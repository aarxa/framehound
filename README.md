# glitch-detector (working name)

A model that looks at a single frame from a game or 3D app and finds rendering glitches, with no reference image needed.

It learns from glitches injected on purpose: each sample is the same frame rendered twice, once clean and once broken, so the pixels the glitch changed are known exactly.

## Generator

Random three.js scenes, rendered headless in Chrome. Five glitch types so far:

| Glitch | What breaks |
|---|---|
| `missing_texture` | a texture fails to load; the engine shows magenta/black checker, magenta or black |
| `exploded_vertices` | a few vertices get garbage positions and the mesh shoots spikes |
| `z_fighting` | two surfaces at the same depth flicker through each other |
| `black_object` | shading breaks (NaN normals, failed shader) and the object renders black |
| `inside_out` | culling/winding is flipped and you see the object's back faces |

```bash
npm install
npm run generate -- --count 100 --out out/batch1     # clean / glitched / mask PNGs + manifest.jsonl
node generator/sheet.mjs out/batch1                    # contact sheet for checking them by eye
```

Uses the installed Google Chrome through Playwright.
