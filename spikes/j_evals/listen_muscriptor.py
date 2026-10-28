"""Listening page: MuScriptor next to the current sidecar (k_source_prep router) and the input.

    spikes/j_evals/env.sh amt python spikes/j_evals/listen_muscriptor.py

Writes $LATTICE_OUT/listen_amt/<clip>/ and $LATTICE_OUT/listen_amt/index.html (open it with
file://; starting one player pauses the others). Per clip:
  00_input.wav                    the recording
  truth.wav                       GM render of the true notes (synthetic layered clips only)
  router.wav / router_ab.wav      the sidecar's render from <bigdisk>/out-k/listen (real notes)
  muscriptor_<size>.wav / _ab.wav GM render of MuScriptor's MIDI; _ab = render left, input right
Renders use listen.py's TinySoundFont GM synth, so MuScriptor's instrument labels are audible.
"""
import json
import os
import shutil
from pathlib import Path

import librosa
import numpy as np
import pretty_midi
import soundfile as sf

from listen import SR, describe, render

OUT = Path(os.environ["LATTICE_OUT"])
PRED = OUT / "amt" / "pred"
ROUTER = Path(os.environ["LATTICE_BIGDISK"]) / "out-k" / "listen"
DEST = OUT / "listen_amt"
SIZES = ["small", "medium", "large"]
SYNTH = [f"layered_{i}__phone" for i in range(4)]


def ab(r, y):
    n = min(len(r), len(y))
    return np.stack([r[:n], 0.8 * y[:n] / max(np.abs(y).max(), 1e-9)], axis=1)


def main():
    real = {k: v for k, v in json.loads((OUT / "inputs_real.json").read_text()).items() if k.startswith("vn_")}
    synth = json.loads((OUT / "inputs_synth.json").read_text())
    clips = [(c, real[c]) for c in real] + [(c, synth[c]) for c in SYNTH]
    html = ["<!doctype html><meta charset='utf-8'><title>MuScriptor A/B</title>",
            "<style>body{font:14px system-ui;margin:16px;background:#fff;color:#111}td{padding:2px 12px 2px 0;vertical-align:middle}"
            "audio{height:32px;width:380px}h2{margin-top:28px}.n{color:#555;font-size:12px}</style>",
            "<p>Each MIDI is rendered with the same GM SoundFont. <b>_ab</b> files: render in the left ear, input in the right. "
            "Router = the current sidecar (k_source_prep). Synthetic clips have a render of the true notes. Playing one pauses the others.</p>"]
    for clip, path in clips:
        d = DEST / clip
        d.mkdir(parents=True, exist_ok=True)
        y, _ = librosa.load(path, sr=SR, mono=True)
        sf.write(d / "00_input.wav", y, SR)
        rows = [("00_input", "")]
        tf = OUT / "amt" / "synth" / "truth" / f"{clip.split('__')[0]}.mid"
        if clip in SYNTH and tf.exists():
            pm = pretty_midi.PrettyMIDI(str(tf))
            sf.write(d / "truth.wav", render(pm, len(y) / SR), SR)
            rows.append(("truth", f"{describe(pm)['notes']} notes"))
        if (ROUTER / clip / "all.wav").exists():
            shutil.copy(ROUTER / clip / "all.wav", d / "router.wav")
            shutil.copy(ROUTER / clip / "ab__all.wav", d / "router_ab.wav")
            rows += [("router", (ROUTER / clip / "notes.txt").read_text().splitlines()[0].split(":", 1)[-1][:90]), ("router_ab", "")]
        for size in SIZES:
            mid = PRED / f"muscriptor_{size}" / f"{clip}.mid"
            if not mid.exists():
                continue
            pm = pretty_midi.PrettyMIDI(str(mid))
            r = render(pm, len(y) / SR)
            sf.write(d / f"muscriptor_{size}.wav", r, SR)
            sf.write(d / f"muscriptor_{size}_ab.wav", ab(r, y), SR)
            s = describe(pm)
            shutil.copy(mid, d / f"muscriptor_{size}.mid")
            rows += [(f"muscriptor_{size}", f"{s['notes']} notes, {s['drum_hits']} drum hits; {', '.join(s['instruments'])}"),
                     (f"muscriptor_{size}_ab", "")]
        html.append(f"<h2>{clip}</h2><table>")
        html += [f"<tr><td>{name}</td><td><audio controls preload='none' src='{clip}/{name}.wav'></audio></td>"
                 f"<td class='n'>{note}</td></tr>" for name, note in rows]
        html.append("</table>")
        print(clip, [r[0] for r in rows], flush=True)
    html.append("<script>document.addEventListener('play',e=>{for(const a of document.querySelectorAll('audio'))if(a!==e.target)a.pause()},true)</script>")
    (DEST / "index.html").write_text("\n".join(html))
    print(f"file://{DEST}/index.html")


if __name__ == "__main__":
    main()
