"""Optional: compare Lattice renders with Logic "golden bounces" of the same test signals.

On the Mac: put $FX_OUT/golden/<signal>.wav on a track, dial the Logic plugin to the settings of a
case in $FX_OUT/cases.json (see docs/fx-verification.md), bounce to $FX_OUT/logic/<case>.wav (48 kHz).
Then, back here:

  uv run python fx_verify/compare_golden.py [case ...]

Per case: alignment lag, level difference, null depth (residual after alignment and level match)
and the worst 1/3-octave magnitude difference between 50 Hz and 16 kHz.
"""
from __future__ import annotations

import sys

import numpy as np
import soundfile as sf
from scipy.signal import correlate, resample_poly

from measure import OUT, SR, db, render, rms


def third_octave_db(x: np.ndarray) -> np.ndarray:
    X = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / SR)
    centers = 1000 * 2 ** (np.arange(-13, 13) / 3)
    out = [10 * np.log10(np.sum(X[(f >= c / 2 ** (1 / 6)) & (f < c * 2 ** (1 / 6))]) + 1e-30) for c in centers]
    return centers, np.array(out)


def compare(case: str) -> str:
    ref, sr = sf.read(OUT / "logic" / f"{case}.wav", always_2d=True)
    ref = ref[:, 0]
    if sr != SR:
        ref = resample_poly(ref, SR, sr)
    ours, _ = render(case)
    n = min(len(ref), len(ours))
    lag = int(np.argmax(correlate(ours[:n], ref[:n], mode="full", method="fft"))) - (n - 1)
    a, b = (ours[lag:n], ref[: n - lag]) if lag >= 0 else (ours[: n + lag], ref[-lag:n])
    level = float(db(rms(a) / rms(b)))
    g = np.dot(a, b) / np.dot(b, b)
    null = float(db(rms(a - g * b) / rms(a)))
    c, ta = third_octave_db(a)
    _, tb = third_octave_db(b)
    band = (c >= 50) & (c <= 16000)
    worst = float(np.max(np.abs((ta - tb)[band] - (ta - tb)[band].mean())))
    return f"| {case} | {lag} | {level:+.2f} | {null:.1f} | {worst:.2f} |"


if __name__ == "__main__":
    names = sys.argv[1:] or sorted(p.stem for p in (OUT / "logic").glob("*.wav"))
    print("| case | lag (samples) | level, ours - Logic (dB) | null depth (dB) | worst 1/3-oct shape diff (dB) |")
    print("|---|---|---|---|---|")
    for name in names:
        print(compare(name))
