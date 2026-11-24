"""Apply the injector's visibility rules again to a dataset captured before a rule existed.

Keeps a sample only if its biggest connected patch of plainly changed pixels (more than 40/255) has at least 150
pixels, and its broken frame still has some brightness spread (a glitch that blanks the whole frame looks the same
as a clean empty scene). The rules match sample() in generator/inject/glitch-gl.js. The old manifest is kept as
manifest.unfiltered.jsonl.

    .venv/bin/python -I scripts/refilter_capture.py data/gl-v1
"""
import collections
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

STRONG, MIN_PATCH, MIN_SPREAD = 40, 150, 6.0


def biggest_patch(at, enough):
    h, w = at.shape
    flat = at.ravel()
    seen = np.zeros(flat.size, bool)
    best = 0
    for s in np.flatnonzero(flat):
        if seen[s]:
            continue
        seen[s] = True
        stack, size = [s], 0
        while stack:
            p = stack.pop()
            size += 1
            y, x = divmod(int(p), w)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w:
                        q = ny * w + nx
                        if flat[q] and not seen[q]:
                            seen[q] = True
                            stack.append(q)
        best = max(best, size)
        if best >= enough:
            break
    return best


def main():
    root = Path(sys.argv[1])
    src = root / "manifest.unfiltered.jsonl"
    if not src.exists():
        (root / "manifest.jsonl").rename(src)
    rows = [json.loads(line) for line in src.read_text().splitlines() if line]
    kept, why = [], collections.Counter()
    for r in rows:
        a = np.asarray(Image.open(root / r["files"]["clean"]).convert("RGB"), dtype=np.int16)
        b = np.asarray(Image.open(root / r["files"]["glitched"]).convert("RGB"), dtype=np.int16)
        strong = np.abs(a - b).max(axis=2) > STRONG
        lum = b @ np.array([0.2126, 0.7152, 0.0722])
        patch, spread = biggest_patch(strong, MIN_PATCH), float(lum.std())
        if patch < MIN_PATCH:
            why["scattered"] += 1
        elif spread < MIN_SPREAD:
            why["blank frame"] += 1
        else:
            kept.append(r)
    (root / "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in kept))
    by_type = collections.Counter(r["glitch"] for r in rows)
    kept_type = collections.Counter(r["glitch"] for r in kept)
    print(f"kept {len(kept)} of {len(rows)}; dropped {dict(why)}")
    print({t: f"{kept_type[t]}/{n}" for t, n in by_type.most_common()})


if __name__ == "__main__":
    main()
