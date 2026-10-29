# Backlog

Updated 2026-10-28. One entry per remaining task, in priority order. Each says what "done" means,
which files it touches, and what it depends on, so an agent can be pointed at one entry.
Rules and commands: `CLAUDE.md`. Status: `HANDOFF.md`. Stream ids (S0–S8): `docs/session-plan.md`.

When you finish an entry: move it to "Done" at the bottom with the date and a one-line result,
and update the `HANDOFF.md` status table.

## Now

### B0. DAW bugs and quality of life (ongoing)
- **Deferred (Oct 28, after the second batch):** paused until the user sends the next list.
- **What:** the mini-DAW works but is still buggy. The user will send items; list each one here as
  a bullet with a date, and fix them between the bigger entries.
- **Done when:** each item has a failing Playwright test first, then the fix (`docs/local-testing-workflow.md`).
- **Items:**
  - 2026-10-27, done: tap tempo (T; hint on the tempo field).
  - 2026-10-27, done: delete a sound from Ideas (× on hover, or Delete/Backspace on a focused card; asks if clips use it; undoable).
  - 2026-10-27, done: click or drag the bar ruler to move the playhead (snapped). Also fixed: the playhead
    snapped back to the end of the audio when sent past it (`go_to`, `.`), because the engine's `seekTo` clamps.
  - 2026-10-28, done: record timing. The count-in was 111 ms late into the transport and not on the bar grid;
    MIDI notes landed ~100 ms late; mic takes had no latency compensation; the count-in couldn't be cancelled.
    All fixed and measured (`e2e/record-timing.spec.ts`, `src/core/recordTiming.ts`). Still open: a user-set
    recording delay (browsers rarely report mic latency), and punching in while playing without a restart.
  - 2026-10-28, done: playback across region edits. A trim/move/duplicate/delete rebuilds waveform-playlist's
    engine; Play during the rebuild (Muse's "trim it and play") was silent and could stay broken, and an edit
    while playing stopped the audio while the UI still showed playing. Patched the provider (play/stop wait for
    the new engine; it resumes from the heard position) and the click re-anchors (`e2e/playback-edits.spec.ts`).
  - 2026-10-28, done: cycle recording. The transport looped but the take didn't, so notes after the wrap
    landed past the cycle end. Now MIDI passes merge into one region over the cycle and a mic take keeps the
    latest pass, as in GarageBand (`foldMidiTake` / `cycleMicTake` in `src/core/recordTiming.ts`). Not yet: take folders.
  - 2026-10-28, done: tempo changes keep regions on their bars (`changeTempo`): MIDI notes stretch, audio
    regions move but aren't time-stretched, and the cycle area, punch range and playhead follow
    (`e2e/tempo-change.spec.ts`). `extract_midi` adopting a detected tempo still only relabels the grid.
  - 2026-10-28, done: Stop leaves the playhead where it was heard; it jumped ~0.13 s on (lookahead + output
    latency), so the next Play skipped that much. Muse's `stop` (no position) still leaves the session's
    position stale, though the engine stops in the right place.
  - 2026-10-28, done: , and . go to the previous / next bar line (they moved a bar from wherever the
    playhead was, keeping the offset).
  - 2026-10-28, done (batch of 10, `e2e/ideas-flow.spec.ts`): L toggles the library (O still works);
    Muse chat starts hidden; a library preview still loading when the panel closed started anyway (fixed);
    the Musical Typing window drags by its title bar (remembered; double-click resets); the Piano Roll
    previews notes on the region's own instrument (sample, kit or piano) through the track's effects;
    rubber-band note selection on empty grid (Shift adds).
  - 2026-10-29, done (batch of 5, `e2e/arrange-multi.spec.ts`): multi-select regions (Shift/Cmd-click, or a
    marquee from empty lane space) and drag them together (`move_clips`, one undo step; Delete runs
    `delete_clips`); reorder tracks by dragging a header (`move_track`, Muse can call it too); the cycle area
    snaps to the grid in the ruler; C turns Cycle on around the selected regions, widened to the Snap grid
    (Beat: 1.4 to 2.4; Bar: whole bars; Off: the regions' edges; none selected: the last area); with Cycle on, Play starts at the cycle start. Not yet: track colours follow
    the position, so a moved track changes colour; a group drag can't make a new track.
  - 2026-10-28, done: try a sound before it has a track. Library rows get a + (tool `add_sound`, user only):
    the sound goes to Ideas on no track and Musical Typing opens with it; clicking an Ideas card on no
    track does the same; R then records onto a new track named after it. Ideas cards drag onto the
    arrangement (tool `place_sound`, Muse can call it). The try-out lives in the renderer
    (`musicalTyping.audition`), not the session, so Muse doesn't see it.
  - 2026-10-28, done: versions of a processed sound. A sound and its cleanup / quantize versions share
    one Ideas card showing the one in use; its Versions list plays each and switches the clips
    (tool `use_audio_version`, Muse too; the summary names a processed clip's original).
  - 2026-10-28, partly: "can't trim clips" did not reproduce (arrangement and Audio Editor trims pass in
    web and Electron). The arrangement's trim edges were invisible 8 px zones: now 10 px and lit on hover.
    Open: a second trim started within ~1 s of the previous one sometimes never starts a drag (playlist
    re-render); the Electron test waits 1.5 s. Ask the user what they grabbed if it still fails.

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
- **Cost:** about $0.10 total (~$0.001 per call, measured Oct 28). Ask before each recording
  step (`npm run record-fixtures` is denied in settings).
- **Progress (Oct 28):** steps 1-4 done.
  - **Cost** is far below the estimate: ~9.5k prompt tokens and ~$0.001 per call. Smoke test $0.011, baseline $0.042.
  - **Baseline** (no vocabulary; fixtures in `tests/fixtures/baseline/`): 54 calls for 10 phrases, 23 of them
    `list_devices` lookups. Picks were mostly sensible:

    | Phrase | Muse picked (baseline) | Calls | Issue |
    |---|---|---|---|
    | stand out (vocal) | EQ: low cut 100, −2.5 @ 350, +3 @ 3k, +1.5 air; comp 3:1 −18 | 5 | — |
    | harsh (vocal) | de-esser 7 kHz + EQ −2.5 on bell 3 at its default 2.5 kHz | 8 | read "harsh" as sibilance; no EQ freq chosen |
    | sibilant (vocal) | de-esser at defaults | 3 | no knob moves |
    | warm (bass) | EQ low shelf +4 @ 120, high shelf −3; tube sat 6 | 9 | 5 separate set_params |
    | muddy (bass) | EQ low cut 35, −4 @ 220 | 3 | — |
    | punchy (drums) | FET comp 4:1 −18, attack 10 **→ 0.3 ms** | 4 | **bug**: style preset overwrote attack |
    | glue (drums) | VCA comp 2.5:1, knee 12, attack 10, release 200 | 6 | same bug; 3 calls to re-set knobs |
    | wider + spacious (pad) | width 150, mono below 200; chorus; reverb 3.5 s 30% | 6 | 5 lookups |
    | grit, then back off (bass) | tube sat 12 dB, then nudge −1 → 9 | 5 | (3 failed calls before the string fix) |
    | telephone (vocal) | filter HP 400 + filter LP 3.2k | 5 | — |
  - **Two tool bugs fixed** (tests in `tests/fx.test.ts`): `set_param` rejected numbers sent as strings for
    add/mul/nudge (Muse always sends `"-1"`); `insert_device` applied a `style` preset after the knobs given with
    it, so the preset reset them.
  - **Step 4:** `suggest_moves(words[], track_id?, source_type?, amount?)` in `fx/tools.ts`, lookup in
    `fx/vocab.ts` (source type from the track name, aliases, per-source entries, amount scaling, lists the
    track's existing devices). `vocab.json` v2: 31 entries, per-source variants for warm and muddy, aliases and
    a one-line note each; telephone now band-limits 350 Hz-4 kHz with the EQ plus a little crunch. One line in
    the system prompt. Tests: `tests/vocab.test.ts` (each of the 10 phrases applies to its track only, nothing
    clamped), vocab range and lookup tests in `tests/fx.test.ts`.
  - **Step 5, with vocabulary ($0.038):** Muse called `suggest_moves` first in all 10 and applied the moves as
    given. 45 calls instead of 54; `list_devices` lookups 3 instead of 23; every final knob equals the vocab value.
    | Phrase | With `suggest_moves` | Calls (baseline) |
    |---|---|---|
    | stand out | EQ low cut 100, −2 @ 350, +2.5 @ 3k; comp thresh −22 | 4 (5) |
    | harsh | EQ −3 @ 3.5 kHz, Q 1.5 (no de-esser now) | 4 (8) |
    | sibilant | de-esser 6.5 kHz, thresh −30, range 6 | 4 (3) |
    | warm bass | EQ low shelf +3 @ 120, high shelf −2; tape sat 6 | 6 (9) |
    | muddy bass | EQ low cut 30, −4 @ 250 | 4 (3) |
    | punchy drums | VCA comp 4:1, attack 25, release 80, thresh −24 | 4 (4) |
    | glue drums | VCA comp 2:1, attack 10, release 200, thresh −21 | 4 (6) |
    | wider + spacious pad | width 130, mono below 150; reverb decay 2.8 s, mix 28 | 4 (6) |
    | grit, then back off | transistor sat 12, then nudge → 9 | 7 (5) |
    | telephone | EQ 350 Hz-4 kHz band, transistor sat 8 | 4 (5) |
  - **Step 6 done:** `tests/fx-agent.test.ts` replays the 10: `suggest_moves` first, no failed calls, no clamp
    notes, only the named track edited, every knob in its usual range, punchy keeps its slow attack, "too much" lowers drive.
  - **Step 7, by ear (Oct 28, live in the app, phrases stacked on the same tracks):**
    | # | Phrase | User | What happened |
    |---|---|---|---|
    | 1 | stand out | — | **hit MAX_STEPS (10)**: 6 calls to apply, then measured, looked up comp, set makeup 2.8, measured again |
    | 2 | harsh | ok | EQ −3 @ 3.5k; reported brightness 893 → 805 Hz |
    | 3 | sibilant | n/a | needs a recording with real S sounds |
    | 4 | warm bass | ok (needs a better instrument) | applied, measured, then cut hs_gain −2 a second time |
    | 5 | muddy bass | bad (needs a better instrument) | −4 @ 250 Hz; reported low-mids −5 dB |
    | 6 | punchy drums | good | slow-attack comp; then makeup **+10.2 dB** to undo the level drop it measured |
    | 7 | glue drums | bad | **hit MAX_STEPS**: retuned the punchy comp instead of adding glue, chased thresh −18 → −28 |
    | 8 | wider + spacious pad | ok | applied as given; "width up slightly" |
    | 9 | grit, then back off | ok / no audible difference | nudge −1 = drive 12 → 9 dB with auto gain: too small to hear |
    | 10 | telephone | good | reused the vocal's EQ (stand-out and harsh moves still on), added crunch |
    Muse quoted measured changes in every finished reply (B9 works live). Problems: applying moves one knob
    per call eats the 10-step budget; compressor moves lower the level, so Muse chases it with makeup; the
    measurement compares against no effects, not against the last change, so stacked phrases are muddled;
    "back it off" is too small on drive.
  - **Next (tabled Oct 28), a listening eval before more vocab rules.** Every vocab number is still a guess, so
    settle them by ear instead of hand-picking more:
    1. Inputs from the user in `data/fx_eval/inputs/` (git-ignored): isolated, dry, time-aligned stems from one
       song, 8-15 s WAV: `vocal.wav` (clear S sounds), `bass.wav` (body at 200-300 Hz), `drums.wav`
       (uncompressed, real dynamics), `pad.wav` (stereo). Optional: a harsher vocal, a clean bass.
    2. Vocab eval (free, no Muse): apply each phrase's moves and render through the real chain in headless
       Chromium to `out/fx_eval/<run>/<case>/` (before + one WAV per variant). Open questions become blind
       A/B variants: glue retunes the existing comp vs a second comp; comp auto gain on vs off; "back it off"
       as −1 nudge vs half the drive. Judge page on the `spikes/e_eval` pattern; marks good/close/wrong + note
       to `out/eval/fx_ratings.jsonl`. Winners go into `vocab.json`.
    3. Then `apply_moves` (lookup + apply + measure in one call, one undo step; MAX_STEPS stays 10), and
       `measure_track` reporting the change since the last measurement as well as vs no effects.
    4. Agent eval: the same cases through Muse, recorded once live (~$0.05, ask first), replayed free;
       Muse's calls, reply and measurements saved next to the audio.
### B3. Make cleanup and drum quantize real (S4, part 1)
- **Do:** replace the `cleanup_noise` and `quantize_drums` stubs with the existing Python
  (`spikes/m_cleanup_models/clean.py` with `spikes/b_cleanup/run_noisereduce.py` as fallback, `spikes/f_engineer/quantize.py`), called the same way
  `extract_midi` is (a child process from `app/src/node/`), returning the processed audio as a new clip or take.
- **Done when:** both tools change the audio in the app; e2e tests run with a mock manifest
  (like `LATTICE_SIDECAR_MOCK`); the user has listened to one quantized loop.
- **Progress (Oct 28):** both tools are real. `spikes/k_source_prep/engineer.py` (run by `run_engineer.sh` in the
  `sep` env, which gained noisereduce) writes a mono WAV of the input's rate and length; `app/src/node/engineer.ts`
  spawns it (`LATTICE_ENGINEER_MOCK=1` returns the input, for e2e). The tool runs once per audio source on the track,
  then switches the track's clips to a new `processed` source in one undo step (`replaceTrackSource`); Muse sees
  `[audio: noise cleaned (Mel-RoFormer denoise)]` on the clip. Quantize puts the grid on the session's bars
  (phase = clip offset − start). Measured: Mel-RoFormer 32 s on a 33 s voice note (MPS), length exact.
  **Finding:** noisereduce's default 500 Hz mask smoothing took 6-7 dB off a harmonic tone; 100 Hz loses < 1 dB
  and still drops the floor ~22 dB (now the fallback's setting; the Oct 28 F1 for noisereduce used the default).
  Tests: `spikes/k_source_prep/test_engineer.py`, `app/tests/engineer.test.ts`, `app/e2e/engineer.spec.ts`.
  Left: the processed take is mono (the upload is mono); progress isn't shown during the ~30 s run; the user
  listens to one quantized loop and one cleaned note in the app.
  - **Note (Oct 28): no UI yet.** The tools are only reachable through Muse in chat. Add toolbar controls next to
    Extract MIDI, on the selected clip's track: "Clean noise" (busy state, then method + noise floor change) and
    "Quantize" (grid 1/4-1/32, strength). Same tools as Muse, so hand edits and one undo step; Playwright first.
- **Files:** `app/src/core/sidecar.ts`, `app/src/node/`, `app/src/core/tools.ts`, `spikes/b_cleanup`, `spikes/f_engineer`.
- **Note:** the move of live sidecar code out of `spikes/` is on hold (user decision, Oct 27).
- **Finding (Oct 28, `spikes/m_cleanup_models`):** cleanup in front of `extract_midi` lowers note F1
  (raw 0.80, noisereduce 0.59, Mel-RoFormer denoise 0.59; 0.58 / 0.67 with the mode forced), so
  `cleanup_noise` should clean the audio the musician hears and leave `extract_midi` on the raw take.
  Decided (Oct 28): Mel-RoFormer denoise (`denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt`, via the `sep`
  env) is the default, preferred by ear; ~17 s per 20 s note on MPS, so show progress. noisereduce (~0.2 s) is
  the fallback when the model isn't installed or fails; the tool result says which ran.

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

### B9. Ears: let Muse describe a sound and check its own knob moves (S7) — moved up Oct 27
- **Why:** today Muse never gets a description of the audio, only the session, knob values and
  Freesound metadata. It moves knobs blind and the user judges.
- **Evidence:** LLM2Fx (Doh et al., WASPAA 2025, arXiv 2505.20770) found an LLM picks better EQ and
  reverb settings from text when measured DSP features are in its context. LLM2Fx-Tools
  (arXiv 2512.01559) extends this to planning whole effect chains with tool calls. That is the
  cheap version below.
- **Cheap version (preferred):** render the track before and after a change (`renderTrack`, offline),
  measure brightness, loudness, noise, pitch and envelope (the features in `spikes/ears.py`), and
  return them as text in the tool result: "brightness +18%, level −0.4 dB". Muse can then say
  what it did and catch a move that went the wrong way.
- **Heavier version:** PE-AV word scores ("is this grittier?"); tracks drive, resonance, attack and
  detune but misses brightness and noise. PE-AV large is untested. Only if the cheap version isn't enough.
- **Depends on:** B1.
- **Progress (Oct 28): cheap version built.** `measure_track(track_id)` renders the track as heard and with its
  effects removed (in the renderer, which holds the audio: an IPC round trip from Electron main, or in-page on
  the web) and returns both feature sets plus `what_the_fx_do`, the changes largest first, e.g. "air band −21.7 dB
  vs the least-changed band", "brightness −80%", "loud-quiet spread −13.8 dB, loud and quiet parts closer
  together". Features (`app/src/core/ears.ts`, pure TS, no model): level, sample peak, crest (10 ms peak over
  level), loud-quiet spread (400 ms windows), spectral centroid, 7 band levels, stereo width. The system prompt
  says to call it once after effect moves and report the measured change.
  - Three readings were wrong on the first try and are fixed, each with a test: band changes measured against
    the overall level (or the median band) made untouched bands read as boosted after a high cut, so the
    reference is now the least-changed band; a sample-peak crest read a 10:1 compressor as "more dynamic", so
    crest uses the loudest 10 ms; and crest vs spread are now described as what they are (peaks standing out
    vs loud and quiet parts closer together) instead of "compressed / dynamic".
  - Tests: `tests/ears.test.ts` (known answers on synthetic signals), `tests/vocab.test.ts` (the tool),
    `e2e/measure.spec.ts` (real effect chain in the page: a high cut reads darker with less air, a compressor
    reads as closer loud and quiet parts), and an Electron test of the IPC path.
  - **Left:** recorded scenarios can't measure (Node has no audio engine), so Muse's use of it is checked live:
    the B1 step 7 phrases in the app exercise it too. Look for Muse quoting the measured change, and fixing a move
    that measured the wrong way.

### B12b. Drum pad, part 2
Part 1 (the playable kit) is in Done. Left, roughly in order of demo value:
- **Muse fills a kit:** "make me a dusty lo-fi kit". Muse can call `set_pad` today, but only with
  sounds already in the session; it needs a way to pull library or Freesound sounds into the
  session (the renderer decodes audio, so this is a renderer round trip like `measure_track`).
  Picks go by names, tags and categories, plus B9 features.
- **Piano Roll:** pad names as row labels on kit clips, and a note click plays the pad (today
  `auditionNote` plays the built-in drums for kit clips; it has no session).
- **Export kit:** the pad WAVs plus a credits file for the CC-BY sounds.
- Per-pad trim, gain and choke groups (closed hat cuts the open hat); rename a pad or kit in the UI
  (tools exist); drag a kit card onto the arrangement; wires from a kit card to its tracks.
- Velocity per pad or by key modifier (fixed at 100 for now, decided Oct 28).

### B6. Demo script and public repo
- **Positioning (research, Oct 27):** "agentic DAW" is already a crowded category, so don't claim
  first AI DAW, first text-to-preset, first hum-to-MIDI, or stems as the headline. Name the closest
  work and say what is different. Details in `idea.md` §1a.
- **Do:** write the 3-minute script (`docs/demo.md`) from what works; decide which optional
  modules appear; set up the fresh public repo with third-party pieces labelled.
- **Done when:** the user approves the script; repo is public with a README.
- **Depends on:** B1 at least (B2 is tabled).

## Later / optional

### B2. Voice commands: the wake word "Hey Muse" (S6) — push-to-talk done Oct 28
- **Do:** the musician says "Hey Muse", then the command; the clip ends on about 1 s of silence.
  After that it is the push-to-talk pipeline (Done, 2026-10-28): Muse Voice Transcribe, then a chat turn.
- **Wake word constraints:**
  - It must be spotted **locally**, always on. Streaming the mic to Meta would cost money all the
    time and send everything the musician says or plays.
  - The hackathon rule allows only Meta models at runtime, so the spotter must be a Meta model or
    non-ML code. Earlier candidates (sherpa-onnx, openWakeWord, Vosk, Porcupine) are all non-Meta.
    Muse Voice Transcribe's realtime `ENDPOINTING` mode (built-in voice activity detection) could end
    the clip once "Hey Muse" is heard, but only while the mic streams to Meta.
  - **Decided (Oct 27): "Hey Muse".** "Muse" alone is short and close to "music", "news", "use".
  - Music playing through speakers, and a vocal take being recorded, will both reach the mic.
    Pause listening while a track is armed or recording, and test with playback on.
- **Done when:** the wake word reaches the agent and runs a tool, in Electron. The false-trigger count
  over a few minutes of playback is written down.

### B7. Remaining sidecar tools (S4, part 2)
`set_synth_knobs`, `fit_synth_to_reference` (`spikes/c_recreate`), `generate_mrt2` (`spikes/d_mrt2`,
`spikes/j_evals/mrt2_cuda.py`). Only if the demo needs reference recreation or MRT2 (open decision).

### B8. Move live sidecar code out of `spikes/`
Into a top-level `sidecar/` with one entry point. On hold until B3 is done and the user agrees.

## Dropped

- SAM Audio GGUF for stems (B4, Oct 27): lost to htdemucs_6s / Mel-RoFormer on every scored part
  and by ear on 6 voice notes; 8–12 GB VRAM vs ~1.5 GB. Details: `spikes/l_sam_audio/README.md`.
- YuE / Noiz (song generation from lyrics): off-pitch, 24 GB VRAM, CC BY-NC weights (Oct 27).
- Local Qwen as a Muse stand-in (Oct 27). DeepFilterNet for cleanup (treats humming as noise).
  Audiobox Aesthetics as a closeness grader. pedalboard (GPL-3.0).

## Done

- 2026-10-28: B13 slice a drum loop by drum. Tool `slice_drums(clip_id)` cuts an audio clip at each
  hit and moves every slice to a new track per drum (`<track> Kick / Snare / Hat`, under the
  original, with its gain and effects copied); the slices abut, so together they replay the clip
  exactly, and undo brings the clip back. Not a true separation: whatever rings under a hit stays in
  that hit's slice (chosen over a kit-separation model, which would break the Meta-only rule). Hits
  come from the engineer sidecar's new `hits` op (`drums.py slice_points`: the existing librosa
  onset detector, backtrack capped at 20 ms so a cut lands just before the attack; a hit with
  several labels goes to the drum whose hits it sounds most like, by onset spectral centroid
  relative to the file). About 3.4 s on the 25 s voice-note drum loop (103 hits). Tests:
  `app/tests/sliceDrums.test.ts`, a Playwright test in `app/e2e/engineer.spec.ts` (mock hits), and
  `test_hits` in `spikes/k_source_prep/test_engineer.py` (synthetic kit, every hit's kind right).
  Not checked by ear: the labels on real loops (beatbox or kit); `drum_eval.py` scores the detector
  on GM kits only.
  Same day, `find_sound(clip_id)`: Muse asked the user how much dead space to cut, because it had no
  way to see where sound starts. The sidecar's `regions` op (`engineer.py sound_regions`: librosa
  `effects.split`; silence is under the quietest 0.5 s + 10 dB, kept within -50..-30 dB) gives the
  sound's start and end on the timeline, the dead space at each end, silent gaps of 0.25 s or more,
  and a `suggested_trim` (10 ms before the sound, 50 ms after) for `trim_clip`. A measurement: not
  logged as an edit, no undo step. The system prompt tells Muse to use it instead of asking for
  times. On the voice-note drum loop: sound from 1.253 s, in 0.8 s. Ideas not built: `set_fade`, `split_clip`.
- 2026-10-28: B2 push-to-talk. Hold `` ` `` (or the mic button in the prompt bar), speak, and let go.
  Playback pauses while the mic is open, which is blocked while a track records; a hold under 0.3 s is
  ignored, and clips stop at 30 s. The clip (16 kHz mono WAV) goes to **Muse Voice Transcribe**
  (`muse-voice-transcribe-1.0`, `POST /v1/asr/transcribe`, `PUSH_TO_TALK`; $0.18/hr, billed per
  second) in the main process (the Vite middleware `/api/stt` in dev:web). The transcript is sent as
  a chat turn and shows with a mic icon. No new session tool: it is only another way to type.
  A local dev model was tried and dropped: wav2vec2 (Meta) through transformers.js misheard
  ("PANCIER", "THRE DE BE") and needed a 360 MB download; Meta's model was exact on the same clip
  in 1.3-1.5 s. Tests: `app/tests/stt.test.ts` (recorded response in `tests/fixtures/stt/`),
  `app/e2e/push-to-talk.spec.ts` (fake mic, `$LATTICE_STT_MOCK`), one Electron IPC test. One live
  run through the browser path (`say` clip → fake mic → Meta) transcribed word for word. Not yet
  done: a by-voice check in Electron with the speakers on.
- 2026-10-27: S1 effects engine + verification; device panel; S3 audio to MIDI wired in; canvas UI;
  sound library; clip moves and snap; musical typing and sampler; repo docs reorganised (`CLAUDE.md`,
  this backlog, `spikes/README.md`).
- 2026-10-27: B10 saved device chains. Tools `save_chain` / `load_chain` (appends; `replace`
  clears first; one undo step) / `list_chains`, for Muse and the panel's "Save chain" and
  "Load chain…" controls. Saved names show in `summarize()`. Electron stores them in
  `chains.json` in userData (`app/src/node/chainFile.ts`); the web build keeps them in memory.
  Tests: `app/tests/chains.test.ts`, `app/e2e/chains.spec.ts`. Not done: delete or rename a
  saved chain.
- 2026-10-28: B11 autosave and versions. Electron writes the open session to
  `userData/project/session.json` 500 ms after each change (and on window close) and loads it
  on launch. Tools `save_version` / `restore_version` (by id or name; one undo step) /
  `list_versions` for Muse, plus `new_session` (user only). An auto version
  (`Before Muse: "<request>"`) is saved before each Muse turn if the session changed, so "go
  back to before the drive" works. All versions are kept (~10-50 KB each, no audio); the
  Versions menu shows named ones plus the newest 20 auto, with "Show all". Audio comes back
  after a relaunch: imports by original path, library sounds by id, recordings and path-less
  files as bytes in `userData/project/audio/` (`app/src/node/projectFiles.ts`,
  `app/src/renderer/sourceAudio.ts`). Web build: versions in memory, no autosave. Tests:
  `app/tests/versions.test.ts`, `app/e2e/versions.spec.ts`, relaunch test in
  `app/e2e/electron.spec.ts`. Not done: undo history across restarts, a tree view of versions,
  delete or rename a version, multiple projects. A moved import shows an error and plays silent.
- 2026-10-28: B12 drum pad, part 1. A kit of 9 pads (Q W E / A S D / Z X C, General MIDI drum
  notes, fixed velocity) made from Ideas or library sounds. It gets an Ideas card; clicking it
  shows the pads in the Musical Typing window; drop a sound on a pad to fill it; R records a drum
  take on the kit (`midi.kit`), which plays each note's pad sound once through. Tools
  `create_kit` / `set_pad` / `clear_pad` / `rename_kit` / `delete_kit` (Muse sees kits in
  `summarize()`); `record_midi` takes `kit_id`. Deleting a sound empties its pads; deleting a kit
  keeps its takes on the built-in drums. Code: `app/src/core/kit.ts`, `kitTools.ts`, the pad
  view in `renderer/MusicalTyping.tsx`. Tests: `app/tests/kit.test.ts`, `app/e2e/drum-pad.spec.ts`.
  Rest: B12b.
- 2026-10-28: B3a source prep on the Mac. Steps 1-5 as recorded earlier (43 s per 20 s note, warm);
  step 6: the user ran `extract_midi` on two real voice notes in the app and judged the MIDI acceptable.
