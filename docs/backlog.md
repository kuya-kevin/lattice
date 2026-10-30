# Backlog

Updated 2026-10-29. One entry per remaining task, in priority order. Each says what "done" means,
which files it touches, and what it depends on, so an agent can be pointed at one entry.
Rules and commands: `CLAUDE.md`. Status: `HANDOFF.md`. Stream ids (S0–S8): `docs/session-plan.md`.

When you finish an entry: say so in your lane note; the merge step moves it to "Done" at the bottom
with the date and a one-line result and updates the `HANDOFF.md` status table (`docs/parallel-work.md`).

**Lanes (Oct 29):** A = B0. B = B14, then B12b pad UI, B2. C = B12b "Muse fills a kit", then B6.
S = B15. Paused (Python lane): B7, B8. Priority: a UI that is easy for musicians to work in.

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
    **Try these by ear with the user** (agreed Oct 29: do them together when the user is home).
  - 2026-10-28, done: playback across region edits. A trim/move/duplicate/delete rebuilds waveform-playlist's
    engine; Play during the rebuild (Muse's "trim it and play") was silent and could stay broken, and an edit
    while playing stopped the audio while the UI still showed playing. Patched the provider (play/stop wait for
    the new engine; it resumes from the heard position) and the click re-anchors (`e2e/playback-edits.spec.ts`).
  - 2026-10-28, done: cycle recording. The transport looped but the take didn't, so notes after the wrap
    landed past the cycle end. Now MIDI passes merge into one region over the cycle and a mic take keeps the
    latest pass, as in GarageBand (`foldMidiTake` / `cycleMicTake` in `src/core/recordTiming.ts`). Not yet: take folders.
  - 2026-10-28, done: tempo changes keep regions on their bars (`changeTempo`): MIDI notes stretch, audio
    regions move but aren't time-stretched, and the cycle area, punch range and playhead follow
    (`e2e/tempo-change.spec.ts`). Oct 29: `extract_midi` adopting a detected
    tempo is the same tempo change (the recording and its new stems stay where they were heard).
  - 2026-10-28, done: Stop leaves the playhead where it was heard; it jumped ~0.13 s on (lookahead + output
    latency), so the next Play skipped that much. Oct 29: Muse's `stop` (no position) now updates
    the session's position too (the renderer writes back where it stopped).
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
    (Beat: 1.4 to 2.4; Bar: whole bars; Off: the regions' edges; none selected: the last area); with Cycle on, Play starts at the cycle start. Oct 29: a moved track keeps its
    colour (`Track.color`), and a group dragged below the last track goes on new tracks (`move_clips`).
  - 2026-10-28, done: try a sound before it has a track. Library rows get a + (tool `add_sound`, user only):
    the sound goes to Ideas on no track and Musical Typing opens with it; clicking an Ideas card on no
    track does the same; R then records onto a new track named after it. Ideas cards drag onto the
    arrangement (tool `place_sound`, Muse can call it). The try-out lives in the renderer
    (`musicalTyping.audition`), not the session, so Muse doesn't see it.
  - 2026-10-28, done: versions of a processed sound. A sound and its cleanup / quantize versions share
    one Ideas card showing the one in use; its Versions list plays each and switches the clips
    (tool `use_audio_version`, Muse too; the summary names a processed clip's original).
  - 2026-10-29, done (batch of 3, branch `worktree-a-daw`): an Ideas sound played as a MIDI take's
    instrument now shows as on that track (label, colour, wire); deleting it sends those takes back to
    the piano. The Piano Roll / Audio Editor resizes from its bottom edge (persisted). The Versions menu
    reads like a commit log: each version lists what changed after it (+ / − / ~, `core/versionDiff.ts`;
    `list_versions` with `changes: true`). Oct 29: an "After Muse" auto version at the end of each
    turn gives hand edits their own row. Not yet: `Versions.css` uses a local green (no green token; lane S).
  - 2026-10-28, partly: "can't trim clips" did not reproduce (arrangement and Audio Editor trims pass in
    web and Electron). The arrangement's trim edges were invisible 8 px zones: now 10 px and lit on hover.
    Oct 29: a second trim 50 ms after the first starts every time (`e2e/trim-twice.spec.ts`; only a press
    within a few ms of the release is dropped); the Electron test's wait is gone. Ask the user what they
    grabbed if it still fails.

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

### B14. Muse talks back (lane B)
- **What:** an option for Muse to speak its reply, so a musician with hands on an instrument can
  push-to-talk in and hear the answer. Push-to-talk input already works (B2, Done).
- **Facts checked (Oct 29):** the Meta Model API has no text-to-speech (dev.meta.ai models and
  pricing pages; Muse Voice Transcribe "does not synthesize speech"). Decided (user, Oct 29): use
  Meta's open-weight **MMS-TTS English** (`facebook/mms-tts-eng`, VITS), run in the app through the
  Transformers.js `text-to-speech` pipeline (ONNX build `Xenova/mms-tts-eng`; the package is now
  `@huggingface/transformers`, check current docs). Use fp32: int8 is reported to hurt VITS audio.
  Weights are **CC BY-NC 4.0**: add a licence watchlist row. No API cost. One voice.
- **First, a spike:** speak 5 typical confirmations on the Mac, log time to first audio and load
  time, the user listens. If it fails by ear or is too slow, stop and ask (fallback: `speechSynthesis`).
- **Do:** a toggle, off by default, that is a tool like every other action. When on, Muse speaks a
  short confirmation of what it did, and its clarifying questions (B16); not long replies. Playback
  ducks while it speaks; never speaks while a track records; pressing push-to-talk stops it.
- **Done when:** a Playwright test asserts the toggle and speaking state through a mock voice in
  the web build; checked by ear in Electron; latency per reply logged in the lane note; row added to
  `docs/model-map.md`.
- **Files:** `renderer/pushToTalk.ts`, `renderer/ChatPanel.tsx`, a new `renderer/tts.ts` (or a worker),
  `core/bridge.ts`, `renderer/mockBridge.ts`.

### B16. Muse acts on clear instructions (replaces "competing versions")
- **Why (user, Oct 29):** vague sound requests ("make it sound better / more open / wider") are out
  for now: describing a sound in words is too hard without a model that can take reference audio.
  Muse responds to concrete instructions.
- **Do:**
  - System prompt: act on concrete edits only. For a vague sound word, ask one short question that
    offers one or two concrete changes ("brighter: raise the top-end EQ, or cut the low-mids?").
  - Take `suggest_moves` out of Muse's tool list and the prompt line (`core/agent.ts:17`). Keep
    `vocab.json` and the tool code; update `tests/vocab.test.ts` and `tests/fx-agent.test.ts` to match.
  - Resolve targets by selection ("this"), by name ("the vocal", "the double") and by position
    ("bar 9", "bars 5-8"). Check `summarize()` gives Muse enough to do this (selection, track names,
    regions in bars).
  - Instruction families: **arrange** (move, copy, loop/repeat, delete bars, split), **mix** (gain,
    pan, mute, solo), **tracks** (new, duplicate, rename, colour), **edit** (quantize, transpose,
    trim, fade), **devices** (add, remove, set a knob to an exact value). Add any missing tool.
  - An instruction eval: about 30 phrases across the families, each with the expected session change,
    checked automatically from recorded fixtures.
- **Done when:** every family has a tool and the eval passes from fixtures; `idea.md` no longer
  describes the 2-3 versions loop.
- **Cost:** recording the eval fixtures, about $0.03. Ask before recording.

### B17. Sound shelves: Starred and My Sounds, across projects
- **What:** two shelves in the library that persist in userData across projects (in memory on the
  web, like saved chains): **Starred** (any sound starred from the library, Ideas or pads) and
  **My Sounds** (the user's recordings and exported sounds).
- **Export as a sound:** `export_sound(track or region, name)` renders through the track's effects
  (`renderTrack`, `encodeWav` in `fx/engine/render.ts`), writes a WAV and adds it to My Sounds.
  From a region or track context menu, the device panel, or Muse ("save this as dusty keys").
  Keep the effect tail; trim trailing silence (default, not yet confirmed by the user).
- **Remembers how it was made** if it isn't hard (user: a plain WAV is enough otherwise): keep the
  source audio and the chain beside the WAV, so "reopen" puts the source on a new track with the
  chain loaded. Saved chains (B10) and source bytes in userData (B11) already do most of this.
- **Tools:** `star_sound`, `export_sound`, `find_sound_in_shelf`, so Muse can use them ("put my
  starred kick on pad Q"). Also gives B12b "Muse fills a kit" a way to pull sounds in.
- **Done when:** a star and an export survive an Electron relaunch (Electron test with a fresh
  `LATTICE_USER_DATA`); Vitest for the tools; Playwright for star and export in the web build.

### B18. Dry / wet mix
- **Listen:** a control-bar A/B switch that bypasses every effect device on every track without
  changing the session (gain and pan stay, so the balance holds). Loudness-matched by default so
  louder doesn't win (not yet confirmed by the user). A tool like everything else.
- **Hand off:** export stems, one WAV per track, as a dry set and a wet set (same render path as
  `export_sound`), named by track.
- **Done when:** Playwright asserts the switch state and that the session is unchanged; an export
  test checks one file per track per set and that dry stems match the source audio.

### B20. Detect a clip's key, and adopt it as the session key
- **Idea from:** Bitwig Superpowers "Detect Event Key" (Oct 29 review). Muse can't hear music, so a
  key it can read as text helps it with transposing and choosing sounds.
- **Detect:** `detect_key(clip_id)` builds a pitch-class histogram from a MIDI clip's notes (weighted
  by duration and velocity) and scores all 24 keys against the Krumhansl-Kessler profiles. Pure TS
  in `core/`, no model and no sidecar. It returns the best key, a confidence, and the runner-up when
  it is close (often the relative major or minor). It stores the result on the clip (e.g. `clip.key`),
  and `summarize()` shows it.
  - Audio clips: use the MIDI from `extract_midi` when the clip has some. An FFT chroma pass in the
    renderer is optional and can come later.
- **Adopt it (user, Oct 29):** an option to set the session key to the clip's key. Show a "Use as
  session key" action on the clip's context menu and next to the detected key. It is `set_key` with
  the clip's key, so it is one undo step and Muse can call it too ("match the project key to this
  clip"). Tempo adoption in `extract_midi` is the model for how this works.
- **Done when:** Vitest checks the scores on fixed note sets (a C major scale, an A minor
  progression, a close relative-key case) and checks that adopting the key changes `session.key`.
  Playwright checks the menu action through `window.lattice.getSession()`.
- **Files:** a new `core/key.ts`, `core/midiTools.ts`, `core/session.ts` (`Clip`, `summarize`),
  the clip context menu in the renderer.

### B21. Capture MIDI: keep what was just played
- **Idea from:** Bitwig Superpowers "Capture MIDI". You play something on Musical Typing without
  recording, then press Capture and it becomes a clip.
- **Do:** Musical Typing keeps the last 30 s of note on/off events in a rolling buffer, whether or
  not anything is recording. `capture_midi(track_id?)` turns the buffer into a MIDI clip through the
  same path as `record_midi`. While playing, the notes land on the bars where they were played. When
  stopped, they start at the playhead. The capture goes on a new track if a clip is in the way (it
  never replaces one), and it empties the buffer so the next capture never repeats notes.
- **Where:** a Capture button next to the transport, plus a shortcut. Muse can call the tool too
  ("capture that and quantize it"), and like other UI calls it is logged as a hand edit.
- **Done when:** Vitest checks placement while playing and while stopped, the new-track case and that
  the buffer empties. Playwright plays notes with Musical Typing, captures, and asserts the clip in
  `getSession()`.
- **Files:** `renderer/MusicalTyping.tsx`, `core/midiTools.ts`, `renderer/ControlBar.tsx`.

### B22. MIDI transforms: arpeggiate, strum, chop, velocity ramp
- **Idea from:** Bitwig Superpowers MIDI Tools and Ramp. These map onto things a producer would ask
  Muse for ("strum those chords", "arpeggiate it in sixteenths", "fade the velocity in"), and they
  fit B16's concrete **edit** instructions.
- **Do:** pure note functions in `core/midiTools.ts`, each a tool and one undo step, working on a
  clip or on the selected notes:
  - `arpeggiate`: style (up, down, up-down, random), rate (a grid value) and gate.
  - `strum`: the delay between the notes of each chord, and the direction (up or down).
  - `chop`: split notes at every grid line. This is also Cmd+E in the piano roll.
  - `ramp_velocity`: start and end velocity, applied in time order.
  - Optionally `humanize` (small timing and velocity jitter, seeded so tests are repeatable).
- **Done when:** Vitest covers each transform on fixed note sets. Playwright covers one of them from
  the piano roll. If B16's eval exists, it gets two or three phrases for these tools.
- **Files:** `core/midiTools.ts`, `renderer/PianoRoll.tsx` (menu and footer for the ramp).

### B15. Layout variants (lane S)
- **What:** variants for a more modern layout, the way Google Stitch was used before. The canvas
  direction (Oct 27, `app/docs/ux-notes.md` Layout) is the starting point; Logic stays the
  reference for musical conventions.
- **Explore:** variants live in `app/variants/` (git-ignored, never committed). A restyle is an
  override stylesheet over the real app behind a dev-only `?variant=<name>` switch; a new layout
  is a standalone mock page. The user compares them on port 5394 and picks.
- **Apply:** a short freeze (`docs/parallel-work.md`): the other lanes merge first, lane S applies
  the pick to `styles.css` and the components, then everyone rebases.
- **Done when:** the user has picked a variant, it is applied, the e2e suite passes, and
  `app/docs/ux-notes.md` describes the new layout.

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

### B12b. Sample pad, part 2 (was "Drum pad")
Part 1 (the playable kit) is in Done. Oct 29 (lane A): it is a sample pad now: any sound on a pad
(Ideas, library, Finder files), pads take the sound's name, pads and kits rename in the UI
(`rename_pad`), a kit card drags onto the arrangement (`place_kit`, an empty 2-bar region) and wires
to its tracks, and a kit region's Piano Roll rows are its pads (a click plays the real pad). Left,
roughly in order of demo value:
- **Muse fills a kit:** "make me a dusty lo-fi kit". Muse can call `set_pad` today, but only with
  sounds already in the session; it needs a way to pull library or Freesound sounds into the
  session (the renderer decodes audio, so this is a renderer round trip like `measure_track`).
  Picks go by names, tags and categories, plus B9 features.
- **Export kit:** the pad WAVs plus a credits file for the CC-BY sounds.
- Per-pad trim, gain and choke groups (closed hat cuts the open hat); a held note sustaining a long
  sample (pads are one-shots).
- A kit region isn't drawn until all its pad sounds have loaded; a pad whose audio never reloads would
  hide it (needs a fallback render). Its Piano Roll also lists GM names between pads (Logic shows only the pads).
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

### B19. Recording delay calibration and vocal stacking — tabled (user, Oct 29)
- **Come back to this.** The user is thinking it over. Draft: per device-pair loopback calibration
  (click out, mic in, cross-correlate; clap-along fallback for headphones; warn on Bluetooth) to
  replace the unreliable `outputLatency` / track `latency` estimates (`renderer/audioClock.ts`);
  align a double to the lead per phrase (split at silences, shift by envelope cross-correlation,
  ±80 ms, no stretching); tools `make_double`, `fake_double` (delay + detune, DSP).
- **Open questions:** the user's mic and headphone setup; whether a per-phrase shift is tight enough;
  harmonies in scope; align every double automatically or on request.

## Dropped

- Competing versions ("Muse proposes 2-3 versions, you pick") and vague sound requests (Oct 29):
  too hard to describe in words. Revisit with a model that takes reference audio (B16).

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
