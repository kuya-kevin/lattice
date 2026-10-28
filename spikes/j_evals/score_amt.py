"""Note F1 (mir_eval, onset +-50 ms, pitch +-50 cents, offsets ignored) on the synthetic set.

    spikes/j_evals/env.sh amt python spikes/j_evals/score_amt.py

Reads truth from $LATTICE_OUT/amt/synth/truth, predictions from $LATTICE_OUT/amt/pred/<system>/:
- direct:   <system>/<clip>__<clean|phone>.mid
- on stems: <system>/<sepmodel>--<clip>__phone--<stem>.mid (from stems.json, see run_stems.py)
Scores
- single-part clips (hum, bass, keys): all predicted non-drum notes vs the part;
- layered clips, whole mix: all notes vs all parts ("all"), and for YourMT3 per part by its
  instrument label (YourMT3, MuScriptor; singing/voice -> hum, programs 32-39 -> bass, rest -> keys);
- layered clips via separation: the stem's notes vs the matching part.
Also a pitch-class F1 (octave errors forgiven). Writes $LATTICE_OUT/amt/f1.json and f1.md.
"""
import json
import os
from collections import defaultdict
from pathlib import Path

import mir_eval
import numpy as np
import pretty_midi

ROOT = Path(os.environ["LATTICE_OUT"]) / "amt"
PRED = ROOT / "pred"
TRUTH = ROOT / "synth" / "truth"
SYSTEMS = ["basic_pitch", "basic_pitch_clean", "pyin", "bytedance_piano", "yourmt3",
           "muscriptor_small", "muscriptor_medium", "muscriptor_large"]
LABELLED = {"yourmt3", "muscriptor_small", "muscriptor_medium", "muscriptor_large"}  # name their instruments
STEM_FOR_PART = {"hum": ["vocals"], "bass": ["bass"], "keys": ["piano"]}


def arrays(notes, fold=False):
    if not notes:
        return np.zeros((0, 2)), np.zeros(0)
    iv = np.array([[n.start, max(n.end, n.start + 0.01)] for n in notes])
    p = np.array([n.pitch for n in notes], dtype=float)
    if fold:
        p = 60 + p % 12
    return iv, librosa_midi_to_hz(p)


def librosa_midi_to_hz(m):
    return 440.0 * 2 ** ((np.asarray(m) - 69) / 12)


def f1(ref, est, fold=False):
    ri, rp = arrays(ref, fold)
    ei, ep = arrays(est, fold)
    if len(rp) == 0 or len(ep) == 0:
        return {"p": 0.0, "r": 0.0, "f": 0.0, "n_est": len(ep)}
    p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=0.05, offset_ratio=None)
    return {"p": p, "r": r, "f": f, "n_est": len(ep)}


def part_of(inst):
    name = inst.name.lower()
    if any(k in name for k in ("sing", "voice", "vocal", "choir")) or 52 <= inst.program <= 54:
        return "hum"
    if 32 <= inst.program <= 39:
        return "bass"
    return "keys"


def load(path):
    if not path.exists():
        return None
    return pretty_midi.PrettyMIDI(str(path))


def notes_of(pm, part=None):
    out = []
    for inst in pm.instruments:
        if inst.is_drum or (part and part_of(inst) != part):
            continue
        out += inst.notes
    return out


def main():
    rows = defaultdict(list)  # (setting, system) -> list of (f, f_pc)
    detail = []
    for tf in sorted(TRUTH.glob("*.mid")):
        clip = tf.stem
        cat = clip.split("_")[0]
        truth = pretty_midi.PrettyMIDI(str(tf))
        parts = {i.name: i.notes for i in truth.instruments}
        all_truth = [n for ns in parts.values() for n in ns]
        for cond in ("clean", "phone"):
            for sysname in SYSTEMS:
                pm = load(PRED / sysname / f"{clip}__{cond}.mid")
                if pm is None:
                    continue
                if cat != "layered":
                    s, spc = f1(all_truth, notes_of(pm)), f1(all_truth, notes_of(pm), fold=True)
                    rows[(f"{cat} {cond}", sysname)].append((s["f"], spc["f"]))
                    detail.append({"clip": clip, "cond": cond, "system": sysname, "part": cat, **s, "f_pitch_class": spc["f"]})
                else:
                    s, spc = f1(all_truth, notes_of(pm)), f1(all_truth, notes_of(pm), fold=True)
                    rows[(f"layered {cond} mix->all parts", sysname)].append((s["f"], spc["f"]))
                    detail.append({"clip": clip, "cond": cond, "system": sysname, "part": "all", **s, "f_pitch_class": spc["f"]})
                    if sysname in LABELLED:
                        for part, ref in parts.items():
                            s = f1(ref, notes_of(pm, part))
                            spc = f1(ref, notes_of(pm, part), fold=True)
                            rows[(f"layered {cond} mix->{part} (instrument label)", sysname)].append((s["f"], spc["f"]))
            if cond != "phone":
                continue
            # via separation stems
            for sysname in SYSTEMS:
                for sep in ("mel_roformer", "bs_roformer", "htdemucs_6s"):
                    for part, ref in parts.items():
                        for stem in STEM_FOR_PART[part]:
                            pm = load(PRED / sysname / f"{sep}--{clip}__phone--{stem}.mid")
                            if pm is None:
                                continue
                            s, spc = f1(ref, notes_of(pm)), f1(ref, notes_of(pm), fold=True)
                            label = f"{cat} phone {sep}:{stem} -> {part}" if cat == "layered" else f"hum phone {sep}:{stem} (denoise)"
                            rows[(label, sysname)].append((s["f"], spc["f"]))
                            detail.append({"clip": clip, "cond": "phone", "sep": f"{sep}:{stem}", "system": sysname, "part": part, **s, "f_pitch_class": spc["f"]})
    table = defaultdict(dict)
    for (setting, sysname), vals in rows.items():
        v = np.array(vals)
        table[setting][sysname] = {"f1": round(float(v[:, 0].mean()), 3), "f1_pitch_class": round(float(v[:, 1].mean()), 3), "n": len(v)}
    (ROOT / "f1.json").write_text(json.dumps({"table": table, "detail": detail}, indent=1, default=float))
    lines = ["| setting | " + " | ".join(SYSTEMS) + " |", "|---|" + "---|" * len(SYSTEMS)]
    for setting in sorted(table):
        cells = []
        for s in SYSTEMS:
            c = table[setting].get(s)
            cells.append(f"{c['f1']:.2f} ({c['f1_pitch_class']:.2f})" if c else "")
        lines.append(f"| {setting} | " + " | ".join(cells) + " |")
    md = "Note F1, onset +-50 ms (pitch-class F1 in brackets), mean over 4 clips\n\n" + "\n".join(lines)
    (ROOT / "f1.md").write_text(md + "\n")
    print(md)


if __name__ == "__main__":
    main()
