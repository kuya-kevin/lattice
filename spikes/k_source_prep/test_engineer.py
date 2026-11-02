"""Known-answer tests for engineer.py (B3), no model weights needed:

    LATTICE_BIGDISK=... spikes/j_evals/env.sh sep python spikes/k_source_prep/test_engineer.py

1. quantize at a given phase: hits jittered ±25 ms around a 100 BPM 1/16 grid whose first line
   is at 0.07 s land within a few ms of it; the output keeps the input's length and rate.
2. cleanup with noisereduce: a tone with gaps plus white noise; the noise floor drops by more
   than 10 dB and the tone's level stays within 1.5 dB.
3. the CLI writes the WAV and one RESULT line.
4. hits (B13 slice_drums): a synthetic kick / snare / hat pattern comes back one entry per hit,
   at most 30 ms before its attack, with the right kind; the CLI prints them without writing audio.
5. regions (B13 find_sound): tone bursts after 1 s of room noise 45 dB down come back as one
   region starting at the first burst (a 0.1 s gap is bridged).
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
from drums import slice_points  # noqa: E402
from engineer import cleanup, db, quantize, sound_regions  # noqa: E402

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
        out, info = cleanup(noisy, SR)
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


def kit_loop(bpm=110.0, bars=2):
    """Kick on 1 and 3, snare on 2 and 4, hats on the off-beat 8ths: no two hits at once."""
    beat = 60 / bpm
    t = np.arange(int(0.25 * SR)) / SR
    kick = np.sin(2 * np.pi * np.cumsum(50 + 100 * np.exp(-t * 30)) / SR) * np.exp(-t * 12)
    snare = (0.5 * np.diff(rng.normal(0, 1, len(t) + 1)) + np.sin(2 * np.pi * 190 * t)) * np.exp(-t * 25)  # wires (high-passed noise) + body
    hat = np.diff(rng.normal(0, 1, len(t) + 2), 2) * np.exp(-t * 80)
    truth = []
    for b in range(4 * bars):
        truth.append((0.05 + b * beat, "kick" if b % 2 == 0 else "snare"))
        truth.append((0.05 + (b + 0.5) * beat, "hat"))
    y = np.zeros(int((0.3 + 4 * bars * beat) * SR), np.float32)
    for at, kind in truth:
        x = {"kick": kick, "snare": snare, "hat": 0.4 * hat}[kind]
        n = int(at * SR)
        y[n : n + len(x)] += 0.6 * x[: len(y) - n]
    return y, truth


def test_hits():
    y, truth = kit_loop()
    pts = slice_points(y, SR)
    assert len(pts) == len(truth), (len(pts), len(truth))
    for p, (at, kind) in zip(pts, truth):
        assert -0.03 < p["time"] - at < 0.005 and p["kind"] == kind, (p, at, kind)  # cut just before the attack
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "in.wav"
        sf.write(src, y, SR)
        p = subprocess.run([sys.executable, str(HERE / "engineer.py"), "hits", str(src)], capture_output=True, text=True, check=True)
        info = json.loads(next(l for l in p.stdout.splitlines() if l.startswith("RESULT "))[7:])
        assert [h["kind"] for h in info["hits"]] == [k for _, k in truth] and info["duration"] == round(len(y) / SR, 3)
        assert sorted(x.name for x in Path(d).iterdir()) == ["in.wav"]
    print("hits ok", len(pts))


def test_regions():
    t = np.arange(int(4 * SR)) / SR
    tone = 0.5 * np.sin(2 * np.pi * 220 * t) * (((t >= 1.0) & (t < 2.0)) | ((t >= 2.1) & (t < 3.0)))
    y = (tone + rng.normal(0, 0.5 * 10 ** (-45 / 20), len(t))).astype(np.float32)
    regions, threshold = sound_regions(y, SR)
    assert len(regions) == 1 and 0.96 < regions[0][0] <= 1.01 and 2.99 <= regions[0][1] < 3.05, (regions, threshold)
    assert -50 <= threshold <= -30, threshold
    print("regions ok", regions, threshold)


if __name__ == "__main__":
    test_quantize_to_given_phase()
    test_cleanup_nr()
    test_cli()
    test_hits()
    test_regions()
