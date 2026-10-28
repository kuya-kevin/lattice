# Spike M: learned cleanup models vs noisereduce, before audio to MIDI

Run 2026-10-28 on the Mac (M2 Pro, 16 GB, MPS). Question: do the community Mel-RoFormer denoise /
dereverb models (found via the UVR5 UI Space; loaded with python-audio-separator, already in the
j_evals `sep` env) beat noisereduce as cleanup in front of `extract_midi`, and do they sound better?

## Result

**Don't clean before transcription.** On the 16 synthetic phone clips, raw audio scores best (note F1
0.80). Every cleanup loses, mostly on the hum/melody, because the sidecar's Mel-RoFormer vocal split
already acts as a denoiser for the melody and cleaning first strips the voice. Cleanup also changes the
router's content guess (layered → keys, hum → layered), which costs more.

Through the whole sidecar (router picks the content):

| variant | hum | bass | keys | layered | all 16 | cleanup RTF (MPS) |
|---|---|---|---|---|---|---|
| raw | 0.65 | 0.97 | 0.79 | 0.79 | **0.80** | - |
| gate (`prep.py --denoise`) | 0.66 | 0.84 | 0.84 | 0.49 | 0.71 | ~0 |
| nr (noisereduce, stationary) | 0.54 | 0.89 | 0.80 | 0.16 | 0.59 | 0.01 |
| mr_denoise (aufr33) | 0.50 | 0.97 | 0.76 | 0.14 | 0.59 | 0.86 |
| mr_dereverb (anvuew) | 0.66 | 0.98 | 0.79 | 0.80 | 0.81 | 0.51 |
| mr_both | 0.50 | 0.97 | 0.76 | 0.14 | 0.59 | 1.36 |

Mode forced to the true category (`score.py --true-mode`), so only the effect on transcription is left:

| variant | hum | bass | keys | layered | all 16 |
|---|---|---|---|---|---|
| raw | 0.65 | 0.97 | 0.79 | 0.79 | **0.80** |
| gate | 0.66 | 0.94 | 0.84 | 0.58 | 0.75 |
| nr | 0.13 | 0.96 | 0.80 | 0.45 | 0.58 |
| mr_denoise | 0.45 | 0.97 | 0.76 | 0.51 | 0.67 |

Note F1: mir_eval, onset 50 ms, offsets ignored (as `j_evals/score_amt.py`); classic transcribers
(basic-pitch / pyin), not MuScriptor. Layered = mean of hum/bass/keys, a missing part counts 0.

- **Keys is the only part cleanup helps** (gate +0.05). Not enough to turn it on by default.
- **mr_denoise beats noisereduce for the melody** when the mode is known (0.45 vs 0.13 hum, 0.51 vs 0.45
  layered): noisereduce wipes the hum entirely on 2 of 4 hum clips and on every layered melody.
- **The dereverb model does nothing here.** `dereverb_mel_band_roformer_anvuew_sdr_19.1729` changes
  the audio by -40 dB (vs -11 to -23 dB for the denoiser), so its F1 equals raw. It is a stereo model
  fed dual-mono; our voice notes and Freesound sets are all mono. Best guess (untested): it needs
  stereo cues, so it may still help on a stereo song or a vocal stem pulled from one.
  The mono variant (`dereverb_mel_band_roformer_mono_anvuew`, stems "Unknown" in audio-separator)
  isn't usable as-is: which output is the dry one flips from clip to clip, and the better output
  only beats raw by about 0.3 dB SI-SDR against the pre-reverb render.
- **Speed on MPS:** the denoiser runs at 0.86x real time (a 20 s note takes ~17 s), noisereduce at 0.01x.
  Weights: 1.7 GB for both models.
- **Side finding (sidecar, not cleanup):** `hum_2` scores 0 on raw because quantize snaps every note
  to a grid offset by 53 ms, just past the 50 ms onset tolerance. The notes are right; the grid
  phase is off.

**Listening (Oct 28, the builder):** the only clear difference is on the synthetic layered clip, where
mr_denoise sounds clearly better. On the real voice notes it is at most slightly better than the others.

**For B3 (`cleanup_noise`), decided Oct 28 by the builder:** mr_denoise is the default (they prefer
how it sounds), with a progress indicator since it takes ~17 s per 20 s note on MPS plus model load;
noisereduce (~0.2 s) is the fast fallback when the model isn't installed or fails. Either way it cleans
the audio the musician hears; `extract_midi` keeps reading the raw take. mr_denoise weights have no
stated licence: opt-in download, separate process, a row in the licence watchlist.

## How to run

```bash
export LATTICE_BIGDISK=~/lattice-data   # every venv, cache, weight and output goes here
spikes/j_evals/env.sh amt python spikes/j_evals/synth_set.py                   # synthetic phone set (once)
spikes/j_evals/env.sh sep python spikes/m_cleanup_models/clean.py models       # raw + Mel-RoFormer variants
(cd spikes && uv run python m_cleanup_models/clean.py nr)                      # noisereduce variant
spikes/j_evals/env.sh amt python spikes/m_cleanup_models/score.py              # sidecar + F1 -> out-m/f1.md
spikes/j_evals/env.sh amt python spikes/m_cleanup_models/score.py --true-mode  # mode forced -> out-m/f1_mode.md
spikes/j_evals/env.sh amt python spikes/m_cleanup_models/listen.py             # out-m/listen/index.html
```

Each script takes `--pilot` (one input) and appends one JSON line per job to a log in `out-m/`; reruns
of `score.py` skip jobs already logged ok. The `sep` env now installs on the Mac:
`audio-separator[gpu]` on Linux, `[cpu]` on macOS (torch picks MPS; the lockfile change is markers only).

## Licences

| Piece | Licence |
|---|---|
| python-audio-separator | MIT |
| `denoise_mel_band_roformer_aufr33_*`, `dereverb_mel_band_roformer_*anvuew*` | community weights, no stated licence (like the viperx BS-RoFormer); opt-in, separate process |
| noisereduce | MIT |
| UVR5 UI (where the model names came from) | non-commercial (INCU); no code taken |
