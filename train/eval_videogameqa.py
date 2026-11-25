"""Real games against real games: VideoGameQA-Bench's glitch screenshots against its glitch-free ones.

Both sets are Steam screenshots, so unlike the three.js test there is no gap in sharpness or style between broken and
clean frames for the model to lean on. The glitched screenshots cover every kind of bug; labels/videogameqa.json
marks which show a rendering glitch (the kind framehound is trained for) so they can be scored on their own.

Screenshots are split by game into "dev" (used while working) and "locked" (scored once, at the end). Scoring the
locked half needs --final.

    .venv/bin/python train/eval_videogameqa.py --ckpt runs/v3b-resnet34/best.pt
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

from eval_clean import overlay, separation
from eval_glitchbench import prepare
from train import build_model, pick_device

REPO = Path(__file__).resolve().parent.parent


def sheet(items, path, tile_h=180, cols=3):
    """frame | heatmap pairs with their scores underneath."""
    tiles = []
    for r, small, prob in items:
        pair = Image.new("RGB", (small.width * 2, small.height))
        pair.paste(small, (0, 0))
        pair.paste(overlay(small, prob), (small.width, 0))
        tiles.append(pair.resize((round(pair.width * tile_h / pair.height), tile_h)))
    if not tiles:
        return
    tw = max(t.width for t in tiles)
    out = Image.new("RGB", (cols * (tw + 16) + 16, math.ceil(len(tiles) / cols) * (tile_h + 30) + 16), (17, 17, 17))
    d = ImageDraw.Draw(out)
    for i, (t, (r, _, _)) in enumerate(zip(tiles, items)):
        x, y = 16 + (i % cols) * (tw + 16), 16 + (i // cols) * (tile_h + 30)
        out.paste(t, (x, y))
        d.text((x, y + tile_h + 6), f"{r['kind']}  game {r['game']}  p(glitch) {r['p_glitch']:.2f}  {r['predicted_type']}",
               fill=(255, 110, 110) if r["glitch"] else (120, 220, 140))
    out.save(path, quality=88)
    print(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--data", default=str(REPO / "eval-data/videogameqa"))
    ap.add_argument("--tags", default=str(REPO / "labels/videogameqa.json"))
    ap.add_argument("--half", choices=["dev", "locked"], default="dev")
    ap.add_argument("--final", action="store_true", help="required to score the locked half")
    ap.add_argument("--short-side", type=int, default=432)  # the training frames' height
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    if args.half == "locked" and not args.final:
        raise SystemExit("the locked half is scored once, at the end; pass --final if this is that time")

    device = pick_device()
    ck = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    types = ck["types"]
    model = build_model(len(types), ck["encoder"], pretrained=False)
    model.load_state_dict(ck["model"])
    model.to(device).eval()
    out = Path(args.out or Path(args.ckpt).parent / f"videogameqa_{args.half}")
    out.mkdir(parents=True, exist_ok=True)

    data = Path(args.data)
    files = [f for f in json.loads((data / "manifest.json").read_text())["files"] if f["half"] == args.half]
    tags = json.loads(Path(args.tags).read_text())["tags"]

    @torch.no_grad()
    def score(f):
        x, small, (h, w) = prepare(Image.open(data / f["file"]).convert("RGB"), args.short_side)
        mask_logits, type_logits = model(x[None].to(device))
        prob = torch.sigmoid(mask_logits)[0, 0, :h, :w].cpu().numpy()
        p_type = type_logits.softmax(1)[0].cpu().numpy()
        r = {"id": f["id"], "game": f["game"], "glitch": f["glitch"],
             "kind": tags[f["id"]]["tag"] if f["glitch"] else "clean",
             "p_glitch": float(1 - p_type[0]), "predicted_type": types[int(p_type.argmax())],
             "pixel_score": float(np.sort(prob.ravel())[-64:].mean())}
        return r, small, prob

    rows = [score(f)[0] for f in files]
    with open(out / "scores.jsonl", "w") as fh:
        fh.writelines(json.dumps(r) + "\n" for r in rows)

    clean = [r for r in rows if not r["glitch"]]
    summary = {"checkpoint": args.ckpt, "half": args.half, "threshold": args.threshold,
               "clean": {"n": len(clean), "false_alarms": round(sum(r["p_glitch"] > args.threshold for r in clean) / len(clean), 3),
                         "median_p_glitch": round(float(np.median([r["p_glitch"] for r in clean])), 3)}}
    for key in ("p_glitch", "pixel_score"):
        neg = [r[key] for r in clean]
        groups = {"all_glitches": [r for r in rows if r["glitch"]]}
        for kind in ("rendering", "other", "unclear"):
            groups[kind] = [r for r in rows if r["kind"] == kind]
        summary[f"vs_clean_by_{key}"] = {k: separation([r[key] for r in rs], neg, args.threshold) for k, rs in groups.items() if rs}
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))

    # what it flags most among clean frames, and how it sees the rendering glitches
    by_id = {f["id"]: f for f in files}
    worst_clean = sorted(clean, key=lambda r: -r["p_glitch"])[:18]
    sheet([score(by_id[r["id"]]) for r in worst_clean], out / "false_alarms.jpg")
    rendering = sorted((r for r in rows if r["kind"] == "rendering"), key=lambda r: -r["p_glitch"])
    sheet([score(by_id[r["id"]]) for r in rendering[:30]], out / "rendering.jpg")


if __name__ == "__main__":
    main()
