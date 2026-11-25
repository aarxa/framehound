# framehound's Vulkan layer

This is the native version of the WebGL injector, `generator/inject/glitch-gl.js`. It's a Vulkan layer that the
Vulkan loader puts into any Vulkan app. It writes the app's own frames twice, once clean and once with one draw call
broken, along with the exact mask of the broken pixels. The output has the same layout as the WebGL capture, so
`scripts/split_same_page.py`, `train/train.py` and the evaluations read it unchanged.

![Frames from the test scene: clean, with one draw broken by the layer, and the mask](../docs/vulkan-layer.jpg)

## How it works

The WebGL injector freezes the page's clock and replays the recorded frame, so it can draw the frame twice. A layer
can't freeze a native app's clock, so this one draws the frame twice another way:

- **Shadow recording.** On a capture frame, every command the app records goes into its own command buffer and also
  into a few shadow copies. Each copy breaks one draw call. The layer has wrappers for all 307 recording commands,
  generated from the Vulkan registry (`layer/gen_commands.py`), so no command goes missing from a copy.
- **Each copy submitted in turn.** When the app submits, the layer runs each shadow copy and reads the finished
  swapchain image back. Then it runs the app's own command buffers and reads the clean frame. The app has already
  written that frame's data (matrices, animation, uniforms), so the clean and broken frames differ only by the broken
  draw.
- **Pipeline variants.** Glitches that change render state (culling, depth test, blending) need different pipelines.
  The layer creates those variants inside `vkCreateGraphicsPipelines`, while the app's create info is still at hand,
  and binds them for the broken draw only.
- **Copied descriptor sets.** For a missing texture, the broken draw gets a copy of one of its descriptor sets, with
  one sampled image swapped for a fallback texture.
- **Same rules as the WebGL side.** A broken frame is kept only if the glitch is visible:
  - 0.2–60% of the frame changes;
  - at least 0.1% of the frame changes plainly, in a patch of at least 150 px (at 768×432);
  - the frame doesn't go blank.

The six glitches so far:

| Glitch | What happens to the draw |
|---|---|
| `missing_draw` | it never happens |
| `missing_texture` | one of its textures is swapped for a fallback: magenta/black checker, black or grey checker |
| `dropped_faces` | a run of its triangles is skipped, leaving a hole |
| `inside_out` | culling is flipped and the inside shows |
| `depth_test_off` | it draws over whatever should hide it |
| `additive_blend` | it's blended additively, so it glows and turns see-through |

## Build and run

You need CMake, a C++17 compiler, the Vulkan loader and headers, and glslang. On a Mac, MoltenVK and the rest come
from Homebrew:

```bash
brew install molten-vk vulkan-loader vulkan-headers vulkan-tools glslang cmake
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
```

Run any Vulkan app with the layer on:

```bash
FRAMEHOUND_OUT=data/native-scene FRAMEHOUND_APP=scene FRAMEHOUND_START=10 FRAMEHOUND_EVERY=5 \
  FRAMEHOUND_CAPTURES=140 FRAMEHOUND_VARIANTS=10 \
  VK_ADD_LAYER_PATH=native/build VK_INSTANCE_LAYERS=VK_LAYER_FRAMEHOUND_glitch \
  native/build/fh_scene --frames 720
```

Then learn from it as from any capture:

```bash
.venv/bin/python -I scripts/split_same_page.py data/native-scene data/native-scene-split --last-share 0.2
.venv/bin/python train/train.py --data data/native-scene-split --out runs/native-scene --epochs 15
```

| Setting | Meaning |
|---|---|
| `FRAMEHOUND_OUT` | folder to write to; without it the layer passes everything through |
| `FRAMEHOUND_APP` | the app's id in the manifest |
| `FRAMEHOUND_START`, `FRAMEHOUND_EVERY` | first frame to capture, then every N frames |
| `FRAMEHOUND_CAPTURES` | the most frames to capture |
| `FRAMEHOUND_VARIANTS` | broken copies per captured frame |
| `FRAMEHOUND_TYPES` | glitches to use, comma-separated |
| `FRAMEHOUND_SHADOW_ALL=1` | shadow every command buffer, for apps that record theirs once and submit them every frame |
| `FRAMEHOUND_SEED` | random seed |

`fh_scene` (`testapp/`) is a small Vulkan scene for trying the layer without a game. It draws a textured ground, a ring
of turning cubes and spheres, and two glass boxes, to a headless swapchain (no window). Like a game engine, it
re-records its command buffer every frame. `--indirect` draws everything with `vkCmdDrawIndexedIndirect`, and
`--secondary` records the draws in a secondary command buffer.

## Results so far

RESULTS_PLACEHOLDER

## Not done yet

- **A real engine.** Official Godot builds for macOS link MoltenVK into the engine, so the Vulkan loader, and with it
  every layer, is skipped. Godot built from source with `use_volk=yes` should load it. On Linux and Windows, engines go
  through the loader.
- **Things passed through unbroken:**
  - draws in secondary command buffers, with `FRAMEHOUND_SHADOW_ALL` (on capture frames they are broken like any
    other)
  - indirect draws with a count buffer (`vkCmdDrawIndirectCount`)
  - `vkQueueSubmit2`
  - submits with timeline semaphore values

  Indirect draws can be broken in every way except `dropped_faces`, since the GPU reads their counts.
- **State the GPU carries between frames.** Each copy is a full extra submit. Effects that keep history on the GPU,
  such as temporal anti-aliasing, see the frame once per copy and drift.
- **Glitches that need the app's vertex data.** Lost texture coordinates and exploded vertices need copies of vertex
  buffers, which the layer doesn't make yet.
