"""Magenta RT2 on CUDA (JAX backend): speed/VRAM, spike-D recreation, text prompts on a MIDI phrase.

    spikes/j_evals/env.sh mrt python spikes/j_evals/mrt2_cuda.py mrt2_small
    spikes/j_evals/env.sh mrt python spikes/j_evals/mrt2_cuda.py mrt2_base

Writes:
- out/c_recreate/<target>/mrt2_cuda_<size>.wav (new listening-test candidates; same recipe
  as spikes/d_mrt2/run_mrt2.py: looped reference as the style prompt, the reference's note
  for its gate as the piano roll, cfg musiccoca 3 / notes 3, temperature 1, top-k 40)
- $LATTICE_OUT/mrt2/phrase_<size>_<prompt>.wav and phrase.mid (text prompts on a 2-bar phrase)
- $LATTICE_OUT/mrt2/bench_<size>.json (load/compile time, RTF, peak VRAM)
"""
import json
import os
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")  # so peak VRAM is measurable

import jax  # noqa: E402
import numpy as np  # noqa: E402
import pretty_midi  # noqa: E402
import soundfile as sf  # noqa: E402
from scipy.signal import resample_poly  # noqa: E402

from magenta_rt import MagentaRT2Jax, audio  # noqa: E402
from magenta_rt.config import MUSICCOCA, PIANOROLL_WITH_ONSETS  # noqa: E402

FPS = 25
OFF, HOLD, ONSET = 0, 1, 2
C_OUT = Path(os.environ["LATTICE_C"])
OUT = Path(os.environ["LATTICE_OUT"]) / "mrt2"

# A 2-bar phrase at 100 bpm in C minor (pitch, start beat, length in beats).
BPM = 100
PHRASE = [(60, 0, 1), (63, 1, 0.5), (67, 1.5, 0.5), (70, 2, 1.5), (68, 3.5, 0.5),
          (67, 4, 1), (65, 5, 0.5), (63, 5.5, 0.5), (62, 6, 1), (60, 7, 1)]
PROMPTS = ["solo piano", "analog synth lead", "electric bass guitar", "string ensemble", "lo-fi electric piano"]


def peak_vram_mb():
    stats = jax.devices()[0].memory_stats() or {}
    return stats.get("peak_bytes_in_use", 0) / 2**20


def rolls_for(notes, total_frames):
    """notes: (pitch, start_s, end_s). Returns a per-frame list of 128-long piano-roll rows."""
    rows = np.zeros((total_frames, 128), dtype=np.int32)
    for pitch, start, end in notes:
        a = int(round(start * FPS))
        b = max(int(round(end * FPS)), a + 1)
        rows[a:b, pitch] = HOLD
        rows[a, pitch] = ONSET
    return rows


def play(mrt, style, rows, prime=0, **kw):
    """Generate one chunk per run of identical piano-roll rows, carrying state."""
    state, chunks, sr = None, [], 48000
    if prime:
        _, state = mrt.generate(conditioning={MUSICCOCA.key: style, PIANOROLL_WITH_ONSETS.key: [OFF] * 128},
                                frames=prime, **kw)
    i = 0
    while i < len(rows):
        j = i + 1
        while j < len(rows) and (rows[j] == rows[i]).all():
            j += 1
        wav, state = mrt.generate(conditioning={MUSICCOCA.key: style, PIANOROLL_WITH_ONSETS.key: rows[i].tolist()},
                                  frames=j - i, state=state, **kw)
        chunks.append(wav.samples)
        sr = wav.sample_rate
        i = j
    return np.concatenate(chunks), sr


def midi(f0):
    return int(round(69 + 12 * np.log2(f0 / 440.0)))


def main(size="mrt2_small"):
    OUT.mkdir(parents=True, exist_ok=True)
    bench = {"size": size, "device": str(jax.devices()[0])}
    t0 = time.time()
    mrt = MagentaRT2Jax(size=size, temperature=1.0, top_k=40,
                        cfg_scales={"musiccoca": 3.0, "notes": 3.0, "drums": 1.0})
    bench["load_and_compile_s"] = round(time.time() - t0, 1)
    print(bench, flush=True)

    # --- speed: 10 s of free generation from a text prompt, after a 1 s warm-up ---
    style = mrt.embed_style("disco funk")
    mrt.generate(conditioning={MUSICCOCA.key: style}, frames=25)
    t0 = time.time()
    state = None
    for _ in range(10):
        wav, state = mrt.generate(conditioning={MUSICCOCA.key: style}, frames=25, state=state)
    gen = time.time() - t0
    bench.update(rtf=round(gen / 10, 3), x_realtime=round(10 / gen, 2), ms_per_frame=round(1000 * gen / 250, 1))
    print(bench, flush=True)

    # --- spike D on the 6 recreation targets ---
    summary = json.loads((C_OUT / "summary.json").read_text())
    recreate = {}
    for name, rec in summary.items():
        d = C_OUT / name
        ref, sr = sf.read(d / "reference.wav")
        looped = np.tile(ref, int(np.ceil(10 * sr / len(ref))))
        st = mrt.embed_style(audio.Waveform(looped[:, None].astype(np.float32), sr))
        note = midi(rec["true_f0"])
        frames = int(round(len(ref) / sr * FPS))
        rows = rolls_for([(note, 0.0, rec["gate"])], frames)
        t0 = time.time()
        y, out_sr = play(mrt, st, rows)
        took = time.time() - t0
        mono = resample_poly(y.mean(axis=1), sr, out_sr)[: len(ref)]
        mono = 0.8 * mono / max(np.abs(mono).max(), 1e-9)
        sf.write(d / f"mrt2_cuda_{size.split('_')[1]}.wav", mono, sr)
        recreate[name] = {"note": note, "seconds_to_generate": round(took, 2), "audio_seconds": round(len(ref) / sr, 2)}
        print(name, recreate[name], flush=True)
    bench["recreate"] = recreate

    # --- text prompts on a short MIDI phrase ---
    spb = 60 / BPM
    notes = [(p, s * spb, (s + l) * spb * 0.98) for p, s, l in PHRASE]
    pm = pretty_midi.PrettyMIDI(initial_tempo=BPM)
    inst = pretty_midi.Instrument(program=0, name="phrase")
    inst.notes = [pretty_midi.Note(velocity=100, pitch=p, start=a, end=b) for p, a, b in notes]
    pm.instruments.append(inst)
    pm.write(str(OUT / "phrase.mid"))
    total = int((8 * spb + 1.0) * FPS)
    phrase = {}
    for prompt in PROMPTS:
        st = mrt.embed_style(prompt)
        bass = "bass" in prompt
        rows = rolls_for([(p - 24 if bass else p, a, b) for p, a, b in notes], total)
        t0 = time.time()
        y, out_sr = play(mrt, st, rows, prime=FPS)  # 1 s primed with notes off, discarded
        took = time.time() - t0
        y = 0.8 * y / max(np.abs(y).max(), 1e-9)
        slug = re.sub(r"\W+", "_", prompt)
        sf.write(OUT / f"phrase_{size}_{slug}.wav", y, out_sr)
        phrase[prompt] = {"seconds_to_generate": round(took, 2), "audio_seconds": round(len(y) / out_sr, 2)}
        print(prompt, phrase[prompt], flush=True)
    bench["phrase"] = phrase
    bench["peak_vram_mb_jax"] = round(peak_vram_mb())
    (OUT / f"bench_{size}.json").write_text(json.dumps(bench, indent=2))
    print(json.dumps(bench, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:])
