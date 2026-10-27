"""Meta Audiobox Aesthetics as a grader, checked against the Kev3090 pair ratings.

    spikes/j_evals/env.sh aes python spikes/j_evals/aes_grader.py

Scores every WAV in out/c_recreate/<target>/ (reference + candidates) on the four axes
(PQ production quality, PC production complexity, CE content enjoyment, CU content
usefulness, each ~1-10), then asks, over the same decided pairs analyze.py uses:
- raw axis: does the candidate with the higher score win "closer to the reference"?
- reference-aware: is the candidate whose 4-axis vector is nearer the reference's the winner?
- spectral distance (the existing self-check) on the same pairs, for comparison;
- thumbs-up ("I'd use this"): AUC of each axis for liked vs not liked;
- slider round (round 1, "like" scores): Spearman per axis.
Writes $LATTICE_OUT/aes/scores.json and report.json.
"""
import json
import os
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from scipy.stats import binomtest, spearmanr

from audiobox_aesthetics.infer import initialize_predictor

C = Path(os.environ["LATTICE_C"])
RATINGS = C.parent / ("ev" "al") / "ratings.jsonl"
OUT = Path(os.environ["LATTICE_OUT"]) / "aes"
AXES = ["PQ", "PC", "CE", "CU"]


def score_all():
    pred = initialize_predictor()
    files = sorted(C.glob("*/*.wav"))
    torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    out = {}
    for i in range(0, len(files), 16):
        batch = files[i : i + 16]
        items = []
        for f in batch:  # torchaudio.load needs torchcodec/ffmpeg here, so pass tensors
            y, sr = sf.read(str(f), dtype="float32", always_2d=True)
            items.append({"path": torch.from_numpy(y.T.copy()), "sample_rate": sr})
        res = pred.forward(items)
        for f, r in zip(batch, res):
            out[f"{f.parent.name}/{f.stem}"] = r
    took = time.time() - t0
    secs = sum(sf.info(str(f)).duration for f in files)
    meta = {"files": len(files), "audio_seconds": round(secs, 1), "seconds": round(took, 2),
            "peak_vram_mb": round(torch.cuda.max_memory_allocated() / 2**20)}
    return out, meta


def auc(pos, neg):
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    scores, meta = score_all()
    (OUT / "scores.json").write_text(json.dumps({"meta": meta, "scores": scores}, indent=2))
    summary = json.loads((C / "summary.json").read_text())
    answers = [json.loads(line) for line in RATINGS.read_text().splitlines()]
    pairs = [a for a in answers if a.get("kind") == "pair" and a["rater"] == "Kev3090"]

    def vec(trial, cond):
        key = f"{trial}/{'reference' if cond == 'hidden_reference' else cond}"
        return np.array([scores[key][a] for a in AXES]) if key in scores else None

    def dist(trial, cond):
        return 0.0 if cond == "hidden_reference" else summary[trial]["conditions"].get(cond, {}).get("distance")

    # Pairs that include the hidden reference are easy for any reference-aware metric
    # (distance 0), so the agreement is also reported without them.
    tables = {}
    for subset in ("all_decided", "without_hidden_reference"):
        agree = defaultdict(lambda: [0, 0])  # name -> [agree, decided]
        for p in pairs:
            if p["choice"] == "same":
                continue
            if subset != "all_decided" and "hidden_reference" in (p["a"], p["b"]):
                continue
            a_won = p["choice"] == "a"
            va, vb, ref = vec(p["trial"], p["a"]), vec(p["trial"], p["b"]), vec(p["trial"], "reference")
            da, db = dist(p["trial"], p["a"]), dist(p["trial"], p["b"])
            if da is not None and db is not None and da != db:
                agree["spectral_distance"][1] += 1
                agree["spectral_distance"][0] += (da < db) == a_won
            if va is None or vb is None:
                continue
            for k, ax in enumerate(AXES):
                if va[k] != vb[k]:
                    agree[f"higher_{ax}"][1] += 1
                    agree[f"higher_{ax}"][0] += (va[k] > vb[k]) == a_won
            na, nb = np.linalg.norm(va - ref), np.linalg.norm(vb - ref)
            if na != nb:
                agree["nearer_ref_4axis"][1] += 1
                agree["nearer_ref_4axis"][0] += (na < nb) == a_won
        tables[subset] = {
            name: {"agree": ag, "decided": n, "rate": round(ag / n, 3),
                   "p_one_sided": round(float(binomtest(ag, n, 0.5, alternative="greater").pvalue), 4)}
            for name, (ag, n) in agree.items()}
    table = tables

    liked = defaultdict(lambda: ([], []))
    for p in pairs:
        for cond, on in p.get("like", {}).items():
            v = vec(p["trial"], cond)
            if v is None:
                continue
            for k, ax in enumerate(AXES):
                liked[ax][0 if on else 1].append(v[k])
    like_auc = {ax: round(auc(*liked[ax]), 3) for ax in AXES}

    sliders = [a for a in answers if a.get("kind", "slider") == "slider"]
    xs, ys = defaultdict(list), []
    for r in sliders:
        for cond, s in r["scores"].items():
            v = vec(r["trial"], cond)
            if v is None or cond == "hidden_reference":
                continue
            ys.append(s)
            for k, ax in enumerate(AXES):
                xs[ax].append(v[k])
    slider = {ax: [round(float(x), 3) for x in spearmanr(xs[ax], ys)] for ax in AXES}

    per_cond = defaultdict(list)
    for key, s in scores.items():
        per_cond[key.split("/")[1]].append([s[a] for a in AXES])
    means = {c: dict(zip(AXES, np.round(np.mean(v, axis=0), 2).tolist())) for c, v in per_cond.items()}

    report = {"meta": meta, "pairs_kev3090": len(pairs), "pair_agreement": table, "thumbs_up_auc": like_auc,
              "slider_round_spearman_rho_p": slider, "mean_scores_by_condition": means}
    (OUT / "report.json").write_text(json.dumps(report, indent=2, default=float))
    print(json.dumps(report, indent=2, default=float))


if __name__ == "__main__":
    main()
