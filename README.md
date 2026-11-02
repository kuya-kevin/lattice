# Lattice

A mini-DAW where Muse, Meta's model, is your session engineer. Bring a hummed voice note, talk or
type what you want, and Muse carries it out as visible tool calls on a session you can also edit by
hand. Your hand moves go back to Muse as feedback on its next turn. Muse cannot hear music, so the
app measures sound and gives it numbers.

Built for the Meta Global AI Developer Hackathon, Indie track.

## Meta models

Every model called at runtime is a Meta model.

| Model | Job | Where it runs | Licence |
|---|---|---|---|
| Muse Spark 1.3 (`muse-spark-1.3-contributor`) | understands requests, plans, calls the tools | Meta Model API | Meta API terms |
| Muse Voice Transcribe (`muse-voice-transcribe-1.0`) | push-to-talk speech to text | Meta Model API | Meta API terms |
| MMS-TTS English (`facebook/mms-tts-eng`) | speaks Muse's replies | on your computer (Transformers.js, WebGPU or WASM) | weights CC BY-NC 4.0 |
| Demucs `htdemucs_6s` | splits audio into vocals, drums, bass, guitar, piano, other | on your computer (Python sidecar) | MIT |

## What is not a model

These run at runtime and use no machine learning, so no model is involved:

- Effects engine: Web Audio, Faust, Signalsmith Stretch
- `measure_track`: level, peak, spectrum and stereo measurements Muse reads as text
- `cleanup_noise`: noisereduce (spectral gating)
- Notes from audio: pyin (single lines; a solo voice is cleaned with noisereduce first) and onset detection (drums), then note cleanup and key detection
- Freesound: a search API, not a model

Meta has no chord transcription model, so a chordal part stays audio. Its Demucs stem can still be
placed on a track, mixed and processed, but it does not become MIDI notes.

## Run it

```bash
cd app && npm install && npm run dev
```

`.env` holds `META_MODEL_API_KEY` and `FREESOUND_API_KEY` (see `.env.example`). The Python sidecar
needs [uv](https://docs.astral.sh/uv/) and `LATTICE_BIGDISK`, or a `~/lattice-data` folder, for its
environments and weights. Without a key, `npm run dev:web` runs in a browser with an offline Muse.

Tests: `npx vitest run`, `npx tsc --noEmit` and Playwright under `app/e2e`, all from `app/`.

## Repo

| Folder | What it is |
|---|---|
| `app/` | the product: Electron, React and TypeScript |
| `spikes/k_source_prep/` | the Python sidecar the app calls |
| `spikes/f_engineer/` | drum quantize code the sidecar uses |
| `spikes/` (everything else), `envs/` | **past research, not called by the app.** Some of it evaluated non-Meta models (`spikes/j_evals`, `spikes/m_cleanup_models`, and others); those results led to the choices above |
| `docs/` | design notes, backlog and the demo plan |
