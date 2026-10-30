# Lattice: idea handoff

**Status:** direction as of 2026-10-26 (day 1). Spike results: `docs/spike-results.md`. Current status and next steps: `HANDOFF.md`.
**Hackathon:** Meta Global AI Developer Hackathon, Oct 26 - Nov 4 2026 (submit by **Nov 4, 9:00 PM ET**), Indie Developer track, theme **Build for Your World**.
**Full spec:** "Lattice System Spec v0.1" (Sept 2026; private, not in the repo). This file is the short version plus everything decided since.

---

## Current direction

### 1. Pitch

**Lattice: a mini-DAW where Muse is your sound designer and your session engineer.** You bring a voice note, trim it, and *tell* Muse what to do in plain words ("move the vocal to bar 9", "pan the double 30% left", "fade this out"). Muse carries out concrete instructions as tool calls you can see, undo and tweak by hand, and keeps going from your changes. Muse also runs the session: punch-in, take picking, drum quantize, trimming, cleanup. We build our own DAW (not Logic) so every agent action is a typed tool call on a session model we own; Logic stays the finishing tool via stem/MIDI export.

### 1a. Positioning (checked Oct 27)

"Agentic DAW" is already a named, crowded category. Don't claim first AI DAW, first text-to-preset,
first hum-to-MIDI, or stem separation as the headline. What is new is the whole loop and how it
works: hum → notes or sample → spoken or typed instructions carried out as visible tool calls →
your hand move read as feedback → version history → Logic export. Nobody found does all of that.

| Closest work | What it does | Difference |
|---|---|---|
| Moises Studio Agentic Mode (launched Sept 2 2026) | "comp the best takes, clean up a noisy recording, build an effect chain", every step visible and reversible (their press release) | the same as our engineer half; no hand moves as feedback |
| DAWZY (arXiv 2512.03289, NeurIPS 2025 workshop) | GPT-5 + MCP drives REAPER, Basic Pitch hum-to-MIDI, undo markers | research prototype; cite it |
| Keeble Weil | plugin synth where Claude sets every knob from a description ("darker", "more movement") | one synth, not a session; vendor claims, no reviews found |
| Jamu (Ableton), FL Studio 2026 Gopher | plain language → DAW actions and device settings | inside an existing DAW; Gopher can't add notes or pick presets |

Research that backs the design: LLM2Fx (arXiv 2505.20770) and LLM2Fx-Tools (2512.01559) on LLMs
setting effect parameters, helped by measured audio features (backlog B9); Text2FX (2409.18847)
on CLAP-guided effects.

Lines to use: "Suno gives you a finished song. Lattice gives you the knobs." / "Your hand is part
of the prompt."

### 2. Two roles

| | **Sound designer** (centerpiece) | **Session engineer** (a given) |
|---|---|---|
| Rhythm | instruction by instruction on one sound | one command, one result |
| Output | device chains with real knobs, set as asked | session edits: takes, cuts, fades, timing |
| Human control | grab any knob any time; Muse reads the move as feedback | review, keep or undo |
| Model | Muse/Meta first; **pivot to Magenta RT2 if Muse's results are weak** (tested: `docs/spike-results.md`) | Muse |

**Instruction loop (decided Oct 29, B16):** source (voice note) → cleanup → trim → you give concrete instructions (arrange, mix, tracks, edits, devices) → Muse does exactly that and says what it did in one spoken sentence → you adjust by hand or give the next instruction. Vague sound words ("make it better", "more open", "wider") get one short question offering one or two concrete changes ("Brighter how: raise the top-end EQ, or cut the low-mids?"), not a guess. History is the Versions list (before/after each Muse turn), not a chat log.

Dropped (Oct 29): "Muse proposes 2-3 competing versions" from a vibe description. Muse can't hear, so its guesses at a vibe were the weak part; concrete instructions are what it does reliably. Later possibility: a reference clip ("make the drums sound like this") measured with our features and turned into concrete moves the user confirms.

**Two ways forward from a source:** use it as a sample (resample, pitch, chop, effects), or turn it into notes (basic-pitch, Apache-2.0: hum → MIDI) that play a synth Muse designs.

