# worktree-a-daw — 2026-10-29
Backlog: B0 (part: three items from the user's Oct 29 list)
Changed:
- Ideas: a sound used as the instrument of a MIDI take now counts as on that track: the card says
  "on <track>", takes the track colour and gets its wire. Deleting such a sound keeps the takes'
  notes and switches them to the piano (the confirm says so).
- Region editor (Piano Roll / Audio Editor) resizes by dragging its bottom edge; double-click or
  Enter resets; the height persists with the other layout sizes.
- Versions menu reads like a commit log: each version shows what changed after it (+ added,
  − removed, ~ changed: tracks, clips, devices, knob moves, volume, tempo, sounds, drum pads),
  two lines inline and "N more", full request text on two lines, dates for older days.
  `list_versions` takes `changes: true` (Muse can use it too). New core module `core/versionDiff.ts`.
Check it: npm run dev:web -- --port 5391 --strictPort, then
  1. Library: add a sound to Ideas, record a Musical Typing take with it (R, play, R): the card
     says "on <new track>" and a wire runs to it.
  2. Select a MIDI region, open Piano Roll (P), scroll down and drag the line under it: taller/shorter.
  3. Save a version, add a device and change a volume, open Versions: the saved row lists
     "+ <Device> on <track>" and "~ <track> volume ...". Restore still works.
Tests: vitest 242 passing, tsc clean, e2e ideas-flow, resize, versions, musical-typing,
  piano-roll, audio-editor, drum-pad, smoke, arrange pass (30)
Muse spend: $0.00
Left / known issues:
- For lane S: Versions.css adds a local green (`--add: #6fd39a`, scoped to the menu) for "+"
  lines; there is no green token yet. Resizable.css and Versions.css hold this lane's styles.
- A version's changes are "everything after it up to the next version", so hand edits made after
  a Muse turn show under that Muse request too.
- The main checkout's `.claude/launch.json` got a local `lattice-web-a` entry (port 5391, this
  worktree) so the preview pane can run it; not committed.
