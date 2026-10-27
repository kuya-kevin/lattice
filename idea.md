# Lattice: idea handoff

**Status:** reworked 2026-10-26 (see §0, which supersedes §1 and §7 where they conflict). Day-1 spikes in `spikes/`, results in §0.8.
**Hackathon:** Meta Global AI Developer Hackathon, Oct 26 - Nov 4 2026 (submit by **Nov 4, 9:00 PM ET**), Indie Developer track, theme **Build for Your World**.
**Full spec:** "Lattice System Spec v0.1" (Sept 2026; private, not in the repo). This file is the short version plus everything decided since.

---

## 0. Current direction (decided 2026-10-26)

### 0.1 Pitch

**Lattice: a mini-DAW where Muse is your sound designer and your session engineer.** You bring a voice note or a sound from a song, trim it, and *talk* about the vibe you want. Muse proposes versions you can hear, compare and tweak by hand, and keeps going from your changes. Muse also runs the session: punch-in, take picking, drum quantize, trimming, cleanup. We build our own DAW (not Logic) so every agent action is a typed tool call on a session model we own; Logic stays the finishing tool via stem/MIDI export.

### 0.2 Two roles

| | **Sound designer** (centerpiece) | **Session engineer** (a given) |
|---|---|---|
| Rhythm | many rounds on one sound | one command, one result |
| Output | variants as device chains with real knobs | session edits: takes, cuts, fades, timing |
| Human control | grab any knob any time; Muse reads the move as feedback | review, keep or undo |
| Model | Muse/Meta first; **pivot to Magenta RT2 if Muse's results are weak** (tested, §0.8) | Muse |

**Sound-design loop:** source (voice note / song snippet) → cleanup → trim → describe the vibe → Muse proposes 2-3 versions → you react with words, picks ("B > C") or **knob moves** → Muse revises from there → keep. History is a tree of versions, not a chat log.

**Two ways forward from a source:** use it as a sample (resample, pitch, chop, effects), or turn it into notes (basic-pitch, Apache-2.0: hum → MIDI) that play a synth Muse designs.

**Recreating a reference sound ("the synth in Stronger"):** goal is a close match built from signal processing, not describe-and-search. Two approaches tested side by side:
- *Designed with signal processing (Meta path):* Muse picks the synth's structure, a search program (CMA-ES over a spectral distance) fits the numbers. Every knob stays editable.
- *Neural clone (Google fallback):* Magenta RT2 audio prompt → playable instrument. Probably closer, but a black box.
- Splice/Freesound nearest matches as a third, cheap alternative. Judged by a blind human listening test (§0.7).

### 0.3 Engineer tools (MVP)

Punch-in with pre-roll + takes; Muse picks the best take (you confirm); **drum quantize** (onset slicing, snap, crossfade; no time-stretch); trim / silence and breath removal; normalize, fades, clip gain; transpose/octave; sidechain; **noise cleanup on every import** (phone notes vary a lot). Out of MVP: vocal tuning (parked; later a generic AU/VST3 slot via pedalboard), time-stretch, full comping.

### 0.4 Stack

| Layer | Choice |
|---|---|
| App | **Electron**; renderer is Vite/TS + Web Audio, also runnable as a plain web page with a mocked `bridge` (for Playwright/Chrome testing) |
| Session model + agent tools | plain TypeScript; proposals are diffs on session JSON; Vitest |
| Python sidecar | pedalboard (effects, offline renders, AU hosting), noisereduce, basic-pitch, SAM Audio (if it runs), Splice MCP / Freesound clients, Muse tool loop |
| Fixed device set | gain, EQ, saturation, compressor (sidechain in), pitch shift, delay, reverb, plus our synth and a sampler |
| Export | WAV stems + MIDI (open in Logic) |

Testing: recorded Muse fixtures for the tool loop; pytest on audio with measurable checks; Chromium fake-mic flags (`--use-file-for-fake-audio-capture`) for deterministic punch-in alignment tests; a few Playwright `_electron` end-to-end runs (experimental support).

### 0.5 External tools

