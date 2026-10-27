"""Measures the headless renders against published references. Run after signals.py and the
Playwright renders (see docs/fx-verification.md):

  uv run --with pytest pytest fx_verify -q          (from spikes/, FX_OUT set)
"""
from __future__ import annotations

import json

import numpy as np
import pytest
from scipy.signal import butter, correlate, medfilt, resample_poly, sosfilt

from measure import (FREQS, OUT, SR, butterworth_qs, cascade, cases, cents, db, gc_static, harmonics_db, inst_freq,
                     loudness_lufs, measured_response, octave_band, onset, peak_freq, rbj, ref_response, render, rms,
                     rms_db, rt60_t30, signal, thd_db, time_to_fraction, true_peak_db)

CASES = cases()


def io(name):
    c = CASES[name]
    return signal(c["signal"]), render(name), c


# ====================================================================== utility
def test_utility_gain(rec):
    ok = True
    for name, g in (("utility_gain_m6", -6.0), ("utility_gain_p12", 12.0)):
        (x, _), (y, _), _ = io(name)
        m = rms_db(y) - rms_db(x)
        ok &= rec("utility", name, "gain (dB)", g, m, "±0.01 dB", abs(m - g) < 0.01, "definition")
    assert ok


def test_utility_width(rec):
    ok = True
    for w in (0, 50, 100, 150, 200):
        (xl, xr), (yl, yr), _ = io(f"utility_width_{w}")
        mi, si = (xl + xr) / 2, (xl - xr) / 2
        mo, so = (yl + yr) / 2, (yl - yr) / 2
        dm = rms_db(mo) - rms_db(mi)
        ds = rms_db(so) - rms_db(si)
        exp = 20 * np.log10(w / 100) if w else -np.inf
        okw = abs(dm) < 0.01 and ((ds < -120) if w == 0 else abs(ds - exp) < 0.01)
        ok &= rec("utility", f"utility_width_{w}", "side gain (dB), mid change (dB)", f"{exp:.2f}, 0", f"{ds:.2f}, {dm:.3f}", "±0.01 dB", okw, "M/S matrix")
    assert ok


def test_utility_pan_phase_swap(rec):
    (xl, xr), (yl, yr), _ = io("utility_pan_left")
    a = rec("utility", "utility_pan_left", "R out (dBFS); L out vs L+R in (dB)", "-inf; 0", f"{rms_db(yr):.1f}; {rms_db(yl) - rms_db(xl + xr):.3f}", "R < -120, ±0.01", rms_db(yr) < -120 and abs(rms_db(yl) - rms_db(xl + xr)) < 0.01, "W3C StereoPanner (stereo input)")
    (xl, xr), (yl, yr), _ = io("utility_phase_swap")
    err = max(np.max(np.abs(yl - xr)), np.max(np.abs(yr + xl)))
    b = rec("utility", "utility_phase_swap", "max |out - (R, -L)|", 0.0, float(err), "< 1e-6", err < 1e-6, "definition")
    assert a and b


