"""Spike M, step 2: the sidecar (k_source_prep/prep.py) on every cleaned variant, note F1 per part.

    spikes/j_evals/env.sh amt python spikes/m_cleanup_models/score.py [--pilot] [prep.py options]

Variants are the folders clean.py wrote under $LATTICE_BIGDISK/out-m/audio/, plus "gate", which is
raw audio with prep.py's own --denoise (its built-in spectral gate). Default prep options:
--transcriber classic (basic-pitch / pyin; MuScriptor is not set up on every machine); pass
--transcriber muscriptor to score with the app's default. Synthetic clips are scored against
their truth MIDI (mir_eval, onset 50 ms, as j_evals/score_amt.py); real voice notes are only run,
for listen.py. Writes $LATTICE_BIGDISK/out-m/runs/<variant>/<clip>/ (prep output),
out-m/score.log (one JSON line per run; reruns skip what is logged ok) and out-m/f1.{json,md}.
--true-mode passes each synthetic clip's category as --mode (skips the router's content guess, so
only the cleanup's effect on transcription is left), for the variants raw, gate, nr, mr_denoise;
outputs get a _mode suffix (runs_mode/, score_mode.log, f1_mode.{json,md}).
"""
import json
import os
import sys
import time
import traceback
from collections import defaultdict
from pathlib import Path

import numpy as np
import pretty_midi

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "k_source_prep"))
sys.path.insert(0, str(HERE.parent / "j_evals"))
import prep  # noqa: E402
from score_amt import f1  # noqa: E402

BIG = Path(os.environ["LATTICE_BIGDISK"])
OUT = BIG / "out-m"
TRUTH = Path(os.environ["LATTICE_OUT"]) / "amt" / "synth" / "truth"
PART = {"melody": "hum", "bass": "bass", "keys": "keys"}
ORDER = ["raw", "gate", "nr", "mr_denoise", "mr_dereverb", "mr_both"]
CATS = ["hum", "bass", "keys", "layered"]


SUFFIX = "_mode" if "--true-mode" in sys.argv else ""


def jobs(pilot):
    audio = OUT / "audio"
    variants = [v for v in ORDER if v == "gate" or (audio / v).is_dir()]
    clips = sorted(p.stem for p in (audio / "raw").glob("*.wav"))
    if SUFFIX:
        variants = [v for v in variants if v in ("raw", "gate", "nr", "mr_denoise")]
        clips = [c for c in clips if not c.startswith("real_")]
    if pilot:
        clips = clips[:1]
    return [(v, c) for v in variants for c in clips]


def run_one(variant, clip, extra):
    src = OUT / "audio" / ("raw" if variant == "gate" else variant) / f"{clip}.wav"
    dest = OUT / f"runs{SUFFIX}" / variant / clip
    mode = ["--mode", clip.split("_")[0]] if SUFFIX else []
    args = [str(src), str(dest), "--transcriber", "classic", *mode, *extra, *(["--denoise"] if variant == "gate" else [])]
    m = prep.run(str(src), str(dest), prep.parse(args))
    rec = {"variant": variant, "clip": clip, "content": m["content"], "warnings": m["warnings"], "stems": {}}
    truth = TRUTH / f"{clip}.mid"
    parts = {i.name: i.notes for i in pretty_midi.PrettyMIDI(str(truth)).instruments} if truth.exists() else {}
    cat = clip.split("_")[0]
    for s in m["stems"]:
        part = cat if cat != "layered" else PART.get(s["name"])
        inst = pretty_midi.PrettyMIDI(str(dest / s["midi"])).instruments
        notes = inst[0].notes if inst else []  # a stem with no notes writes a MIDI file with no instrument
        rec["stems"][s["name"]] = {"transcriber": s["transcriber"], "notes": len(notes),
                                   **({"f1": round(f1(parts[part], notes)["f"], 3)} if part in parts else {})}
    return rec


def clip_f1(rec):
    """One number per synthetic clip: its scored stems' F1 (layered: mean over hum/bass/keys, a missing part = 0)."""
    cat = rec["clip"].split("_")[0]
    if cat not in CATS:
        return None
    f = {k: v["f1"] for k, v in rec["stems"].items() if "f1" in v}
    if cat == "layered":
        return float(np.mean([f.get(s, 0.0) for s in ("melody", "bass", "keys")]))
    return max(f.values(), default=0.0)


def report(recs):
    by = defaultdict(lambda: defaultdict(list))
    secs = defaultdict(list)
    for r in recs:
        v = clip_f1(r)
        if v is not None:
            by[r["variant"]][r["clip"].split("_")[0]].append(v)
            secs[r["variant"]].append(r["secs"])
    clean_s = defaultdict(float)
    audio_s = defaultdict(float)
    log = OUT / "clean.log"
    for line in log.read_text().splitlines() if log.exists() else []:
        c = json.loads(line)
        clean_s[c["variant"]] += c["secs"]
        audio_s[c["variant"]] += c["audio_s"]
    rows, table = [], {}
    rows.append("| variant | " + " | ".join(CATS) + " | all 16 | cleanup RTF |")
    rows.append("|---" * (len(CATS) + 3) + "|")
    for v in ORDER:
        if v not in by:
            continue
        cats = {c: float(np.mean(by[v][c])) if by[v][c] else None for c in CATS}
        allv = float(np.mean([x for c in CATS for x in by[v][c]]))
        rtf = clean_s[v] / audio_s[v] if audio_s[v] else None
        if v == "mr_both" and rtf is not None and audio_s["mr_denoise"]:  # clean.py reused the denoise pass
            rtf += clean_s["mr_denoise"] / audio_s["mr_denoise"]
        table[v] = {**cats, "all": allv, "n": sum(len(by[v][c]) for c in CATS), "cleanup_rtf": rtf}
        cell = lambda x: "-" if x is None else f"{x:.2f}"
        rows.append(f"| {v} | " + " | ".join(cell(cats[c]) for c in CATS) + f" | **{allv:.2f}** | {cell(rtf)} |")
    (OUT / f"f1{SUFFIX}.json").write_text(json.dumps(table, indent=1))
    (OUT / f"f1{SUFFIX}.md").write_text("Note F1 (onset 50 ms) per category, mean over 4 clips each. Layered = mean of hum/bass/keys.\n"
                               "RTF = cleanup seconds per audio second (mr_both counts both models).\n\n" + "\n".join(rows) + "\n")
    print("\n".join(rows))


def main():
    rest = sys.argv[1:]
    pilot = "--pilot" in rest
    rest = [a for a in rest if a not in ("--pilot", "--true-mode")]
    log = OUT / f"score{SUFFIX}.log"
    seen = {}
    for line in log.read_text().splitlines() if log.exists() else []:
        r = json.loads(line)
        if r.get("status") == "ok":
            seen[(r["variant"], r["clip"])] = r
    for variant, clip in jobs(pilot):
        if (variant, clip) in seen:
            continue
        t = time.time()
        try:
            rec = run_one(variant, clip, rest) | {"status": "ok"}
        except Exception as e:
            rec = {"variant": variant, "clip": clip, "status": "fail", "error": f"{type(e).__name__}: {str(e)[:300]}"}
            traceback.print_exc()
        rec["secs"] = round(time.time() - t, 1)
        with log.open("a") as fh:
            fh.write(json.dumps(rec) + "\n")
        print(json.dumps(rec), flush=True)
        if rec["status"] != "ok":
            sys.exit(1)
        seen[(variant, clip)] = rec
    report(list(seen.values()))


if __name__ == "__main__":
    main()
