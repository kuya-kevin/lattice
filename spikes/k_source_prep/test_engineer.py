"""Known-answer tests for engineer.py (B3), no model weights needed:

    LATTICE_BIGDISK=... spikes/j_evals/env.sh sep python spikes/k_source_prep/test_engineer.py

1. quantize at a given phase: hits jittered ±25 ms around a 100 BPM 1/16 grid whose first line
   is at 0.07 s land within a few ms of it; the output keeps the input's length and rate.
2. cleanup with noisereduce: a tone with gaps plus white noise; the noise floor drops by more
   than 10 dB and the tone's level stays within 1.5 dB.
3. the CLI writes the WAV and one RESULT line.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from engineer import cleanup, db, quantize  # noqa: E402

SR = 22050
rng = np.random.default_rng(1)


def drums(bpm=100.0, phase=0.07, seconds=8.0):
    step = 60 / bpm / 4
    lines = np.arange(phase, seconds - 0.5, step)
    true = lines[rng.random(len(lines)) < 0.5]
    played = true + rng.uniform(-0.025, 0.025, len(true))
    y = np.zeros(int(seconds * SR), np.float32)
    t = np.arange(int(0.1 * SR)) / SR
    for i, p in enumerate(played):
        hit = np.sin(2 * np.pi * 60 * t * (1 + 2 * np.exp(-t * 40))) * np.exp(-t * 30) if i % 2 == 0 else rng.normal(0, 1, len(t)) * np.exp(-t * 40)
        n = int(p * SR)
        y[n : n + len(t)] += 0.5 * hit
    return y, step


def test_quantize_to_given_phase():
    y, step = drums()
    out, info = quantize(y, SR, bpm=100.0, grid=16, strength=1.0, phase=0.07)
    assert len(out) == len(y)
    assert info["hits"] > 20 and info["moved"] > 10, info
    assert info["off_grid_ms"]["before"] > 5, info
    assert info["off_grid_ms"]["after"] < 3, info
    half, half_info = quantize(y, SR, bpm=100.0, grid=16, strength=0.5, phase=0.07)
    assert info["off_grid_ms"]["after"] < half_info["off_grid_ms"]["after"] < info["off_grid_ms"]["before"], half_info
    print("quantize ok", info["off_grid_ms"], "half:", half_info["off_grid_ms"])


def test_cleanup_nr():
    t = np.arange(int(6 * SR)) / SR
    on = (t % 2) < 1.2  # phrases with gaps
    saw = sum(np.sin(2 * np.pi * 220 * k * t) / k for k in range(1, 40) if 220 * k < SR / 2)
    for name, s in {"sine": np.sin(2 * np.pi * 220 * t), "harmonic": saw}.items():
        tone = 0.3 * s / np.max(np.abs(s)) * on
        noisy = (tone + rng.normal(0, 0.02, len(t))).astype(np.float32)
        out, info = cleanup(noisy, SR, method="nr")
        assert len(out) == len(noisy)
        assert info["method"] == "noisereduce"
        drop = info["noise_floor_db"]["before"] - info["noise_floor_db"]["after"]
        assert drop > 10, (name, info)
        assert abs(db(out[on]) - db(tone[on])) < 1.5, (name, db(out[on]), db(tone[on]))
        print("cleanup ok", name, info)


def test_cli():
    y, _ = drums(seconds=4.0)
    with tempfile.TemporaryDirectory() as d:
        src, dst = Path(d) / "in.wav", Path(d) / "out.wav"
        sf.write(src, y, SR)
        p = subprocess.run([sys.executable, str(HERE / "engineer.py"), "quantize", str(src), str(dst), "--bpm", "100", "--grid", "16", "--phase", "0.07"],
                           capture_output=True, text=True, check=True)
        line = next(l for l in p.stdout.splitlines() if l.startswith("RESULT "))
        info = json.loads(line[7:])
        out, sr = sf.read(dst)
        assert sr == SR and len(out) == len(y) and info["duration"] == round(len(y) / SR, 3), info
        print("cli ok")


if __name__ == "__main__":
    test_quantize_to_given_phase()
    test_cleanup_nr()
    test_cli()
