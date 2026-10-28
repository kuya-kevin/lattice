# Lattice

A mini-DAW where Muse (Meta's model) is the sound designer and session engineer. The producer
talks or types ("make the vocal stand out", "quantize the drums"), and Muse acts through typed tool
calls on a session model we own. Built for the Meta Global AI Developer Hackathon, Indie track.
**Submission deadline: Nov 4 2026, 9:00 PM ET.** All code must be written Oct 26 - Nov 4.

Direction and pitch: `idea.md`. Current status: `HANDOFF.md`. Remaining work, one entry per task:
`docs/backlog.md`. Workstreams (S0-S8) and decisions: `docs/session-plan.md`. Spike index: `spikes/README.md`.

## Ground rules

- **Never `git commit`.** Stage with `git add` and say what's staged; the user reviews and commits.
- **Meta API budget: $150 for the whole hackathon.** Use `muse-spark-1.3-contributor`. Make a few
  test calls before any batch run, log token usage, and report spend. Tests never call Meta:
  use recorded fixtures (`npm run record-fixtures` re-records them, which costs money; ask first).
- **Muse cannot hear music.** Its audio input is speech-to-text only (verified Oct 26). Give it
  text: session summaries, measured features, tool results. Never pay for Muse audio calls on music.
- **Rights.** Copyrighted reference audio stays local (`data/`, `out/`, both git-ignored) and out of
  the repo and demo. Freesound material is CC0/CC-BY only; attribution lives in `data/freesound/README.md`.
  Flag licences of any new model or library (several current ones are GPL or non-commercial, see below).
- **Meta models stay central** in the story: Muse plans, and Meta's Demucs / SAM Audio / PE-AV do the
  listening and separation where possible.
- Docs are Markdown files in the repo, not published artifacts or claude.ai links.

## Layout

```
app/                 Electron + Vite/React/TS app (the product)
  electron/          main process and preload (IPC; keys and Muse calls live here)
  src/core/          session model, tools, Muse agent loop, bridge interface (no DOM; tested in Vitest)
    session.ts         Session/Track/Clip types and summarize() (what Muse sees)
    tools.ts           session tools (OpenAI-format schemas + handlers); midiTools.ts for MIDI
    agent.ts           system prompt and tool loop
    bridge.ts          the renderer's only door outside (Electron IPC, or renderer/mockBridge.ts in web)
    sidecar.ts         Python sidecar interface; StubSidecar fakes everything except extractMidi
  src/fx/            effects engine: catalog.json (all knobs), vocab.json (words -> knob moves),
                     engine/ (live + offline chain), faust/ (.dsp sources + prebuilt wasm), tools.ts
  src/node/          Node-side helpers (Muse client, library, sourcePrep.ts spawns the S3 sidecar)
  src/renderer/      React UI (App.tsx, Arrange, DevicePanel, ChatPanel, ...)
  tests/  e2e/  e2e-fx/   Vitest, Playwright (web + Electron), fx render harness
  docs/ux-notes.md   UI conventions (Logic/GarageBand) with sources; append when you add one
spikes/              Python experiments, one folder per spike (a_ears ... k_source_prep); uv project
  k_source_prep/     the live S3 sidecar (voice note -> stems -> MIDI), called by the app
  j_evals/           GPU model evals (3090); results in its README
  fx_verify/         effects verification (signals -> headless render -> pytest measurements)
envs/                separate uv projects for models whose deps clash (mrt: Magenta RT2 on the Mac; ears: PE-AV)
docs/                design docs; archive/ holds superseded ones
data/  out/          git-ignored: voice notes, Freesound sets, generated audio, ratings
```

## Commands (run from `app/`)

| What | Command |
|---|---|
| Install | `npm install` (runs `patch-package`; waveform-playlist is patched in `patches/`) |
| Electron dev | `npm run dev` |
| Browser dev (mock bridge, offline Muse) | `npm run dev:web` |
| Unit tests | `npx vitest run` (or `npx vitest run tests/<file>.test.ts`) |
| Typecheck | `npx tsc --noEmit` (keep it clean) |
| E2E, web | `E2E_PORT=53xx npx playwright test e2e/<file>.spec.ts --reporter=line` |
| E2E, Electron | `npm run build && npx playwright test e2e/electron.spec.ts --reporter=line` |
| Faust rebuild | `FAUSTWASM_DIR=... node scripts/build-faust.mjs` (only after editing `src/fx/faust/*.dsp`) |

Python: each folder with a `pyproject.toml` is its own uv project (`cd spikes && uv run python ...`).
On the 3090 box, caches and venvs go to the big data disk (`LATTICE_BIGDISK`); the root disk is
nearly full. The real path is machine-specific and kept out of the repo.

Secrets are in `.env` (see `.env.example`): `META_MODEL_API_KEY`, `FREESOUND_API_KEY`,
`FREESOUND_CLIENT_ID`, `HF_TOKEN`. Never print them or put them in tests, URLs or docs.

## How to work here

- **Every agent action is a tool.** UI buttons and Muse call the same tools via `runTool`; UI calls
  are logged as hand edits that Muse sees on its next turn. New features get a tool in
  `src/core/tools.ts` (or `fx/tools.ts`, `midiTools.ts`), a summary line in `session.ts` if Muse
  should see the state, and a Vitest test.
- **Knobs are data.** Add or change devices and params in `src/fx/catalog.json`, not in code.
  `tests/fx.test.ts` checks `vocab.json` names only real params with legal values.
- **Test UI changes with Playwright, asserting on state** (`window.lattice.getSession()`), not on
  pixels. Write the failing test first. Full guide: `docs/local-testing-workflow.md`.
- Electron tests run built files: `npm run build` first or they test stale code. Give each
  Playwright run its own `E2E_PORT`.
- Audio buffers live only in the renderer; reopening the Electron window keeps the session but
  drops audio (clips draw empty). Not a bug.
- Python model calls go through a separate process (the app never imports GPL code; YourMT3+ is
  treated as GPL). Stub sidecar tools must say "stub" in their result so Muse reports them honestly.
- When you finish a backlog entry, move it to Done in `docs/backlog.md`, update the `HANDOFF.md`
  status table, and keep docs short and dated. New spikes get a row in `spikes/README.md`.
- `.claude/settings.json` allows tests, typecheck, build and read-only git, and denies `git commit`,
  `git push` and `npm run record-fixtures` (costs Meta money).

## Licence watchlist

| Piece | Licence | Note |
|---|---|---|
| waveform-playlist, Signalsmith Stretch, Mel-RoFormer, htdemucs | MIT | fine |
| basic-pitch, Magenta RT2 code, PE-AV | Apache-2.0 | MRT2 weights are CC-BY-4.0 |
| Faust devices | ours + STK-4.3 / zita_rev1 | no GPL `compressors.lib` / `limiter_lad` |
| YourMT3+ | treat as GPL-3.0 | opt-in, separate process only |
| ByteDance piano transcription | no licence file | opt-in only |
| SAM Audio | SAM License | evaluated via audio.cpp GGUF, dropped Oct 27 (`spikes/l_sam_audio`) |
| Mel-RoFormer denoise (aufr33) | community weights, no stated licence | `cleanup_noise` default (B3), separate process; noisereduce (MIT) fallback (`spikes/m_cleanup_models`) |
| MuScriptor medium | code MIT, weights CC BY-NC 4.0 | non-commercial; sidecar default transcriber, separate process (`spikes/k_source_prep`) |
| pedalboard | GPL-3.0 | not used (decided) |
