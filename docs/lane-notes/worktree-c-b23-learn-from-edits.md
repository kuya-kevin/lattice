# worktree-c-b23-learn-from-edits (lane C) — 2026-10-29
Backlog: new entry, proposed **B23. Learn from user changes** (design only so far)

Changed: design doc `docs/learn-from-edits.md` (no code yet).

For the merge step, add to `docs/backlog.md` under "Now":

> ### B23. Learn from user changes
> - **What:** turn the user's hand habits and corrections into rules kept in `taste.json` (userData),
>   learned when the user saves a version or starts a new session, applied across sessions. First
>   rule kind: side words in a track name -> pan (any track). Second: corrections to `suggest_moves`
>   knob moves (vocab word + source type).
> - **Design:** `docs/learn-from-edits.md` (demo script, capture, storage, build plan).
> - **Done when:** the demo script in the doc passes as a Playwright spec, detectors have Vitest tests,
>   and Muse reports learned habits it applies.
> - **Lane:** C.

Check it: read `docs/learn-from-edits.md`.
Tests: none (docs only).
Muse spend: $0.00
Left / known issues: all of the build. Step 4 of the demo needs one recorded Muse fixture (ask first).
