"""Score the onset drum detector on a small synthetic phone-quality drum set.

    spikes/j_evals/env.sh amt python spikes/k_source_prep/drum_eval.py         # render + score
    spikes/j_evals/env.sh amt python spikes/k_source_prep/drum_eval.py tune    # grid-search drums.TH

6 clips, 8 bars of GM drums (TimGM6mb kit via TinySoundFont: kick 36, snare 38, closed hat 42)
at random tempi and patterns, degraded with j_evals synth_set.phone() (room, band-limit, noise,
AGC, AAC). Scores onset F1 (+-50 ms) overall and per class, plus the class confusion.
Writes $LATTICE_BIGDISK/out-k/drums/{audio/*.wav, drum_f1.md}. Caveat: a GM kit is not a beatbox.
"""
import json
import os
import sys
from pathlib import Path

import mir_eval
import numpy as np
import pretty_midi
import soundfile as sf
import tinysoundfont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "j_evals"))
import drums as D  # noqa: E402
from synth_set import SF2, SR, phone  # noqa: E402

OUT = Path(os.environ["LATTICE_BIGDISK"]) / "out-k" / "drums"
PATTERNS = [  # 16 steps per bar: (kick, snare, hat)
    ("x...x...x...x...", "....x.......x...", "x.x.x.x.x.x.x.x."),
    ("x.....x...x.....", "....x.......x...", "x.x.x.x.x.x.x.x."),
    ("x..x..x...x..x..", "....x.......x..x", "xxxxxxxxxxxxxxxx"),
    ("x.......x.x.....", "....x.......x...", "..x...x...x...x."),
]


def render(hits, seconds):
    synth = tinysoundfont.Synth(samplerate=SR)
    sfid = synth.sfload(str(SF2))
    synth.program_select(9, sfid, 128, 0, is_drums=True)
    ev = sorted([(t, 1, p, v) for t, p, v in hits] + [(t + 0.1, 0, p, 0) for t, p, v in hits])
    total = int((seconds + 0.5) * SR)
    out, pos = np.zeros((total, 2), np.float32), 0
    for t, on, p, v in ev + [(total / SR, -1, 0, 0)]:
        stop = min(int(t * SR), total)
        if stop > pos:
            out[pos:stop] = np.frombuffer(synth.generate(stop - pos), dtype=np.float32).reshape(-1, 2)
            pos = stop
        if on == 1:
            synth.noteon(9, p, v)
        elif on == 0:
            synth.noteoff(9, p)
    y = out.mean(axis=1)
    return 0.5 * y / max(np.abs(y).max(), 1e-9)


def tune():
    """Grid-search the class thresholds on the rendered clips (run main() once first)."""
    import itertools
    truth = json.loads((OUT / "truth.json").read_text())
    data = []
    for cid, hits in truth.items():
        y, sr = sf.read(OUT / "audio" / f"{cid}__phone.wav", dtype="float32")
        y = y / (np.max(np.abs(y)) + 1e-9)
        times, strength, feats = D.onset_features(y, sr)
        keep = strength >= 0.1 * np.percentile(strength, 90)
        data.append((hits, times[keep], feats[keep]))
    best = (0, None)
    grid = {"kick": [0.3, 0.5, 0.7], "kick_tilt": [0.6, 1.0, 1.5], "snare": [0.3, 0.5, 0.7], "snare_tilt": [0.6, 0.9, 1.3],
            "hat": [0.3, 0.45, 0.6], "hat_tilt": [0.5, 0.8, 1.2]}
    for combo in itertools.product(*grid.values()):
        th = dict(zip(grid, combo))
        scores = []
        for hits, times, feats in data:
            labels = D.classify(feats, th)
            for cl in D.GM:
                r = np.array(sorted(t for t, p in hits if p == D.GM[cl]))
                e = np.array([t for t, ls in zip(times, labels) if cl in ls])
                scores.append(mir_eval.onset.f_measure(r, e, window=0.05)[0] if len(e) else 0.0)
        m = float(np.mean(scores))
        if m > best[0]:
            best = (m, th)
    print("best mean class F1", round(best[0], 3), best[1])


def main(th=D.TH):
    (OUT / "audio").mkdir(parents=True, exist_ok=True)
    per = {c: [] for c in D.GM}
    allf, truth = [], {}
    names = list(D.GM)
    lines = ["| clip | bpm | truth hits | detected | onset F1 | kick F1 | snare F1 | hat F1 |", "|---|---|---|---|---|---|---|---|"]
    for k in range(6):
        rng = np.random.default_rng(500 + k)
        bpm = float(rng.integers(80, 140))
        pat = PATTERNS[k % len(PATTERNS)]
        step = 60 / bpm / 4
        hits = []
        for bar in range(8):
            for i in range(16):
                t = (bar * 16 + i) * step + rng.normal(0, 0.008)  # human timing
                for cl, row in zip(names, pat):
                    if row[i] == "x":
                        hits.append((max(t, 0), D.GM[cl], int(np.clip(rng.normal(95 if cl != "hat" else 70, 12), 40, 127))))
        seconds = 8 * 16 * step
        y = render(hits, seconds)
        yp, _ = phone(y, rng)
        sf.write(OUT / "audio" / f"drums_{k}__phone.wav", yp, SR)
        det = D.detect(yp.astype(np.float32), SR, th)
        ref_t = np.array(sorted({round(t, 3) for t, _, _ in hits}))
        est_t = np.array(sorted({h["time"] for h in det}))
        f = mir_eval.onset.f_measure(ref_t, est_t, window=0.05)[0] if len(est_t) else 0.0
        allf.append(f)
        row = []
        for cl in names:
            r = np.array(sorted(t for t, p, _ in hits if p == D.GM[cl]))
            e = np.array([h["time"] for h in det if h["class"] == cl])
            fc = mir_eval.onset.f_measure(r, e, window=0.05)[0] if len(e) and len(r) else 0.0
            per[cl].append(fc)
            row.append(fc)
        truth[f"drums_{k}"] = [(round(t, 4), p) for t, p, _ in hits]
        lines.append(f"| drums_{k} | {bpm:.0f} | {len(ref_t)} | {len(det)} | {f:.2f} | " + " | ".join(f"{x:.2f}" for x in row) + " |")
    lines.append(f"| mean | | | | {np.mean(allf):.2f} | " + " | ".join(f"{np.mean(per[c]):.2f}" for c in names) + " |")
    (OUT / "truth.json").write_text(json.dumps(truth))
    md = "\n".join(lines) + "\n"
    (OUT / "drum_f1.md").write_text(md)
    print(md)


if __name__ == "__main__":
    tune() if sys.argv[1:] == ["tune"] else main()
