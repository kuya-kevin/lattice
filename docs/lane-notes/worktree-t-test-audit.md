# worktree-t-test-audit — 2026-10-31
Backlog: none (test-suite audit requested by the user: faster e2e, no lost coverage).
Changed: all 15 candidates below, applied after the user approved (Oct 31). No app code changed.
Muse spend: $0.00 (no Meta calls; fixtures only).

## Result

| Run | Before | After |
|---|---|---|
| Playwright full (web + Electron) | 62-65 s, 302.7 test-s, failed in both baseline runs | **50-53 s**, ~220 test-s; 128/128 in the last 3 runs |
| Electron specs alone | 22 s | 12.8 s |
| click-drift | 42 s, failed under load | 21 s, passed in all 5 full runs |
| Stems export | 7.6 s alone, 12.6-15.8 s loaded | 1.3 s |
| Vitest | 445 tests | unchanged: 433 pass, 12 skipped |

Tests: tsc clean; vitest 433 pass; Playwright 128 tests (was 142: 14 removed or merged, each one's
asserts kept elsewhere as listed below). Full runs before the flake fixes: 128, 127, 128, 128, 126
and 128, 127, 128 of 128; after them: 128, 128, 128 (53, 53, 51 s).
Check it: `npm run build`, then `E2E_PORT=5350 npx playwright test --reporter=line`;
`LATTICE_EVIDENCE=1` brings back the screenshots and videos.

Flakes fixed in a second pass (user asked, Oct 31), each from a measured cause; then 160/160 at
10 workers x 20 repeats (all of record-timing, pills, the track reorder):
- **record-timing mic takes** (count-in and cycle audio): a take ends 33-51 ms short of the stop
  (input-latency compensation plus ~6 ms block jitter; 12 solo runs measured), so the 0.05 s limit
  failed now and then. Now 0.1 s; a missed count-in trim is 2 s off, a wrong pass ~0.5 s.
- **record-timing cycle audio**: under load the fixed 2.5 s wait sometimes stopped in a pass's
  first beat, where `cycleMicTake` (by design, unit-tested) keeps the pass before (0.8 s off). It
  now waits for the LCD to show beat 2-3 of the cycle bar before stopping.
- **pills drag**: the pills are centred, and a web font landing after the first measure moved
  them 1.59 px (seen with `document.fonts.status === 'loading'`). Both reloads now wait for
  `document.fonts.ready`.
