"""Transcribers used by the router. Each returns a list of cleanup.Note with a confidence 0-1.

- pyin (librosa, ISC): monophonic; conf = mean voiced probability of the note's frames.
- basic-pitch (Spotify, Apache-2.0, ONNX on CPU): polyphonic; conf = note amplitude.
- bytedance_piano (Kong et al.): opt-in only, the repo has no licence file.
- YourMT3+ (treated as GPL-3.0): never imported; run as a separate process in its own env,
  only when enabled and >= 14 GB of VRAM is free (see prep.py).
"""
from __future__ import annotations

import logging
import os
import subprocess

import librosa
import numpy as np
import scipy.signal

from cleanup import Note

if not hasattr(scipy.signal, "gaussian"):  # basic-pitch 0.4 uses the pre-1.13 scipy name
    scipy.signal.gaussian = scipy.signal.windows.gaussian
logging.getLogger().setLevel(logging.ERROR)


def pyin(y: np.ndarray, sr: int, fmin: float = 55, fmax: float = 1400, hop: int = 256) -> list[Note]:
    if sr != 22050:
        y, sr = librosa.resample(y, orig_sr=sr, target_sr=22050), 22050
    f0, voiced, prob = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr, frame_length=2048, hop_length=hop)
    midi = np.where(voiced, librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0)), np.nan)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0][: len(midi)]
    r95 = np.percentile(rms, 95) + 1e-9
    rounded = np.round(midi)
    dt = hop / sr
    notes: list[Note] = []
    start = cur = None

    def close(i):
        if start is not None and (i - start) * dt >= 0.05:
            seg = midi[start:i]
            vel = int(np.clip(30 + 90 * np.mean(rms[start:i]) / r95, 20, 127))
            notes.append(Note(int(np.round(np.nanmedian(seg))), start * dt, i * dt, vel, float(np.nanmean(prob[start:i]))))

    for i, r in enumerate(rounded):
        if np.isnan(r):
            close(i)
            start = cur = None
        elif cur is None or abs(r - cur) >= 1:
            # tolerate a one-frame wobble: only split when the new pitch holds 3 frames
            if cur is not None and i + 2 < len(rounded) and not np.all(rounded[i : i + 3] == r):
                continue
            close(i)
            start, cur = i, r
    close(len(rounded))
    return notes


_BP = None


def basic_pitch(path: str) -> list[Note]:
    global _BP
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import Model, predict
    if _BP is None:
        _BP = Model(ICASSP_2022_MODEL_PATH)
    _, _, events = predict(path, _BP)
    return [Note(int(p), float(s), float(e), int(np.clip(a * 127, 1, 127)), float(a)) for s, e, p, a, _ in events]


def bytedance_piano(path: str) -> list[Note]:
    from pathlib import Path

    import torch
    from piano_transcription_inference import PianoTranscription, sample_rate
    ckpt = Path(os.environ["TORCH_HOME"]) / "piano_transcription" / "note_F1=0.9677_pedal_F1=0.9186.pth"
    t = PianoTranscription(device="cuda" if torch.cuda.is_available() else "cpu", checkpoint_path=str(ckpt))
    y, _ = librosa.load(path, sr=sample_rate, mono=True)
    tmp = Path(os.environ.get("TMPDIR", "/tmp")) / f"bd_{os.getpid()}.mid"
    out = t.transcribe(y, str(tmp))
    return [Note(int(n["midi_note"]), float(n["onset_time"]), float(n["offset_time"]), int(n["velocity"]), float(n["velocity"]) / 127)
            for n in out["est_note_events"]]


def free_vram_mb() -> int:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        return int(out.stdout.strip().splitlines()[0])
    except Exception:
        return 0
