# Backlog

Updated 2026-10-27 (late). One entry per remaining task, in priority order. Each says what "done" means,
which files it touches, and what it depends on, so an agent can be pointed at one entry.
Rules and commands: `CLAUDE.md`. Status: `HANDOFF.md`. Stream ids (S0–S8): `docs/session-plan.md`.

When you finish an entry: move it to "Done" at the bottom with the date and a one-line result,
and update the `HANDOFF.md` status table.

## Now

### B0. DAW bugs and quality of life (ongoing)
- **What:** the mini-DAW works but is still buggy. The user will send items; list each one here as
  a bullet with a date, and fix them between the bigger entries.
- **Done when:** each item has a failing Playwright test first, then the fix (`docs/local-testing-workflow.md`).
- **Items:** _(none logged yet)_

### B1. Words to knob moves: wire `vocab.json` into Muse (S2)
- **Why:** the pitch is "you don't need to know which knob".
- **Current state:** Muse already has the effects tools. `list_devices` gives it each device and
  knob with ranges, units, usual ("agent") ranges and the words each knob fixes, so it can pick
  *which* knob for "muddy" or "harsh". What it lacks: *how far* to move it, which devices to combine
  for a phrase like "stand out in the mix", and per-source differences (vocal vs bass). That's in
  `vocab.json`, which Muse never sees. Muse has also never been run on the effects tools (the
  recorded fixtures predate S1), so step one is a baseline: record a few requests without the
  vocabulary, then with it, and compare.
- **Facts checked (Oct 27):** every fixed value in `vocab.json` is inside the knob's `agentRange`.
  Tracks have no source type; Muse can only infer one from the track name. The system prompt says
  nothing about effects. The existing fixtures don't store token usage.
