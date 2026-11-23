"""Train a glitch segmenter + type classifier on generated frames.

    .venv/bin/python train/train.py --data data/v1 --out runs/v1-resnet34 --epochs 8
"""
import argparse
import json
import math
import time
from pathlib import Path

import segmentation_models_pytorch as smp
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from data import GlitchFrames, load_types


def build_model(n_types, encoder="resnet34", pretrained=True):
    return smp.Unet(
        encoder_name=encoder,
        encoder_weights="imagenet" if pretrained else None,
        classes=1,  # per-pixel "is this pixel glitched"
        aux_params={"classes": n_types, "dropout": 0.2},  # which glitch, or none
    )


def auroc(scores, labels):
    """Area under the ROC curve via the rank-sum (Mann-Whitney) statistic."""
    pairs = sorted(zip(scores, labels))
    pos = sum(labels)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return float("nan")
    rank_sum, i = 0.0, 0
    while i < len(pairs):
        j = i
        while j < len(pairs) and pairs[j][0] == pairs[i][0]:
            j += 1
        avg_rank = (i + j + 1) / 2  # ties share their average rank
        rank_sum += avg_rank * sum(l for _, l in pairs[i:j])
        i = j
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


@torch.no_grad()
def evaluate(model, loader, device, types):
    model.eval()
    head_scores, pix_scores, labels, inter, union, type_hits, type_total = [], [], [], 0.0, 0.0, 0, 0
    per_type = {t: [0, 0] for t in types[1:]}  # detected, total (at the 0.5 head threshold)
    clean_flagged = [0, 0]
    for x, m, y in loader:
        x, m = x.to(device), m.to(device)
        mask_logits, type_logits = model(x)
        prob = torch.sigmoid(mask_logits)
        p_glitch = 1 - type_logits.softmax(1)[:, 0]
        for k in range(len(y)):
            label = int(y[k])
            head_scores.append(float(p_glitch[k]))
            pix_scores.append(float(prob[k].flatten().topk(64).values.mean()))  # strongest 64 pixels
            labels.append(int(label > 0))
            if label > 0:
                pred = prob[k] > 0.5
                gt = m[k] > 0.5
                inter += float((pred & gt).sum())
                union += float((pred | gt).sum())
                per_type[types[label]][1] += 1
                per_type[types[label]][0] += int(p_glitch[k] > 0.5)
                type_total += 1
                type_hits += int(int(type_logits[k].argmax()) == label)
            else:
                clean_flagged[1] += 1
                clean_flagged[0] += int(p_glitch[k] > 0.5)
    return {
        "auroc_head": auroc(head_scores, labels),
        "auroc_pixels": auroc(pix_scores, labels),
        "pixel_iou": inter / max(union, 1),
        "type_accuracy": type_hits / max(type_total, 1),
        "false_alarm_rate": clean_flagged[0] / max(clean_flagged[1], 1),
        "recall_by_type": {t: round(d / max(n, 1), 3) for t, (d, n) in per_type.items()},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/v1")
    ap.add_argument("--out", default="runs/v1")
    ap.add_argument("--encoder", default="resnet34")
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--size", type=int, default=384)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=None, help="use only the first N scenes per split (smoke tests)")
    args = ap.parse_args()

    torch.manual_seed(0)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    types = load_types(args.data)

    train_ds = GlitchFrames(args.data, "train", args.size, train=True, limit=args.limit)
    val_ds = GlitchFrames(args.data, "val", train=False, limit=args.limit and max(1, args.limit // 9))
    train_dl = DataLoader(train_ds, args.batch, shuffle=True, num_workers=args.workers, drop_last=True, persistent_workers=args.workers > 0)
    val_dl = DataLoader(val_ds, 8, shuffle=False, num_workers=args.workers, persistent_workers=args.workers > 0)

    model = build_model(len(types), args.encoder).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = args.epochs * len(train_dl)
    warmup = min(300, steps // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / warmup) * 0.5 * (1 + math.cos(math.pi * min(s, steps) / steps)))
    dice = smp.losses.DiceLoss("binary", from_logits=True)

    (out / "config.json").write_text(json.dumps({**vars(args), "types": types, "device": str(device),
                                                 "train_examples": len(train_ds), "val_examples": len(val_ds)}, indent=2))
    print(f"{len(train_ds)} train / {len(val_ds)} val examples on {device}, {len(train_dl)} steps per epoch", flush=True)

    best = -1.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        t0, running = time.time(), 0.0
        for step, (x, m, y) in enumerate(train_dl, 1):
            x, m, y = x.to(device), m.to(device), y.to(device)
            mask_logits, type_logits = model(x)
            loss = F.binary_cross_entropy_with_logits(mask_logits, m) + dice(mask_logits, m) + 0.5 * F.cross_entropy(type_logits, y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            running += float(loss)
            if step % 50 == 0:
                rate = step * args.batch / (time.time() - t0)
                print(f"epoch {epoch} step {step}/{len(train_dl)} loss {running / 50:.3f} ({rate:.0f} img/s)", flush=True)
                running = 0.0
        metrics = {"epoch": epoch, "minutes": round((time.time() - t0) / 60, 1), **evaluate(model, val_dl, device, types)}
        print(json.dumps(metrics), flush=True)
        with open(out / "metrics.jsonl", "a") as f:
            f.write(json.dumps(metrics) + "\n")
        score = metrics["auroc_head"] + metrics["pixel_iou"]
        torch.save({"model": model.state_dict(), "types": types, "encoder": args.encoder, "epoch": epoch, "metrics": metrics}, out / "last.pt")
        if score > best:
            best = score
            torch.save({"model": model.state_dict(), "types": types, "encoder": args.encoder, "epoch": epoch, "metrics": metrics}, out / "best.pt")
    print(f"done; best checkpoint at {out / 'best.pt'}", flush=True)


if __name__ == "__main__":
    main()
