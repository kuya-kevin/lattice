"""Test signals and render cases for the Lattice effects verification harness.

Writes to $FX_OUT (default ../out/fx relative to the repo root):
  signals/<name>.{L,R}.f32 or .f32   raw float32 for the Playwright renderer
  golden/<name>.wav                  24-bit WAV copies for an optional Logic "golden bounce"
  cases.json                         device settings per case (read by app/e2e-fx/render.spec.ts)

Run:  uv run python fx_verify/signals.py      (from spikes/)
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

SR = 48000
REPO = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("FX_OUT", REPO / "out" / "fx"))
VOCALS = Path(os.environ.get("LATTICE_DATA", REPO / "data")) / "freesound_material" / "audio" / "dry_vocal"
# sibilant takes picked by spikes/h_freesound (manifest "sibilant frames 40 % / 15 %")
VOCAL_IDS = ["39913", "435156"]

rng = np.random.default_rng(20261027)
t_of = lambda sec: np.arange(int(round(sec * SR))) / SR
db = lambda x: 10 ** (x / 20)


def write(name: str, x: np.ndarray, golden: bool = True) -> str:
    """x: (n,) mono or (n, 2) stereo float."""
    (OUT / "signals").mkdir(parents=True, exist_ok=True)
    x = np.asarray(x, dtype=np.float32)
    base = OUT / "signals" / name
    if x.ndim == 1:
        x.tofile(f"{base}.f32")
    else:
        x[:, 0].copy().tofile(f"{base}.L.f32")
        x[:, 1].copy().tofile(f"{base}.R.f32")
    if golden:
        (OUT / "golden").mkdir(parents=True, exist_ok=True)
        sf.write(OUT / "golden" / f"{name}.wav", np.clip(x, -1, 1 - 2**-23), SR, subtype="PCM_24")
    return f"signals/{name}"


def square(level_db: float, sec: float, hz: float = 1000.0) -> np.ndarray:
    """Naive square wave: |x| is constant, so a peak detector sees a steady level (a 'DC' level
    test without DC). Used for static curves and time constants of dynamics devices."""
    return db(level_db) * np.sign(np.sin(2 * np.pi * hz * t_of(sec) + 1e-9))


def sine(level_db: float, sec: float, hz: float) -> np.ndarray:
    return db(level_db) * np.sin(2 * np.pi * hz * t_of(sec))


def burst(hz: float, ms: float, level_db: float = -12) -> np.ndarray:
    n = int(SR * ms / 1000)
    return db(level_db) * np.sin(2 * np.pi * hz * np.arange(n) / SR) * np.hanning(n)


def sibilant_phrase() -> np.ndarray:
    """Vowel-like harmonic tone (f0 150 Hz, formants ~700/1200/2600 Hz) alternating with
    sibilant noise bursts (band 4.5-9 kHz), 4 cycles of 300 ms vowel + 120 ms 's'."""
    from scipy.signal import butter, sosfilt

    parts, labels = [], []
    sos_s = butter(4, [4500, 9000], btype="bandpass", fs=SR, output="sos")
    for _ in range(4):
        t = t_of(0.3)
        # 1/k^2 tilt (about -12 dB/oct, like a voiced glottal source) plus three formant bumps
        v = sum(np.sin(2 * np.pi * 150 * k * t) * (1 / k**2) * (1 + 2 * np.exp(-((150 * k - 700) / 300) ** 2) + np.exp(-((150 * k - 1200) / 300) ** 2) + 0.5 * np.exp(-((150 * k - 2600) / 400) ** 2)) for k in range(1, 40))
        v = v / np.max(np.abs(v)) * db(-12) * np.hanning(len(t)) ** 0.25
        s = sosfilt(sos_s, rng.standard_normal(int(0.12 * SR)))
        s = s / np.sqrt(np.mean(s**2)) * db(-20) * np.hanning(len(s)) ** 0.5
        parts += [v, s]
        labels += [("vowel", len(v)), ("s", len(s))]
    x = np.concatenate(parts)
    seg, pos = [], 0
    for lab, n in labels:
        seg.append({"label": lab, "start": pos, "end": pos + n})
        pos += n
    (OUT / "signals").mkdir(parents=True, exist_ok=True)
    (OUT / "signals" / "sibilant_segments.json").write_text(json.dumps(seg))
    return x


def load_vocal(vid: str) -> np.ndarray:
    x, sr = sf.read(VOCALS / f"{vid}.wav", always_2d=True)
    x = x.mean(axis=1)
    if sr != SR:
        g = np.gcd(sr, SR)
        x = resample_poly(x, SR // g, sr // g)
    return (x / np.max(np.abs(x)) * db(-3)).astype(np.float32)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cases: list[dict] = []

    def case(name, signal, devices, tail=0.0, **kw):
        cases.append({"name": name, "signal": signal, "devices": devices, "tail": tail, **kw})

    # ---------------------------------------------------------- shared signals
    imp = np.zeros(SR // 2)
    imp[0] = 0.5
    s_imp = write("impulse", imp)
    imp2 = np.zeros((SR // 2, 2))
    imp2[0] = 0.5
    s_imp2 = write("impulse_st", imp2, golden=False)

    # ---------------------------------------------------------- utility
    s_sine = write("sine1k_m12", sine(-12, 1.0, 1000))
    case("utility_gain_m6", s_sine, [{"kind": "utility", "params": {"gain": -6}}])
    case("utility_gain_p12", s_sine, [{"kind": "utility", "params": {"gain": 12}}])
    st = np.stack([sine(-12, 1.0, 500), sine(-12, 1.0, 700)], axis=1)
    s_st = write("stereo_500_700", st)
    for w in (0, 50, 100, 150, 200):
        case(f"utility_width_{w}", s_st, [{"kind": "utility", "params": {"width": w}}])
    case("utility_pan_left", s_st, [{"kind": "utility", "params": {"pan": -1}}])
    case("utility_phase_swap", s_st, [{"kind": "utility", "params": {"phase_l": True, "swap": True}}])
    side = np.stack([sine(-12, 1.0, 100) + sine(-12, 1.0, 2000), -(sine(-12, 1.0, 100) + sine(-12, 1.0, 2000))], axis=1)
    s_side = write("side_100_2k", side)
    case("utility_mono_below_200", s_side, [{"kind": "utility", "params": {"mono_below": 200}}])
    case("utility_mono_below_off", s_side, [{"kind": "utility", "params": {}}])

    # ---------------------------------------------------------- eq (impulse responses)
    eq_cases = {
        "eq_bell_2k5_p6_q2": {"b3_freq": 2500, "b3_gain": 6, "b3_q": 2},
        "eq_bell_200_m12_q05": {"b1_freq": 200, "b1_gain": -12, "b1_q": 0.5},
        "eq_bell_8k_p9_q8": {"b4_freq": 8000, "b4_gain": 9, "b4_q": 8},
        "eq_lowshelf_100_p6": {"ls_freq": 100, "ls_gain": 6},
        "eq_highshelf_10k_m6": {"hs_freq": 10000, "hs_gain": -6},
        "eq_hp_100_12": {"hp_on": True, "hp_freq": 100, "hp_slope": 12},
        "eq_hp_100_24": {"hp_on": True, "hp_freq": 100, "hp_slope": 24},
        "eq_hp_100_48": {"hp_on": True, "hp_freq": 100, "hp_slope": 48},
        "eq_lp_5k_36": {"lp_on": True, "lp_freq": 5000, "lp_slope": 36},
        "eq_out_m3": {"out": -3},
        "eq_vocal_combo": {"hp_on": True, "hp_freq": 90, "b1_freq": 300, "b1_gain": -3, "b3_freq": 3000, "b3_gain": 2.5, "b3_q": 1.2, "hs_freq": 12000, "hs_gain": 2},
    }
    for name, p in eq_cases.items():
        case(name, s_imp, [{"kind": "eq", "params": p}])

    # ---------------------------------------------------------- filter
    filt = {
        "filter_lp_1k_24": {"type": "lowpass", "slope": 24, "cutoff": 1000},
        "filter_hp_500_12": {"type": "highpass", "slope": 12, "cutoff": 500},
        "filter_lp_2k_48": {"type": "lowpass", "slope": 48, "cutoff": 2000},
        "filter_bp_1k_q2": {"type": "bandpass", "slope": 12, "cutoff": 1000, "reso": 2},
        "filter_lp_1k_reso4": {"type": "lowpass", "slope": 12, "cutoff": 1000, "reso": 4},
    }
    for name, p in filt.items():
        case(name, s_imp, [{"kind": "filter", "params": p}])
    noise = rng.standard_normal(SR * 4) * db(-18)
    s_noise = write("noise_4s", noise)
    case("filter_lfo_1hz_2oct", s_noise, [{"kind": "filter", "params": {"cutoff": 1000, "lfo_rate": 1, "lfo_depth": 2}}])

    # ---------------------------------------------------------- comp
    levels = list(range(-60, 1, 5))
    for lv in levels:
        s = write(f"square_{abs(lv)}", square(lv, 0.6), golden=False)
        case(f"comp_static_k0_{abs(lv)}", s, [{"kind": "comp", "params": {"thresh": -24, "ratio": 4, "knee": 0, "attack": 1, "release": 50}}])
        case(f"comp_static_k12_{abs(lv)}", s, [{"kind": "comp", "params": {"thresh": -24, "ratio": 4, "knee": 12, "attack": 1, "release": 50}}])
        case(f"comp_static_r20_{abs(lv)}", s, [{"kind": "comp", "params": {"thresh": -30, "ratio": 20, "knee": 0, "attack": 1, "release": 50}}])
    step = np.concatenate([square(-40, 0.5), square(-10, 1.0), square(-40, 1.5)])
    s_step = write("square_step_m40_m10", step)
    case("comp_time_a10_r200", s_step, [{"kind": "comp", "params": {"thresh": -24, "ratio": 4, "knee": 0, "attack": 10, "release": 200}}])
    case("comp_time_a1_r50", s_step, [{"kind": "comp", "params": {"thresh": -24, "ratio": 4, "knee": 0, "attack": 1, "release": 50}}])
    case("comp_makeup_mix", s_step, [{"kind": "comp", "params": {"thresh": -24, "ratio": 4, "knee": 0, "attack": 1, "release": 50, "makeup": 6, "mix": 50}}])

    # ---------------------------------------------------------- limiter
    hot = sine(-6, 1.0, 997) + 0.4 * np.sign(np.sin(2 * np.pi * 3 * t_of(1.0))) * (rng.random(SR) > 0.999)
    s_hot = write("limiter_hot", hot)
    case("limiter_g12_c1", s_hot, [{"kind": "limiter", "params": {"gain": 12, "ceiling": -1, "lookahead": 5, "release": 60}}])
    case("limiter_g18_c3_la1", s_hot, [{"kind": "limiter", "params": {"gain": 18, "ceiling": -3, "lookahead": 1, "release": 20}}])
    drums = np.zeros(SR * 2)
    for k in range(8):
        n0 = k * SR // 4
        n = SR // 8
        drums[n0:n0 + n] += rng.standard_normal(n) * np.exp(-np.arange(n) / (SR * 0.02)) * (0.9 if k % 2 == 0 else 0.5)
    drums *= db(-1) / np.max(np.abs(drums))  # peak -1 dBFS before the limiter's input gain
    s_dr = write("drums_synth", drums)
    case("limiter_drums_g9", s_dr, [{"kind": "limiter", "params": {"gain": 9, "ceiling": -1, "lookahead": 5, "release": 80}}])
    case("limiter_latency", s_imp, [{"kind": "limiter", "params": {"lookahead": 5}}])

    # ---------------------------------------------------------- gate
    # -30 [0,.5) -70 [.5,2) -30 [2,2.5) -52 [2.5,3.3) -30 [3.3,3.6) -56 [3.6,4.8)
    gate_sig = np.concatenate([square(-30, 0.5), square(-70, 1.5), square(-30, 0.5), square(-52, 0.8), square(-30, 0.3), square(-56, 1.2)])
    s_gate = write("gate_levels", gate_sig)
    case("gate_range40", s_gate, [{"kind": "gate", "params": {"thresh": -50, "range": -40, "hyst": 3, "attack": 1, "hold": 30, "release": 100}}])
    case("gate_timing", s_gate, [{"kind": "gate", "params": {"thresh": -50, "range": -60, "hyst": 3, "attack": 5, "hold": 100, "release": 50}}])

    # ---------------------------------------------------------- deess
    s_sib = write("sibilant_synth", sibilant_phrase())
    case("deess_synth_split", s_sib, [{"kind": "deess", "params": {"freq": 6500, "thresh": -20, "range": 9}}])
    case("deess_synth_wide", s_sib, [{"kind": "deess", "params": {"freq": 6500, "thresh": -20, "range": 9, "band": "wide"}}])
    case("deess_synth_shelf", s_sib, [{"kind": "deess", "params": {"freq": 5000, "thresh": -20, "range": 9, "shape": "highshelf"}}])
    case("deess_synth_bypass", s_sib, [{"kind": "deess", "params": {"freq": 6500, "thresh": 0, "range": 0}}])
    for vid in VOCAL_IDS:
        if (VOCALS / f"{vid}.wav").exists():
            s_v = write(f"vocal_{vid}", load_vocal(vid))
            case(f"deess_vocal_{vid}", s_v, [{"kind": "deess", "params": {"freq": 6500, "thresh": -18, "range": 8}}])

    # ---------------------------------------------------------- sat (THD vs drive)
    for model in ("tape", "tube", "transistor", "fuzz"):
        for drive in (0, 6, 12, 24, 36):
            case(f"sat_{model}_{drive}", s_sine, [{"kind": "sat", "params": {"model": model, "drive": drive, "tone": 20000, "low_cut": 20, "auto_gain": False}}])
    case("sat_tape_12_auto", s_sine, [{"kind": "sat", "params": {"model": "tape", "drive": 12, "tone": 20000, "auto_gain": True}}])
    case("sat_tape_12_mix50", s_sine, [{"kind": "sat", "params": {"model": "tape", "drive": 12, "tone": 20000, "auto_gain": False, "mix": 50}}])
    case("sat_tube_bias", s_sine, [{"kind": "sat", "params": {"model": "tube", "drive": 12, "bias": 0.5, "tone": 20000, "auto_gain": False}}])

    # ---------------------------------------------------------- delay
    s_b = write("burst1k", np.concatenate([burst(1000, 20), np.zeros(SR // 10)]))
    case("delay_250_fb50", s_b, [{"kind": "delay", "params": {"sync": False, "time_ms": 250, "feedback": 50, "low_cut": 20, "high_cut": 20000, "width": 0, "mix": 100}}], tail=1.6)
    case("delay_sync_8th_120", s_b, [{"kind": "delay", "params": {"sync": True, "time_note": "1/8", "feedback": 30, "low_cut": 20, "high_cut": 20000, "width": 0, "mix": 100}}], tail=1.2, tempo=120)
    case("delay_sync_8d_100", s_b, [{"kind": "delay", "params": {"sync": True, "time_note": "1/8d", "feedback": 30, "low_cut": 20, "high_cut": 20000, "width": 0, "mix": 100}}], tail=1.6, tempo=100)
    case("delay_pingpong", s_b, [{"kind": "delay", "params": {"sync": False, "time_ms": 200, "feedback": 60, "pingpong": True, "low_cut": 20, "high_cut": 20000, "mix": 100}}], tail=1.2)
    case("delay_fb110_bounded", s_b, [{"kind": "delay", "params": {"sync": False, "time_ms": 50, "feedback": 110, "low_cut": 20, "high_cut": 20000, "width": 0, "mix": 100}}], tail=4.0)
    case("delay_spread_50", s_b, [{"kind": "delay", "params": {"sync": False, "time_ms": 250, "feedback": 0, "low_cut": 20, "high_cut": 20000, "width": 50, "mix": 100}}], tail=0.6)

    # ---------------------------------------------------------- reverb
    flat = {"mix": 100, "low_ratio": 1, "damping": 20000, "low_cut": 20, "high_cut": 20000, "predelay": 0}
    for dec in (0.5, 1, 2, 4):
        case(f"reverb_rt60_{dec}", s_imp, [{"kind": "reverb", "params": {**flat, "decay": dec}}], tail=max(3, dec * 2.5))
    for pd in (0, 50, 120):
        case(f"reverb_predelay_{pd}", s_imp, [{"kind": "reverb", "params": {**flat, "decay": 1, "predelay": pd}}], tail=2)
    case("reverb_damping_3k", s_imp, [{"kind": "reverb", "params": {**flat, "decay": 2, "damping": 3000}}], tail=5)
    case("reverb_width_0", s_imp2, [{"kind": "reverb", "params": {**flat, "decay": 1, "width": 0}}], tail=2)

    # ---------------------------------------------------------- pitch
    s440 = write("sine440_2s", sine(-12, 2.0, 440))
    for semis, cents in ((7, 0), (-12, 0), (3, 37), (12, 0), (-5, -20)):
        for keep in (False, True):
            case(f"pitch_{semis}st_{cents}ct_{'fk' if keep else 'nf'}", s440, [{"kind": "pitch", "params": {"semis": semis, "cents": cents, "formant_keep": keep}}], tail=0.3)

    # harmonic tone (f0 220 Hz, 12 harmonics, 1/k): closer to real material than a sine
    t = t_of(2.0)
    harm = sum(np.sin(2 * np.pi * 220 * k * t) / k for k in range(1, 13))
    s_h = write("harm220_2s", harm / np.max(np.abs(harm)) * db(-12))
    for semis in (-12, -7, 5, 12):
        case(f"pitch_harm_{semis}st", s_h, [{"kind": "pitch", "params": {"semis": semis, "formant_keep": False}}], tail=0.3)

    # ---------------------------------------------------------- mod
    case("mod_chorus_sine", write("sine1k_3s", sine(-12, 3.0, 1000)), [{"kind": "mod", "params": {"mode": "chorus", "rate": 1, "depth": 50, "delay": 7, "mix": 100}}])
    case("mod_phaser_noise", s_noise, [{"kind": "mod", "params": {"mode": "phaser", "rate": 0.5, "depth": 50, "stages": 8, "mix": 100}}])
    case("mod_flanger_noise", s_noise, [{"kind": "mod", "params": {"mode": "flanger", "rate": 0.25, "depth": 80, "delay": 2, "feedback": 50, "mix": 50}}])

    # ---------------------------------------------------------- crush
    s_fs = write("sine997_m1", sine(-0.5, 1.0, 997))
    for bits in (4, 8, 12):
        case(f"crush_bits_{bits}", s_fs, [{"kind": "crush", "params": {"bits": bits, "downsample": 1}}])
    case("crush_down_4", s_fs, [{"kind": "crush", "params": {"bits": 16, "downsample": 4}}])

    # ---------------------------------------------------------- whole chain smoke
    if (VOCALS / f"{VOCAL_IDS[0]}.wav").exists():
        case("chain_vocal_preset", f"signals/vocal_{VOCAL_IDS[0]}", [
            {"kind": "gate", "params": {"thresh": -60}},
            {"kind": "eq", "params": {"hp_on": True, "hp_freq": 90, "b3_freq": 3000, "b3_gain": 2.5}},
            {"kind": "deess", "params": {"thresh": -18}},
            {"kind": "comp", "params": {"thresh": -24, "ratio": 3, "makeup": 4}},
            {"kind": "sat", "params": {"drive": 4}},
            {"kind": "delay", "params": {"mix": 12}},
            {"kind": "reverb", "params": {"mix": 15}},
            {"kind": "limiter", "params": {"ceiling": -1}},
        ], tail=2)

    (OUT / "cases.json").write_text(json.dumps({"sampleRate": SR, "cases": cases}, indent=1))
    print(f"{len(cases)} cases, signals in {OUT / 'signals'}")


if __name__ == "__main__":
    main()
