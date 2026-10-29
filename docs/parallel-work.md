# Parallel work: lanes, branches, merging

Agreed 2026-10-29. Up to four agent sessions work at once, each in its own git worktree and branch.
The user checks each branch in the browser, then it merges into main. Main only receives merges.

## Lanes

Lanes are split by area of the screen, so two lanes rarely edit the same file.

| Lane | Owns | Backlog | Dev port | E2E ports |
|---|---|---|---|---|
| **A. Arrangement and editing** | Arrange, Piano Roll, Audio Editor, transport, control bar | B0 (the user's rolling bug list) | 5391 | 5310-5319 |
| **B. Input and voice** | push-to-talk, chat panel, Musical Typing, drum pad UI | B14 (Muse talks back), then B12b pad UI, B2 | 5392 | 5320-5329 |
| **C. Flexible** | Ideas, library and device panels; Muse/core when a UI feature needs a tool | B12b "Muse fills a kit", then B6 | 5393 | 5330-5339 |
| **S. Styling** | `styles.css` and its design tokens, layout variants | B15 | 5394 | 5340-5349 |
| main checkout | merges only | - | 5390 | 5299 (default) |

Paused: the Python/sidecar lane (B7, B8). It adds model features, not ease of use.

Shared files and who may change them:
- **`styles.css` and the `:root` tokens belong to lane S.** Other lanes use existing tokens and put
  new styles in their own component CSS file (as `DevicePanel.css` and `MusicalTyping.css` do).
- **`App.tsx`, `session.ts`, `tools.ts`:** small additions only (wire a component, add a summary
  line, register a tool). New tools go in their own module (`kitTools.ts`, `midiTools.ts` pattern).
  No lane reorganizes these files.
- **`HANDOFF.md` and `docs/backlog.md`: lanes don't edit them.** Each lane writes a lane note
  instead (below), and the merge step folds it in. This removes the conflict every pair of
  branches would otherwise have.
- **Live Muse calls: one lane at a time** (the $150 budget). Say so in the lane note, with spend.

## Starting a lane

1. Main must be committed: a worktree starts from the last commit and never sees uncommitted work.
2. From the main checkout: `claude --worktree <lane>-<entry>` (e.g. `b-b14-voice-reply`). It
   creates `.claude/worktrees/<name>` on branch `worktree-<name>`. Lane A is one long-lived branch
   (`a-daw`) because its bug list keeps arriving; B, C and S use one branch per backlog entry.
3. In the worktree: `cd app && npm install`. If the lane needs live Muse or speech, copy `.env`
   from the main checkout (it is git-ignored and the hook refuses to commit it).
4. Run the dev server on the lane's port: `npm run dev:web -- --port 5392 --strictPort`.

## Commits

- Agents commit on their lane branch, as often as useful. Never on main: the pre-commit hook
  refuses agent commits there.
- Every commit runs the leak scan (`.githooks/scan-leaks.sh`): keys, `.env` values, absolute home
  paths (`/Users/<name>`, `/home/<name>/`, the real bigdisk path) and files from `.env`, `data/`, `out/`
  are refused. Use env vars and placeholders like `<bigdisk>`. Never use `--no-verify`.
- The hook is on via `git config core.hooksPath .githooks` (once per clone; worktrees share it).

## Ready for review (the lane agent does this when the user says "prep for merge")

1. `git rebase main` so the user tests exactly what will land. Fix conflicts in the lane, not on main.
2. `npx tsc --noEmit`, `npx vitest run`, the lane's Playwright specs (on the lane's E2E ports).
3. `.githooks/scan-leaks.sh main...HEAD` for the whole branch.
4. Write or update the lane note `docs/lane-notes/<branch>.md` and commit it:

   ```
   # <branch> — <date>
   Backlog: B14 (done | part: ...)
   Changed: one line per user-visible change.
   Check it: npm run dev:web -- --port 5392 --strictPort, then
     1. ...  2. ...  3. ...   (3-5 things to try, with what should happen)
   Tests: vitest N passing, tsc clean, e2e <specs> pass
   Muse spend: $0.00 (or calls made and cost)
   Left / known issues: ...
   ```

## Merging (main checkout; the user, or a merge session the user directs)

1. The user has checked the branch on its port.
2. `git merge --ff-only <branch>`. If it isn't a fast-forward, the lane rebases again (step 1 above);
   main never resolves conflicts.
3. Fold the lane note into `HANDOFF.md` (status table, tests, spend) and `docs/backlog.md` (Done
   entries), delete the note, and commit on main. An agent commit on main needs
   `LATTICE_ALLOW_MAIN=1 git commit ...`, which always asks the user first.
4. One-off lane: `git worktree remove .claude/worktrees/<name>` and `git branch -d <branch>`.
   Lane A keeps going on the same branch.
5. Tell the other open lanes to rebase before their next review.

Removing a worktree deletes its untracked files. Check `git status` in it first; don't use `--force`
without looking (that is how an untracked `launch.json` was lost on Oct 29).

## Lane S: variants stay uncommitted

- **Explore** (safe alongside the other lanes): variants live in `app/variants/` (git-ignored), never
  in the live app. A restyle is an override stylesheet over the real app, picked with a dev-only
  `?variant=<name>` switch; a new layout is a standalone mock page. The user compares them on port
  5394 and picks one. Copy keepers to `ui-reference/` in the main checkout before removing the
  worktree, or they are lost.
- **Apply** (a short freeze): the other lanes merge what they have, lane S applies the chosen
  variant to the real components and merges, then everyone rebases.