- **arrange-multi track reorder**: reproduced 1 in 60 under load: right after the drop, one read
  of t5's header gave its slot's previous colour, the next read the right one. The check now polls.
  The app may show that stale colour for a frame (lane A's area; not looked into further).

What changed, beyond the table below:
- `e2e/evidence.ts`: `shot()` and `evidenceVideo`, used by every spec that wrote screenshots or video.
- `playwright.config.ts`: projects `electron` (listed first, `workers: 1`) and `web`. Listed first
  matters: as the second project its serial chain trailed the web run (60 s vs 51 s).
- `docs/local-testing-workflow.md`: the evidence section now describes `LATTICE_EVIDENCE`.

## Baseline (M-series Mac, 10 cores, Playwright default 5 workers, main @ 695b73a)

| Run | Wall | Tests | Result |
|---|---|---|---|
| `npx vitest run` | 3 s | 445 (12 skipped by design) | pass |
| Playwright web only (no build: Electron specs skip) | 62 s | 142, 272.6 test-s | 129 pass, **1 fail** (click-drift) |
| Playwright Electron specs only (`npm run build` first) | 22 s | 12 | pass; **same 22 s on 1 worker as on 3** |
| Playwright full (`npx playwright test` with a build) | 65 s | 142, 302.7 test-s | 140 pass, **2 fail** (click-drift, record-timing mic take) |
| click-drift alone | 42 s | 1 | pass (0.0 ms drift on all 39 passes) |
| record-timing + mix-view alone, 1 worker | 34 s | 8 | pass |
| fx render harness (`playwright.fx.config.ts`, 139 cases) | 8 s | 1 | pass |

Wall time tracks total test-seconds / 5 workers, so what counts is cutting test-seconds and CPU
load. Both failures are **timing tests that pass alone and fail under parallel load** (4.5 ms vs a
3 ms limit; 0.0503 s vs 0.05 s). Load also stretches tests: stems export runs 7.4 s alone, 12.6-15.8 s
in the full run. So raising `workers` is not a fix; it would make these flakier.

## Candidates, biggest first

Test-seconds are measured in the full run unless marked "alone".

| # | Where | What | Do | Coverage kept | Saves (test-s) |
|---|---|---|---|---|---|
| 1 | `mix-view.spec.ts:113` Stems export | 6.3 s of the 7.6 s (profiled alone) is `expect(stem.left[i]).toBe(0)` run once per sample of the tail. The export itself takes <1 s | **Change** to a single expect on the tail's max abs value | identical (every tail sample is still checked for 0) | ~6 alone, ~12 in full run |
| 2 | `click-drift.spec.ts` | One test sleeping 40 s (38 loop passes at 230 BPM 4/4). Longest test in the suite, and it flakes under load | **Change** to 2/4 at 230 BPM: same ~38 passes in ~20 s, and the cycle is still a non-whole number of engine ticks (200.35). Pattern check becomes `[accent, beat]`. Or, alternatively, make it opt-in (`LATTICE_SOAK=1`, run after metronome/transport changes) | same pass count and drift limit; the opt-in route runs it only on demand | ~21 (or 42 if opt-in) |
| 3 | `oct30-bugs.spec.ts:50` two-bar loop | 6 stop points, ~9.8 s of fixed waits; only the last stop crosses the wrap | **Change** to 3 stop points (early, late, past the wrap) | stop-from-cycle-start, silent after stop, stop across the wrap | ~5 |
| 4 | Video + evidence shots | `video: 'on'` in playback, snap-prompt, musical-typing, resize and tracks-clipboard; `recordVideo` in 2 Electron tests; ~60 `page.screenshot` evidence files into the git-ignored `screenshots/` | **Change** to off by default and on with `LATTICE_EVIDENCE=1`; keep Playwright's `retain-on-failure` video | no assertions depend on them | est. ~5, plus less CPU contention for the timing tests (to measure) |
| 5 | `electron.spec.ts` | 9 tests, 9 launches + 2 relaunches | **Merge**: one shared app (`describe.serial` + `beforeAll`, env = union of fixture library, engineer mock, STT mock, fake mic) for import, library IPC, measure/cleanup, push-to-talk, R-records, zoom. Relaunch test stays separate | same IPC paths | ~3-4 |
| 6 | `electron.spec.ts:35` 0.1 s one-shot / Space from focused menu | Renderer-only behaviour, already in `playback.spec.ts` (tests 2 and 3), plus a video | **Remove** | web playback specs | ~4 |
| 7 | `electron.spec.ts:188` trim both edges | Covered by `trim-twice.spec.ts` (its header says verified in web and Electron) and audio-editor's trim | **Remove**, or fold into #5 if you want an Electron trim kept | trim-twice, audio-editor, arrange trim | ~1.6 |
| 8 | Electron worker count | 22 s on 1 worker = 22 s on 3; in parallel they only slow each other | **Change**: put the 3 Electron specs in their own Playwright project with `workers: 1` (`TestProject.workers`, Playwright ≥1.52; we have 1.64), the web specs in another | same | frees 2 workers for web, ~0 directly |
| 9 | `ideas-ruler-tap.spec.ts:110` tap tempo | Second tap run ("from anywhere") waits 4 x 600 ms plus the ~2 s commit again. The tempo math (averaging, 2 s reset, 40-240 clamp) is already in `tests/ideas-ruler-tap.test.ts` | **Change** the second run to stop at "TAP shows in the LCD" | global T binding; commit/undo still in the first run | ~3 |
| 10 | `playback.spec.ts` "keeps rolling" (1 s clip, 2.5 s wait) + "0.1 s one-shot" | The same behaviour (transport rolls past the last region) twice | **Merge** into one test with the 0.1 s clip, keeping both sets of asserts | rolls past end, stop in place, LCD moved | ~2.5 |
| 11 | `shortcuts.spec.ts:61` "R records after a one-bar count-in" | Same flow as `record-timing.spec.ts:105` (mic take with count-in), which checks it more precisely | **Merge**: add the `COUNT-IN` LCD assert to record-timing, drop this one | count-in label, take lands | ~2.4 |
| 12 | `smoke.spec.ts:42` mic take | Same as `mixer.spec.ts:132` (Enable mic, Record, take on a new track) | **Merge**: move its asserts (name `Take…`, duration > 0.5, no page errors) into mixer's, drop it | same | ~1.8 |
| 13 | `oct29-layout.spec.ts` 7 width tests | 7 page loads + imports for one reachability check | **Merge** into one test that loops `setViewportSize` over the 7 widths (the failure message already names the width) | same 7 widths | ~2.5 |
| 14 | `shortcuts.spec.ts:110` "control bar screenshot (wide/narrow)" | No assertions, just two screenshots; reachability at widths is #13 | **Remove** (or keep under `LATTICE_EVIDENCE`) | oct29-layout | ~1.1 |
| 15 | `tempo-change.spec.ts:34` stopped playhead | The math is in `tests/session.test.ts:125` (`changeTempo` moves the position to 8); e2e adds only the LCD readout | **Move down** (drop e2e; LCD readout of a position is covered by many specs) | session unit test | ~0.5 |

Left alone on purpose:
- **Vitest** (3 s, 445 tests): no time to win. `tests/fx-agent.test.ts` is a `describe.skip` legacy block
  kept to document B1 (its own header says so); the instruction cases skip until fixtures are recorded.
- **Electron relaunch / projects / shelves / stems-on-disk**: each tests persistence or file IPC that
  the web build doesn't have (web stems go through downloads, Electron writes files).
- **record-timing, playback-edits, tempo-change playing, mixer meters**: their waits measure real
  audio-clock behaviour; shorter waits would weaken them.
- **fx render harness**: 8 s, only run after DSP changes.
- The 37 copies of a WAV-builder helper across specs: worth sharing in `e2e/helpers.ts` while
  touching these files, but no time saved.

## Estimate (before the changes)

About 70 of 303 test-seconds saved, a full run from ~65 s to roughly 48-52 s. Measured: 51-52 s.
#2 was done as the 2/4 shortening, not opt-in.

## Found on the way

- A fresh worktree's `npm install` left `node_modules/electron/dist` half extracted (89 MB vs 258 MB),
  so every Electron test failed with "Electron failed to install correctly". Fixed here by copying
  `dist/` from the main checkout. Other new lanes may hit the same.
- click-drift and the record-timing mic-take test fail on main under the default 5-worker load.
