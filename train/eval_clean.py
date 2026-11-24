"""The fair test: real glitched game screenshots against real clean frames, scored by the same model.

GlitchBench has only broken screenshots, so a model that flagged everything would look perfect on it. This adds clean
frames from a real engine (three.js's own reference screenshots, fetched by scripts/fetch-clean-frames.mjs) and reports:
  - false-alarm rate on the clean frames
  - for each GlitchBench category (real games only), how well the score separates it from the clean frames (AUROC
    with a bootstrap 95% interval) and how many it catches when false alarms are held at 5%

The clean screenshots are small (400x250). So that the model can't tell the two sets apart by sharpness alone, every
frame is first brought down to the same short side (--match-detail) before the usual resize.

    .venv/bin/python train/eval_clean.py --ckpt runs/v2-resnet34/best.pt --clean eval-data/threejs-r170
"""
import argparse
import collections
import glob
import io
import json
import math
import random
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import torch
from PIL import Image, ImageDraw

from eval_glitchbench import category, prepare
from train import auroc, build_model

REPO = Path(__file__).resolve().parent.parent


def match_detail(img, short_side):
    """Downscale so the short side is at most short_side, saving resized frames once as JPEG like the clean set."""
    if not short_side:
        return img
    w, h = img.size
    s = short_side / min(w, h)
    if s >= 1:
        return img
    img = img.resize((round(w * s), round(h * s)), Image.BILINEAR)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=95)
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")


def bootstrap_auroc(pos, neg, n=1000, seed=0):
    rnd = random.Random(seed)
    vals = sorted(
        auroc(p + q, [1] * len(p) + [0] * len(q))
        for p, q in ((rnd.choices(pos, k=len(pos)), rnd.choices(neg, k=len(neg))) for _ in range(n))
    )
    return round(vals[int(0.025 * n)], 3), round(vals[int(0.975 * n) - 1], 3)


def separation(pos, neg, threshold):
    """How well scores of glitched frames (pos) stand above clean ones (neg)."""
    at5 = float(np.quantile(neg, 0.95))  # the score that only 5% of clean frames exceed
    return {
        "n": len(pos),
        "flagged": round(sum(s > threshold for s in pos) / len(pos), 3),
        "auroc_vs_clean": round(auroc(pos + neg, [1] * len(pos) + [0] * len(neg)), 3),
        "auroc_95ci": bootstrap_auroc(pos, neg),
        "caught_at_5pct_false_alarms": round(sum(s > at5 for s in pos) / len(pos), 3),
    }


