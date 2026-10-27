"""Spike D: Magenta RT2 as the sound-design engine, on the same targets as spike C.

MRT2 is steered by a style embedding (from audio or text) plus a per-frame piano roll.
Here the reference audio is the style prompt and the piano roll plays the reference's
note for its gate length, so MRT2 gets the same information the synth optimizer got.
Runs in envs/mrt (MLX, Apple Silicon); score afterwards with score_mrt2.py in the
spikes env.

    ../../envs/mrt/.venv/bin/python run_mrt2.py ../../out/c_recreate [mrt2_small] [prime_seconds]
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from magenta_rt import MagentaRT2StdMlxfn, audio
from magenta_rt.config import MUSICCOCA, PIANOROLL_WITH_ONSETS

FPS = 25  # MRT2 frame rate
OFF, HOLD, ONSET = 0, 1, 2


def midi(f0):
    return int(round(69 + 12 * np.log2(f0 / 440.0)))


def piano_roll(note, state):
    roll = [OFF] * 128
    roll[note] = state
    return roll


def play_note(mrt, style, note, seconds, gate, prime=0.0, **kw):
    """Onset frame, held frames for the gate, then off frames; state carries across calls.

    prime: seconds generated first with every note off (and then thrown away), so the
    model starts the note from a running state instead of a cold one.
    """
    on = max(int(round(gate * FPS)), 1)
    total = int(round(seconds * FPS))
    chunks, state = [], None
    if prime > 0:
        _, state = mrt.generate(
            conditioning={MUSICCOCA.key: style, PIANOROLL_WITH_ONSETS.key: [OFF] * 128}, frames=int(prime * FPS), **kw
        )
    for roll, frames in ((piano_roll(note, ONSET), 1), (piano_roll(note, HOLD), on - 1), (piano_roll(note, OFF), total - on)):
        if frames <= 0:
            continue
        wav, state = mrt.generate(
            conditioning={MUSICCOCA.key: style, PIANOROLL_WITH_ONSETS.key: roll}, frames=frames, state=state, **kw
        )
        chunks.append(wav.samples)
    return np.concatenate(chunks), wav.sample_rate


def main(c_out, size="mrt2_small", prime="0"):
    c_out = Path(c_out)
    summary = json.loads((c_out / "summary.json").read_text())
    mrt = MagentaRT2StdMlxfn(size=size, temperature=1.0, top_k=40, cfg_scales={"musiccoca": 3.0, "notes": 3.0, "drums": 1.0})
    log = {}
    for name, rec in summary.items():
        d = c_out / name
        ref, sr = sf.read(d / "reference.wav")
        # The style model reads ~10 s clips; one 2 s note alone embeds poorly, so loop it.
        looped = np.tile(ref, int(np.ceil(10 * sr / len(ref))))
        style = mrt.embed_style(audio.Waveform(looped[:, None].astype(np.float32), sr))
        note = midi(rec["true_f0"])
        t0 = time.time()
        y, out_sr = play_note(mrt, style, note, len(ref) / sr, rec["gate"], prime=float(prime))
        took = time.time() - t0
        mono = resample_poly(y.mean(axis=1), sr, out_sr)[: len(ref)]
        mono = 0.8 * mono / max(np.abs(mono).max(), 1e-9)
        sf.write(d / "mrt2.wav", mono, sr)
        log[name] = {"note": note, "seconds_to_generate": took, "audio_seconds": len(ref) / sr}
        print(f"{name:24s} note {note}  {took:.2f}s for {len(ref) / sr:.1f}s of audio", flush=True)
    (c_out.parent / "d_mrt2.json").write_text(json.dumps(log, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:])
