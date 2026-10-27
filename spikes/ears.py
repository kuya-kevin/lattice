"""Text ears for Muse: Muse's audio input is speech-to-text, so it can't hear timbre.
We measure a sound and describe it in words and numbers Muse can reason over.

describe(y, sr, f0, gate) -> dict of features; to_text(features) -> short summary;
compare(target, candidate) -> what to change, in words, for a revision step.
"""
import librosa
import numpy as np

HOP = 256


def _note_name(f0):
    return librosa.hz_to_note(f0) if f0 else "unpitched"


def _envelope(y, sr, gate):
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=HOP)[0]
    t = np.arange(len(rms)) * HOP / sr
    peak_i = int(np.argmax(rms))
    peak = rms[peak_i] + 1e-12
    attack = float(t[np.argmax(rms >= 0.9 * peak)])
    held = rms[(t > t[peak_i]) & (t < gate)]
    sustain = float(np.median(held[-max(len(held) // 4, 1):]) / peak) if len(held) else 0.0
    # Decay: time from peak until within 10% of the sustain level (or gate end).
    settle = np.where((t > t[peak_i]) & (rms <= (sustain + 0.1 * (1 - sustain)) * peak))[0]
    decay = float(t[settle[0]] - t[peak_i]) if len(settle) else float(gate - t[peak_i])
    after = np.where((t > gate) & (rms < 0.05 * peak))[0]
    release = float(t[after[0]] - gate) if len(after) else float(t[-1] - gate)
    return {"attack_s": attack, "decay_s": max(decay, 0.0), "sustain_level": sustain, "release_s": max(release, 0.0)}


def _harmonics(y, sr, f0, n=16):
    """Harmonic amplitudes (dB re. strongest), sub-octave level, and how noisy the spectrum is."""
    S = np.abs(librosa.stft(y, n_fft=8192, hop_length=2048)).mean(axis=1)
    freqs = librosa.fft_frequencies(sr=sr, n_fft=8192)

    def level(f):
        band = (freqs > f * 0.97) & (freqs < f * 1.03)
        return S[band].max() if band.any() else 0.0

    h = np.array([level(f0 * k) for k in range(1, n + 1) if f0 * k < sr / 2 - 200])
    ref = h.max() + 1e-12
    h_db = 20 * np.log10(h / ref + 1e-6)
    sub_db = float(20 * np.log10(level(f0 / 2) / ref + 1e-6))
    odd, even = h[0::2], h[1::2]
    odd_even_db = float(20 * np.log10((np.sum(odd[1:] ** 2) + 1e-12) / (np.sum(even**2) + 1e-12)) / 2)
    # Slope of harmonic level vs log2(harmonic number): saw ≈ -6 dB/oct, square odd ≈ -6, sine steep.
    k = np.arange(1, len(h) + 1)
    slope = float(np.polyfit(np.log2(k), h_db, 1)[0])
    # Noise: energy away from the harmonic series.
    near = np.zeros_like(freqs, dtype=bool)
    for kk in range(1, int(sr / f0) + 1):  # half-harmonics too, so a sub oscillator isn't counted as noise
        near |= np.abs(freqs - f0 * kk / 2) < f0 * 0.04
    noise_db = float(10 * np.log10((np.sum(S[~near] ** 2) + 1e-12) / (np.sum(S[near] ** 2) + 1e-12)))
    return {"harmonic_slope_db_per_octave": slope, "odd_vs_even_db": odd_even_db, "sub_octave_db": sub_db, "noise_vs_tone_db": noise_db}


def _brightness(y, sr, f0, gate):
    """Spectral centroid in harmonic numbers at the start, middle and end of the note (filter motion)."""
    cent = librosa.feature.spectral_centroid(y=y, sr=sr, n_fft=2048, hop_length=HOP)[0]
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    t = np.arange(len(cent)) * HOP / sr
    loud = rms > 0.05 * rms.max()

    def at(lo, hi):
        m = loud & (t >= lo) & (t < hi)
        return float(np.median(cent[m]) / f0) if m.any() else float("nan")

    return {"brightness_start": at(0.0, 0.08), "brightness_mid": at(gate * 0.4, gate * 0.6), "brightness_end": at(gate * 0.85, gate)}


def _movement(y, sr, f0, gate):
    """Beating of the fundamental's band (unison detune / chorus show up as amplitude wobble).
    Measured relative to the overall level so attack and decay don't count as wobble."""
    S = np.abs(librosa.stft(y, n_fft=4096, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=4096)
    band = S[(freqs > f0 * 0.9) & (freqs < f0 * 1.1)].sum(axis=0)
    total = S.sum(axis=0)
    t = np.arange(len(band)) * HOP / sr
    m = (t > 0.15) & (t < gate) & (total > 0.1 * total.max())
    ratio = band[m] / (total[m] + 1e-12)
    wobble = float(np.std(ratio) / (np.mean(ratio) + 1e-12)) if m.sum() > 4 else 0.0
    return {"wobble": wobble}


def describe(y, sr, f0, gate):
    feats = {"pitch_hz": f0, "note": _note_name(f0), "note_length_s": gate}
    feats.update(_envelope(y, sr, gate))
    feats.update(_brightness(y, sr, f0, gate))
    feats.update(_harmonics(y, sr, f0))
    feats.update(_movement(y, sr, f0, gate))
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in feats.items()}


GLOSSARY = """How to read these measurements:
- attack_s / decay_s / release_s: seconds; sustain_level: 0-1 of the peak.
- brightness_*: spectral centroid in harmonic numbers (1 = only the fundamental, 8+ = bright) at the start, middle and end of the note; a falling value means a closing filter.
- harmonic_slope_db_per_octave: about -6 for a saw or square, steeper (-12 or lower) for a filtered or sine-like tone.
- odd_vs_even_db: near 0 for a saw, strongly positive (+10 or more) for a square/hollow tone.
- sub_octave_db: level an octave below the note; above about -30 means a sub oscillator.
- noise_vs_tone_db: above about -25 means audible noise or breath (detuned unison and fast plucks also raise it).
- wobble: amplitude movement of the fundamental while held; above about 0.1 means beating from detuned unison voices or chorus."""


def to_text(feats):
    return "\n".join(f"- {k}: {v}" for k, v in feats.items())


def compare(target, candidate):
    """Per-feature differences as text, largest first, so a revision can be specific."""
    rows = []
    for k, tv in target.items():
        cv = candidate.get(k)
        if not isinstance(tv, (int, float)) or not isinstance(cv, (int, float)) or k in ("pitch_hz", "note_length_s"):
            continue
        if np.isnan(tv) or np.isnan(cv):
            continue
        scale = max(abs(tv), abs(cv), 1e-3)
        rows.append((abs(tv - cv) / scale, f"- {k}: target {tv}, yours {cv}"))
    return "\n".join(r for _, r in sorted(rows, reverse=True))