def overlay(frame, heat):
    base = np.asarray(frame, dtype=np.float32) / 255.0
    grey = base * 0.45 + 0.25 * base.mean(axis=2, keepdims=True)
    h = heat[..., None]
    return Image.fromarray(((grey * (1 - h) + np.array([0.2, 0.85, 1.0]) * h).clip(0, 1) * 255).astype(np.uint8))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--clean", default=str(REPO / "eval-data/threejs-r170"))
    ap.add_argument("--glitchbench", default=str(REPO / "eval-data/glitchbench"))
    ap.add_argument("--short-side", type=int, default=432)  # the training frames' height
    ap.add_argument("--match-detail", type=int, default=250)  # the clean screenshots' height; 0 turns it off
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    ck = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    types = ck["types"]
    model = build_model(len(types), ck["encoder"], pretrained=False)
    model.load_state_dict(ck["model"])
    model.to(device).eval()
    out = Path(args.out or Path(args.ckpt).parent / f"clean_test_{args.match_detail or 'native'}")
    out.mkdir(parents=True, exist_ok=True)

    @torch.no_grad()
    def score(img):
        x, small, (h, w) = prepare(match_detail(img, args.match_detail), args.short_side)
        mask_logits, type_logits = model(x[None].to(device))
        prob = torch.sigmoid(mask_logits)[0, 0, :h, :w].cpu().numpy()
        p_type = type_logits.softmax(1)[0].cpu().numpy()
        r = {"p_glitch": float(1 - p_type[0]), "predicted_type": types[int(p_type.argmax())],
             "pixel_score": float(np.sort(prob.ravel())[-64:].mean())}
        return r, small, prob

    clean_dir = Path(args.clean)
    manifest = clean_dir / "manifest.json"
    if manifest.exists():
        files = json.loads(manifest.read_text())["files"]
    else:
        files = [{"file": p.name, "example": p.stem, "skipped_in_threejs_tests": False}
                 for p in sorted(clean_dir.iterdir()) if p.suffix.lower() in (".jpg", ".jpeg", ".png")]

    parquets = sorted(glob.glob(f"{args.glitchbench}/*.parquet"))
    if not files or not parquets:
        raise SystemExit(f"need clean frames in {clean_dir} and GlitchBench parquet files in {args.glitchbench}")

    rows = []
    for f in files:
        r, _, _ = score(Image.open(clean_dir / f["file"]).convert("RGB"))
        rows.append({"set": "clean", "id": f["example"], "skipped_in_threejs_tests": f["skipped_in_threejs_tests"], **r})
    for pf in parquets:
        for batch in pq.ParquetFile(pf).iter_batches(batch_size=16, columns=["image", "id", "glitch-type", "game"]):
            for row in batch.to_pylist():
                if row["game"] == "N/A":
                    continue  # made by GlitchBench's authors in Unity, not taken from a released game
                r, _, _ = score(Image.open(io.BytesIO(row["image"]["bytes"])).convert("RGB"))
                rows.append({"set": "glitchbench", "id": row["id"], "game": row["game"],
                             "category": category(row["glitch-type"]), **r})
    with open(out / "scores.jsonl", "w") as fh:
        fh.writelines(json.dumps(r) + "\n" for r in rows)

    clean = [r for r in rows if r["set"] == "clean"]
    tested = [r for r in clean if not r["skipped_in_threejs_tests"]]
    by_cat = collections.defaultdict(list)
    for r in rows:
        if r["set"] == "glitchbench":
            by_cat[r["category"]].append(r)
    summary = {"checkpoint": args.ckpt, "threshold": args.threshold, "match_detail": args.match_detail,
               "clean": {"n": len(clean), "false_alarms": round(sum(r["p_glitch"] > args.threshold for r in clean) / len(clean), 3),
                         "false_alarms_in_threejs_tested": round(sum(r["p_glitch"] > args.threshold for r in tested) / max(1, len(tested)), 3),
                         "median_p_glitch": round(float(np.median([r["p_glitch"] for r in clean])), 3)}}
    for key in ("p_glitch", "pixel_score"):
        neg = [r[key] for r in clean]
        summary[f"real_games_by_{key}"] = {cat: separation([r[key] for r in rs], neg, args.threshold)
                                           for cat, rs in sorted(by_cat.items())}
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))

    # the clean frames the model is most sure are broken: frame | heatmap
    worst = sorted(clean, key=lambda r: -r["p_glitch"])[:24]
    by_id = {f["example"]: f for f in files}
    tile_h, cols, tiles = 160, 3, []
    for r in worst:
        _, small, prob = score(Image.open(clean_dir / by_id[r["id"]]["file"]).convert("RGB"))
        pair = Image.new("RGB", (small.width * 2, small.height))
        pair.paste(small, (0, 0))
        pair.paste(overlay(small, prob), (small.width, 0))
        tiles.append(pair.resize((round(pair.width * tile_h / pair.height), tile_h)))
    if tiles:
        tw = max(t.width for t in tiles)
        sheet = Image.new("RGB", (cols * (tw + 16) + 16, math.ceil(len(tiles) / cols) * (tile_h + 30) + 16), (17, 17, 17))
        d = ImageDraw.Draw(sheet)
        for i, (t, r) in enumerate(zip(tiles, worst)):
            x, y = 16 + (i % cols) * (tw + 16), 16 + (i // cols) * (tile_h + 30)
            sheet.paste(t, (x, y))
            d.text((x, y + tile_h + 6), f"{r['id'][:40]}  p(glitch) {r['p_glitch']:.2f}  {r['predicted_type']}",
                   fill=(255, 110, 110) if r["p_glitch"] > args.threshold else (120, 220, 140))
        sheet.save(out / "false_alarms.jpg", quality=88)
        print(out / "false_alarms.jpg")


if __name__ == "__main__":
    main()
