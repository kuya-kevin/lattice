"""Can SAM Audio (text-prompted separation, audio.cpp GGUF) beat our fixed-stem separators?

    spikes/j_evals/env.sh amt python spikes/l_sam_audio/run_sam.py jobs.json small [base large]

jobs.json: [{"id": "<clip>", "audio": "<wav>", "part": "<name>", "tag": "p1", "text": "<prompt>"}, ...]
For each variant (Q8_0 GGUF) and job, runs `audiocpp_cli --task s2s --family sam_audio` and writes
$LATTICE_OUT/sam/<variant>/<id>__<part>__<tag>/{target,residual}.wav (mono 48 kHz) plus
$LATTICE_OUT/sam/<variant>/runs.json: wall time (includes model load), peak VRAM (nvidia-smi,
sampled every 50 ms) and target + residual vs input (dB). That last one is recorded, not a gate:
SAM is generative, so the two only match the input to about -10 dB.
Needs $AUDIOCPP_CLI (default: <bigdisk>/repos/audiocpp-src/build/.../audiocpp_cli).
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

BIG = Path(os.environ["LATTICE_BIGDISK"])
OUT = Path(os.environ["LATTICE_OUT"]) / "sam"
MODELS = BIG / "models" / "sam-audio-gguf"


def find_cli():
    if os.environ.get("AUDIOCPP_CLI"):
        return os.environ["AUDIOCPP_CLI"]
    hits = sorted((BIG / "repos" / "audiocpp-src" / "build").rglob("audiocpp_cli"))
    hits = [h for h in hits if h.is_file() and os.access(h, os.X_OK)]
    if not hits:
        sys.exit("audiocpp_cli not found; set AUDIOCPP_CLI")
    return str(hits[0])


class VramPeak(threading.Thread):
    """Peak used GPU memory (MiB) while a child process runs."""

    def __init__(self):
        super().__init__(daemon=True)
        self.peak, self.stop = 0, threading.Event()
        self.base = self.read()

    @staticmethod
    def read():
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True).stdout
        return int(out.split()[0])

    def run(self):
        while not self.stop.is_set():
            self.peak = max(self.peak, self.read())
            time.sleep(0.05)


def load_mono(path, sr):
    y, s = sf.read(path, always_2d=True)
    y = y.mean(axis=1)
    if s != sr:
        g = np.gcd(s, sr)
        y = resample_poly(y, sr // g, s // g)
    return y


def consistency_db(audio, target, residual):
    x = load_mono(audio, 48000)
    t, r = load_mono(target, 48000), load_mono(residual, 48000)
    n = min(len(x), len(t), len(r))
    err = t[:n] + r[:n] - x[:n]
    return float(10 * np.log10(np.sum(err**2) / (np.sum(x[:n] ** 2) + 1e-20) + 1e-20))


CHUNK_S, OVERLAP_S, SR_OUT = 20.0, 1.0, 48000  # decoder memory grows with length: 78 s needs >16 GB


def run_cli(cli, model, audio, text, d):
    """One CLI call; inputs longer than CHUNK_S + 5 s go in overlapping chunks, crossfaded back."""
    cmd = [cli, "--task", "s2s", "--family", "sam_audio", "--model", str(model), "--backend", "cuda",
           "--text", text, "--seed", "42", "--log"]
    x = load_mono(audio, SR_OUT)
    if len(x) <= (CHUNK_S + 5) * SR_OUT:
        p = subprocess.run(cmd + ["--audio", audio, "--out-dir", str(d)], capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr
    step, n, ov = int((CHUNK_S - OVERLAP_S) * SR_OUT), int(CHUNK_S * SR_OUT), int(OVERLAP_S * SR_OUT)
    outs, logs = {"target": np.zeros(len(x)), "residual": np.zeros(len(x))}, []
    for i, start in enumerate(range(0, len(x), step)):
        seg = x[start:start + n]
        cd = d / "chunks" / f"{i:02d}"
        cd.mkdir(parents=True, exist_ok=True)
        sf.write(cd / "in.wav", seg, SR_OUT)
        p = subprocess.run(cmd + ["--audio", str(cd / "in.wav"), "--out-dir", str(cd)], capture_output=True, text=True)
        logs.append(p.stdout + p.stderr)
        if p.returncode != 0:
            return p.returncode, "\n".join(logs)
        w = np.ones(len(seg))  # linear fade in/out over the overlap (none at the outer edges)
        if start > 0:
            w[:ov] = np.linspace(0, 1, ov)
        if start + n < len(x):
            w[-ov:] = np.linspace(1, 0, ov)
        for k in outs:
            y = load_mono(cd / f"{k}.wav", SR_OUT)[:len(seg)]
            outs[k][start:start + len(y)] += w[:len(y)] * y
        if start + n >= len(x):
            break
    for k, y in outs.items():
        sf.write(d / f"{k}.wav", y, SR_OUT)
    return 0, "\n".join(logs)


def main():
    jobs = json.loads(Path(sys.argv[1]).read_text())
    cli = find_cli()
    for variant in sys.argv[2:]:
        model = MODELS / f"sam-audio-{variant}-q8_0.gguf"
        vout = OUT / variant
        vout.mkdir(parents=True, exist_ok=True)
        runs_path = vout / "runs.json"
        runs = json.loads(runs_path.read_text()) if runs_path.exists() else {}
        for job in jobs:
            key = f"{job['id']}__{job['part']}" + (f"__{job['tag']}" if job.get("tag") else "")
            d = vout / key
            d.mkdir(parents=True, exist_ok=True)  # the CLI may fail before creating it
            mon = VramPeak()
            mon.start()
            t0 = time.time()
            rc, log = run_cli(cli, model, job["audio"], job["text"], d)
            wall = time.time() - t0
            mon.stop.set()
            mon.join()
            (d / "log.txt").write_text(log)
            if rc != 0:
                print(f"{variant} {key}: FAILED ({rc}); see {d / 'log.txt'}", flush=True)
                continue
            dur = sf.info(job["audio"]).duration
            rec = {**job, "seconds": round(dur, 2), "wall_s": round(wall, 2), "rtf_wall": round(wall / dur, 3),
                   "vram_peak_mib": mon.peak - mon.base,
                   "consistency_db": round(consistency_db(job["audio"], d / "target.wav", d / "residual.wav"), 1)}
            runs[key] = rec
            runs_path.write_text(json.dumps(runs, indent=1))
            print(variant, key, {k: rec[k] for k in ("wall_s", "vram_peak_mib", "consistency_db")}, flush=True)


if __name__ == "__main__":
    main()
