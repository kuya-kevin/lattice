"""Spike C: a small subtractive synth with a flat, typed parameter space.

Every parameter has real units and a range so an agent (or an optimizer) can set it,
and a human can read it back as a knob. Renders one note, mono, at SR.
"""
from dataclasses import dataclass

import numpy as np
from scipy.signal import lfilter

SR = 22050
BLOCK = 128


@dataclass(frozen=True)
class Param:
    name: str
    lo: float
    hi: float
    unit: str
    log: bool = False
    integer: bool = False
    doc: str = ""

    def from_unit(self, u):
        u = float(np.clip(u, 0.0, 1.0))
        v = self.lo * (self.hi / self.lo) ** u if self.log else self.lo + u * (self.hi - self.lo)
        return round(v) if self.integer else v

    def to_unit(self, v):
        v = float(np.clip(v, self.lo, self.hi))
        return np.log(v / self.lo) / np.log(self.hi / self.lo) if self.log else (v - self.lo) / (self.hi - self.lo)


PARAMS = [
    Param("saw", 0, 1, "level", doc="sawtooth oscillator level"),
    Param("square", 0, 1, "level", doc="square oscillator level"),
    Param("sub", 0, 1, "level", doc="sine one octave below"),
    Param("noise", 0, 0.5, "level", doc="white noise level"),
    Param("voices", 1, 7, "count", integer=True, doc="unison voices on saw and square"),
    Param("detune", 0, 50, "cents", doc="spread of unison voices"),
    Param("cutoff", 60, 16000, "Hz", log=True, doc="low-pass cutoff"),
    Param("resonance", 0, 0.95, "amount", doc="low-pass resonance"),
    Param("env_amount", 0, 6, "octaves", doc="filter envelope pushes cutoff up by this much"),
    Param("env_decay", 0.005, 2.0, "s", log=True, doc="filter envelope decay"),
    Param("attack", 0.001, 1.0, "s", log=True, doc="amp attack"),
    Param("decay", 0.01, 2.0, "s", log=True, doc="amp decay"),
    Param("sustain", 0, 1, "level", doc="amp sustain"),
    Param("release", 0.01, 2.0, "s", log=True, doc="amp release"),
    Param("drive", 0, 1, "amount", doc="tanh saturation after the filter"),
]
BY_NAME = {p.name: p for p in PARAMS}


def default_patch():
    return {
        "saw": 0.8, "square": 0.0, "sub": 0.2, "noise": 0.0, "voices": 1, "detune": 0,
        "cutoff": 2000, "resonance": 0.2, "env_amount": 1.0, "env_decay": 0.3,
        "attack": 0.005, "decay": 0.3, "sustain": 0.7, "release": 0.2, "drive": 0.0,
    }


def to_vector(patch):
    return np.array([p.to_unit(patch[p.name]) for p in PARAMS])


def from_vector(x):
    return {p.name: p.from_unit(u) for p, u in zip(PARAMS, x)}


def _polyblep(t, dt):
    # Band-limits the saw discontinuity so aliasing doesn't dominate the spectrum.
    out = np.zeros_like(t)
    a = t < dt
    x = t[a] / dt
    out[a] = x + x - x * x - 1.0
    b = t > 1.0 - dt
    x = (t[b] - 1.0) / dt
    out[b] = x * x + x + x + 1.0
    return out


def _saw(phase, dt):
    t = phase % 1.0
    return 2.0 * t - 1.0 - _polyblep(t, dt)


def _adsr(n, gate_n, a, d, s, r):
    t = np.arange(n) / SR
    env = np.where(t < a, t / a, s + (1 - s) * np.exp(-(t - a) / (d / 4.6)))
    level_at_off = env[min(gate_n, n - 1)]
    rel = level_at_off * np.exp(-(t - gate_n / SR) / (r / 4.6))
    return np.where(np.arange(n) < gate_n, env, rel)


def render(patch, f0, seconds, gate_seconds, seed=0):
    p = {k: BY_NAME[k].from_unit(BY_NAME[k].to_unit(v)) for k, v in patch.items()}
    n = int(seconds * SR)
    gate_n = int(gate_seconds * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(seed)

    voices = int(p["voices"])
    spread = np.linspace(-1, 1, voices) if voices > 1 else np.zeros(1)
    osc = np.zeros(n)
    for s in spread:
        f = f0 * 2 ** (s * p["detune"] / 1200)
        dt = f / SR
        phase = rng.random() + f * t
        osc += p["saw"] * _saw(phase, dt)
        osc += p["square"] * 0.5 * (_saw(phase, dt) - _saw(phase + 0.5, dt))
    osc /= np.sqrt(voices)
    osc += p["sub"] * np.sin(2 * np.pi * (f0 / 2) * t)
    osc += p["noise"] * rng.standard_normal(n)

    # Block-wise 2-pole resonant low-pass with a decaying cutoff envelope.
    fenv = np.exp(-t / (p["env_decay"] / 4.6))
    cutoff = np.minimum(p["cutoff"] * 2 ** (p["env_amount"] * fenv), 0.45 * SR)
    q = 0.707 + p["resonance"] * 12
    y = np.zeros(n)
    zi = np.zeros(2)
    for i in range(0, n, BLOCK):
        w0 = 2 * np.pi * cutoff[i] / SR
        alpha = np.sin(w0) / (2 * q)
        cw = np.cos(w0)
        b = np.array([(1 - cw) / 2, 1 - cw, (1 - cw) / 2])
        a = np.array([1 + alpha, -2 * cw, 1 - alpha])
        y[i : i + BLOCK], zi = lfilter(b / a[0], a / a[0], osc[i : i + BLOCK], zi=zi)

    y *= _adsr(n, gate_n, p["attack"], p["decay"], p["sustain"], p["release"])
    if p["drive"] > 0:
        g = 1 + 9 * p["drive"]
        y = np.tanh(g * y) / np.tanh(g)
    peak = np.max(np.abs(y)) or 1.0
    return (0.8 * y / peak).astype(np.float32)
