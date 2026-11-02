# worktree-c-device-drag — 2026-11-01
Backlog: none (user request: drag to reorder the effects chain)
Changed: drag a device by its title bar to reorder the chain. The card dims, a line shows where it
  lands, and release makes one `move_device` (one undo step). Escape cancels. The ‹ › buttons stay.
Check it: npm run dev:web -- --port 5393 --strictPort, then
  1. Add Channel EQ, Compressor and De-Esser to a track.
  2. Drag De-Esser's title bar to the left of Channel EQ: a line appears there, the card dims, and
     on release De-Esser is first.
  3. Undo (⌘Z): the old order is back.
  4. Start a drag and press Escape: the line goes and the order doesn't change.
  5. Narrow the editor until the cards stack in one column: drop above or below a card, with a
     level line.
Tests: vitest 451 passing, tsc clean, e2e device-drag, fx-panel, chains pass
Muse spend: $0.00
Left / known issues: no auto-scroll while dragging near the canvas edge; scroll with the wheel or
  trackpad during the drag. Pointer drag only; the ‹ › buttons are the keyboard route.
