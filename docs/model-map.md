# Which model does which job

Updated 2026-11-01. Muse understands what you say and runs the session, but it can't hear music.
Every job that needs ears or sound goes to a Meta model or to plain signal processing: the hackathon
rule allows only Meta models at runtime. `README.md` has the short version.
Status words: **working**, **in app** (wired into Lattice), **stub** (fake result in the app),
**candidate** (not yet evaluated), **dropped**. Meta models are marked (Meta).

## How a request flows

1. **You** type (or, later, talk), tweak knobs and clips by hand, and judge by ear. Hand edits are
   passed to Muse as feedback on its next turn.
2. **Lattice app** (Electron, also runs in a browser): the DAW, the effects engine, the chat panel.
3. **Muse (Meta)**, `muse-spark-1.3-contributor`: reads the session as text, decides, calls tools.
   Never listens to audio.
4. **Tools:** all real. The non-Meta generators and the synth stubs were removed on Nov 1.

## Job by job

| Job | What does it | Runs where | Status | What we measured |
|---|---|---|---|---|
| **Talking and planning** |||||
| Understand a request, plan, call tools | Muse Spark 1.3 (Meta), contributor mode | Meta API | working, in app | Several calls per turn; respects hand edits. About $0.04 per mixing request with the full tool prompt. |
| Spoken instructions to text | Muse Voice Transcribe (`muse-voice-transcribe-1.0`, Meta) | Meta API | working in app (B2 push-to-talk, Oct 28) | $0.18/hr, billed per second. Exact on a `say` test clip; Muse Spark 1.2 audio input also transcribes speech but is a chat model. |
| Speak Muse's reply | MMS-TTS English (`facebook/mms-tts-eng`, VITS, Meta) via Transformers.js, fp32 | app (renderer Web Worker; WebGPU, WASM fallback) | in app (B14, Oct 29), off by default | The Meta API has no TTS. Electron WebGPU about 0.2 s per short phrase after a ~1.5 s load; WASM about real time. Reads letters only, so numbers and units are written out first. $0 per reply. |
| Words to knob moves | `vocab.json` + Muse | app | seed data, not wired (S2) | — |
| **Shaping sound** |||||
| Effects (EQ, comp, de-esser, gate, limiter, sat, filter, delay, reverb, pitch, mod, crush, utility) | our engine: native Web Audio, Faust WASM, Signalsmith Stretch | app (live + offline) | working, in app | 68 reference checks pass, 2 known pitch gaps (`docs/fx-verification.md`). |
| Find real sounds by words and timbre | Freesound API | cloud | working, in app | `note_name` reliable (64/80), `pitch` not (11/80). 144 one-shots + 48 producer-material sounds, CC0/CC-BY. |
| Recreate a sound with editable knobs | 15-knob synth + CMA-ES (no model) | Python | research only, removed from the app Nov 1 | Your top pick by ear (liked 64). About 30 s per sound. |
| Play notes in a style | Magenta RT2 (Google) | Mac MLX or 3090 JAX | **dropped Nov 1**, not Meta | Vibe, not copy (liked 43). |
| **Ears and grading** |||||
| Score words against a sound | PE-AV base (Meta) | Python | partial | Tracks 4 of 6 synth knobs; misses brightness and noise. Large not run. |
| Grade "closer to the reference" | spectral distance | Python | working (spike) | Agrees with your ears 77% of pairs (72% without the easy ones). |
| Grade quality | Audiobox Aesthetics (Meta) | 3090 | dropped as grader | At chance on closeness. |
| **Source prep** |||||
| Clean up noisy voice notes | noisereduce (stationary, noise profile) | Python | in app (`cleanup_noise`) | Noise down 3–16 dB, performance changed ≤ 2 dB. Mel-RoFormer denoise sounded better but isn't Meta (dropped Nov 1). |
| Pull one instrument out of a mix | Demucs htdemucs_6s (Meta) | Python, on the computer | in app (`split_stems`, `extract_midi`) | About 7 s for a 20 s clip on the Mac. Mel-RoFormer isolated hums better, not Meta (dropped Nov 1). |
| Pull out a sound by describing it | SAM Audio (Meta) | 3090 or Mac | blocked (gated); GGUF via audio.cpp is a candidate | — |
| Audio to MIDI | pyin for single lines (no model): noisereduce first on a solo voice, the Demucs stem in a mix; chords stay audio, no Meta transcriber exists | Python | in app | See `spikes/k_source_prep/README.md`. basic-pitch, MuScriptor, YourMT3+, ByteDance dropped Nov 1, not Meta. |
| Drum quantize, trim silence | our code: onset detection, grid fit | Python | in app | Your loop: 12.5 → 4.5 ms off the 1/16 grid. Needs a listen. |
| Drums from voice notes to MIDI | onset drum detector (`k_source_prep/drums.py`) | Python | in app (inside `extract_midi`) | Synthetic onset F1 0.94 (optimistic: tuned on the same clips). |

## Meta at the centre

Muse plans and runs everything; Demucs does the separation; MMS-TTS speaks. Everything else at
runtime is signal processing with no model. PE-AV and SAM Audio remain research.

Sources: `docs/spike-results.md`, `spikes/j_evals/README.md`, `spikes/k_source_prep/README.md`.
