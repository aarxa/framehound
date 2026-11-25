// framehound's Vulkan layer: the native version of generator/inject/glitch-gl.js.
//
// Loaded into any Vulkan app by the Vulkan loader, it lets framehound learn from the app's own frames. On a capture
// frame, every command buffer the app records is also recorded into a few shadow copies, identical except that in each
// one, one draw call is broken: left out, drawn with a texture swapped for a fallback, missing some of its triangles,
// drawn inside out, drawn with no depth test or drawn with additive blending. At submit, the layer runs each shadow copy, reads the finished frame back, then runs the
// app's own commands and reads the clean frame. All of them draw from the same data the app uploaded for that frame,
// so the clean and broken frames differ only by the broken draw, and the difference is the glitch's exact mask.
//
// The output is the same as framehound's WebGL capture (clean/, glitched/, masks/, manifest.jsonl), so the trainer and
// `framehound learn` read it unchanged.
//
// Settings (environment variables):
//   FRAMEHOUND_OUT       folder to write to; without it the layer only passes calls through
//   FRAMEHOUND_APP       the app's id in the manifest (default "app")
//   FRAMEHOUND_START     first frame to capture (default 30), FRAMEHOUND_EVERY: then every N frames (default 30)
//   FRAMEHOUND_CAPTURES  how many frames to capture at most (default unlimited)
//   FRAMEHOUND_VARIANTS  broken copies per captured frame (default 8)
//   FRAMEHOUND_TYPES     glitches to use, comma-separated (default all six)
//   FRAMEHOUND_SEED      random seed (default 1)
//   FRAMEHOUND_SHADOW_ALL=1  shadow every command buffer the app records, not just those of capture frames, for apps
//                        that record their command buffers once and submit them every frame (vkcube does)
//
// Limits for now: frames are read from the swapchain image being presented; indirect draws with a count buffer and
// vkQueueSubmit2 are passed through unbroken, and so are draws in secondary command buffers with FRAMEHOUND_SHADOW_ALL.
#include <vulkan/vk_layer.h>
#include <vulkan/vulkan.h>
#include <zlib.h>

#include <sys/stat.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdarg>
#include <functional>
#include <mutex>
#include <random>
#include <string>
#include <unordered_map>
#include <vector>

#ifndef VK_LAYER_EXPORT
#define VK_LAYER_EXPORT __attribute__((visibility("default")))
#endif

namespace {

// ---- settings --------------------------------------------------------------------------------------------------------
struct Config {
  std::string out, app = "app";
  long start = 30, every = 30, captures = -1, variants = 8;
  unsigned seed = 1;
  bool shadowAll = false;  // shadow every command buffer, for apps that record once and submit every frame
  std::vector<std::string> types = {"missing_draw", "missing_texture", "dropped_faces", "inside_out", "depth_test_off", "additive_blend"};
  bool active() const { return !out.empty(); }
};

Config LoadConfig() {
  Config c;
  auto get = [](const char* k) { return std::getenv(k); };
  if (const char* v = get("FRAMEHOUND_OUT")) c.out = v;
  if (const char* v = get("FRAMEHOUND_APP")) c.app = v;
  if (const char* v = get("FRAMEHOUND_START")) c.start = std::atol(v);
  if (const char* v = get("FRAMEHOUND_EVERY")) c.every = std::max(1L, std::atol(v));
  if (const char* v = get("FRAMEHOUND_CAPTURES")) c.captures = std::atol(v);
  if (const char* v = get("FRAMEHOUND_VARIANTS")) c.variants = std::max(1L, std::atol(v));
  if (const char* v = get("FRAMEHOUND_SEED")) c.seed = unsigned(std::atol(v));
  if (const char* v = get("FRAMEHOUND_SHADOW_ALL")) c.shadowAll = std::atoi(v) != 0;
  if (const char* v = get("FRAMEHOUND_TYPES")) {
    c.types.clear();
    std::string s = v;
    for (size_t a = 0, b; a <= s.size(); a = b + 1) {
      b = s.find(',', a);
      if (b == std::string::npos) b = s.size();
      if (b > a) c.types.push_back(s.substr(a, b - a));
    }
  }
  return c;
}

const Config& config() {
  static const Config c = LoadConfig();
  return c;
}

bool Wanted(const char* type) {
  const auto& t = config().types;
  return std::find(t.begin(), t.end(), type) != t.end();
}

// ---- dispatch ----------------------------------------------------------------------------------------------------------
using Key = void*;
template <typename T>
Key KeyOf(T handle) {
  return *reinterpret_cast<void**>(handle);  // the loader's dispatch table pointer, shared by a device's objects
}

struct Variant {
  long draw = -1;  // which draw to break: of the frame, or of the command buffer for shadow-all recordings
  unsigned seed = 0;
  std::string type, info;
  bool applied = false;
  uint32_t count = 0;
  std::string call;
};

struct BoundSet {
  VkDescriptorSet set = VK_NULL_HANDLE;
  VkPipelineLayout layout = VK_NULL_HANDLE;
  std::vector<uint32_t> offsets;  // its dynamic offsets
};

struct Device;
struct Recording {
  Device* device = nullptr;
  VkCommandPool pool = VK_NULL_HANDLE;
  VkCommandBufferLevel level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
  std::vector<VkCommandBuffer> shadows;  // one per broken variant, while a capture frame is recorded
  std::vector<Variant> variants;         // what each shadow breaks
  uint64_t shadowFrame = ~0ull;
  bool local = false;  // shadows made outside a capture frame (FRAMEHOUND_SHADOW_ALL), counted by draws in this buffer
  long draws = 0, lastDraws = 0;
  VkPipeline bound = VK_NULL_HANDLE;  // the graphics pipeline bound at this point of the recording
  std::vector<BoundSet> sets;         // and the graphics descriptor sets, while shadowing
  std::vector<VkDescriptorSet> temps;  // copies of sets made for broken draws
  std::vector<Recording*> executed;     // secondary command buffers with shadows that this one executes
};

Recording* RecordingOf(VkCommandBuffer cb);

#define FH_COMMAND_TABLE
#include "commands.inc"
#undef FH_COMMAND_TABLE

struct Instance {
  VkInstance handle = VK_NULL_HANDLE;
  PFN_vkGetInstanceProcAddr gipa = nullptr;
  PFN_vkDestroyInstance DestroyInstance = nullptr;
  PFN_vkGetPhysicalDeviceMemoryProperties GetPhysicalDeviceMemoryProperties = nullptr;
};

struct PipelineInfo {
  VkPrimitiveTopology topology = VK_PRIMITIVE_TOPOLOGY_MAX_ENUM;
  VkPipeline insideOut = VK_NULL_HANDLE, depthOff = VK_NULL_HANDLE, additive = VK_NULL_HANDLE;
};

struct Swapchain {
  std::vector<VkImage> images;
  VkFormat format = VK_FORMAT_UNDEFINED;
  VkExtent2D extent{};
  uint32_t acquired = 0;
};

struct Device {
  VkDevice handle = VK_NULL_HANDLE;
  Instance* instance = nullptr;
  PFN_vkGetDeviceProcAddr gdpa = nullptr;
  PFN_vkSetDeviceLoaderData setLoaderData = nullptr;
  VkPhysicalDeviceMemoryProperties memory{};
  CmdTable cmd;
#define FH_DEVICE_FUNCTIONS(X)                                                                                         \
  X(DestroyDevice) X(GetDeviceQueue) X(QueueSubmit) X(QueueWaitIdle) X(QueuePresentKHR) X(CreateSwapchainKHR)          \
  X(DestroySwapchainKHR) X(GetSwapchainImagesKHR) X(AcquireNextImageKHR) X(CreateGraphicsPipelines) X(DestroyPipeline) \
  X(AllocateCommandBuffers) X(FreeCommandBuffers) X(BeginCommandBuffer) X(EndCommandBuffer) X(ResetCommandBuffer)      \
  X(CreateCommandPool) X(DestroyCommandPool) X(ResetCommandPool) X(CreateFence) X(DestroyFence) X(WaitForFences)       \
  X(ResetFences) X(CreateBuffer) X(DestroyBuffer) X(GetBufferMemoryRequirements) X(AllocateMemory) X(FreeMemory)       \
  X(BindBufferMemory) X(MapMemory) X(UnmapMemory) X(DeviceWaitIdle) X(CreateDescriptorSetLayout)                      \
  X(CreatePipelineLayout) X(AllocateDescriptorSets) X(FreeDescriptorSets) X(CreateDescriptorPool)                        \
  X(DestroyDescriptorPool) X(UpdateDescriptorSets) X(CreateImage) X(DestroyImage) X(CreateImageView) X(DestroyImageView) \
  X(GetImageMemoryRequirements) X(BindImageMemory) X(CreateSampler) X(DestroySampler)
#define FH_DECLARE(name) PFN_vk##name name = nullptr;
  FH_DEVICE_FUNCTIONS(FH_DECLARE)

  std::unordered_map<VkQueue, uint32_t> queueFamily;
  std::unordered_map<VkPipeline, PipelineInfo> pipelines;
  std::unordered_map<VkSwapchainKHR, Swapchain> swapchains;
  VkSwapchainKHR lastAcquired = VK_NULL_HANDLE;

  // frames
  uint64_t frame = 0;
  long drawsThisFrame = 0, drawsLastFrame = 0;
  bool capturing = false;
  long captured = 0;
  std::vector<Variant> variants;
  std::mt19937 rng{1};
  unsigned nextSeed = 1;

