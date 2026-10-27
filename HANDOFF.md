# Lattice handoff (end of day 1, 2026-10-26)

**Moving to:** the 3090 machine for evals. The direction and the full spike results are in `idea.md` §0 (§0.8 = day-1 results). The map of which model does which job is in `Lattice Model Map.md`.

## Moving the repo

- **Nothing is committed** (rule: stage only, the owner reviews). 83 files are staged on the Mac. To move, either commit and push from the Mac yourself, or copy the folder.
- **Git-ignored, so it doesn't travel with git:**
  - `.env`: Meta, Freesound and HF keys. Copy it by hand over a secure channel.
  - `data/` (39 MB): voice notes and the Freesound set.
  - `out/` (98 MB): generated audio, ratings, separated stems. 53 MB of that is the Demucs model cache in `out/separate/models`, which can be re-downloaded.
- **Copy command:**
  ```
  rsync -a --exclude .venv --exclude node_modules --exclude 'out/separate/models' lattice/ <3090>:lattice/
  ```
- **On the 3090:** run `uvx hf auth login` again. SAM Audio access is still awaiting Meta's approval.

## Rules that still apply

- Never `git commit`; stage only.
- Meta budget is **$150 for the whole hackathon**; about $0.03 spent so far. Use `muse-spark-1.3-contributor` (contributor mode approved). Test with a few calls before any batch.
- **Muse can't hear music.** Its audio input is speech-to-text (verified). Don't pay for Muse audio calls on music.
- Copyrighted reference snippets stay local and out of the repo and demo. The Freesound set is CC0/CC-BY only, with attribution in `data/freesound/README.md`.

## Status by part

| Part | State | Where |
|---|---|---|
| Mini-DAW (Electron + web) | Working: tracks, trim, record, punch-in, click/count-in, tempo/key/time-signature bar, GarageBand shortcuts, Muse chat panel. 34 Vitest + 10 Playwright tests, all offline. | `app/` (`npm install`, `npm run dev` or `npm run dev:web`) |
| Muse tool calling | Working. OpenAI-format tools against the Meta API; sees session state and the user's hand edits. Recorded fixtures for tests. | `app/src/core/agent.ts`, `app/src/node/muse.ts` |
| Placeholder tools in app | quantize, cleanup, Magenta RT2, synth knobs, fit-to-reference, ears. Real versions are the spikes below. **Next build step: wire them in through a Python sidecar.** | `app/src/core/sidecar.ts` |
| Noise cleanup | Working (noisereduce, stationary, with a noise profile). | `spikes/b_cleanup/` |
| Synth + optimizer (recreate) | Working. Your top pick by ear (liked 64, "start from this" 6/13). Muse + optimizer is a close second (66). | `spikes/c_recreate/` |
| Magenta RT2 | Works on the Mac (MLX, mlx==0.31.1 pinned). Captures the vibe, not a copy (liked 43). **Mac-only env**; on NVIDIA use the `jax` backend if needed. | `spikes/d_mrt2/`, `envs/mrt/` |
| Listening test | Now pairwise ("which is closer, A or B") plus a thumbs-up for "I'd use this". **Not rated yet in pair mode.** | `spikes/e_eval/` |
| Drum quantize + trim | Working. Your loop: 12.5 → 4.5 ms off the 1/16 grid. Needs a listen. | `spikes/f_engineer/` |
| PE-AV ears (Meta) | Partial results; see below. | `spikes/g_pe_av/`, `envs/ears/` |
| Freesound reference set | 144 CC0/CC-BY one-shots, 18 categories, train/test split. Use `fs_note_name`, never `fs_pitch` (wrong 69/80). | `spikes/h_freesound/`, `data/freesound/` |
| Piano separation | Working: Demucs htdemucs_6s (Meta) put 91% of note 146 in the piano stem. | `envs/separate/` (CLI), `out/separate/` |
| Audio → MIDI + key | Acceptable ("good enough to edit"): basic-pitch, 132 notes, G minor; rare out-of-key notes snapped. | `spikes/i_to_midi/`, `envs/basicpitch/` |

Each Python env is its own uv project: `spikes/` (main), `envs/{mrt,ears,separate,basicpitch,denoise}`. Run `uv sync` in each one you need on the new machine.

## Evals to run on the 3090

1. **PE-AV ears, small/base/large:**
   ```
   cd spikes && ../envs/ears/.venv/bin/python g_pe_av/test_ears.py ../out/c_recreate facebook/pe-av-large
   ```
   - **What it tests:** knob sweeps on our synth; agreement with ratings; Freesound category accuracy (top-1/top-3 of 18); correlation with Freesound's brightness/warmth/roughness/hardness.
   - **Memory:** it now auto-picks CUDA, runs fp16, batches 4 clips capped at 5 s. The old version hit 17 GB on the Mac.
   - **Known `transformers` 5.21 workarounds in the code:** `ignore_mismatched_sizes=True`, because the video tower's head mismatches and we don't use video; and a hand-rolled text embedding, because `get_text_audio_embeds` is broken.
   - **Results so far (knob sweeps, Spearman ρ):**

     | Knob | small | base |
     |---|---|---|
     | drive | +1.00 | +1.00 |
     | resonance | −1.00 | +1.00 |
     | attack | +0.96 | +0.86 |
     | detune | +0.50 | +0.75 |
     | cutoff | +0.61 | +0.18 |
     | noise | 0.00 | +0.14 |

     Base tracks 4 of 6. Large and the Freesound test haven't run yet.
2. **Alternative ears, to compare on the same test:**
   - MusicCoCa (already in `envs/mrt`; Mac-only there)
   - LAION or Microsoft CLAP
   - Qwen3-Omni-30B-A3B-Captioner, for free-form descriptions (30B; check its "other" licence first)
3. **SAM Audio (Meta)**, once access is approved: the official CUDA weights; try text prompts ("piano", "humming", "kick") on note 146 and the drum loop. Ungated MLX copies exist for the Mac (`mlx-community/sam-audio-small`, 2.4 GB), under the same SAM License.
4. **Piano transcription accuracy:**
   - Build a synthetic phone-quality set: known MIDI → piano render → room noise, mic EQ and compression, plus humming on top.
   - Score basic-pitch against a piano specialist (ByteDance piano transcription, or Magenta's Onsets and Frames) with mir_eval note F1 (onset ±50 ms).
   - Optional: the owner records 4 known clips (C major scale, I–V–vi–IV, a known melody, one fast passage).
5. **Pair-rating round:**
   ```
   cd spikes && uv run python e_eval/server.py ../out/c_recreate
   ```
   Open http://localhost:8765 with a new rater name, then run `uv run python e_eval/analyze.py ../out/c_recreate`. It reports per-method win rate, thumbs-ups, and how often the spectral distance picks your winner.

## Open decisions

- **Ears:** PE-AV size; whether to pair it with direct measurement for brightness and noise, which it misses.
- **Self-grading:** whether any automatic score is good enough for the agent to grade its own attempts. The pair round decides; until then, human ears stay in the loop.
- **Sidecar design:** how the app calls the Python tools (one long-running local HTTP/stdio process is the plan in `idea.md` §0.4).
