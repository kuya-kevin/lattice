"""Known-answer test: hits on a 90 BPM 1/16 grid, jittered by up to ±25 ms, then quantized.

    uv run python f_engineer/test_quantize.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from quantize import hits, quantize  # noqa: E402

SR, BPM = 22050, 90.0
rng = np.random.default_rng(0)
step = 60 / BPM / 4
true = np.arange(0.25, 8.0, step)[rng.random(len(np.arange(0.25, 8.0, step))) < 0.5]  # half the 16ths have a hit
played = true + rng.uniform(-0.025, 0.025, len(true))
y = np.zeros(int(9 * SR))
t = np.arange(int(0.12 * SR)) / SR
for i, p in enumerate(played):
    kick = np.sin(2 * np.pi * 60 * t * (1 + 2 * np.exp(-t * 40))) * np.exp(-t * 25)
    snare = rng.normal(0, 1, len(t)) * np.exp(-t * 35)
    n = int(p * SR)
    y[n : n + len(t)] += 0.6 * (kick if i % 2 == 0 else snare)


def err_ms(found, ref):
    return 1000 * np.array([np.min(np.abs(ref - f)) for f in found])


grid_lines = np.arange(0.25 - 2 * step, 9.0, step)  # every 1/16 line of the true grid


def tightness_ms(found, ref):
    """Spread of hit-to-grid offsets once a constant offset (inaudible) is removed."""
    signed = 1000 * np.array([(f - ref[np.argmin(np.abs(ref - f))]) for f in found])
    return np.abs(signed - np.median(signed))


found = hits(y, SR)
print(f"hits: {len(found)} found of {len(true)} played")
print(f"detection error vs played time: median {np.median(err_ms(found, played)):.1f} ms")
for bpm in (BPM, None):
    q, info = quantize(y, SR, 16, 1.0, bpm)
    after = hits(q, SR)
    b, a = tightness_ms(found, grid_lines), tightness_ms(after, grid_lines)
    print(f"bpm given={bpm}: used {info['bpm']:.2f}; looseness (ms from grid, constant offset removed) before median {np.median(b):.1f}"
          f" / 90th pct {np.percentile(b, 90):.1f}, after median {np.median(a):.1f} / 90th pct {np.percentile(a, 90):.1f}")

if "--debug" in sys.argv:
    q, info = quantize(y, SR, 16, 1.0, BPM)
    print("true phase", round(true[0] % step, 4), "fitted", round(info["phase_s"], 4), "step", round(step, 4))
    print("planned new times vs true grid (ms):", np.round(err_ms(info["new_times"], grid_lines), 1))
    print("found:", np.round(found, 3))
    print("played:", np.round(played, 3))
