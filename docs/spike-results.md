# Spike results (day 1, 2026-10-26)

Code in `spikes/`, outputs in `out/` (git-ignored). Direction is in `../idea.md`; which model does which job is in `model-map.md`.

Code in `spikes/` (uv project; `envs/denoise` and `envs/basicpitch` held tools whose dependencies clash; both were removed Oct 27 (superseded by `spikes/j_evals/envs/amt`)). Outputs in `out/` (git-ignored). Test material: 4 of the builder's voice notes (`data/`, git-ignored).

**Credentials:** Meta key (`META_MODEL_API_KEY`) and Freesound key are in `.env` and both verified. HF login done; access to `facebook/sam-audio-small`/`-large` requested, awaiting Meta's review. **Meta budget: $150 for the 10 days.** Muse Spark 1.2 is $1.25 / $4.25 per M input/output tokens; a short audio-plus-question call is about 1.1k tokens (mostly reasoning), so ~$0.005. Contributor mode is ~12× cheaper but lets Meta train on what we send (not decided).

**A. Can Muse hear? No: its audio input is speech-to-text.** Tested on `muse-spark-1.2`, the model the docs recommend for audio, with the documented `input_audio` format, plus the Responses API with a data URI; ~10 calls, ~$0.05.
- **Synth notes:** dropped at 16, 22.05 and 48 kHz. The prompt tokens matched the text alone (43), and Muse replied "As a text-based AI I can't hear…" or said it saw "a line of dashes" or "musical note symbols".
- **Spoken clip (macOS `say`):** transcribed word for word.
- **Beatbox voice note (150):** "I can't listen to audio".
- **Reading:** prompt tokens grow only by roughly a transcript's length, so the model receives text, not sound.

