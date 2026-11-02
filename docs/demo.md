# Demo plan and Meta-only migration

Draft, 2026-11-01. Submission: Nov 4, 9:00 PM ET. Nothing here has been run as a full take yet.

**Migration status (Nov 1): items 1-10 are done, and the app now calls only Meta models at runtime.**
Item 11 (public repo) is left. No live Muse turn has run since the change.

## The rule, and where we stand

Every model called at runtime must be a Meta model, and the README must say which ones and where
they run. Stage One is pass/fail, so this comes before any polish. **Before the migration Lattice failed it**, and
there was no README. The table shows the state before the migration.

| Runtime model | Job | Status |
|---|---|---|
| Muse Spark 1.3 | plans, calls tools | Meta, Meta API |
| Muse Voice Transcribe | push-to-talk | Meta, Meta API |
| MMS-TTS English | spoken replies | Meta, on device (WebGPU/WASM). Weights CC BY-NC |
| htdemucs_6s | stems | Meta, on device. MIT |
| Mel-RoFormer vocals | vocal split, and the router's vocal share | **not Meta** |
| Mel-RoFormer denoise (aufr33) | `cleanup_noise` default | **not Meta** |
| MuScriptor | default transcriber | **not Meta** |
| basic-pitch | layered melody, the instrument router, fallback transcriber | **not Meta** |
| YourMT3+, ByteDance piano | opt-in flags | **not Meta** |
| Magenta RT2 | `generate_mrt2` (a stub, but Muse is offered it) | **not Meta** |

Not models, so they stay; the README lists them as non-ML: the effects engine (Web Audio, Faust,
Signalsmith Stretch), `measure_track` features, pyin, noisereduce, onset drum detection, note
cleanup, key detection, the Freesound API (a search service).

## Refactor list

### Must do

| # | Change | Where | Size |
|---|---|---|---|
| 1 | Vocal split: htdemucs_6s vocals in place of Mel-RoFormer. The router's vocal share becomes vocals vs the sum of the other stems | `spikes/k_source_prep/separate.py`, `prep.py` | S |
| 2 | Default transcriber: remove MuScriptor; hum goes to pyin | `prep.py`, `muscriptor_stems.py` | S |
| 3 | Remove basic-pitch: bass and single lines go to pyin on the Demucs stem; the instrument router uses a DSP polyphony estimate, or the user's mode | `prep.py:230`, `prep.py:242-270`, `transcribers.py` | M |
| 4 | Polyphonic keys: **there is no Meta transcription model.** Keep the Demucs stem as audio and say so in the tool result | `prep.py`, `midiTools.ts` | S |
| 5 | `cleanup_noise`: drop the Mel-RoFormer branch; noisereduce becomes the default | `engineer.py:73-123` | S |
| 6 | Delete the `--yourmt3` / `--bytedance` flags and their code | `prep.py`, `transcribers.py` | S |
| 7 | Delete `generate_mrt2`. Hide `set_synth_knobs` and `fit_synth_to_reference` from Muse (`userOnly` or delete): they are stubs Muse can call today | `core/tools.ts:693-733`, `core/sidecar.ts` | S |
| 8 | Fix the wording Muse reads: tool descriptions name Mel-RoFormer, and `separate` has a `vocals (Mel-RoFormer only)` option | `core/midiTools.ts:214,221`, `core/tools.ts:595`, `core/sidecar.ts:72` | S |
| 9 | Remove the dropped packages from the sidecar envs, so a clean install cannot call them | `spikes/j_evals/envs/amt`, `sep`, `muscriptor`, `yourmt3` | S |
| 10 | README: Meta models, where each runs, what is non-ML. Label `spikes/` as past research that the app does not call. Update `CLAUDE.md`, `docs/model-map.md` | new `README.md` | S |
| 11 | Public repo (B6) | | S |

Check after item 7 whether recorded Muse fixtures still replay. `npm run record-fixtures` costs
money and needs the user's OK.

### What it costs in quality

Scores are F1 on the 16 synthetic phone clips (`spikes/k_source_prep/README.md`).

| Part | Before | Now, measured | Note |
|---|---|---|---|
| Hum | 0.84 | 0.67 | noisereduce then pyin, no Demucs; one clip scores 0 with the right pitches, about 60 ms late; the others 0.77, 0.95, 0.95 |
| Bass | 0.97 | 0.91 | pyin on the Demucs bass stem |
| Layered hum, bass | 0.89, 0.96 | 0.81, 0.81 | Demucs stems; can move about 0.03 per run |
| Keys, layered keys | 0.90, 0.68 | no MIDI | stays audio |
| Drums | 0.94 | 0.94 | already DSP; optimistic, tuned on the same clips |
| Heard cleanup | preferred by ear | noisereduce | `extract_midi` reads the raw take, so MIDI is not affected |

