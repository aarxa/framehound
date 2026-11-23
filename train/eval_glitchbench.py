"""Run a trained model on GlitchBench (real game screenshots) and report detection by glitch category.

GlitchBench's public release (huggingface.co/datasets/glitchbench/GlitchBench, MIT) has 607 glitch screenshots
and no clean ones, so this measures how many real glitches the model flags, not its false-alarm rate.
Only "Rendering and Texture" is in framehound's scope; the other categories are reported for context.

    .venv/bin/python train/eval_glitchbench.py --ckpt runs/v1-resnet34/best.pt --data eval-data/glitchbench
"""
import argparse
import collections
import glob
import io
import json
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import torch
import torch.nn.functional as F
from PIL import Image, ImageDraw

from train import build_model

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def category(raw):
    # the dataset spells some categories with and without "Issues"/"Errors"; fold them together
    for key in ("Rendering", "Physics", "Animation", "Camera"):
        if raw.startswith(key):
            return key
    return raw


def prepare(img, short_side):
    """Resize so the short side matches training scale, then pad to a multiple of 32 for the U-Net."""
    w, h = img.size
    s = short_side / min(w, h)
    img = img.resize((max(32, round(w * s)), max(32, round(h * s))), Image.BILINEAR)
    arr = (np.asarray(img, dtype=np.float32) / 255.0 - MEAN) / STD
    x = torch.from_numpy(arr).permute(2, 0, 1)
    ph, pw = (-x.shape[1]) % 32, (-x.shape[2]) % 32
    return F.pad(x, (0, pw, 0, ph)), img, (x.shape[1], x.shape[2])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--data", default="eval-data/glitchbench")
    ap.add_argument("--short-side", type=int, default=512)
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    ck = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    types = ck["types"]
    model = build_model(len(types), ck["encoder"], pretrained=False)
    model.load_state_dict(ck["model"])
    model.to(device).eval()
    out = Path(args.out or Path(args.ckpt).parent / "glitchbench")
    out.mkdir(parents=True, exist_ok=True)

    results = []
    with torch.no_grad():
        for f in sorted(glob.glob(f"{args.data}/*.parquet")):
            pf = pq.ParquetFile(f)
            for batch in pf.iter_batches(batch_size=16, columns=["image", "id", "glitch-type", "game"]):
                for row in batch.to_pylist():
                    img = Image.open(io.BytesIO(row["image"]["bytes"])).convert("RGB")
                    x, small, (h, w) = prepare(img, args.short_side)
                    mask_logits, type_logits = model(x[None].to(device))
                    prob = torch.sigmoid(mask_logits)[0, 0, :h, :w].cpu().numpy()
                    p_type = type_logits.softmax(1)[0].cpu().numpy()
                    r = {
                        "id": row["id"], "game": row["game"], "category": category(row["glitch-type"]),
                        "p_glitch": float(1 - p_type[0]), "predicted_type": types[int(p_type.argmax())],
                        "pixel_score": float(np.sort(prob.ravel())[-64:].mean()),
                    }
                    results.append(r)
                    if r["category"] == "Rendering":
                        # keep the frame and the model's heatmap for the sheet
                        heat = (prob * 255).astype(np.uint8)
                        small.save(out / f"{r['id']}.jpg", quality=90)
                        Image.fromarray(heat).save(out / f"{r['id']}_heat.png")

    with open(out / "results.jsonl", "w") as fh:
        fh.writelines(json.dumps(r) + "\n" for r in results)

    by = collections.defaultdict(list)
    for r in results:
        by[r["category"]].append(r)
    summary = {}
    for cat, rs in sorted(by.items()):
        summary[cat] = {
            "n": len(rs),
            "flagged": round(sum(r["p_glitch"] > args.threshold for r in rs) / len(rs), 3),
            "median_p_glitch": round(float(np.median([r["p_glitch"] for r in rs])), 3),
            "predicted_types": dict(collections.Counter(r["predicted_type"] for r in rs).most_common()),
        }
    (out / "summary.json").write_text(json.dumps({"checkpoint": args.ckpt, "threshold": args.threshold, "short_side": args.short_side, **summary}, indent=2))
    print(json.dumps(summary, indent=2))

    # sheet of the in-scope (rendering) screenshots, highest scores first: frame | model's heatmap
    rend = sorted(by.get("Rendering", []), key=lambda r: -r["p_glitch"])
    tile_h, cols = 200, 3
    tiles = []
    for r in rend:
        frame = Image.open(out / f"{r['id']}.jpg")
        heat = np.asarray(Image.open(out / f"{r['id']}_heat.png"), dtype=np.float32)[..., None] / 255.0
        base = np.asarray(frame, dtype=np.float32) / 255.0
        grey = base * 0.45 + 0.25 * base.mean(axis=2, keepdims=True)
        over = grey * (1 - heat) + np.array([0.2, 0.85, 1.0]) * heat
        pair = Image.new("RGB", (frame.width * 2, frame.height))
        pair.paste(frame, (0, 0))
        pair.paste(Image.fromarray((over.clip(0, 1) * 255).astype(np.uint8)), (frame.width, 0))
        s = tile_h / pair.height
        tiles.append((pair.resize((round(pair.width * s), tile_h)), r))
    if tiles:
        tw = max(t.width for t, _ in tiles)
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (tw + 16) + 16, rows * (tile_h + 30) + 16), (17, 17, 17))
        d = ImageDraw.Draw(sheet)
        for i, (t, r) in enumerate(tiles):
            x, y = 16 + (i % cols) * (tw + 16), 16 + (i // cols) * (tile_h + 30)
            sheet.paste(t, (x, y))
            d.text((x, y + tile_h + 6), f"{r['game'][:28]}  p(glitch) {r['p_glitch']:.2f}  guess: {r['predicted_type']}",
                   fill=(120, 220, 140) if r["p_glitch"] > args.threshold else (255, 110, 110))
        sheet.save(out / "rendering_sheet.jpg", quality=88)
        print(out / "rendering_sheet.jpg")


if __name__ == "__main__":
    main()
