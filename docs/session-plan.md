# Session plan

> Stream definitions (S0-S8) and decisions. Live status is in `HANDOFF.md`; remaining work, in priority order, is in `docs/backlog.md`.

Updated 2026-10-26 after the workflow interview. Work happens on the 3090 box; the Mac is for listening and recording.

## Product statement
A mini-DAW where the producer talks (push-to-talk) and Muse performs the commands: shape a sound with effects, add quantized drum/bass/piano MIDI, put a vocal chain on a recording, do light arrangement. Everything runs inside Lattice. Logic is the inspiration, not the host. Secondary use case: isolate stems from a song for remixing.

## Producer workflow (source of truth)
1. Capture an idea: voice note (sometimes hummed, sometimes an instrument; often poor audio, sometimes layered) or a snippet of a song.
2. Isolate parts, ideally to MIDI.
3. Shape the sample: pitch, reverb, filter, distortion until it sounds decent.
4. Add quantized drum/bass/piano MIDI.
5. Record vocals with a minimal chain (compressor, de-esser, reverb, EQ); light arranging.
Pain point: not knowing which knob to use ("how do I make my vocals stand out in the mix").

## Ground rules
- Stage only; no commits unless asked. Subagents and worktrees for parallel streams.
- Session spend limit: **$1** on Meta calls. Test a few calls before any batch. Use `muse-spark-1.3-contributor`.
- Muse cannot hear music; do not pay for audio calls on music.
- Keep copyrighted reference audio local; only CC0/CC-BY in anything shown.
- Large caches (HF, uv, models) go under `<bigdisk>/` (a project folder on the large data drive; the root disk is nearly full). Keep `.venv` on the main disk (NTFS).

## Streams

| ID | Stream | Goal | Depends on | Done when |
|---|---|---|---|---|
| S0 | **Setup** | Node and `npm install`, app runs in the browser; uv envs synced into `<bigdisk>/venvs/`; caches on `<bigdisk>` (root disk has <2 GB free) | none | `npm test` and `npm run dev:web` work; env sync notes in HANDOFF |
| S1 | **Effects engine + knob catalog** | Comprehensive device set reusing open-source DSP (see `plugin-catalog.md`), typed knobs with ranges/units/defaults, **live in the browser** with a hand-tunable knob panel; same graph renders offline for the agent | S0, S5 research | each device renders a test file; knob catalog is a single JSON the agent and UI both read; pytest checks measurable effects (e.g. EQ band moves the spectrum) |
| S2 | **Vocabulary layer + Muse mapping** | Words to knob moves ("gritty", "warm", "bright", "wide", "punchy", "stand out in the mix"), per source type (vocal, bass, drums, pad); Muse picks devices and values | S1 catalog (schema), Muse key | recorded-fixture tests: a set of requests produces sensible, bounded tool calls; user judges 10 phrases by ear |
| S3 | **Source prep to MIDI** | Clean phone audio, isolate layers/instruments, convert to notes (octave fix, key snap, quantize) | S0, data/ | pipeline script on the 4 voice notes + Freesound set; accuracy scored on a synthetic phone-quality set (mir_eval note F1) |
| S4 | **Sidecar bridge** | One local Python process the app calls for: cleanup, separation, audio to MIDI, effects render, quantize | S1/S3 interfaces | app tools call real implementations; stubs replaced |
| S5 | **Plugin research** | Survey stock Logic plugins and common third-party ones for knobs/ranges/typical chains; map to what pedalboard can do; list gaps | none | `docs/plugin-catalog.md` with per-device knob tables and the gaps list |
| S6 | **Voice commands** | Push-to-talk hotkey or the spoken wake word "Muse" (spotted locally) records speech, Muse 1.2 audio-in transcribes, feeds the agent | S0 | spoken command reaches the agent and runs a tool in the web app |
| S7 | **Eval (optional)** | Pair ratings, ears (PE-AV), reference recreation, MRT2 | user ratings | decision recorded: keep or drop each module |
| S8 | **Stems/remix** | Whole-song separation (Demucs, SAM Audio) and export | S3, SAM access | export of stems with quality notes |

