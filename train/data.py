"""Dataset: each generated scene gives two examples, the glitched frame with its mask and the clean frame with an empty mask."""
import io
import json
import random
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter
from torch.utils.data import Dataset


def load_types(root):
    meta = json.loads((Path(root) / "dataset.json").read_text())
    return ["none"] + meta["glitch_types"]  # index 0 means "no glitch"


class GlitchFrames(Dataset):
    def __init__(self, root, split, size=384, train=True, limit=None):
        self.root = Path(root)
        self.size = size
        self.train = train
        self.types = load_types(root)
        rows = [json.loads(line) for line in (self.root / "manifest.jsonl").read_text().splitlines() if line]
        rows = [r for r in rows if r["split"] == split]
        if limit:
            rows = rows[:limit]
        self.items = []
        for r in rows:
            f = r["files"]
            self.items.append((f["glitched"], f["mask"], self.types.index(r["glitch"]), r["seed"]))
            self.items.append((f["clean"], None, 0, r["seed"]))

    def __len__(self):
        return len(self.items)

    def _augment(self, img, mask):
        # same random crop and flip for image and mask
        w, h = img.size
        scale = random.uniform(0.5, 1.0)
        cw = ch = int(min(w, h) * scale ** 0.5)
        x, y = random.randint(0, w - cw), random.randint(0, h - ch)
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
        return np.clip(arr, 0, 1), mask

    def __getitem__(self, i):
        path, mask_path, label, seed = self.items[i]
        img = Image.open(self.root / path).convert("RGB")
        mask = Image.open(self.root / mask_path).convert("L") if mask_path else Image.new("L", img.size, 0)
        if self.train:
            arr, mask = self._augment(img, mask)
        else:
            arr = np.asarray(img, dtype=np.float32) / 255.0
        x = torch.from_numpy(arr).permute(2, 0, 1).float()
        x = (x - torch.tensor([0.485, 0.456, 0.406])[:, None, None]) / torch.tensor([0.229, 0.224, 0.225])[:, None, None]
        m = torch.from_numpy((np.asarray(mask) > 127).astype(np.float32))[None]
        return x, m, label
