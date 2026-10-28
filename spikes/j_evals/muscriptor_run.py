"""MuScriptor (MIT code, CC BY-NC 4.0 weights) on the synthetic set and the real voice notes.

    spikes/j_evals/env.sh muscriptor python spikes/j_evals/muscriptor_run.py <synth|stems|real> \
        [--sizes small,medium,large] [--pilot] [--keep-going]

stems = the separated phone stems the router uses (Mel-RoFormer vocals, htdemucs_6s bass and piano;
from $LATTICE_OUT/stems_synth.json), scored against the matching part.
Writes $LATTICE_OUT/amt/pred/muscriptor_<size>/<clip>.mid (the names score_amt.py reads) and
appends one JSON line per job to $LATTICE_OUT/amt/muscriptor_progress.log (`tail -f` it):
size, clip, seconds of audio, status, wall time, real-time factor, peak VRAM, notes, instruments,
and for synth clips the note F1 against all parts (same mir_eval settings as score_amt.py).
Greedy decoding sometimes emits no notes at all on a hummed clip (every chunk ends at once);
an empty result is retried once with classifier-free guidance 3 (CFG_RETRY), logged as "retry".
Clips that already have a non-empty MIDI are skipped unless --redo.
Clips run longest first. --pilot runs only the longest clip per size. Stops on the first crash, or
when more than a quarter of a size's clips come back empty (one empty clip is a result, scored 0),
unless --keep-going. One model load per size; each size is freed before the next.
"""
import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

import pretty_midi
import soundfile as sf
import torch
from muscriptor import TranscriptionModel

sys.path.insert(0, str(Path(__file__).resolve().parent))
from score_amt import f1, notes_of  # noqa: E402

OUT = Path(os.environ["LATTICE_OUT"])
AMT = OUT / "amt"
LOG = AMT / "muscriptor_progress.log"
CFG_RETRY = 3.0
STEMS = {"mel_roformer:vocals", "htdemucs_6s:bass", "htdemucs_6s:piano"}
STEMS_PART = {"vocals": "hum", "bass": "bass", "piano": "keys"}


def jobs_for(which):
    if which == "stems":
        src = {k: v for k, v in json.loads((OUT / "stems_synth.json").read_text()).items()
               if k.split("--")[0] + ":" + k.split("--")[2] in STEMS}
    else:
        src = json.loads((OUT / f"inputs_{which}.json").read_text())
    if which == "real":
        src = {k: v for k, v in src.items() if k.startswith("vn_")}
    dur = {k: sf.info(v).duration for k, v in src.items()}
    return sorted(((k, v, dur[k]) for k, v in src.items()), key=lambda j: -j[2])


def truth_notes(clip):
    if "--" in clip:  # stem: only the matching part
        _, clip, stem = clip.split("--")
        part = STEMS_PART[stem]
    else:
        part = None
    tf = AMT / "synth" / "truth" / f"{clip.split('__')[0]}.mid"
    if not tf.exists():
        return None
    return [n for i in pretty_midi.PrettyMIDI(str(tf)).instruments if part in (None, i.name) for n in i.notes]


def log(rec):
    line = json.dumps(rec)
    with LOG.open("a") as fh:
        fh.write(line + "\n")
    print(line, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("which", choices=["synth", "stems", "real"])
    ap.add_argument("--sizes", default="small,medium,large")
    ap.add_argument("--pilot", action="store_true")
    ap.add_argument("--keep-going", action="store_true")
    ap.add_argument("--redo", action="store_true")
    a = ap.parse_args()
    jobs = jobs_for(a.which)
    if a.pilot:
        jobs = jobs[:1]
    print(f"log: {LOG}", flush=True)
    failed = False
    for size in a.sizes.split(","):
        dest = AMT / "pred" / f"muscriptor_{size}"
        dest.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        torch.cuda.reset_peak_memory_stats()
        try:
            model = TranscriptionModel.load_model(size, device="cuda")
        except Exception as e:
            log({"size": size, "clip": "(load)", "status": "fail", "error": f"{type(e).__name__}: {str(e)[:300]}"})
            sys.exit(1)
        log({"size": size, "clip": "(load)", "status": "ok", "secs": round(time.time() - t0, 1),
             "vram_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)})
        empties = 0
        for clip, path, dur in jobs:
            out = dest / f"{clip}.mid"
            if not a.redo and out.exists() and any(i.notes for i in pretty_midi.PrettyMIDI(str(out)).instruments):
                continue
            torch.cuda.reset_peak_memory_stats()
            t0 = time.time()
            rec = {"size": size, "set": a.which, "clip": clip, "audio_s": round(dur, 1)}
            try:
                midi, _ = model.transcribe_and_postprocess(path, detect_tempo=False)
                out.write_bytes(midi)
                pm = pretty_midi.PrettyMIDI(str(out))
                n = sum(len(i.notes) for i in pm.instruments)
                if not n:
                    midi, _ = model.transcribe_and_postprocess(path, detect_tempo=False, cfg_coef=CFG_RETRY)
                    out.write_bytes(midi)
                    pm = pretty_midi.PrettyMIDI(str(out))
                    n = sum(len(i.notes) for i in pm.instruments)
                    rec["retry"] = f"cfg{CFG_RETRY:g}"
                secs = time.time() - t0
                rec.update(status="ok" if n else "empty", secs=round(secs, 1), rtf=round(secs / dur, 3),
                           vram_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2), notes=n,
                           instruments=sorted({i.name for i in pm.instruments}))
                ref = truth_notes(clip) if a.which != "real" else None
                if ref is not None:
                    rec["f1_all"] = round(f1(ref, notes_of(pm))["f"], 3)
            except Exception as e:
                rec.update(status="fail", secs=round(time.time() - t0, 1), error=f"{type(e).__name__}: {str(e)[:300]}")
                traceback.print_exc()
            log(rec)
            empties += rec["status"] == "empty"
            if rec["status"] == "fail" or empties > len(jobs) / 4:
                failed = True
                if not a.keep_going:
                    sys.exit(1)
        del model
        torch.cuda.empty_cache()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
