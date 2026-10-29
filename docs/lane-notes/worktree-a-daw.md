# worktree-a-daw — 2026-10-29 (batch 4)
Backlog: B0 (the four leftovers from earlier batches, done); B12b (sample pad: Piano Roll pad rows,
note click plays the pad, kit card wires and drag, rename pads and kits, done; Muse fills a kit and
export are still open); B0 "extract_midi only relabels the grid" (done).

Changed:
- Tracks keep their colour when reordered (`Track.color`, given when the track is made; older
  sessions get theirs pinned on the first move).
- Versions: an "After Muse" auto version is saved at the end of each Muse turn, so hand edits after it
  get their own row ("your edits after this"); it is hidden while nothing follows it.
- Muse's `stop` without a position: the renderer writes back where playback stopped.
- A second trim straight after the first: no longer reproduces (25 web + 8 Electron runs, likely fixed
  by the Oct 28 provider patch). Regression test `e2e/trim-twice.spec.ts`; the Electron test's 1.5 s wait is gone.
- Drum pad is now **Sample pad**: any sound on a pad; a pad takes the sound's name unless renamed
  (double-click a pad, tool `rename_pad`); audio files dropped from the Finder fill pads from the one
  dropped on; double-click the kit card's name to rename it; drag the card onto the arrangement for an
  empty 2-bar region on the kit (tool `place_kit`, Muse can call it); wires go from the kit card to its
  tracks, and the card takes the track colour. Tool names (`create_kit`, `set_pad`, ...) are unchanged.
- Piano Roll on a kit region: rows named after the pads, every pad has a row, clicking a row or note
  plays the real pad sound.
- A group drag below the last track makes new tracks (`move_clips`), keeping the group's shape; each is
  named after the track its region came from ("keys 2"), as a single drag does.
- `extract_midi` adopting a detected tempo is a real tempo change now: other regions keep their bars
  (MIDI stretches, audio moves); the recording and its new stems stay where they were heard.

Check it: npm run dev:web -- --port 5391 --strictPort, then
  1. Import three WAVs, drag the bottom track's header to the top: the colours go with the tracks.
  2. + New sample pad (Ideas), drop two WAVs from the Finder on pad A: A and S take the files' names.
     Double-click S, rename it; double-click the kit card's name, rename it.
  3. Drag the kit card onto the arrangement: a 2-bar region on a new track named after the kit, with a
     wire. Double-click it: the Piano Roll rows carry the pad names; click a row to hear the pad.
  4. Shift-click two regions on the bottom two tracks, drag one below the last lane: both land on new tracks.
  5. Ask Muse something that changes the mix, then make a hand edit: Versions shows "After Muse: ..."
     with "your edits after this" (needs live Muse in Electron; the web build's offline Muse changes nothing).

Tests: vitest 247 passing, tsc clean, web e2e 84/84 (all 26 specs), Electron e2e 8/8 (after `npm run build`).
Muse spend: $0.00 (no live calls).

Left / known issues:
- **To try by ear with the user (they asked to do this together):** a user-set recording delay (browsers
  rarely report mic latency), and punching in while playing without restarting the transport.
- Sample pads: Muse can't pull library or Freesound sounds into a kit yet; no kit export; per-pad
  trim/gain/choke; velocity is fixed at 100; pads are one-shots (a long note doesn't hold a sustained sample).
- A kit region's Piano Roll also shows GM drum names on the rows between pads (e.g. "Tom H");
  Logic shows only the kit's rows.
- Existing behaviour, seen while checking: a region on a kit (or sampler) isn't drawn until every pad sound's
  audio has loaded, so a pad whose audio never reloads would hide the region. Worth a fallback render.
- `Ideas.css` (kit rename field) and `Versions.css` are lane-A stylesheets with fallback colours; lane S may
  want to fold them into the tokens.
