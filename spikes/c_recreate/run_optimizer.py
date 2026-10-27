"""Spike C: optimizer-only condition (no model), plus default and random anchors.

Writes target/condition WAVs and a JSON summary for the eval page.
"""
import json
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import soundfile as sf

from match import fit_any_octave, measure_note, spectral_distance
from synth import PARAMS, SR, default_patch, from_vector, render
from targets import all_targets

out = Path(sys.argv[1] if len(sys.argv) > 1 else "../../out/c_recreate")
budget = int(sys.argv[2]) if len(sys.argv) > 2 else 1200
out.mkdir(parents=True, exist_ok=True)
summary = {}

for name, (y, true_f0, true_patch) in all_targets().items():
    d = out / name
    d.mkdir(exist_ok=True)
    sf.write(d / "reference.wav", y, SR)
    f0, gate = measure_note(y)
    seconds = len(y) / SR
    rec = {"true_f0": true_f0, "measured_f0": f0, "gate": gate, "conditions": {}}

    default = render(default_patch(), f0, seconds, gate)
    sf.write(d / "default.wav", default, SR)
    rec["conditions"]["default"] = {"distance": spectral_distance(y, default), "patch": default_patch()}

    rand_patch = from_vector(np.random.default_rng(zlib.crc32(name.encode())).random(len(PARAMS)))
    rand = render(rand_patch, f0, seconds, gate)
    sf.write(d / "anchor_random.wav", rand, SR)
    rec["conditions"]["anchor_random"] = {"distance": spectral_distance(y, rand), "patch": rand_patch}

    t = time.perf_counter()
    fit_f0, best, dist, evals = fit_any_octave(y, f0, gate, budget=budget)
    rec["conditions"]["optimizer"] = {
        "distance": dist, "patch": best, "f0": fit_f0, "evals": evals, "seconds": time.perf_counter() - t,
    }
    sf.write(d / "optimizer.wav", render(best, fit_f0, seconds, gate), SR)
    if true_patch:
        rec["true_patch"] = true_patch
        # Same patch, different oscillator phases: the best distance a perfect fit can reach.
        rec["conditions"]["true_patch_rerender"] = {
            "distance": spectral_distance(y, render(true_patch, true_f0, seconds, gate))
        }
        rec["conditions"]["optimizer"]["param_error"] = {
            p.name: abs(p.to_unit(best[p.name]) - p.to_unit(true_patch[p.name])) for p in PARAMS
        }
    summary[name] = rec
    c = rec["conditions"]
    print(
        f"{name:24s} f0 {true_f0:6.1f}->{c['optimizer']['f0']:6.1f}  default {c['default']['distance']:.3f}"
        f"  random {c['anchor_random']['distance']:.3f}  optimizer {dist:.3f} ({evals} renders, {c['optimizer']['seconds']:.0f}s)",
        flush=True,
    )

(out / "summary.json").write_text(json.dumps(summary, indent=2, default=float))
