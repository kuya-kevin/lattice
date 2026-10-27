"""Spike D: does MRT2's style model (MusicCoCa) agree with human ratings better than
the spectral distance? Cosine similarity of looped-to-10 s clips vs. the reference.

    ../../envs/mrt/.venv/bin/python musiccoca_vs_ratings.py ../../out/c_recreate
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.stats import spearmanr

from magenta_rt import audio
from magenta_rt.musiccoca import MusicCoCa

c_out = Path(sys.argv[1])
ratings = [json.loads(line) for line in (c_out.parent / "eval" / "ratings.jsonl").read_text().splitlines()]
summary = json.loads((c_out / "summary.json").read_text())
coca = MusicCoCa()


def embed(path):
    y, sr = sf.read(path)
    y = np.tile(y, int(np.ceil(10 * sr / len(y))))
    e = np.asarray(coca.embed(audio.Waveform(y[:, None].astype(np.float32), sr))).ravel()
    return e / np.linalg.norm(e)


human, cosine, dist = [], [], []
for r in ratings:
    d = c_out / r["trial"]
    ref = embed(d / "reference.wav")
    for cond, score in r["scores"].items():
        if cond == "hidden_reference":
            continue
        human.append(score)
        cosine.append(float(ref @ embed(d / f"{cond}.wav")))
        dist.append(summary[r["trial"]]["conditions"][cond]["distance"])
print(f"n = {len(human)} ratings (hidden reference excluded)")
rho, p = spearmanr(human, cosine)
print(f"MusicCoCa cosine vs human:  rho = {rho:+.2f} (p = {p:.3f})  (positive = agrees)")
rho, p = spearmanr(human, dist)
print(f"spectral distance vs human: rho = {rho:+.2f} (p = {p:.3f})  (negative = agrees)")
