# l_sam_audio: can SAM Audio (text-prompted separation) beat our fixed-stem separators?

**Answer (2026-10-27): no. Dropped.** We keep htdemucs_6s + Mel-RoFormer (`k_source_prep`).
SAM lost to them on every part we could score. It needs 8–12 GB of VRAM where they need about
1.5 GB, and on voice notes the prompt wording sometimes pulls out the wrong instrument. The user's
listening check on 6 real voice notes agreed: htdemucs sounds better.

## Setup

- **audio.cpp v0.9.3**, built from source. The prebuilt Linux tarball has only the server and
  needs a missing `libnccl.so.2`. Built with gcc-13 + CUDA 12.4 and `CMAKE_CUDA_ARCHITECTURES=86`.
  Binary: `<bigdisk>/repos/audiocpp-src/build/bin/audiocpp_cli`.
- **Weights:** `audio-cpp/SAM-Audio-GGUF`, Q8_0 small / base / large, in `<bigdisk>/models/sam-audio-gguf/`.
  SAM License.
- **The audio.cpp output is always watermarked**, with no flag to turn it off (codec watermark in
  `src/models/sam_audio/codec.cpp`). The model card says a final build drops it.
- **Output** is mono 48 kHz `target.wav` + `residual.wav`. SAM is generative, so target + residual
  only matches the input to about -10 dB. That is expected, recorded and not used as a check.
- **Memory grows with clip length.** A 78 s clip needed a 16 GB decoder buffer and ran out of
  memory, so `run_sam.py` splits anything longer than 25 s into 20 s chunks with a 1 s crossfade.

## Scripts (run with `spikes/j_evals/env.sh amt python ...`, `LATTICE_BIGDISK` set)

| Script | What |
|---|---|
| `truth_stems.py` | true hum / keys / bass stems for the 4 synthetic layered clips, by replaying `j_evals/synth_set.py`'s seeds. Check: the stems sum to the mix within -72 dB. |
| `score.py jobs` / `score.py table` | job lists (2 fixed prompts per part); SI-SDR table → `$LATTICE_OUT/sam/si_sdr.md` |
| `run_sam.py jobs.json small [base large]` | runs the CLI per job; logs wall time, peak VRAM, target + residual vs input |
| `listen_pack.py jobs` / `pack` | voice notes 112, 114, 119, 143, 145, 146 through htdemucs_6s and SAM small (5 prompts) → `$LATTICE_OUT/listen_sep/vn_<n>/` (plus a local `index.html` player) |

Baselines come from `j_evals/separate.py` (sep env).

## Results

SI-SDR, in dB; higher is better. Each cell is the mean over clips. "input" is the unseparated mix,
which is the floor to beat. The SAM columns take the better of the two prompts.

**Synthetic layered voice notes** (4 clips: SoundFont hum + piano + bass, phone chain):

| part | input | htdemucs_6s | Mel-RoFormer | SAM small | SAM base | SAM large |
|---|---|---|---|---|---|---|
| hum | -1.2 | 3.6 | **5.0** | 4.8 | 4.0 | -25.7 |
| keys | -8.8 | **-2.2** | — | -6.3 | -5.0 | -10.7 |
| bass | -9.4 | **-1.2** | — | -1.6 | -1.4 | -1.4 |

**MUSDB18** (first 8 test tracks, 7 s excerpts, Zenodo 3270814, local only):

| part | input | htdemucs_6s | Mel-RoFormer | SAM small | SAM base | SAM large |
|---|---|---|---|---|---|---|
| vocals | -5.2 | 8.7 | **11.7** | -5.0 | 1.2 | 4.1 |
| bass | -4.6 | **7.9** | — | 0.2 | 5.6 | 7.4 |
| drums | -4.8 | **7.8** | — | 0.7 | 2.2 | 2.4 |

Prompts were fixed before the run: hum "singing voice" / "humming", keys "piano" / "piano
chords", bass "bass guitar" / "bass", vocals "singing voice" / "vocals", drums "drums" / "drum kit".

**Speed and memory:**

| | peak VRAM | speed |
|---|---|---|
| htdemucs_6s | 0.6 GB (torch peak) | ~16× real time |
| Mel-RoFormer | 1.1 GB (torch peak) | ~15× real time |
| SAM small / base / large | 9.8 / 10.4 / 12.3 GB (nvidia-smi) | ~2–3 s per clip of 24 s or less, model load included; ~6× real time on long notes |

## What we saw

- **On voice notes SAM either succeeds or misses entirely.** Per clip, hum scores are either about
  +4 to +5 or about -30 to -60. At -30 to -60 SAM has extracted a different part, usually the
  bass. "humming" pulled out the bass on 3 of 4 clips with small. Large missed the hum on 3 of 4
  clips even with "singing voice".
- **On real songs, bigger SAM is better but still behind.** Large on bass comes within 0.5 dB of
  htdemucs, but vocals and drums are 5–7 dB behind.
- **Listening (M4):** the user compared htdemucs and SAM small on 6 real voice notes and judged
  htdemucs better.
- **Caveats:**
  - The synthetic "hum" is a General MIDI voice preset, not a person.
  - The MUSDB excerpts are short and not curated.
  - SAM small's output is mono, while htdemucs keeps stereo.
  - None of these would close the gap.

## If it comes back

SAM's only real advantage is open prompts for parts no fixed stem covers, such as "kick" or "shaker".
That was not tested by ear. Revisit if the demo needs isolation by description. Start with large on
short clips and two fixed prompts, and score against the fixed stems first.