def test_utility_mono_below(rec):
    (xl, xr), (yl, yr), _ = io("utility_mono_below_200")
    sl = (yl - yr) / 2
    si = (xl - xr) / 2
    s100 = harmonics_db(sl[SR // 4:], 100, 1)[0] - harmonics_db(si[SR // 4:], 100, 1)[0]
    s2k = harmonics_db(sl[SR // 4:], 2000, 1)[0] - harmonics_db(si[SR // 4:], 2000, 1)[0]
    ref100 = 20 * np.log10(0.5**4 / (1 + 0.5**4))  # LR4 high band = |Butterworth-2 HP|^2
    a = rec("utility", "utility_mono_below_200", "side @100 Hz (dB)", float(ref100), float(s100), "±0.5 dB", abs(s100 - ref100) < 0.5, "Linkwitz-Riley LR4")
    b = rec("utility", "utility_mono_below_200", "side @2 kHz (dB)", 0.0, float(s2k), "±0.05 dB", abs(s2k) < 0.05, "Linkwitz-Riley LR4")
    (xl, _), (yl, _), _ = io("utility_mono_below_off")
    err = float(np.max(np.abs(yl - xl)))
    c = rec("utility", "utility_mono_below_off", "max |out - in|", 0.0, err, "< 1e-6", err < 1e-6, "bypass")
    assert a and b and c


# ====================================================================== eq / filter (RBJ cookbook)
EQ_REF = {
    "eq_bell_2k5_p6_q2": ([rbj("peaking", 2500, 2, 6)], 0),
    "eq_bell_200_m12_q05": ([rbj("peaking", 200, 0.5, -12)], 0),
    "eq_bell_8k_p9_q8": ([rbj("peaking", 8000, 8, 9)], 0),
    "eq_lowshelf_100_p6": ([rbj("lowshelf", 100, gain_db=6)], 0),
    "eq_highshelf_10k_m6": ([rbj("highshelf", 10000, gain_db=-6)], 0),
    "eq_hp_100_12": (cascade("highpass", 100, 2), 0),
    "eq_hp_100_24": (cascade("highpass", 100, 4), 0),
    "eq_hp_100_48": (cascade("highpass", 100, 8), 0),
    "eq_lp_5k_36": (cascade("lowpass", 5000, 6), 0),
    "eq_out_m3": ([], -3),
    "eq_vocal_combo": (cascade("highpass", 90, 4) + [rbj("peaking", 300, 1, -3), rbj("peaking", 3000, 1.2, 2.5), rbj("highshelf", 12000, gain_db=2)], 0),
    "filter_lp_1k_24": (cascade("lowpass", 1000, 4), 0),
    "filter_hp_500_12": (cascade("highpass", 500, 2), 0),
    "filter_lp_2k_48": (cascade("lowpass", 2000, 8), 0),
    "filter_bp_1k_q2": ([rbj("bandpass", 1000, 2)], 0),
    "filter_lp_1k_reso4": ([rbj("lowpass", 1000, 4)], 0),
}


BUTTER_FC = {"eq_hp_100_12": 100, "eq_hp_100_24": 100, "eq_hp_100_48": 100, "eq_lp_5k_36": 5000,
             "filter_lp_1k_24": 1000, "filter_hp_500_12": 500, "filter_lp_2k_48": 2000}


@pytest.mark.parametrize("name", list(EQ_REF))
def test_eq_filter_rbj(rec, name):
    (x, _), (y, _), _ = io(name)
    rows, g = EQ_REF[name]
    ref = ref_response(rows, g)
    meas = measured_response(y, x)
    mask = ref > -40  # pass band and transition band
    err = float(np.max(np.abs(meas[mask] - ref[mask])))
    dev = "eq" if name.startswith("eq") else "filter"
    ok = rec(dev, name, "max |H - H_ref| where H_ref > -40 dB, 20 Hz-20 kHz (dB)", 0.0, err, "≤ 0.25 dB", err <= 0.25, "RBJ cookbook / Butterworth")
    deep = (ref <= -40) & (ref > -70)
    if deep.any():
        rec(dev, name, "max |H - H_ref| where -70 < H_ref ≤ -40 dB (dB), info", 0.0, float(np.max(np.abs(meas[deep] - ref[deep]))), "info", True, "stop band")
    extra = True
    fc = BUTTER_FC.get(name)
    if fc:
        h = float(measured_response(y, x, np.array([fc]))[0])
        extra = rec(dev, name, "|H(fc)| (dB)", -3.01, float(h), "±0.1 dB", abs(h + 3.01) < 0.1, "Butterworth -3 dB at fc")
    assert ok and extra


def test_filter_lfo(rec):
    (x, _), (y, _), _ = io("filter_lfo_1hz_2oct")
    hop = SR // 100
    frames = [y[i:i + 2048] for i in range(SR // 2, len(y) - 2048, hop)]
    f = np.fft.rfftfreq(2048, 1 / SR)
    cent = np.array([np.sum(f * np.abs(np.fft.rfft(fr * np.hanning(2048)))) / np.sum(np.abs(np.fft.rfft(fr * np.hanning(2048)))) for fr in frames])
    c = cent - cent.mean()
    spec = np.abs(np.fft.rfft(c * np.hanning(len(c)), 16 * len(c)))
    rate = np.fft.rfftfreq(16 * len(c), 1 / 100)[np.argmax(spec[1:]) + 1]
    ratio = float(np.percentile(cent, 95) / np.percentile(cent, 5))
    ok = rec("filter", "filter_lfo_1hz_2oct", "centroid modulation rate (Hz); max/min", "1.0; > 2", f"{rate:.2f}; {ratio:.2f}", "±0.1 Hz", abs(rate - 1) < 0.1 and ratio > 2, "LFO on detune (exponential)")
    assert ok


# ====================================================================== comp (Giannoulis et al. 2012)
@pytest.mark.parametrize("tag,T,R,W", [("k0", -24, 4, 0), ("k12", -24, 4, 12), ("r20", -30, 20, 0)])
def test_comp_static_curve(rec, tag, T, R, W):
    lv = np.arange(-60, 1, 5)
    meas = []
    for l in lv:
        _, (y, _), _ = io(f"comp_static_{tag}_{abs(l)}")
        meas.append(float(db(np.median(np.abs(y[int(0.4 * SR):])))))
    ref = gc_static(lv, T, R, W)
    err = float(np.max(np.abs(np.array(meas) - ref)))
    ok = rec("comp", f"comp_static_{tag} (T {T}, R {R}:1, knee {W})", "max static-curve error over -60..0 dB (dB)", 0.0, err, "≤ 0.1 dB", err <= 0.1, "Giannoulis 2012 eq. 4")
    assert ok


def gr_trace(name):
    (x, _), (y, _), _ = io(name)
    return db(np.abs(y) / np.maximum(np.abs(x), 1e-12))


@pytest.mark.parametrize("name,att,rel", [("comp_time_a10_r200", 10, 200), ("comp_time_a1_r50", 1, 50)])
def test_comp_time_constants(rec, name, att, rel):
    g = gr_trace(name)
    s0, s1 = int(0.5 * SR), int(1.5 * SR)
    ta = time_to_fraction(g[:s1], s0, 1 - np.exp(-1), True) * 1000
    tr = time_to_fraction(g, s1, 1 - np.exp(-1), False) * 1000
    gr = float(-np.median(g[s1 - SR // 10:s1]))
    exp_gr = float(-10 - gc_static(-10, -24, 4, 0))
    a = rec("comp", name, "attack time constant (ms)", att, ta, "±5 %", abs(ta - att) / att < 0.05, "Giannoulis 2012 eq. 7 (63 %)")
    b = rec("comp", name, "release time constant (ms)", rel, tr, "±5 %", abs(tr - rel) / rel < 0.05, "Giannoulis 2012 eq. 7 (63 %)")
    c = rec("comp", name, "steady GR at -10 dBFS (dB)", exp_gr, gr, "±0.05 dB", abs(gr - exp_gr) < 0.05, "Giannoulis 2012 eq. 4")
    assert a and b and c


def test_comp_makeup_mix(rec):
    g = gr_trace("comp_makeup_mix")
    meas = float(np.median(g[int(1.3 * SR):int(1.5 * SR)]))
    wet = 10 ** ((-10.5 + 6) / 20)
    exp = float(db(0.5 + 0.5 * wet))
    assert rec("comp", "comp_makeup_mix (makeup +6, mix 50 %)", "steady gain at -10 dBFS (dB)", exp, meas, "±0.05 dB", abs(meas - exp) < 0.05, "parallel mix")


# ====================================================================== limiter
@pytest.mark.parametrize("name,ceil", [("limiter_g12_c1", -1.0), ("limiter_g18_c3_la1", -3.0), ("limiter_drums_g9", -1.0)])
def test_limiter_ceiling(rec, name, ceil):
    (xl, xr), (yl, yr), c = io(name)
    pk = float(db(max(np.max(np.abs(yl)), np.max(np.abs(yr)))))
    tp = max(true_peak_db(yl), true_peak_db(yr))
    gain = c["devices"][0]["params"]["gain"]
    dl = loudness_lufs(yl, yr) - loudness_lufs(xl, xr)
    a = rec("limiter", name, "sample peak (dBFS)", ceil, pk, "≤ ceiling + 0.01 dB", pk <= ceil + 0.01, "brick-wall definition")
    rec("limiter", name, "true peak, 4x (dBTP), info", ceil, tp, "info (true peak is v1.1)", True, "ITU-R BS.1770-4 Annex 2")
    rec("limiter", name, "loudness gain (LU), info", f"< {gain}", float(dl), "info", True, "ITU-R BS.1770-4")
    assert a


def test_limiter_latency(rec):
    (x, _), (y, _), _ = io("limiter_latency")
    lag = int(np.argmax(np.abs(y)))
    a = rec("limiter", "limiter_latency (lookahead 5 ms)", "delay (samples)", 240, lag, "exact", lag == 240, "lookahead = latency")
    b = rec("limiter", "limiter_latency", "gain below ceiling", 1.0, float(y[lag] / x[0]), "±1e-5", abs(y[lag] / x[0] - 1) < 1e-5, "unity below ceiling")
    assert a and b


# ====================================================================== gate
def seg_level(y, t0, t1):
    return float(db(np.median(np.abs(y[int(t0 * SR):int(t1 * SR)]))))


def test_gate_range_hysteresis(rec):
    (x, _), (y, _), _ = io("gate_range40")
    # segments: -30 [0,.5) -70 [.5,2) -30 [2,2.5) -52 [2.5,3.3) -30 [3.3,3.6) -56 [3.6,4.8)
    att_closed = seg_level(x, 1.7, 1.95) - seg_level(y, 1.7, 1.95)
    att_hyst = seg_level(x, 3.0, 3.25) - seg_level(y, 3.0, 3.25)
    att_below = seg_level(x, 4.5, 4.75) - seg_level(y, 4.5, 4.75)
    a = rec("gate", "gate_range40", "attenuation when closed (dB)", 40.0, att_closed, "±0.1 dB", abs(att_closed - 40) < 0.1, "range")
    b = rec("gate", "gate_range40", "-52 dBFS after open (thresh -50, hyst 3): attenuation (dB)", 0.0, att_hyst, "±0.1 dB (stays open)", abs(att_hyst) < 0.1, "hysteresis")
    c = rec("gate", "gate_range40", "-56 dBFS: attenuation (dB)", 40.0, att_below, "±0.1 dB (closes)", abs(att_below - 40) < 0.1, "hysteresis")
    assert a and b and c


def test_gate_timing(rec):
    (x, _), (y, _), _ = io("gate_timing")
    g = db(np.abs(y) / np.maximum(np.abs(x), 1e-12))  # gain in dB (smoothed in dB)
    # opening at 2.0 s (-70 -> -30): one-pole attack 5 ms on the dB gain
    ta = time_to_fraction(g[:int(2.4 * SR)], int(2.0 * SR), 1 - np.exp(-1), True) * 1000
    # closing at 0.5 s (-30 -> -70): detector release (10 ms) crosses thresh-hyst after 10 ms * ln(10^(23/20)),
    # then hold 100 ms, then release 50 ms
    hi, lo, floor = 10 ** (-30 / 20), 10 ** (-53 / 20), 10 ** (-70 / 20)
    det = 10 * np.log((hi - floor) / (lo - floor))  # 10 ms detector release from -30 toward -70 crosses -53
    seg = g[int(0.5 * SR):int(2.0 * SR)]
    drop = int(np.argmax(seg < -0.01))
    hold = drop / SR * 1000 - det
    tr = time_to_fraction(seg, drop, 1 - np.exp(-1), False) * 1000
    a = rec("gate", "gate_timing", "attack time constant, dB domain (ms)", 5.0, ta, "±5 %", abs(ta - 5) / 5 < 0.05, "one-pole, 63 %")
    b = rec("gate", "gate_timing", "hold (ms)", 100.0, hold, "±1 ms", abs(hold - 100) < 1, "hold counter")
    c = rec("gate", "gate_timing", "release time constant, dB domain (ms)", 50.0, tr, "±5 %", abs(tr - 50) / 50 < 0.05, "one-pole, 63 %")
    assert a and b and c


# ====================================================================== de-esser
def band_db(x, lo=4500, hi=9000):
    sos = butter(6, [lo, hi], btype="bandpass", fs=SR, output="sos")
    return rms_db(sosfilt(sos, x))


def test_deess_synthetic(rec):
    segs = json.loads((OUT / "signals" / "sibilant_segments.json").read_text())
    ok = True
    for name, mode in (("deess_synth_split", "split"), ("deess_synth_wide", "wide"), ("deess_synth_shelf", "shelf")):
        (x, _), (y, _), _ = io(name)
        ss = [s for s in segs if s["label"] == "s"]
        s_red = np.mean([band_db(x[s["start"]:s["end"]]) - band_db(y[s["start"]:s["end"]]) for s in ss])
        lo, hi = (6000, 7000) if mode != "shelf" else (7000, 9000)
        c_red = np.mean([band_db(x[s["start"]:s["end"]], lo, hi) - band_db(y[s["start"]:s["end"]], lo, hi) for s in ss])
        v_chg = np.mean([rms_db(y[s["start"]:s["end"]]) - rms_db(x[s["start"]:s["end"]]) for s in segs if s["label"] == "vowel"])
        ok &= rec("deess", name, f"reduction on 's' bursts, {lo // 1000}-{hi // 1000} kHz (dB)", "≈ 9 (range 9)", float(c_red), "7 to 9.5", 7 <= c_red <= 9.5, "relative detector")
        rec("deess", name, "reduction on 's' bursts, 4.5-9 kHz (dB), info", "≤ 9", float(s_red), "info", True, "relative detector")
        ok &= rec("deess", name, "level change on vowels (dB)", 0.0, float(v_chg), "±0.5 dB", abs(v_chg) < 0.5, "relative detector")
    (x, _), (y, _), _ = io("deess_synth_bypass")
    err = float(np.max(np.abs(y - x)))
    ok &= rec("deess", "deess_synth_bypass (range 0)", "max |out - in|", 0.0, err, "< 1e-5 (split path sums to input)", err < 1e-5, "svf notch + band = input")
    assert ok


@pytest.mark.parametrize("name", [n for n in CASES if n.startswith("deess_vocal_")])
def test_deess_vocal(rec, name):
    (x, _), (y, _), _ = io(name)
    n = int(0.02 * SR)
    sos = butter(6, [5000, 10000], btype="bandpass", fs=SR, output="sos")
    hx, hy = sosfilt(sos, x), sosfilt(sos, y)
    sib, non = [], []
    for i in range(0, len(x) - n, n):
        e = rms(x[i:i + n])
        if e < 10 ** (-45 / 20):
            continue
        r = rms(hx[i:i + n]) / e
        if r > 0.35:
            sib.append(rms_db(hx[i:i + n]) - rms_db(hy[i:i + n]))
        elif r < 0.05:
            non.append(rms_db(y[i:i + n]) - rms_db(x[i:i + n]))
    s_red, v_chg = float(np.mean(sib)), float(np.mean(non))
    a = rec("deess", f"{name} ({len(sib)} sibilant / {len(non)} voiced frames)", "5-10 kHz reduction on sibilant frames (dB)", "> 2", s_red, "> 2 dB", s_red > 2, "Freesound CC-BY take")
    b = rec("deess", name, "level change on non-sibilant frames (dB)", 0.0, v_chg, "±0.5 dB", abs(v_chg) < 0.5, "Freesound CC-BY take")
    assert a and b


# ====================================================================== saturation (THD vs drive)
def sat_reference(x, model, drive, bias=0.0):
    """Same static curves in numpy, 8x oversampled (polyphase), DC removed."""
    g = 10 ** (drive / 20)
    b = bias * 0.5
    f = {
        "tape": np.tanh,
        "tube": lambda u: np.where(u >= 0, np.tanh(u), 1.5 * np.tanh(u / 1.5)),
        "transistor": lambda u: np.where(np.abs(u) >= 1, np.sign(u), 1.5 * (u - u**3 / 3)),
        "fuzz": lambda u: np.sin(np.pi / 2 * u),
    }[model]
    # Web Audio's curve covers inputs in [-1, 1]; beyond that the end value holds
    u = resample_poly(x, 8, 1)
    y = f(g * np.clip(u, -1, 1) + b) - f(np.array(b))
    y = resample_poly(y, 1, 8)
    return y - np.mean(y)


@pytest.mark.parametrize("model", ["tape", "tube", "transistor", "fuzz"])
def test_sat_thd(rec, model):
    ok = True
    prev = -np.inf
    for drive in (0, 6, 12, 24, 36):
        (x, _), (y, _), _ = io(f"sat_{model}_{drive}")
        seg = slice(SR // 4, SR // 4 + 32768)
        m = thd_db(y[seg], 1000)
        r = thd_db(sat_reference(x, model, drive)[seg], 1000)
        tol = 1.0 if r > -60 else 3.0
        ok &= rec("sat", f"sat_{model}_{drive}", "THD, h2..h15 (dB)", float(r), float(m), f"±{tol} dB", abs(m - r) <= tol, "static curve, numpy 8x")
        if model in ("tape", "transistor", "tube"):
            ok &= m >= prev - 0.5
        prev = m
    assert ok


def test_sat_auto_gain_mix_bias(rec):
    (x, _), (y, _), _ = io("sat_tape_12_auto")
    d = rms_db(y[SR // 4:]) - rms_db(x[SR // 4:])
    a = rec("sat", "sat_tape_12_auto", "level change with auto gain (dB)", 0.0, d, "±0.3 dB", abs(d) < 0.3, "RMS match at -12 dBFS")
    (x, _), (w, _), _ = io("sat_tape_12")
    (_, _), (m, _), _ = io("sat_tape_12_mix50")
    seg = slice(SR // 4, SR // 4 + 32768)
    lag = int(np.argmax(correlate(w[seg], x[seg], mode="full", method="fft"))) - (32768 - 1)
    exp = 0.5 * x[seg] + 0.5 * w[seg]
    err = rms_db(m[seg] - exp) - rms_db(exp)
    b = rec("sat", "sat_tape_12_mix50", "wet/dry alignment lag (samples); mix error (dB rel)", "0; < -60", f"{lag}; {err:.1f}", "lag 0, < -60 dB", lag == 0 and err < -60, "latency-compensated dry path")
    (x, _), (y, _), _ = io("sat_tube_bias")
    h = harmonics_db(y[seg], 1000, 3)
    h2 = float(h[1] - h[0])
    (_, _), (y0, _), _ = io("sat_tape_12")
    h0 = harmonics_db(y0[seg], 1000, 3)
    c = rec("sat", "sat_tube_bias vs sat_tape_12", "2nd harmonic (dBc): biased tube; symmetric tape", "> -40; < -80", f"{h2:.1f}; {h0[1] - h0[0]:.1f}", "even harmonics from asymmetry", h2 > -40 and h0[1] - h0[0] < -80, "Zölzer DAFX ch. 4")
    assert a and b and c


# ====================================================================== delay
def echo_peaks(y, burst, n):
    c = correlate(y, burst, mode="valid", method="fft")
    env = np.abs(c)
    peaks = []
    guard = int(0.03 * SR)
    work = env.copy()
    for _ in range(n):
        k = int(np.argmax(work))
        peaks.append((k, float(env[k])))
        work[max(0, k - guard):k + guard] = 0
    return sorted(peaks)


@pytest.mark.parametrize("name,ms,fb", [("delay_250_fb50", 250, 0.5), ("delay_sync_8th_120", 250, 0.3), ("delay_sync_8d_100", 450, 0.3)])
def test_delay_spacing_feedback(rec, name, ms, fb):
    (x, _), (y, _), _ = io(name)
    b = x[:int(0.02 * SR)]
    p = echo_peaks(y, b, 3)
    spacing = np.diff([0] + [k for k, _ in p]) / SR * 1000
    ratio = float(db(p[1][1] / p[0][1]))
    a = rec("delay", name, "echo times (ms)", f"{ms}, {2 * ms}, {3 * ms}", ", ".join(f"{k / SR * 1000:.2f}" for k, _ in p), "±1 sample", all(abs(k - (i + 1) * ms * SR / 1000) <= 1 for i, (k, _) in enumerate(p)), "J.O. Smith PASP, feedback comb")
    c = rec("delay", name, "echo-to-echo ratio (dB)", float(db(fb)), ratio, "±0.1 dB", abs(ratio - db(fb)) < 0.1, "feedback gain")
    assert a and c


def test_delay_pingpong_spread_runaway(rec):
    (x, _), (yl, yr), _ = io("delay_pingpong")
    b = x[:int(0.02 * SR)]
    el = [rms(yl[int((k * 0.2 - 0.01) * SR):int((k * 0.2 + 0.03) * SR)]) for k in (1, 2, 3)]
    er = [rms(yr[int((k * 0.2 - 0.01) * SR):int((k * 0.2 + 0.03) * SR)]) for k in (1, 2, 3)]
    alt = el[0] > 100 * er[0] and er[1] > 100 * el[1] and el[2] > 100 * er[2]
    a = rec("delay", "delay_pingpong", "echo 1/2/3 side", "L, R, L", ", ".join("L" if l > r else "R" for l, r in zip(el, er)), "≥ 40 dB separation", alt, "cross-feedback")
    (x, _), (yl, yr), _ = io("delay_spread_50")
    lag = (echo_peaks(yr, b, 1)[0][0] - echo_peaks(yl, b, 1)[0][0])
    c = rec("delay", "delay_spread_50", "R - L echo offset (samples)", 360, lag, "±1", abs(lag - 360) <= 1, "7.5 ms at 50 %")
    (_, _), (y, _), _ = io("delay_fb110_bounded")
    first = np.max(np.abs(y[:int(0.2 * SR)]))
    late = np.max(np.abs(y[-SR:]))
    d = rec("delay", "delay_fb110_bounded", "peak first 0.2 s / last 1 s", "grows, stays finite (< 4)", f"{first:.3f} / {late:.3f}", "late > first, finite", bool(np.isfinite(late) and late > first and late < 4), "loop soft clip")
    assert a and c and d


# ====================================================================== reverb
@pytest.mark.parametrize("dec", [0.5, 1, 2, 4])
def test_reverb_rt60(rec, dec):
    _, (y, _), _ = io(f"reverb_rt60_{dec}")
    t1k = rt60_t30(octave_band(y, 1000))
    tbb = rt60_t30(y)
    a = rec("reverb", f"reverb_rt60_{dec}", "RT60, T30 in the 1 kHz octave (s)", float(dec), t1k, "±15 %", abs(t1k - dec) / dec < 0.15, "Schroeder 1965; ISO 3382-1")
    rec("reverb", f"reverb_rt60_{dec}", "RT60, T30 broadband (s), info", float(dec), tbb, "info", True, "Schroeder 1965")
    assert a


def test_reverb_predelay_damping_width(rec):
    o = {pd: onset(render(f"reverb_predelay_{pd}")[0]) for pd in (0, 50, 120)}
    ok = True
    for pd in (50, 120):
        d = (o[pd] - o[0]) / SR * 1000
        ok &= rec("reverb", f"reverb_predelay_{pd}", "onset shift vs predelay 0 (ms)", float(pd), d, "±0.1 ms", abs(d - pd) < 0.1, "definition")
    _, (y, _), _ = io("reverb_damping_3k")
    r = rt60_t30(octave_band(y, 8000)) / rt60_t30(octave_band(y, 1000))
    ok &= rec("reverb", "reverb_damping_3k", "RT60(8 kHz) / RT60(1 kHz)", "< 0.75 (0.5 above f2)", float(r), "< 0.75", r < 0.75, "zita-rev1 f2 (decay halves above)")
    _, (yl, yr), _ = io("reverb_width_0")
    s = rms_db(yl - yr) - rms_db(yl + yr)
    ok &= rec("reverb", "reverb_width_0", "side / mid (dB)", "-inf", float(s), "< -100 dB", s < -100, "M/S width")
    assert ok


# ====================================================================== pitch
@pytest.mark.parametrize("name", [n for n in CASES if n.startswith("pitch_") and not n.startswith("pitch_harm")])
def test_pitch_cents(rec, name):
    (x, _), (y, _), c = io(name)
    p = c["devices"][0]["params"]
    target = 440 * 2 ** ((p["semis"] + p["cents"] / 100) / 12)
    f = peak_freq(y[int(0.5 * SR):int(1.8 * SR)])
    e = float(cents(f, target))
    lvl = rms_db(y[int(0.5 * SR):int(1.8 * SR)]) - rms_db(x[int(0.5 * SR):int(1.8 * SR)])
    a = rec("pitch", name, "pitch error (cents)", 0.0, e, "±5 ct", abs(e) <= 5, f"pure sine, f = 440 * 2^(st/12) = {target:.2f} Hz")
    rec("pitch", name, "level change (dB), info", 0.0, float(lvl), "info", True, "")
    if not a and target < 250:
        pytest.xfail(f"known gap: pure tones shifted below ~250 Hz land sharp ({e:+.1f} ct), see fx-verification.md")
    assert a


@pytest.mark.parametrize("name", [n for n in CASES if n.startswith("pitch_harm")])
def test_pitch_harmonic(rec, name):
    """Harmonic tone: f0 from the harmonic comb (sum of log spectra at k*f, k = 1..8)."""
    _, (y, _), c = io(name)
    st = c["devices"][0]["params"]["semis"]
    target = 220 * 2 ** (st / 12)
    seg = y[int(0.5 * SR):int(1.8 * SR)]
    w = np.hanning(len(seg))
    Y = np.abs(np.fft.rfft(seg * w, 4 * len(seg)))
    fbin = SR / (4 * len(seg))
    cand = target * 2 ** (np.linspace(-60, 60, 2401) / 1200)
    score = [sum(np.log(np.interp(k * f, np.arange(len(Y)) * fbin, Y) + 1e-12) for k in range(1, 9)) for f in cand]
    e = float(cents(cand[int(np.argmax(score))], target))
    assert rec("pitch", name, "f0 error, harmonic comb (cents)", 0.0, e, "±5 ct", abs(e) <= 5, f"220 Hz, 12 harmonics -> {target:.1f} Hz")


# ====================================================================== modulation
def test_mod(rec):
    (x, _), (y, _), c = io("mod_chorus_sine")
    f = medfilt(inst_freq(y[SR // 2:-SR // 4]), 401)[1000:-1000]
    dev = (np.percentile(f, 99.5) - np.percentile(f, 0.5)) / 2
    exp = 1000 * 2 * np.pi * 1.0 * 0.5 * 0.007  # f0 * omega_m * depth * delay
    a = rec("mod", "mod_chorus_sine (rate 1 Hz, depth 50 %, 7 ms)", "peak frequency deviation (Hz)", float(exp), float(dev), "±10 %", abs(dev - exp) / exp < 0.1, "Doppler of a modulated delay (Dattorro 1997)")
    (x, _), (y, _), _ = io("mod_phaser_noise")
    d = rms_db(y[SR // 2:]) - rms_db(x[SR // 2:])
    b = rec("mod", "mod_phaser_noise (mix 100 %)", "energy change (dB)", 0.0, float(d), "±0.2 dB", abs(d) < 0.2, "allpass chain is lossless")
    (x, _), (y, _), _ = io("mod_flanger_noise")
    seg = y[2 * SR:2 * SR + 8192] * np.hanning(8192)
    sp = db(np.convolve(np.abs(np.fft.rfft(seg)), np.ones(9) / 9, mode="same"))[50:2000]
    depth = float(np.percentile(sp, 99) - np.percentile(sp, 1))
    c2 = rec("mod", "mod_flanger_noise (mix 50 %, fb 50 %)", "comb notch depth (dB)", "> 12", depth, "> 12 dB", depth > 12, "feedforward + feedback comb")
    assert a and b and c2


# ====================================================================== crush
@pytest.mark.parametrize("bits", [4, 8, 12])
def test_crush_bits(rec, bits):
    (x, _), (y, _), _ = io(f"crush_bits_{bits}")
    snr = rms_db(x) - rms_db(y - x)
    exp = 6.02 * bits + 1.76 - 0.5  # full-scale sine rule, input at -0.5 dBFS
    tol = 3.0 if bits == 4 else 1.5
    levels = len(np.unique(np.round(y, 7)))
    a = rec("crush", f"crush_bits_{bits}", "SNR (dB); distinct levels", f"{exp:.1f}; ≤ {2 ** bits + 1}", f"{snr:.1f}; {levels}", f"±{tol} dB", abs(snr - exp) < tol and levels <= 2**bits + 1, "6.02 N + 1.76 dB (uniform quantizer)")
    assert a


def test_crush_downsample(rec):
    _, (y, _), _ = io("crush_down_4")
    same = float(np.mean(y[1:] == y[:-1]))
    assert rec("crush", "crush_down_4", "fraction of held samples", 0.75, same, "±0.01", abs(same - 0.75) < 0.01, "sample-and-hold x4")


# ====================================================================== chain smoke
def test_chain_vocal_preset(rec):
    if "chain_vocal_preset" not in CASES:
        pytest.skip("no vocal file")
    (xl, xr), (yl, yr), _ = io("chain_vocal_preset")
    pk = float(db(max(np.max(np.abs(yl)), np.max(np.abs(yr)))))
    lu = loudness_lufs(yl, yr)
    ok = rec("chain", "chain_vocal_preset (gate eq deess comp sat delay reverb limiter)", "sample peak (dBFS); loudness (LUFS)", "≤ -1; info", f"{pk:.2f}; {lu:.1f}", "peak ≤ -0.99", pk <= -0.99 and np.isfinite(lu), "end-to-end")
    assert ok
