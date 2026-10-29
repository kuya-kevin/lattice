# Which model does which job

Updated 2026-10-27. Muse understands what you say and runs the session, but it can't hear music.
Every job that needs ears or sound goes to another model or to plain signal processing.
Status words: **working**, **in app** (wired into Lattice), **stub** (fake result in the app),
**candidate** (not yet evaluated), **dropped**. Meta models are marked (Meta).

## How a request flows

1. **You** type (or, later, talk), tweak knobs and clips by hand, and judge by ear. Hand edits are
   passed to Muse as feedback on its next turn.
2. **Lattice app** (Electron, also runs in a browser): the DAW, the effects engine, the chat panel.
3. **Muse (Meta)**, `muse-spark-1.3-contributor`: reads the session as text, decides, calls tools.
   Never listens to audio.
4. **Tools:** session, effects, MIDI, and Freesound tools are real; five sound and engineer tools
   are still stubs (see the table).

## Job by job

| Job | What does it | Runs where | Status | What we measured |
|---|---|---|---|---|
| **Talking and planning** |||||
| Understand a request, plan, call tools | Muse Spark 1.3 (Meta), contributor mode | Meta API | working, in app | Several calls per turn; respects hand edits. About $0.04 per mixing request with the full tool prompt. |
| Spoken instructions to text | Muse Voice Transcribe (`muse-voice-transcribe-1.0`, Meta) | Meta API | working in app (B2 push-to-talk, Oct 28) | $0.18/hr, billed per second. Exact on a `say` test clip; Muse Spark 1.2 audio input also transcribes speech but is a chat model. |
| Words to knob moves | `vocab.json` + Muse | app | seed data, not wired (S2) | — |
| **Shaping sound** |||||
| Effects (EQ, comp, de-esser, gate, limiter, sat, filter, delay, reverb, pitch, mod, crush, utility) | our engine: native Web Audio, Faust WASM, Signalsmith Stretch | app (live + offline) | working, in app | 68 reference checks pass, 2 known pitch gaps (`docs/fx-verification.md`). |
| Find real sounds by words and timbre | Freesound API | cloud | working, in app | `note_name` reliable (64/80), `pitch` not (11/80). 144 one-shots + 48 producer-material sounds, CC0/CC-BY. |
| Recreate a sound with editable knobs | 15-knob synth + CMA-ES optimizer (+ Muse seed patch) | Python | stub in app | Your top pick by ear (liked 64; Muse seed 66). About 30 s per sound. |
| Play notes in a style | Magenta RT2 (Google) | Mac MLX or 3090 JAX | stub in app | Vibe, not copy (liked 43). Keys prompts follow MIDI closely (F1 up to 1.0). |
| **Ears and grading** |||||
| Score words against a sound | PE-AV base (Meta) | Python | partial | Tracks 4 of 6 synth knobs; misses brightness and noise. Large not run. |
| Grade "closer to the reference" | spectral distance | Python | working (spike) | Agrees with your ears 77% of pairs (72% without the easy ones). |
| Grade quality | Audiobox Aesthetics (Meta) | 3090 | dropped as grader | At chance on closeness. |
| **Source prep** |||||
| Clean up noisy voice notes | noisereduce (stationary, noise profile) | Python | stub in app | Noise down 3–16 dB, performance changed ≤ 2 dB. DeepFilterNet dropped (treats humming as noise). |
| Pull one instrument out of a mix | Mel-RoFormer, htdemucs_6s (Meta) | Python | in app (inside `extract_midi`) | Best hum isolation: Mel-RoFormer. htdemucs piano stem: 91% of note 146's piano energy. |
| Pull out a sound by describing it | SAM Audio (Meta) | 3090 or Mac | blocked (gated); GGUF via audio.cpp is a candidate | — |
| Audio to MIDI | router: pyin, basic-pitch, opt-in YourMT3+ (GPL, separate process) and ByteDance piano | Python | working, in app | Synthetic phone set F1: bass 0.98, hum 0.67, layered keys 0.59 (0.70 with YourMT3+). |
| Audio to MIDI (alternative) | MuScriptor (CC BY-NC) | muscriptor.cpp | candidate | Paper: about 2× YourMT3+ onset F1 on studio mixes; includes drums. Untested on phone audio. |
| Drum quantize, trim silence | our code: onset detection, grid fit | Python | stub in app | Your loop: 12.5 → 4.5 ms off the 1/16 grid. Needs a listen. |
| Drums from voice notes to MIDI | onset drum detector (`k_source_prep/drums.py`) | Python | in app (inside `extract_midi`) | Synthetic onset F1 0.94 (optimistic: tuned on the same clips). |

## Meta at the centre

Muse plans and runs everything; Meta's Demucs, PE-AV and (once available) SAM Audio cover separation
and listening. Non-Meta pieces: Magenta RT2 (Google), basic-pitch (Spotify), Mel-RoFormer, pyin.

Sources: `docs/spike-results.md`, `spikes/j_evals/README.md`, `spikes/k_source_prep/README.md`.
