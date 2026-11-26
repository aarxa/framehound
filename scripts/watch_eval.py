"""Measure watch on its own test runs (framehound watch --plant): how many planted glitches were flagged, and how often
the broken draw was named first, by where it draws and by ranking.

    python3 scripts/watch_eval.py watch/hexgl-test4/report.json [more reports]

For each flagged frame with a planted glitch (left-out draws can't be named, so they're counted apart), it re-ranks the
draws from the per-draw numbers watch records, so rankings can be compared on the same frames:
  - box: the share of a box around the flagged area that the draw covers, times the share of its pixels in the box
  - heatmap, before: the share of the heatmap the draw explains, times the mean heat over what it draws
  - watch: what watch uses now, the same with the first factor square-rooted and only heat above 0.3 counted (reports
    made before the change don't record that, so it's left out for them)
  - true pixels: the heatmap replaced by the truly broken pixels, to show what a perfect heatmap would give
Draws are split by where they draw: to the frame itself, to an offscreen target such as a shadow map, or nowhere the
frame shows once the glitch is in (leaving them out changes nothing).
"""
import json
import math
import sys
from collections import defaultdict


def share(part, whole):
    return part / whole if whole else 0


def rankings(L):
    ranks = {
        "box": lambda s: share(s["inside"], L["area"]) * share(s["inside"], s["total"]),
        "heatmap, before": lambda s: share(s["warm"], L.get("heat_total")) * share(s["warm"], s["total"]),
    }
    if "hot_total" in L:
        ranks["watch"] = lambda s: math.sqrt(share(s["hot"], L["hot_total"])) * share(s["hot"], s["total"])
    ranks["true pixels"] = lambda s: share(s["on_true"], L.get("true_total")) * share(s["on_true"], s["total"])
    return ranks


def main(paths):
    for path in paths:
        r = json.load(open(path))
        frames = [f for f in r["frames"] if not f.get("skipped")]
        planted = [f for f in frames if f.get("planted")]
        clean = [f for f in frames if not f.get("planted")]
        flagged = [f for f in planted if f["flagged"]]
        print(path)
        print(f"  flagged: {len(flagged)} of {len(planted)} planted glitches, {sum(f['flagged'] for f in clean)} of {len(clean)} clean frames")
        named = [f for f in flagged if f["planted"]["type"] != "missing_draw" and f.get("located", {}).get("stats")]
        print(f"  left-out draws flagged (can't be named): {sum(f['planted']['type'] == 'missing_draw' for f in flagged)}")
        if not named:
            print("  no per-draw numbers in this report (made before watch recorded them)")
            continue
        table = defaultdict(lambda: [0, 0, 0])  # (ranking, target) -> frames, first, top three
        names = []
        for f in named:
            L = f["located"]
            mine = next((s for s in L["stats"] if s["index"] == f["planted"]["draw"]), None)
            target = "to the frame" if mine and mine["direct"] else "offscreen" if mine else "changes nothing"
            for name, score in rankings(L).items():
                if name not in names:
                    names.append(name)
                order = [i for v, i in sorted(((score(s), s["index"]) for s in L["stats"]), reverse=True) if v > 0]
                rank = order.index(f["planted"]["draw"]) + 1 if f["planted"]["draw"] in order else None
                for key in ((name, target), (name, "all")):
                    t = table[key]
                    t[0] += 1
                    t[1] += rank == 1
                    t[2] += bool(rank and rank <= 3)
        for target in ("all", "to the frame", "offscreen", "changes nothing"):
            if not table[("box", target)][0]:
                continue
            print(f"  {target}:")
            for name in names:
                n, first, top3 = table[(name, target)]
                if n:
                    print(f"    {name:16s} first {first}/{n}, top 3 {top3}/{n}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