| Need | Tool | Status |
|---|---|---|
| Sample search | Splice MCP (`mcp.splice.com/mcp`, beta, OAuth; search free, downloads cost credits) | not yet tried |
| CC-licensed sounds | Freesound API v2 (text + `similar_to`) | waiting on API key |
| Source separation | Meta SAM Audio (gated HF weights, SAM License, CUDA-oriented) | waiting on HF access; may need the 3090 box |
| Logic control | community logic-pro-mcp servers | dropped (own DAW instead) |
| YouTube / Reddit packs | — | not a sound source (ToS / unclear rights) |

### 0.6 Demo (3 min)

1. Sound design (~1:45): hum a voice note → clean + trim → "dark, gritty synth" → Muse plays 3 versions → you pull the drive back by hand → Muse adjusts → octave down, sidechain to the kick → keep.
2. Engineering (~0:50): punch in vocals at bar 9 → Muse picks the best take → quantize the drum loop → trim breaths.
3. Wrap (~0:25): export stems to Logic, show the version tree and provenance.

### 0.7 Human eval

Blind, randomized listening test (`spikes/e_eval`): per reference, a hidden copy of the reference, each method's attempt, and a random-patch anchor; 0-100 similarity plus "would you start from this?". Playback loudness-matched. Local page now; later hosted behind Cloudflare Access for 2-3 producer friends. `analyze.py` also checks whether the spectral distance agrees with human ratings (if yes, the agent can use it to check its own attempts).

### 0.8 Day-1 spikes (2026-10-26)

Code in `spikes/` (uv project; `envs/denoise` and `envs/basicpitch` hold tools whose dependencies clash). Outputs in `out/` (git-ignored). Test material: 4 of the builder's voice notes (`data/`, git-ignored).

**Credentials:** Meta key (`META_MODEL_API_KEY`) and Freesound key are in `.env` and both verified. HF login done; access to `facebook/sam-audio-small`/`-large` requested, awaiting Meta's review. **Meta budget: $150 for the 10 days.** Muse Spark 1.2 is $1.25 / $4.25 per M input/output tokens; a short audio-plus-question call is about 1.1k tokens (mostly reasoning), so ~$0.005. Contributor mode is ~12× cheaper but lets Meta train on what we send (not decided).

**A. Can Muse hear? No: its audio input is speech-to-text.** Tested on `muse-spark-1.2`, the model the docs recommend for audio, with the documented `input_audio` format, plus the Responses API with a data URI; ~10 calls, ~$0.05.
- **Synth notes:** dropped at 16, 22.05 and 48 kHz. The prompt tokens matched the text alone (43), and Muse replied "As a text-based AI I can't hear…" or said it saw "a line of dashes" or "musical note symbols".
- **Spoken clip (macOS `say`):** transcribed word for word.
- **Beatbox voice note (150):** "I can't listen to audio".
- **Reading:** prompt tokens grow only by roughly a transcript's length, so the model receives text, not sound.

