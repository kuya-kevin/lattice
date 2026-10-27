"""Engineer tools: drum quantize and trim (no model involved).

quantize: find hits, fit a grid (tempo + phase) to them, then slice the audio at each
hit and move each slice toward its nearest grid line by `strength` (0 = untouched,
1 = on the grid). Slices are moved, not stretched, so hits keep their sound; short
fades hide the cuts. This is what Logic's "Flex slicing" does.

trim: cut leading/trailing silence, keeping a little padding.

    uv run python f_engineer/quantize.py <in.wav> <out.wav> [grid=16] [strength=1.0] [bpm]
"""
import sys

import librosa
import numpy as np
import soundfile as sf

FADE_S = 0.004


def hits(y, sr, with_strength=False, min_strength=0.25):
    """Hit start times (s), backtracked to the quiet point just before each attack.
    Hits weaker than min_strength x the median hit (ringing, double triggers) are dropped."""
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=128)
    peaks = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=128, units="frames")
    starts = librosa.onset.onset_backtrack(peaks, env)
    strength = env[peaks]
    keep = strength >= min_strength * np.median(strength) if len(peaks) else np.array([], bool)
    times = librosa.frames_to_time(starts[keep], sr=sr, hop_length=128)
    return (times, strength[keep]) if with_strength else times


def fit_grid(times, bpm, grid=16, weights=None):
    """Grid step (s) and the phase that puts the hits closest to grid lines (strong hits count more)."""
    step = 60.0 / bpm * 4 / grid
    w = np.ones_like(times) if weights is None else weights
    phases = np.linspace(0, step, 400, endpoint=False)
    cost = [np.sum(w * np.abs(((times - p + step / 2) % step) - step / 2)) for p in phases]
    return step, float(phases[int(np.argmin(cost))])


def refine_bpm(times, bpm, grid=16, weights=None, spread=0.04):
    """Beat trackers are often ~1% off, which drifts across a loop; search nearby tempos."""
    best = None
    for b in np.linspace(bpm * (1 - spread), bpm * (1 + spread), 81):
        step, phase = fit_grid(times, b, grid, weights)
        w = np.ones_like(times) if weights is None else weights
        cost = np.sum(w * np.abs(((times - phase + step / 2) % step) - step / 2)) / step
        if best is None or cost < best[0]:
            best = (cost, float(b))
    return best[1]


def snap(times, step, phase, strength=1.0):
    target = phase + np.round((times - phase) / step) * step
    return times + strength * (target - times)


def deviation_ms(times, step, phase):
    return 1000 * np.abs(((times - phase + step / 2) % step) - step / 2)


def move_slices(y, sr, starts, new_starts):
    """Cut y at `starts` and place each slice at its new start, with short fades."""
    out = np.zeros(len(y) + sr, dtype=y.dtype)
    fade = int(FADE_S * sr)
    bounds = list((starts * sr).astype(int)) + [len(y)]
    if bounds[0] > 0:  # audio before the first hit stays where it is
        out[: bounds[0]] += y[: bounds[0]]
    for i, new in enumerate(new_starts):
        a, b = bounds[i], bounds[i + 1]
        seg = y[a:b].copy()
        if len(seg) > 2 * fade:
            seg[:fade] *= np.linspace(0, 1, fade)
            seg[-fade:] *= np.linspace(1, 0, fade)
        n = max(int(round(new * sr)), 0)
        out[n : n + len(seg)] += seg[: len(out) - n]
    return out[: len(y)]


def quantize(y, sr, grid=16, strength=1.0, bpm=None):
    t, w = hits(y, sr, with_strength=True)
    if bpm is None:
        bpm = refine_bpm(t, float(np.atleast_1d(librosa.beat.beat_track(y=y, sr=sr)[0])[0]), grid, w)
    step, phase = fit_grid(t, bpm, grid, w)
    new = snap(t, step, phase, strength)
    return move_slices(y, sr, t, new), {"bpm": bpm, "grid": grid, "hits": len(t), "step_s": step, "phase_s": phase,
                                         "before_ms": deviation_ms(t, step, phase), "times": t, "new_times": new}


def trim(y, sr, top_db=40, pad_s=0.05):
    """Cut leading/trailing silence (quieter than top_db below the peak), keep pad_s either side."""
    _, (a, b) = librosa.effects.trim(y, top_db=top_db)
    pad = int(pad_s * sr)
    a, b = max(a - pad, 0), min(b + pad, len(y))
    return y[a:b], (a / sr, b / sr)


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    grid = int(sys.argv[3]) if len(sys.argv) > 3 else 16
    strength = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    bpm = float(sys.argv[5]) if len(sys.argv) > 5 else None
    y, sr = sf.read(src)
    y = y.mean(axis=1) if y.ndim > 1 else y
    q, info = quantize(y, sr, grid, strength, bpm)
    after = deviation_ms(hits(q, sr), info["step_s"], info["phase_s"])
    sf.write(dst, q, sr)
    print(f"{info['hits']} hits at {info['bpm']:.1f} BPM, 1/{grid} grid: off-grid {np.median(info['before_ms']):.1f} ms median before,"
          f" {np.median(after):.1f} ms after (strength {strength})")
