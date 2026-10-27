Lattice · state as of Oct 26, end of day 1

# Which model does which job

Muse can understand what you say and run the session, but it can't hear music. So every job that needs ears or sound goes to a different model or to plain signal processing. This page maps each job to what does it today and how well it's working.

Working Mixed results Placeholder in app Waiting Dropped META made by Meta

## How a request flows

### You

type or talk, tweak by hand, judge by ear

**"Make it grittier", "quantize the drums", "find a warm pad"**Your hand edits (trims, gain, knobs) are passed to Muse as feedback on its next turn.

↓

### Lattice app

Electron, also runs in a browser

**Mini-DAW**waveform-playlist (open source, MIT): tracks, trim, record, punch-in, click track, tempo/key bar, Logic-style shortcutsWorking

**Muse chat panel**shows each tool call Muse makesWorking

↓

### Muse, the planner META

muse-spark-1.3-contributor, cloud

**Reads the session, decides, calls tools**Sees tracks, tempo, key and your edits as text. Never listens to audio itself.Working

↓ tool calls

### Tools

what Muse can reach

**Session tools**trim, gain, mute/solo, add track, punch-in, tempo, key, clickWorking in app

**Freesound search**words plus timbre filters (bright, warm, rough…)Working in app

**Sound and engineer tools**quantize, cleanup, synth knobs, recreate, Magenta RT2, earsPlaceholder in appReal versions exist as Python spikes; next step is wiring them in.

## Job by job

| Job | What does it | Runs where | Status | What we measured |
| --- | --- | --- | --- | --- |
| Talking and planning |  |  |  |  |
| Understand your request, plan, call tools | Muse Spark 1.3 METAcontributor mode, approved | Meta APIcloud | Working | Standard tool calling; makes several calls per turn. 16 app calls, about $0.006. Respects your hand edits in the recorded test. |
| Spoken instructions to text | Muse Spark 1.2 audio input META | Meta APIcloud | Speech only | Transcribed a spoken sentence word for word. Synth notes are dropped; a beatbox clip was refused. |
| Ears: describing and comparing sounds |  |  |  |  |
| Score words against a sound ("is this grittier?") | PE-AV base METAPerception Encoder Audio-Visual, Apache-2.0 | Your Mac\~4 GB | Testing | Tracks 4 of 6 synth knobs: drive, resonance, attack, detune. Misses brightness and noise. Large model and the 144-sound Freesound test are running. |
| Brightness, noise, pitch, envelope | Direct measurementsignal processing, no model | Your Mac | Shelved for now | Moves the right way on our own synth, one knob at a time. Could cover the two words PE-AV misses. |
| Grade an attempt automatically | Spectral distance, MusicCoCa, PE-AVthree candidates | Your Mac | Waiting on pairs | None matched your slider ratings, but those were "do I like it", not closeness. The new A/B page answers this properly. |
| Making sounds |  |  |  |  |
| Recreate a sound you can tweak | Our 15-knob synth + optimizertrial-and-error search, no AI model | Your Mac\~30 s per sound | Your top pick | Liked 64 on average; "start from this" 6/13. Fails on some sounds (acid bass, 6/100 in round 1). |
| Muse sets the first patch, optimizer finishes | Muse META + optimizerMuse reads a written description | Meta API + Mac | Close second | Liked 66; best automatic score on 3 of 6, including the acid bass. Muse alone 54. About $0.002 per sound. |
| Play notes in a style ("like this, but…") | Magenta RT2 smallGoogle, Apache-2.0 / CC-BY | Your MacMLX, 2× real time | Vibe, not copy | Right pitch on 5 of 6 when the reference is looped to 10 s. Liked 43, same as the starter patch. Ignores note length. |
| Find real sounds by words and timbre | Freesound APIsearch, not a model | Cloud | Working | Filters on brightness, warmth, roughness, hardness, depth. Curated set: 144 CC0/CC-BY one-shots in 18 categories. Its `pitch` field is unreliable (11/80); `note_name` is good (64/80). |
| Session engineering |  |  |  |  |
| Clean up noisy voice notes | noisereducesignal processing | Your Mac | Working | Noise down 3–16 dB, performance changed at most about 2 dB. DeepFilterNet dropped: it treated humming as noise. |
| Pull one instrument out of a mix | Demucs htdemucs_6s METAvia python-audio-separator | Your Mac14 s for 33 s | Working | Piano from note 146: 91% of the energy landed in the piano stem, 5% in vocals (your humming). |
| Pull out a sound by describing it | SAM Audio METASAM License | Mac via MLX copy, or the 3090 | Access pending | Meta's gated copy is awaiting approval. Ungated MLX copies exist (2.4 GB small, 6 GB large); same licence terms apply. |
| Quantize drums, trim silence | Our codeonset detection, grid fit | Your Mac | Working | Your loop at 83 BPM: 12.5 → 4.5 ms off the 1/16 grid. Synthetic test: 20 → 3–5 ms. |
| Audio to MIDI, key detection | basic-pitchSpotify, Apache-2.0; key from music-theory profiles | Your Mac | Acceptable | Your piano: 132 notes, G minor. Your verdict: good enough to edit. A piano-specialist model is untested. |

## Open questions

### Which ears?

PE-AV base or large, possibly paired with direct measurement for brightness and noise. Results from the large model and the Freesound test are pending.

### Can anything grade an attempt?

Rate a round of A/B pairs. If a score picks your winner most of the time, the agent can check its own work; if not, your ears stay in the loop.

### Wiring the tools in

Connect the Python spikes to the app: quantize, cleanup, synth + optimizer, Magenta RT2, ears. Today these are placeholders in the app.

### Meta at the centre

Muse plans and runs everything; Meta's PE-AV, Demucs and SAM Audio cover the listening and separation. Magenta RT2 (Google) and basic-pitch (Spotify) are the non-Meta pieces.

Meta spend so far: about $0.03 of the $150 budget. Source: `idea.md` §0.8 and the spike results in `spikes/`.