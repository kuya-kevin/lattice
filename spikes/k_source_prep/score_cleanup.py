"""Note F1 before / after cleanup on the j_evals synthetic phone set (mir_eval, onset +-50 ms).

    spikes/j_evals/env.sh amt python spikes/k_source_prep/score_cleanup.py [sidecar run names...]

A. Cleanup applied to yesterday's raw predictions ($LATTICE_OUT/amt/pred/<system>/), phone clips
   and the separated stems, for each transcriber:
     raw | clean (no quantize) | clean + 1/16 quantize at the estimated tempo | ... at the true tempo
B. The full sidecar (router + cleanup) on the 16 phone clips, read from
   $LATTICE_BIGDISK/out-k/<run>/<clip>/manifest.json for each run name given (default: synth;
   make them with run_synth.py): raw vs cleaned per stem, scored against the matching part.
Writes $LATTICE_BIGDISK/out-k/cleanup_f1.{json,md}.
"""
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pretty_midi

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "j_evals"))
import cleanup as C  # noqa: E402
from score_amt import f1  # noqa: E402  (mir_eval wrapper, same settings as yesterday)

EVALS = Path(os.environ["LATTICE_OUT"])
OUTK = Path(os.environ["LATTICE_BIGDISK"]) / "out-k"
PRED = EVALS / "amt" / "pred"
TRUTH = EVALS / "amt" / "synth" / "truth"
MAN = {m["id"]: m for m in json.loads((EVALS / "amt" / "synth" / "manifest.json").read_text())}
SYSTEMS = ["basic_pitch", "pyin", "bytedance_piano", "yourmt3", "muscriptor_medium"]
ROLE = {"hum": "melody", "bass": "bass", "keys": "keys"}
STEM = {"hum": ("mel_roformer", "vocals"), "bass": ("htdemucs_6s", "bass"), "keys": ("htdemucs_6s", "piano")}
VARIANTS = ["raw", "clean", "clean+q(est)", "clean+q(true)"]


def pm_notes(path, system):
    pm = pretty_midi.PrettyMIDI(str(path))
    out = []
    for i in pm.instruments:
        if i.is_drum:
            continue
        for n in i.notes:
            conf = 1.0 if system in ("pyin", "yourmt3") else n.velocity / 127
            out.append(C.Note(n.pitch, n.start, n.end, n.velocity, conf))
    return out


def as_pm(notes):
    return [pretty_midi.Note(velocity=int(n.velocity), pitch=int(n.pitch), start=n.start, end=n.end) for n in notes]


def variants(notes, role, bpm):
    yield "raw", notes
    yield "clean", C.clean(notes, C.CleanupOptions(role=role, quantize=None)).notes
    yield "clean+q(est)", C.clean(notes, C.CleanupOptions(role=role)).notes
    yield "clean+q(true)", C.clean(notes, C.CleanupOptions(role=role, bpm=bpm)).notes


def score_sidecar(mf, clip, cat, bpm, parts, rows, tempo_err):
    if not mf.exists():
        return
    m = json.loads(mf.read_text())
    if m.get("tempo"):
        b = m["tempo"]["bpm"]
        ratio = min([abs(b * k / bpm - 1) for k in (0.5, 1, 2, 2 / 3, 1.5)])
        tempo_err.append({"clip": clip, "true": bpm, "est": b, "rel_err_mod_octave": round(ratio, 4), "conf": m["tempo"].get("confidence")})
    stem_part = {"melody": "hum", "bass": "bass", "keys": "keys", "piano": "keys", "guitar": "keys"}
    used = set()
    for s in m["stems"]:
        part = cat if cat != "layered" else stem_part.get(s["name"])
        if part not in parts or (cat == "layered" and part in used):
            continue
        used.add(part)
        ref = parts[part]
        raw = pretty_midi.PrettyMIDI(str(mf.parent / s["raw_midi"])).instruments[0].notes
        cl = pretty_midi.PrettyMIDI(str(mf.parent / s["midi"])).instruments[0].notes
        label = f"{cat} -> {part}" if cat == "layered" else cat
        rows[("B", label, f"{m['content']}:{s['transcriber']}", "raw")].append(f1(ref, raw)["f"])
        rows[("B", label, f"{m['content']}:{s['transcriber']}", "clean+q(est)")].append(f1(ref, cl)["f"])
        # same cleanup at the true tempo, from the raw notes
        raw_n = [C.Note(n.pitch, n.start, n.end, n.velocity, n.velocity / 127 if s["transcriber"] != "pyin" else 1.0) for n in raw]
        role = s["role"]
        rows[("B", label, f"{m['content']}:{s['transcriber']}", "clean")].append(f1(ref, as_pm(C.clean(raw_n, C.CleanupOptions(role=role, quantize=None)).notes))["f"])
        rows[("B", label, f"{m['content']}:{s['transcriber']}", "clean+q(true)")].append(f1(ref, as_pm(C.clean(raw_n, C.CleanupOptions(role=role, bpm=bpm)).notes))["f"])


