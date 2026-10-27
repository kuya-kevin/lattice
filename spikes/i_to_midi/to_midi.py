"""Audio -> MIDI with a key-aware cleanup proposal ("doesn't have to be perfect").

1. basic-pitch transcribes (polyphonic; fine for piano).
2. Drop blips (very short or very quiet notes).
3. Detect the key (Krumhansl-Schmuckler on duration-weighted pitch classes).
4. Propose: rare out-of-key notes (likely mistakes) snapped to the nearest scale tone;
   out-of-key notes played often (borrowed chords, leading tones) are kept. Starts quantized to
   a 1/16 grid at the detected tempo. Both raw and proposed MIDI are written, plus
   quick sine renders to listen to.

Runs in envs/basicpitch:
    ../envs/basicpitch/.venv/bin/python i_to_midi/to_midi.py <in.wav> <out_dir>
"""
import json
import sys
from pathlib import Path

import librosa
import numpy as np
import pretty_midi
import soundfile as sf
from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import predict

NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
SCALE = {"major": [0, 2, 4, 5, 7, 9, 11], "minor": [0, 2, 3, 5, 7, 8, 10]}


def detect_key(notes):
    hist = np.zeros(12)
    for n in notes:
        hist[n.pitch % 12] += (n.end - n.start) * n.velocity
    scores = []
    for tonic in range(12):
        for mode, prof in (("major", MAJOR), ("minor", MINOR)):
            scores.append((np.corrcoef(hist, np.roll(prof, tonic))[0, 1], tonic, mode))
    scores.sort(reverse=True)
    best, second = scores[0], scores[1]
    return {"tonic": NAMES[best[1]], "tonic_pc": best[1], "mode": best[2], "r": round(float(best[0]), 3),
            "runner_up": f"{NAMES[second[1]]} {second[2]} (r {second[0]:.3f})"}


def snap_to_key(pitch, tonic_pc, mode):
    allowed = {(tonic_pc + s) % 12 for s in SCALE[mode]}
    if pitch % 12 in allowed:
        return pitch
    for d in (-1, 1, -2, 2):  # nearest scale tone, prefer down
        if (pitch + d) % 12 in allowed:
            return pitch + d
    return pitch


def render(pm, sr=22050):
    """Plain decaying sine per note, just to hear pitches and timing."""
    y = np.zeros(int((pm.get_end_time() + 1) * sr))
    for n in pm.instruments[0].notes:
        t = np.arange(int((n.end - n.start + 0.3) * sr)) / sr
        f = librosa.midi_to_hz(n.pitch)
        tone = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * np.exp(-t * 3) * (n.velocity / 127)
        a = int(n.start * sr)
        y[a : a + len(tone)] += tone[: len(y) - a]
    return 0.8 * y / max(np.abs(y).max(), 1e-9)


def main(src, out_dir, min_dur=0.08, min_vel=30, rare=0.05):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(src).stem
    _, pm, _ = predict(src, ICASSP_2022_MODEL_PATH)
    raw = pm.instruments[0].notes
    kept = [n for n in raw if n.end - n.start >= min_dur and n.velocity >= min_vel]
    key = detect_key(kept)

    y, sr = librosa.load(src, sr=22050, mono=True)
    bpm = float(np.atleast_1d(librosa.beat.beat_track(y=y, sr=sr)[0])[0])
    step = 60 / bpm / 4

    proposed = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    inst = pretty_midi.Instrument(program=0, name=f"proposal in {key['tonic']} {key['mode']}")
    share = np.bincount([n.pitch % 12 for n in kept], minlength=12) / max(len(kept), 1)
    snapped = 0
    for n in kept:
        p = snap_to_key(n.pitch, key["tonic_pc"], key["mode"]) if share[n.pitch % 12] < rare else n.pitch
        snapped += p != n.pitch
        start = round(n.start / step) * step
        end = max(round(n.end / step) * step, start + step)
        inst.notes.append(pretty_midi.Note(velocity=n.velocity, pitch=p, start=start, end=end))
    proposed.instruments.append(inst)

    clean = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    clean.instruments.append(pretty_midi.Instrument(program=0, name="raw transcription"))
    clean.instruments[0].notes = list(raw)

    clean.write(str(out / f"{stem}_raw.mid"))
    proposed.write(str(out / f"{stem}_proposal.mid"))
    sf.write(out / f"{stem}_raw_preview.wav", render(clean), 22050)
    sf.write(out / f"{stem}_proposal_preview.wav", render(proposed), 22050)

    pcs = np.bincount([n.pitch % 12 for n in kept], minlength=12)
    report = {"notes_raw": len(raw), "notes_kept": len(kept), "snapped_to_key": int(snapped), "bpm": round(bpm, 1),
              "key": key, "pitch_classes": {NAMES[i]: int(c) for i, c in enumerate(pcs) if c},
              "range": [pretty_midi.note_number_to_name(min(n.pitch for n in kept)), pretty_midi.note_number_to_name(max(n.pitch for n in kept))]}
    (out / f"{stem}_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
