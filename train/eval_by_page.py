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
from train import auroc, build_model, pick_device


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--pages-from", default=None, help="a manifest.jsonl whose pages (of --pages-split) to keep")
    ap.add_argument("--pages-split", default="val")
    ap.add_argument("--changed", type=float, default=0.2, help="view change above which a page counts as a new view")
    ap.add_argument("--per-page", action="store_true", help="also report each page on its own")
    ap.add_argument("--json", default=None, help="write the all-pages summary, with the score threshold at 5%% false alarms, here")
    args = ap.parse_args()

    device = pick_device()
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
            return None
        at5 = float(np.quantile(neg, 0.95))
        by_type = collections.defaultdict(list)
        for it in its:
            if it["label"]:
                by_type[it["type"]].append(it["score"] > at5)
        out = {"pages": len({it["app"] for it in its}), "broken": len(pos), "clean": len(neg),
               "auroc": round(auroc(pos + neg, [1] * len(pos) + [0] * len(neg)), 3), "auroc_95ci": bootstrap_auroc(pos, neg),
               "threshold_at_5pct_false_alarms": round(at5, 4), "caught_at_5pct_false_alarms": round(float(np.mean([p > at5 for p in pos])), 3),
               "caught_by_type": {t: {"caught": round(float(np.mean(v)), 3), "n": len(v)} for t, v in sorted(by_type.items())}}
        print(f"{name}: {out['pages']} pages, {out['broken']} broken / {out['clean']} clean; "
              f"AUROC {out['auroc']:.3f} {out['auroc_95ci']}; caught at 5% false alarms {out['caught_at_5pct_false_alarms']:.2f}")
        print("   by type at 5% false alarms:", {t: f"{v['caught']:.2f} (n={v['n']})" for t, v in out["caught_by_type"].items()})
        return out

    summary = report("all", items)
    if args.json and summary:
        Path(args.json).write_text(json.dumps({"checkpoint": args.ckpt, "data": args.data, **summary}, indent=2))
    report(f"view changed > {args.changed}", [it for it in items if view_change.get(it["app"], 1) > args.changed])
    report(f"view changed <= {args.changed}", [it for it in items if view_change.get(it["app"], 1) <= args.changed])
    if args.per_page:
        for app in sorted({it["app"] for it in items}):
            report(f"{app} (view change {view_change.get(app)})", [it for it in items if it["app"] == app])


if __name__ == "__main__":
    main()
