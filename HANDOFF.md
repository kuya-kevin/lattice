# Lattice status

**Updated 2026-10-28 (day 3 of 10).** Submission: Nov 4 2026, 9:00 PM ET.
This is the one current-status page. What's left to do is in `docs/backlog.md`; rules and commands
are in `CLAUDE.md`; direction is in `idea.md`. Parallel lanes and merging (Oct 29): `docs/parallel-work.md`.

## Status by part

| Part | State | Where |
|---|---|---|
| Mini-DAW (Electron + web) | **Working, still buggy.** More bug and quality-of-life items from the user are coming (`docs/backlog.md`, B0). Tracks, trim, record, punch-in, click and count-in (record timing fixed Oct 28: count-in on the beat and on the grid, cancellable; MIDI and mic takes latency-compensated; GarageBand comparison fixes Oct 28: playback survives region edits, cycle recording, tempo changes keep bars, stop where heard, bar-line , / .), tempo/key/time-signature LCD, GarageBand shortcuts, clips movable across tracks with snap, copy/paste, tap tempo, click-the-ruler playhead, deleting sounds from Ideas, Ideas before tracks (library + → try on Musical Typing → record onto a new track; drag a card onto the arrangement) and a version stack per processed sound (Oct 28), resizable panels, sound library panel, musical typing, a sampler from any clip, a drum pad (B12, Oct 28: 9 pads on Q W E / A S D / Z X C from Ideas or library sounds; takes record on the kit). Canvas UI (dot grid, floating panels, bottom prompt bar). | `app/` |
| Muse agent | **Working.** OpenAI-format tool calling against the Meta API; sees session state and hand edits as text. Recorded fixtures for tests. | `app/src/core/agent.ts`, `app/src/node/muse.ts` |
| Effects engine (S1) | **Working by ear; correctness rests on measurement.** The user's ears are not the source of truth here. The source of truth is the verification harness: each device is rendered headless and measured against a published reference (RBJ EQ cookbook, Giannoulis compressor curves, Schroeder RT60, BS.1770 loudness). Last run Oct 27: 68 pass, 2 known pitch gaps. It is not part of `vitest`; re-run it after any DSP change. A Logic "golden bounce" comparison is set up but not done. 13 devices (native Web Audio, Faust WASM, Signalsmith Stretch), one catalog JSON for UI and agent. | `app/src/fx/`, `docs/fx-verification.md` |
| Device panel | **Working.** Generated from the catalog; knob moves go through the same tools as Muse. Save a chain by name and load it on any track (B10, Oct 27; stored in userData in Electron, in memory on the web). | `app/src/renderer/DevicePanel.tsx` |
| Autosave and versions | **Working** (B11, Oct 28). Electron autosaves the session and reopens it on launch, audio included. Named versions plus an auto version before each Muse turn; Versions menu in the control bar; Muse can save and restore. Web build: versions in memory only. | `app/src/core/versions.ts`, `app/src/node/projectFiles.ts` |
| Words to knob moves (S2) | **Working; by-ear check left (Oct 28).** `suggest_moves` serves `vocab.json` v2 to Muse (how far to move which knobs, per source type from the track name); one line in the system prompt. Baseline recorded without it: 10 phrases, 54 calls, mostly sensible picks, and two tool bugs found and fixed (backlog B1). Recorded with it: Muse looks the words up first in all 10 and applies the vocab values (45 calls vs 54); replay tests in `tests/fx-agent.test.ts`. Left: the user judges by ear. | `app/src/fx/vocab.json`, `app/src/fx/vocab.ts` |
| Audio to MIDI (S3) | **Working; the user judged it acceptable on two real voice notes in the app (Oct 28).** Tools `extract_midi` / `quantize_midi` (`record_midi` is the separate Musical Typing take tool). Scored only on the synthetic set and in e2e with a mock result. **Runs on the Mac since Oct 28** (`LATTICE_BIGDISK=~/lattice-data`; ~43 s per 20 s note, warm). **Piano Roll** (Oct 28): double-click a region or press P to see and edit its notes; an audio region opens the **Audio Editor** there (scrub, trim, move to the grid). Synthetic phone set F1: bass 0.98, layered hum 0.89, hum 0.67, layered keys 0.59 (weakest). **Oct 27: MuScriptor medium is now the default transcriber** (basic-pitch kept for the layered melody): hum 0.84, keys 0.90, layered bass 0.96, layered keys 0.68. The user listened to old vs new on the voice notes and judged the new one good. | `spikes/k_source_prep/` |
| Sidecar (S4) | **Partly real.** `extract_midi`, `cleanup_noise`, `quantize_drums`, `slice_drums` and `find_sound` (B13, Oct 28: analysis only, the app edits) are real (one-shot child processes; B3, Oct 28: the track switches to the processed take, one undo step). `generate_mrt2`, `set_synth_knobs`, `fit_synth_to_reference` return fake results. Working Python exists for synth + fit (`c_recreate`) and MRT2 (`d_mrt2`, `j_evals`). | `app/src/core/sidecar.ts`, `spikes/k_source_prep/engineer.py` |
| Voice commands (S6) | **Push-to-talk working (B2, Oct 28); wake word tabled.** Hold ` or the mic button, speak, let go: playback pauses, Muse Voice Transcribe (Meta, $0.18/hr) turns the clip into text, and it is sent as a chat turn. Checked live through the browser path; not yet by voice in Electron. The wake word "Hey Muse" needs a local Meta-only spotter (backlog B2). | `app/src/renderer/pushToTalk.ts`, `app/src/node/stt.ts` |
| Freesound search | **Working** in the app (`search_freesound`, timbre filters). | `app/src/core/freesound.ts` |
| Stems / isolate by description (S8) | **SAM Audio dropped (Oct 27); htdemucs_6s + Mel-RoFormer stay** (Demucs is Meta's). SAM GGUF via audio.cpp lost to them on every scored part (synthetic voice notes and MUSDB), needs 8–12 GB VRAM vs ~1.5 GB, and the user preferred htdemucs by ear on 6 voice notes. | `spikes/l_sam_audio/README.md` |
| Evals (S7) | **Research, plus measured features in the app (B9).** These answer "can anything other than the user's ears judge a sound?" Results: Muse can't hear music; spectral distance picks the user's winner in 77% of pairs, so it can check "closer to a reference" (only useful for reference recreation); PE-AV tracks some words (drive, resonance, attack, detune) but misses brightness and noise; Audiobox Aesthetics doesn't help. **B9 (Oct 28): `measure_track` gives Muse measured features as text** (level, crest, spread, brightness, 7 bands, width) for a track with and without its effects, and what the effects changed; built in `app/src/core/ears.ts`, checked on synthetic signals and the real chain. Not yet seen in a live Muse turn. | `docs/spike-results.md`, `spikes/j_evals/README.md` |
| Demo, public repo | **Not started.** | — |

## Tests (2026-10-28)

- Vitest: 238 passing in 25 files (Oct 29, after the multi-select / track reorder / cycle batch). `npx tsc --noEmit` clean. Oct 29: `e2e/arrange-multi.spec.ts` (4) plus 10 related specs pass (full suite not re-run).
- Playwright: 81 tests (web + 8 Electron) in 23 specs; all passed Oct 28 after the B0 bug batch, and the 3 B2 tests and the 4 `engineer.spec.ts` tests (with B13) pass (full suite not re-run) (`app/e2e/`), plus the fx render harness (`app/e2e-fx/`). Known: a second arrangement trim within ~1 s of the previous one can miss (backlog B0). Electron tests launch with a fresh `LATTICE_USER_DATA` folder each.
- **After a pull that changes `app/patches/`:** if Play does nothing ("TonePlayout not initialized"), the old patch is still applied. Run `rm -rf node_modules/@waveform-playlist/browser && npm install` in `app/`. This was the cause of two `playback-edits` failures on Oct 28.
- Fixed Oct 28: in the Audio Editor, a trim followed by dragging the region body did nothing (the trim's text selection started a native drag). `user-select: none` on `.ae-canvas`. The Piano Roll's `.pr-canvas` has no such rule; check it by hand.

## Spend

Meta API: about $0.11 of $150 as of Oct 28 (B1 smoke test, baseline and vocab run: $0.091, ~$0.001 per call). Update this line
when you make Muse calls.

## Machines

- **Mac:** listening, recording, the demo. MRT2 runs here via MLX (`envs/mrt`, `mlx==0.31.1`).
- **3090 box (24 GB VRAM):** GPU evals. Root disk nearly full: caches, venvs and weights go to
  the big data disk (`LATTICE_BIGDISK`). `.env`, `data/` and `out/` are git-ignored and copied by hand.
- Each Python env is its own uv project (`spikes/`, `envs/*`, `spikes/j_evals/envs/*`); run `uv sync` in each.

## Needs from the user

- Judge S2 by ear: try the 10 B1 phrases in the Electron app on real tracks, mark each good / close / wrong (this also shows whether Muse uses `measure_track`, B9).
- Send the next batch of DAW bugs and quality-of-life items (B0).
- A listen to the drum quantize result (`spikes/f_engineer`).
- One line per voice note 112, 114, 119, 143, 145: hum, instrument, or layered?
- A dry vocal take with strong "s" sounds (for the de-esser).
- Check a few Logic knob ranges in `docs/plugin-catalog.md` on the Mac.
- Commit the Oct 29 parallel-work setup (`.githooks/`, `.claude/settings.json`, `.gitignore`, docs) before starting lanes: worktrees start from the last commit and won't have the hook or rules until then.

## Open decisions

- Are reference recreation (synth + optimizer) and Magenta RT2 in the demo? If not, most of S4 shrinks.
- Demo script (3 minutes); Meta models must stay central.
- Voice commands (B2) are tabled. Wake word decided: "Hey Muse"; the local keyword spotter is still open.
