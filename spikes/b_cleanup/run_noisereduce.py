"""Spike B: spectral-gating cleanup (noisereduce) on the voice notes.

Stationary gating with a noise profile taken from the quietest half second wins on
these notes: non-stationary gating removed as much of the performance as the noise.
"""
import sys
import time
from pathlib import Path

import noisereduce as nr
import numpy as np
import soundfile as sf


def quietest_window(y, sr, seconds=0.5):
    w = int(seconds * sr)
    hop = w // 4
    energy = [np.mean(y[i : i + w] ** 2) for i in range(0, len(y) - w, hop)]
    start = int(np.argmin(energy)) * hop
    return y[start : start + w]


src = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

for wav in sorted(src.glob("*.wav")):
    y, sr = sf.read(wav)
    t = time.perf_counter()
    clean = nr.reduce_noise(y=y, sr=sr, stationary=True, y_noise=quietest_window(y, sr), prop_decrease=1.0)
    dt = time.perf_counter() - t
    sf.write(out / wav.name, clean, sr)
    print(f"{wav.name}: {dt:.2f}s for {len(y) / sr:.1f}s audio")
