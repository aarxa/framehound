"""Draw a sheet of model predictions on validation frames: frame | true glitch | predicted glitch, with scores.

    .venv/bin/python train/visualize.py --ckpt runs/v1-resnet34/best.pt --data data/v1 --n 24
"""
import argparse
import random

import numpy as np
import torch
from PIL import Image, ImageDraw

from data import GlitchFrames
from train import build_model, pick_device

TILE = 200  # tile height; width follows the frames' shape


def overlay(rgb, mask, color):
    """Grey out the frame and paint the mask in a colour, like the generator's contact sheet."""
    base = (rgb * 0.45 + 0.25 * rgb.mean(axis=2, keepdims=True)).clip(0, 1)
    a = mask[..., None]
    return base * (1 - a) + np.array(color, dtype=np.float32) * a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--data", default="data/v1")
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--out", default=None)
    ap.add_argument("--seed", type=int, default=3)
    args = ap.parse_args()

    device = pick_device()
    ck = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    types = ck["types"]
    model = build_model(len(types), ck["encoder"], pretrained=False)
    model.load_state_dict(ck["model"])
    model.to(device).eval()

    ds = GlitchFrames(args.data, "val", train=False)
    random.seed(args.seed)
    idx = random.sample(range(len(ds)), args.n)
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    cols = 2
    _, fh, fw = ds[0][0].shape
    tw = round(TILE * fw / fh)
    sheet = Image.new("RGB", (cols * (3 * tw + 40), (args.n // cols) * (TILE + 34) + 10), (17, 17, 17))
    draw = ImageDraw.Draw(sheet)
    with torch.no_grad():
        for n, i in enumerate(idx):
            x, m, y = ds[i]
            mask_logits, type_logits = model(x[None].to(device))
            prob = torch.sigmoid(mask_logits)[0, 0].cpu().numpy()
            p_type = type_logits.softmax(1)[0].cpu().numpy()
            rgb = (x.permute(1, 2, 0).numpy() * std + mean).clip(0, 1)
            tiles = [rgb, overlay(rgb, m[0].numpy(), (1.0, 0.18, 0.33)), overlay(rgb, prob, (0.2, 0.85, 1.0))]
            ox, oy = (n % cols) * (3 * tw + 40) + 10, (n // cols) * (TILE + 34) + 10
            for k, t in enumerate(tiles):
                sheet.paste(Image.fromarray((t * 255).astype(np.uint8)).resize((tw, TILE)), (ox + k * tw, oy))
            truth = types[int(y)]
            guess = types[int(p_type.argmax())]
            ok = (int(y) > 0) == (p_type[0] < 0.5)
            draw.text((ox, oy + TILE + 6), f"true: {truth}   predicted: {guess}   p(glitch) {1 - p_type[0]:.2f}",
                      fill=(120, 220, 140) if ok else (255, 110, 110))
    out = args.out or args.ckpt.rsplit("/", 1)[0] + "/val_predictions.png"
    sheet.save(out)
    print(out)


if __name__ == "__main__":
    main()
