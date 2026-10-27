"""Spike C: test targets.

In-family targets come from our own synth with known parameters, so we can check
whether a matcher recovers them. Out-of-family targets use synthesis our synth
can't express exactly (FM, plucked string, chorus+reverb), which is closer to
matching a sound from a real record.
"""
import numpy as np
import pedalboard as pb

from synth import SR, render

SECONDS = 2.0
GATE = 1.2

IN_FAMILY = {
    "in_supersaw_lead": (
        {"saw": 0.9, "square": 0.0, "sub": 0.3, "noise": 0.02, "voices": 7, "detune": 28,
         "cutoff": 3200, "resonance": 0.25, "env_amount": 1.5, "env_decay": 0.4,
         "attack": 0.01, "decay": 0.5, "sustain": 0.8, "release": 0.4, "drive": 0.3},
        220.0,
    ),
    "in_acid_bass": (
        {"saw": 0.0, "square": 0.85, "sub": 0.1, "noise": 0.0, "voices": 1, "detune": 0,
         "cutoff": 180, "resonance": 0.8, "env_amount": 4.5, "env_decay": 0.18,
         "attack": 0.002, "decay": 0.25, "sustain": 0.4, "release": 0.08, "drive": 0.6},
        55.0,
    ),
    "in_soft_pad": (
        {"saw": 0.5, "square": 0.3, "sub": 0.0, "noise": 0.05, "voices": 4, "detune": 14,
         "cutoff": 900, "resonance": 0.1, "env_amount": 0.5, "env_decay": 1.2,
         "attack": 0.5, "decay": 1.0, "sustain": 0.9, "release": 0.8, "drive": 0.0},
        330.0,
    ),
}


def _env(n, a, d, gate_n, r):
    t = np.arange(n) / SR
    e = np.minimum(t / a, 1.0) * np.exp(-np.maximum(t - a, 0) / d)
    tail = np.exp(-np.maximum(t - gate_n / SR, 0) / r)
    return e * tail


def fm_epiano(f0=261.63):
    n = int(SECONDS * SR)
    t = np.arange(n) / SR
    index = 3.0 * np.exp(-t / 0.25)
    y = np.sin(2 * np.pi * f0 * t + index * np.sin(2 * np.pi * f0 * 14 * t))
    y += 0.5 * np.sin(2 * np.pi * f0 * t + 1.2 * np.exp(-t / 0.6) * np.sin(2 * np.pi * f0 * t))
    return y * _env(n, 0.002, 0.9, int(GATE * SR), 0.15), f0


def karplus_pluck(f0=146.83, seed=1):
    n = int(SECONDS * SR)
    period = int(round(SR / f0))
    buf = np.random.default_rng(seed).uniform(-1, 1, period)
    y = np.zeros(n)
    for i in range(n):
        y[i] = buf[i % period]
        buf[i % period] = 0.498 * (buf[i % period] + buf[(i + 1) % period])
    return y, SR / period


def chorus_reverb_lead(f0=392.0):
    patch = {"saw": 0.6, "square": 0.4, "sub": 0.0, "noise": 0.0, "voices": 2, "detune": 8,
             "cutoff": 2500, "resonance": 0.3, "env_amount": 1.0, "env_decay": 0.3,
             "attack": 0.03, "decay": 0.4, "sustain": 0.7, "release": 0.3, "drive": 0.1}
    dry = render(patch, f0, SECONDS, GATE)
    board = pb.Pedalboard([pb.Chorus(rate_hz=0.8, depth=0.4, mix=0.5), pb.Reverb(room_size=0.6, wet_level=0.3)])
    return board(dry, SR), f0


OUT_OF_FAMILY = {
    "out_fm_epiano": fm_epiano,
    "out_karplus_pluck": karplus_pluck,
    "out_chorus_reverb_lead": chorus_reverb_lead,
}


def all_targets():
    """name -> (audio, true_f0, true_patch or None)."""
    out = {}
    for name, (patch, f0) in IN_FAMILY.items():
        out[name] = (render(patch, f0, SECONDS, GATE, seed=7), f0, patch)
    for name, fn in OUT_OF_FAMILY.items():
        y, f0 = fn()
        y = 0.8 * y / np.max(np.abs(y))
        out[name] = (y.astype(np.float32), f0, None)
    return out
