"""Check screenshots with a model learned for one app (framehound learn): a glitch score, a verdict and a heatmap.

The verdict uses the score threshold that let through 5% of the app's own held-out clean frames, so about one clean
frame in twenty is flagged; set another with --threshold.

    .venv/bin/python train/check.py --model models/hexgl shot1.png shot2.png [--out heatmaps/] [--threshold 0.8]
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from eval_clean import overlay
from eval_glitchbench import prepare
from train import build_model, pick_device


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="a folder made by framehound learn (model.pt and report.json)")
    ap.add_argument("images", nargs="+")
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--short-side", type=int, default=432)  # the training frames' height
    ap.add_argument("--out", default=None, help="folder for frame | heatmap images (default: next to each screenshot)")
    args = ap.parse_args()

    model_dir = Path(args.model)
    ck = torch.load(model_dir / "model.pt", map_location="cpu", weights_only=False)
    report = json.loads((model_dir / "report.json").read_text()) if (model_dir / "report.json").exists() else {}
    threshold = args.threshold if args.threshold is not None else report.get("threshold_at_5pct_false_alarms", 0.5)
    device = pick_device()
    model = build_model(len(ck["types"]), ck["encoder"], pretrained=False)
    model.load_state_dict(ck["model"])
    model.to(device).eval()

    for path in map(Path, args.images):
        img = Image.open(path).convert("RGB")
        x, small, (h, w) = prepare(img, args.short_side)
        with torch.no_grad():
            mask_logits, type_logits = model(x[None].to(device))
        heat = torch.sigmoid(mask_logits)[0, 0, :h, :w].cpu().numpy()
        p_type = type_logits.softmax(1)[0].cpu().numpy()
        score = float(1 - p_type[0])
        kind = ck["types"][1 + int(p_type[1:].argmax())]
        out_dir = Path(args.out) if args.out else path.parent
        out_dir.mkdir(parents=True, exist_ok=True)
        pair = Image.new("RGB", (small.width * 2, small.height))
        pair.paste(small, (0, 0))
        pair.paste(overlay(small, heat), (small.width, 0))
        heat_file = out_dir / f"{path.stem}.framehound.png"
        pair.save(heat_file)
        box = hottest_patch(heat)
        if box:
            sx, sy = img.width / w, img.height / h
            box = [int(box[0] * sx), int(box[1] * sy), int(box[2] * sx), int(box[3] * sy)]
        flagged = score > threshold
        print(json.dumps({"image": str(path), "glitch": flagged, "score": round(score, 3), "threshold": round(threshold, 3),
                          "likely_kind": kind if flagged else None, "region": box if flagged else None, "heatmap": str(heat_file)}))


def hottest_patch(heat, cell=4):
    """Bounding box (x0, y0, x1, y1) of the biggest connected patch of strongly flagged pixels, found on a coarse grid."""
    h, w = heat.shape
    grid = heat[: h - h % cell, : w - w % cell].reshape(h // cell, cell, w // cell, cell).mean(axis=(1, 3))
    hot = grid > max(0.5, 0.6 * float(grid.max()))
    seen = np.zeros_like(hot)
    best = None
    for y0, x0 in zip(*np.nonzero(hot)):
        if seen[y0, x0]:
            continue
        stack, cells = [(y0, x0)], []
        seen[y0, x0] = True
        while stack:
            y, x = stack.pop()
            cells.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < hot.shape[0] and 0 <= nx < hot.shape[1] and hot[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        if best is None or len(cells) > len(best):
            best = cells
    if not best:
        return None
    ys, xs = zip(*best)
    return [min(xs) * cell, min(ys) * cell, (max(xs) + 1) * cell, (max(ys) + 1) * cell]


if __name__ == "__main__":
    main()
