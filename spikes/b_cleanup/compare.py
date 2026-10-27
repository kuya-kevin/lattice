"""Spike B: compare cleanup methods on noise floor removed vs. signal kept.

A good cleanup drops the quiet frames (noise floor) a lot while barely touching the
loud frames (the performance). For hums we also check the pitch track survives.
"""
import sys
from pathlib import Path

import librosa
import numpy as np

SR = 22050


def frame_db(y):
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    return 20 * np.log10(rms + 1e-9)


def pitch_track(y):
    f0, voiced, _ = librosa.pyin(y, fmin=60, fmax=1000, sr=SR)
    return np.where(voiced, f0, np.nan)


raw_dir = Path(sys.argv[1])
method_dirs = [Path(p) for p in sys.argv[2:]]

for raw in sorted(raw_dir.glob("*.wav")):
    y_raw, _ = librosa.load(raw, sr=SR)
    db_raw = frame_db(y_raw)
    quiet = db_raw <= np.percentile(db_raw, 20)
    loud = db_raw >= np.percentile(db_raw, 80)
    f0_raw = pitch_track(y_raw)
    print(f"\n{raw.name}")
    for d in method_dirs:
        y, _ = librosa.load(d / raw.name, sr=SR)
        n = min(len(y), len(y_raw))
        db = frame_db(y[:n])
        m = min(len(db), len(db_raw))
        floor_drop = np.mean(db_raw[:m][quiet[:m]]) - np.mean(db[:m][quiet[:m]])
        signal_loss = np.mean(db_raw[:m][loud[:m]]) - np.mean(db[:m][loud[:m]])
        f0 = pitch_track(y[:n])
        k = min(len(f0), len(f0_raw))
        both = ~np.isnan(f0[:k]) & ~np.isnan(f0_raw[:k])
        kept = both.sum() / max((~np.isnan(f0_raw[:k])).sum(), 1)
        cents = np.median(np.abs(1200 * np.log2(f0[:k][both] / f0_raw[:k][both]))) if both.any() else float("nan")
        print(
            f"  {d.name:12s} noise floor -{floor_drop:5.1f} dB | performance -{signal_loss:4.1f} dB"
            f" | pitched frames kept {kept:4.0%} | pitch drift {cents:4.1f} cents"
        )
