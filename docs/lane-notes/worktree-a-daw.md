# worktree-a-daw — 2026-10-30

Backlog: B0 (the user's Oct 30 list, 12 items: done, see below)

Changed:
- Muse has a loop tool: `set_cycle` (from_bar/to_bar inclusive, on/off). The cycle now lives in the
  session (`session.cycle`), shown in Muse's summary; undo keeps it. The Cycle button, C and ruler
  drags go through it too.
- Stop stops: two races in the playlist could start audio after Stop (a play still starting its audio
  after an engine rebuild; a resume right after a rebuild), plus clock ticks that fired after pause()
  restarted the loop. Fixed in TransportSync and in the patches (browser, playout).
- Space decides play/stop from the engine or the session, so a press while a play is starting stops it
  instead of restarting from the loop start (the "finicky" Space).
- With Cycle on, a take from a stop starts at the cycle's left edge (while playing, at the playhead).
- Recording a vocal: the first R used to only ask for the mic and do nothing; it now starts the take
  once the mic opens. A mic stream that died is asked for again.
- Regions: a trim may run over the next region (engine patch); a MIDI region's end extends past its
  notes (its source grows; audio regions still stop at their audio's end).
- The arrangement ruler stays in view when the board scrolls or the canvas pans (Arrange.css, a
  transform; sticky can't work inside the horizontal scroller).
- Piano Roll: Option/Alt-drag copies notes (copies selected); the left edge trims a note's start, the
  right edge its length (visible on hover, wider); Quantize acts on the selected notes only
  (`quantize_midi` takes `notes`).
- Zoom −/+ moved to the left of the Piano Roll and Audio Editor toolbars.
- Library: double-click a sound to add it to Ideas; an Ideas card's "Add to track…" picker puts the
  sound on an existing track (or a new one) at the playhead.

Check it: `npm install` first (three patches changed: browser, playout, new engine), then npm run dev:
  1. Ask Muse "set up a two-bar loop and play it": the Cycle lights over bars 1-2 and plays from bar 1.
  2. Loop playback and press Space many times, fast and slow, near the loop end: it always stops.
  3. Cycle on bars 3-4, playhead at bar 1, press R (vocal): recording starts at bar 3. First R on a
     fresh launch records (no second press).
  4. Drag the end of a MIDI region right, over the next region: it extends. In the Piano Roll,
     Option-drag a note, drag a note's left edge, select two notes and press Quantize.
  5. Add 12 tracks and scroll down: the ruler stays at the top. Double-click a library sound, then
     use "Add to track…" on its Ideas card.

Follow-up (Oct 30): Muse sees the Piano Roll's note selection.
- The selection is session state (`selection.notes`, indexes into the selected region's notes; a
  quiet user tool `select_notes`). The summary's last line names the notes and their indexes, and
  the prompt says "these notes" = those indexes. Undo keeps it (a view setting).
- New Muse tools `set_note_velocity` (set or change) and `delete_midi_notes`; `quantize_midi` with
  `notes` and no clip_id uses the selected region.
- Edits that re-sort notes (quantize, transpose, Piano Roll edits) move the selection with its
  notes (`setClipNotes`), which fixes the "selection points at neighbours" issue below.
- Check it: select two notes, ask Muse "quantize these" / "make these softer" / "delete these".
- Tests: tests/note-selection.test.ts (7), e2e/note-selection.spec.ts (2); vitest 381, web e2e 126,
  electron 9 + 2, tsc clean. Spend $0.

Tests: vitest 374 passing (new: cycle.test.ts, oct30-edits.test.ts), tsc clean, e2e: oct30-bugs.spec.ts
  (8, new), full web suite (see below), electron.spec.ts (new: first-press recording).
Muse spend: $0.00 (no live calls).
Left / known issues:
- Extending an audio region past its recording isn't possible (no looping regions yet).
