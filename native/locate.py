"""framehound watch for Vulkan apps: run the app twice with the layer, and name the draw calls behind flagged frames.

1. The app runs with the layer writing every Nth frame (FRAMEHOUND_VARIANTS=0).
2. The model learned for the app checks those frames.
3. The app runs again. On the flagged frames, the layer draws the frame once per draw call with that draw left out
   (FRAMEHOUND_LOCATE).
4. Draws are ranked as in the WebGL watch: by how much of the model's heatmap the pixels they draw explain, times how
   much of what they draw is flagged. report.html shows each flagged frame and the draws found there.

    .venv/bin/python native/locate.py --model models/native-scene --out watch/native-bug \\
        [--start 20 --every 20 --count 15] [--expect 5] -- native/build/fh_scene --frames 340 --bug texture:5

The app has to draw the same frames on both runs: a deterministic app, or a GFXReconstruct replay of a recording.
--expect N: the draw known to be broken (a test), to report where it ranks.
"""
import argparse
import html
import json
import os
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DIFF = 12  # per channel: below this a pixel counts as unchanged, as in the injector


def run_app(cmd, settings):
    env = dict(os.environ, VK_ADD_LAYER_PATH=str(ROOT / "native/build"), VK_INSTANCE_LAYERS="VK_LAYER_FRAMEHOUND_glitch", **settings)
    subprocess.run(cmd, env=env, check=True)


def changed(a, b):
    return np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2) > DIFF