`run_ears.py` and the Muse versions of C were not run; they would pay for Muse to guess blind. **Consequence:** Muse is still the voice and planner: spoken instructions ("make it gritty") work, and it reasons over text. The ears have to come from our own analysis (pitch, envelope, brightness, noise, motion → a text summary Muse reads, plus the spectral distance) and/or an audio embedding (MRT2's MusicCoCa).

**B. Cleanup.**
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

**E. First ratings (2026-10-26, 1 rater, 6 sounds):**
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

## 1. The idea in one paragraph

Lattice is an **arrange-first AI music canvas** where agents never touch the song directly. The song is a typed, symbolic graph (sections, lanes, tracks, MIDI clips, devices, automation). An AI agent reads that graph and **proposes** changes as reviewable diffs ("open up the hook" → a ghosted proposal of 5 objects). The artist auditions it, A/Bs it, and **commits all, part, or none** of it. Neural audio models are **instruments on tracks** driven by the graph's MIDI, not composers that replace the song. Everything an agent or model made stays editable and carries provenance.

**Why it matters (the producer's view):** today's AI music tools either generate a whole song you can't edit, or bolt a chatbot onto a DAW. Lattice keeps the artist the director: AI output always resolves into ordinary clips, notes and curves you can change by hand.

**Why us:** the builder produces music in Logic, so this is a domain known first-hand (the theme's requirement).

## 2. Why this project (and not the tennis coach)

The hackathon rules list "Sports analyzers or coaches" among the generic projects to avoid, which ruled out the original tennis-coach idea (and its reframed "tennis measurement" version, which is still visibly tennis). Lattice isn't on the avoid list. It isn't a basic RAG app, a chatbot or an image analyzer.

## 3. Core invariants (from the spec, §1)

1. **Canvas first, timeline always.** Spatial freedom never costs timing precision.
2. **Generated = editable.** No committed AI result stays a black box.
3. **Agents write proposals; humans commit.** No code path lets an agent mutate the session. `commit` is user-only.
4. **Complexity exposed by selection.** Routing/parameter graphs one click away, never mandatory.
5. **Musical roles over implementation.** Sections and lanes carry meaning; tracks are how it's built.
6. **Local-first trust.** Session, assets and provenance live on the artist's disk.
7. **Structure is authoritative; audio is a render.**

## 4. Model roles (decided 2026-10-26)

| Role | Model | Why |
|---|---|---|
| **Studio Agent** (reads the graph, writes typed proposals, explains them) | **Muse Spark** (Meta Model API) | Theme requires Meta's models to be central. The agent is the core of the demo. |
| **Agent's ears** (`audition`: hears its own render before the artist does) | **Muse Spark 1.2** (audio input) | 1.3's audio input is documented as degraded. |
| **Neural instrument** (a device on a MIDI track; notes condition it live) | **Magenta RealTime 2**, Small model | Best fit for MIDI-conditioned sound; user's call: "if magenta is the best model for the job let's use that". |
| Textures / one-shots (optional) | MRT2, or Meta's open-weights audio models on Modal/Baseten | Partner credits: Baseten $100, Modal $100, Fireworks $25 (open-weights Meta models only). |

Framing for judges: **Muse Spark is the agent doing the work; Magenta is the instrument it plays.** Don't present Muse as a side feature.

### Verified facts (2026-10-26)

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

## 5. Object model (spec §3, abridged)

| Primitive | Meaning |
|---|---|
| Project | song + tempo map, key, markers, refs, macros |
| Section | verse/hook/bridge span with role, energy 0..1, tags |
| Lane | a musical role, backed by one or more tracks |
| Track | audio/MIDI channel with a device chain |
| Clip | audio/MIDI/generated performance; immutable source, takes |
| SoundSource | sample/recording/AI instrument with mandatory origin + rights |
| Device | instrument/effect/analyzer; typed I/O; automatable params |
| Route / Bus | explicit graph edges; sends; sidechains |
| Parameter | real units (dB, Hz, ms), range, curve |
| AutomationCurve / Macro / Modulator | the three things that write to a Parameter, kept distinct |
| Reference | an artist-supplied anchor; agent reads only the ticked descriptors |
| **Proposal** | `{diff, rationale, scope, cost, provenance}`: previewable, partially committable, reversible |
| Branch | a safe alternate direction; merges object by object |
| Intent | natural-language direction bound to a selection |

**Provenance** on every object an agent/model touched: author (human / agent mode / model id+version), intent text, inputs, model seed/settings, proposal id, `derived_from` (freeze → thaw lineage), compute local/cloud.

## 6. Agent surface (spec §6, §8, §9)

- **17 verbs.** Read-only: `inspect`, `audition`, `compare`, `analyze`. Propose: `create`, `duplicate`, `move`, `trim/split`, `transform`, `route`, `insert_device`, `set_parameter`, `map_macro`, `write_automation`, `generate_variant`. **Human-only:** `commit`, `revert`.
- **Proposal lifecycle:** Intent → scope shown (narrow / add constraint loop) → Proposal (diff + rationale + cost) → Audition (A/B) → **human gate** → commit whole / commit partial / fork to branch / discard.
- **Permission policy** per session (e.g. vocal track and master bus denied unless opened; mix assistant writes only to a mix-pass branch; cloud compute budget).
- **Four modes** of one Studio Agent: **Arrange** (song shape, contrast, transitions), **Shape** (find/build a sound), **Move** (automation/modulation for a moment), **Balance** (diagnose masking, propose mix fixes).

## 7. Hackathon slice (proposal, to iterate on)

The spec's V1 (plug-in hosting, recording, full mix engine, all four modes) is months of work. A 10-day slice that still shows the idea:

1. **Browser canvas:** sections × lanes of MIDI clips, a transport, one continuous song→detail zoom (piano roll).
2. **Muse Spark Studio Agent**, 1-2 modes (**Arrange** and **Move**), over a small typed action API → returns Proposals.
3. **Proposal UX:** ghosted objects on the canvas and in the piano roll, rationale text, **A/B audition, partial commit**, discard, provenance in an inspector.
4. **Magenta RT2 Small** as one neural instrument on one lane (local on the Mac), the rest via a simple browser synth.
5. **`audition` with Muse Spark 1.2:** the agent listens to its own render and revises once (only if the day-1 test shows it understands music).

**Demo (3 min):** load a short loop → "make the second hook lift" → agent proposes 5 objects with rationale → A/B → accept 2 of 5 → tweak one note by hand (direct manipulation, no agent) → show provenance → MRT2 instrument following the edited MIDI.

**Explicitly out** (spec §14 plus the hackathon cut): plug-in hosting, recording, modular patching, live performance, marketplace/social, one-click full-song generation, DAW project import fidelity.

**Optional extra from the shelved tennis work:** an Apple Watch as a gesture controller whose wrist motion (800 Hz accel / 200 Hz gyro, verified on the SE) gets recorded as automation curves (Move mode). Not core.

## 8. Rules that shape the build

- **New work only:** all code written Oct 26 - Nov 4. This idea doc and the spec are fine (ideas); no pre-built code.
- **Identify contributions:** judges must be able to tell what's new. Start a **fresh public repo**; keep third-party pieces (Magenta, any synth library) clearly labeled.
- **Public repo**, **3-minute demo video** (heavily scored), one track only.
- Use only code/data/assets we have rights to: check Magenta's license; use own music or licensed samples in the demo.
- Judged (Indie track) on **creativity, technical ambition, and whether it works**.

## 9. Open questions

**Day-1 tests (decide the plan):**
- **T1** Does Muse Spark 1.2 give useful, specific feedback on a short music render (arrangement, masking, energy)? If not, drop `audition` and stay symbolic.
- **T2** Can a custom app drive MRT2 Small on the M2 Pro (API, latency, CPU/GPU load), or only the AU plugin/apps? If only the plugin, does the demo route MIDI to it in Logic or another host?
- **T3** Does Muse Spark produce musically credible arrangement edits from a typed JSON action API (spec Q6)? Try 3 intents on one loop.

**Product questions (spec §15, ordered by damage if wrong):**
- **Q1** What is the atomic unit of a partial commit: object, property, or time span? Decides the diff UI and the version model.
- **Q2** How does an agent perceive audio it didn't author? Minimum representation beyond LUFS/spectrum; does it need a model?
- **Q3** Can a lane backed by several tracks be automated as one thing? (Probably via Macro; verify.)
- **Q4** Latency budget for a playable neural instrument: ~200 ms vs. <20 ms for playing. Pads survive; percussive transients don't.
- **Q5** Which reference descriptors are legally/ethically extractable (tempo/key yes; groove, spectral balance, arrangement shape contested)?
- **Q6** Does the symbolic writer need a music-specific model, or is an LLM over the action API credible? (= T3)
- **Q7** Serialization format: DAWproject as the escape hatch?
- **Q8** Section energy: artist intent vs. measured analysis; show the disagreement?

**Hackathon-specific:**
- Browser app vs. native Mac app (MRT2 is Mac-native; a browser canvas needs a local bridge to it).
- Logic integration: export MIDI/DAWproject to Logic at the end of the demo, as proof the work isn't locked in?
- How much of Muse Spark's job is visible in a 3-minute video? The agent must be the star.

## 10. Sources

- Lattice System Spec v0.1 (private, not in the repo)
- Meta Model API: [models](https://dev.meta.ai/docs/models), [video and audio understanding](https://dev.meta.ai/docs/video-understanding), [file handling](https://dev.meta.ai/docs/file-handling)
- Magenta RealTime 2: [Google page](https://magenta.tensorflow.org/mrt2), [model card](https://huggingface.co/google/magenta-realtime-2) (not yet read), [third-party overview](https://mer.vin/2026/06/magenta-realtime-2-open-local-live-music-model-with-midi-and-200ms-latency/)
- Hackathon: https://cerebralvalley.ai/e/meta-ai-developer-hackathon (rules pasted by the user 2026-10-26)
