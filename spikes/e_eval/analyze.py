"""Spike E: summarize listening-test answers and check them against spectral distance.

Two kinds of answers live in ratings.jsonl:
- slider (rounds 1-2): 0-100 per candidate. The rater used it as "do I like it",
  not closeness, so it's reported as liking.
- pair (round 3 on): "which is closer to the reference, A or B (or same)" plus a
  thumbs-up for "I'd use this".

If the automatic distance picks the same winner as the ears, the agent can use it
to check its own attempts; if not, the loop needs human ears.

    uv run python e_eval/analyze.py ../out/c_recreate
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

stimuli = Path(sys.argv[1] if len(sys.argv) > 1 else "../out/c_recreate")
answers = [json.loads(line) for line in (stimuli.parent / "eval" / "ratings.jsonl").read_text().splitlines()]
summary = json.loads((stimuli / "summary.json").read_text())


def distance(trial, cond):
    if cond == "hidden_reference":
        return 0.0
    return summary.get(trial, {}).get("conditions", {}).get(cond, {}).get("distance")


sliders = [a for a in answers if a.get("kind", "slider") == "slider"]
pairs = [a for a in answers if a.get("kind") == "pair"]

if sliders:
    like, keep = defaultdict(list), defaultdict(list)
    for r in sliders:
        for cond, score in r["scores"].items():
            like[cond].append(score)
            keep[cond].append(bool(r["keep"].get(cond)))
    print(f"Slider rounds (read as liking): {len(sliders)} sounds, raters {sorted({r['rater'] for r in sliders})}")
    for cond in sorted(like, key=lambda c: -np.mean(like[c])):
        print(f"  {cond:18s} like {np.mean(like[cond]):5.1f}   start-from-it {sum(keep[cond])}/{len(keep[cond])}")
    print()

if pairs:
    wins, played, likes, liked_n = defaultdict(float), defaultdict(int), defaultdict(int), defaultdict(int)
    agree = total = 0
    for p in pairs:
        a, b, choice = p["a"], p["b"], p["choice"]
        played[a] += 1
        played[b] += 1
        if choice == "same":
            wins[a] += 0.5
            wins[b] += 0.5
        else:
            wins[a if choice == "a" else b] += 1
            da, db = distance(p["trial"], a), distance(p["trial"], b)
            if da is not None and db is not None and da != db:
                total += 1
                agree += (da < db) == (choice == "a")
        for cond, on in p.get("like", {}).items():
            liked_n[cond] += 1
            likes[cond] += bool(on)
    print(f"Pair rounds: {len(pairs)} pairs, raters {sorted({p['rater'] for p in pairs})}")
    print(f"  {'condition':18s} {'closer (win rate)':>18s} {'thumbs-up':>10s}")
    for cond in sorted(played, key=lambda c: -wins[c] / played[c]):
        print(f"  {cond:18s} {wins[cond] / played[cond]:13.0%} of {played[cond]:<3d} {likes[cond]:4d}/{liked_n[cond]}")
    if total:
        print(f"\n  Spectral distance picks the same winner as the ears in {agree}/{total} decided pairs ({agree / total:.0%}; 50% = chance).")