def main():
    rows = defaultdict(list)
    tempo_err = []
    for tf in sorted(TRUTH.glob("*.mid")):
        clip = tf.stem
        cat, bpm = clip.split("_")[0], MAN[clip]["bpm"]
        parts = {i.name: i.notes for i in pretty_midi.PrettyMIDI(str(tf)).instruments}
        # --- A. yesterday's predictions
        for system in SYSTEMS:
            jobs = []
            if cat != "layered":
                jobs.append((f"{cat} phone, direct", PRED / system / f"{clip}__phone.mid", ROLE[cat], parts[cat]))
                if cat == "hum":
                    jobs.append(("hum phone, mel_roformer:vocals", PRED / system / f"mel_roformer--{clip}__phone--vocals.mid", "melody", parts["hum"]))
            else:
                for part, (sep, stem) in STEM.items():
                    jobs.append((f"layered phone, {sep}:{stem} -> {part}", PRED / system / f"{sep}--{clip}__phone--{stem}.mid", ROLE[part], parts[part]))
            for label, path, role, ref in jobs:
                if not path.exists():
                    continue
                notes = pm_notes(path, system)
                for v, ns in variants(notes, role, bpm):
                    rows[("A", label, system, v)].append(f1(ref, as_pm(ns))["f"])
        # --- B. the sidecar
        for run in sys.argv[1:] or ["synth"]:
            score_sidecar(OUTK / run / clip / "manifest.json", clip, cat, bpm, parts, rows, tempo_err)

    table = defaultdict(dict)
    for (sec, label, system, v), vals in rows.items():
        table[(sec, label, system)][v] = (round(float(np.mean(vals)), 3), len(vals))
    lines = ["Note F1 (onset +-50 ms, offsets ignored), mean over clips (n). q = 1/16 quantize.", "",
             "| part | setting | transcriber | " + " | ".join(VARIANTS) + " | n |", "|---|---|---|" + "---|" * (len(VARIANTS) + 1)]
    for (sec, label, system) in sorted(table):
        c = table[(sec, label, system)]
        n = max(x[1] for x in c.values())
        lines.append(f"| {sec} | {label} | {system} | " + " | ".join(f"{c[v][0]:.2f}" if v in c else "" for v in VARIANTS) + f" | {n} |")
    if tempo_err:
        lines += ["", "Tempo estimate vs truth (error after allowing x2, x1/2, x3/2, x2/3):", "",
                  "| clip | true | est | rel. error | conf |", "|---|---|---|---|---|"]
        lines += [f"| {t['clip']} | {t['true']} | {t['est']} | {t['rel_err_mod_octave']} | {t['conf']} |" for t in tempo_err]
    md = "\n".join(lines) + "\n"
    OUTK.mkdir(parents=True, exist_ok=True)
    (OUTK / "cleanup_f1.md").write_text(md)
    (OUTK / "cleanup_f1.json").write_text(json.dumps({"|".join(k): v for k, v in table.items()} | {"tempo": tempo_err}, indent=1))
    print(md)


if __name__ == "__main__":
    main()
