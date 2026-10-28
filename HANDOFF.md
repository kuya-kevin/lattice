# Lattice status

**Updated 2026-10-27 (end of day 2 of 10).** Submission: Nov 4 2026, 9:00 PM ET.
This is the one current-status page. What's left to do is in `docs/backlog.md`; rules and commands
are in `CLAUDE.md`; direction is in `idea.md`.

## Status by part

| Part | State | Where |
|---|---|---|
| Mini-DAW (Electron + web) | **Working, still buggy.** More bug and quality-of-life items from the user are coming (`docs/backlog.md`, B0). Tracks, trim, record, punch-in, click and count-in, tempo/key/time-signature LCD, GarageBand shortcuts, clips movable across tracks with snap, copy/paste, tap tempo, click-the-ruler playhead, deleting sounds from Ideas, resizable panels, sound library panel, musical typing, a sampler from any clip. Canvas UI (dot grid, floating panels, bottom prompt bar). | `app/` |
| Muse agent | **Working.** OpenAI-format tool calling against the Meta API; sees session state and hand edits as text. Recorded fixtures for tests. | `app/src/core/agent.ts`, `app/src/node/muse.ts` |
| Effects engine (S1) | **Working by ear; correctness rests on measurement.** The user's ears are not the source of truth here. The source of truth is the verification harness: each device is rendered headless and measured against a published reference (RBJ EQ cookbook, Giannoulis compressor curves, Schroeder RT60, BS.1770 loudness). Last run Oct 27: 68 pass, 2 known pitch gaps. It is not part of `vitest`; re-run it after any DSP change. A Logic "golden bounce" comparison is set up but not done. 13 devices (native Web Audio, Faust WASM, Signalsmith Stretch), one catalog JSON for UI and agent. | `app/src/fx/`, `docs/fx-verification.md` |
| Device panel | **Working.** Generated from the catalog; knob moves go through the same tools as Muse. | `app/src/renderer/DevicePanel.tsx` |
| Words to knob moves (S2) | **Partial.** Muse can already insert devices and set knobs: `list_devices` shows each device and knob with the words it fixes (e.g. low cut: rumble, muddy, boomy), so Muse knows *which* knob. It gets no guidance on *how far* or per source type; that's what `vocab.json` holds, and Muse never sees it. Muse has never been run on the effects tools: the recorded fixtures predate S1. | `app/src/fx/vocab.json` |
| Audio to MIDI (S3) | **Wired in, not tried by the user.** Tools `extract_midi` / `quantize_midi` (`record_midi` is the separate Musical Typing take tool). Scored only on the synthetic set and in e2e with a mock result. **Runs on the Mac since Oct 28** (`LATTICE_BIGDISK=~/lattice-data`; ~43 s per 20 s note, warm). **Piano Roll** (Oct 28): double-click a region or press P to see and edit its notes. Synthetic phone set F1: bass 0.98, layered hum 0.89, hum 0.67, layered keys 0.59 (weakest). **Oct 27: MuScriptor medium is now the default transcriber** (basic-pitch kept for the layered melody): hum 0.84, keys 0.90, layered bass 0.96, layered keys 0.68. The user listened to old vs new on the voice notes and judged the new one good. Not yet tried from the app (backlog B3a step 6). | `spikes/k_source_prep/` |
| Sidecar (S4) | **Mostly stubs.** Only `extract_midi` is real (one-shot child process). `quantize_drums`, `cleanup_noise`, `generate_mrt2`, `set_synth_knobs`, `fit_synth_to_reference` return fake results. Working Python exists for cleanup (`b_cleanup`), drum quantize (`f_engineer`), synth + fit (`c_recreate`), MRT2 (`d_mrt2`, `j_evals`). | `app/src/core/sidecar.ts` |
| Voice commands (S6) | **Not started, tabled.** Push-to-talk plus the wake word "Hey Muse". Muse audio input transcribes speech word for word (verified); the wake word must be spotted locally. | — |
| Freesound search | **Working** in the app (`search_freesound`, timbre filters). | `app/src/core/freesound.ts` |
| Stems / isolate by description (S8) | **SAM Audio dropped (Oct 27); htdemucs_6s + Mel-RoFormer stay** (Demucs is Meta's). SAM GGUF via audio.cpp lost to them on every scored part (synthetic voice notes and MUSDB), needs 8–12 GB VRAM vs ~1.5 GB, and the user preferred htdemucs by ear on 6 voice notes. | `spikes/l_sam_audio/README.md` |
| Evals (S7) | **Research, not in the app.** These answer "can anything other than the user's ears judge a sound?" Results: Muse can't hear music; spectral distance picks the user's winner in 77% of pairs, so it can check "closer to a reference" (only useful for reference recreation); PE-AV tracks some words (drive, resonance, attack, detune) but misses brightness and noise; Audiobox Aesthetics doesn't help. Today Muse gets **no description of the audio itself**, only the session, knob values and Freesound metadata. A cheap "ears" step (measured features as text, `spikes/ears.py`) would let Muse describe a sound and check that a knob change moved it the right way: backlog B9. | `docs/spike-results.md`, `spikes/j_evals/README.md` |
| Demo, public repo | **Not started.** | — |

## Tests (2026-10-27)

- Vitest: 115 passing in 15 files. `npx tsc --noEmit` clean.
- Playwright: 41 web tests in 12 specs plus 4 Electron (`app/e2e/`), plus the fx render harness (`app/e2e-fx/`). All passed Oct 27 (evening).

## Spend

Meta API: about $0.03 of $150 as of Oct 26; recent sessions made no paid calls. Update this line
when you make Muse calls.

## Machines

- **Mac:** listening, recording, the demo. MRT2 runs here via MLX (`envs/mrt`, `mlx==0.31.1`).
- **3090 box (24 GB VRAM):** GPU evals. Root disk nearly full: caches, venvs and weights go to
  the big data disk (`LATTICE_BIGDISK`). `.env`, `data/` and `out/` are git-ignored and copied by hand.
- Each Python env is its own uv project (`spikes/`, `envs/*`, `spikes/j_evals/envs/*`); run `uv sync` in each.

## Needs from the user

- Judge S2 by ear (10 phrases) once it's wired.
- Try `extract_midi` on two real voice notes in the app on the Mac and judge them in the Piano Roll (B3a step 6).
- Send the next batch of DAW bugs and quality-of-life items (B0).
- A listen to the drum quantize result (`spikes/f_engineer`).
- One line per voice note 112, 114, 119, 143, 145: hum, instrument, or layered?
- A dry vocal take with strong "s" sounds (for the de-esser).
- Check a few Logic knob ranges in `docs/plugin-catalog.md` on the Mac.
- Commit the staged work once reviewed: worktree agents start from HEAD and won't see staged files.

## Open decisions

- Are reference recreation (synth + optimizer) and Magenta RT2 in the demo? If not, most of S4 shrinks.
- Demo script (3 minutes); Meta models must stay central.
- Voice commands (B2) are tabled. Wake word decided: "Hey Muse"; the local keyword spotter is still open.
