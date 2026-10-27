"""Onset-based drum / beatbox to MIDI (no model: none of the AMT models found drums in voice notes).

1. Onsets with librosa on the percussive part (HPSS), backtracked to the attack.
2. At each onset, the spectral flux (log-magnitude rise) in three bands, summed over the
   first ~35 ms: low 40-200 Hz (kick, the beatboxed "b"), mid 200-3000 Hz (snare body, "k"/"pf"),
   high 5-11 kHz (hat, "ts"). Phone mics cut below ~120 Hz and above ~7.5 kHz, so the bands
   overlap what is left. Each band is normalised by its 90th percentile over the file's
   onsets, so a dull mic still splits its hits.
3. Multi-label: a hit can be kick + hat at once (they often coincide on the beat).
   kick: low band strong and low-vs-mid balance tilted low; hat: high band strong relative to
   the mid; snare: mid band strong and not explained by a kick. At least one label per onset
   (the band with the largest normalised flux).
4. Velocity from the onset strength. GM drum notes: kick 36, snare 38, closed hat 42.
"""
from __future__ import annotations

import librosa
import numpy as np

GM = {"kick": 36, "snare": 38, "hat": 42}
BANDS = {"low": (40, 200), "mid": (200, 3000), "high": (5000, 11000)}
# thresholds (on band flux / its 90th percentile), chosen on the synthetic GM-kit set (drum_eval.py)
TH = {"kick": 0.7, "kick_tilt": 0.6, "snare": 0.7, "snare_tilt": 0.6, "hat": 0.3, "hat_tilt": 0.5}
HOP = 256


def onset_features(y: np.ndarray, sr: int, delta: float = 0.07, min_gap: float = 0.05):
    """(times, strength, band flux matrix [n, 3]) for the onsets of y."""
    perc = librosa.effects.percussive(y, margin=2.0)
    env = librosa.onset.onset_strength(y=perc, sr=sr, hop_length=HOP)
    wait = int(min_gap * sr / HOP)
    peaks = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=HOP, delta=delta, wait=wait)
    frames = librosa.onset.onset_backtrack(peaks, env)
    S = np.log1p(100 * np.abs(librosa.stft(y, n_fft=1024, hop_length=HOP)))
    f = librosa.fft_frequencies(sr=sr, n_fft=1024)
    flux = np.maximum(0, np.diff(S, axis=1, prepend=S[:, :1]))
    look = max(2, int(0.035 * sr / HOP))
    feats = np.zeros((len(frames), 3))
    for j, (lo, hi) in enumerate(BANDS.values()):
        band = flux[(f >= lo) & (f < hi)].mean(axis=0)
        for i, fr in enumerate(frames):
            feats[i, j] = band[fr : fr + look + 1].sum()
    times = librosa.frames_to_time(frames, sr=sr, hop_length=HOP)
    return times, env[peaks], feats


def classify(feats: np.ndarray, th: dict = TH) -> list[list[str]]:
    if len(feats) == 0:
        return []
    norm = feats / (np.percentile(feats, 90, axis=0) + 1e-9)
    out = []
    for lo, mid, hi in norm:
        labels = []
        kick = lo >= th["kick"] and lo >= th["kick_tilt"] * mid
        if kick:
            labels.append("kick")
        if mid >= th["snare"] and (not kick or mid >= th["snare_tilt"] * lo * 1.5) and hi < 2.5 * mid:
            labels.append("snare")
        if hi >= th["hat"] and hi >= th["hat_tilt"] * mid:
            labels.append("hat")
        if not labels:
            labels.append(["kick", "snare", "hat"][int(np.argmax([lo, mid, hi]))])
        out.append(labels)
    return out


def detect(y: np.ndarray, sr: int, th: dict = TH) -> list[dict]:
    """Drum hits: [{"time", "class", "pitch", "velocity"}], several per onset when classes coincide."""
    y = y / (np.max(np.abs(y)) + 1e-9)
    times, strength, feats = onset_features(y, sr)
    if len(times) == 0:
        return []
    # gate: drop onsets far weaker than the strong ones (room noise, breaths, handling)
    keep = strength >= 0.1 * np.percentile(strength, 90)
    times, strength, feats = times[keep], strength[keep], feats[keep]
    s90 = np.percentile(strength, 90) + 1e-9
    hits = []
    for t, s, labels in zip(times, strength, classify(feats, th)):
        vel = int(np.clip(40 + 80 * s / s90, 30, 127))
        for cl in labels:
            hits.append({"time": round(float(t), 4), "class": cl, "pitch": GM[cl], "velocity": vel if cl != "hat" else int(vel * 0.8)})
    return hits


def percussive_ratio(y: np.ndarray) -> float:
    h, p = librosa.effects.hpss(y)
    return float(np.sum(p**2) / (np.sum(h**2) + np.sum(p**2) + 1e-12))
