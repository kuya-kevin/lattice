"""The melodic transcriber used by the router: pyin (librosa, ISC), DSP, monophonic. Returns a list
of cleanup.Note with a confidence 0-1 (the mean voiced probability of the note's frames).
"""
from __future__ import annotations

import librosa
import numpy as np

from cleanup import Note


def pyin(y: np.ndarray, sr: int, fmin: float = 55, fmax: float = 1400, hop: int = 256) -> list[Note]:
    if sr != 22050:
        y, sr = librosa.resample(y, orig_sr=sr, target_sr=22050), 22050
    f0, voiced, prob = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr, frame_length=2048, hop_length=hop)
    midi = np.where(voiced, librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0)), np.nan)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0][: len(midi)]
    r95 = np.percentile(rms, 95) + 1e-9
    rounded = np.round(midi)
    dt = hop / sr
    notes: list[Note] = []
    start = cur = None

    def close(i):
        if start is not None and (i - start) * dt >= 0.05:
            seg = midi[start:i]
            vel = int(np.clip(30 + 90 * np.mean(rms[start:i]) / r95, 20, 127))
            notes.append(Note(int(np.round(np.nanmedian(seg))), start * dt, i * dt, vel, float(np.nanmean(prob[start:i]))))

    for i, r in enumerate(rounded):
        if np.isnan(r):
            close(i)
            start = cur = None
        elif cur is None or abs(r - cur) >= 1:
            # tolerate a one-frame wobble: only split when the new pitch holds 3 frames
            if cur is not None and i + 2 < len(rounded) and not np.all(rounded[i : i + 3] == r):
                continue
            close(i)
            start, cur = i, r
    close(len(rounded))
    return notes