- **Plan:**
  1. **Scenarios (no cost).** Add a `vocab` group to `SCENARIOS` in `core/scenario.ts`: 10 phrases on
     named tracks ("Vocal take", "Bass DI", "Drum loop", "Pad"). For example: vocal stand out,
     vocal less harsh, vocal less sibilant, warmer bass, bass less muddy, drums punchier, drums
     glue, pad wider and more spacious, gritty bass, telephone vocal. One of them has a
     hand-edit turn ("too much, back it off") to test nudge.
  2. **Smoke test (about $0.10).** Record 2 of them live, with the vocabulary not yet exposed. Read the
     actual spend per request before going on.
  3. **Baseline (about $0.40).** Record all 10 without the vocabulary. Write down what Muse picked:
     devices, values, clamps, extra `list_devices` calls. Copy these fixtures to
     `tests/fixtures/baseline/`, because re-recording overwrites by name. `record-fixtures` already
     takes scenario names as arguments.
  4. **Expose the vocabulary.** Add a `suggest_moves(word, source_type)` tool in `fx/tools.ts`, plus one
     line in the system prompt ("for a sound word, call suggest_moves first, then apply with
     insert_device/set_param"). It returns the catalog-checked moves for the closest entry, or
     says none match.
     - **Why a tool over a prompt excerpt:** the vocabulary grows without growing every request, and
       it's testable on its own.
     - Grow `vocab.json`: add per-source variants where they differ (e.g. "warm" on bass leans on the
       low shelf, on vocal on saturation), and the phrases from step 1.
  5. **Record again (about $0.40)** and compare with the baseline in a short table in this entry.
  6. **Tests.** Replay tests assert that each phrase uses the right devices, every value stays inside
     `agentRange` (or the clamp note is passed on to the user), and nothing touches other tracks.
  7. **By ear.** The user plays the 10 results in the app and marks each good, close or wrong. Wrong
     ones get a vocab fix, with no re-record unless the tool calls change.
- **Done when:** steps 6 and 7 pass.
- **Files:** `app/src/core/scenario.ts`, `app/src/fx/vocab.json`, `app/src/fx/tools.ts`,
  `app/src/core/agent.ts`, `app/tests/`.
- **Cost:** about $1 total (at the ~$0.04 per request measured on Oct 27). Ask before each recording
  step (`npm run record-fixtures` is denied in settings).
- **Small fix on the way:** the `vocab.json` note names `tests/fx-catalog.test.ts`; the check is in
  `tests/fx.test.ts`.

### B3. Make cleanup and drum quantize real (S4, part 1)
- **Do:** replace the `cleanup_noise` and `quantize_drums` stubs with the existing Python
  (`spikes/b_cleanup/run_noisereduce.py`, `spikes/f_engineer/quantize.py`), called the same way
  `extract_midi` is (a child process from `app/src/node/`), returning the processed audio as a new clip or take.
- **Done when:** both tools change the audio in the app; e2e tests run with a mock manifest
  (like `LATTICE_SIDECAR_MOCK`); the user has listened to one quantized loop.
- **Files:** `app/src/core/sidecar.ts`, `app/src/node/`, `app/src/core/tools.ts`, `spikes/b_cleanup`, `spikes/f_engineer`.
- **Note:** the move of live sidecar code out of `spikes/` is on hold (user decision, Oct 27).

### B3a. Run source prep (audio to MIDI) on the Mac
- **Why:** `extract_midi` only runs on the 3090 box today. `spikes/k_source_prep/run.sh` needs
  `LATTICE_BIGDISK` and the j_evals `amt` and `sep` envs, which were only built there. The user
  hasn't tried audio to MIDI yet, and the demo is on the Mac.
- **Do (on the Mac; no code change expected):**
  1. Pick a Mac folder for everything heavy, e.g. `~/lattice-data`, and
     `export LATTICE_BIGDISK=~/lattice-data` (also wherever the app is started, so `sourcePrep.ts`
     passes it on). `env.sh` puts every cache under it: venvs in `venvs/`, model weights in `hf/`
     (`HF_HUB_CACHE`), torch weights in `torch/`. Nothing goes to the 3090's disk layout.
  2. `uv sync` the j_evals `amt`, `sep` and `muscriptor` envs through `env.sh`.
  3. HF login once, outside `env.sh`: `uvx hf auth login`, with the account that accepted the
     MuScriptor licence (writes `~/.cache/huggingface/token`; `env.sh` points `HF_TOKEN_PATH` at it).
  4. First run downloads MuScriptor medium (1.2 GB) into `$LATTICE_BIGDISK/hf/` on the Mac, plus the
     Mel-RoFormer / htdemucs weights.
  5. Pilot one voice note with `spikes/k_source_prep/run.sh` and check the manifest says
     `"transcriber": "muscriptor"` with no fallback warning. MuScriptor picks MPS and float16 by
     itself; the 3 GB free-VRAM check only runs where `nvidia-smi` exists. Speed on MPS is
     unmeasured: if a 20 s note takes much longer than ~30 s, note it here before going on.
  6. Run one voice note end to end from the app. YourMT3+ stays off (needs a 14 GB GPU).
- **If MuScriptor isn't set up,** the sidecar still works: it falls back to basic-pitch / pyin with a
  warning in the manifest.
- **Done when:** the user has run `extract_midi` on two real voice notes in the app and judged the MIDI.

## Next

### B5. Evaluate MuScriptor for audio to MIDI (S3) — next on the 3090
- **Do:** run MuScriptor (official `muscriptor` package, MIT code, CC BY-NC 4.0 weights, HF
  licence click-through) on the j_evals synthetic phone set and score it with
  `spikes/j_evals/score_amt.py`; compare with the router, especially layered keys (0.59), hum
  (0.67) and drums.
- **Milestones:**
  - **How it runs:** every job writes one line (clip, model size, status, time, VRAM, F1) to a
    progress log in `$LATTICE_OUT/amt/`; pilot on one clip first, including the longest one, and
    stop on the first failure.
  - **M6 runs:** `muscriptor transcribe` on one synthetic clip writes non-empty MIDI on the GPU.
  - **M7 score:** an F1 row per model size (small, medium; large if it fits) per category, next
    to the router's rows in `out-evals/amt/f1.md`.
  - **M8 decide:** renders for 2 real voice notes, keep/drop in the j_evals README, licence table
    row, staged.
- **Progress (Oct 27):** M6-M8 done. The user kept medium. It is the sidecar's default transcriber
  (`--transcriber muscriptor`), with basic-pitch kept for a layered note's melody: every category
  at or above the old sidecar (hum 0.67 → 0.84, keys 0.79 → 0.90, layered keys 0.59 → 0.68).
  Results in `spikes/k_source_prep/README.md`.
- **Listening (Oct 27):** the user compared old vs new sidecar output on the voice notes
  (`<bigdisk>/out-k/listen_compare/index.html`) and judged the new one good.
- **Left:** run `extract_midi` from the app (it already calls `run.sh` with the new default); the
  Mac setup is in B3a.
- **Links:** https://github.com/muscriptor/muscriptor, https://huggingface.co/DamRsn/muscriptor-gguf, arXiv 2607.08168.

### B6. Demo script and public repo
- **Do:** write the 3-minute script (`docs/demo.md`) from what works; decide which optional
  modules appear; set up the fresh public repo with third-party pieces labelled.
- **Done when:** the user approves the script; repo is public with a README.
- **Depends on:** B1 at least (B2 is tabled).

## Later / optional

### B2. Voice commands: push-to-talk and the wake word "Hey Muse" (S6) — tabled Oct 27
- **Do:** two ways to start a spoken command, one pipeline after that:
  1. **Push-to-talk:** hold a hotkey, speak, release.
  2. **Wake word:** the musician says "Hey Muse", then the command; the clip ends on
     about 1 s of silence (voice activity detection).
  Either way the clip goes to Muse 1.2 audio input for transcription, and the text becomes a normal
  chat turn. The transcript shows in the chat panel so a mishearing is visible.
- **Wake word constraints:**
  - It must be spotted **locally**, always on. Streaming the mic to Meta would cost money all the
    time and send everything the musician says or plays.
  - Candidates (licence first; nothing installed yet): sherpa-onnx keyword spotting (Apache-2.0;
    the keyword is plain text, no training; has WASM and Node builds), openWakeWord (Apache-2.0,
    Python; needs a custom model trained for "muse"), Vosk with a one-word grammar (Apache-2.0),
    Porcupine (proprietary, free tier with an access key). The Web Speech API isn't an option: it
    doesn't work in Electron.
  - **Decided (Oct 27): "Hey Muse".** "Muse" alone is short and close to "music", "news", "use".
  - Music playing through speakers, and a vocal take being recorded, will both reach the mic.
    Pause listening while a track is armed or recording, and test with playback on.
- **Done when:** both triggers reach the agent and run a tool, in Electron. Tests use recorded
  transcription fixtures (no Meta calls); one manual check with real calls. False-trigger count
  over a few minutes of playback is written down.
- **Files:** `app/src/renderer/ChatPanel.tsx`, `app/src/core/bridge.ts`, `app/electron/`, `app/src/node/muse.ts`.


### B7. Remaining sidecar tools (S4, part 2)
`set_synth_knobs`, `fit_synth_to_reference` (`spikes/c_recreate`), `generate_mrt2` (`spikes/d_mrt2`,
`spikes/j_evals/mrt2_cuda.py`). Only if the demo needs reference recreation or MRT2 (open decision).

### B8. Move live sidecar code out of `spikes/`
Into a top-level `sidecar/` with one entry point. On hold until B3 is done and the user agrees.

### B9. Ears: let Muse describe a sound and check its own knob moves (S7)
- **Why:** today Muse never gets a description of the audio, only the session, knob values and
  Freesound metadata. It moves knobs blind and the user judges.
- **Cheap version (preferred):** render the track before and after a change (`renderTrack`, offline),
  measure brightness, loudness, noise, pitch and envelope (the features in `spikes/ears.py`), and
  return them as text in the tool result: "brightness +18%, level −0.4 dB". Muse can then say
  what it did and catch a move that went the wrong way.
- **Heavier version:** PE-AV word scores ("is this grittier?"); tracks drive, resonance, attack and
  detune but misses brightness and noise. PE-AV large is untested. Only if the cheap version isn't enough.
- **Depends on:** B1.

## Dropped

- SAM Audio GGUF for stems (B4, Oct 27): lost to htdemucs_6s / Mel-RoFormer on every scored part
  and by ear on 6 voice notes; 8–12 GB VRAM vs ~1.5 GB. Details: `spikes/l_sam_audio/README.md`.
- YuE / Noiz (song generation from lyrics): off-pitch, 24 GB VRAM, CC BY-NC weights (Oct 27).
- Local Qwen as a Muse stand-in (Oct 27). DeepFilterNet for cleanup (treats humming as noise).
  Audiobox Aesthetics as a closeness grader. pedalboard (GPL-3.0).

## Done

- 2026-10-27: S1 effects engine + verification; device panel; S3 audio to MIDI wired in; canvas UI;
  sound library; clip moves and snap; musical typing and sampler; repo docs reorganised (`CLAUDE.md`,
  this backlog, `spikes/README.md`).
