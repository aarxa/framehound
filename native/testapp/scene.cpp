// A small Vulkan scene for testing framehound's Vulkan layer without a game: a textured ground, a ring of turning
// cubes and spheres, and two glass boxes, drawn to a headless swapchain (no window) and re-recorded every frame, the
// way game engines do.
//
//   fh_scene [--frames 300] [--size 768x432] [--indirect] [--indirect-count] [--secondary] [--submit2] [--timeline]
//     --indirect: draw with vkCmdDrawIndexedIndirect; --indirect-count: with vkCmdDrawIndexedIndirectCount (exits with
//     77 where the driver doesn't support it); --secondary: record the draws in a secondary command buffer;
//     --submit2: submit with vkQueueSubmit2; --timeline: also signal a timeline semaphore each frame
//   --bug texture:N | --bug inside:N   ship a bug in draw N (0 is the ground, 1-10 the ring, 11 the big sphere):
//     drawn with the fallback texture, or with culling flipped so its inside shows
#include <vulkan/vulkan.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#define CHECK(x)                                                                \
  do {                                                                          \
    VkResult r_ = (x);                                                          \
    if (r_ != VK_SUCCESS) {                                                     \
      std::fprintf(stderr, "%s failed: %d (line %d)\n", #x, int(r_), __LINE__); \
      std::exit(1);                                                             \
    }                                                                           \
  } while (0)

// ---- maths (column-major, as GLSL reads it) ------------------------------------------------------------------------
struct Mat {
  float m[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
};
Mat operator*(const Mat& a, const Mat& b) {
  Mat c;
  for (int col = 0; col < 4; col++)
    for (int row = 0; row < 4; row++) {
      float s = 0;
      for (int k = 0; k < 4; k++) s += a.m[k * 4 + row] * b.m[col * 4 + k];
      c.m[col * 4 + row] = s;
    }
  return c;
}
Mat Perspective(float fovy, float aspect, float n, float f) {
  Mat p;
  float t = 1.0f / std::tan(fovy / 2);
  std::memset(p.m, 0, sizeof p.m);
  p.m[0] = t / aspect;
  p.m[5] = -t;  // Vulkan's y points down
  p.m[10] = f / (n - f);
  p.m[11] = -1;
  p.m[14] = n * f / (n - f);
  return p;
}
Mat LookAt(const float e[3], const float c[3]) {
  float f[3] = {c[0] - e[0], c[1] - e[1], c[2] - e[2]};
  float fl = std::sqrt(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
  for (float& x : f) x /= fl;
  float s[3] = {-f[2], 0, f[0]};  // f x (0, 1, 0)
  float sl = std::sqrt(s[0] * s[0] + s[2] * s[2]);
  s[0] /= sl, s[2] /= sl;
  float u[3] = {s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]};
  Mat v;
  v.m[0] = s[0], v.m[4] = s[1], v.m[8] = s[2];
  v.m[1] = u[0], v.m[5] = u[1], v.m[9] = u[2];
  v.m[2] = -f[0], v.m[6] = -f[1], v.m[10] = -f[2];
  v.m[12] = -(s[0] * e[0] + s[1] * e[1] + s[2] * e[2]);
  v.m[13] = -(u[0] * e[0] + u[1] * e[1] + u[2] * e[2]);
  v.m[14] = f[0] * e[0] + f[1] * e[1] + f[2] * e[2];
  return v;
}
Mat Translate(float x, float y, float z) {
  Mat t;
  t.m[12] = x, t.m[13] = y, t.m[14] = z;
  return t;
}
Mat Scale(float x, float y, float z) {
  Mat t;
  t.m[0] = x, t.m[5] = y, t.m[10] = z;
  return t;
}
Mat RotateY(float a) {
  Mat r;
  r.m[0] = std::cos(a), r.m[8] = std::sin(a), r.m[2] = -std::sin(a), r.m[10] = std::cos(a);
  return r;
}
Mat RotateX(float a) {
  Mat r;
  r.m[5] = std::cos(a), r.m[9] = -std::sin(a), r.m[6] = std::sin(a), r.m[10] = std::cos(a);
  return r;
}

// ---- meshes ------------------------------------------------------------------------------------------------------------
struct Vertex {
  float pos[3], nrm[3], uv[2];
};
struct Mesh {
  uint32_t firstIndex, indexCount;
  int32_t vertexOffset;
};

void AddCube(std::vector<Vertex>& v, std::vector<uint32_t>& idx) {
  const float n[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
  uint32_t base = uint32_t(v.size());
  for (int f = 0; f < 6; f++) {
    // two axes across the face: u (the normal's axes rotated) and w = n x u, so (u, w, n) is right-handed
    float u[3] = {n[f][1], n[f][2], n[f][0]};
    float w[3] = {n[f][1] * u[2] - n[f][2] * u[1], n[f][2] * u[0] - n[f][0] * u[2], n[f][0] * u[1] - n[f][1] * u[0]};
    for (int k = 0; k < 4; k++) {
      float su = (k == 1 || k == 2) ? 1.f : -1.f, sw = (k >= 2) ? 1.f : -1.f;
      Vertex x{};
      for (int c = 0; c < 3; c++) x.pos[c] = 0.5f * (n[f][c] + su * u[c] + sw * w[c]), x.nrm[c] = n[f][c];
      x.uv[0] = su * 0.5f + 0.5f, x.uv[1] = sw * 0.5f + 0.5f;
      v.push_back(x);
    }
    uint32_t q = base + f * 4;
    // counter-clockwise seen from outside: (u, w, n) is right-handed
    idx.insert(idx.end(), {q, q + 1, q + 2, q, q + 2, q + 3});
  }
}

void AddSphere(std::vector<Vertex>& v, std::vector<uint32_t>& idx, int stacks = 24, int slices = 32) {
  uint32_t base = uint32_t(v.size());
  for (int i = 0; i <= stacks; i++) {
    float t = float(M_PI) * i / stacks;
    for (int j = 0; j <= slices; j++) {
      float p = 2 * float(M_PI) * j / slices;
      Vertex x{};
      x.nrm[0] = std::sin(t) * std::cos(p), x.nrm[1] = std::cos(t), x.nrm[2] = std::sin(t) * std::sin(p);
      for (int c = 0; c < 3; c++) x.pos[c] = 0.5f * x.nrm[c];
      x.uv[0] = float(j) / slices * 2, x.uv[1] = float(i) / stacks;
      v.push_back(x);
    }
  }
  for (int i = 0; i < stacks; i++)
    for (int j = 0; j < slices; j++) {
      uint32_t a = base + i * (slices + 1) + j, b = a + slices + 1;
      idx.insert(idx.end(), {a, a + 1, b, a + 1, b + 1, b});
    }
}

void AddPlane(std::vector<Vertex>& v, std::vector<uint32_t>& idx) {
  uint32_t base = uint32_t(v.size());
  const float p[4][2] = {{-1, -1}, {1, -1}, {1, 1}, {-1, 1}};
  for (auto& q : p) v.push_back({{q[0], 0, q[1]}, {0, 1, 0}, {q[0] * 0.5f + 0.5f, q[1] * 0.5f + 0.5f}});
  idx.insert(idx.end(), {base, base + 3, base + 2, base, base + 2, base + 1});
}

std::vector<uint32_t> ReadFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) {
    std::fprintf(stderr, "can't read %s\n", path.c_str());
    std::exit(1);
  }
  std::vector<uint32_t> words(size_t(f.tellg()) / 4);
  f.seekg(0);
  f.read(reinterpret_cast<char*>(words.data()), std::streamsize(words.size() * 4));
  return words;
}

// ---- Vulkan ------------------------------------------------------------------------------------------------------------
struct App {
  VkInstance instance;
  VkPhysicalDevice phys;
  VkDevice device;
  VkQueue queue;
  uint32_t family = 0;
  VkPhysicalDeviceMemoryProperties mem;
  uint32_t Memory(uint32_t bits, VkMemoryPropertyFlags want) {
    for (uint32_t i = 0; i < mem.memoryTypeCount; i++)
      if ((bits & (1u << i)) && (mem.memoryTypes[i].propertyFlags & want) == want) return i;
    std::fprintf(stderr, "no memory type\n");
    std::exit(1);
  }
  VkBuffer Buffer(VkDeviceSize size, VkBufferUsageFlags usage, const void* data, VkDeviceMemory* memory) {
    VkBufferCreateInfo bi{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
    bi.size = size;
    bi.usage = usage;
    VkBuffer b;
    CHECK(vkCreateBuffer(device, &bi, nullptr, &b));
    VkMemoryRequirements req;
    vkGetBufferMemoryRequirements(device, b, &req);
    VkMemoryAllocateInfo ai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    ai.allocationSize = req.size;
    ai.memoryTypeIndex = Memory(req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    CHECK(vkAllocateMemory(device, &ai, nullptr, memory));
    CHECK(vkBindBufferMemory(device, b, *memory, 0));
    if (data) {
      void* p;
      vkMapMemory(device, *memory, 0, size, 0, &p);
      std::memcpy(p, data, size_t(size));
      vkUnmapMemory(device, *memory);
    }
    return b;
  }
  VkImage Image(uint32_t w, uint32_t h, VkFormat format, VkImageUsageFlags usage, VkDeviceMemory* memory) {
    VkImageCreateInfo ii{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
    ii.imageType = VK_IMAGE_TYPE_2D;
    ii.format = format;
    ii.extent = {w, h, 1};
    ii.mipLevels = ii.arrayLayers = 1;
    ii.samples = VK_SAMPLE_COUNT_1_BIT;
    ii.tiling = VK_IMAGE_TILING_OPTIMAL;
    ii.usage = usage;
    VkImage img;
    CHECK(vkCreateImage(device, &ii, nullptr, &img));
    VkMemoryRequirements req;
    vkGetImageMemoryRequirements(device, img, &req);
    VkMemoryAllocateInfo ai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    ai.allocationSize = req.size;
    ai.memoryTypeIndex = Memory(req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    CHECK(vkAllocateMemory(device, &ai, nullptr, memory));
    CHECK(vkBindImageMemory(device, img, *memory, 0));
    return img;
  }
  VkImageView View(VkImage img, VkFormat format, VkImageAspectFlags aspect) {
    VkImageViewCreateInfo vi{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
    vi.image = img;
    vi.viewType = VK_IMAGE_VIEW_TYPE_2D;
    vi.format = format;
    vi.subresourceRange = {aspect, 0, 1, 0, 1};
    VkImageView v;
    CHECK(vkCreateImageView(device, &vi, nullptr, &v));
    return v;
  }
};

struct Push {
  Mat mvp, model;
  float color[4];
  float params[4];
};

int main(int argc, char** argv) {
  int frames = 300;
  uint32_t W = 768, H = 432;
  std::string shaders = SHADER_DIR;
  bool indirect = false, indirectCount = false, secondary = false, submit2 = false, timeline = false;
  std::string bugKind;
  int bugDraw = -1;
  for (int i = 1; i < argc; i++) {
    if (!std::strcmp(argv[i], "--frames") && i + 1 < argc) frames = std::atoi(argv[++i]);
    else if (!std::strcmp(argv[i], "--size") && i + 1 < argc) std::sscanf(argv[++i], "%ux%u", &W, &H);
    else if (!std::strcmp(argv[i], "--indirect")) indirect = true;
    else if (!std::strcmp(argv[i], "--indirect-count")) indirect = indirectCount = true;
    else if (!std::strcmp(argv[i], "--secondary")) secondary = true;
    else if (!std::strcmp(argv[i], "--submit2")) submit2 = true;
    else if (!std::strcmp(argv[i], "--timeline")) timeline = true;
    else if (!std::strcmp(argv[i], "--bug") && i + 1 < argc) {
      std::string b = argv[++i];
      bugKind = b.substr(0, b.find(':'));
      bugDraw = std::atoi(b.substr(b.find(':') + 1).c_str());
    }
  }
  App a;

  // instance with a headless surface: no window needed
  const char* iext[] = {VK_KHR_SURFACE_EXTENSION_NAME, "VK_EXT_headless_surface", VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME,
                        VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME, VK_EXT_DEBUG_UTILS_EXTENSION_NAME};
  VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
  app.pApplicationName = "fh_scene";
  app.apiVersion = VK_API_VERSION_1_2;
  VkInstanceCreateInfo ici{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
  ici.flags = VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR;
  ici.pApplicationInfo = &app;
  ici.enabledExtensionCount = 5;
  ici.ppEnabledExtensionNames = iext;
  CHECK(vkCreateInstance(&ici, nullptr, &a.instance));
  auto createHeadless = (PFN_vkCreateHeadlessSurfaceEXT)vkGetInstanceProcAddr(a.instance, "vkCreateHeadlessSurfaceEXT");
  VkHeadlessSurfaceCreateInfoEXT hs{VK_STRUCTURE_TYPE_HEADLESS_SURFACE_CREATE_INFO_EXT};
  VkSurfaceKHR surface;
  CHECK(createHeadless(a.instance, &hs, nullptr, &surface));

  uint32_t n = 1;
  CHECK(vkEnumeratePhysicalDevices(a.instance, &n, &a.phys));
  vkGetPhysicalDeviceMemoryProperties(a.phys, &a.mem);
  float priority = 1;
  VkDeviceQueueCreateInfo qi{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
  qi.queueFamilyIndex = a.family;
  qi.queueCount = 1;
  qi.pQueuePriorities = &priority;
  std::vector<const char*> dext = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
  uint32_t ne = 0;
  vkEnumerateDeviceExtensionProperties(a.phys, nullptr, &ne, nullptr);
  std::vector<VkExtensionProperties> exts(ne);
  vkEnumerateDeviceExtensionProperties(a.phys, nullptr, &ne, exts.data());
  for (auto& e : exts)
    if (!std::strcmp(e.extensionName, "VK_KHR_portability_subset")) dext.push_back("VK_KHR_portability_subset");
  if (submit2) dext.push_back("VK_KHR_synchronization2");
  VkPhysicalDeviceSynchronization2FeaturesKHR sync2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SYNCHRONIZATION_2_FEATURES_KHR};
  sync2.synchronization2 = VK_TRUE;
  VkPhysicalDeviceVulkan12Features v12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES};
  if (indirectCount) {
    VkPhysicalDeviceVulkan12Features has{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES};
    VkPhysicalDeviceFeatures2 f2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2};
    f2.pNext = &has;
    vkGetPhysicalDeviceFeatures2(a.phys, &f2);
    if (!has.drawIndirectCount) {
      std::fprintf(stderr, "this driver doesn't support drawIndirectCount\n");
      return 77;
    }
    v12.drawIndirectCount = VK_TRUE;
  }
  v12.timelineSemaphore = timeline ? VK_TRUE : VK_FALSE;
  v12.pNext = submit2 ? &sync2 : nullptr;
  VkDeviceCreateInfo dci{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
  dci.pNext = &v12;
  dci.queueCreateInfoCount = 1;
  dci.pQueueCreateInfos = &qi;
  dci.enabledExtensionCount = uint32_t(dext.size());
  dci.ppEnabledExtensionNames = dext.data();
  CHECK(vkCreateDevice(a.phys, &dci, nullptr, &a.device));
  vkGetDeviceQueue(a.device, a.family, 0, &a.queue);

  // swapchain
  uint32_t nf = 0;
  vkGetPhysicalDeviceSurfaceFormatsKHR(a.phys, surface, &nf, nullptr);
  std::vector<VkSurfaceFormatKHR> formats(nf);
  vkGetPhysicalDeviceSurfaceFormatsKHR(a.phys, surface, &nf, formats.data());
  VkSurfaceFormatKHR fmt = formats[0];
  for (auto& f : formats)
    if (f.format == VK_FORMAT_B8G8R8A8_UNORM && f.colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR) fmt = f;
  VkSurfaceCapabilitiesKHR caps;
  vkGetPhysicalDeviceSurfaceCapabilitiesKHR(a.phys, surface, &caps);
  VkSwapchainCreateInfoKHR sci{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};
  sci.surface = surface;
  sci.minImageCount = std::max(2u, caps.minImageCount);
  sci.imageFormat = fmt.format;
  sci.imageColorSpace = fmt.colorSpace;
  sci.imageExtent = {W, H};
  sci.imageArrayLayers = 1;
  sci.imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
  sci.preTransform = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR;
  sci.compositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
  sci.presentMode = VK_PRESENT_MODE_FIFO_KHR;
  sci.clipped = VK_TRUE;
  VkSwapchainKHR swapchain;
  CHECK(vkCreateSwapchainKHR(a.device, &sci, nullptr, &swapchain));
  uint32_t ni = 0;
  vkGetSwapchainImagesKHR(a.device, swapchain, &ni, nullptr);
  std::vector<VkImage> images(ni);
  vkGetSwapchainImagesKHR(a.device, swapchain, &ni, images.data());

  // render pass, depth, framebuffers
  const VkFormat depthFormat = VK_FORMAT_D32_SFLOAT;
  VkAttachmentDescription att[2] = {};
  att[0].format = fmt.format;
  att[0].samples = VK_SAMPLE_COUNT_1_BIT;
  att[0].loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
  att[0].storeOp = VK_ATTACHMENT_STORE_OP_STORE;
  att[0].stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
  att[0].stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
  att[0].initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
  att[0].finalLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
  att[1] = att[0];
  att[1].format = depthFormat;
  att[1].storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
  att[1].finalLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
  VkAttachmentReference colorRef{0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL}, depthRef{1, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
  VkSubpassDescription sub{};
  sub.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
  sub.colorAttachmentCount = 1;
  sub.pColorAttachments = &colorRef;
  sub.pDepthStencilAttachment = &depthRef;
  VkSubpassDependency dep{};
  dep.srcSubpass = VK_SUBPASS_EXTERNAL;
  dep.srcStageMask = dep.dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT | VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT;
  dep.dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
  VkRenderPassCreateInfo rpi{VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO};
  rpi.attachmentCount = 2;
  rpi.pAttachments = att;
  rpi.subpassCount = 1;
  rpi.pSubpasses = &sub;
  rpi.dependencyCount = 1;
  rpi.pDependencies = &dep;
  VkRenderPass pass;
  CHECK(vkCreateRenderPass(a.device, &rpi, nullptr, &pass));
  VkDeviceMemory depthMem;
  VkImage depth = a.Image(W, H, depthFormat, VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT, &depthMem);
  VkImageView depthView = a.View(depth, depthFormat, VK_IMAGE_ASPECT_DEPTH_BIT);
  std::vector<VkFramebuffer> fbs(ni);
  for (uint32_t i = 0; i < ni; i++) {
    VkImageView views[2] = {a.View(images[i], fmt.format, VK_IMAGE_ASPECT_COLOR_BIT), depthView};
    VkFramebufferCreateInfo fi{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};
    fi.renderPass = pass;
    fi.attachmentCount = 2;
    fi.pAttachments = views;
    fi.width = W, fi.height = H, fi.layers = 1;
    CHECK(vkCreateFramebuffer(a.device, &fi, nullptr, &fbs[i]));
  }

  // command pool, used for uploads and every frame
  VkCommandPoolCreateInfo cpi{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
  cpi.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
  cpi.queueFamilyIndex = a.family;
  VkCommandPool pool;
  CHECK(vkCreateCommandPool(a.device, &cpi, nullptr, &pool));
  VkCommandBufferAllocateInfo cai{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
  cai.commandPool = pool;
  cai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
  cai.commandBufferCount = 1;
  VkCommandBuffer cmd, inner;
  CHECK(vkAllocateCommandBuffers(a.device, &cai, &cmd));
  cai.level = VK_COMMAND_BUFFER_LEVEL_SECONDARY;
  CHECK(vkAllocateCommandBuffers(a.device, &cai, &inner));
  cai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;

  // textures: a checker and stripes, made here
  const uint32_t TS = 256;
  VkDescriptorSetLayoutBinding binding{0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, nullptr};
  VkDescriptorSetLayoutCreateInfo dli{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
  dli.bindingCount = 1;
  dli.pBindings = &binding;
  VkDescriptorSetLayout setLayout;
  CHECK(vkCreateDescriptorSetLayout(a.device, &dli, nullptr, &setLayout));
  VkDescriptorPoolSize ps{VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 3};
  VkDescriptorPoolCreateInfo dpi{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
  dpi.maxSets = 3;
  dpi.poolSizeCount = 1;
  dpi.pPoolSizes = &ps;
  VkDescriptorPool dpool;
  CHECK(vkCreateDescriptorPool(a.device, &dpi, nullptr, &dpool));
  VkSamplerCreateInfo smi{VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO};
  smi.magFilter = smi.minFilter = VK_FILTER_LINEAR;
  smi.addressModeU = smi.addressModeV = smi.addressModeW = VK_SAMPLER_ADDRESS_MODE_REPEAT;
  VkSampler sampler;
  CHECK(vkCreateSampler(a.device, &smi, nullptr, &sampler));
  auto nameObject = (PFN_vkSetDebugUtilsObjectNameEXT)vkGetDeviceProcAddr(a.device, "vkSetDebugUtilsObjectNameEXT");
  auto name = [&](VkObjectType type, uint64_t handle, const char* text) {
    if (!nameObject) return;
    VkDebugUtilsObjectNameInfoEXT ni{VK_STRUCTURE_TYPE_DEBUG_UTILS_OBJECT_NAME_INFO_EXT};
    ni.objectType = type, ni.objectHandle = handle, ni.pObjectName = text;
    nameObject(a.device, &ni);
  };
  VkDescriptorSet sets[3];
  const char* textureNames[3] = {"checker texture", "stripes texture", "fallback texture"};
  for (int t = 0; t < 3; t++) {
    std::vector<uint8_t> px(TS * TS * 4);
    for (uint32_t y = 0; y < TS; y++)
      for (uint32_t x = 0; x < TS; x++) {
        bool on = t == 1 ? (y / 16) % 2 : ((x / 32) + (y / 32)) % 2;
        uint8_t* p = &px[(y * TS + x) * 4];
        uint8_t v = on ? 235 : (t == 0 ? 120 : 170);
        p[0] = v, p[1] = v, p[2] = uint8_t(t == 0 ? v : v * 0.85), p[3] = 255;
        if (t == 2) p[0] = on ? 255 : 0, p[1] = 0, p[2] = on ? 255 : 0;  // the engine's magenta and black "missing" checker
      }
    VkDeviceMemory stagingMem, texMem;
    VkBuffer staging = a.Buffer(px.size(), VK_BUFFER_USAGE_TRANSFER_SRC_BIT, px.data(), &stagingMem);
    VkImage tex = a.Image(TS, TS, VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT, &texMem);
    VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    vkBeginCommandBuffer(cmd, &bi);
    VkImageMemoryBarrier b{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
    b.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    b.newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
    b.dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    b.srcQueueFamilyIndex = b.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    b.image = tex;
    b.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, nullptr, 0, nullptr, 1, &b);
    VkBufferImageCopy region{};
    region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    region.imageExtent = {TS, TS, 1};
    vkCmdCopyBufferToImage(cmd, staging, tex, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
    b.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
    b.newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
    b.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    b.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, 0, 0, nullptr, 0, nullptr, 1, &b);
    vkEndCommandBuffer(cmd);
    VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    si.commandBufferCount = 1;
    si.pCommandBuffers = &cmd;
    CHECK(vkQueueSubmit(a.queue, 1, &si, VK_NULL_HANDLE));
    vkQueueWaitIdle(a.queue);
    vkDestroyBuffer(a.device, staging, nullptr);
    vkFreeMemory(a.device, stagingMem, nullptr);
    VkDescriptorSetAllocateInfo sai{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
    sai.descriptorPool = dpool;
    sai.descriptorSetCount = 1;
    sai.pSetLayouts = &setLayout;
    CHECK(vkAllocateDescriptorSets(a.device, &sai, &sets[t]));
    name(VK_OBJECT_TYPE_IMAGE, uint64_t(tex), textureNames[t]);  // engines name their textures, rarely their sets
    VkDescriptorImageInfo dii{sampler, a.View(tex, VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_ASPECT_COLOR_BIT), VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
    VkWriteDescriptorSet w{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
    w.dstSet = sets[t];
    w.descriptorCount = 1;
    w.descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    w.pImageInfo = &dii;
    vkUpdateDescriptorSets(a.device, 1, &w, 0, nullptr);
  }

  // meshes in one vertex and one index buffer
  std::vector<Vertex> verts;
  std::vector<uint32_t> idx;
  Mesh meshes[3];
  auto add = [&](int k, void (*fn)(std::vector<Vertex>&, std::vector<uint32_t>&)) {
    meshes[k].firstIndex = uint32_t(idx.size());
    meshes[k].vertexOffset = 0;
    fn(verts, idx);
    meshes[k].indexCount = uint32_t(idx.size()) - meshes[k].firstIndex;
  };
  add(0, AddPlane);
  add(1, AddCube);
  add(2, [](std::vector<Vertex>& v, std::vector<uint32_t>& i) { AddSphere(v, i); });
  VkDeviceMemory vmem, imem;
  VkBuffer vbuf = a.Buffer(verts.size() * sizeof(Vertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, verts.data(), &vmem);
  VkBuffer ibuf = a.Buffer(idx.size() * 4, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, idx.data(), &imem);
  VkDrawIndexedIndirectCommand commands[3];
  for (int k = 0; k < 3; k++) commands[k] = {meshes[k].indexCount, 1, meshes[k].firstIndex, meshes[k].vertexOffset, 0};
  VkDeviceMemory dmem, cmem;
  VkBuffer dbuf = a.Buffer(sizeof commands, VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, commands, &dmem);
  const uint32_t one = 1;
  VkBuffer cbuf = a.Buffer(sizeof one, VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, &one, &cmem);

  // pipelines: solid, and glass (blended, no depth writes)
  auto shader = [&](const char* file) {
    auto words = ReadFile(shaders + "/" + file);
    VkShaderModuleCreateInfo si{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
    si.codeSize = words.size() * 4;
    si.pCode = words.data();
    VkShaderModule m;
    CHECK(vkCreateShaderModule(a.device, &si, nullptr, &m));
    return m;
  };
  VkShaderModule vs = shader("scene.vert.spv"), fs = shader("scene.frag.spv");
  VkPushConstantRange pcr{VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0, sizeof(Push)};
  VkPipelineLayoutCreateInfo pli{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
  pli.setLayoutCount = 1;
  pli.pSetLayouts = &setLayout;
  pli.pushConstantRangeCount = 1;
  pli.pPushConstantRanges = &pcr;
  VkPipelineLayout layout;
  CHECK(vkCreatePipelineLayout(a.device, &pli, nullptr, &layout));
  VkPipelineShaderStageCreateInfo stages[2] = {{VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO}, {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO}};
  stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT, stages[0].module = vs, stages[0].pName = "main";
  stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT, stages[1].module = fs, stages[1].pName = "main";
  VkVertexInputBindingDescription vb{0, sizeof(Vertex), VK_VERTEX_INPUT_RATE_VERTEX};
  VkVertexInputAttributeDescription va[3] = {{0, 0, VK_FORMAT_R32G32B32_SFLOAT, 0}, {1, 0, VK_FORMAT_R32G32B32_SFLOAT, 12}, {2, 0, VK_FORMAT_R32G32_SFLOAT, 24}};
  VkPipelineVertexInputStateCreateInfo vi{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
  vi.vertexBindingDescriptionCount = 1, vi.pVertexBindingDescriptions = &vb;
  vi.vertexAttributeDescriptionCount = 3, vi.pVertexAttributeDescriptions = va;
  VkPipelineInputAssemblyStateCreateInfo ia{VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};
  ia.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
  VkViewport viewport{0, 0, float(W), float(H), 0, 1};
  VkRect2D scissor{{0, 0}, {W, H}};
  VkPipelineViewportStateCreateInfo vps{VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};
  vps.viewportCount = 1, vps.pViewports = &viewport, vps.scissorCount = 1, vps.pScissors = &scissor;
  VkPipelineRasterizationStateCreateInfo rs{VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};
  rs.polygonMode = VK_POLYGON_MODE_FILL;
  rs.cullMode = VK_CULL_MODE_BACK_BIT;
  rs.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE;
  rs.lineWidth = 1;
  VkPipelineMultisampleStateCreateInfo ms{VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};
  ms.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;
  VkPipelineDepthStencilStateCreateInfo ds{VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO};
  ds.depthTestEnable = ds.depthWriteEnable = VK_TRUE;
  ds.depthCompareOp = VK_COMPARE_OP_LESS;
  VkPipelineColorBlendAttachmentState blend{};
  blend.colorWriteMask = 0xf;
  VkPipelineColorBlendStateCreateInfo cb{VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};
  cb.attachmentCount = 1, cb.pAttachments = &blend;
  VkGraphicsPipelineCreateInfo gp{VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO};
  gp.stageCount = 2, gp.pStages = stages, gp.pVertexInputState = &vi, gp.pInputAssemblyState = &ia, gp.pViewportState = &vps;
  gp.pRasterizationState = &rs, gp.pMultisampleState = &ms, gp.pDepthStencilState = &ds, gp.pColorBlendState = &cb;
  gp.layout = layout, gp.renderPass = pass;
  VkPipeline solid, glass, flipped;
  CHECK(vkCreateGraphicsPipelines(a.device, VK_NULL_HANDLE, 1, &gp, nullptr, &solid));
  rs.cullMode = VK_CULL_MODE_FRONT_BIT;  // a winding bug: the front faces are culled
  CHECK(vkCreateGraphicsPipelines(a.device, VK_NULL_HANDLE, 1, &gp, nullptr, &flipped));
  rs.cullMode = VK_CULL_MODE_NONE;
  ds.depthWriteEnable = VK_FALSE;
  blend.blendEnable = VK_TRUE;
  blend.srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA, blend.dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
  blend.srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE, blend.dstAlphaBlendFactor = VK_BLEND_FACTOR_ZERO;
  CHECK(vkCreateGraphicsPipelines(a.device, VK_NULL_HANDLE, 1, &gp, nullptr, &glass));
  name(VK_OBJECT_TYPE_PIPELINE, uint64_t(solid), "solid");
  name(VK_OBJECT_TYPE_PIPELINE, uint64_t(flipped), "solid");
  name(VK_OBJECT_TYPE_PIPELINE, uint64_t(glass), "glass");

  // frames
  VkSemaphoreCreateInfo semi{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
  VkSemaphore acquired;
  CHECK(vkCreateSemaphore(a.device, &semi, nullptr, &acquired));
  std::vector<VkSemaphore> rendered(ni);
  for (auto& s : rendered) CHECK(vkCreateSemaphore(a.device, &semi, nullptr, &s));
  VkFenceCreateInfo fci{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
  VkFence done;
  CHECK(vkCreateFence(a.device, &fci, nullptr, &done));
  VkSemaphoreTypeCreateInfo sti{VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO};
  sti.semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE;
  VkSemaphoreCreateInfo tsi{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
  tsi.pNext = &sti;
  VkSemaphore frameCount = VK_NULL_HANDLE;
  if (timeline) CHECK(vkCreateSemaphore(a.device, &tsi, nullptr, &frameCount));
  auto queueSubmit2 = submit2 ? (PFN_vkQueueSubmit2KHR)vkGetDeviceProcAddr(a.device, "vkQueueSubmit2KHR") : nullptr;
  const float palette[10][3] = {{0.90f, 0.30f, 0.25f}, {0.95f, 0.65f, 0.20f}, {0.95f, 0.90f, 0.35f}, {0.45f, 0.80f, 0.35f}, {0.25f, 0.70f, 0.75f},
                                {0.30f, 0.45f, 0.90f}, {0.60f, 0.40f, 0.85f}, {0.90f, 0.45f, 0.70f}, {0.85f, 0.85f, 0.85f}, {0.55f, 0.40f, 0.30f}};
  Mat proj = Perspective(0.9f, float(W) / H, 0.1f, 100.f);
  for (int frame = 0; frame < frames; frame++) {
    uint32_t image;
    CHECK(vkAcquireNextImageKHR(a.device, swapchain, UINT64_MAX, acquired, VK_NULL_HANDLE, &image));
    float cam = 0.4f + frame * 0.006f;
    float eye[3] = {9.5f * std::cos(cam), 4.2f, 9.5f * std::sin(cam)}, at[3] = {0, 0.6f, 0};
    Mat viewProj = proj * LookAt(eye, at);

    vkResetCommandBuffer(cmd, 0);
    VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(cmd, &bi);
    VkClearValue clear[2];
    clear[0].color = {{0.52f, 0.66f, 0.80f, 1}};
    clear[1].depthStencil = {1, 0};
    VkRenderPassBeginInfo rbi{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};
    rbi.renderPass = pass;
    rbi.framebuffer = fbs[image];
    rbi.renderArea = scissor;
    rbi.clearValueCount = 2;
    rbi.pClearValues = clear;
    vkCmdBeginRenderPass(cmd, &rbi, secondary ? VK_SUBPASS_CONTENTS_SECONDARY_COMMAND_BUFFERS : VK_SUBPASS_CONTENTS_INLINE);
    VkCommandBuffer outer = cmd;
    if (secondary) {
      VkCommandBufferInheritanceInfo inh{VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_INFO};
      inh.renderPass = pass;
      inh.framebuffer = fbs[image];
      VkCommandBufferBeginInfo sbi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
      sbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT | VK_COMMAND_BUFFER_USAGE_RENDER_PASS_CONTINUE_BIT;
      sbi.pInheritanceInfo = &inh;
      vkResetCommandBuffer(inner, 0);
      vkBeginCommandBuffer(inner, &sbi);
      cmd = inner;
    }
    VkDeviceSize zero = 0;
    vkCmdBindVertexBuffers(cmd, 0, 1, &vbuf, &zero);
    vkCmdBindIndexBuffer(cmd, ibuf, 0, VK_INDEX_TYPE_UINT32);
    int drawNumber = 0;
    auto draw = [&](VkPipeline pipe, int set, const Mesh& m, const Mat& model, const float* rgb, float alpha, float repeat) {
      if (drawNumber++ == bugDraw) {  // the shipped bug
        if (bugKind == "texture") set = 2;
        if (bugKind == "inside") pipe = flipped;
      }
      vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
      vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[set], 0, nullptr);
      Push p{viewProj * model, model, {rgb[0], rgb[1], rgb[2], alpha}, {repeat, 0, 0, 0}};
      vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0, sizeof p, &p);
      VkDeviceSize at = VkDeviceSize(&m - meshes) * sizeof(VkDrawIndexedIndirectCommand);
      if (indirectCount) vkCmdDrawIndexedIndirectCount(cmd, dbuf, at, cbuf, 0, 1, sizeof(VkDrawIndexedIndirectCommand));
      else if (indirect) vkCmdDrawIndexedIndirect(cmd, dbuf, at, 1, sizeof(VkDrawIndexedIndirectCommand));
      else vkCmdDrawIndexed(cmd, m.indexCount, 1, m.firstIndex, m.vertexOffset, 0);
    };
    const float ground[3] = {0.75f, 0.78f, 0.70f};
    draw(solid, 0, meshes[0], Scale(12, 1, 12), ground, 1, 6);
    for (int i = 0; i < 10; i++) {
      float ang = i * 2 * float(M_PI) / 10;
      float spin = frame * 0.02f + i;
      bool cube = i % 2 == 0;
      float s = cube ? 1.3f : 1.5f;
      Mat model = Translate(4.2f * std::cos(ang), s / 2 + 0.05f * std::sin(frame * 0.05f + i), 4.2f * std::sin(ang)) * RotateY(spin) *
                  (cube ? RotateX(0.3f) : Mat()) * Scale(s, s, s);
      draw(solid, i % 3 == 0 ? 1 : 0, meshes[cube ? 1 : 2], model, palette[i], 1, 1);
    }
    const float big[3] = {0.80f, 0.75f, 0.65f};
    draw(solid, 1, meshes[2], Translate(0, 1.4f, 0) * RotateY(frame * 0.01f) * Scale(2.8f, 2.8f, 2.8f), big, 1, 2);
    const float tint[3] = {0.6f, 0.85f, 1.0f};
    draw(glass, 0, meshes[1], Translate(-1.6f, 1.0f, 2.2f) * RotateY(0.5f) * Scale(1.2f, 2.0f, 1.2f), tint, 0.35f, 1);
    draw(glass, 0, meshes[1], Translate(2.0f, 0.8f, -1.8f) * RotateY(-0.3f) * Scale(1.6f, 1.6f, 1.6f), tint, 0.35f, 1);
    if (secondary) {
      vkEndCommandBuffer(inner);
      cmd = outer;
      vkCmdExecuteCommands(cmd, 1, &inner);
    }
    vkCmdEndRenderPass(cmd);
    vkEndCommandBuffer(cmd);

    VkSemaphore signals[2] = {rendered[image], frameCount};
    uint64_t values[2] = {0, uint64_t(frame) + 1}, zero64 = 0;
    if (submit2) {
      VkSemaphoreSubmitInfo w{VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO, nullptr, acquired, 0, VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT, 0};
      VkSemaphoreSubmitInfo s[2] = {{VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO, nullptr, signals[0], 0, VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT, 0},
                                    {VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO, nullptr, signals[1], values[1], VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT, 0}};
      VkCommandBufferSubmitInfo c{VK_STRUCTURE_TYPE_COMMAND_BUFFER_SUBMIT_INFO, nullptr, cmd, 0};
      VkSubmitInfo2 si{VK_STRUCTURE_TYPE_SUBMIT_INFO_2};
      si.waitSemaphoreInfoCount = 1, si.pWaitSemaphoreInfos = &w;
      si.commandBufferInfoCount = 1, si.pCommandBufferInfos = &c;
      si.signalSemaphoreInfoCount = timeline ? 2 : 1, si.pSignalSemaphoreInfos = s;
      CHECK(queueSubmit2(a.queue, 1, &si, done));
    } else {
      VkPipelineStageFlags wait = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
      VkTimelineSemaphoreSubmitInfo tl{VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO};
      tl.waitSemaphoreValueCount = 1, tl.pWaitSemaphoreValues = &zero64;
      tl.signalSemaphoreValueCount = 2, tl.pSignalSemaphoreValues = values;
      VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO};
      si.pNext = timeline ? &tl : nullptr;
      si.waitSemaphoreCount = 1, si.pWaitSemaphores = &acquired, si.pWaitDstStageMask = &wait;
      si.commandBufferCount = 1, si.pCommandBuffers = &cmd;
      si.signalSemaphoreCount = timeline ? 2 : 1, si.pSignalSemaphores = signals;
      CHECK(vkQueueSubmit(a.queue, 1, &si, done));
    }
    VkPresentInfoKHR pi{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};
    pi.waitSemaphoreCount = 1, pi.pWaitSemaphores = &rendered[image];
    pi.swapchainCount = 1, pi.pSwapchains = &swapchain, pi.pImageIndices = &image;
    VkResult pr = vkQueuePresentKHR(a.queue, &pi);
    if (pr != VK_SUCCESS && pr != VK_SUBOPTIMAL_KHR) std::fprintf(stderr, "present: %d\n", int(pr));
    CHECK(vkWaitForFences(a.device, 1, &done, VK_TRUE, UINT64_MAX));
    CHECK(vkResetFences(a.device, 1, &done));
    if (timeline) {
      uint64_t reached = 0;
      vkGetSemaphoreCounterValue(a.device, frameCount, &reached);
      if (reached != uint64_t(frame) + 1) std::fprintf(stderr, "timeline at %llu, expected %d\n", (unsigned long long)reached, frame + 1);
    }
  }
  vkDeviceWaitIdle(a.device);
  std::printf("drew %d frames at %ux%u\n", frames, W, H);
  vkDestroyDevice(a.device, nullptr);  // the rest goes with the process
  return 0;
}
