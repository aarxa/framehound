"""Dataset: each generated scene gives two examples, the glitched frame with its mask and the clean frame with an empty mask.

Training uses random crops, so a crop can miss the glitch entirely. A crop of a glitched frame with almost no glitch
pixels left is the clean frame in all but noise, so it is labelled "none"; otherwise the model is taught that normal
pictures can be broken. Half the crops are aimed at a glitch pixel so enough of them still show the glitch, and the
clean frame of the same scene is aimed at the same place, so where a crop sits never gives the answer away.
"""
import io
import json
import random
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter
from torch.utils.data import Dataset

AIM_AT_GLITCH = 0.5  # share of training crops placed so they contain a glitch pixel
MIN_GLITCH_PIXELS = 64  # fewer glitch pixels than this left in a crop (at full resolution) and it counts as clean


def load_types(root):
    meta = json.loads((Path(root) / "dataset.json").read_text())
    return ["none"] + meta["glitch_types"]  # index 0 means "no glitch"


class GlitchFrames(Dataset):
    def __init__(self, root, split, size=384, train=True, limit=None, only=None):
        self.root = Path(root)
        self.size = size
        self.train = train
        self.types = load_types(root)  # always the full list, so the model's outputs keep the same meaning
        rows = [json.loads(line) for line in (self.root / "manifest.jsonl").read_text().splitlines() if line]
        rows = [r for r in rows if r["split"] == split and (only is None or r["glitch"] in only)]
        if limit:
            rows = rows[:limit]
        self.items = []
        seen_clean = set()
        for r in rows:
            f = r["files"]
            # the last field is the scene's glitch mask, used only to aim crops (for the clean frame too)
            self.items.append((f["glitched"], f["mask"], self.types.index(r["glitch"]), r["seed"], f["mask"]))
            # Captured pages share one clean frame among several glitches. Training takes it once per glitch (each time
            # with its own crop and augmentation, so clean and broken stay balanced); validation counts it once.
            if train or f["clean"] not in seen_clean:
                self.items.append((f["clean"], None, 0, r["seed"], f["mask"]))
                seen_clean.add(f["clean"])

    def __len__(self):
        return len(self.items)

    def _augment(self, img, mask, aim):
        # same crop and flip for image and mask; returns how many glitch pixels the crop kept
        w, h = img.size
        scale = random.uniform(0.5, 1.0)
        cw = ch = int(min(w, h) * scale ** 0.5)
        ys, xs = np.nonzero(aim)
        if len(xs) and random.random() < AIM_AT_GLITCH:
            k = random.randrange(len(xs))
            x = random.randint(max(0, xs[k] - cw + 1), min(w - cw, xs[k]))
            y = random.randint(max(0, ys[k] - ch + 1), min(h - ch, ys[k]))
        else:
            x, y = random.randint(0, w - cw), random.randint(0, h - ch)
        kept = int((np.asarray(mask.crop((x, y, x + cw, y + ch))) > 127).sum())
        img = img.crop((x, y, x + cw, y + ch)).resize((self.size, self.size), Image.BILINEAR)
        mask = mask.crop((x, y, x + cw, y + ch)).resize((self.size, self.size), Image.NEAREST)
        if random.random() < 0.5:
            img, mask = img.transpose(Image.FLIP_LEFT_RIGHT), mask.transpose(Image.FLIP_LEFT_RIGHT)
        # what real screenshots go through: compression, softening, small colour shifts
        if random.random() < 0.5:
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=random.randint(35, 95))
            img = Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
        if random.random() < 0.15:
            img = img.filter(ImageFilter.GaussianBlur(random.uniform(0.3, 1.0)))
        arr = np.asarray(img, dtype=np.float32) / 255.0
        if random.random() < 0.5:
            arr = arr * random.uniform(0.8, 1.2) + random.uniform(-0.08, 0.08)  # exposure / offset
        if random.random() < 0.2:
            arr = arr + np.random.normal(0, random.uniform(0.005, 0.03), arr.shape)
        return np.clip(arr, 0, 1), mask, kept

    def __getitem__(self, i):
        path, mask_path, label, seed, aim_path = self.items[i]
        img = Image.open(self.root / path).convert("RGB")
        mask = Image.open(self.root / mask_path).convert("L") if mask_path else Image.new("L", img.size, 0)
        if self.train:
            aim = np.asarray(mask if mask_path else Image.open(self.root / aim_path).convert("L")) > 127
            arr, mask, kept = self._augment(img, mask, aim)
            if label and kept < MIN_GLITCH_PIXELS:
                label, mask = 0, Image.new("L", mask.size, 0)  # the crop missed the glitch
        else:
            arr = np.asarray(img, dtype=np.float32) / 255.0
        x = torch.from_numpy(arr).permute(2, 0, 1).float()
        x = (x - torch.tensor([0.485, 0.456, 0.406])[:, None, None]) / torch.tensor([0.229, 0.224, 0.225])[:, None, None]
        m = torch.from_numpy((np.asarray(mask) > 127).astype(np.float32))[None]
        if not self.train:
            # full frames go through the U-Net whole, so pad height and width up to a multiple of 32
            ph, pw = (-x.shape[1]) % 32, (-x.shape[2]) % 32
            x = torch.nn.functional.pad(x, (0, pw, 0, ph))
            m = torch.nn.functional.pad(m, (0, pw, 0, ph))
        return x, m, label
