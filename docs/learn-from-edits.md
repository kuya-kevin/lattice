# Learn from user changes (proposed B23)

Design agreed 2026-10-29. Not built yet. Lane C.

Muse can't hear music, but it can learn the producer's ear from their hands. Lattice watches what
the user does by hand, turns habits and corrections into small rules, keeps them across sessions,
and Muse (and the app) apply them later, always saying so.

## Today

- Every UI action runs through `runTool(..., 'user')`; `store.logUserEdit` keeps one line of text
  per edit (`core/tools.ts`, `runTool`).
- Muse reads those lines once in `<user_edits_since_last_turn>` (`core/agent.ts`), then
  `takeUserEdits()` clears them. Nothing survives the turn, and the strings carry no structure.
- Reusable: the "After Muse" version at the end of each turn (separates Muse's state from the
  user's), `fx/vocab.json` (words -> knob moves), `chains.json` in userData (B10: persists across
  sessions behind a file library).

## Two kinds of rule

| Kind | Learned from | Key | Example |
|---|---|---|---|
| **name-pan** (build first, the demo) | the user's own habit: a track's name and where it ended up | name word only, **any source type** | `left` in a name -> pan -0.4 |
| **vocab correction** (second) | the user moving a knob Muse set from `suggest_moves` | vocab word + source type | `spacious` on vocal -> reverb mix -5 vs default |

Source type matters for vocab words (a "spacious" vocal and pad need different moves) but not for
panning (a producer who doubles vocals at ±40% likely doubles guitars there too).

## Capture: when the user saves a version

Learning runs when the user saves a named version (Versions menu, "Name this version" -> Save,
`save_version`) and on **New session** (it auto-saves first; the user is leaving that work).
Muse's own auto versions (before/after a turn) never teach: they are Muse's checkpoints, not the
user's approval. Learning is plain code, no Meta calls.

**name-pan detector.** For each track, look for the side words `left`/`right`/`L`/`R` as whole
words, any case ("Vox L", "Gtr-R" match; "Lead", "Rhodes" never do). If the track is panned to that
side, that is evidence; the amount is the average |pan| seen. A side learned also gives the mirror
side (left -0.4 -> right +0.4). A side-named track left centred or panned the other way counts
against the rule. One observation is enough: the user did it themselves.

**vocab-correction detector.** During a Muse turn, record which vocab entry `suggest_moves`
resolved (by its main word, so aliases like "space"/"roomy" share one rule) and which params Muse
then set. At save, diff the After Muse version against the current session on those params only.
A kept change is a correction (undone edits don't count, only the saved state). A device Muse
inserted that the user removed or bypassed counts against the word. Repeats average
(+3 then +2 -> about -5.5 over 2 edits) rather than overwrite. Ladder: 1 edit = Muse mentions it,
2 = default, 3 the other way = rule dropped.

## Storage: across sessions

`taste.json` in userData, next to `chains.json`, behind the same kind of file library
(`FileChainLibrary` pattern; in-memory in the web build and tests). It is outside the session, so
rules follow the user to every session and survive a relaunch.

```json
{ "kind": "name-pan", "word": "left", "pan": -0.4, "count": 1, "lastSeen": "2026-10-29T..." }
{ "kind": "vocab", "word": "spacious", "sourceType": "vocal", "device": "reverb", "param": "mix", "offset": -5, "count": 1, "lastSeen": "..." }
```

## Apply

- **User makes or renames a track** to a side-named one: the app applies the name-pan rule at once
  through `set_pan` (one undo step), shows "Panned 40% left (your habit) · Undo · Forget", and logs
  it as a hand edit so Muse sees it. Instant, no Meta call.
- **Muse makes or renames a track:** `summarize()` adds a short "Producer habits" block; Muse pans
  by the user's amount instead of hard ±1 or a guess.
- **Vocab words:** `suggest_moves` adds the offsets on top of `vocab.json` and labels them,
  e.g. `mix +3 (your usual; default +8)`.
- A rule never overrides the user: name-pan only applies to a track that is still centred.
- **Taste list** (small panel, e.g. in the Versions menu): each rule with its scope ("any track" /
  "vocals"), how many edits taught it, and a delete button. Deleting is a tool, like every action.

## Demo script

1. Session 1: add "Vocal Left", pan 40% left; add "Vocal Right", pan 40% right. Save version
   "doubles". The Taste list shows *left/right in name -> pan ±40% · any track · 2 edits*.
2. New session, import a new vocal, add "Vocal Left": it pans 40% left by itself, with the note.
3. Add "Guitar L": it pans 40% left too (the rule is the user's habit, not a vocal setting).
4. Ask Muse "double the lead vocal left and right": it duplicates, names the tracks Vocal Left /
   Vocal Right, pans ±40% and says it used the user's usual width. (Recorded fixture; one live
   call to record it, ask first.)
5. Delete the rule in the Taste list, add "Vocal Right": it stays centred.

Optional proof of persistence: an Electron Playwright test that quits and relaunches with the
same `LATTICE_USER_DATA` and checks the rule is still applied.

## Build plan

- `core/taste.ts`: rule types, the name-word matcher, the two detectors (pure, Vitest-tested,
  including the "Lead"/"Rhodes" non-matches).
- `core/tasteTools.ts`: `list_taste`, `forget_taste` (and later `remember_preference` for stated
  habits: "I always want less reverb on vocals"). Own module, per `docs/parallel-work.md`.
- Hook the detectors into `save_version` and `new_session` (`core/versions.ts`), small additions.
- `node/` file library for `taste.json`, wired in `electron/main.ts` like `chains`; bridge methods.
- Apply on `add_track` / `rename_track` (and duplicate) for name-pan; `summarize()` habits line;
  `suggest_moves` offsets (`fx/vocab.ts`) for vocab rules.
- Renderer: the note with Undo/Forget, the Taste list (own CSS file; lane S owns `styles.css`).
- Playwright first, asserting on `window.lattice.getSession()` and the stored rules, following the
  demo script above.

## Open

- Should stated preferences (`remember_preference`) share the Taste list? Probably yes.
- Rules don't export with a chain or a session (not for the hackathon).