**Recreating a reference sound ("the synth in Stronger"):** goal is a close match built from signal processing, not describe-and-search. Two approaches tested side by side:
- *Designed with signal processing (Meta path):* Muse picks the synth's structure, a search program (CMA-ES over a spectral distance) fits the numbers. Every knob stays editable.
- *Neural clone (Google fallback):* Magenta RT2 audio prompt → playable instrument. Probably closer, but a black box.
- Splice/Freesound nearest matches as a third, cheap alternative. Judged by a blind human listening test (0.7 below).

### 3. Engineer tools (MVP)

Punch-in with pre-roll + takes; Muse picks the best take (you confirm); **drum quantize** (onset slicing, snap, crossfade; no time-stretch); trim / silence and breath removal; normalize, fades, clip gain; transpose/octave; sidechain; **noise cleanup on every import** (phone notes vary a lot). Out of MVP: vocal tuning (parked; later a generic AU/VST3 slot via pedalboard), time-stretch, full comping.

### 4. Stack

| Layer | Choice |
|---|---|
| App | **Electron**; renderer is Vite/TS + Web Audio, also runnable as a plain web page with a mocked `bridge` (for Playwright/Chrome testing) |
| Session model + agent tools | plain TypeScript; proposals are diffs on session JSON; Vitest |
| Python sidecar | pedalboard (effects, offline renders, AU hosting), noisereduce, basic-pitch, SAM Audio (if it runs), Splice MCP / Freesound clients, Muse tool loop |
| Fixed device set | gain, EQ, saturation, compressor (sidechain in), pitch shift, delay, reverb, plus our synth and a sampler |
| Export | WAV stems + MIDI (open in Logic) |

Testing: recorded Muse fixtures for the tool loop; pytest on audio with measurable checks; Chromium fake-mic flags (`--use-file-for-fake-audio-capture`) for deterministic punch-in alignment tests; a few Playwright `_electron` end-to-end runs (experimental support).

### 5. External tools

| Need | Tool | Status |
|---|---|---|
| Sample search | Splice MCP (`mcp.splice.com/mcp`, beta, OAuth; search free, downloads cost credits) | not yet tried |
| CC-licensed sounds | Freesound API v2 (text + `similar_to`) | waiting on API key |
| Source separation | Meta SAM Audio (gated HF weights, SAM License, CUDA-oriented) | waiting on HF access; may need the 3090 box |
| Logic control | community logic-pro-mcp servers | dropped (own DAW instead) |
| YouTube / Reddit packs | — | not a sound source (ToS / unclear rights) |

### 6. Demo (3 min)

1. Sound design (~1:45): hum a voice note → clean + trim → turn it into MIDI → "put saturation on the keys, drive at 12 dB" → you pull the drive back by hand → "now an octave down, and loop it through bar 16" → keep.
2. Engineering (~0:50): punch in vocals at bar 9 → Muse picks the best take → quantize the drum loop → trim breaths.
3. Wrap (~0:25): export stems to Logic, show the version tree and provenance.

### 7. Human eval

Blind, randomized listening test (`spikes/e_eval`): per reference, a hidden copy of the reference, each method's attempt, and a random-patch anchor; 0-100 similarity plus "would you start from this?". Playback loudness-matched. Local page now; later hosted behind Cloudflare Access for 2-3 producer friends. `analyze.py` also checks whether the spectral distance agrees with human ratings (if yes, the agent can use it to check its own attempts).

---

## Hackathon rules

- **New work only:** all code written Oct 26 - Nov 4. Ideas and specs are fine; no pre-built code.
- **Identify contributions:** judges must be able to tell what's new. Start a **fresh public repo**; keep third-party pieces (Magenta, any synth library) clearly labeled.
- **Public repo**, **3-minute demo video** (heavily scored), one track only.
- Use only code/data/assets we have rights to: check Magenta's license; use own music or licensed samples in the demo.
- Judged (Indie track) on **creativity, technical ambition, and whether it works**.


## Where the rest went

- Day-1 spike results and verified API facts: `docs/spike-results.md`
- Job-by-job model map: `docs/model-map.md`
- Transport/control-bar conventions: `app/docs/ux-notes.md`
- Superseded arrange-first concept (proposals, provenance, object model): `docs/archive/arrange-first-concept.md`
- Current status: `HANDOFF.md`; remaining work: `docs/backlog.md`; agent rules: `CLAUDE.md`
