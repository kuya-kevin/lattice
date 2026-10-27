# Control bar and transport: conventions we follow

Reference: Logic Pro and GarageBand for Mac. Where they differ, we follow **GarageBand's
defaults**: they're simpler, and they match what the artist asked for (Space, Return, R, K).

## Key commands

| Key | Action | Source |
|---|---|---|
| Space | Play / stop. Stops in place; the playhead stays where it stopped. | GarageBand main-window shortcuts; Logic "Play or Stop" |
| Return (Enter) | Go to the beginning. If playing, keeps playing from bar 1. | GarageBand |
| R | Record / stop recording | GarageBand (Logic's default is `*`) |
| K | Metronome (click) on/off | GarageBand |
| Shift-K | Count-in on/off | GarageBand |
| C | Cycle on/off (defaults to bars 1–4 if no region yet) | GarageBand, Logic |
| , / . | Playhead back / forward one bar | GarageBand |

Shortcuts are ignored while typing (inputs, the chat box, selects, editable text) and when
Cmd, Ctrl or Alt is held, so system shortcuts keep working. Space and Return are swallowed
so they don't scroll the page or press a focused button.

## Control bar and LCD

- **Layout:** a single strip.
  - Transport buttons on the left: go to beginning, play/stop, record, cycle.
  - An LCD in the middle.
  - Click and count-in toggles on the right.
  - Import, add track and mic after that.

  This is the shape of Logic's and GarageBand's control bar. Both put the LCD in the centre
  and add Metronome and Count-in buttons next to it.
- **The LCD:** shows the playhead as bars / beats / sixteenths ("1 1 1") and as time, then
  the tempo (BPM), time signature and key. This matches GarageBand's LCD and Logic's default
  "Beats & Project" LCD mode.
  - **Tempo:** click it to type a value. Enter or clicking away commits, Esc cancels, and
    Up/Down nudges by 1 (Shift by 10). The range is 40–240 BPM. Logic also lets you drag the
    value vertically; we skipped that for now (it's cheap to add).
  - **Time signature:** a pop-up of common signatures (2/4, 3/4, 4/4, 5/4, 6/8, 7/8, 12/8).
    As in Logic and GarageBand, it changes the grid and the click, not playback speed.
  - **Key:** pick from a list of the 24 major and minor keys, or type one ("Gm", "F# maj",
    "Bb"); it's normalized, for example to "G minor". Logic and GarageBand both default to
    C major and 4/4 at 120 BPM. We default to 120 BPM and 4/4 with no key set, so Muse can
    tell "not set" apart from "C major".
- **Ruler:** shows bars and beats driven by the session tempo and time signature
  (waveform-playlist's `BeatsAndBarsProvider`). Snap is off for now.

## Metronome and count-in

- The click follows the project tempo and accents the downbeat. It plays during playback and
  during recording when on. That is Logic's default behaviour: its "Click while Recording"
  and "Click while Playing" modes both on.
- The count-in is one bar of clicks before recording starts, toggled separately from the
  click, as in GarageBand. GarageBand also offers two bars; we do one.
- Apple's own warning applies: with a microphone, the click can bleed into the take, so use
  headphones.
- **Timing:**
  - Clicks are oscillator blips scheduled ahead on the AudioContext clock by a 25 ms timer
    with a 100 ms lookahead (`src/core/metronome.ts`). Jitter in the JS timer doesn't move
    the clicks.
  - Clicks share the playlist's AudioContext and are aligned to the engine's position minus
    its scheduling lookahead.
  - The count-in-to-record handoff still uses a `setTimeout`, so it can be a few ms late.
  - There's no recording latency compensation yet.

## Muse

Tempo, time signature, key and click are part of the session model. Muse sees them in the
first line of every session summary, for example `Tempo 92 BPM, 4/4, key G minor, click on,
1-bar count-in.`. It can change them with `set_tempo`, `set_time_signature`, `set_key` and
`set_metronome`. `quantize_drums` takes the session tempo, not its own `bpm` argument. The
transport is the `play`, `stop` and `go_to` tools; the UI and the key commands call the same
tools.

## Sources

- GarageBand for Mac, main-window keyboard shortcuts: https://support.apple.com/guide/garageband/main-window-shortcuts-gbnd58362a62/mac
- GarageBand for Mac, project properties (tempo, key, time signature in the LCD): https://support.apple.com/guide/garageband/intro-to-project-properties-gbnd31d2cb35/mac
- GarageBand for Mac, set the time signature (LCD, Beats & Project): https://support.apple.com/guide/garageband/gbnd727cec12/mac
- Logic Pro for Mac, project properties (tempo, key, time signature; defaults): https://support.apple.com/guide/logicpro/lgcp8f5d126d/mac
- Logic Pro for Mac, transport key commands (Space = Play or Stop): https://help.apple.com/logicpro/mac/10.1/en.lproj/lgcp2814a670.html
- Logic Pro for Mac, transport buttons (cycle with C): https://support.apple.com/guide/logicpro/lgcp0b07c0c9/mac
- Logic Pro for iPad, metronome and count-in modes: https://support.apple.com/guide/logicpro-ipad/lpipb46f43b3/ipados

# Window layout, sound library, tracks and regions (added 2026-10-27)

## Layout

The layout follows Logic's main window. The control bar runs along the top. The tracks area
has its own small toolbar (snap, undo, view toggles). A browser pane sits on the right, and an
editor / Smart Controls pane sits at the bottom of the tracks area.
- **Right pane:** tabbed. **Library** is our version of Logic's Loop Browser; **Muse** is the
  chat. Muse is the default tab. Both stay mounted, so switching tabs keeps the chat history
  and the search.
- **Bottom pane:** Smart Controls. It shows the selected track (and the selected region) and is
  where the effects agent mounts `DevicePanel` (see the marked region in `App.tsx`).

## Key commands

These add to the transport commands above.

| Key | Action | Source |
|---|---|---|
| O | Show/hide the sound library. If the Muse tab is showing, O switches to Library. | Logic: O = Loop Browser |
| B | Show/hide Smart Controls | Logic: B = Smart Controls |
| ⌘Z / ⇧⌘Z (Ctrl on Linux/Windows; Ctrl-Y also redoes) | Undo / redo | Logic, GarageBand |
| Delete / Backspace | Delete the selected region | Logic, GarageBand |
| ⌘G | Snap to grid on/off (goes back to the last grid, Bar or Beat) | GarageBand main-window shortcuts |

The same typing and modifier rules apply as for the transport keys.

## Sound library (Loop Browser conventions)

- **Search and keyword buttons:** a search field plus keyword buttons (Drums, Bass, Synth,
  Keys, Vocal, FX, One-shot, Phrase / Loop, CC0 only). Selected buttons combine with **AND**,
  as Logic's keyword buttons narrow the result list.
- **Set selector and category browser:** a set selector (All / Instruments / Material / Voice
  notes). With no search and no filters, a category browser (grouped by set, with counts)
  takes the place of Logic's column browser. Clicking a category drills in, and "‹ All" goes
  back.
- **Preview:** click a row to hear it; click again to stop. This matches the Loop Browser,
  where clicking a loop previews it. Previews play straight to the output, not through the
  track mixer.
- **Adding sounds:** drag a row onto a track to add it there, at the snapped time under the
  pointer. Drop it on empty space below the tracks (or on the empty project) to make a new
  track. This is Logic's rule: "drag the loop to an empty part of the Tracks area to create a
  new track".
- **Credits:** the info area at the bottom gives a TASL credit line (title, author, source,
  licence), as Creative Commons recommends. CC-BY sounds are flagged "Attribution required",
  and the line is saved on the session source (`credit`) so an export can list it later.
- **Where the data comes from:** Electron reads `data/` (or `$LATTICE_DATA_DIR`) in the main
  process over IPC (`library:list`, `library:audio`). dev:web uses a Vite middleware
  (`/api/library`). Tests use `tests/fixtures/library` (tiny synthetic files). Audio is only
  ever requested by item id, never by path.

## Regions (clips)

- **Moving regions:** drag a region by its header to move it in time and to another track.
  Drop it below the last track to put it on a new track. While you drag, the region stays put
  and dims. A white outline shows where it will land, with a help tag ("2 3 1 · Drums" = bar,
  beat, division and the destination track), like Logic's help tag.
  waveform-playlist 16's `ClipInteractionProvider` only moves regions horizontally (it
  hard-codes `RestrictToHorizontalAxis`). We keep its trim handles and its dnd-kit sensors, but
  we run our own `DragDropProvider` (`renderer/Arrange.tsx`).
- **Snap:** Off / Bar / Beat, defaulting to Beat. Snap applies to moves, trims and library
  drops. GarageBand has a single Snap to Grid toggle (⌘G); Logic has a Snap menu that
  includes Bar and Beat. **Difference from Logic:** Logic snaps *relatively* by default, so a
  region keeps its offset from the grid unless "Snap Regions to Absolute Value" is on. We
  always snap the region start onto the grid line, which is the absolute mode. That is simpler
  to predict, and it is what Muse assumes when it reasons in bars.
- **Overlaps:** regions may overlap on a track, as in Logic (later regions play over earlier
  ones). We don't block overlapping drops.
- **Hand edits:** every move, trim, delete and placement runs a tool, so the user and Muse
  share one path.
  - `move_clip` takes an optional `track_id` and is now open to Muse, for light arranging.
  - Moves are logged for Muse in plain words, e.g. `moved clip c4 from t3 @0s to t1 @3s`.
  - Trims are committed once, when the drag ends, so one trim is one undo step and one log
    line.
- **Undo:** one history for both the user and Muse (Logic has one undo history too). Undo and
  redo restore the arrangement and the mix but keep the playhead/transport, and they never
  reuse ids. Undo is logged too, so Muse knows when you took back something it did.
- **Selection:** click a region to select it (white outline, lighter header), and click a
  track header to select the track. The selected header is lighter, as in Logic, and the Smart
  Controls pane follows the selection.
- **Region colour:** each track gets a colour (blue, green, yellow, orange, …) for its header
  strip and its regions (coloured header, tinted body, light waveform), close to Logic's
  default region look. Regions on muted tracks turn grey. The region header shows the
  region's own name; waveform-playlist prints the track name there, which is wrong after a
  move.

## Track headers

The header has a colour strip, the track number, the name and the id (Muse refers to tracks
by id), then **M / S / R** buttons and a volume slider.
- **M / S / R colours:** mute is blue, solo is yellow and record-enable is red, the colours
  Logic uses for these buttons.
- **Record-enable:** one armed track at a time, since we record a single input. A take goes
  to the punch-in track if one is armed, else the record-enabled track, else the selected
  track, else a new track. Muse sees "record-armed" in the session summary and can call
  `arm_track`.
- **Volume:** Option/Alt-click the slider to reset it to 0 dB, Logic's reset gesture.
- **Not yet:** there's no pan control (the session has no pan), and tracks can't be renamed
  in place.

## Sources (layout, library, regions)

- Logic Pro for Mac, Loop Browser (keyword buttons; click to preview; drag to a track or to an empty part of the Tracks area for a new track): https://support.apple.com/en-ng/guide/logicpro/lgcp4b716bce/mac and https://help.apple.com/logicpro/mac/10.1/en.lproj/lgcp4b716bce.html
- Logic Pro 9 manual, finding Apple Loops in the Loop Browser (button view, dimmed keywords): https://help.apple.com/logicpro/mac/9.1.6/en/logicpro/usermanual/chapter_11_section_3.html
- Logic Pro for Mac, snap values (Bar, Beat; relative vs "Snap Regions to Absolute Value"): https://support.apple.com/en-mk/guide/logicpro/lgcpf7c0f66a/mac
- Logic Pro 9 manual, snapping region edits; regions move horizontally and vertically between tracks: https://help.apple.com/logicpro/mac/9.1.6/en/logicpro/usermanual/chapter_13_section_2.html
- GarageBand for Mac, main-window shortcuts (⌘G Snap to Grid): https://support.apple.com/guide/garageband/gbnd58362a62/mac
- Creative Commons, recommended practices for attribution (TASL): https://wiki.creativecommons.org/wiki/Recommended_practices_for_attribution
- Unverified (from memory of Logic's default key commands, check on the Mac): O = Loop Browser, B = Smart Controls, Option-click resets a slider, M/S/R button colours.
