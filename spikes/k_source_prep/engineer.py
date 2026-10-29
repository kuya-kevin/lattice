"""Engineer sidecar (B3): noise cleanup and drum quantize on one source, called by the app.
Also two analyses that write no audio: the hit list for slice_drums and the sound regions for
find_sound (B13).

    LATTICE_BIGDISK=<bigdisk> spikes/k_source_prep/run_engineer.sh cleanup  <in.wav> <out.wav> [--method auto|model|nr]
    LATTICE_BIGDISK=<bigdisk> spikes/k_source_prep/run_engineer.sh quantize <in.wav> <out.wav> --bpm 120 --grid 16 \
        [--strength 1] [--phase 0]
    LATTICE_BIGDISK=<bigdisk> spikes/k_source_prep/run_engineer.sh hits <in.wav>
    LATTICE_BIGDISK=<bigdisk> spikes/k_source_prep/run_engineer.sh regions <in.wav>

Writes <out.wav> (mono, the input's sample rate and length, so the app's clip offsets still
hold) and prints one line `RESULT <json>`. Runs in the j_evals `sep` env.

cleanup: Mel-RoFormer denoise (aufr33, via audio-separator; the default, preferred by ear in
  spikes/m_cleanup_models) or noisereduce stationary with a profile from the quietest 0.5 s
  (the fallback when the model isn't installed or fails). The result says which ran and why.
quantize: f_engineer/quantize.py (slice at hits, move each slice toward the grid, no stretch).
  --phase puts the grid where the app's bars are (source seconds of a grid line); without
  it the phase is fitted to the hits.
hits: drums.py slice_points (one entry per hit: time in source seconds, kind kick/snare/hat).
  No output file; the RESULT line carries the list.
regions: where there is sound (sound_regions). No output file.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "f_engineer"))
from quantize import deviation_ms, fit_grid, hits, move_slices, snap  # noqa: E402

from drums import slice_points  # noqa: E402

MODEL_SR = 44100
DENOISE = "denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt"  # keep the "dry" stem


def read_mono(path: str) -> tuple[np.ndarray, int]:
    y, sr = sf.read(path, dtype="float32", always_2d=True)
    return y.mean(axis=1), sr


def fit_length(y: np.ndarray, n: int) -> np.ndarray:
    return y[:n] if len(y) >= n else np.pad(y, (0, n - len(y)))


def quietest_window(y: np.ndarray, sr: int, seconds=0.5) -> np.ndarray:
    w = min(int(seconds * sr), len(y))
    hop = max(w // 4, 1)
    energy = [np.mean(y[i : i + w] ** 2) for i in range(0, max(len(y) - w, 1), hop)]
    start = int(np.argmin(energy)) * hop
    return y[start : start + w]


def db(x: np.ndarray) -> float:
    return float(10 * np.log10(np.mean(x.astype(np.float64) ** 2) + 1e-12))


def floor_db(y: np.ndarray, sr: int) -> float:
    """Level of the quietest 0.5 s: the noise you hear between phrases."""
    return db(quietest_window(y, sr))


def denoise_model(y: np.ndarray, sr: int) -> np.ndarray:
    import imageio_ffmpeg  # audio-separator shells out to ffmpeg; use the static one (as m_cleanup_models)
    import librosa
    from audio_separator.separator import Separator

    weights = Path(os.environ["LATTICE_BIGDISK"]) / "models" / "audio-separator"
    if not (weights / DENOISE).exists():
        raise FileNotFoundError(f"{DENOISE} not in {weights}")
    tmp = Path(tempfile.mkdtemp(dir=os.environ.get("TMPDIR")))
    try:
        (tmp / "bin").mkdir()
        (tmp / "bin" / "ffmpeg").symlink_to(imageio_ffmpeg.get_ffmpeg_exe())
        os.environ["PATH"] = f"{tmp / 'bin'}:{os.environ['PATH']}"
        x = librosa.resample(y, orig_sr=sr, target_sr=MODEL_SR) if sr != MODEL_SR else y
        stereo = tmp / "in.wav"  # Roformer configs expect 2 channels
        sf.write(stereo, np.stack([x, x], axis=1), MODEL_SR)
        sep = Separator(output_dir=str(tmp), model_file_dir=str(weights), output_format="WAV", log_level=30)
        sep.load_model(model_filename=DENOISE)
        outs = [tmp / Path(o).name for o in sep.separate(str(stereo))]
        dry = [o for o in outs if "_(dry)_" in o.name.lower()]
        if len(dry) != 1:
            raise RuntimeError(f"can't find the dry stem in {[o.name for o in outs]}")
        d, dsr = read_mono(str(dry[0]))
        d = librosa.resample(d, orig_sr=dsr, target_sr=sr) if dsr != sr else d
        return fit_length(d, len(y))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def denoise_nr(y: np.ndarray, sr: int) -> np.ndarray:
    import noisereduce as nr

    # freq_mask_smooth_hz: the default 500 Hz smears the mask across harmonics and took 6-7 dB
    # off a 220 Hz tone in test_engineer.py; 100 Hz loses < 1 dB and still drops the floor ~22 dB.
    out = nr.reduce_noise(y=y, sr=sr, stationary=True, y_noise=quietest_window(y, sr), prop_decrease=1.0, freq_mask_smooth_hz=100)
    return fit_length(out.astype(np.float32), len(y))


def cleanup(y: np.ndarray, sr: int, method="auto") -> tuple[np.ndarray, dict]:
    t = time.time()
    fallback = None
    if method in ("auto", "model"):
        try:
            out, used = denoise_model(y, sr), "Mel-RoFormer denoise"
        except Exception as e:  # noqa: BLE001 - any model failure falls back, and the result says why
            if method == "model":
                raise
            fallback = f"{type(e).__name__}: {e}"[:300]
            out, used = denoise_nr(y, sr), "noisereduce (fallback)"
    else:
        out, used = denoise_nr(y, sr), "noisereduce"
    info = {
        "method": used,
        "noise_floor_db": {"before": round(floor_db(y, sr), 1), "after": round(floor_db(out, sr), 1)},
        "level_change_db": round(db(out) - db(y), 2),  # how much of the performance's level changed
        "seconds": round(time.time() - t, 1),
    }
    if fallback:
        info["fallback_reason"] = fallback
    return out, info


def sound_regions(y: np.ndarray, sr: int, gap: float = 0.25) -> tuple[list[list[float]], float]:
    """Stretches with sound (source seconds; gaps under `gap` s bridged), and the threshold used, in
    dB below the loudest 46 ms. Silence is anything under the quietest 0.5 s + 10 dB, kept within
    -50..-30 dB: a phone recording's room noise sits 40-50 dB down and is not sound, and a
    recording with no quiet part (the floor is the music) still only loses what is 30 dB down."""
    import librosa

    hop, n = 256, 1024
    rms = librosa.feature.rms(y=y, frame_length=n, hop_length=hop)[0]
    rel = 20 * np.log10(rms + 1e-9) - 20 * np.log10(rms.max() + 1e-9)
    w = max(1, int(0.5 * sr / hop))
    floor = float(10 * np.log10(np.convolve(10 ** (rel / 10), np.ones(w) / w, mode="valid").min() + 1e-12)) if len(rel) >= w else -120.0
    top_db = float(min(50.0, max(30.0, -(floor + 10))))
    out: list[list[float]] = []
    for a, b in librosa.effects.split(y, top_db=top_db, frame_length=n, hop_length=hop):
        a, b = a / sr, b / sr
        if out and a - out[-1][1] < gap:
            out[-1][1] = b
        else:
            out.append([a, b])
    return [[round(float(a), 3), round(float(b), 3)] for a, b in out], round(-top_db, 1)


def quantize(y: np.ndarray, sr: int, bpm: float, grid=16, strength=1.0, phase: float | None = None) -> tuple[np.ndarray, dict]:
    t, w = hits(y, sr, with_strength=True)
    if not len(t):
        return y.copy(), {"hits": 0, "moved": 0, "max_shift_ms": 0.0, "bpm": bpm, "grid": grid}
    step = 60.0 / bpm * 4 / grid
    phase = fit_grid(t, bpm, grid, w)[1] if phase is None else phase % step
    new = snap(t, step, phase, strength)
    out = fit_length(move_slices(y, sr, t, new), len(y))
    shift = 1000 * np.abs(new - t)
    after = hits(out, sr)
    return out, {
        "hits": int(len(t)),
        "moved": int(np.sum(shift > 1.0)),
        "max_shift_ms": round(float(shift.max()), 1),
        "off_grid_ms": {  # median distance from the nearest grid line, before and after
            "before": round(float(np.median(deviation_ms(t, step, phase))), 1),
            "after": round(float(np.median(deviation_ms(after, step, phase))), 1) if len(after) else None,
        },
        "bpm": bpm,
        "grid": grid,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("op", choices=["cleanup", "quantize", "hits", "regions"])
    ap.add_argument("src")
    ap.add_argument("dst", nargs="?")
    ap.add_argument("--method", choices=["auto", "model", "nr"], default="auto")
    ap.add_argument("--bpm", type=float)
    ap.add_argument("--grid", type=int, default=16)
    ap.add_argument("--strength", type=float, default=1.0)
    ap.add_argument("--phase", type=float)
    a = ap.parse_args(argv)
    y, sr = read_mono(a.src)
    if a.op == "hits":
        pts = slice_points(y, sr)
        print("RESULT " + json.dumps({"hits": pts, "sample_rate": sr, "duration": round(len(y) / sr, 3)}), flush=True)
        return
    if a.op == "regions":
        regions, threshold = sound_regions(y, sr)
        print("RESULT " + json.dumps({"regions": regions, "threshold_db": threshold, "duration": round(len(y) / sr, 3)}), flush=True)
        return
    if not a.dst:
        ap.error(f"{a.op} needs an output path")
    if a.op == "cleanup":
        out, info = cleanup(y, sr, a.method)
    else:
        if not a.bpm:
            ap.error("quantize needs --bpm")
        out, info = quantize(y, sr, a.bpm, a.grid, min(max(a.strength, 0.0), 1.0), a.phase)
    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    if peak > 1.0:  # slices overlapping after a move can sum past full scale
        out = out / peak
        info["normalized_from_peak"] = round(peak, 3)
    Path(a.dst).parent.mkdir(parents=True, exist_ok=True)
    sf.write(a.dst, out.astype(np.float32), sr, subtype="FLOAT")
    info |= {"sample_rate": sr, "duration": round(len(out) / sr, 3)}
    print("RESULT " + json.dumps(info), flush=True)


if __name__ == "__main__":
    main()
