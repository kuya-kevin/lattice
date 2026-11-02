# Spikes

Python experiments, one folder per question. `spikes/` is one uv project (`cd spikes && uv run python ...`);
models with clashing dependencies have their own projects under `../envs/` and `j_evals/envs/`.
Updated 2026-11-01. **Only `k_source_prep/` and the `f_engineer/quantize.py` it imports run in the
product, and they use one model, Meta Demucs. Everything else here is past research the app does
not call,** including its evaluations of non-Meta models.

**Status:** **live** = the app calls this code today. **ready** = works, waiting to be wired into
the app (backlog entry in brackets). **reference** = results recorded, kept for re-runs.
**dropped** = the approach lost; kept only for the record.

| Folder | Question | Status | Results |
|---|---|---|---|
| `muse.py` | thin Muse client for the spikes | reference | — |
| `ears.py` | measured features → text Muse can read | reference (used by `c_recreate`) | — |
| `a_ears/` | can Muse hear music? | dropped: speech-to-text only | `docs/spike-results.md` |
| `b_cleanup/` | which cleanup for phone voice notes? | **ready** (noisereduce) [B3]; DeepFilterNet dropped (`run_deepfilter.py` no longer runs: its env was removed) | `docs/spike-results.md` |
| `c_recreate/` | recreate a reference with a 15-knob synth + CMA-ES (+ Muse seed) | reference; removed from the app Nov 1 | `docs/spike-results.md` |
| `d_mrt2/` | Magenta RT2 as the sound engine (Mac, MLX) | dropped Nov 1: not Meta | `docs/spike-results.md` |
| `e_eval/` | blind A/B listening test server + analysis | reference | pair round: spectral distance 77% |
| `f_engineer/` | drum quantize and trim | **ready** [B3] | 12.5 → 4.5 ms off grid |
| `fx_verify/` | effects engine vs published references | reference (re-run after DSP changes) | `docs/fx-verification.md` |
| `g_pe_av/` | can PE-AV be Muse's ears? | reference (large not run) [B9] | `docs/spike-results.md` |
| `h_freesound/` | curate CC0/CC-BY Freesound sets | reference | `h_freesound/README.md` |
| `i_to_midi/` | first audio → MIDI pass (basic-pitch + key) | superseded by `k_source_prep`; its env (`envs/basicpitch`) was removed, so it no longer runs | `docs/spike-results.md` |
| `j_evals/` | GPU evals on the 3090: MRT2 CUDA, Audiobox, separation, transcription | reference (its `muscriptor` and `yourmt3` envs were removed Nov 1, so those evals no longer run; `env.sh` and the `amt`, `sep` envs are live) | `j_evals/README.md` |
| `k_source_prep/` | voice note → stems → MIDI (the `extract_midi` sidecar) | **live** | `k_source_prep/README.md` |
| `l_sam_audio/` | can SAM Audio GGUF (audio.cpp, text prompts) beat htdemucs_6s / Mel-RoFormer? | dropped: lost on every part, 8–12 GB VRAM vs ~1.5 GB | `l_sam_audio/README.md` |
| `m_cleanup_models/` | do the Mel-RoFormer denoise / dereverb models (audio-separator) beat noisereduce before audio → MIDI? | reference | `m_cleanup_models/README.md` |

New spike: next letter (`n_...`), a module docstring that states the question and how to run it,
results in a README or `docs/spike-results.md`, and a row here.
