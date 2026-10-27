"""Reference formulas and measurements for the effects verification harness.

References (see docs/fx-verification.md for full citations):
- RBJ: R. Bristow-Johnson, "Cookbook formulae for audio EQ biquad filter coefficients"
  (as adopted by the W3C Web Audio API spec, BiquadFilterNode section).
- Butterworth section Qs: J.O. Smith, Introduction to Digital Filters (CCRMA), and any filter text.
- Giannoulis, Massberg & Reiss 2012 (JAES 60(6)): compressor static curve eq. (4) and one-pole
  time constants alpha = exp(-1 / (tau fs)).
- Schroeder 1965 (JASA 37) backward integration; ISO 3382-1 T30 evaluation for RT60.
- ITU-R BS.1770-4: K-weighting (48 kHz coefficients) and 4x oversampled true peak.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
from scipy.signal import butter, hilbert, resample_poly, sosfilt, sosfiltfilt, sosfreqz, lfilter

SR = 48000
REPO = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("FX_OUT", REPO / "out" / "fx"))


# ------------------------------------------------------------------ IO
def render(name: str) -> tuple[np.ndarray, np.ndarray]:
    d = OUT / "renders"
    return (np.fromfile(d / f"{name}.L.f32", dtype="<f4").astype(np.float64),
            np.fromfile(d / f"{name}.R.f32", dtype="<f4").astype(np.float64))


def signal(base: str) -> tuple[np.ndarray, np.ndarray]:
    p = OUT / base
    if Path(f"{p}.f32").exists():
        x = np.fromfile(f"{p}.f32", dtype="<f4").astype(np.float64)
        return x, x
    return (np.fromfile(f"{p}.L.f32", dtype="<f4").astype(np.float64),
            np.fromfile(f"{p}.R.f32", dtype="<f4").astype(np.float64))


def cases() -> dict:
    spec = json.loads((OUT / "cases.json").read_text())
    return {c["name"]: c for c in spec["cases"]}


db = lambda x: 20 * np.log10(np.maximum(np.abs(x), 1e-30))
rms = lambda x: float(np.sqrt(np.mean(np.square(x))))
rms_db = lambda x: float(db(rms(x)))


# ------------------------------------------------------------------ RBJ biquads (Web Audio spec forms)
def _norm(b, a):
    b = np.asarray(b, float) / a[0]
    a = np.asarray(a, float) / a[0]
    return np.concatenate([b, a])


def rbj(kind: str, f0: float, q: float = np.sqrt(0.5), gain_db: float = 0.0, fs: float = SR) -> np.ndarray:
    """One second-order section (sos row). q is linear; shelves use S = 1 as in Web Audio."""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / fs
    c, s = np.cos(w0), np.sin(w0)
    alpha = s / (2 * q)
    if kind == "lowpass":
        return _norm([(1 - c) / 2, 1 - c, (1 - c) / 2], [1 + alpha, -2 * c, 1 - alpha])
    if kind == "highpass":
        return _norm([(1 + c) / 2, -(1 + c), (1 + c) / 2], [1 + alpha, -2 * c, 1 - alpha])
    if kind == "bandpass":  # constant 0 dB peak gain
        return _norm([alpha, 0, -alpha], [1 + alpha, -2 * c, 1 - alpha])
    if kind == "peaking":
        return _norm([1 + alpha * A, -2 * c, 1 - alpha * A], [1 + alpha / A, -2 * c, 1 - alpha / A])
    alpha_s = s / 2 * np.sqrt((A + 1 / A) * (1 / 1 - 1) + 2)
    sa = 2 * np.sqrt(A) * alpha_s
    if kind == "lowshelf":
        return _norm([A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa)],
                     [(A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa])
    if kind == "highshelf":
        return _norm([A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa)],
                     [(A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa])
    raise ValueError(kind)


def butterworth_qs(order: int) -> list[float]:
    return sorted(1 / (2 * np.cos((2 * k - 1) * np.pi / (2 * order))) for k in range(1, order // 2 + 1))


def cascade(kind: str, f0: float, order: int) -> list[np.ndarray]:
    return [rbj(kind, f0, q) for q in butterworth_qs(order)]


FREQS = np.geomspace(20, 20000, 400)


def ref_response(sos_rows: list[np.ndarray], gain_db: float = 0.0, freqs=FREQS) -> np.ndarray:
    if not sos_rows:
        return np.full(len(freqs), gain_db)
    _, h = sosfreqz(np.array(sos_rows), worN=freqs, fs=SR)
    return db(h) + gain_db


def dtft(x: np.ndarray, freqs) -> np.ndarray:
    """Exact DTFT at arbitrary frequencies (no bin interpolation)."""
    n = np.arange(len(x))
    out = np.empty(len(freqs), complex)
    for i in range(0, len(freqs), 50):
        f = np.asarray(freqs[i:i + 50])[:, None]
        out[i:i + 50] = np.exp(-2j * np.pi * f * n[None, :] / SR) @ x
    return out


def measured_response(y: np.ndarray, x: np.ndarray, freqs=FREQS) -> np.ndarray:
    return db(dtft(y, freqs) / dtft(x, freqs))


# ------------------------------------------------------------------ dynamics (Giannoulis et al. 2012)
def gc_static(x_db, T, R, W):
    """Soft-knee static curve, eq. (4)."""
    x = np.asarray(x_db, float)
    y = np.where(2 * (x - T) < -W, x, T + (x - T) / R)
    if W > 0:
        knee = np.abs(2 * (x - T)) <= W
        y = np.where(knee, x + (1 / R - 1) * (x - T + W / 2) ** 2 / (2 * W), y)
    return y


def time_to_fraction(trace: np.ndarray, start: int, frac: float, rising: bool) -> float:
    """Seconds from start until trace (normalised 0->1 change) crosses frac."""
    seg = trace[start:]
    v0, v1 = seg[0], seg[-1]
    norm = (seg - v0) / (v1 - v0)
    idx = np.argmax(norm >= frac)
    # linear interpolation between samples
    if idx > 0:
        a, b = norm[idx - 1], norm[idx]
        idx = idx - 1 + (frac - a) / (b - a)
    return idx / SR


# ------------------------------------------------------------------ spectra
def harmonics_db(y: np.ndarray, f0: float, nharm: int = 15) -> np.ndarray:
    """Amplitudes (dB) of harmonics 1..nharm via a Blackman-Harris windowed FFT (peak bin search)."""
    w = np.blackman(len(y))
    Y = np.abs(np.fft.rfft(y * w)) / (np.sum(w) / 2)
    f = np.fft.rfftfreq(len(y), 1 / SR)
    out = []
    for h in range(1, nharm + 1):
        k = int(round(h * f0 * len(y) / SR))
        if h * f0 >= SR / 2 - 100:
            out.append(-300.0)
            continue
        out.append(float(db(np.max(Y[max(0, k - 3):k + 4]))))
    return np.array(out)


def thd_db(y: np.ndarray, f0: float, nharm: int = 15) -> float:
    a = 10 ** (harmonics_db(y, f0, nharm) / 20)
    return float(db(np.sqrt(np.sum(a[1:] ** 2)) / a[0]))


def peak_freq(y: np.ndarray) -> float:
    """Frequency of the strongest component, parabolic interpolation on a log-magnitude spectrum."""
    n = len(y)
    w = np.hanning(n)
    Y = np.abs(np.fft.rfft(y * w, 8 * n))
    k = int(np.argmax(Y))
    a, b, c = np.log(Y[k - 1:k + 2])
    p = 0.5 * (a - c) / (a - 2 * b + c)
    return (k + p) * SR / (8 * n)


def cents(f, ref):
    return 1200 * np.log2(f / ref)


def inst_freq(y: np.ndarray) -> np.ndarray:
    ph = np.unwrap(np.angle(hilbert(y)))
    return np.diff(ph) * SR / (2 * np.pi)


# ------------------------------------------------------------------ reverb
def octave_band(y: np.ndarray, fc: float) -> np.ndarray:
    sos = butter(3, [fc / np.sqrt(2), fc * np.sqrt(2)], btype="bandpass", fs=SR, output="sos")
    return sosfiltfilt(sos, y)


def schroeder_db(ir: np.ndarray) -> np.ndarray:
    e = np.cumsum(ir[::-1] ** 2)[::-1]
    return 10 * np.log10(np.maximum(e / e[0], 1e-30))


def rt60_t30(ir: np.ndarray, lo: float = -5, hi: float = -35) -> float:
    """RT60 from the -5..-35 dB range of the Schroeder curve (ISO 3382 T30), least-squares line."""
    edc = schroeder_db(ir)
    i0 = int(np.argmax(edc <= lo))
    i1 = int(np.argmax(edc <= hi))
    t = np.arange(i0, i1) / SR
    slope, _ = np.polyfit(t, edc[i0:i1], 1)
    return float(-60 / slope)


def onset(y: np.ndarray, rel: float = 1e-3) -> int:
    return int(np.argmax(np.abs(y) > rel * np.max(np.abs(y))))


# ------------------------------------------------------------------ BS.1770-4
def k_weight(x: np.ndarray) -> np.ndarray:
    """K-weighting with the 48 kHz coefficients published in ITU-R BS.1770-4, Tables 1 and 2."""
    b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285]
    a1 = [1.0, -1.69065929318241, 0.73248077421585]
    b2 = [1.0, -2.0, 1.0]
    a2 = [1.0, -1.99004745483398, 0.99007225036621]
    return lfilter(b2, a2, lfilter(b1, a1, x))


def loudness_lufs(L: np.ndarray, R: np.ndarray) -> float:
    """Integrated loudness, BS.1770-4 gating (400 ms blocks, 75 % overlap, -70 LUFS absolute
    and -10 LU relative gates)."""
    zl, zr = k_weight(L) ** 2, k_weight(R) ** 2
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    z = np.array([np.mean(zl[i:i + blk]) + np.mean(zr[i:i + blk]) for i in range(0, len(L) - blk + 1, hop)])
    lk = -0.691 + 10 * np.log10(np.maximum(z, 1e-30))
    z = z[lk > -70]
    if not len(z):
        return -np.inf
    rel = -0.691 + 10 * np.log10(np.mean(z)) - 10
    z = z[(-0.691 + 10 * np.log10(z)) > rel]
    return float(-0.691 + 10 * np.log10(np.mean(z)))


def true_peak_db(x: np.ndarray) -> float:
    """4x oversampled peak (BS.1770-4 Annex 2 approach, polyphase FIR interpolation)."""
    return float(db(np.max(np.abs(resample_poly(x, 4, 1)))))
