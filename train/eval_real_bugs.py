"""Real bugs: score frames from an app's broken release against frames from its fixed release.

The model was learned on the app's last good release (framehound learn). Frames from the release that shipped the bug
should score above frames from the release that fixed it. Reports AUROC (with a bootstrap 95% interval), how many
broken frames are flagged when 5% of fixed frames are, how many the model's own threshold flags (from report.json,
set on injected glitches), and a sheet of broken frames with heatmaps.

    .venv/bin/python train/eval_real_bugs.py --ckpt runs/x/best.pt --broken data/x-broken/clean --fixed data/x-fixed/clean
        [--report models/x/report.json] [--out runs/x/real_bug]
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

from eval_clean import bootstrap_auroc, overlay
from eval_glitchbench import prepare
from train import auroc, build_model, pick_device


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--broken", required=True, help="folder of frames from the release with the bug (searched recursively)")
    ap.add_argument("--fixed", required=True, help="folder of frames from the release that fixed it")
    ap.add_argument("--report", default=None, help="report.json from learning, for the model's own 5%% threshold")
    ap.add_argument("--short-side", type=int, default=432)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    device = pick_device()
    ck = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    model = build_model(len(ck["types"]), ck["encoder"], pretrained=False)
    model.load_state_dict(ck["model"])
    model.to(device).eval()

    def score(path):
        x, small, (h, w) = prepare(Image.open(path).convert("RGB"), args.short_side)
        with torch.no_grad():
            mask_logits, type_logits = model(x[None].to(device))
        p = type_logits.softmax(1)[0].cpu().numpy()
        return float(1 - p[0]), ck["types"][1 + int(p[1:].argmax())], small, torch.sigmoid(mask_logits)[0, 0, :h, :w].cpu().numpy()

    broken = sorted(Path(args.broken).rglob("*.png"))
    fixed = sorted(Path(args.fixed).rglob("*.png"))
    b = [score(p) for p in broken]
    f = [score(p) for p in fixed]
    pos, neg = [s for s, *_ in b], [s for s, *_ in f]
    at5 = float(np.quantile(neg, 0.95))
    own = json.loads(Path(args.report).read_text())["threshold_at_5pct_false_alarms"] if args.report else None
    summary = {
        "broken_frames": len(pos), "fixed_frames": len(neg),
        "auroc": round(auroc(pos + neg, [1] * len(pos) + [0] * len(neg)), 3), "auroc_95ci": bootstrap_auroc(pos, neg),
        "median_score_broken": round(float(np.median(pos)), 3), "median_score_fixed": round(float(np.median(neg)), 3),
        "caught_when_5pct_of_fixed_flagged": round(float(np.mean([s > at5 for s in pos])), 3),
        "own_threshold": own,
        "caught_at_own_threshold": round(float(np.mean([s > own for s in pos])), 3) if own is not None else None,
        "fixed_flagged_at_own_threshold": round(float(np.mean([s > own for s in neg])), 3) if own is not None else None,
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))

    # broken frames, most confident first: frame | heatmap
    order = sorted(range(len(b)), key=lambda i: -b[i][0])[:12]
    tiles = []
    for i in order:
        s, kind, small, heat = b[i]
        pair = Image.new("RGB", (small.width * 2, small.height))
        pair.paste(small, (0, 0))
        pair.paste(overlay(small, heat), (small.width, 0))
        tiles.append((pair.resize((round(pair.width * 180 / pair.height), 180)), s, kind))
    if tiles:
        tw = max(t.width for t, _, _ in tiles)
        sheet = Image.new("RGB", (2 * (tw + 16) + 16, math.ceil(len(tiles) / 2) * 210 + 16), (17, 17, 17))
        d = ImageDraw.Draw(sheet)
        for k, (t, s, kind) in enumerate(tiles):
            x, y = 16 + (k % 2) * (tw + 16), 16 + (k // 2) * 210
            sheet.paste(t, (x, y))
            d.text((x, y + 186), f"broken release  p(glitch) {s:.2f}  {kind}", fill=(255, 110, 110))
        sheet.save(out / "broken_frames.jpg", quality=88)


if __name__ == "__main__":
    main()
