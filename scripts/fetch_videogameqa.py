"""Download VideoGameQA-Bench's image glitch-detection task into eval-data/videogameqa (CC BY 4.0).

1,000 Steam screenshots from 509 games, 500 labelled glitched and 500 glitch-free, labelled by hand by the authors
(Taesiri et al., NeurIPS 2025 Datasets and Benchmarks, arXiv 2505.15952). Unlike GlitchBench it has clean game frames,
so false alarms are measured on games rather than on engine demos. The glitched half covers every kind of bug (physics,
clipping, UI as well as rendering), and there is no per-image glitch type.

Screenshots are split by game into two halves: "dev", which is used while working, and "locked", which is scored once
at the end. A game never appears in both halves, so a model can't do well by recognising a game.

    .venv/bin/python -I scripts/fetch_videogameqa.py
"""
import hashlib
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pyarrow.parquet as pq

REPO = "taesiri/VideoGameQA-Bench"
BASE = f"https://huggingface.co/datasets/{REPO}/resolve/main"
OUT = Path(__file__).resolve().parent.parent / "eval-data" / "videogameqa"
HEADERS = {"User-Agent": "framehound-eval/0.1"}


def get(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={**HEADERS, **(headers or {})})
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def half(game):
    return "dev" if hashlib.sha256(f"framehound:{game}".encode()).digest()[0] % 2 == 0 else "locked"


def main():
    (OUT / "images").mkdir(parents=True, exist_ok=True)
    labels = OUT / "labels.parquet"
    if not labels.exists():
        labels.write_bytes(get(f"{BASE}/data/test-00000-of-00001.parquet"))
    rows = [r for r in pq.read_table(labels).to_pylist()
            if "GlitchDetection" in r["question_categories"] and r["media_type"] == "images"]
    paths = [f"images/{r['custom_id']}/{r['media_path'][0]}" for r in rows]
    # the Hub reports each file's size and sha256, so every download can be checked
    info = json.loads(get(f"https://huggingface.co/api/datasets/{REPO}/paths-info/main",
                          json.dumps({"paths": paths}).encode(), {"Content-Type": "application/json"}))
    sha = {e["path"]: e["lfs"]["oid"] for e in info}

    def fetch(i):
        file = OUT / "images" / f"{rows[i]['custom_id']}.jpg"
        if file.exists() and hashlib.sha256(file.read_bytes()).hexdigest() == sha[paths[i]]:
            return 0
        buf = get(f"{BASE}/{paths[i]}")
        if hashlib.sha256(buf).hexdigest() != sha[paths[i]] or buf[:3] != b"\xff\xd8\xff":
            raise SystemExit(f"{paths[i]}: checksum or format mismatch")
        file.write_bytes(buf)
        return len(buf)

    with ThreadPoolExecutor(8) as pool:
        got = sum(pool.map(fetch, range(len(rows))))

    files = [{"file": f"images/{r['custom_id']}.jpg", "id": r["custom_id"], "game": r["media_source"],
              "glitch": json.loads(r["ground_truth"])["glitch_detected"], "half": half(r["media_source"])} for r in rows]
    manifest = {"source": f"https://huggingface.co/datasets/{REPO}", "license": "CC BY 4.0",
                "citation": "Taesiri et al., VideoGameQA-Bench, NeurIPS 2025 Datasets and Benchmarks (arXiv 2505.15952)",
                "files": files}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    for h in ("dev", "locked"):
        fs = [f for f in files if f["half"] == h]
        print(f"{h}: {len(fs)} screenshots ({sum(f['glitch'] for f in fs)} glitched) from {len({f['game'] for f in fs})} games")
    print(f"{got / 1e6:.0f} MB new in {OUT}")


if __name__ == "__main__":
    main()
