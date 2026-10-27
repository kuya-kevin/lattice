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
