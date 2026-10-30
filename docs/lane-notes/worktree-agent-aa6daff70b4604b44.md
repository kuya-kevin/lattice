# worktree-agent-aa6daff70b4604b44 (lane C) — 2026-10-29
Backlog: B16 "Muse acts on clear instructions" (done, except recording the eval; it needs your OK, below)

Changed:
- Muse's system prompt (`core/agent.ts`): acts on concrete instructions only (arrange, mix, tracks,
  edits, devices); resolves "this" (selection), names and bars from the summary; answers a vague
  sound word with one short question offering one or two concrete changes; uses values the user
  names exactly; ends each turn with one short sentence meant to be spoken (no ids, no lists).
- `suggest_moves` is no longer offered to Muse (`userOnly`); the tool and `vocab.json` stay.
  `tests/vocab.test.ts` calls it as the user now. `tests/fx-agent.test.ts` (the B1 fx- replays) is
  `describe.skip` with the reason in the file: those fixtures were recorded with suggest_moves
  offered, so they fail at its first call. The fx- scenarios left `SCENARIOS` (now `fxScenarios()`),
  so a plain `npm run record-fixtures` won't re-record them.
- Summary (`session.ts`): a bars line ("bar n starts at X * (n-1) s"), each clip's bars
  ("bar 5 to 9" = fills bars 5-8), each track's colour name ("(blue) t5 ..."), clip fades, and
  the selection by name ("selected clip c6 ("Vocal" on t5 "Vocal")"), playhead bar.
- New tools in `core/editTools.ts` (registered in tools.ts): `split_clip`, `repeat_clip`
  (times or until_bar), `delete_bars` (closes the gap by default), `insert_bars`, `copy_bars`,
  `set_pan` (uses/adds a Utility device), `duplicate_track`, `set_track_color` (names in
  `core/trackColors.ts`, same order as TrackHeader's palette), `set_fade`.
- Bars in existing tools: `move_clip` and `duplicate_clip` take `bar`, `move_clips` takes `bars`,
  `trim_clip` takes `from_bar`/`to_bar` (a left-out edge stays put).
- `set_param` and `insert_device` take `exact: true`: a value the user named gets the knob's full
  range instead of being clamped to the usual (agent) range.
- Clip fades play: `Clip.fadeIn/fadeOut` go to the playout engine (`renderer/audio.ts`, two lines).
- `idea.md`: the "Muse proposes 2-3 versions" loop is replaced by the instruction loop; reference
  audio noted as a later possibility.

Check it: npm run dev:web -- --port 5393 --strictPort (Muse is offline in the web build, so check
the tools by hand from the console with `window.lattice`, or in Electron with live Muse):
  1. Electron: "Move the vocal to bar 9" -> the region lands on bar 9; reply is one sentence.
  2. Electron: "Make it sound better" -> a one-line question with two concrete options, no edit.
  3. Select a region, "split this at bar 3" -> two regions, split on the bar line.
  4. "Fade the vocal out over 2 seconds" -> the fade is heard at the end of the region.
  5. "Pan the double 30% left" -> a Utility device on that track, Pan at -0.3.

Tests: vitest 292 passing, 47 skipped (10 legacy fx- replays + 37 instruction replays not yet
recorded), tsc clean, e2e smoke, playback-edits, arrange-multi pass (port 5330).
New: `tests/editTools.test.ts` (21), `tests/instructions.test.ts` (36 offline: every case's ideal
tool calls pass its check, and doing nothing fails it).

Instruction eval (`core/instructionEval.ts`): 34 phrases (arrange 10, mix 7, tracks 4, edit 6,
devices 4, vague-ask 3), each a one-turn scenario "instr-<id>" on a shared 5-track mix, checked on
the resulting session (plus: one question and no change for the vague ones; short reply with no ids).
To record (NOT done; costs money, needs your OK), from `app/`:

    npm run record-fixtures -- 'instr-*'

Cost estimate: ~75 calls (2 per case, 1 for the questions) at ~10k prompt tokens each (the tool list
is ~9.5k tokens now) = ~0.8M in + ~15k out = about **$0.08** at contributor rates (higher than the
$0.03 first guessed, because of the tool list). To try a few first:
`npm run record-fixtures -- instr-move-to-bar instr-vague-better instr-knob-exact` (~$0.007).
The script also needs FREESOUND_API_KEY in .env (it checks it even for these scenarios).

Muse spend: $0.00 while building. Oct 29: the user recorded the 34 instr- fixtures, 886,853 in / 8,405 out tokens, $0.0904; replay passes 34/34 (31 concrete instructions call the right tool, the 3 vague ones ask a question and call none).

Left / known issues:
- `measure_track` and other offline renders (`renderer/ears.ts`) ignore clip fades.
- Pan is a Utility device, not a track field: the mixer UI has no pan knob yet.
- Muse resolves names to ids itself; tools don't accept track names.
- `scripts/record-fixtures.ts` now accepts a trailing `*` as a prefix match.
