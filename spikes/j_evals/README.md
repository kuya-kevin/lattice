# Spike J: GPU model evals on the 3090

RTX 3090 (24 GB), CUDA driver 13.2, run 2026-10-27. Every cache, venv, weight and output lives on
`<bigdisk>` (the root disk is nearly full). Outputs: `<bigdisk>/out-evals`.

## How to run

First `export LATTICE_BIGDISK=<bigdisk>` (the scripts refuse to run without it).

Each model family has its own uv project under `envs/<name>/` (their dependencies clash). The
virtualenvs live at `<bigdisk>/venvs/j-<name>`. `env.sh` sets the cache variables
and runs a command in one of them:

```bash
spikes/j_evals/env.sh mrt  python spikes/j_evals/mrt2_cuda.py mrt2_small   # and mrt2_base
cd spikes && uv run python j_evals/score_mrt2_cuda.py <bigdisk>/transfer/out/c_recreate
spikes/j_evals/env.sh amt  python spikes/j_evals/mrt2_phrase_check.py
spikes/j_evals/env.sh aes  python spikes/j_evals/aes_grader.py
spikes/j_evals/run_amt.sh synth     # synthetic set: build, separate, transcribe, score
spikes/j_evals/run_amt.sh real      # real material: separate, transcribe, listening package
```

MRT2 weights: `mrt models init` and `mrt checkpoints download mrt2_small|mrt2_base` inside the `mrt`
env (`MAGENTA_HOME` points them at the big disk). YourMT3+: code and the `YPTF.MoE+Multi (noPS)`
checkpoint are taken from the HF Space `mimbres/YourMT3` into `<bigdisk>/repos/YourMT3`:
`huggingface_hub.snapshot_download("mimbres/YourMT3", repo_type="space", local_dir=..., ignore_patterns=[...])`,
leaving out `examples/`, `mid/` and every `amt/logs/2024/*` folder except
`mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops` (562 MB). ByteDance piano checkpoint: Zenodo record
4034264, saved to `$TORCH_HOME/piano_transcription/`.

| Script | Env | What it does |
|---|---|---|
| `mrt2_cuda.py` | mrt | Magenta RT2 (JAX/CUDA): speed + VRAM; spike D on the 6 `c_recreate` targets; text prompts on a 2-bar MIDI phrase |
| `score_mrt2_cuda.py` | spikes | spectral distance of the new renders; adds `mrt2_cuda_*` to `summary.json` (backup `summary.before_j_evals.json`) |
| `mrt2_phrase_check.py` | amt | basic-pitch on the phrase renders, F1 vs the phrase |
| `aes_grader.py` | aes | Audiobox Aesthetics on every `c_recreate` WAV vs the Kev3090 pair ratings |
| `synth_set.py` | amt | synthetic phone-quality set with known MIDI (16 clips) |
| `inputs.py` / `stems.py` | amt | input lists for the other scripts |
| `separate.py` | sep | BS-RoFormer, Mel-RoFormer, htdemucs_6s via python-audio-separator |
| `transcribe.py` | amt | basic-pitch, basic-pitch + blip filter, pyin, ByteDance piano |
| `yourmt3_run.py` | yourmt3 | YourMT3+ batch transcription |
| `score_amt.py` | amt | mir_eval note F1 (onset 50 ms, offsets ignored) → `amt/f1.md` |
| `listen.py` | amt | MIDI + GM renders + A/B files for the real material |

## Results

See the final report in the session, mirrored here in short.

### Magenta RT2 runs on CUDA

The repo's JAX backend (`MagentaRT2Jax`, `pip install magenta-rt jax[cuda13]`) runs on the 3090
without changes. Small is 4.5× faster than real time (8.9 ms per 40 ms frame); base is 1.6× (24.7 ms).
Peak JAX memory is 5.5 GB for small and 14.5 GB for base. With preallocation off, nvidia-smi still
shows 15.3 / 17.4 GB, because the allocator keeps what it took. So base and YourMT3+ (12 GB) can't
share the card.

