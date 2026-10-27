"""Spike C: fit synth parameters to a target sound.

The target's pitch and note length are measured, not fitted. Everything else is
searched with CMA-ES against a multi-resolution log-spectrogram distance.
"""
import cma
import librosa
import numpy as np

from synth import PARAMS, SR, from_vector, render, to_vector

FFTS = (2048, 512, 128)


def measure_note(y):
    """Pitch (Hz) and gate length (s) of a single-note target."""
    f0, voiced, _ = librosa.pyin(y, fmin=30, fmax=2000, sr=SR, frame_length=4096)
    f = float(np.nanmedian(f0[voiced])) if np.any(voiced) else 220.0
    rms = librosa.feature.rms(y=y, hop_length=256)[0]
    db = 20 * np.log10(rms / rms.max() + 1e-9)
    above = np.where(db > -12)[0]
    gate = (above[-1] * 256 / SR) if len(above) else len(y) / SR / 2
    return f, max(gate, 0.05)


def _mag(y, n_fft):
    return np.abs(librosa.stft(y, n_fft=n_fft, hop_length=n_fft // 4))


def _normalize(y):
    return y / (np.sqrt(np.mean(y**2)) + 1e-9)


def target_spectra(target):
    t = _normalize(target)
    return [_mag(t, k) for k in FFTS]


def spectral_distance(a, b, a_spectra=None):
    """DDSP-style multi-resolution distance: linear-magnitude convergence plus a
    down-weighted log term. A log-only distance over-weights the quiet gaps between
    harmonics and preferred the wrong octave on 2 of 6 targets; this one got 3/3."""
    n = min(len(a), len(b))
    a_spectra = a_spectra if a_spectra is not None and n == len(a) else target_spectra(a[:n])
    b = _normalize(b[:n])
    d = 0.0
    for sa, k in zip(a_spectra, FFTS):
        sb = _mag(b, k)
        d += np.linalg.norm(sa - sb) / np.linalg.norm(sa) + 0.25 * np.mean(np.abs(np.log(sa + 1e-4) - np.log(sb + 1e-4)))
    return float(d / len(FFTS))


def fit(target, f0, gate, x0=None, sigma0=0.3, budget=1200, frozen=None, seed=0):
    """CMA-ES fit. `frozen` maps param name -> value an agent decided not to search."""
    frozen = frozen or {}
    free = [i for i, p in enumerate(PARAMS) if p.name not in frozen]
    full0 = to_vector(x0) if x0 is not None else np.full(len(PARAMS), 0.5)
    frozen_vec = {i: PARAMS[i].to_unit(frozen[PARAMS[i].name]) for i in range(len(PARAMS)) if PARAMS[i].name in frozen}
    seconds = len(target) / SR
    spectra = target_spectra(target)

    def patch_of(xfree):
        x = full0.copy()
        x[free] = np.clip(xfree, 0, 1)
        for i, v in frozen_vec.items():
            x[i] = v
        return from_vector(x)

    def loss(xfree):
        return spectral_distance(target, render(patch_of(xfree), f0, seconds, gate), spectra)

    es = cma.CMAEvolutionStrategy(
        full0[free], sigma0,
        {"bounds": [0, 1], "maxfevals": budget, "seed": seed + 1, "verbose": -9, "popsize": 16},
    )
    while not es.stop():
        xs = es.ask()
        es.tell(xs, [loss(x) for x in xs])
    best = patch_of(es.result.xbest)
    return best, float(es.result.fbest), es.result.evaluations


def fit_any_octave(target, f0, gate, budget=1200, **kw):
    """pyin often lands an octave off (a sub oscillator reads as f/2), and no single
    harmonic rule fixed every case. Fit at f0 and 2*f0 with the full budget and keep the
    better: a short probe picked the wrong octave on 4 of 6 targets, the full fit on 0 of 3."""
    fits = {f: fit(target, f, gate, budget=budget, **kw) for f in (f0, 2 * f0)}
    best_f0 = min(fits, key=lambda f: fits[f][1])
    patch, dist, _ = fits[best_f0]
    return best_f0, patch, dist, sum(r[2] for r in fits.values())