  // reading frames back
  std::unordered_map<uint32_t, VkCommandPool> copyPools;
  VkBuffer readBuffer = VK_NULL_HANDLE;
  VkDeviceMemory readMemory = VK_NULL_HANDLE;
  VkDeviceSize readSize = 0;
  VkFence fence = VK_NULL_HANDLE;
  std::unordered_map<std::string, long> written;
  unsigned nextFile = 1;

  // descriptor sets, for swapping a texture
  struct SetLayout {
    std::vector<VkDescriptorSetLayoutBinding> bindings;
    bool copyable = true;
  };
  std::unordered_map<VkDescriptorSetLayout, SetLayout> setLayouts;
  std::unordered_map<VkDescriptorSet, VkDescriptorSetLayout> setLayoutOf;
  VkDescriptorPool tempPool = VK_NULL_HANDLE;
  struct Placeholder {
    const char* style;
    VkImage image = VK_NULL_HANDLE;
    VkDeviceMemory memory = VK_NULL_HANDLE;
    VkImageView view = VK_NULL_HANDLE;
  };
  std::vector<Placeholder> placeholders;  // fallback textures, made at the first present
  VkSampler sampler = VK_NULL_HANDLE;
  bool placeholdersTried = false;
};

std::mutex lock;
std::unordered_map<Key, Instance*> instances;
std::unordered_map<Key, Device*> devices;
std::unordered_map<VkCommandBuffer, Recording*> recordings;

Instance* InstanceOf(Key k) {
  auto it = instances.find(k);
  return it == instances.end() ? nullptr : it->second;
}
template <typename T>
Device* DeviceOf(T handle) {
  std::lock_guard<std::mutex> g(lock);
  auto it = devices.find(KeyOf(handle));
  return it == devices.end() ? nullptr : it->second;
}

Recording* RecordingOf(VkCommandBuffer cb) {
  std::lock_guard<std::mutex> g(lock);
  auto it = recordings.find(cb);
  if (it != recordings.end()) return it->second;
  // a command buffer we didn't see allocated: record it without shadows
  auto d = devices.find(KeyOf(cb));
  auto* r = new Recording;
  r->device = d == devices.end() ? nullptr : d->second;
  recordings[cb] = r;
  return r;
}

void Log(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
void Log(const char* fmt, ...) {
  va_list a;
  va_start(a, fmt);
  std::fprintf(stderr, "[framehound] ");
  std::vfprintf(stderr, fmt, a);
  std::fprintf(stderr, "\n");
  va_end(a);
}

#define FH_COMMAND_WRAPPERS
#include "commands.inc"
#undef FH_COMMAND_WRAPPERS

// ---- files --------------------------------------------------------------------------------------------------------------
void MakeDirs(const std::string& path) {
  for (size_t i = 1; i < path.size(); i++) {
    if (path[i] == '/') mkdir(path.substr(0, i).c_str(), 0755);
  }
  mkdir(path.c_str(), 0755);
}

bool WritePng(const std::string& path, int w, int h, int channels, const uint8_t* pixels) {
  std::vector<uint8_t> raw(size_t(w * channels + 1) * h);
  for (int y = 0; y < h; y++) {
    raw[size_t(y) * (w * channels + 1)] = 0;
    std::memcpy(&raw[size_t(y) * (w * channels + 1) + 1], pixels + size_t(y) * w * channels, size_t(w) * channels);
  }
  uLongf zlen = compressBound(raw.size());
  std::vector<uint8_t> z(zlen);
  if (compress2(z.data(), &zlen, raw.data(), raw.size(), 6) != Z_OK) return false;
  z.resize(zlen);
  std::vector<uint8_t> png = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
  auto be32 = [](std::vector<uint8_t>& v, uint32_t x) {
    for (int s = 24; s >= 0; s -= 8) v.push_back(uint8_t(x >> s));
  };
  auto chunk = [&](const char* type, const std::vector<uint8_t>& data) {
    be32(png, uint32_t(data.size()));
    size_t at = png.size();
    png.insert(png.end(), type, type + 4);
    png.insert(png.end(), data.begin(), data.end());
    be32(png, uint32_t(crc32(0, png.data() + at, uInt(png.size() - at))));
  };
  std::vector<uint8_t> ihdr;
  be32(ihdr, uint32_t(w));
  be32(ihdr, uint32_t(h));
  ihdr.insert(ihdr.end(), {8, uint8_t(channels == 3 ? 2 : 0), 0, 0, 0});
  chunk("IHDR", ihdr);
  chunk("IDAT", z);
  chunk("IEND", {});
  FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  std::fwrite(png.data(), 1, png.size(), f);
  std::fclose(f);
  return true;
}

// ---- reading the presented image back --------------------------------------------------------------------------------
uint32_t MemoryType(const Device* d, uint32_t bits, VkMemoryPropertyFlags want) {
  for (uint32_t i = 0; i < d->memory.memoryTypeCount; i++) {
    if ((bits & (1u << i)) && (d->memory.memoryTypes[i].propertyFlags & want) == want) return i;
  }
  return UINT32_MAX;
}

bool EnsureReadBuffer(Device* d, VkDeviceSize size) {
  if (d->readSize >= size) return true;
  if (d->readBuffer) {
    d->DestroyBuffer(d->handle, d->readBuffer, nullptr);
    d->FreeMemory(d->handle, d->readMemory, nullptr);
  }
  VkBufferCreateInfo bi{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
  bi.size = size;
  bi.usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT;
  if (d->CreateBuffer(d->handle, &bi, nullptr, &d->readBuffer) != VK_SUCCESS) return false;
  VkMemoryRequirements req;
  d->GetBufferMemoryRequirements(d->handle, d->readBuffer, &req);
  VkMemoryAllocateInfo ai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
  ai.allocationSize = req.size;
  ai.memoryTypeIndex = MemoryType(d, req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  if (ai.memoryTypeIndex == UINT32_MAX || d->AllocateMemory(d->handle, &ai, nullptr, &d->readMemory) != VK_SUCCESS) return false;
  d->BindBufferMemory(d->handle, d->readBuffer, d->readMemory, 0);
  d->readSize = size;
  return true;
}

VkCommandBuffer NewCommandBuffer(Device* d, VkCommandPool pool, VkCommandBufferLevel level) {
  VkCommandBufferAllocateInfo ai{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
  ai.commandPool = pool;
  ai.level = level;
  ai.commandBufferCount = 1;
  VkCommandBuffer cb = VK_NULL_HANDLE;
  if (d->AllocateCommandBuffers(d->handle, &ai, &cb) != VK_SUCCESS) return VK_NULL_HANDLE;
  if (d->setLoaderData) d->setLoaderData(d->handle, cb);  // a dispatchable object made inside the layer
  return cb;
}

bool Wait(Device* d) {
  VkResult r = d->WaitForFences(d->handle, 1, &d->fence, VK_TRUE, 10ull * 1000 * 1000 * 1000);
  d->ResetFences(d->handle, 1, &d->fence);
  return r == VK_SUCCESS;
}

// Copy the image just drawn to host memory as RGB, waiting for it. The image is in the layout the app leaves it in for
// presenting, and is put back in it.
bool ReadImage(Device* d, VkQueue queue, const Swapchain& sc, std::vector<uint8_t>& rgb) {
  bool bgra = sc.format == VK_FORMAT_B8G8R8A8_UNORM || sc.format == VK_FORMAT_B8G8R8A8_SRGB;
  bool rgba = sc.format == VK_FORMAT_R8G8B8A8_UNORM || sc.format == VK_FORMAT_R8G8B8A8_SRGB;
  if (!bgra && !rgba) return false;
  uint32_t w = sc.extent.width, h = sc.extent.height;
  if (!EnsureReadBuffer(d, VkDeviceSize(w) * h * 4)) return false;
  uint32_t family = d->queueFamily[queue];
  VkCommandPool& pool = d->copyPools[family];
  if (!pool) {
    VkCommandPoolCreateInfo pi{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    pi.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    pi.queueFamilyIndex = family;
    if (d->CreateCommandPool(d->handle, &pi, nullptr, &pool) != VK_SUCCESS) return false;
  }
  VkCommandBuffer cb = NewCommandBuffer(d, pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY);
  if (!cb) return false;
  VkImage image = sc.images[sc.acquired];
  VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
  bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
  d->BeginCommandBuffer(cb, &bi);
  VkImageMemoryBarrier b{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
  b.srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_MEMORY_WRITE_BIT;
  b.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
  b.oldLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
  b.newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
  b.srcQueueFamilyIndex = b.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
  b.image = image;
  b.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
  d->cmd.CmdPipelineBarrier(cb, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, nullptr, 0, nullptr, 1, &b);
  VkBufferImageCopy region{};
  region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
  region.imageExtent = {w, h, 1};
  d->cmd.CmdCopyImageToBuffer(cb, image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, d->readBuffer, 1, &region);
  b.srcAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
  b.dstAccessMask = 0;
  b.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
  b.newLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
  d->cmd.CmdPipelineBarrier(cb, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, 0, 0, nullptr, 0, nullptr, 1, &b);
  d->EndCommandBuffer(cb);
  VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO};
  si.commandBufferCount = 1;
  si.pCommandBuffers = &cb;
  bool ok = d->QueueSubmit(queue, 1, &si, d->fence) == VK_SUCCESS && Wait(d);
  if (ok) {
    void* p = nullptr;
    d->MapMemory(d->handle, d->readMemory, 0, VkDeviceSize(w) * h * 4, 0, &p);
    const uint8_t* src = static_cast<const uint8_t*>(p);
    rgb.resize(size_t(w) * h * 3);
    for (size_t i = 0; i < size_t(w) * h; i++) {
      rgb[i * 3 + 0] = src[i * 4 + (bgra ? 2 : 0)];
      rgb[i * 3 + 1] = src[i * 4 + 1];
      rgb[i * 3 + 2] = src[i * 4 + (bgra ? 0 : 2)];
    }
    d->UnmapMemory(d->handle, d->readMemory);
  }
  d->FreeCommandBuffers(d->handle, pool, 1, &cb);
  return ok;
}

// ---- which broken frames count (the same rules as the WebGL injector) --------------------------------------------------
struct Change {
  double fraction = 0, strong = 0, mean = 0, spread = 0;
  long patch = 0;
  std::vector<uint8_t> mask;
};

Change Compare(const std::vector<uint8_t>& clean, const std::vector<uint8_t>& broken, int w, int h) {
  const int kDiff = 12, kStrong = 40;
  Change c;
  c.mask.assign(size_t(w) * h, 0);
  std::vector<uint8_t> strongAt(size_t(w) * h, 0);
  long changed = 0, strong = 0;
  double sum = 0, ls = 0, ls2 = 0;
  for (size_t i = 0; i < size_t(w) * h; i++) {
    int d = 0;
    for (int k = 0; k < 3; k++) d = std::max(d, std::abs(int(clean[i * 3 + k]) - int(broken[i * 3 + k])));
    if (d > kDiff) {
      changed++;
      sum += d;
      c.mask[i] = 255;
      if (d > kStrong) strong++, strongAt[i] = 1;
    }
    double l = 0.2126 * broken[i * 3] + 0.7152 * broken[i * 3 + 1] + 0.0722 * broken[i * 3 + 2];
    ls += l;
    ls2 += l * l;
  }
  double n = double(w) * h;
  c.fraction = changed / n;
  c.strong = strong / n;
  c.mean = changed ? sum / changed : 0;
  c.spread = std::sqrt(std::max(0.0, ls2 / n - (ls / n) * (ls / n)));
  // biggest connected patch of plain change
  std::vector<int> stack;
  for (size_t s = 0; s < strongAt.size(); s++) {
    if (strongAt[s] != 1) continue;
    long size = 0;
    stack.assign(1, int(s));
    strongAt[s] = 2;
    while (!stack.empty()) {
      int p = stack.back();
      stack.pop_back();
      size++;
      int x = p % w, y = p / w;
      for (int dy = -1; dy <= 1; dy++)
        for (int dx = -1; dx <= 1; dx++) {
          int nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          int q = ny * w + nx;
          if (strongAt[q] == 1) strongAt[q] = 2, stack.push_back(q);
        }
    }
    c.patch = std::max(c.patch, size);
  }
  return c;
}

std::string Json(const std::string& s) {
  std::string o = "\"";
  for (char ch : s) {
    if (ch == '"' || ch == '\\') o += '\\';
    o += ch;
  }
  return o + "\"";
}

// ---- shadows -----------------------------------------------------------------------------------------------------------
void FreeShadows(Recording* r) {
  if (!r->shadows.empty() && r->device) r->device->FreeCommandBuffers(r->device->handle, r->pool, uint32_t(r->shadows.size()), r->shadows.data());
  if (!r->temps.empty() && r->device) r->device->FreeDescriptorSets(r->device->handle, r->device->tempPool, uint32_t(r->temps.size()), r->temps.data());
  r->temps.clear();
  r->sets.clear();
  r->executed.clear();
  r->shadows.clear();
  r->variants.clear();
  r->shadowFrame = ~0ull;
  r->local = false;
}

bool IsTriangles(VkPrimitiveTopology t) {
  return t == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST || t == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP || t == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN;
}

// A draw as recorded: draw(cb, count, offset) re-issues it with another count and first vertex/index.
struct DrawCall {
  const char* call;
  uint32_t count;  // vertices or indices; for an indirect draw, unknown (the GPU reads it)
  uint32_t first;
  bool indirect = false;
  std::function<void(VkCommandBuffer, uint32_t, uint32_t)> draw;
};

// ---- fallback textures and descriptor set copies, for missing_texture ------------------------------------------------
// A texture that never loaded, so the engine's fallback shows: the draw is drawn with a copy of one of its descriptor
// sets in which one sampled image is swapped for a fallback.
void MakePlaceholders(Device* d, VkQueue queue) {
  d->placeholdersTried = true;
  const uint32_t S = 64;
  struct Style {
    const char* name;
    uint8_t a[3], b[3];
    uint32_t cells;
  };
  const Style styles[] = {{"magenta-checker", {255, 0, 255}, {0, 0, 0}, 8}, {"black", {0, 0, 0}, {0, 0, 0}, 1}, {"grey-checker", {200, 200, 200}, {90, 90, 90}, 8}};
  VkBufferCreateInfo bi{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
  bi.size = S * S * 4;
  bi.usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
  VkBuffer staging;
  if (d->CreateBuffer(d->handle, &bi, nullptr, &staging) != VK_SUCCESS) return;
  VkMemoryRequirements req;
  d->GetBufferMemoryRequirements(d->handle, staging, &req);
  VkMemoryAllocateInfo ai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
  ai.allocationSize = req.size;
  ai.memoryTypeIndex = MemoryType(d, req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  VkDeviceMemory stagingMemory;
  if (d->AllocateMemory(d->handle, &ai, nullptr, &stagingMemory) != VK_SUCCESS) return;
  d->BindBufferMemory(d->handle, staging, stagingMemory, 0);
  uint32_t family = d->queueFamily[queue];
  VkCommandPool& pool = d->copyPools[family];
  if (!pool) {
    VkCommandPoolCreateInfo pi{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    pi.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    pi.queueFamilyIndex = family;
    d->CreateCommandPool(d->handle, &pi, nullptr, &pool);
  }
  if (!d->fence) {
    VkFenceCreateInfo fi{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    d->CreateFence(d->handle, &fi, nullptr, &d->fence);
  }
  for (const Style& st : styles) {
    void* p = nullptr;
    d->MapMemory(d->handle, stagingMemory, 0, S * S * 4, 0, &p);
    auto* px = static_cast<uint8_t*>(p);
    for (uint32_t y = 0; y < S; y++)
      for (uint32_t x = 0; x < S; x++) {
        const uint8_t* c = ((x * st.cells / S) + (y * st.cells / S)) % 2 ? st.a : st.b;
        uint8_t* q = px + (y * S + x) * 4;
        q[0] = c[0], q[1] = c[1], q[2] = c[2], q[3] = 255;
      }
    d->UnmapMemory(d->handle, stagingMemory);
    Device::Placeholder ph;
    ph.style = st.name;
    VkImageCreateInfo ii{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
    ii.imageType = VK_IMAGE_TYPE_2D;
    ii.format = VK_FORMAT_R8G8B8A8_UNORM;
    ii.extent = {S, S, 1};
    ii.mipLevels = ii.arrayLayers = 1;
    ii.samples = VK_SAMPLE_COUNT_1_BIT;
    ii.tiling = VK_IMAGE_TILING_OPTIMAL;
    ii.usage = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
    if (d->CreateImage(d->handle, &ii, nullptr, &ph.image) != VK_SUCCESS) break;
    VkMemoryRequirements ir;
    d->GetImageMemoryRequirements(d->handle, ph.image, &ir);
    VkMemoryAllocateInfo mi{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    mi.allocationSize = ir.size;
    mi.memoryTypeIndex = MemoryType(d, ir.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    if (mi.memoryTypeIndex == UINT32_MAX) mi.memoryTypeIndex = MemoryType(d, ir.memoryTypeBits, 0);
    if (d->AllocateMemory(d->handle, &mi, nullptr, &ph.memory) != VK_SUCCESS) break;
    d->BindImageMemory(d->handle, ph.image, ph.memory, 0);
    VkCommandBuffer cb = NewCommandBuffer(d, pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY);
    VkCommandBufferBeginInfo cbi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    cbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    d->BeginCommandBuffer(cb, &cbi);
    VkImageMemoryBarrier b{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
    b.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    b.newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
    b.dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    b.srcQueueFamilyIndex = b.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    b.image = ph.image;
    b.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    d->cmd.CmdPipelineBarrier(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, nullptr, 0, nullptr, 1, &b);
    VkBufferImageCopy region{};
    region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    region.imageExtent = {S, S, 1};
    d->cmd.CmdCopyBufferToImage(cb, staging, ph.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
    b.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
    b.newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
    b.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    b.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
    d->cmd.CmdPipelineBarrier(cb, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 0, nullptr, 0, nullptr, 1, &b);
    d->EndCommandBuffer(cb);
    VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    si.commandBufferCount = 1;
    si.pCommandBuffers = &cb;
    bool ok = d->QueueSubmit(queue, 1, &si, d->fence) == VK_SUCCESS && Wait(d);
    d->FreeCommandBuffers(d->handle, pool, 1, &cb);
    if (!ok) break;
    VkImageViewCreateInfo vi{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
    vi.image = ph.image;
    vi.viewType = VK_IMAGE_VIEW_TYPE_2D;
    vi.format = VK_FORMAT_R8G8B8A8_UNORM;
    vi.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    if (d->CreateImageView(d->handle, &vi, nullptr, &ph.view) != VK_SUCCESS) break;
    d->placeholders.push_back(ph);
  }
  d->DestroyBuffer(d->handle, staging, nullptr);
  d->FreeMemory(d->handle, stagingMemory, nullptr);
  VkSamplerCreateInfo smi{VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO};
  smi.magFilter = smi.minFilter = VK_FILTER_NEAREST;
  smi.addressModeU = smi.addressModeV = smi.addressModeW = VK_SAMPLER_ADDRESS_MODE_REPEAT;
  if (d->CreateSampler(d->handle, &smi, nullptr, &d->sampler) != VK_SUCCESS) d->placeholders.clear();
  VkDescriptorPoolSize sizes[] = {{VK_DESCRIPTOR_TYPE_SAMPLER, 1024}, {VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1024},
                                  {VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1024}, {VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 256},
                                  {VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 256}, {VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, 256},
                                  {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1024}, {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1024},
                                  {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 256}, {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, 256},
                                  {VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, 64}};
  VkDescriptorPoolCreateInfo dpi{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
  dpi.flags = VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT;
  dpi.maxSets = 512;
  dpi.poolSizeCount = uint32_t(sizeof sizes / sizeof sizes[0]);
  dpi.pPoolSizes = sizes;
  if (d->CreateDescriptorPool(d->handle, &dpi, nullptr, &d->tempPool) != VK_SUCCESS) d->placeholders.clear();
}

const Device::SetLayout* LayoutOfSet(Device* d, VkDescriptorSet set) {
  std::lock_guard<std::mutex> g(lock);
  auto s = d->setLayoutOf.find(set);
  if (s == d->setLayoutOf.end()) return nullptr;
  auto l = d->setLayouts.find(s->second);
  return l == d->setLayouts.end() ? nullptr : &l->second;
}

// a copy of `src` with one sampled image swapped for a fallback texture
VkDescriptorSet SwappedSet(Device* d, VkDescriptorSet src, const VkDescriptorSetLayoutBinding& binding, const Device::Placeholder& ph) {
  VkDescriptorSetLayout layout;
  {
    std::lock_guard<std::mutex> g(lock);
    layout = d->setLayoutOf[src];
  }
  const Device::SetLayout* info = LayoutOfSet(d, src);
  VkDescriptorSetAllocateInfo ai{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
  ai.descriptorPool = d->tempPool;
  ai.descriptorSetCount = 1;
  ai.pSetLayouts = &layout;
  VkDescriptorSet dst = VK_NULL_HANDLE;
  if (d->AllocateDescriptorSets(d->handle, &ai, &dst) != VK_SUCCESS) return VK_NULL_HANDLE;
  std::vector<VkCopyDescriptorSet> copies;
  for (const auto& b : info->bindings) {
    if (!b.descriptorCount) continue;
    VkCopyDescriptorSet c{VK_STRUCTURE_TYPE_COPY_DESCRIPTOR_SET};
    c.srcSet = src, c.srcBinding = b.binding, c.dstSet = dst, c.dstBinding = b.binding, c.descriptorCount = b.descriptorCount;
    copies.push_back(c);
  }
  // copies first, then the swapped image (in one call, writes would go first and be copied over)
  d->UpdateDescriptorSets(d->handle, 0, nullptr, uint32_t(copies.size()), copies.data());
  VkDescriptorImageInfo ii{d->sampler, ph.view, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
  VkWriteDescriptorSet w{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
  w.dstSet = dst, w.dstBinding = binding.binding, w.descriptorCount = 1, w.descriptorType = binding.descriptorType, w.pImageInfo = &ii;
  d->UpdateDescriptorSets(d->handle, 1, &w, 0, nullptr);
  return dst;
}

// Break one draw in shadow `s`, the way variant v asks; records the draw normally if nothing applies.
void BreakDraw(Device* d, Recording* r, VkCommandBuffer s, Variant& v, const DrawCall& dc) {
  auto pi = d->pipelines.find(r->bound);
  const PipelineInfo* p = pi == d->pipelines.end() ? nullptr : &pi->second;
  std::vector<const char*> ok;
  bool scene = p && IsTriangles(p->topology) && (dc.indirect || dc.count > 6);  // leaves out full-screen passes, sprites, lines
  if (scene) {
    if (Wanted("missing_draw")) ok.push_back("missing_draw");
    if (Wanted("dropped_faces") && !dc.indirect && p->topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST && dc.count >= 12) ok.push_back("dropped_faces");
    if (Wanted("inside_out") && p->insideOut) ok.push_back("inside_out");
    if (Wanted("depth_test_off") && p->depthOff) ok.push_back("depth_test_off");
    if (Wanted("additive_blend") && p->additive) ok.push_back("additive_blend");
  }
  // sampled images the fragment shader reads, in the bound descriptor sets
  struct Slot {
    uint32_t set;
    VkDescriptorSetLayoutBinding binding;
  };
  std::vector<Slot> slots;
  if (scene && Wanted("missing_texture") && !d->placeholders.empty() && d->tempPool) {
    for (uint32_t si = 0; si < r->sets.size(); si++) {
      const Device::SetLayout* l = r->sets[si].set ? LayoutOfSet(d, r->sets[si].set) : nullptr;
      if (!l || !l->copyable) continue;
      for (const auto& b : l->bindings)
        if ((b.descriptorType == VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER || b.descriptorType == VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE) &&
            (b.stageFlags & VK_SHADER_STAGE_FRAGMENT_BIT) && b.descriptorCount)
          slots.push_back({si, b});
    }
    if (!slots.empty()) ok.push_back("missing_texture");
  }
  if (ok.empty()) {
    dc.draw(s, dc.count, dc.first);
    return;
  }
  std::mt19937 rnd(v.seed * 9973u + 1);
  std::uniform_real_distribution<double> u(0, 1);
  v.type = ok[rnd() % ok.size()];
  v.applied = true;
  v.count = dc.count;
  v.call = dc.call;
  if (v.type == "missing_draw") {
    v.info = "{}";
  } else if (v.type == "missing_texture") {
    const Slot& slot = slots[rnd() % slots.size()];
    // the magenta checker most often, as engines' own fallbacks are
    const Device::Placeholder& ph = d->placeholders[std::min<size_t>(d->placeholders.size() - 1, std::array<size_t, 4>{0, 0, 1, 2}[rnd() % 4])];
    const BoundSet& bs = r->sets[slot.set];
    VkDescriptorSet swapped = SwappedSet(d, bs.set, slot.binding, ph);
    if (!swapped) {
      v.applied = false;
      dc.draw(s, dc.count, dc.first);
      return;
    }
    r->temps.push_back(swapped);
    d->cmd.CmdBindDescriptorSets(s, VK_PIPELINE_BIND_POINT_GRAPHICS, bs.layout, slot.set, 1, &swapped, uint32_t(bs.offsets.size()), bs.offsets.data());
    dc.draw(s, dc.count, dc.first);
    d->cmd.CmdBindDescriptorSets(s, VK_PIPELINE_BIND_POINT_GRAPHICS, bs.layout, slot.set, 1, &bs.set, uint32_t(bs.offsets.size()), bs.offsets.data());
    char buf[128];
    std::snprintf(buf, sizeof buf, "{\"style\": \"%s\", \"set\": %u, \"binding\": %u}", ph.style, slot.set, slot.binding.binding);
    v.info = buf;
  } else if (v.type == "dropped_faces") {
    uint32_t tris = dc.count / 3;
    uint32_t k = std::max(1u, uint32_t(tris * (0.02 + 0.28 * u(rnd))));
    uint32_t start = uint32_t(u(rnd) * (tris - k + 1));
    if (start) dc.draw(s, start * 3, dc.first);
    if (tris > start + k) dc.draw(s, (tris - start - k) * 3, dc.first + (start + k) * 3);
    char buf[96];
    std::snprintf(buf, sizeof buf, "{\"style\": \"block\", \"dropped_share\": %.3f}", double(k) / tris);
    v.info = buf;
  } else {
    VkPipeline alt = v.type == "inside_out" ? p->insideOut : v.type == "depth_test_off" ? p->depthOff : p->additive;
    d->cmd.CmdBindPipeline(s, VK_PIPELINE_BIND_POINT_GRAPHICS, alt);
    dc.draw(s, dc.count, dc.first);
    d->cmd.CmdBindPipeline(s, VK_PIPELINE_BIND_POINT_GRAPHICS, r->bound);
    v.info = "{}";
  }
}

// ---- intercepted device functions ---------------------------------------------------------------------------------------
VKAPI_ATTR void VKAPI_CALL fh_GetDeviceQueue(VkDevice device, uint32_t family, uint32_t index, VkQueue* queue) {
  Device* d = DeviceOf(device);
  d->GetDeviceQueue(device, family, index, queue);
  std::lock_guard<std::mutex> g(lock);
  d->queueFamily[*queue] = family;
}

VKAPI_ATTR VkResult VKAPI_CALL fh_CreateSwapchainKHR(VkDevice device, const VkSwapchainCreateInfoKHR* info, const VkAllocationCallbacks* a, VkSwapchainKHR* sc) {
  Device* d = DeviceOf(device);
  VkSwapchainCreateInfoKHR ci = *info;
  ci.imageUsage |= VK_IMAGE_USAGE_TRANSFER_SRC_BIT;  // so frames can be read back
  VkResult r = d->CreateSwapchainKHR(device, &ci, a, sc);
  if (r == VK_SUCCESS) {
    std::lock_guard<std::mutex> g(lock);
    Swapchain& s = d->swapchains[*sc];
    s.format = ci.imageFormat;
    s.extent = ci.imageExtent;
  }
  return r;
}

VKAPI_ATTR void VKAPI_CALL fh_DestroySwapchainKHR(VkDevice device, VkSwapchainKHR sc, const VkAllocationCallbacks* a) {
  Device* d = DeviceOf(device);
  {
    std::lock_guard<std::mutex> g(lock);
    d->swapchains.erase(sc);
    if (d->lastAcquired == sc) d->lastAcquired = VK_NULL_HANDLE;
  }
  d->DestroySwapchainKHR(device, sc, a);
}

VKAPI_ATTR VkResult VKAPI_CALL fh_GetSwapchainImagesKHR(VkDevice device, VkSwapchainKHR sc, uint32_t* count, VkImage* images) {
  Device* d = DeviceOf(device);
  VkResult r = d->GetSwapchainImagesKHR(device, sc, count, images);
  if (images && (r == VK_SUCCESS || r == VK_INCOMPLETE)) {
    std::lock_guard<std::mutex> g(lock);
    d->swapchains[sc].images.assign(images, images + *count);
  }
  return r;
}

VKAPI_ATTR VkResult VKAPI_CALL fh_AcquireNextImageKHR(VkDevice device, VkSwapchainKHR sc, uint64_t timeout, VkSemaphore sem, VkFence fence, uint32_t* index) {
  Device* d = DeviceOf(device);
  VkResult r = d->AcquireNextImageKHR(device, sc, timeout, sem, fence, index);
  if (r == VK_SUCCESS || r == VK_SUBOPTIMAL_KHR) {
    std::lock_guard<std::mutex> g(lock);
    d->swapchains[sc].acquired = *index;
    d->lastAcquired = sc;
  }
  return r;
}

// Pipelines: remember the topology, and make the variants the glitches swap in while the create info is at hand.
VKAPI_ATTR VkResult VKAPI_CALL fh_CreateGraphicsPipelines(VkDevice device, VkPipelineCache cache, uint32_t n, const VkGraphicsPipelineCreateInfo* infos, const VkAllocationCallbacks* a, VkPipeline* out) {
  Device* d = DeviceOf(device);
  VkResult r = d->CreateGraphicsPipelines(device, cache, n, infos, a, out);
  if (r != VK_SUCCESS) return r;
  for (uint32_t i = 0; i < n; i++) {
    const VkGraphicsPipelineCreateInfo& ci = infos[i];
    PipelineInfo p;
    if (ci.pInputAssemblyState) p.topology = ci.pInputAssemblyState->topology;
    if (config().active()) {
      auto dynamic = [&](VkDynamicState s) {
        if (!ci.pDynamicState) return false;
        for (uint32_t k = 0; k < ci.pDynamicState->dynamicStateCount; k++)
          if (ci.pDynamicState->pDynamicStates[k] == s) return true;
        return false;
      };
      auto variant = [&](VkGraphicsPipelineCreateInfo v) {
        v.flags &= ~VkPipelineCreateFlags(VK_PIPELINE_CREATE_DERIVATIVE_BIT);
        v.basePipelineHandle = VK_NULL_HANDLE;
        v.basePipelineIndex = -1;
        VkPipeline made = VK_NULL_HANDLE;
        return d->CreateGraphicsPipelines(device, cache, 1, &v, a, &made) == VK_SUCCESS ? made : VK_NULL_HANDLE;
      };
      if (ci.pRasterizationState && !dynamic(VK_DYNAMIC_STATE_CULL_MODE) && !dynamic(VK_DYNAMIC_STATE_FRONT_FACE)) {
        // the front faces vanish and the inside shows
        VkPipelineRasterizationStateCreateInfo rs = *ci.pRasterizationState;
        rs.cullMode = rs.cullMode == VK_CULL_MODE_FRONT_BIT ? VK_CULL_MODE_BACK_BIT : VK_CULL_MODE_FRONT_BIT;
        VkGraphicsPipelineCreateInfo v = ci;
        v.pRasterizationState = &rs;
        p.insideOut = variant(v);
      }
      if (ci.pDepthStencilState && ci.pDepthStencilState->depthTestEnable && !dynamic(VK_DYNAMIC_STATE_DEPTH_COMPARE_OP) && !dynamic(VK_DYNAMIC_STATE_DEPTH_TEST_ENABLE)) {
        // drawn over whatever should hide it
        VkPipelineDepthStencilStateCreateInfo ds = *ci.pDepthStencilState;
        ds.depthCompareOp = VK_COMPARE_OP_ALWAYS;
        VkGraphicsPipelineCreateInfo v = ci;
        v.pDepthStencilState = &ds;
        p.depthOff = variant(v);
      }
      if (ci.pColorBlendState && ci.pColorBlendState->attachmentCount && !ci.pColorBlendState->pAttachments[0].blendEnable) {
        // a blend mode leaked from another draw: it glows and turns see-through
        VkPipelineColorBlendStateCreateInfo bs = *ci.pColorBlendState;
        std::vector<VkPipelineColorBlendAttachmentState> att(bs.pAttachments, bs.pAttachments + bs.attachmentCount);
        for (auto& t : att) {
          t.blendEnable = VK_TRUE;
          t.srcColorBlendFactor = t.dstColorBlendFactor = VK_BLEND_FACTOR_ONE;
          t.srcAlphaBlendFactor = t.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
          t.colorBlendOp = t.alphaBlendOp = VK_BLEND_OP_ADD;
        }
        bs.pAttachments = att.data();
        VkGraphicsPipelineCreateInfo v = ci;
        v.pColorBlendState = &bs;
        p.additive = variant(v);
      }
    }
    std::lock_guard<std::mutex> g(lock);
    d->pipelines[out[i]] = p;
  }
  return r;
}

VKAPI_ATTR void VKAPI_CALL fh_DestroyPipeline(VkDevice device, VkPipeline pipeline, const VkAllocationCallbacks* a) {
  Device* d = DeviceOf(device);
  PipelineInfo p;
  {
    std::lock_guard<std::mutex> g(lock);
    auto it = d->pipelines.find(pipeline);
    if (it != d->pipelines.end()) p = it->second, d->pipelines.erase(it);
  }
  for (VkPipeline v : {p.insideOut, p.depthOff, p.additive})
    if (v) d->DestroyPipeline(device, v, a);
  d->DestroyPipeline(device, pipeline, a);
}

VKAPI_ATTR VkResult VKAPI_CALL fh_CreateDescriptorSetLayout(VkDevice device, const VkDescriptorSetLayoutCreateInfo* info, const VkAllocationCallbacks* a, VkDescriptorSetLayout* out) {
  Device* d = DeviceOf(device);
  VkResult r = d->CreateDescriptorSetLayout(device, info, a, out);
  if (r != VK_SUCCESS) return r;
  Device::SetLayout l;
  l.bindings.assign(info->pBindings, info->pBindings + info->bindingCount);
  for (auto& b : l.bindings) {
    b.pImmutableSamplers = nullptr;  // not kept; writes to such bindings ignore the sampler anyway
    if (b.descriptorType == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK) l.copyable = false;
  }
  // sets of these layouts can't be copied into a plain pool
  if (info->flags & (VK_DESCRIPTOR_SET_LAYOUT_CREATE_PUSH_DESCRIPTOR_BIT_KHR | VK_DESCRIPTOR_SET_LAYOUT_CREATE_UPDATE_AFTER_BIND_POOL_BIT)) l.copyable = false;
  for (auto* p = static_cast<const VkBaseInStructure*>(info->pNext); p; p = p->pNext)
    if (p->sType == VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_BINDING_FLAGS_CREATE_INFO) l.copyable = false;
  std::lock_guard<std::mutex> g(lock);
  d->setLayouts[*out] = std::move(l);
  return r;
}

VKAPI_ATTR VkResult VKAPI_CALL fh_AllocateDescriptorSets(VkDevice device, const VkDescriptorSetAllocateInfo* info, VkDescriptorSet* sets) {
  Device* d = DeviceOf(device);
  VkResult r = d->AllocateDescriptorSets(device, info, sets);
  if (r != VK_SUCCESS) return r;
  std::lock_guard<std::mutex> g(lock);
  for (uint32_t i = 0; i < info->descriptorSetCount; i++) d->setLayoutOf[sets[i]] = info->pSetLayouts[i];
  return r;
}

VKAPI_ATTR void VKAPI_CALL fh_CmdBindDescriptorSets(VkCommandBuffer cb, VkPipelineBindPoint point, VkPipelineLayout layout, uint32_t first, uint32_t count,
                                                    const VkDescriptorSet* sets, uint32_t dynamicCount, const uint32_t* dynamic) {
  Recording* r = RecordingOf(cb);
  Device* d = r->device;
  d->cmd.CmdBindDescriptorSets(cb, point, layout, first, count, sets, dynamicCount, dynamic);
  for (VkCommandBuffer s : r->shadows) d->cmd.CmdBindDescriptorSets(s, point, layout, first, count, sets, dynamicCount, dynamic);
  if (point != VK_PIPELINE_BIND_POINT_GRAPHICS || r->shadows.empty()) return;
  uint32_t at = 0;
  for (uint32_t i = 0; i < count; i++) {
    BoundSet b{sets[i], layout, {}};
    if (const Device::SetLayout* l = LayoutOfSet(d, sets[i]))
      for (const auto& bd : l->bindings)
        if (bd.descriptorType == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC || bd.descriptorType == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC)
          for (uint32_t k = 0; k < bd.descriptorCount && at < dynamicCount; k++) b.offsets.push_back(dynamic[at++]);
    if (r->sets.size() <= first + i) r->sets.resize(first + i + 1);
    r->sets[first + i] = b;
  }
}

VKAPI_ATTR VkResult VKAPI_CALL fh_AllocateCommandBuffers(VkDevice device, const VkCommandBufferAllocateInfo* info, VkCommandBuffer* cbs) {
  Device* d = DeviceOf(device);
  VkResult r = d->AllocateCommandBuffers(device, info, cbs);
  if (r != VK_SUCCESS) return r;
  std::lock_guard<std::mutex> g(lock);
  for (uint32_t i = 0; i < info->commandBufferCount; i++) {
    auto* rec = new Recording;
    rec->device = d;
    rec->pool = info->commandPool;
    rec->level = info->level;
    delete recordings[cbs[i]];
    recordings[cbs[i]] = rec;
  }
  return r;
}

void ForgetPool(Device* d, VkCommandPool pool, bool freeShadows) {
  std::vector<Recording*> mine;
  {
    std::lock_guard<std::mutex> g(lock);
    for (auto& [cb, r] : recordings)
      if (r->device == d && r->pool == pool) mine.push_back(r);
  }
  for (Recording* r : mine) {
    if (freeShadows) FreeShadows(r);
    else r->shadows.clear();
  }
}

VKAPI_ATTR void VKAPI_CALL fh_FreeCommandBuffers(VkDevice device, VkCommandPool pool, uint32_t n, const VkCommandBuffer* cbs) {
  Device* d = DeviceOf(device);
  for (uint32_t i = 0; i < n; i++) {
    if (!cbs[i]) continue;
    Recording* r = nullptr;
    {
      std::lock_guard<std::mutex> g(lock);
      auto it = recordings.find(cbs[i]);
      if (it != recordings.end()) r = it->second, recordings.erase(it);
    }
    if (r) FreeShadows(r), delete r;
  }
  d->FreeCommandBuffers(device, pool, n, cbs);
}

VKAPI_ATTR void VKAPI_CALL fh_DestroyCommandPool(VkDevice device, VkCommandPool pool, const VkAllocationCallbacks* a) {
  Device* d = DeviceOf(device);
  {
    std::lock_guard<std::mutex> g(lock);
    for (auto it = recordings.begin(); it != recordings.end();) {
      if (it->second->device == d && it->second->pool == pool) delete it->second, it = recordings.erase(it);
      else ++it;
    }
  }
  d->DestroyCommandPool(device, pool, a);  // frees the shadows with the rest
}

VKAPI_ATTR VkResult VKAPI_CALL fh_ResetCommandPool(VkDevice device, VkCommandPool pool, VkCommandPoolResetFlags flags) {
  Device* d = DeviceOf(device);
  ForgetPool(d, pool, true);
  return d->ResetCommandPool(device, pool, flags);
}

VKAPI_ATTR VkResult VKAPI_CALL fh_ResetCommandBuffer(VkCommandBuffer cb, VkCommandBufferResetFlags flags) {
  Recording* r = RecordingOf(cb);
  FreeShadows(r);
  return r->device->ResetCommandBuffer(cb, flags);
}

VKAPI_ATTR VkResult VKAPI_CALL fh_BeginCommandBuffer(VkCommandBuffer cb, const VkCommandBufferBeginInfo* info) {
  Recording* r = RecordingOf(cb);
  Device* d = r->device;
  FreeShadows(r);  // shadows of an earlier recording
  r->bound = VK_NULL_HANDLE;
  if (r->draws) r->lastDraws = r->draws;
  r->draws = 0;
  VkResult res = d->BeginCommandBuffer(cb, info);
  const Config& c = config();
  bool all = c.active() && c.shadowAll;
  // secondaries get shadows on capture frames; with shadow-all, only primaries do (one broken draw per copy)
  bool secondary = r->level == VK_COMMAND_BUFFER_LEVEL_SECONDARY;
  if (res != VK_SUCCESS || !(d->capturing || all) || (secondary && all) || !r->pool) return res;
  if (all) {
    // armed by draw index within this command buffer, from how many draws it had last time (or the last frame's)
    long n = std::max(1L, r->lastDraws ? r->lastDraws : d->drawsLastFrame);
    r->variants.clear();
    for (long v = 0; v < c.variants; v++) {
      Variant var;
      var.draw = long(d->rng() % uint32_t(n));
      var.seed = d->nextSeed++;
      r->variants.push_back(var);
    }
    r->local = true;
  } else {
    r->variants = d->variants;
  }
  for (size_t v = 0; v < r->variants.size(); v++) {
    VkCommandBuffer s = NewCommandBuffer(d, r->pool, r->level);
    if (!s) break;
    VkCommandBufferBeginInfo bi = *info;
    bi.flags &= ~VkCommandBufferUsageFlags(VK_COMMAND_BUFFER_USAGE_SIMULTANEOUS_USE_BIT);
    d->BeginCommandBuffer(s, &bi);
    r->shadows.push_back(s);
  }
  if (r->shadows.size() != r->variants.size()) FreeShadows(r);
  else r->shadowFrame = d->frame;
  return res;
}

VKAPI_ATTR VkResult VKAPI_CALL fh_EndCommandBuffer(VkCommandBuffer cb) {
  Recording* r = RecordingOf(cb);
  for (VkCommandBuffer s : r->shadows) r->device->EndCommandBuffer(s);
  return r->device->EndCommandBuffer(cb);
}

VKAPI_ATTR void VKAPI_CALL fh_CmdBindPipeline(VkCommandBuffer cb, VkPipelineBindPoint point, VkPipeline pipeline) {
  Recording* r = RecordingOf(cb);
  r->device->cmd.CmdBindPipeline(cb, point, pipeline);
  for (VkCommandBuffer s : r->shadows) r->device->cmd.CmdBindPipeline(s, point, pipeline);
  if (point == VK_PIPELINE_BIND_POINT_GRAPHICS) r->bound = pipeline;
}

void Draw(Recording* r, VkCommandBuffer cb, const DrawCall& dc) {
  Device* d = r->device;
  dc.draw(cb, dc.count, dc.first);
  long index = d->drawsThisFrame++;
  long local = r->draws++;
  for (size_t v = 0; v < r->shadows.size(); v++) {
    if (r->variants[v].draw == (r->local ? local : index)) BreakDraw(d, r, r->shadows[v], r->variants[v], dc);
    else dc.draw(r->shadows[v], dc.count, dc.first);
  }
}

VKAPI_ATTR void VKAPI_CALL fh_CmdDraw(VkCommandBuffer cb, uint32_t vertexCount, uint32_t instances, uint32_t firstVertex, uint32_t firstInstance) {
  Recording* r = RecordingOf(cb);
  Device* d = r->device;
  Draw(r, cb, {"vkCmdDraw", vertexCount, firstVertex, false, [=](VkCommandBuffer c, uint32_t count, uint32_t first) {
    d->cmd.CmdDraw(c, count, instances, first, firstInstance);
  }});
}

VKAPI_ATTR void VKAPI_CALL fh_CmdDrawIndexed(VkCommandBuffer cb, uint32_t indexCount, uint32_t instances, uint32_t firstIndex, int32_t vertexOffset, uint32_t firstInstance) {
  Recording* r = RecordingOf(cb);
  Device* d = r->device;
  Draw(r, cb, {"vkCmdDrawIndexed", indexCount, firstIndex, false, [=](VkCommandBuffer c, uint32_t count, uint32_t first) {
    d->cmd.CmdDrawIndexed(c, count, instances, first, vertexOffset, firstInstance);
  }});
}

// Indirect draws: the GPU reads the counts, so they can be left out or drawn with other state, but not split.
VKAPI_ATTR void VKAPI_CALL fh_CmdDrawIndirect(VkCommandBuffer cb, VkBuffer buffer, VkDeviceSize offset, uint32_t drawCount, uint32_t stride) {
  Recording* r = RecordingOf(cb);
  Device* d = r->device;
  Draw(r, cb, {"vkCmdDrawIndirect", 0, 0, true, [=](VkCommandBuffer c, uint32_t, uint32_t) { d->cmd.CmdDrawIndirect(c, buffer, offset, drawCount, stride); }});
}

VKAPI_ATTR void VKAPI_CALL fh_CmdDrawIndexedIndirect(VkCommandBuffer cb, VkBuffer buffer, VkDeviceSize offset, uint32_t drawCount, uint32_t stride) {
  Recording* r = RecordingOf(cb);
  Device* d = r->device;
  Draw(r, cb, {"vkCmdDrawIndexedIndirect", 0, 0, true, [=](VkCommandBuffer c, uint32_t, uint32_t) {
    d->cmd.CmdDrawIndexedIndirect(c, buffer, offset, drawCount, stride);
  }});
}

VKAPI_ATTR void VKAPI_CALL fh_CmdExecuteCommands(VkCommandBuffer cb, uint32_t n, const VkCommandBuffer* secondaries) {
  Recording* r = RecordingOf(cb);
  Device* d = r->device;
  d->cmd.CmdExecuteCommands(cb, n, secondaries);
  if (r->shadows.empty()) return;
  // each shadow copy runs the same copy of the secondaries, so a draw broken in a secondary shows in that copy
  std::vector<Recording*> recs(n);
  for (uint32_t k = 0; k < n; k++) {
    recs[k] = RecordingOf(secondaries[k]);
    if (!recs[k]->local && recs[k]->shadowFrame == d->frame && !recs[k]->shadows.empty()) r->executed.push_back(recs[k]);
  }
  for (size_t v = 0; v < r->shadows.size(); v++) {
    std::vector<VkCommandBuffer> list(secondaries, secondaries + n);
    for (uint32_t k = 0; k < n; k++)
      if (!recs[k]->local && recs[k]->shadowFrame == d->frame && v < recs[k]->shadows.size()) list[k] = recs[k]->shadows[v];
    d->cmd.CmdExecuteCommands(r->shadows[v], n, list.data());
  }
}

// A frame ends at present: pick the draws to break in the next frame if it is captured.
VKAPI_ATTR VkResult VKAPI_CALL fh_QueuePresentKHR(VkQueue queue, const VkPresentInfoKHR* info) {
  Device* d = DeviceOf(queue);
  VkResult r = d->QueuePresentKHR(queue, info);
  const Config& c = config();
  if (c.active() && !d->placeholdersTried && Wanted("missing_texture")) MakePlaceholders(d, queue);
  d->drawsLastFrame = d->drawsThisFrame;
  d->drawsThisFrame = 0;
  d->frame++;
  long f = long(d->frame);
  d->capturing = c.active() && f >= c.start && (f - c.start) % c.every == 0 && (c.captures < 0 || d->captured < c.captures) &&
                 (c.shadowAll || d->drawsLastFrame > 0);
  d->variants.clear();
  if (d->capturing && !c.shadowAll) {
    for (long v = 0; v < c.variants; v++) {
      Variant var;
      var.draw = long(d->rng() % uint32_t(d->drawsLastFrame));
      var.seed = d->nextSeed++;
      d->variants.push_back(var);
    }
  }
  return r;
}

void SaveCapture(Device* d, const Swapchain& sc, const std::vector<uint8_t>& clean, const std::vector<std::vector<uint8_t>>& broken,
                 const std::vector<Variant>& used) {
  const Config& c = config();
  int w = int(sc.extent.width), h = int(sc.extent.height);
  long moment = d->captured;
  std::string cleanRel = "clean/" + c.app + "/" + std::to_string(moment) + ".png";
  MakeDirs(c.out + "/clean/" + c.app);
  WritePng(c.out + "/" + cleanRel, w, h, 3, clean.data());
  int kept = 0;
  std::string manifest = c.out + "/manifest.jsonl";
  FILE* m = std::fopen(manifest.c_str(), "a");
  for (size_t v = 0; v < broken.size(); v++) {
    const Variant& var = used[v];
    if (!var.applied || broken[v].empty()) continue;
    Change ch = Compare(clean, broken[v], w, h);
    // visible glitches only: enough of the frame changes, plainly, in one patch, and the frame doesn't go blank
    long minPatch = std::lround(150.0 * (double(w) * h) / (768.0 * 432.0));
    if (ch.fraction < 0.002 || ch.fraction > 0.6 || ch.strong < 0.001 || ch.patch < minPatch || ch.spread < 6) continue;
    unsigned id = config().seed * 1000000u + d->nextFile++;  // a recording made once is broken the same way each capture
    char seed[16];
    std::snprintf(seed, sizeof seed, "%07u", id);
    std::string g = "glitched/" + var.type + "/" + seed + ".png", k = "masks/" + var.type + "/" + seed + ".png";
    MakeDirs(c.out + "/glitched/" + var.type);
    MakeDirs(c.out + "/masks/" + var.type);
    WritePng(c.out + "/" + g, w, h, 3, broken[v].data());
    WritePng(c.out + "/" + k, w, h, 1, ch.mask.data());
    if (m) {
      std::fprintf(m,
                   "{\"seed\": %u, \"app\": %s, \"moment\": %ld, \"glitch\": %s, \"info\": %s, \"fraction\": %.6f, \"strong\": %.6f, "
                   "\"mean_change\": %.3f, \"draw\": {\"index\": %ld, \"call\": %s, \"count\": %u}, \"held\": \"resubmit\", "
                   "\"split\": \"train\", \"files\": {\"clean\": %s, \"glitched\": %s, \"mask\": %s}}\n",
                   id, Json(c.app).c_str(), moment, Json(var.type).c_str(), var.info.c_str(), ch.fraction, ch.strong, ch.mean,
                   var.draw, Json(var.call).c_str(), var.count, Json(cleanRel).c_str(), Json(g).c_str(), Json(k).c_str());
    }
    d->written[var.type]++;
    kept++;
  }
  if (m) std::fclose(m);
  // dataset.json, rewritten as captures come in
  std::string types, by;
  for (size_t i = 0; i < c.types.size(); i++) types += (i ? ", " : "") + Json(c.types[i]);
  long total = 0;
  for (auto& [t, n] : d->written) by += (by.empty() ? "" : ", ") + Json(t) + ": " + std::to_string(n), total += n;
  if (FILE* f = std::fopen((c.out + "/dataset.json").c_str(), "w")) {
    std::fprintf(f, "{\"size\": [%d, %d], \"glitch_types\": [%s], \"source\": \"a Vulkan app broken by native/layer (framehound's Vulkan layer)\", "
                    "\"apps\": {%s: {\"split\": \"train\", \"written\": %ld}}, \"written\": %ld, \"byType\": {%s}}\n",
                 w, h, types.c_str(), Json(c.app).c_str(), total, total, by.c_str());
    std::fclose(f);
  }
  Log("frame %llu: %zu broken copies, %d visible and kept", (unsigned long long)d->frame, broken.size(), kept);
}

VKAPI_ATTR VkResult VKAPI_CALL fh_QueueSubmit(VkQueue queue, uint32_t n, const VkSubmitInfo* submits, VkFence fence) {
  Device* d = DeviceOf(queue);
  // which command buffers to swap for their shadows: those recorded this capture frame, or with shadow-all, the first
  // one that has shadows (so each copy has one broken draw)
  bool plain = true;
  std::vector<Recording*> swap;
  bool local = false;
  for (uint32_t i = 0; i < n; i++) {
    if (submits[i].pNext) plain = false;  // timeline values and the like: not handled yet
    for (uint32_t k = 0; k < submits[i].commandBufferCount; k++) {
      Recording* r = RecordingOf(submits[i].pCommandBuffers[k]);
      if (r->shadows.empty() || !d->capturing) continue;
      if (r->local && !local && swap.empty()) swap.push_back(r), local = true;
      else if (!r->local && r->shadowFrame == d->frame && !local) swap.push_back(r);
    }
  }
  bool shadowed = !swap.empty();
  auto sc = d->swapchains.find(d->lastAcquired);
  if (!shadowed || !plain || sc == d->swapchains.end() || sc->second.images.empty()) return d->QueueSubmit(queue, n, submits, fence);

  if (!d->fence) {
    VkFenceCreateInfo fi{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    d->CreateFence(d->handle, &fi, nullptr, &d->fence);
  }
  // 1. wait for what the app's submit waits on (the acquired image), once
  std::vector<VkSubmitInfo> waits(submits, submits + n);
  for (auto& s : waits) s.commandBufferCount = 0, s.signalSemaphoreCount = 0;
  d->QueueSubmit(queue, n, waits.data(), d->fence);
  Wait(d);
  // 2. each broken copy, read back
  size_t copies = swap.front()->shadows.size();
  std::vector<Variant> used(copies);
  for (Recording* r : swap) {
    std::vector<Recording*> all = r->executed;
    all.push_back(r);
    for (Recording* x : all)
      for (size_t v = 0; v < copies && v < x->variants.size(); v++)
        if (x->variants[v].applied) used[v] = x->variants[v];
  }
  std::vector<std::vector<uint8_t>> broken(copies);
  for (size_t v = 0; v < copies; v++) {
    std::vector<std::vector<VkCommandBuffer>> lists(n);
    std::vector<VkSubmitInfo> runs(n);
    for (uint32_t i = 0; i < n; i++) {
      for (uint32_t k = 0; k < submits[i].commandBufferCount; k++) {
        VkCommandBuffer cb = submits[i].pCommandBuffers[k];
        Recording* r = RecordingOf(cb);
        bool swapped = std::find(swap.begin(), swap.end(), r) != swap.end();
        lists[i].push_back(swapped && v < r->shadows.size() ? r->shadows[v] : cb);
      }
      runs[i] = VkSubmitInfo{VK_STRUCTURE_TYPE_SUBMIT_INFO};
      runs[i].commandBufferCount = uint32_t(lists[i].size());
      runs[i].pCommandBuffers = lists[i].data();
    }
    if (used[v].applied && d->QueueSubmit(queue, n, runs.data(), d->fence) == VK_SUCCESS && Wait(d))
      ReadImage(d, queue, sc->second, broken[v]);
  }
  // 3. the app's own commands, without the waits already done, then the clean frame
  std::vector<VkSubmitInfo> own(submits, submits + n);
  for (auto& s : own) s.waitSemaphoreCount = 0, s.pWaitSemaphores = nullptr, s.pWaitDstStageMask = nullptr;
  VkResult r = d->QueueSubmit(queue, n, own.data(), fence);
  std::vector<uint8_t> clean;
  if (r == VK_SUCCESS && d->QueueWaitIdle(queue) == VK_SUCCESS && ReadImage(d, queue, sc->second, clean)) {
    SaveCapture(d, sc->second, clean, broken, used);
    d->captured++;
  }
  d->capturing = false;
  return r;
}

VKAPI_ATTR void VKAPI_CALL fh_DestroyDevice(VkDevice device, const VkAllocationCallbacks* a) {
  Device* d = DeviceOf(device);
  if (!d) return;
  d->DeviceWaitIdle(device);
  {
    std::lock_guard<std::mutex> g(lock);
    for (auto it = recordings.begin(); it != recordings.end();) {
      if (it->second->device == d) delete it->second, it = recordings.erase(it);
      else ++it;
    }
  }
  for (auto& [family, pool] : d->copyPools) d->DestroyCommandPool(device, pool, nullptr);
  if (d->readBuffer) d->DestroyBuffer(device, d->readBuffer, nullptr), d->FreeMemory(device, d->readMemory, nullptr);
  if (d->fence) d->DestroyFence(device, d->fence, nullptr);
  for (auto& ph : d->placeholders) {
    d->DestroyImageView(device, ph.view, nullptr);
    d->DestroyImage(device, ph.image, nullptr);
    d->FreeMemory(device, ph.memory, nullptr);
  }
  if (d->sampler) d->DestroySampler(device, d->sampler, nullptr);
  if (d->tempPool) d->DestroyDescriptorPool(device, d->tempPool, nullptr);
  auto destroy = d->DestroyDevice;
  {
    std::lock_guard<std::mutex> g(lock);
    devices.erase(KeyOf(device));
  }
  delete d;
  destroy(device, a);
}

PFN_vkVoidFunction DeviceFunction(const char* name);

VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL fh_GetDeviceProcAddr(VkDevice device, const char* name) {
  Device* d = DeviceOf(device);
  if (!d) return nullptr;
  PFN_vkVoidFunction next = d->gdpa(device, name);
  if (!next) return nullptr;  // not on this device: don't offer a wrapper for it
  PFN_vkVoidFunction mine = DeviceFunction(name);
  return mine ? mine : next;
}

VKAPI_ATTR VkResult VKAPI_CALL fh_CreateDevice(VkPhysicalDevice phys, const VkDeviceCreateInfo* info, const VkAllocationCallbacks* a, VkDevice* device) {
  auto* link = (VkLayerDeviceCreateInfo*)info->pNext;
  while (link && !(link->sType == VK_STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO && link->function == VK_LAYER_LINK_INFO)) link = (VkLayerDeviceCreateInfo*)link->pNext;
  auto* loaderData = (VkLayerDeviceCreateInfo*)info->pNext;
  while (loaderData && !(loaderData->sType == VK_STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO && loaderData->function == VK_LOADER_DATA_CALLBACK)) loaderData = (VkLayerDeviceCreateInfo*)loaderData->pNext;
  if (!link) return VK_ERROR_INITIALIZATION_FAILED;
  PFN_vkGetInstanceProcAddr gipa = link->u.pLayerInfo->pfnNextGetInstanceProcAddr;
  PFN_vkGetDeviceProcAddr gdpa = link->u.pLayerInfo->pfnNextGetDeviceProcAddr;
  link->u.pLayerInfo = link->u.pLayerInfo->pNext;
  Instance* inst;
  {
    std::lock_guard<std::mutex> g(lock);
    inst = InstanceOf(KeyOf(phys));
  }
  auto create = (PFN_vkCreateDevice)gipa(inst ? inst->handle : VK_NULL_HANDLE, "vkCreateDevice");
  VkResult r = create(phys, info, a, device);
  if (r != VK_SUCCESS) return r;
  auto* d = new Device;
  d->handle = *device;
  d->instance = inst;
  d->gdpa = gdpa;
  d->setLoaderData = loaderData ? loaderData->u.pfnSetDeviceLoaderData : nullptr;
  d->rng.seed(config().seed);
  d->nextSeed = config().seed * 100000u + 1;
#define FH_LOAD(name) d->name = (PFN_vk##name)gdpa(*device, "vk" #name);
  FH_DEVICE_FUNCTIONS(FH_LOAD)
  LoadCmdTable(d->cmd, gdpa, *device);
  if (inst && inst->GetPhysicalDeviceMemoryProperties) inst->GetPhysicalDeviceMemoryProperties(phys, &d->memory);
  std::lock_guard<std::mutex> g(lock);
  devices[KeyOf(*device)] = d;
  if (config().active()) Log("on; writing to %s", config().out.c_str());
  return r;
}

VKAPI_ATTR VkResult VKAPI_CALL fh_CreateInstance(const VkInstanceCreateInfo* info, const VkAllocationCallbacks* a, VkInstance* instance) {
  auto* link = (VkLayerInstanceCreateInfo*)info->pNext;
  while (link && !(link->sType == VK_STRUCTURE_TYPE_LOADER_INSTANCE_CREATE_INFO && link->function == VK_LAYER_LINK_INFO)) link = (VkLayerInstanceCreateInfo*)link->pNext;
  if (!link) return VK_ERROR_INITIALIZATION_FAILED;
  PFN_vkGetInstanceProcAddr gipa = link->u.pLayerInfo->pfnNextGetInstanceProcAddr;
  link->u.pLayerInfo = link->u.pLayerInfo->pNext;
  auto create = (PFN_vkCreateInstance)gipa(VK_NULL_HANDLE, "vkCreateInstance");
  VkResult r = create(info, a, instance);
  if (r != VK_SUCCESS) return r;
  auto* inst = new Instance;
  inst->handle = *instance;
  inst->gipa = gipa;
  inst->DestroyInstance = (PFN_vkDestroyInstance)gipa(*instance, "vkDestroyInstance");
  inst->GetPhysicalDeviceMemoryProperties = (PFN_vkGetPhysicalDeviceMemoryProperties)gipa(*instance, "vkGetPhysicalDeviceMemoryProperties");
  std::lock_guard<std::mutex> g(lock);
  instances[KeyOf(*instance)] = inst;
  return r;
}

VKAPI_ATTR void VKAPI_CALL fh_DestroyInstance(VkInstance instance, const VkAllocationCallbacks* a) {
  Instance* inst;
  {
    std::lock_guard<std::mutex> g(lock);
    inst = InstanceOf(KeyOf(instance));
    instances.erase(KeyOf(instance));
  }
  if (!inst) return;
  inst->DestroyInstance(instance, a);
  delete inst;
}

PFN_vkVoidFunction DeviceFunction(const char* name) {
#define FH_HOOK(n) \
  if (!strcmp(name, "vk" #n)) return (PFN_vkVoidFunction)fh_##n;
  FH_HOOK(GetDeviceProcAddr) FH_HOOK(DestroyDevice) FH_HOOK(GetDeviceQueue) FH_HOOK(CreateSwapchainKHR)
  FH_HOOK(DestroySwapchainKHR) FH_HOOK(GetSwapchainImagesKHR) FH_HOOK(AcquireNextImageKHR) FH_HOOK(QueuePresentKHR)
  FH_HOOK(QueueSubmit) FH_HOOK(CreateGraphicsPipelines) FH_HOOK(DestroyPipeline) FH_HOOK(AllocateCommandBuffers)
  FH_HOOK(FreeCommandBuffers) FH_HOOK(DestroyCommandPool) FH_HOOK(ResetCommandPool) FH_HOOK(ResetCommandBuffer)
  FH_HOOK(BeginCommandBuffer) FH_HOOK(EndCommandBuffer) FH_HOOK(CmdBindPipeline) FH_HOOK(CmdDraw)
  FH_HOOK(CmdDrawIndexed) FH_HOOK(CmdExecuteCommands) FH_HOOK(CreateDescriptorSetLayout) FH_HOOK(AllocateDescriptorSets)
  FH_HOOK(CmdBindDescriptorSets) FH_HOOK(CmdDrawIndirect) FH_HOOK(CmdDrawIndexedIndirect)
  return GeneratedCommand(name);
}

}  // namespace

extern "C" {

VK_LAYER_EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vkGetDeviceProcAddr(VkDevice device, const char* name) {
  return fh_GetDeviceProcAddr(device, name);
}

VK_LAYER_EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vkGetInstanceProcAddr(VkInstance instance, const char* name) {
  if (!strcmp(name, "vkGetInstanceProcAddr")) return (PFN_vkVoidFunction)vkGetInstanceProcAddr;
  if (!strcmp(name, "vkCreateInstance")) return (PFN_vkVoidFunction)fh_CreateInstance;
  if (!strcmp(name, "vkDestroyInstance")) return (PFN_vkVoidFunction)fh_DestroyInstance;
  if (!strcmp(name, "vkCreateDevice")) return (PFN_vkVoidFunction)fh_CreateDevice;
  if (!strcmp(name, "vkGetDeviceProcAddr")) return (PFN_vkVoidFunction)fh_GetDeviceProcAddr;
  if (!instance) return nullptr;
  Instance* inst;
  {
    std::lock_guard<std::mutex> g(lock);
    inst = InstanceOf(KeyOf(instance));
  }
  if (!inst) return nullptr;
  PFN_vkVoidFunction next = inst->gipa(instance, name);
  if (!next) return nullptr;
  PFN_vkVoidFunction mine = DeviceFunction(name);
  return mine ? mine : next;
}

VK_LAYER_EXPORT VKAPI_ATTR VkResult VKAPI_CALL vkNegotiateLoaderLayerInterfaceVersion(VkNegotiateLayerInterface* v) {
  if (v->loaderLayerInterfaceVersion >= 2) {
    v->pfnGetInstanceProcAddr = vkGetInstanceProcAddr;
    v->pfnGetDeviceProcAddr = vkGetDeviceProcAddr;
    v->pfnGetPhysicalDeviceProcAddr = nullptr;
    v->loaderLayerInterfaceVersion = 2;
  }
  return VK_SUCCESS;
}

}  // extern "C"