Real acapella test (New Recording 156, 18.9 s, room noise): routed to `hum`, 51 notes, 12 s total.
Pick the demo take after listening to it.

### Worth adding, because it scores

1. **`split_stems` tool: done.** Puts Demucs stems on their own tracks and mutes the original, so
   the Meta open-weight model has a visible moment. Not yet seen in a live Muse turn.
2. **Tell Muse to use `measure_track`: done.** It is in the system prompt now; its use has not been
   seen in a live turn. This is the answer to "Muse can't hear".
3. **Demucs vocal stem as voice cleanup: tried, no.** On a real noisy acapella its noise floor
   stayed at -38 dB, while noisereduce reached -63 dB. A solo voice now uses noisereduce for notes
   too, so **Demucs does not run on the hum**; beat 1:25-1:50 is where it appears.
4. **Optional, only if 1-3 land by Nov 2 night:** PE-AV ranking the library by description ("find a
   dusty kick"; it misses brightness and noise), or MusicGen-melody replacing the Magenta slot.
   MusicGen weights are CC BY-NC, Mac speed is unknown, and "generate a texture" pulls against
   "Lattice gives you the knobs". PE-AV is the better fit.

## The demo (3:00)

Story: a hummed idea on a phone becomes a session you control, by talking to Muse and moving knobs
yourself. Say "Muse can't hear music" out loud; the design around that limit is the craft.

| Time | On screen | Shows | Rubric |
|---|---|---|---|
| 0:00-0:15 | Play a real voice note. "I have hundreds of these, and most never become songs." | Who it is for | Impact |
| 0:15-0:50 | Drop it in. Hold the talk key: "Clean this up and turn the hum into notes." Tool calls appear, MIDI lands, the Piano Roll opens, Muse answers aloud | Voice Transcribe, Muse tools, MMS-TTS | Meta tooling, Demo |
| 0:50-1:25 | "Play it on a pluck, saturation with drive at 12 dB, an octave down, loop it through bar 16." Then pull the drive back by hand. "Do the same on the bass." | Visible tools, and the hand move as feedback: "Your hand is part of the prompt" | Depth |
| 1:25-1:50 | Bring in a phone jam. "Split this into stems, quantize the drums." Stems appear; A/B before and after | Demucs, named on screen, running on this Mac | Meta tooling |
| 1:50-2:15 | "Muse can't hear, so we measure for it." "Cut the mud on the vocal and check it worked." Muse quotes the measured change | `measure_track`, the EQ | Depth |
| 2:15-2:35 | "Make it better." Muse asks one concrete question instead of guessing. Open a new project: "Use your vocal setup here?" | Instruction loop, learned setups | Impact, Depth |
| 2:35-2:50 | Undo a Muse turn from Versions, then export stems for Logic | You stay in control; it fits a real workflow | Impact |
| 2:50-3:00 | Card: which Meta model does which job, and where it runs. 451 unit tests, effects checked against published references | The required statement | Depth |

Filming rules:
- Live Muse calls, nothing faked. Mark any sped-up wait on screen (`extract_midi` takes about 12 s
  on a 19 s solo voice).
- Only the user's own recordings, plus CC0/CC-BY sounds with credit.
- Record each beat separately, keep the best take, and keep a fallback session saved at each beat.

Leave out: reference recreation, Magenta, wake word, MIDI from layered keys, vague sound design,
any feature that is not named above just because it exists (sample pad is the first spare if a beat
fails: "make me a dusty lo-fi kit").

## Before filming, test each of these live

Unit tests pass and the app loads, but these exact beats have not been run:

- [ ] Each spoken instruction above, in Electron, with the real sidecar after the migration
- [ ] "Do the same on the bass" really uses the hand edit
- [ ] Muse quotes `measure_track`, and the numbers match what you hear
- [ ] The setup offer appears (set the learning count to 1, or prepare two projects)
- [ ] Spoken reply and mic in a screen recording, with no feedback

## Order of work

| When | What |
|---|---|
| Nov 2 | Choose the voice note and the jam; run the checklist live |
| Nov 3 | Public repo; first full take |
| Nov 4 | Final take, submit by midday, leaving hours in hand |
