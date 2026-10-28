"""Job lists for run_sam.py and the SI-SDR table (SAM vs htdemucs_6s / Mel-RoFormer).

    spikes/j_evals/env.sh amt python spikes/l_sam_audio/score.py jobs     # writes $LATTICE_OUT/sam/jobs_*.json
    spikes/j_evals/env.sh amt python spikes/l_sam_audio/score.py table    # writes sam/si_sdr.md

Sets (each part has a true stem):
- synth:  j_evals layered_0..3 phone mixes; parts hum / keys / bass (truth_stems.py references).
- musdb:  MUSDB18 7 s excerpts (Zenodo 3270814, local only); parts vocals / bass / drums.
SI-SDR in dB (scale-invariant, higher is better), at 44.1 kHz after aligning by cross-correlation
(±50 ms). "input" is the unseparated mix scored against the part: the floor to beat.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve, resample_poly

BIG = Path(os.environ["LATTICE_BIGDISK"])
EV = Path(os.environ["LATTICE_OUT"])
SYNTH = EV / "amt" / "synth"
MUSDB = BIG / "transfer" / "data" / "musdb7"
SAM, SEP = EV / "sam", EV / "sep"
SR = 44100
# Two fixed wordings per part, chosen before the run; both are reported (p1, p2).
PROMPTS = {
    "hum": ["singing voice", "humming"],
    "keys": ["piano", "piano chords"],
    "bass": ["bass guitar", "bass"],
    "vocals": ["singing voice", "vocals"],
    "drums": ["drums", "drum kit"],
}
MUSDB_N = 8  # excerpts used (first N test tracks, sorted)


def musdb_tracks():
    test = sorted(p.parent for p in MUSDB.rglob("test/*/mixture.wav"))
    return test[:MUSDB_N]


def sets():
    """{set: [(id, mix_path, part, ref_path)]}"""
    out = {"synth": [], "musdb": []}
    for k in range(4):
        cid = f"layered_{k}__phone"
        for part in ("hum", "keys", "bass"):
            out["synth"].append((cid, SYNTH / "audio" / f"{cid}.wav", part, SYNTH / "stems" / f"layered_{k}__{part}.wav"))
    for t in musdb_tracks():
        cid = "musdb_" + "".join(c if c.isalnum() else "_" for c in t.name)[:40]
        for part in ("vocals", "bass", "drums"):
            out["musdb"].append((cid, t / "mixture.wav", part, t / f"{part}.wav"))
    return out


def baselines(cid, part):
    """{method: [stem wavs summed]} from the existing separations."""
    h, m = SEP / "htdemucs_6s" / cid, SEP / "mel_roformer" / cid
    voc = "hum" if part == "hum" else "vocals"
    table = {
        "htdemucs_6s": {voc: ["vocals"], "bass": ["bass"], "drums": ["drums"], "keys": ["piano", "guitar", "other"]},
        "mel_roformer": {voc: ["vocals"]},
    }
    found = {}
    for meth, d in (("htdemucs_6s", h), ("mel_roformer", m)):
        stems = table[meth].get(part)
        if stems and all((d / f"{s}.wav").exists() for s in stems):
            found[meth] = [d / f"{s}.wav" for s in stems]
    return found


def load(paths):
    ys = []
    for p in paths if isinstance(paths, list) else [paths]:
        y, s = sf.read(p, always_2d=True)
        y = y.mean(axis=1)
        if s != SR:
            g = np.gcd(s, SR)
            y = resample_poly(y, SR // g, s // g)
        ys.append(y)
    n = min(map(len, ys))
    return sum(y[:n] for y in ys)


def si_sdr(est, ref):
    max_lag = int(0.05 * SR)
    xc = fftconvolve(est, ref[::-1])
    mid = len(ref) - 1
    lag = int(np.argmax(np.abs(xc[mid - max_lag: mid + max_lag + 1]))) - max_lag
    est = est[lag:] if lag > 0 else np.pad(est, (-lag, 0))
    n = min(len(est), len(ref))
    e, r = est[:n] - est[:n].mean(), ref[:n] - ref[:n].mean()
    if np.sum(r**2) < 1e-10:
        return None  # silent reference (part absent in this excerpt)
    s = np.dot(e, r) / np.dot(r, r) * r
    return float(10 * np.log10(np.sum(s**2) / (np.sum((e - s) ** 2) + 1e-20) + 1e-20))


def write_jobs():
    SAM.mkdir(parents=True, exist_ok=True)
    for name, rows in sets().items():
        jobs = [{"id": cid, "audio": str(mix), "part": part, "tag": f"p{i + 1}", "text": text}
                for cid, mix, part, _ in rows for i, text in enumerate(PROMPTS[part])]
        (SAM / f"jobs_{name}.json").write_text(json.dumps(jobs, indent=1))
        print(name, len(jobs), "jobs")
    musdb_in = {cid: str(mix) for cid, mix, _, _ in sets()["musdb"]}
    (EV / "inputs_sep_musdb.json").write_text(json.dumps(musdb_in, indent=1))
    print("separate.py inputs:", EV / "inputs_sep_musdb.json")


def table():
    variants = sorted(p.name for p in SAM.iterdir() if (p / "runs.json").exists()) if SAM.exists() else []
    lines = ["# SAM Audio vs fixed-stem separators (SI-SDR dB, higher is better)", ""]
    detail = {}
    for name, rows in sets().items():
        scores = {}  # (part, method) -> [dB]
        for cid, mix, part, ref in rows:
            if not ref.exists():
                continue
            r = load(ref)
            cand = {"input": [mix], **baselines(cid, part)}
            for v in variants:
                for tag in ("p1", "p2"):
                    t = SAM / v / f"{cid}__{part}__{tag}" / "target.wav"
                    if t.exists():
                        cand[f"sam_{v}_{tag}"] = [t]
            for meth, paths in cand.items():
                v = si_sdr(load(paths), r)
                if v is not None:
                    scores.setdefault((part, meth), []).append(v)
                    detail[f"{name}/{cid}/{part}/{meth}"] = round(v, 2)
        methods = ["input", "htdemucs_6s", "mel_roformer"] + [f"sam_{v}_{t}" for v in variants for t in ("p1", "p2")]
        parts = list(dict.fromkeys(p for p, _ in scores))
        lines += [f"## {name}", "", "| part | " + " | ".join(methods) + " |", "|---" * (len(methods) + 1) + "|"]
        for part in parts:
            cells = []
            for m in methods:
                xs = scores.get((part, m))
                cells.append(f"{np.mean(xs):.1f} (n={len(xs)})" if xs else "—")
            lines.append(f"| {part} | " + " | ".join(cells) + " |")
        lines.append("")
    lines += ["Prompts: " + "; ".join(f"{p} p1 \"{a}\", p2 \"{b}\"" for p, (a, b) in PROMPTS.items()), ""]
    for v in variants:
        runs = [r for r in json.loads((SAM / v / "runs.json").read_text()).values() if r.get("tag")]
        lines.append(f"- sam_{v}: median wall {np.median([r['wall_s'] for r in runs]):.1f} s "
                     f"(incl. model load), peak VRAM {max(r['vram_peak_mib'] for r in runs)} MiB, "
                     f"target+residual vs input median {np.median([r['consistency_db'] for r in runs]):.1f} dB "
                     f"(recorded only: SAM is generative)")
    (SAM / "si_sdr.md").write_text("\n".join(lines) + "\n")
    (SAM / "si_sdr.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    {"jobs": write_jobs, "table": table}[sys.argv[1]]()
