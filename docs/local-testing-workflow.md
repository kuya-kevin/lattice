# Local testing workflow

How to check a UI change in the Lattice app quickly, written for coding agents (Claude Code, or
the local Qwen model under omp). The short version: **drive the app with Playwright and assert on
the session object, not on screenshots.** Use screenshots and video as evidence for the human,
not as the main test.

All commands run from `app/`.

## Fastest to slowest

| Path | Cost | Use it for |
|---|---|---|
| `npx vitest run tests/<file>.test.ts` | under 1 s | pure logic (key mapping, snap, session tools) |
| Playwright, web build: `E2E_PORT=53xx npx playwright test e2e/<file>.spec.ts --reporter=line` | about 8 s for 3 tests | almost every UI behaviour. Uses `mockBridge`, so the same session store and tools as Electron, with an offline Muse |
| Playwright, real Electron: `npm run build && npx playwright test e2e/electron.spec.ts --reporter=line` | about 1 s build plus 6–8 s | anything that touches IPC, the main process or the library data dir, or a final "does it work in the real app" check |
| Computer use (screenshots and clicks on the live window) | minutes, lots of tokens | only for looking at layout or visual bugs a human would spot. Never for checking behaviour |

Measured on Oct 27, 2026. The Electron build is Vite plus rolldown and really does take under a
second.

## The pattern

1. **Reproduce with a failing test first.** Write the Playwright spec, temporarily revert or skip
   your fix, and confirm the test fails. Then restore the fix and confirm it passes. A test that
   passes both ways is checking nothing.
2. **Assert on state, not pixels.** The renderer exposes the session to tests:
   ```ts
   const s = await page.evaluate(() => window.lattice!.getSession());
   expect(s.transport.playing).toBe(true);
   expect(s.tracks[0].muted).toBe(false);
   ```
   Also useful: `getByRole('button', { name: 'Stop' | 'Play' })` for the transport state, and
   `getByTestId('lcd-time')` / `getByTestId('lcd-bars')` for the playhead readout.
3. **Make audio in the test instead of using files.** Copy the `sineWav(seconds)` helper from
   `e2e/playback.spec.ts`, then pass the result to `page.getByTestId('file-input').setInputFiles(...)`.
   Use a short length (0.1 s) to test one-shot edge cases.
4. **Get keyboard focus without clicking.** Use `locator.focus()` before `page.keyboard.press(...)`.
   Clicking a `<select>` opens a native menu that Playwright can't see.
5. **Evidence for the human** (off by default since Oct 31; it slows the suite and loads the CPU,
   which the audio timing specs are sensitive to). Run with `LATTICE_EVIDENCE=1` to write it.
   - **Web build:** `test.use({ video: evidenceVideo })` (from `e2e/evidence.ts`). A `.webm` per
     test lands in `test-results/` (or wherever `--output=` points).
   - **Electron:** `electron.launch({ ..., ...(EVIDENCE ? { recordVideo: { dir: 'screenshots/…' } } : {}) })`.
   - **Screenshots:** `shot(page, 'screenshots/<topic>/<name>.png')` (a page or a locator).
     `screenshots/` and `test-results/` are gitignored.

Worked example: `e2e/playback.spec.ts`. It came from the Oct 27 fix: playback now continues past
the last clip, and Space plays/pauses even when a button, slider or menu has focus.

Electron specs run in their own Playwright project on one worker. Most of `e2e/electron.spec.ts`
shares one app launch and starts each test from an empty session (`new_session` keeps the id
counter, so read track ids from the session rather than assuming `t1`).

## Gotchas

- **Ports.** The web config reuses any server already on `E2E_PORT` (default 5299). Give each run
  its own `E2E_PORT` so you don't test another checkout's stale server.
- **Electron tests run the built files** (`dist/`, `dist-electron/`). Run `npm run build` after
  every change, or the Electron tests silently use old code.
- **`npm run dev` can end up running twice.** Each run starts its own Electron, and both have the
  bundle id `com.github.Electron`. Computer-use tools can't tell them apart. Check with
  `pgrep -fl "lattice/app/node_modules/electron"` and look at the start times.
- **Audio lives only in the renderer.** Closing and reopening the Electron window keeps the session
  (tracks, clips) but loses every audio buffer, so clips draw as empty lanes. Don't mistake that for
  a new bug.
- **Typecheck.** `npx tsc --noEmit` is clean. Keep it that way, and delete any temporary repro
  specs before you finish.
- **No Meta calls in tests.** The web build's Muse is an offline stand-in, and the Electron tests
  never send chat. Keep it that way: the API budget is limited.

## When computer use is still worth it

Layout problems that tests don't assert on. For example, the Device chain panel sits under the chat
composer, and the sound library covers "Extract MIDI". For those, take one screenshot, zoom
into the region, and write the finding down. Then switch back to Playwright to check the fix.