def spotlight(frame, mask):
    """The frame dimmed everywhere except where the draw drew."""
    out = (frame.astype(np.float32) * np.where(mask[..., None], 1.0, 0.22)).astype(np.uint8)
    return Image.fromarray(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--id", default="app")
    ap.add_argument("--start", type=int, default=20)
    ap.add_argument("--every", type=int, default=20)
    ap.add_argument("--count", type=int, default=15, help="frames to check")
    ap.add_argument("--expect", type=int, default=None, help="the draw known to be broken, for testing")
    ap.add_argument("cmd", nargs=argparse.REMAINDER, help="-- then the app's command line")
    args = ap.parse_args()
    cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    if not cmd:
        sys.exit("give the app's command line after --")
    out = Path(args.out).resolve()
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)

    # 1. the frames
    print(f"[1/4] running the app, keeping frame {args.start} and every {args.every}th after it ({args.count} frames)")
    run_app(cmd, {"FRAMEHOUND_OUT": str(out / "run1"), "FRAMEHOUND_APP": args.id, "FRAMEHOUND_VARIANTS": "0",
                  "FRAMEHOUND_START": str(args.start), "FRAMEHOUND_EVERY": str(args.every), "FRAMEHOUND_CAPTURES": str(args.count)})
    frames = [json.loads(line) for line in open(out / "run1/frames.jsonl")]

    # 2. the model's verdicts
    print(f"[2/4] checking {len(frames)} frames")
    python = os.environ.get("FRAMEHOUND_PYTHON") or str(ROOT / ".venv/bin/python")
    checker = subprocess.Popen([python, "train/check.py", "--model", str(Path(args.model).resolve()), "--stdin", "--out", str(out / "heatmaps")],
                               cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    for f in frames:
        checker.stdin.write(str(out / "run1" / f["clean"]) + "\n")
        checker.stdin.flush()
        line = checker.stdout.readline()
        while not line.startswith("{"):
            line = checker.stdout.readline()
        f["verdict"] = json.loads(line)
    checker.stdin.close()
    checker.wait()
    flagged = [f for f in frames if f["verdict"].get("glitch")]
    print(f"      {len(flagged)} flagged")

    # 3. the flagged frames again, once per draw with that draw left out
    if flagged:
        print(f"[3/4] running the app again to draw frames {', '.join(str(f['frame']) for f in flagged)} without each draw")
        run_app(cmd, {"FRAMEHOUND_OUT": str(out / "run2"), "FRAMEHOUND_APP": args.id,
                      "FRAMEHOUND_LOCATE": ",".join(str(f["frame"]) for f in flagged)})

    # 4. rank the draws by the heatmap they explain
    print("[4/4] ranking draws")
    (out / "draws").mkdir()
    for f in flagged:
        d = out / "run2/locate" / str(f["frame"])
        first = np.asarray(Image.open(out / "run1" / f["clean"]).convert("RGB"))
        if not (d / "frame.png").exists():
            f["located"] = {"error": "the second run didn't reach this frame"}
            continue
        frame = np.asarray(Image.open(d / "frame.png").convert("RGB"))
        f["same_frame_both_runs"] = bool(frame.shape == first.shape and not changed(frame, first).any())
        heat = f["verdict"]["heat"]
        grid = np.asarray(heat["values"], dtype=np.float32).reshape(heat["rows"], heat["cols"])
        H, W = frame.shape[:2]
        heat_full = np.asarray(Image.fromarray(grid).resize((W, H), Image.NEAREST))
        total_heat = float(heat_full.sum())
        found = []
        for dr in json.load(open(d / "draws.json")):
            path = d / f"without-{dr['index']}.png"
            if not path.exists():
                continue
            mask = changed(frame, np.asarray(Image.open(path).convert("RGB")))
            n = int(mask.sum())
            warm = float(heat_full[mask].sum())
            if not n or warm <= 0:
                continue
            found.append({**dr, "pixels": n, "explains": warm / total_heat, "flagged_share": warm / n, "score": warm / total_heat * warm / n, "mask": mask})
        found.sort(key=lambda x: -x["score"])
        for rank, x in enumerate(found[:3]):
            pic = out / "draws" / f"{f['frame']}-{rank + 1}.jpg"
            spotlight(frame, x["mask"]).save(pic, quality=88)
            x["picture"] = str(pic.relative_to(out))
        order = [x["index"] for x in found]
        f["located"] = {"draws": [{k: v for k, v in x.items() if k != "mask"} for x in found[:3]], "order": order}
        if args.expect is not None:
            f["expected_rank"] = order.index(args.expect) + 1 if args.expect in order else None

    # report
    describe = describe_html

    often = defaultdict(list)
    for f in flagged:
        top = (f.get("located") or {}).get("draws") or []
        if top:
            often[describe(top[0])].append(f["frame"])
    summary = {
        "app": args.id, "command": cmd, "frames_checked": len(frames), "flagged": len(flagged),
        "named_most": sorted(([k, v] for k, v in often.items()), key=lambda kv: -len(kv[1])),
        "same_frames_both_runs": all(f.get("same_frame_both_runs", True) for f in flagged),
    }
    if args.expect is not None:
        ranks = [f.get("expected_rank") for f in flagged]
        summary["expected"] = {"draw": args.expect, "flagged": len(flagged), "first": sum(r == 1 for r in ranks), "top3": sum(bool(r and r <= 3) for r in ranks)}
    for f in frames:
        f["verdict"].pop("heat", None)
    (out / "report.json").write_text(json.dumps({**summary, "frames": frames}, indent=2))
    write_html(out, summary, frames)
    print(json.dumps({k: v for k, v in summary.items() if k != "command"}, indent=2))
    print(f"report: {out / 'report.html'}")


def write_html(out, s, frames):
    e = html.escape
    rows = "".join(f"<tr><td>{len(v)} ({', '.join(map(str, v[:8]))}{', …' if len(v) > 8 else ''})</td><td>{e(k)}</td></tr>" for k, v in s["named_most"])
    parts = []
    for f in frames:
        if not f["verdict"].get("glitch"):
            continue
        v, loc = f["verdict"], f.get("located") or {}
        draws = "".join(
            f'<div class="draw"><img src="{e(x["picture"])}" alt=""><div><p><b>Draw #{x["index"]}</b></p><p>{e(describe_html(x))}</p>'
            f'<p class="dim">Explains {x["explains"]:.0%} of the flagged area; {x["flagged_share"]:.0%} of what it draws is flagged.</p></div></div>'
            for x in loc.get("draws", []))
        heat = Path(v["heatmap"]).relative_to(out) if v.get("heatmap") else ""
        parts.append(f'<section><h2>Frame {f["frame"]}</h2><p>Score {v["score"]} (flagged above {v["threshold"]}), most like '
                     f'<code>{e(str(v.get("likely_kind")))}</code>.{" The broken draw ranks " + str(f.get("expected_rank")) + "." if "expected_rank" in f else ""}</p>'
                     f'<div class="pair"><img src="{e(str(Path("run1") / f["clean"]))}" alt=""><img class="heat" src="{e(str(heat))}" alt=""></div>{draws or "<p>No draw found.</p>"}</section>')
    exp = s.get("expected")
    test = f'<p>Test: draw #{exp["draw"]} is broken. It came first in {exp["first"]} of {exp["flagged"]} flagged frames and in the top three in {exp["top3"]}.</p>' if exp else ""
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>framehound watch: {e(s["app"])}</title><style>
:root {{ color-scheme: dark; }} body {{ margin: 0 auto; max-width: 1100px; padding: 24px 16px 64px; background: #111; color: #e6e6e6; font: 15px/1.5 -apple-system, system-ui, sans-serif; }}
h1 {{ font-size: 22px; margin: 0 0 8px; }} h2 {{ font-size: 17px; margin: 0 0 4px; }} p {{ margin: 4px 0; }} .dim {{ color: #9a9a9a; }} code {{ font: 13px ui-monospace, Menlo, monospace; }}
section {{ border-top: 1px solid #2a2a2a; padding: 20px 0; }} .pair {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }}
.pair img {{ width: 100%; display: block; aspect-ratio: 16 / 9; }} .heat {{ object-fit: cover; object-position: right; }}
.draw {{ display: grid; grid-template-columns: minmax(0, 360px) 1fr; gap: 16px; margin: 12px 0; }} .draw img {{ width: 100%; display: block; }}
table {{ border-collapse: collapse; width: 100%; font-size: 14px; }} th, td {{ text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }} th {{ color: #9a9a9a; font-weight: 500; }}
@media (max-width: 640px) {{ .pair, .draw {{ grid-template-columns: 1fr; }} }}
</style></head><body><h1>framehound watch: {e(s["app"])}</h1><p class="dim">{e(" ".join(s["command"]))}</p>
<p>Checked {s["frames_checked"]} frames; the model flagged {s["flagged"]}.{"" if s["same_frames_both_runs"] else " The second run didn't draw the same frames, so the draws found may be wrong."}</p>{test}
{f'<section><h2>Named first most often</h2><table><tr><th>Frames</th><th>Draw</th></tr>{rows}</table></section>' if rows else ""}
{"".join(parts) or "<section><p>No frame was flagged.</p></section>"}</body></html>"""
    (out / "report.html").write_text(page)


def describe_html(x):
    tris = f"{x['count'] // 3:,} triangles" if x["count"] else "an indirect draw"
    name = f"pipeline “{x['pipeline_name']}” ({x['pipeline']})" if x.get("pipeline_name") else f"pipeline {x['pipeline']}"
    sets = ", ".join(s or "unnamed" for s in x.get("sets", [])) or "none"
    return f"{x['call']}, {tris}, {name}; descriptor sets: {sets}"


if __name__ == "__main__":
    main()