### Suggested order and parallelism
- **Wave 1, parallel worktrees:** S0 (me, first, small), S5 (research subagent), S3 (prep subagent; needs only data and uv).
- **Wave 2:** S1 (needs S5 output), S6 in parallel.
- **Wave 3:** S2 (needs S1 schema), S4 wiring.
- **Wave 4:** S8, then S7 as time allows.

Your earlier priority was E/D/C/B/A. Mapping: E is S1+S2, D is S3+S8 (separation), C is S3 accuracy, B and A are S7 and S4. S4 is promoted because everything real needs it.

## Open decisions
1. **Knob scope:** "as comprehensive as possible" is the goal. Proposal: ~10 devices at 8 to 25 knobs each, based on the S5 catalog, built as one JSON schema so adding a device means adding data, not code.
2. **DSP source (researched, see `plugin-catalog.md`):** one browser implementation, no pedalboard (it is GPL-3.0 and has no expander or de-esser). Native Web Audio / Tone.js for EQ, saturation, filter, delay, modulation, utility; Faust compiled to WASM (permissive parts only) for compressor, de-esser, gate, limiter, reverb (`zita_rev1`); Signalsmith Stretch (MIT) for pitch. Offline/agent renders use the same graph in `OfflineAudioContext`, rendered headless via Playwright/Electron. 13 devices in v1. No browser de-esser exists anywhere, so we write a small Faust one. Logic knob ranges in the catalog are approximate; confirm on the Mac.
3. **Browser vs Electron audio (decided):** effects run **live in the browser/app** so the user can hand-tune them. Agent renders should reuse the same graph via `OfflineAudioContext` where possible, so there is one DSP implementation; the Python sidecar keeps only what the browser can't do (separation, transcription, cleanup).
4. **Reference recreation:** kept as an optional module (S7), aimed at other users (remixers). The pair round shows spectral distance agrees with ears 77% of the time, so the agent can self-check "closer to the reference" (see `spike-results.md`).
6. **Planner (decided 2026-10-27):** Muse is the agent; the local-Qwen stand-in was tried and dropped. Muse costs about $0.04 per mixing request with the full tool prompt, and the budget is ~$150 to Nov 4, so keep Muse testing small and deliberate.
5. **Demo story** for the hackathon (Nov 4, 3-minute video): to be written after S1/S2 show something. Meta models must stay central.

## Needs from the user
- ~~Node + `npm install`~~ done. ~~A/B pair ratings~~ done.
- Judge S2 results by ear (10 phrases), once.
- Provide 2 to 4 real examples: a layered voice note, a vocal take, a drum idea, and a song snippet you would want stems of (kept local). A Freesound "producer material" set is being curated in parallel.
- SAM Audio access status: check HF for the approval email.
- Confirm or edit the open decisions above.

## Done so far
- Pair-rating round analysed (spectral distance matches ears 77%).
- Plugin research done: `docs/plugin-catalog.md` (13-device v1 set, knob tables, catalog JSON schema, licence flags, gap list).
- Freesound producer-material set: 48 CC0/CC-BY sounds in 6 categories, `data/freesound_material/` (script `spikes/h_freesound/curate_material.py`). Dry vocals are thin.
- Local Qwen3.8 27B tried as a Muse stand-in, then dropped in favour of Muse (2026-10-27).
- 5 new voice notes (`.m4a`) in `data/voice_notes/`, awaiting conversion.
- Docs reorganised; architecture diagrams updated (this commit set is staged only).
- Files transferred to this machine; keys present; Meta spend ~$0.03.
- S3 source prep → MIDI (`spikes/k_source_prep/`): router (Mel-RoFormer / htdemucs_6s → pyin /
  basic-pitch, YourMT3+ opt-in), cleanup (range, octave fix, pruning, merge, key snap, tempo +
  quantize), onset drum/beatbox → MIDI. Wired into the app as `extract_midi` / `quantize_midi` with
  MIDI clips and a built-in synth. Results in its README.
