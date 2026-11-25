"""Re-split a captured dataset by moment instead of by page: the "train on your own app" test.

Every page with samples from two or more moments gives its last moments to validation and the rest to training, so
the model is tested on new views of pages it has seen: the last moment only, or the last share of them with
--last-share (a block at the end, not a random pick, so test views aren't next to training views in time). The new
dataset points at the original images.

It also records, per page, how much the validation views differ from the nearest training view (share of pixels that
changed by more than 12/255 between clean frames, averaged over the validation moments), because a page whose camera
barely moved is a much easier test.

    .venv/bin/python -I scripts/split_same_page.py data/gl-v1 data/gl-v1-samepage [--last-share 0.2]
"""
import argparse
import collections
import json
import math
import os
from pathlib import Path

import numpy as np
from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--last-share", type=float, default=0, help="share of each page's moments to test on (0: the last one)")
    args = ap.parse_args()
    src, dst = Path(args.src), Path(args.dst)
    dst.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in (src / "manifest.jsonl").read_text().splitlines() if line]
    moments = collections.defaultdict(set)
    for r in rows:
        moments[r["app"]].add(r["moment"])
    test = {}
    for app, ms in moments.items():
        ms = sorted(ms)
        k = max(1, math.ceil(len(ms) * args.last_share)) if len(ms) > 1 else 0
        test[app] = set(ms[len(ms) - k:]) if k else set()
    rel = os.path.relpath(src, dst)
    out = [{**r, "split": "val" if r["moment"] in test[r["app"]] else "train",
            "files": {k: f"{rel}/{v}" for k, v in r["files"].items()}} for r in rows]
    view_change = {}
    for app, ms in moments.items():
        if not test[app]:
            continue
        load = lambda m: np.asarray(Image.open(src / f"clean/{app}/{m}.png").convert("RGB"), dtype=np.int16)
        train = [load(m) for m in sorted(ms - test[app])]
        changes = []
        for m in sorted(test[app]):
            t = load(m)
            changes.append(min(float((np.abs(c - t).max(axis=2) > 12).mean()) for c in train))
        view_change[app] = round(float(np.mean(changes)), 4)
    (dst / "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in out))
    meta = json.loads((src / "dataset.json").read_text())
    (dst / "dataset.json").write_text(json.dumps({
        "glitch_types": meta["glitch_types"], "size": meta["size"], "source": f"{src} re-split by moment",
        "val_rule": f"each page's last {'moment' if not args.last_share else f'{args.last_share:.0%} of moments'}, for pages with two or more",
        "view_change": view_change}, indent=1))
    split = collections.Counter(r["split"] for r in out)
    changed = sum(v > 0.2 for v in view_change.values())
    print(f"{dict(split)}; {len(view_change)} pages tested on new moments, {changed} of them with views that changed "
          f"on more than 20% of pixels; median change {np.median(list(view_change.values())):.3f}")
    for app, v in sorted(view_change.items(), key=lambda kv: -kv[1])[:10]:
        print(f"   {app}: view change {v}")


if __name__ == "__main__":
    main()
