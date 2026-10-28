"""Spike M, step 3: listening page for the cleanup variants.

    spikes/j_evals/env.sh amt python spikes/m_cleanup_models/listen.py

For the 4 real voice notes and the first synthetic clip of each category, one table per clip,
one row per variant: the cleaned audio as the sidecar saw it (runs/<variant>/<clip>/input.wav,
loudness-matched to -20 LUFS so louder doesn't sound better) and a GM piano render of its MIDI
(all stems; drums as a GM kit), so the notes can be judged too. Synthetic clips also get the clean
render before the phone degradation and the true notes. Each row has a rating (good / ok / bad)
kept in the browser; "Copy ratings" puts them on the clipboard as JSON.
Writes $LATTICE_BIGDISK/out-m/listen/<clip>/*.wav and index.html (file://, one player at a time).
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import pretty_midi
import pyloudnorm as pyln
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "k_source_prep"))
from renders import SR, piano, render  # noqa: E402

BIG = Path(os.environ["LATTICE_BIGDISK"])
OUT = BIG / "out-m"
EVALS = Path(os.environ["LATTICE_OUT"]) / "amt" / "synth"
DEST = OUT / "listen"
ORDER = ["raw", "gate", "nr", "mr_denoise", "mr_dereverb", "mr_both"]
ABOUT = {"raw": "no cleanup", "gate": "prep.py --denoise (built-in spectral gate)", "nr": "noisereduce, stationary",
         "mr_denoise": "Mel-RoFormer denoise (aufr33)", "mr_dereverb": "Mel-RoFormer dereverb (anvuew)",
         "mr_both": "denoise, then dereverb"}
METER = pyln.Meter(SR)


def lufs(y, target=-20.0):
    y = np.asarray(y, np.float32)
    loud = METER.integrated_loudness(y)
    if not np.isfinite(loud):
        return y
    y = y * 10 ** ((target - loud) / 20)
    return y / max(1.0, float(np.abs(y).max()) / 0.99)


def scores():
    recs = {}
    log = OUT / "score.log"
    for line in log.read_text().splitlines() if log.exists() else []:
        r = json.loads(line)
        if r.get("status") == "ok":
            recs[(r["variant"], r["clip"])] = r
    return recs


def main():
    recs = scores()
    runs = OUT / "runs"
    clips = sorted({c.name for v in runs.iterdir() for c in v.iterdir()})
    clips = [c for c in clips if c.startswith("real_")] + [c for c in clips if c.endswith("_0") and not c.startswith("real_")]
    html = ["<!doctype html><meta charset='utf-8'><title>Cleanup A/B</title>",
            "<style>body{font:14px system-ui;margin:16px;background:#fff;color:#111}td{padding:3px 12px 3px 0;vertical-align:middle}"
            "audio{height:32px;width:300px}h2{margin-top:28px}.n{color:#555;font-size:12px}label{margin-right:6px}</style>",
            "<h1>Cleanup before audio to MIDI</h1>",
            "<p><b>cleaned</b>: what the sidecar heard, loudness-matched (-20 LUFS). <b>MIDI</b>: GM piano render of the notes it wrote. "
            "F1 is note F1 against the true notes (synthetic clips only). Playing one pauses the others. "
            "Rate the <i>cleaned</i> audio per row; ratings stay in this browser.</p>",
            "<p><button id='copy'>Copy ratings</button> <span id='msg' class='n'></span></p>"]
    for clip in clips:
        d = DEST / clip
        d.mkdir(parents=True, exist_ok=True)
        html.append(f"<h2>{clip}</h2><table><tr class='n'><td></td><td>cleaned</td><td>MIDI</td><td>F1</td><td>rating</td><td></td></tr>")
        secs = None
        if not clip.startswith("real_"):
            clean = EVALS / "audio" / f"{clip}__clean.wav"
            y, sr = sf.read(clean, dtype="float32")
            y = y.mean(axis=1) if y.ndim > 1 else y
            secs = len(y) / sr
            sf.write(d / "studio.wav", lufs(y), sr)
            sf.write(d / "truth.wav", render(piano(pretty_midi.PrettyMIDI(str(EVALS / "truth" / f"{clip}.mid"))), secs), SR)
            html.append(f"<tr><td>before phone</td><td><audio controls preload='none' src='{clip}/studio.wav'></audio></td>"
                        f"<td><audio controls preload='none' src='{clip}/truth.wav'></audio></td><td></td><td></td>"
                        "<td class='n'>clean render / true notes</td></tr>")
        for v in ORDER:
            run = runs / v / clip
            if not (run / "manifest.json").exists():
                continue
            m = json.loads((run / "manifest.json").read_text())
            y, _ = sf.read(run / "input.wav", dtype="float32")
            s = secs or len(y) / SR
            sf.write(d / f"{v}.wav", lufs(y), SR)
            both = pretty_midi.PrettyMIDI()
            for st in m["stems"]:
                both.instruments += piano(pretty_midi.PrettyMIDI(str(run / st["midi"]))).instruments
            sf.write(d / f"{v}_midi.wav", render(both, s) if m["stems"] else np.zeros(int(s * SR), np.float32), SR)
            r = recs.get((v, clip), {})
            f = "; ".join(f"{k} {x['f1']:.2f}" for k, x in r.get("stems", {}).items() if "f1" in x)
            stems = ", ".join(f"{st['name']} {st['transcriber']} {st['notes_count']}" for st in m["stems"])
            radios = "".join(f"<label><input type='radio' name='{clip}|{v}' value='{g}'>{g}</label>" for g in ("good", "ok", "bad"))
            html.append(f"<tr><td>{v}</td><td><audio controls preload='none' src='{clip}/{v}.wav'></audio></td>"
                        f"<td><audio controls preload='none' src='{clip}/{v}_midi.wav'></audio></td><td>{f}</td><td>{radios}</td>"
                        f"<td class='n'>{ABOUT[v]}; {stems} ({m['content']})</td></tr>")
        html.append("</table>")
        print(clip, flush=True)
    html.append("""<script>
document.addEventListener('play',e=>{for(const a of document.querySelectorAll('audio'))if(a!==e.target)a.pause()},true);
const KEY='lattice-cleanup-ratings';let saved={};try{saved=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
for(const r of document.querySelectorAll('input[type=radio]')){if(saved[r.name]===r.value)r.checked=true;
  r.addEventListener('change',()=>{saved[r.name]=r.value;try{localStorage.setItem(KEY,JSON.stringify(saved))}catch(e){}})}
document.getElementById('copy').onclick=async()=>{const t=JSON.stringify(saved,null,1);
  try{await navigator.clipboard.writeText(t);document.getElementById('msg').textContent='copied '+Object.keys(saved).length+' ratings'}
  catch(e){prompt('Copy:',t)}};
</script>""")
    (DEST / "index.html").write_text("\n".join(html))
    print(f"file://{DEST}/index.html")


if __name__ == "__main__":
    main()
