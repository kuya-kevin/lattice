"""Listening package for the real material: MIDI + GM renders + the input, side by side.

    spikes/j_evals/env.sh amt python spikes/j_evals/listen.py

For each real clip writes $LATTICE_OUT/listen/<clip>/:
  input.wav                          the recording (copy)
  <system>.mid / <system>.wav        direct transcription and its TinySoundFont GM render
  <sep>-<stem>__<system>.mid / .wav  transcription of a separated stem
  stems/<sep>-<stem>.wav             the stems themselves (copies)
  mix__<system>.wav                  render (left) against the input (right), for A/B
and $LATTICE_OUT/listen/summary.json: notes, pitch range, instruments per output.
"""
import json
import os
import shutil
from pathlib import Path

import librosa
import numpy as np
import pretty_midi
import soundfile as sf
import tinysoundfont

OUT = Path(os.environ["LATTICE_OUT"])
PRED = OUT / "amt" / "pred"
SF2 = Path(pretty_midi.__file__).parent / "TimGM6mb.sf2"
SR = 44100
SYSTEMS = ["basic_pitch_clean", "pyin", "bytedance_piano", "yourmt3"]


def render(pm, seconds):
    synth = tinysoundfont.Synth(samplerate=SR)
    sfid = synth.sfload(str(SF2))
    events = []
    for ch, inst in enumerate(pm.instruments[:15]):
        chan = 9 if inst.is_drum else (ch if ch < 9 else ch + 1)
        synth.program_select(chan, sfid, 128 if inst.is_drum else 0, 0 if inst.is_drum else inst.program, is_drums=inst.is_drum)
        for n in inst.notes:
            events += [(n.start, 1, chan, n.pitch, n.velocity), (n.end, 0, chan, n.pitch, 0)]
    events.sort(key=lambda e: (e[0], e[1]))
    total = int((seconds + 0.5) * SR)
    out, pos = np.zeros((total, 2), np.float32), 0
    for t, on, chan, p, v in events + [(total / SR, -1, 0, 0, 0)]:
        stop = min(int(t * SR), total)
        if stop > pos:
            out[pos:stop] = np.frombuffer(synth.generate(stop - pos), dtype=np.float32).reshape(-1, 2)
            pos = stop
        if on == 1:
            synth.noteon(chan, p, v)
        elif on == 0:
            synth.noteoff(chan, p)
    y = out.mean(axis=1)
    return 0.8 * y / max(np.abs(y).max(), 1e-9)


def describe(pm):
    notes = [n for i in pm.instruments if not i.is_drum for n in i.notes]
    drums = sum(len(i.notes) for i in pm.instruments if i.is_drum)
    d = {"notes": len(notes), "drum_hits": drums,
         "instruments": sorted({i.name or pretty_midi.program_to_instrument_name(i.program) for i in pm.instruments})}
    if notes:
        d["range"] = [pretty_midi.note_number_to_name(min(n.pitch for n in notes)), pretty_midi.note_number_to_name(max(n.pitch for n in notes))]
    return d


def emit(dest, name, mid, y_in, summary):
    pm = pretty_midi.PrettyMIDI(str(mid))
    shutil.copy(mid, dest / f"{name}.mid")
    seconds = len(y_in) / SR
    r = render(pm, seconds)
    sf.write(dest / f"{name}.wav", r, SR)
    n = min(len(r), len(y_in))
    ab = np.stack([r[:n], 0.8 * y_in[:n] / max(np.abs(y_in).max(), 1e-9)], axis=1)
    sf.write(dest / f"mix__{name}.wav", ab, SR)
    summary[name] = describe(pm)


def main():
    real = json.loads((OUT / "inputs_real.json").read_text())
    stems = json.loads((OUT / "stems_real.json").read_text())
    all_summary = {}
    for clip, path in real.items():
        dest = OUT / "listen" / clip
        (dest / "stems").mkdir(parents=True, exist_ok=True)
        y_in, _ = librosa.load(path, sr=SR, mono=True)
        sf.write(dest / "input.wav", y_in, SR)
        summary = {}
        for s in SYSTEMS:
            mid = PRED / s / f"{clip}.mid"
            if mid.exists():
                emit(dest, s, mid, y_in, summary)
        for key, stem_path in stems.items():
            sep, c, stem = key.split("--")
            if c != clip:
                continue
            shutil.copy(stem_path, dest / "stems" / f"{sep}-{stem}.wav")
            for s in ("basic_pitch_clean", "yourmt3"):
                mid = PRED / s / f"{key}.mid"
                if mid.exists():
                    emit(dest, f"{sep}-{stem}__{s}", mid, y_in, summary)
        all_summary[clip] = summary
        print(clip, {k: (v["notes"], v["drum_hits"]) for k, v in summary.items() if "__" not in k}, flush=True)
    (OUT / "listen" / "summary.json").write_text(json.dumps(all_summary, indent=1))


if __name__ == "__main__":
    main()
