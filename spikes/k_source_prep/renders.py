"""Listening renders for sidecar outputs (real voice notes have no ground truth).

    spikes/j_evals/env.sh amt python spikes/k_source_prep/renders.py <run_dir> [<run_dir> ...]

For each run dir (a prep.py output with manifest.json) writes $LATTICE_BIGDISK/out-k/listen/<name>/:
  input.wav                   the (mono, normalised) input
  <stem>.mid / <stem>.wav     cleaned MIDI and its render (GM piano for pitched stems, GM kit for drums)
  <stem>.raw.wav              render of the raw transcription, before cleanup
  all.wav                     every cleaned stem together
  ab__<stem>.wav / ab__all.wav  render on the left, input on the right
  stems/                      the separated stems
  notes.txt                   what came out (from the manifest)
"""
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("j_listen", HERE.parent / "j_evals" / "listen.py")
_jl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_jl)
SR, render = _jl.SR, _jl.render  # TinySoundFont + TimGM6mb

OUT = Path(os.environ["LATTICE_BIGDISK"]) / "out-k" / "listen"


def piano(pm):
    for i in pm.instruments:
        if not i.is_drum:
            i.program = 0
    return pm


def ab(r, y):
    n = min(len(r), len(y))
    return np.stack([r[:n], 0.8 * y[:n] / max(np.abs(y).max(), 1e-9)], axis=1)


def main(*runs):
    for run in map(Path, runs):
        m = json.loads((run / "manifest.json").read_text())
        dest = OUT / run.name
        (dest / "stems").mkdir(parents=True, exist_ok=True)
        y, _ = sf.read(run / "input.wav", dtype="float32")
        sf.write(dest / "input.wav", y, SR)
        secs = len(y) / SR
        both = pretty_midi.PrettyMIDI()
        lines = [f"{m['input']}: content {m['content']}, tempo {m['tempo']}, key {(m['key'] or {}).get('name')}",
                 f"warnings: {m['warnings']}"]
        for s in m["stems"]:
            pm = piano(pretty_midi.PrettyMIDI(str(run / s["midi"])))
            shutil.copy(run / s["midi"], dest / f"{s['name']}.mid")
            r = render(pm, secs)
            sf.write(dest / f"{s['name']}.wav", r, SR)
            sf.write(dest / f"ab__{s['name']}.wav", ab(r, y), SR)
            sf.write(dest / f"{s['name']}.raw.wav", render(piano(pretty_midi.PrettyMIDI(str(run / s["raw_midi"]))), secs), SR)
            both.instruments += pm.instruments
            src = run / s["audio"]
            if src.exists() and src.name != "input.wav":
                shutil.copy(src, dest / "stems" / src.name)
            lines.append(f"- {s['name']}: {s['transcriber']}, {s['raw_notes']} raw -> {s['notes_count']} notes, range {s['range']}, "
                         f"conf {s['confidence']}{', ' + str(s['drum_classes']) if s.get('drum_classes') else ''}")
        if m["stems"]:
            r = render(both, secs)
            sf.write(dest / "all.wav", r, SR)
            sf.write(dest / "ab__all.wav", ab(r, y), SR)
        (dest / "notes.txt").write_text("\n".join(lines) + "\n")
        print("\n".join(lines), flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
