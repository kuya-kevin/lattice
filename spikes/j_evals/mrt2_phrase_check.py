"""Does MRT2 play the MIDI phrase it was given? basic-pitch on each render, F1 vs phrase.mid.

    spikes/j_evals/env.sh amt python spikes/j_evals/mrt2_phrase_check.py

Onset tolerance is 100 ms here (MRT2 runs at 25 frames/s = 40 ms steps). The bass prompt was
played two octaves down, so the truth is shifted for it. Pitch-class F1 forgives octaves.
Writes $LATTICE_OUT/mrt2/phrase_check.json.
"""
import json
import os
from pathlib import Path

import mir_eval
import numpy as np
import pretty_midi
import scipy.signal

if not hasattr(scipy.signal, "gaussian"):
    scipy.signal.gaussian = scipy.signal.windows.gaussian
from basic_pitch import ICASSP_2022_MODEL_PATH  # noqa: E402
from basic_pitch.inference import Model, predict  # noqa: E402

D = Path(os.environ["LATTICE_OUT"]) / "mrt2"
PRIME_S = 0.0  # the primed second was discarded before writing


def arr(notes, shift=0, fold=False):
    iv = np.array([[n.start, n.end] for n in notes])
    p = np.array([n.pitch + shift for n in notes], float)
    if fold:
        p = 60 + p % 12
    return iv, 440 * 2 ** ((p - 69) / 12)


def main():
    truth = pretty_midi.PrettyMIDI(str(D / "phrase.mid")).instruments[0].notes
    model = Model(ICASSP_2022_MODEL_PATH)
    res = {}
    for wav in sorted(D.glob("phrase_*.wav")):
        _, pm, _ = predict(str(wav), model)
        est = [n for n in pm.instruments[0].notes if n.end - n.start >= 0.08 and n.velocity >= 30]
        shift = -24 if "bass" in wav.stem else 0
        out = {"n_est": len(est)}
        for fold in (False, True):
            if not est:
                out["f1_pc" if fold else "f1"] = 0.0
                continue
            ri, rp = arr(truth, shift, fold)
            ei, ep = arr(est, 0, fold)
            f = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=0.1, offset_ratio=None)[2]
            out["f1_pc" if fold else "f1"] = round(float(f), 3)
        res[wav.stem] = out
        print(wav.stem, out)
    (D / "phrase_check.json").write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
