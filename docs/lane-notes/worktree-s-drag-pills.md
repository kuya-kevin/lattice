# worktree-s-drag-pills — 2026-10-31

Backlog: none (the user's request: the control bar pill sits off centre; let me place each pill)

Changed:
- The floating pills move: drag the transport, the tool rail, the file actions (Versions, Import,
  Track, Enable mic) or the zoom bar by its empty background; the project pill is one button, so
  drag the button (a drag does not open the menu, a click still does).
- Each pill stays in its zone, clear of where the canvas content starts: the top pills in the top
  band (`--top-h` + 8 px), the rail in the right gutter (`--gutter-r`), the zoom bar below the top
  band; none goes under an open Library panel. A pill's own CSS spot always counts as inside.
- Dropped within 8 px of the window's centre, a pill snaps to it and stays centred on resize (the
  fix for the off-centre transport: its default place is centred between the side pills).
- Spots are kept in localStorage (`lattice.pills.v1`, try/catch, a view preference, not session
  state). Double-click a pill's background, or Layout menu > Reset pills, puts them back.
- Code: `renderer/Chrome.tsx` (`usePillDrag`, mounted in App; pills found by selector, moved with
  the CSS `translate` property so their CSS place and transforms stay), `Chrome.css`; one menu item
  in `Frames.tsx` LayoutMenu. App.tsx: one import and one hook line.

Check it: npm run dev:web -- --port 5394 --strictPort, then
  1. Drag the transport by an LCD label or its edge: it follows; drop near the middle, it snaps centred.
  2. Drag the rail by its divider or padding: it moves up/down, sideways only inside the right gutter.
  3. Reload: pills stay put. Double-click the transport's background: it goes back.
  4. Layout menu (bottom right) > Reset pills: all go back.

Tests: e2e/pills.spec.ts (new); vitest 433 passing, tsc clean; pills, oct29-layout, frames, smoke,
  projects, versions, resize pass; full web e2e 128/129 (record-timing "cycle recording audio" is
  flaky at its 0.05 s tolerance, also without this change: 1 in 12 runs).
Muse spend: $0.00
Left / known issues: positions are one set for all window sizes (offsets from each pill's CSS
  place, clamped live). The light-mode lane touches App.tsx's ZoomBar; this branch only adds two
  lines near the top of App, so the merge should be clean.
