"""MuScriptor medium on the sidecar's stems, one model load (run by prep.py as a separate process).

    spikes/j_evals/env.sh muscriptor python spikes/k_source_prep/muscriptor_stems.py jobs.json [--size medium]

jobs.json: [{"in": "stem.wav", "out": "stem.muscriptor.mid"}, ...]. Prints one line
`RESULT {"<out>": {"notes": n, "retry": bool, "secs": s}, ...}` at the end. An empty result is
retried once with classifier-free guidance 3: greedy decoding sometimes ends every chunk at once
on a hummed stem (spikes/j_evals/README.md). Code MIT, weights CC BY-NC 4.0 (non-commercial).
"""
import argparse
import io
import json
import time

import pretty_midi
from muscriptor import TranscriptionModel

CFG_RETRY = 3.0


def count(midi: bytes) -> int:
    return sum(len(i.notes) for i in pretty_midi.PrettyMIDI(io.BytesIO(midi)).instruments)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs")
    ap.add_argument("--size", default="medium")
    a = ap.parse_args()
    model = TranscriptionModel.load_model(a.size)  # CUDA, MPS or CPU, whichever is there
    result = {}
    for job in json.loads(open(a.jobs).read()):
        t = time.time()
        midi, _ = model.transcribe_and_postprocess(job["in"], detect_tempo=False)
        retry = count(midi) == 0
        if retry:
            midi, _ = model.transcribe_and_postprocess(job["in"], detect_tempo=False, cfg_coef=CFG_RETRY)
        open(job["out"], "wb").write(midi)
        result[job["out"]] = {"notes": count(midi), "retry": retry, "secs": round(time.time() - t, 1)}
    print("RESULT " + json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
