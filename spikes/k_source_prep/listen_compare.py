"""Listening page: two sidecar runs side by side (old classic transcribers vs MuScriptor).

    spikes/j_evals/env.sh amt python spikes/k_source_prep/listen_compare.py

Pairs: real voice notes out-k/real vs out-k/real_muscriptor, synthetic phone clips out-k/synth vs
out-k/synth_muscriptor (make them with run.sh / run_synth.py). Writes
$LATTICE_BIGDISK/out-k/listen_compare/<clip>/ and index.html (file://; one player at a time):
  00_input        the recording
  truth           the true notes (synthetic clips)
  <run>_all / _ab every stem together; _ab = render left, input right
  <run>_<stem>    each stem alone
Everything renders as GM piano (drums as a GM kit), like renders.py, so only the notes differ.
"""
import json
import os
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf

from renders import SR, ab, piano, render

K = Path(os.environ["LATTICE_BIGDISK"]) / "out-k"
TRUTH = Path(os.environ["LATTICE_OUT"]) / "amt" / "synth" / "truth"
DEST = K / "listen_compare"
PAIRS = [("real", "real_muscriptor"), ("synth", "synth_muscriptor")]
LABEL = {"real": "old", "synth": "old", "real_muscriptor": "new", "synth_muscriptor": "new"}


def stems_line(m):
    return "; ".join(f"{s['name']} {s['transcriber']} {s['notes_count']}" for s in m["stems"]) + f" ({m['content']})"


def main():
    html = ["<!doctype html><meta charset='utf-8'><title>Sidecar A/B</title>",
            "<style>body{font:14px system-ui;margin:16px;background:#fff;color:#111}td{padding:2px 12px 2px 0;vertical-align:middle}"
            "audio{height:32px;width:380px}h2{margin-top:28px}.n{color:#555;font-size:12px}</style>",
            "<p><b>old</b> = the sidecar with basic-pitch / pyin; <b>new</b> = the same sidecar with MuScriptor medium. "
            "All renders are GM piano (drums: GM kit), so only the notes differ. <b>_ab</b>: render in the left ear, input in the right. "
            "Synthetic clips also have the true notes. Playing one pauses the others.</p>"]
    for old, new in PAIRS:
        clips = sorted(p.name for p in (K / new).iterdir() if (p / "manifest.json").exists())
        for clip in clips:
            if not (K / old / clip / "manifest.json").exists():
                continue
            d = DEST / clip
            d.mkdir(parents=True, exist_ok=True)
            y, _ = sf.read(K / new / clip / "input.wav", dtype="float32")
            secs = len(y) / SR
            sf.write(d / "00_input.wav", y, SR)
            rows = [("00_input", "")]
            if (TRUTH / f"{clip}.mid").exists():
                sf.write(d / "truth.wav", render(piano(pretty_midi.PrettyMIDI(str(TRUTH / f"{clip}.mid"))), secs), SR)
                rows.append(("truth", ""))
            for run in (old, new):
                m = json.loads((K / run / clip / "manifest.json").read_text())
                lab = LABEL[run]
                both = pretty_midi.PrettyMIDI()
                per = []
                for s in m["stems"]:
                    pm = piano(pretty_midi.PrettyMIDI(str(K / run / clip / s["midi"])))
                    both.instruments += pm.instruments
                    if len(m["stems"]) > 1:
                        sf.write(d / f"{lab}_{s['name']}.wav", render(pm, secs), SR)
                        per.append((f"{lab}_{s['name']}", f"{s['transcriber']}, {s['notes_count']} notes"))
                r = render(both, secs) if m["stems"] else np.zeros(int(secs * SR), np.float32)
                sf.write(d / f"{lab}_all.wav", r, SR)
                sf.write(d / f"{lab}_ab.wav", ab(r, y), SR)
                rows += [(f"{lab}_all", stems_line(m)), (f"{lab}_ab", "")] + per
            html.append(f"<h2>{clip}</h2><table>")
            html += [f"<tr><td>{n}</td><td><audio controls preload='none' src='{clip}/{n}.wav'></audio></td><td class='n'>{t}</td></tr>"
                     for n, t in rows]
            html.append("</table>")
            print(clip, flush=True)
    html.append("<script>document.addEventListener('play',e=>{for(const a of document.querySelectorAll('audio'))if(a!==e.target)a.pause()},true)</script>")
    (DEST / "index.html").write_text("\n".join(html))
    print(f"file://{DEST}/index.html")


if __name__ == "__main__":
    main()
