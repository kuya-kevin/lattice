"""Audio -> MIDI baselines in the amt env: basic-pitch, basic-pitch + blip filter, pyin, ByteDance piano.

    spikes/j_evals/env.sh amt python spikes/j_evals/transcribe.py jobs.json <system> [<system> ...]

jobs.json: {"<id>": "<wav path>"}. Writes $LATTICE_OUT/amt/pred/<system>/<id>.mid and
$LATTICE_OUT/amt/pred/<system>/timing.json (merged across runs).
Systems: basic_pitch, basic_pitch_clean (spikes/i_to_midi filter: >= 80 ms, velocity >= 30),
pyin (monophonic: librosa pyin, frames grouped into notes), bytedance_piano (Kong et al. 2021).
"""
import json
import logging
import os
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import pretty_midi
import scipy.signal
import soundfile as sf
import torch

if not hasattr(scipy.signal, "gaussian"):  # basic-pitch 0.4 uses the pre-1.13 scipy name
    scipy.signal.gaussian = scipy.signal.windows.gaussian

logging.getLogger().setLevel(logging.ERROR)
OUT = Path(os.environ["LATTICE_OUT"]) / "amt" / "pred"
PIANO_CKPT = Path(os.environ["TORCH_HOME"]) / "piano_transcription" / "note_F1=0.9677_pedal_F1=0.9186.pth"


def to_pm(notes, program=0, name="transcription"):
    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=program, name=name)
    inst.notes = [pretty_midi.Note(velocity=int(v), pitch=int(p), start=float(s), end=float(e)) for p, s, e, v in notes]
    pm.instruments.append(inst)
    return pm


class BasicPitch:
    def __init__(self, clean=False):
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model, predict
        self.model, self.predict, self.clean = Model(ICASSP_2022_MODEL_PATH), predict, clean

    def __call__(self, path):
        _, pm, _ = self.predict(path, self.model)
        if self.clean:
            for inst in pm.instruments:
                inst.notes = [n for n in inst.notes if n.end - n.start >= 0.08 and n.velocity >= 30]
        return pm


class Pyin:
    def __call__(self, path, sr=22050, hop=256):
        y, _ = librosa.load(path, sr=sr, mono=True)
        f0, voiced, _ = librosa.pyin(y, fmin=55, fmax=1400, sr=sr, frame_length=2048, hop_length=hop)
        midi = np.where(voiced, librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0)), np.nan)
        rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0][: len(midi)]
        notes, start, cur = [], None, None
        rounded = np.round(midi)
        dt = hop / sr

        def close(i):
            if start is not None and (i - start) * dt >= 0.08:
                seg = midi[start:i]
                vel = np.clip(40 + 600 * np.mean(rms[start:i]), 30, 120)
                notes.append((int(np.round(np.nanmedian(seg))), start * dt, i * dt, vel))

        for i, r in enumerate(rounded):
            if np.isnan(r):
                close(i)
                start, cur = None, None
            elif cur is None or abs(r - cur) >= 1:
                # tolerate one-frame wobble: only split if the new pitch holds 3 frames
                if cur is not None and i + 2 < len(rounded) and not np.all(rounded[i : i + 3] == r):
                    continue
                close(i)
                start, cur = i, r
        close(len(rounded))
        return to_pm(notes)


class ByteDancePiano:
    def __init__(self):
        from piano_transcription_inference import PianoTranscription, sample_rate
        self.sr = sample_rate
        self.t = PianoTranscription(device="cuda", checkpoint_path=str(PIANO_CKPT))

    def __call__(self, path):
        y, _ = librosa.load(path, sr=self.sr, mono=True)
        tmp = Path(os.environ.get("TMPDIR", "/tmp")) / "bd_tmp.mid"
        out = self.t.transcribe(y, str(tmp))
        notes = [(n["midi_note"], n["onset_time"], n["offset_time"], n["velocity"]) for n in out["est_note_events"]]
        return to_pm(notes)


SYSTEMS = {"basic_pitch": lambda: BasicPitch(), "basic_pitch_clean": lambda: BasicPitch(clean=True),
           "pyin": Pyin, "bytedance_piano": ByteDancePiano}


def main(jobs_file, *systems):
    jobs = json.loads(Path(jobs_file).read_text())
    for name in systems:
        t0 = time.time()
        model = SYSTEMS[name]()
        load_s = time.time() - t0
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        dest = OUT / name
        dest.mkdir(parents=True, exist_ok=True)
        files, audio_s, run_s = {}, 0.0, 0.0
        for cid, path in jobs.items():
            t = time.time()
            pm = model(path)
            took = time.time() - t
            pm.write(str(dest / f"{cid}.mid"))
            dur = sf.info(path).duration
            audio_s += dur
            run_s += took
            files[cid] = {"audio_s": round(dur, 2), "seconds": round(took, 2), "notes": sum(len(i.notes) for i in pm.instruments)}
        tf = dest / "timing.json"
        prev = json.loads(tf.read_text())["files"] if tf.exists() else {}
        prev.update(files)
        summary = {"load_s": round(load_s, 1), "audio_s": round(audio_s, 1), "seconds": round(run_s, 1),
                   "rtf": round(run_s / max(audio_s, 1e-9), 4),
                   "peak_vram_mb_torch": round(torch.cuda.max_memory_allocated() / 2**20) if torch.cuda.is_available() else 0,
                   "files": prev}
        tf.write_text(json.dumps(summary, indent=2))
        print(name, {k: v for k, v in summary.items() if k != "files"}, flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