- **Spike D targets** (`mrt2_cuda_small.wav`, `mrt2_cuda_base.wav` in each `out/c_recreate/<target>/`;
  the listening server picks them up). Spectral distance stays at the starter-patch level, like
  the Mac MLX run. Base gave the best MRT2 result so far on the FM e-piano (1.13, vs optimizer 0.95).
  Note length is now partly respected. Small missed the acid bass pitch by 10.6 semitones, and base
  played the supersaw an octave low.
- **Text prompts on a 2-bar phrase** (`out-evals/mrt2/phrase_*.wav`). Note F1 of a basic-pitch
  transcription vs the phrase (onset 100 ms): base "lo-fi electric piano" 1.00, "solo piano" 0.80,
  bass 0.36, strings 0.39, synth lead 0.09. Small: 0.87 / 0.61 / 0.51 / 0.22 / 0.00. Keys prompts
  follow the MIDI closely; sustained and synth timbres follow it loosely.

### Audiobox Aesthetics is not a "closer to the reference" grader

Over the 47 decided Kev3090 pairs, "higher score wins" agrees with the ears 49-64% of the time
(CU best at 30/47, p = 0.04). Reference-aware (4-axis vector nearest the reference's): 34/47 (72%).
Spectral distance gets 36/47 (77%). Without the hidden-reference pairs (the easy ones for any
reference-aware metric), spectral distance gets 23/32 (72%, p = 0.01). Audiobox nearest-reference
gets 21/32 (66%, p = 0.055), and the raw axes are at chance. Thumbs-up AUC: PC 0.66, the others
about 0.5. So keep spectral distance as the self-check. Audiobox is fast (120 s of audio in 1.3 s,
2.4 GB) but doesn't track this rater's judgements.

### Audio to MIDI: synthetic phone set (`out-evals/amt/f1.md`)

The full table is in `f1.md` (16 clips; mean of 4 per row). In short:
- **Keys (piano/EP):** YourMT3+ 0.90 on phone audio (clean 0.89). ByteDance piano 0.96 clean but
  drops to 0.76 on phone audio. basic-pitch 0.78.
- **Bass:** pyin 0.98 clean, 0.82 phone; basic-pitch 0.84 on phone. YourMT3+ is weak (0.50 on phone).
- **Hum (voice/flute, detuned with vibrato):** pyin 0.66 on phone audio; YourMT3+ 0.47; basic-pitch
  0.36. Putting Mel-RoFormer vocals first, as a denoiser, lifts basic-pitch to 0.55 and YourMT3+
  to 0.66.
- **Layered (hum + piano + bass), phone audio:**
  - The whole mix with YourMT3+ gets 0.79 over all parts. Its instrument labels are fine on clean
    audio (bass 0.96, hum 0.61, keys 0.81), but on phone audio it mislabels the bass (0.06).
  - Separating first works best for the melody: Mel-RoFormer vocals → ByteDance or basic-pitch
    reaches 0.81 / 0.78 for the hum part. BS-RoFormer vocals → basic-pitch gets 0.44.
  - htdemucs_6s bass → pyin or basic-pitch gets 0.79 / 0.78. htdemucs_6s piano → YourMT3+ gets 0.71.

Caveat: the synthetic timbres are GM SoundFont samples (TimGM6mb), not real voices; 4 clips per cell.
TimGM6mb's whistle preset plays about 10 semitones flat, so a flute stands in for the whistle.

### Real material (`out-evals/listen/<clip>/`, no ground truth)

Each folder has `input.wav`, every transcription as `.mid` plus a GM render, `mix__*.wav`
(the render on the left channel, the input on the right, for A/B), and the stems with their
transcriptions. Note counts and ranges are in `listen/summary.json`.
- **Clean hum (143, melody around F#4):** YourMT3+ gives 41 notes in C#4-A4. The result is the same
  on the raw file and on all three vocal stems. basic-pitch and pyin add low junk (A#1).
- **Noisy, low notes (112, 114):** every model produces hundreds of notes. These need the cleanup
  and key-snap step whatever the model.
- **Very quiet note (119):** basic-pitch, pyin and YourMT3+ find 34-62 notes; ByteDance finds none.
- **Piano voice note (146):** YourMT3+ splits it into piano (143 notes) and voice. Mel-RoFormer
  "other" and htdemucs "piano" stems give a cleaner piano part (~120 notes).
- **Drum loop (`vn-drum-loop`) and beatbox:** YourMT3+ finds almost no drum hits: 0 on the raw file,
  2 on the htdemucs drums stem, 10 on the Freesound "Hiss Beat". Drums from voice notes need an
  onset/drum-class detector rather than these models.
- **Solo bass (Freesound 511097 FunkyBass):** YourMT3+ returns nothing; pyin and basic-pitch give
  36-41 notes in A1-A2. This matches its weak bass score on the synthetic set.
- **Whistle (699254):** YourMT3+ returns 0 notes; pyin gives 92.

## Per-model summary

| Model | Licence | VRAM (peak) | Speed (RTF, lower is faster) | Setup | Result |
|---|---|---|---|---|---|
| Magenta RT2 small (JAX/CUDA) | code Apache-2.0, weights CC-BY-4.0 | 5.5 GB JAX (15 GB reserved) | 0.22 (4.5× real time) | easy, ~10 min (official `jax[cuda13]` path) | runs; piano-like prompts follow MIDI |
| Magenta RT2 base (JAX/CUDA) | same | 14.5 GB JAX (17 GB reserved) | 0.62 (1.6× real time) | same, 7 GB of weights for both | best MRT2 on the e-piano target; phrase F1 up to 1.0 |
| Audiobox Aesthetics | CC-BY-4.0 (code + weights) | 2.4 GB | ~0.01 | easy; needed `requests` and tensors passed in (torchaudio wants torchcodec/ffmpeg) | not a closeness grader (see above) |
| BS-RoFormer (viperx 1297) | code MIT (audio-separator, lucidrains); weights no stated licence | 1.6 GB | 0.46 | easy once ffmpeg was supplied (imageio-ffmpeg) | weaker than Mel-RoFormer on hum (0.44 vs 0.78 F1 after) |
| Mel-RoFormer (Kim vocals) | MIT (HF card) | 2.0 GB | 0.08 | easy | best vocal/hum isolation for transcription |
| htdemucs_6s | MIT | 0.6 GB | 0.08 | easy | good bass stem (0.79 F1 after); piano stem fair |
| YourMT3+ (YPTF.MoE+Multi noPS) | GitHub repo GPL-3.0, HF Space says Apache-2.0: treat as GPL (run as a separate process) | 12-13 GB (fp16, batch 8) | 0.04-0.13 | medium, ~20 min (Space code, pinned numpy/transformers, wandb import) | best on keys and layered mixes; weak on bass and whistle; no drums from voice notes |
| MT3 (original) | Apache-2.0 | n/a | n/a | skipped: t5x/seqio/Colab-era JAX stack, well past 45 min | YourMT3+ supersedes it |
| ByteDance piano (Kong et al.) | no LICENSE file on GitHub; check before shipping | 0.3 GB | 0.08-0.12 (incl. resampling) | easy (fetch the checkpoint ourselves; it would wget into ~) | 0.96 on clean piano, 0.76 on phone audio; best after Mel-RoFormer for hum |
| basic-pitch (ONNX, CPU) | Apache-2.0 | CPU | 0.009 | medium: Linux pin pulls TensorFlow, overridden; scipy shim | good all-rounder on phone bass/keys, poor on hum |
| pyin (librosa) | ISC | CPU | 0.13 | none | best on monophonic hum and bass |
