"""Re-split a captured dataset by moment instead of by page: the "train on your own app" test.

Every page with samples from two or more moments gives its last moment to validation and the rest to training, so
the model is tested on new views of pages it has seen. The new dataset points at the original images.

It also records, per page, how much the validation view differs from the nearest training view (share of pixels that
changed by more than 12/255 between clean frames), because a page whose camera barely moved is a much easier test.

    .venv/bin/python -I scripts/split_same_page.py data/gl-v1 data/gl-v1-samepage
"""
import collections
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in (src / "manifest.jsonl").read_text().splitlines() if line]
    moments = collections.defaultdict(set)
    for r in rows:
        moments[r["app"]].add(r["moment"])
    rel = os.path.relpath(src, dst)
    out, view_change = [], {}
    for r in rows:
        ms = sorted(moments[r["app"]])
        r = {**r, "split": "val" if len(ms) > 1 and r["moment"] == ms[-1] else "train",
             "files": {k: f"{rel}/{v}" for k, v in r["files"].items()}}
        out.append(r)
    for app, ms in moments.items():
        ms = sorted(ms)
        if len(ms) < 2:
            continue
        load = lambda m: np.asarray(Image.open(src / f"clean/{app}/{m}.png").convert("RGB"), dtype=np.int16)
        last = load(ms[-1])
        view_change[app] = round(min(float((np.abs(load(m) - last).max(axis=2) > 12).mean()) for m in ms[:-1]), 4)
    (dst / "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in out))
    meta = json.loads((src / "dataset.json").read_text())
    (dst / "dataset.json").write_text(json.dumps({
        "glitch_types": meta["glitch_types"], "size": meta["size"], "source": f"{src} re-split by moment",
        "val_rule": "each page's last moment, for pages with samples from two or more moments",
        "view_change": view_change}, indent=1))
    split = collections.Counter(r["split"] for r in out)
    changed = sum(v > 0.2 for v in view_change.values())
    print(f"{dict(split)}; {len(view_change)} pages tested on a new moment, {changed} of them with a view that changed "
          f"on more than 20% of pixels; median change {np.median(list(view_change.values())):.3f}")


if __name__ == "__main__":
    main()
