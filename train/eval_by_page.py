"""Score a checkpoint on a captured dataset's validation frames, broken down by page.

For the same-page test (scripts/split_same_page.py) it separates pages whose validation view differs a lot from the
views trained on from pages whose camera barely moved, and can restrict to a list of pages (for a head-to-head with a
model that never saw those pages at all).

    .venv/bin/python train/eval_by_page.py --ckpt runs/gl1-samepage/best.pt --data data/gl-v1-samepage
        [--pages-from data/gl-v1/manifest.jsonl --pages-split val]
"""
import argparse
import collections
import json
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from data import GlitchFrames
from eval_clean import bootstrap_auroc
from train import auroc, build_model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--pages-from", default=None, help="a manifest.jsonl whose pages (of --pages-split) to keep")
    ap.add_argument("--pages-split", default="val")
    ap.add_argument("--changed", type=float, default=0.2, help="view change above which a page counts as a new view")
    ap.add_argument("--per-page", action="store_true", help="also report each page on its own")
    args = ap.parse_args()

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    ck = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    model = build_model(len(ck["types"]), ck["encoder"], pretrained=False)
    model.load_state_dict(ck["model"])
    model.to(device).eval()

    root = Path(args.data)
    rows = [json.loads(line) for line in (root / "manifest.jsonl").read_text().splitlines() if line]
    app_of = {r["seed"]: r["app"] for r in rows}
    view_change = json.loads((root / "dataset.json").read_text()).get("view_change", {})
    keep = None
    if args.pages_from:
        other = [json.loads(line) for line in Path(args.pages_from).read_text().splitlines() if line]
        keep = {r["app"] for r in other if r["split"] == args.pages_split}

    ds = GlitchFrames(root, "val", train=False)
    scores = []
    with torch.no_grad():
        for x, _, y in DataLoader(ds, 8, shuffle=False, num_workers=4):
            _, type_logits = model(x.to(device))
            scores += [float(p) for p in 1 - type_logits.softmax(1)[:, 0].cpu()]
    items = [{"app": app_of[seed], "label": label, "type": ds.types[label], "score": s}
             for (_, _, label, seed, _), s in zip(ds.items, scores)]
    if keep is not None:
        items = [it for it in items if it["app"] in keep]

    def report(name, its):
        pos = [it["score"] for it in its if it["label"]]
        neg = [it["score"] for it in its if not it["label"]]
        if not pos or not neg:
            return
        at5 = float(np.quantile(neg, 0.95))
        by_type = collections.defaultdict(list)
        for it in its:
            if it["label"]:
                by_type[it["type"]].append(it["score"] > at5)
        print(f"{name}: {len({it['app'] for it in its})} pages, {len(pos)} broken / {len(neg)} clean; "
              f"AUROC {auroc(pos + neg, [1] * len(pos) + [0] * len(neg)):.3f} {bootstrap_auroc(pos, neg)}; "
              f"caught at 5% false alarms {np.mean([p > at5 for p in pos]):.2f}")
        print("   by type at 5% false alarms:", {t: f"{np.mean(v):.2f} (n={len(v)})" for t, v in sorted(by_type.items())})

    report("all", items)
    report(f"view changed > {args.changed}", [it for it in items if view_change.get(it["app"], 1) > args.changed])
    report(f"view changed <= {args.changed}", [it for it in items if view_change.get(it["app"], 1) <= args.changed])
    if args.per_page:
        for app in sorted({it["app"] for it in items}):
            report(f"{app} (view change {view_change.get(app)})", [it for it in items if it["app"] == app])


if __name__ == "__main__":
    main()