`run_ears.py` and the Muse versions of C were not run; they would pay for Muse to guess blind. **Consequence:** Muse is still the voice and planner: spoken instructions ("make it gritty") work, and it reasons over text. The ears have to come from our own analysis (pitch, envelope, brightness, noise, motion → a text summary Muse reads, plus the spectral distance) and/or an audio embedding (MRT2's MusicCoCa).

B. Cleanup.
- **DeepFilterNet: out.** Trained on speech, so it treats hums and beatboxing as noise: removed ~35-43 dB of the *performance* along with the noise.
- **noisereduce, non-stationary: too aggressive** (-15 dB on the performance of noisy notes).
- **noisereduce, stationary with a noise profile from the quietest 0.5 s: adopted.** Noise floor -6 to -16 dB, performance -0.2 to -2.3 dB, pitch untouched, ~0.2 s per 30 s note. Weak on the noisiest hum (`146`: only -6 dB), which is the case to try SAM Audio on. Product idea: the engineer picks the noise-profile region.

**C. Recreating a sound with signal processing (optimizer only so far).** 15-knob subtractive synth (`synth.py`), CMA-ES search (~2,400 renders, ~30 s per sound) on 3 targets from our own synth (true knobs known) and 3 it can't make exactly (FM e-piano, plucked string, chorus+reverb lead).
- Closes most of the gap: distance ~1.5 (default patch) → ~0.7-1.0.
- On supersaw and pad it reaches the metric's floor (re-rendering the *true* patch with new oscillator phases scores the same or worse). The acid bass (resonant filter sweep) stays far off (0.70 vs floor 0.21).
- Knob recovery is poor (2-8 of 15 within 10%): many knob settings sound alike. Fine for a starting point you then tweak, not for "1:1".
- **Metric:** a log-spectrogram distance preferred the wrong octave even after a full search; switched to a DDSP-style linear+log multi-resolution distance (right octave 3/3 in a direct test). Still sensitive to unison phase.
- **Pitch must come from measurement + confirmation (Muse or the human), not from the search.** pyin reads a sub-oscillator patch an octave low; when the synth can't make a timbre (FM, pluck), the search prefers the wrong octave. Product: an explicit "pitch/octave" confirm step.
- Muse conditions written, not run (`run_muse.py`): Muse sets knobs by ear → hears its render and revises once → its patch seeds the search with the knobs it is sure about held fixed.

**E. Listening test.** Built (`e_eval/`): local stdlib server + one static page, blind and randomized, loudness-matched, hidden reference, keyboard shortcuts, ratings to `out/eval/ratings.jsonl`; `analyze.py` reports per-method similarity and whether the spectral distance agrees with ears. Run: `cd spikes && uv run python e_eval/server.py ../out/c_recreate` → http://localhost:8765. Candidates so far: `optimizer`, `default`, `anchor_random` (+ hidden reference); Muse, MRT2 and Freesound candidates drop in as extra WAVs.

E. First ratings (2026-10-26, 1 rater, 6 sounds):
- **Average similarity:** optimizer 60 ± 25, starter patch 40 ± 23, random patch 41 ± 16, MRT2 38 ± 18; the hidden reference got 100 on all six, so the rater is consistent.
- **Optimizer:** best on 4 of 6 (supersaw 71, chorus lead 82, pluck 65, pad 76). It failed badly on the acid bass (6/100), which was one of its *best* distances.
- **MRT2:** about random on average, but marked "start from this" on the e-piano and the acid bass.
- **Automatic scores don't track ears:** spectral distance gives Spearman ρ = −0.26 (p = 0.22); MRT2's own style model (MusicCoCa cosine, `d_mrt2/musiccoca_vs_ratings.py`) gives ρ = +0.12 (p = 0.56).
- **Consequence:** neither can be the agent's self-check yet. The human's ears and picks drive the loop, and automatic scores are hints only (small sample; re-check with more raters).

**C with Muse via text ears (Muse reads measurements, `muse-spark-1.3-contributor`, 12 calls total, ~$0.012).** Spectral distance on the 6 targets, before human rating:
- **Muse alone:** 1.06–1.55, better than the starter patch (1.25–1.67) on all six but well behind the optimizer.
- **One revision from a text diff:** helped on 3 of 6 and made it worse on 3.
- **Optimizer seeded with Muse's patch (Muse-certain knobs frozen):** best of any method on 3 of 6, including the acid bass (0.35 vs 0.70 for the optimizer alone), and about equal on the rest.
- **Caveat:** spectral distance didn't track ears in round 1, so rating round 2 decides.

**Direction after A (user, 2026-10-26):** since Muse can't hear, sound design moves to Magenta RT2. The text-ears approach (`spikes/ears.py`, a measured description Muse reads) is shelved; it was only sanity-checked on our own synth, one knob at a time. Muse stays the voice and planner and runs the engineer tools; Meta models must stay central for the hackathon.

**Extra: hum → MIDI.** basic-pitch on a phone hum gives ~150 overlapping notes in 33 s (it's polyphonic); a monophonic pyin pass gives 43 notes but with octave jumps and A/A♯ wobble. Needs a cleanup step (smoothing, octave fix, snap to key, where Muse can pick the key) before it can drive a synth.

**D. Magenta RT2: plays notes in the right style, but doesn't recreate the sound.** `mrt2_small` (230M, MLX) downloads without a login. It only loads with `mlx==0.31.1`, the version its `.mlxfn` was exported with; newer MLX fails with "Invalid string size" (`envs/mrt`). It generates about 2× faster than real time on the M2 Pro (~0.9 s per 2 s).
- **Setup:** the reference audio is the style prompt; the piano roll plays the reference's note for its length (`d_mrt2/run_mrt2.py`).
- **Style prompt:** a lone 2 s note embeds badly, giving mostly wrong pitch. Looping it to 10 s fixed pitch on 5 of 6 targets, ±11 cents.
- **Distance:** 1.4–1.8, about the starter patch's level (1.3–1.6) and well behind the optimizer (0.7–1.2).
- **Note length:** ignored; notes ring the full 2 s.
- **Text prompt check:** with "solo piano" or "analog synth lead" it follows the requested note's pitch class, sometimes an octave down.
- **Reading:** a vibe or texture instrument ("in the style of"), not a 1:1 recreation; ears decide (`mrt2.wav` is in the listening test).

**DAW base (research):** [waveform-playlist](https://github.com/naomiaro/waveform-playlist) is MIT, TypeScript, and available as React or Web Components. It already has multitrack clips with trim handles, fades, AudioWorklet recording with punch-in, Tone.js effects and WAV export, and is tested with Playwright: the simple base to build on. [openDAW](https://github.com/andremichelle/openDAW) is AGPL, a full browser DAW with a community MCP server of hundreds of tools: reference only.

**Next:** rate the first round (now including MRT2); text-based ears for Muse (feature summary) and re-run C's Muse versions with those; drum quantize and trim; hum cleanup; SAM Audio once access is approved; Freesound targets.

## API facts verified 2026-10-26

(Muse audio claims here were later disproved: see A above.)


**Muse Spark** ([models](https://dev.meta.ai/docs/models), [video/audio](https://dev.meta.ai/docs/video-understanding), [files](https://dev.meta.ai/docs/file-handling)):
- `muse-spark-1.3` / `1.2` / `1.1`: input text, image, video, audio, PDF; **output text only**; 1M-token context.
- 1.3 audio: "not fully supported… quality may be degraded". Use **1.2** for audio.
- Audio formats: **WAV, MP3**. Inline up to 50 MB; Files API up to 1 GiB.
- API: `https://api.meta.ai/v1`, Responses and Chat Completions protocols, parallel tool calls, streamed tool-call args. Content part `{"type":"input_audio","input_audio":{"data":<b64>,"format":"wav"}}`.
- **Unverified:** how well it understands *music* (docs show speech/video examples only). This decides whether `audition` is real or a gimmick.

**Magenta RealTime 2** ([Google page](https://magenta.tensorflow.org/mrt2); [third-party summary](https://mer.vin/2026/06/magenta-realtime-2-open-local-live-music-model-with-midi-and-200ms-latency/)):
- Inputs: MIDI (held notes/chords → ensemble following the harmony; controller modulation), text prompt → playable instrument, short audio clip → cloned instrument; text and audio prompts blendable.
- 48 kHz stereo. Base ≈ 2.5 GB weights (**needs M3 Pro / M2 Max or better**), Small ≈ 450 MB (any Apple Silicon Mac).
- Ships as standalone apps, an **AU plugin** (so it should run in Logic), Max/PureData/SuperCollider extensions, and an open-source framework on GitHub for custom apps.
- **Dev Mac is an M2 Pro, 16 GB → Small model.** No official Linux/NVIDIA support, so the 3090 box can't run it (as far as the docs say).
- **Unverified:** ~200 ms control latency (spec + third-party claim, not on Google's page); license (third-party: CC-BY-4.0 weights, Apache-2.0 code; check the Hugging Face card); how a custom app drives it (pip/MLX/C++?).

## Pair-rating round (2026-10-26, on the 3090, rater "Kev3090", 56 pairs)

"Which is closer to the reference, A or B?" plus a thumbs-up for "I'd use this".

| Method | Closer (win rate) | Thumbs-up |
|---|---|---|
| hidden reference | 87% of 15 | 5/15 |
| **Muse patch + optimizer** | **69% of 16** | 3/16 |
| Muse alone | 62% of 12 | 2/12 |
| Muse, one revision | 50% of 15 | 1/15 |
| optimizer alone | 46% of 13 | 3/13 |
| MRT2 | 31% of 13 | **6/13** |
| random patch | 27% of 15 | 4/15 |
| starter patch | 23% of 13 | 0/13 |

- **Spectral distance now agrees with the ears: same winner in 36/47 decided pairs (77%; chance is 50%, p ≈ 0.0002 one-sided binomial).** Round 1's disagreement came from asking "do I like it" instead of "is it closer". So the distance is usable as the agent's self-check for "closer to a reference" (one rater; confirm with another).
- Muse seeding the optimizer is the best recreation method. Muse alone beats the optimizer alone in pairs, unlike the slider round.
- MRT2 is rarely closest but gets the most "I'd use this": a vibe generator, not a recreator.
- Run: `cd spikes && uv run python e_eval/analyze.py ../out/c_recreate`.
