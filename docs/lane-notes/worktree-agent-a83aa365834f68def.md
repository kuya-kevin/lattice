# worktree-agent-a83aa365834f68def — 2026-10-29
Backlog: B17 (done, with reopen), B18 (done)

Changed:
- Library panel has two more tabs, **★ Starred** and **My Sounds**: shelves that span projects (Electron: `userData/shelf/`, index.json + WAVs; web build: in memory for the page's life).
- Star (☆/★) on library rows, Ideas cards (on hover) and filled pads; a shelf row previews on click, + brings it into Ideas, ★/× takes it off the shelf, ↺ reopens an export.
- Export as a sound: right-click a region or a track lane (Export Region / Track as Sound, or Star the Region's Sound), or **Export Sound** in the device panel header. Renders through the track's effects with the tail kept (8 s rendered) and trailing silence trimmed (-70 dBFS, 20 ms pad, 10 ms fade).
- An export remembers how it was made: the audio before the devices (at the track's gain) is kept beside the WAV as `<id>.source.wav`, the chain in index.json. `reopen_sound` puts that audio on a new track with the chain loaded.
- **Dry** toggle in the transport island (beside 1234): A/B the whole mix with every effect bypassed, devices untouched. Utility devices keep only Gain and Pan (the balance); the dry mix is loudness-matched (gated RMS, 400 ms blocks, -60 dBFS gate) with one gain on every track. Tooltip shows the match (e.g. +4.5 dB). Undo leaves it alone; it is not an edit.
- **Export stems** button (arrow-out icon, right of Versions): one 32-bit float WAV per track, dry set and wet set, all from 0 s. Electron asks for a folder and writes `<folder>/Lattice stems/{dry,wet}/01 Name.wav`; the web build downloads `Lattice stems - dry - 01 Name.wav` etc. Dry stems keep gain and the Utility's gain/pan, so with neither they are the source audio sample for sample. Stems render at the rate the audio was decoded at.
- New tools (Muse and UI): `star_sound`, `unstar_sound`, `export_sound`, `find_sound_in_shelf`, `use_shelf_sound` (Ideas, a pad via kit_id+pad, or a track), `reopen_sound` (core/shelfTools.ts); `set_mix_view`, `export_stems` (core/mixTools.ts). Muse's summary gets a "Shelves:" line and, while dry, a "Listening: DRY" line.

Plumbing: the renderer answers render jobs (`renderer/renderServe.ts`, like B9's measure) over a new `render:req/res` IPC pair; `ctx.adoptAudio` hands a shelf sound to the B11 source-audio store so the renderer reloads it like a restored source. Session gets `mixView?` (kept across undo/restore by `store.restored`).

Check it: npm run dev:web -- --port 5395 --strictPort, then
  1. Import a WAV, add a Reverb in the device panel, right-click the region > Export Region as Sound. Open the Library (L) > My Sounds: the sound is there, longer than the region; click to hear the tail.
  2. Press ↺ on it: a new track with the dry audio and the same Reverb.
  3. Library > search "kick" (or any) > ☆ on a row; ★ Starred tab shows it; + puts it in Ideas. Hover an Ideas card: ☆ stars it too.
  4. Press Dry in the transport while playing: effects drop out, level stays similar; Dry again: wet. Devices in the panel don't change.
  5. Press Export stems (arrow-out icon): 4 downloads for 2 tracks (dry + wet).
  Electron: `npm run build && npm run dev`; stars and exports are still there after a relaunch; Export stems opens a folder dialog.

Tests: vitest 260 passing (new tests/shelf.test.ts, 13), tsc clean, `npm run build` ok.
  e2e web: e2e/shelves.spec.ts (3), e2e/mix-view.spec.ts (2) pass.
  e2e Electron: `npm run build && npx playwright test e2e/electron-shelves.spec.ts` (2) pass (fresh LATTICE_USER_DATA; LATTICE_EXPORT_DIR skips the folder dialog in tests).
Muse spend: $0.00 (no calls).

Left / known issues:
- The dry-mix match gain is measured when Dry is switched on; editing devices while dry leaves it stale until toggled again. Dry mode is saved with the session (autosave) and comes back on relaunch.
- Recordings are not added to My Sounds automatically (only via `export_sound {source_id}`); no UI button for that yet besides Muse. A pad's star keeps the whole source, not the pad's trimmed slice.
- Shelf items taken off a shelf keep their WAVs on disk (`userData/shelf/`); there is no cleanup.
- An exported WAV lives only in userData; there is no "Save WAV as…" or "Show in Finder" for a single sound yet (stems do have a folder).
- The region menu finds the region by pointer position (lane overlays take the click); MIDI regions export fine but can't be starred (no audio source).
- The control bar is tight below ~1300 px; the Dry toggle and stems button are compact for that, lane S may want to restyle.
