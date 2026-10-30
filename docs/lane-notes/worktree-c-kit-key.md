# worktree-c-kit-key — 2026-10-30
Backlog: B20 (done), B12b (part: "Muse fills a kit" done; export kit, per-pad trim/gain/choke, velocity left)
Also from the user (Oct 30): Muse's voice in Electron and the B16 instructions were tried live (HANDOFF "Needs from the user").

Changed:
- B20: `detect_key` (Muse and the region menu) reads a clip's key from its notes (Krumhansl-Kessler, `core/key.ts`),
  notes it on the clip (`Clip.key`, dropped when the notes change; Muse sees `[key A minor, detected]`), and with
  `set_session_key` adopts it as the session key (one undo step). An audio region reads its extract_midi stems.
  Right-click a region: Detect Key, Use as Session Key; a notice says the key, how sure, and a close second.
- B12b: Muse fills a sample pad from the library: `find_library_sounds` (words and/or category), `fill_kit` (new or
  existing kit, several pads, one undo step), and `set_pad` takes `library_id`. Library sounds load like shelf
  sounds (adoptAudio) and keep their CC-BY credit. Prompt: a kit request with a mood word is concrete, not a question.

Check it (Electron, live Muse; the worktree has no data/, so point it at the main checkout's):
  cd app && LATTICE_DATA_DIR=../../../../data npm run dev
  1. Chat "make me a dusty lo-fi kit": a kit card appears in Ideas with drums from the library on its pads; Muse
     names its picks. Open the pad (click the card) and play Q W E / A S D / Z X C: each pad plays its sound.
  2. Chat "put a different snare on the kit": Muse searches snares and swaps pad X (set_pad with library_id).
  3. Record or draw a few chords on Musical Typing (e.g. A minor), right-click the region -> Detect Key: a notice
     says the key; the region menu shows it. Then Use as Session Key: the LCD key changes; Cmd-Z puts it back.
  4. Chat "what key is this clip in? match the project to it": Muse calls detect_key with set_session_key.
  5. Web build without Muse: npm run dev:web -- --port 5393 --strictPort (the region menu works there too).

Tests: vitest 367 passing (12 skipped), tsc clean, e2e full web suite 105 passed (10 skipped), Electron specs 10 passed;
  new: tests/key.test.ts, tests/kit.test.ts (B12b block), e2e/key.spec.ts, e2e/fill-kit.spec.ts
Muse spend: $0.00 (no live calls; Muse's use of the new tools is checked live in step 1, 2 and 4)
Left / known issues:
- B12b: no Freesound-online picks (library only), no B9 features for picking; export kit, per-pad trim/gain/choke,
  velocity still open. Pad sounds don't get their own Ideas cards (they show inside the kit card), as before.
- B20: audio regions need extract_midi first (no FFT chroma pass). A stem is matched to its audio region by name
  ("<region> <stem>") and overlap, so a renamed stem is missed.
