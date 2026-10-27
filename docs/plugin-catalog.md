# Plugin catalog (S5 research)

Researched 2026-10-26. Purpose: pick open-source DSP for the Lattice effects engine instead of writing it from scratch, and fix the knob vocabulary that the UI and Muse share.

**How sure each claim is**
- **[v]** verified this session against a primary source: vendor docs, source code, the npm/PyPI registry, or the GitHub API.
- **[~]** approximate, from experience with the product UI. Apple does not publish numeric ranges for Logic's plugins. Check these on the Mac before relying on them.
- **[?]** unverified or inferred.

Locally installed packages that were read directly: `tone@15.1.22` and `@waveform-playlist/*@16.0.0` (both in `app/node_modules`).

---

## 0. TL;DR

1. **Run every effect live in the browser and render offline with the same graph in an `OfflineAudioContext`.** That gives one DSP implementation, so pedalboard is not needed for parity.
   - waveform-playlist already supports this. Its effects callback has the shape `(graphEnd, destination, isOffline)`, and `useExportWav` takes `createOfflineTrackEffects` [v].
2. **Build devices from three sources:**
   - native Web Audio and Tone.js nodes for EQ, filter, modulation, delay, utility and saturation;
   - **Faust** compiled ahead of time to AudioWorklet WASM for compressor, de-esser, gate, limiter and reverb;
   - **Signalsmith Stretch** (MIT, WASM AudioWorklet, formant control) for pitch.
3. **Licenses:**
   - Faust library functions carry per-function licenses [v]. Use only the STK-4.3 (MIT-style) and MIT ones, which include `zita_rev1_stereo`, `jpverb`, `dattorro_rev`, `svf`, `crossover2LR4`, `cubicnl`, `gate_mono` and `compression_gain_mono`.
   - **Avoid the GPL-3.0-only functions:** `FFcompressor_N_chan`, `RMS_FBFFcompressor_*`, `limiter_lad_*`, `expander_N_chan`, `vital_rev`, `kb_rom_rev1`, plus the `jprev_demo` and `greyhole_demo` wrappers (GPL-2+).
4. **Corrections to `session-plan.md`:**
   - pedalboard has **no Expander** [v].
   - It **does** have `BrickwallLimiter` (true-peak), `Clipping`, `Bitcrush`, `LadderFilter`, `Resample`, `MP3Compressor` and `GSMFullRateCompressor` [v].
   - It **is GPL-3.0** [v].
5. **No de-esser exists in the browser ecosystem.** Not in Tone, Tuna, WAM community, Elementary or the Faust libraries [v by search of sources]. Write one in Faust: about 30 lines from STK-licensed parts (section 4).

---

## 1. Reference devices (Logic Pro stock)

Source for knob names and behaviour: Apple's *Logic Pro User Guide for iPad*, effects chapters. These share the Mac plugins [v].
- Base URL: `https://support.apple.com/guide/logicpro-ipad/<slug>/ipados`. Slugs are given per device below.
- Apple publishes **no numeric ranges or defaults**, so every range below is **[~]**.

### 1.1 Channel EQ — `eq-parameters-lpip1816dc6e`

| Band | Type [v] | Knobs | Range [~] |
|---|---|---|---|
| 1 | High-pass | Freq, Slope, Q, On | 20 Hz–20 kHz; slope 6/12/18/24/36/48 dB/oct; Q has no effect at 6 dB/oct [v] |
| 2 | Low shelf | Freq, Gain, Q, On | ±24 dB; Q 0.1–100 [v: "extremely high value, such as 100"] |
| 3–6 | Parametric bell | Freq, Gain, Q, On | as above |
| 7 | High shelf | Freq, Gain, Q, On | as above |
| 8 | Low-pass | Freq, Slope, Q, On | as band 1 |
| Global | Master Gain, Analyzer (pre/post), display scale (Linear 12/30/60 dB, Warped) [v] | — | master ±24 dB [~] |

### 1.2 Compressor — `main-parameters-lpip25f51558`, `output-parameters-lpip3266d8ab`, `side-chain-parameters-lpip1cc06e29`

| Knob | Range / options | Notes |
|---|---|---|
| Circuit Type | Platinum Digital, Studio VCA, Studio FET, Classic VCA, Vintage VCA, Vintage FET, Vintage Opto [v] | See the model table below |
| Input Gain | ≈ ±30 dB [~] | |
| Threshold | ≈ −60…0 dB [~] | |
| Ratio | ≈ 1:1…30:1 [~] | |
| Knee | ≈ 0…1 (hard to soft) [~] | Not on Studio VCA [3rd-party] |
| Attack | ≈ 0…200 ms [~] | Not on Classic VCA [3rd-party] |
| Release | ≈ 5…5000 ms [~]; Auto Release toggle [v] | |
| Make Up | ≈ ±30 dB [~] | |
| Auto Gain | Off / 0 dB / −12 dB [v] | |
| Limiter | On, Threshold [v] | |
| Mix | 0–100 % [v exists] | Parallel compression |
| Output Gain | dB [v exists] | |
| Distortion | Off / Soft / Hard / Clip [v] | |
| Side chain detection | Max / Sum, Peak / RMS [v] | |
| SC filter | On, Listen, Mode LP/BP/HP/ParEQ/HiShelf, Freq, Q, Gain [v] | Gain only for ParEQ and HiShelf |

Circuit models. Hardware lineage is from [MusicTech](https://musictech.com/tutorials/logic-pro/understanding-compressor-circuit-types-in-logic) (3rd-party):

| Model | Modelled on | Quirk |
|---|---|---|
| Platinum Digital | — (Logic's original) | Clean, fast [Apple] |
| Studio VCA | Focusrite Red 3 | No knee |
| Studio FET | 1176 Blackface | Fast |
| Classic VCA | dbx 160 | No attack or release |
| Vintage VCA | SSL bus compressor | "Glue" |
| Vintage FET | 1176 Bluestripe | More saturated |
| Vintage Opto | LA-2A | Slow, coloured |

### 1.3 DeEsser 2 — `deesser-2-lpipc19de96d`

| Knob | Options / range | Notes [v] |
|---|---|---|
| Threshold | dB | |
| Max Reduction | dB | |
| Threshold Mode | Relative / Absolute | Relative compares the band level to the full-band level and is the default |
| Range | Split / Wide | Split reduces only the band; Wide reduces the whole signal |
| Frequency | Hz | Sibilance is typically 5–10 kHz |
| Filter Mode | Shelving / Band Stop | |
| Filter Solo | toggle | |

### 1.4 Limiter and Adaptive Limiter — `limiter-lpipd55746cc`, `adaptive-limiter-lpip6fcabd78`

| Device | Knobs [v] | Range [~] |
|---|---|---|
| Limiter | Gain, Release, Output Level, Lookahead (ms), Mode (Legacy / Precision), TP (true peak, Precision only) | gain 0…20 dB, out −20…0 dB, lookahead 0…20 ms |
| Adaptive Limiter | Gain, Out Ceiling, TP Detection, Remove DC, Lookahead, Apply (optimal) Lookahead | ceiling −20…0 dB |

### 1.5 Noise Gate — `noise-gate-overview-lpipbafe55dc`

Knobs [v]:
- Threshold (dB).
- Hysteresis (dB).
- Mode: Gate / Ducker.
- Reduction: can boost by up to +20 dB [v].
- Attack, Hold, Release, Lookahead.
- Key Filter (on/off), Monitor, Low Cutoff, High Cutoff, Characteristic (Bandpass / Band Reject).

Ranges [~]: threshold −100…0 dB, reduction −100…+20 dB, hold 0…500 ms.

### 1.6 Reverbs

| Device | Knobs [v] |
|---|---|
| ChromaVerb, main (`main-controls-lpipdc1fd692`) | Room Type (Room, Chamber, Concert Hall, Synth Hall, Digital, Dark Room, Vocal Hall, Bloomy, Theatre, Dense Room, Smooth Space, Reflective Hall, Strange Room, Airy), Freeze, Predelay (+Sync), Decay (+Sync), Attack, Size, Density, Distance, Dry, Wet |
| ChromaVerb, details | Quality (Low / High / Ultra), Mod Src (sine / random / noise), Mod Smooth, Mod Speed, Mod Depth, Early/Late Mix, Width, Mono Maker (+Freq) |
| ChromaVerb, Damping EQ | Low Shelf, Low Peak, High Peak and High Shelf, each with Freq, **Ratio** (decay-time multiplier) and Q |
| ChromaVerb, Output EQ | Low Cut (Freq, Order, Q), Low Shelf, Low Peak, High Peak, High Shelf (Freq, Gain, Q), High Cut (Freq, Order, Q) |
| Space Designer (`main-parameters-lpipe9ff881d`) | IR or synthesized IR, Predelay (+Sync), Length, Size (IR resample), X-Over Freq, Lo Spread, Hi Spread (0…1 [v]), plus volume, filter and density envelopes and output EQ |

### 1.7 Delays

| Device | Knobs [v] |
|---|---|
| Tape Delay (`tape-delay-lpipf03e8133`) | Sync, Note, Deviation, ×2 / ÷2, Delay Time (ms or note), Smoothing, Clip Threshold (tape saturation), Stereo Spread, Tape Head Mode (Clean / Diffuse), Low Cut, High Cut (in the feedback loop), Feedback (100 % means endless), Freeze, Wow LFO Rate and Intensity, Flutter Rate and Intensity, Dry, Wet |
| Stereo Delay (`stereo-delay-lpip2861fe20`) | Per side L and R: Input (Off, L, R, L+R, L−R), Note, Deviation, Delay Time, Feedback (+phase), Crossfeed (+phase). Global: Low Cut, High Cut, Routing preset (Rotate, Pan, Ping Pong, 10/90, 90/10, Straight), Beat Sync, Stereo Link, Output Mix L and R |

### 1.8 Distortion family

| Device | Knobs [v] |
|---|---|
| Overdrive | Drive (FET), Tone (high-cut), Output, Level Compensation |
| Distortion | Drive, Tone, Output, Level Compensation |
| Bitcrusher | Drive, Clip Level, Clip Mode (Clip / Wrap / Fold), Resolution 1–24 bit [v], Downsampling 1x…(≥10x [v]), Mix |
| ChromaGlow | Model (Retro Tube, Modern Tube, Magnetic, Squeeze, Analog Preamp), Style (Clean / Colorful, or Soft Press / Hard Press), Drive, Bypass Below (Hz), Level In, Level Out, Mix, Low Cut and High Cut (each with Slope, Freq, Resonance, Pre/Post) |
| Phat FX (`fx-processors-lpip22791b4f`) | Global: Input, Output, Mix, Limiter (soft / hard / off), XY pad. Modules: Bass Enhancer (Tune, Amount, Mode); Compressor (Release, Amount, Mode = Logic circuit types); Distortion (3× Drive + Type); Mod FX (Rate, Mix, Mode); Filter (Cutoff, Resonance, Drive, Type, Mix); Bandpass (Low/High Cutoff and Resonance, Reject Mix). Modulators include an envelope follower and step LFOs |

### 1.9 AutoFilter

Pages: `filter-controls-lpipc0da0a0e`, `lfo-controls-lpipf4e84b33`, `envelope-controls-lpip6535c03b`, `distortion-controls-lpip597cccfd`, `out-controls-lpip4fcb72c8`.

| Section | Knobs [v] |
|---|---|
| Filter | Cutoff, Resonance, Mode (MM HP, MM BP, MM LP, PK, LP 6/12/18/24 dB), Fatness, Stereo Spread, Env Cutoff Mod, LFO Cutoff Mod |
| LFO | Rate (+Sync), Waveform (saw down, saw up, triangle, pulse, random), Retrigger, Pulsewidth, Sync Phase, Stereo Phase |
| Envelope | Threshold, Env Dynamic, Side Chain Link, Attack, Decay, Sustain, Release |
| Distortion | Pre Filter amount, Post Filter amount, Mode (Classic / Tube / Scream) |
| Out | Dry Signal, Main Out |

### 1.10 Pitch, modulation, stereo, gain

| Device | Knobs [v] |
|---|---|
| Pitch Shifter (`pitch-shifter-overview-lpip3a0e23de`) | Semitones, Cents, Mode (Drums / Speech / Vocals / Manual / Pitch Tracking), Delay and Crossfade (Manual mode only), Mix, Latency Compensation, Stereo Link (Normal / Invert). Range [~]: ±24 st |
| Chorus | Rate, Intensity, D-Mode, Mix |
| Flanger | Rate (+Sync), Intensity, Feedback (±), Mix |
| Phaser | Sweep Mode, Stages (4–12; odd values are comb), Sweep Floor and Ceiling, LFO 1 and 2 Rate (+Sync), Phase (°), LFO Mix, Feedback, Warmth, HP and LP Cutoff, FB Filter, Output Mix (±, negative inverts) |
| Stereo Spread | Order (up to 12 bands), Lower and Upper Intensity, Lower and Upper Freq |
| Direction Mixer | Input LR / MS, Direction (±180°), Spread (0 = mono, 1 = neutral, >1 = wider; MS mode 2 = side only), Split, Crossover, Direction Low, Spread Low |
| Gain | Gain, Balance, Phase L and R invert, Swap L/R, Make Mono |

### 1.11 Third-party knob naming (for vocabulary only)

| Plugin | Knob names | Source |
|---|---|---|
| FabFilter Pro-Q | Frequency, Gain, Q, Shape (Bell, Low/High Shelf, Low/High Cut, Notch, Band Pass, Tilt Shelf, Flat Tilt), Slope (to 96 dB/oct and Brickwall), Dynamic EQ range [~ from product knowledge] | fabfilter.com |
| FabFilter Pro-C 2 | Style (Clean, Classic, Opto, Vocal, Mastering, Bus, Punch, Pumping), Threshold, Ratio, Knee 0–72 dB, Range, Attack, Release, Auto Release, Lookahead ≤20 ms, Hold ≤500 ms, Gain, Auto Gain, Dry/Wet 0–200 %, SC EQ [v] | [help](https://fabfilter.com/help/pro-c/using/dynamicscontrols) |
| FabFilter Pro-DS | Threshold, Range, Mode (Single Vocal / Allround), Wide Band / Split Band, HP and LP detection band (2–20 kHz), Lookahead ≤15 ms, Stereo Link [v] | [help](https://www.fabfilter.com/help/pro-ds/using/basiccontrols) |
| Soundtoys Decapitator | Style A/E/N/T/P (Ampex 350, EMI TG, Neve 1057, Culture Vulture triode and pentode), Drive, Punish (+20 dB), Tone, Low Cut, Thump, High Cut, Steep, Auto (gain), Output, Mix [v] | [manual](https://www.soundtoys.com/wp-content/uploads/Decapitator-Manual.pdf) |
| Valhalla VintageVerb / Room | Mix, PreDelay, Decay (≈0.2–70 s), Size, Attack, Early/Late Diffusion, ModRate, ModDepth, HighCut, LowCut, BassMult (≈0.25–4×), BassXover, HighShelf, HighFreq, Color Mode, Reverb Mode [~ partially verified via reviews] | valhalladsp.com |

**Naming conventions to adopt:**
- Threshold / Ratio / Knee / Attack / Release / Makeup / Mix.
- Freq / Gain / Q / Slope.
- Drive / Tone / Mix / Output.
- Decay / PreDelay / Size / Damping / Width.
- Rate / Depth / Feedback / Mix.

---

## 2. Open-source DSP usable live in the browser

### 2.1 Library survey

| Library | License | Status | What it gives Lattice | Verdict |
|---|---|---|---|---|
| **Web Audio native nodes** | n/a (browser) | — | BiquadFilter (LP/HP/BP/shelf/peak/notch/allpass, 12 dB/oct, `getFrequencyResponse` for drawing curves), DynamicsCompressor (threshold −100…0, knee 0…40, ratio 1…20, attack 0…1 s, release 0…1 s, read-only `reduction`; **no makeup, no sidechain input**), WaveShaper (oversample none/2x/4x), Convolver, Delay, StereoPanner, Gain, ChannelSplitter/Merger, AudioWorklet | **Base layer** |
| **Tone.js** 15.1.22 | MIT [v] | Active (pushed 2026-10-25) | Already bundled. Effect list in 2.2 | Use for modulation, AutoFilter, widener and delay basics |
| **waveform-playlist** 16 (`@waveform-playlist/browser`) | MIT [v] | Active | `effectDefinitions` (20 Tone effects with min/max/default, see 2.2), `useDynamicEffects` / `useTrackDynamicEffects` (per-track chains), WAM hosting via `@dawcore/wam@0.0.3` (MIT), `useExportWav` with offline effects [v] | **Host for chains and export.** Our catalog replaces its definitions |
| **Tuna.js** 1.1.3 (`tunajs`) | MIT (npm) [v]; GitHub shows no SPDX | Slow | Overdrive (4 algorithms), Filter, Cabinet, Delay (with cutoff), Convolver, Compressor (native wrapper plus makeup), WahWah, Tremolo, Phaser, Chorus, Bitcrusher and Moog (**ScriptProcessor**, deprecated), PingPongDelay, Panner, Gain [v wiki] | Skip; overlaps Tone, and ScriptProcessor is a problem |
| **Faust** + `@grame/faustwasm` 0.19.1 | Compiler and faustwasm LGPL-2.1 [v]. Libraries are LGPL **with an exception that lets generated code take any license** [v], but functions declare their own licenses (see 2.3) | Very active | Ahead-of-time `faust2wasm.js x.dsp out/` produces `dsp-module.wasm`, `dsp-meta.json` and a JS loader. **The libfaust compiler need not ship.** Parameters are set by path (`setParamValue("/x/thresh", v)`). `createOfflineProcessor` and `faust2sndfile` render offline [v README] | **Use for dynamics and reverb** |
| **Web Audio Modules 2** (`@webaudiomodules/api` 2.0.0-alpha.6, sdk 0.0.12) | MIT [v] | API frozen since 2023 | Plugin standard with parameter info and state | Use only through waveform-playlist's `@dawcore/wam` if we want third-party pedals |
| **wam-community** (58 plugins, [index](https://www.webaudiomodules.com/community/plugins.json)) | Repo has **no license**; varies per plugin [v] | Last push 2024-03 | Effects: Simple Distortion, Microverb (convolution), Simple Delay, Simple EQ (3-band), Big Muff, Csound Pitch Shifter, DeathGate (multiband gate), DistoMachine, DualPitchShifter, GraphicEqualizer, Grey Hole, KBVerb, KppFuzz, KppDistorder, OSCTube, Overdriverix, OwlDirty, OWLShimmer, PingPongDelay, QuadraFuzz, SmoothDelay, StereoFreqShifter, StonePhaser, SweetWah, Temper, ThruZeroFlanger, TS9, WeirdPhaser, Stereo Enhancer. **No compressor, limiter or de-esser** [v] | Optional "creative pedal" shelf. Check each plugin's license before vendoring |
| **Elementary Audio** (`@elemaudio/core` 4.0.1, web-renderer, offline-renderer) | MIT [v] | Slower (last release 2024-12) | `el.compress(atkMs, relMs, thresh, ratio, sidechain, x)`, `el.skcompress(…, kneeWidth, …)` (**real sidechain input**) [v src], biquads, SVF, convolve, delay; `elemaudio/srvb` reverb (MIT) | Good fallback for dynamics if Faust tooling is a problem; adds a second runtime |
| **Airwindows** (DeEss, DeBess, ToTape9, Console7…) | MIT [v] | Very active | Small, self-contained C++ per plugin, all parameters normalised 0–1. DeEss: Intense, Max DS, Freq. DeBess: Intense, Sharp, Depth, Filter, Sense. ToTape9: Input, Tilt, Shape, Flutter, FlutSpd, Bias, HeadBmp, HeadFrq, Output [v src] | **No web or WASM port exists** [v search]. Would need an emscripten build. `airwin2rack` (MIT) consolidates them behind one interface. v2 candidate |
| **Surge XT** / `sst-effects` | GPL-3.0 [v] | Active | Excellent effects | No web build. **GPL: avoid** |
| **Dragonfly Reverb** | GPL-3.0 [v] | Active | Hall / Room / Plate / Early | No web build. GPL: avoid |
| **LSP plugins** | LGPL-3.0 [v] | Active | Full dynamics suite | No web build; heavy |
| **x42** (darc, dpl) | GPL-3.0 [v] | Active | Compressor, true-peak limiter | No web build; GPL |
| **CHOW** (AnalogTapeModel; chowdsp_utils) | Tape GPL-3.0 [v]; utils mostly BSD-3 [?] (GitHub shows NOASSERTION) | Active | Tape model | No web build. Only chowdsp_utils is permissive |
| **Csound** (`@csound/browser` 7.0.0) | Wrapper Apache-2.0, core LGPL-2.1 [v] | Active | pvscale (formant-aware pitch), reverbsc, compress2, freeverb… | Large runtime; overkill |
| **RNBO** (`@rnbo/js` 1.4.5) | Runtime MIT; exported code dual-licensed (Cycling '74 licence for non-commercial use, or GPL-3) [v] | Active | Needs a paid Max licence to author | Skip |
| **Signalsmith Stretch** (`signalsmith-stretch` 1.3.2) | MIT [v] | Active | Official WASM AudioWorklet. Works on live input or buffers. `schedule({semitones, tonalityHz, formantSemitones, formantCompensation, formantBaseHz, rate})`, `latency()` [v README] | **Use for pitch** |
| **SoundTouchJS** (`soundtouchjs` 0.3.0; `@soundtouchjs/audio-worklet` 2.1.1) | LGPL-2.1 / MPL-2.0 [v] | Active | WSOLA tempo and pitch, **no formant handling** | Fallback |
| **Rubber Band WASM** (`rubberband-wasm` 3.3.0) | **GPL-2.0** [v] (commercial licence from Breakfast Quay) | — | Best quality; formant preserve (`--formant`) | Avoid for a public MIT repo unless the whole repo goes GPL |
| **node-web-audio-api** 2.2.0 | BSD-3 [v] | Active | Web Audio in Node (Rust). OfflineAudioContext; AudioWorklet support [?] | Possible headless render path for the Python sidecar or tests |

### 2.2 Tone.js effect classes (defaults read from `tone@15.1.22` source [v])

Effect classes. Every class also has `wet`, default 1, unless a different value is listed.

| Class | Params = default |
|---|---|
| AutoFilter | frequency=1 Hz (LFO), type=sine, depth=1, baseFrequency=200, octaves=2.6, filter={type lowpass, rolloff −12, Q 1} |
| AutoPanner | frequency=1, type=sine, depth=1 |
| AutoWah | baseFrequency=100, octaves=6, sensitivity=0 dB, Q=2, gain=2, follower=0.2 |
| BitCrusher | bits=4 (AudioWorklet) |
| Chebyshev | order=1, oversample=none |
| Chorus | frequency=1.5, delayTime=3.5 ms, depth=0.7, type=sine, spread=180, feedback=0, wet=0.5 |
| Distortion | distortion=0.4, oversample=none (WaveShaper) |
| FeedbackDelay | delayTime=0.25, maxDelay=1, feedback=0.125 |
| Freeverb | roomSize=0.7, dampening=3000 |
| FrequencyShifter | frequency=0 |
| JCReverb | roomSize=0.5 |
| Phaser | frequency=0.5, octaves=3, stages=10, Q=10, baseFrequency=350 |
| PingPongDelay | delayTime=0.25, maxDelay=1, feedback=0.125 |
| PitchShift | pitch=0, windowSize=0.1, delayTime=0, feedback=0 (two sawtooth-swept delay lines; grainy) |
| Reverb | decay=1.5, preDelay=0.01 (convolution with a generated noise IR; **regenerates asynchronously on every decay or preDelay change**, so it is poor for live knob turning) |
| StereoWidener | width=0.5 (M/S) |
| Tremolo | frequency=10, depth=0.5, spread=180 |
| Vibrato | maxDelay=0.005, frequency=5, depth=0.1 |

Components:

| Class | Params = default |
|---|---|
| Compressor | Native wrapper: threshold −24, ratio 12, knee 30, attack 0.003, release 0.25 |
| Limiter | Compressor with ratio 20, attack 3 ms, release 10 ms, threshold −12. **Not brick-wall** |
| Gate | threshold −40, smoothing 0.1. Follower plus comparator: no hold, range or hysteresis |
| MultibandCompressor | low and high crossover 250 / 2000 Hz; per-band ratio, threshold, attack, release, knee |
| MidSideCompressor | mid and side compressor settings |
| EQ3 | low, mid, high (dB); lowFrequency 400, highFrequency 2500 |
| Filter | type, frequency 350, Q 1, gain 0, rolloff −12/−24/−48/−96 |
| Others | Convolver, OnePoleFilter, FeedbackCombFilter, LowpassCombFilter, Panner, PanVol, Channel, Volume, CrossFade, MultibandSplit |

UI ranges that waveform-playlist ships in `effectDefinitions` [v]:
- compressor: threshold −60…0, ratio 1…20, attack 0…1 s, release 0…1 s, knee 0…40
- gate: threshold −100…0, attack 0…0.3, release 0…0.5
- eq3: ±24 dB; lowFrequency 20–500, highFrequency 1k–10k
- chorus: freq 0.1–10 Hz, delay 0–20 ms
- phaser: base 100–2000 Hz, octaves 1–6
- feedbackDelay and pingPongDelay: 0–1 s, feedback 0–0.95
- reverb: decay 0.1–10 s
- freeverb: room 0–1, damp 0–10 kHz
- distortion: 0–1
- bitCrusher: 1–16 bits
- stereoWidener: 0–1
- **No pitchShift entry.**

### 2.3 Faust functions worth using (license as declared in the library source [v])

| Need | Function | Declared license | Notes |
|---|---|---|---|
| Reverb (main) | `re.zita_rev1_stereo(rdel, f1, f2, t60dc, t60m, fsmax)` | jos section, STK-4.3 (MIT-style) | Fons Adriaensen's zita-rev1 algorithm. Demo ranges: rdel 0–100 ms, f1 50–1000 Hz, f2 1.5–20 kHz, t60dc and t60m 1–8 s. `dm.zita_rev1` adds a 2-band output EQ |
| Reverb (lush, modulated) | `re.jpverb(t60, damp, size, early_diff, mod_depth, mod_freq, low, mid, high, low_cutoff, high_cutoff)` | MIT | Do **not** copy `jprev_demo`, which is GPL-2+ |
| Reverb (huge, creative) | `re.valhallaSupermassive(…)`, `re.greyhole(…)` | MIT | |
| Reverb (plate) | `re.dattorro_rev(pre_delay, bw, i_diff1, i_diff2, decay, d_diff1, d_diff2, damping)` | STK-4.3 | |
| Freeverb | `re.stereo_freeverb` | GRAME LGPL with exception | |
| Compressor (basic) | `co.compressor_stereo(ratio, thresh, att, rel)`, `co.compression_gain_mono`, `co.compressor_lad_mono` | STK-4.3 | No knee or makeup, so we add them |
| Compressor (full) | `co.FFcompressor_N_chan`, `co.RMS_FBFFcompressor_N_chan` (knee, link, FF/FB) | **GPL-3.0-only** | **Avoid**; write our own gain computer |
| Limiter | `co.limiter_lad_*` | **GPL-3.0-only** | **Avoid**; write a ~25-line lookahead limiter |
| Gate | `ef.gate_stereo(thresh, att, hold, rel)` | STK-4.3 | Add range and hysteresis |
| Crossover | `fi.crossover2LR4(fc)`, `fi.lowpassLR4`, `fi.highpassLR4`, `fi.svf.*` | STK-4.3 | For the de-esser, mono-maker and multiband |
| EQ | `fi.peak_eq_cq`, `fi.low_shelf`, `fi.high_shelf`, `fi.lowpass(N, fc)`, `fi.highpass(N, fc)` | STK-4.3 | Native biquads are enough for EQ |
| Saturation | `ef.cubicnl(drive, offset)`, `ef.softclipQuadratic` (MIT), `aa.*` (antialiased waveshapers) | STK-4.3 / MIT | |
| Pitch | `ef.transpose(w, x, s)`, `ef.transpose_windowed` (MIT) | — | Delay-line based, same class as Tone.PitchShift; no formants |
| Mod | `pf.flanger_stereo`, `pf.phaser2_stereo` | STK-4.3 | |
| Width | `ef.stereo_width(w)`, `ef.ms_enc` / `ef.ms_dec` | STK-4.3 | |

---

## 3. Offline and Python parity

### 3.1 pedalboard: what is actually there

Verified against `pedalboard_native/__init__.pyi` on master and the v0.9.26 docs. **License: GPL-3.0.**

| Plugin | Params = default |
|---|---|
| Compressor | threshold_db=0, ratio=1, attack_ms=1, release_ms=100 (JUCE; **no knee, makeup or sidechain**) |
| Limiter | threshold_db=−10, release_ms=100 |
| BrickwallLimiter | ceiling_db=−1, release_ms=100, lookahead_ms=5, true_peak=False |
| NoiseGate | threshold_db=−100, ratio=10, attack_ms=1, release_ms=100 |
| Gain | gain_db=1.0 |
| Clipping | threshold_db=−6 |
| Distortion | drive_db=25 |
| Bitcrush | bit_depth=8 |
| Chorus | rate_hz=1, depth=0.25, centre_delay_ms=7, feedback=0, mix=0.5 |
| Phaser | rate_hz=1, depth=0.5, centre_frequency_hz=1300, feedback=0, mix=0.5 (6-stage) |
| Delay | delay_seconds=0.5, feedback=0, mix=0.5 |
| Reverb | room_size=0.5, damping=0.5, wet_level=0.33, dry_level=0.4, width=1, freeze_mode=0 (Freeverb) |
| Convolution | impulse_response_filename or array, mix=1, sample_rate |
| HighpassFilter / LowpassFilter | cutoff_frequency_hz=50 |
| HighShelfFilter / LowShelfFilter / PeakFilter | cutoff_frequency_hz=440, gain_db=0, q=0.707 |
| LadderFilter | mode LPF12/HPF12/BPF12/LPF24/HPF24/BPF24, cutoff_hz=200, resonance=0, drive=1 |
| PitchShift | semitones=0 (Rubber Band; no formant option exposed) |
| Resample | target_sample_rate=8000, quality |
| Others | Invert, MP3Compressor (vbr_quality=2), GSMFullRateCompressor, IIRFilter (base), Chain / Mix / Pedalboard containers, VST3Plugin / AudioUnitPlugin hosts |

- **Not present:** Expander, de-esser, EQ with more than one band per plugin, stereo width or M/S, tape or tube saturation models, auto-filter or LFO filter, flanger, tremolo.
- Logic's own plugins live inside Logic, not as system AUs, so pedalboard cannot load them on the Mac [~].

### 3.2 Recommendation: one DSP implementation in the browser

- **Live:** an AudioContext with the device graph per track (`useTrackDynamicEffects`, or our own `TrackEffectsFunction`).
- **Offline:** the same graph-builder function, run in an `OfflineAudioContext`.
  - waveform-playlist's `useExportWav({ createOfflineTrackEffects })` already exists for this [v].
  - Every `OfflineAudioContext` must `audioWorklet.addModule()` the Faust and Signalsmith modules again.
- **Agent and sidecar renders and pytest:** render headless through Electron or Playwright. Playwright is already a devDependency, so this is Chromium, identical to live. Write a WAV, then let pytest measure it (spectral centroid, band energy, LUFS, gain reduction).
  - Alternative: `node-web-audio-api` (BSD-3) in Node. AudioWorklet parity is [?].
- **pedalboard:** keep it only as an optional reference or A/B tool in the sidecar. Do not keep two implementations of each device in sync.
  - GPL-3 note: a separate Python process that imports pedalboard is fine for a hackathon. Do not vendor it into an MIT-licensed repo.

---

## 4. De-esser

**Survey result:** no ready browser de-esser.
- Airwindows DeEss and DeBess are MIT but have no web build.
- FabFilter, Logic and pedalboard: proprietary or absent.

**Build it in Faust** (`deess.dsp`) using only STK/MIT parts:

```
detector = fi.svf.bp(freq, q)              // or fi.highpassLR4(freq) in "shelf" mode
env      = abs : si.onePoleSwitching(att, rel) : ba.linear2db   // ~0.5 ms attack, ~60 ms release
relative = env - full_band_env_db          // Logic "Relative" mode; "Absolute" uses env alone
gr_db    = min(0, -(over * (1 - 1/ratio))) clipped at -maxReduction, where over = relative - thresh
split    : x -> crossover2LR4(freq) -> (low, high * db2linear(gr_db)) -> sum   // "Split"
wide     : x * db2linear(gr_db)                                                // "Wide"
```

Knobs: `freq`, `thresh`, `range`, `mode`, `band`, `listen`, plus an output GR meter. They mirror DeEsser 2 and Pro-DS (table in 6.3).
- **Fallback without Faust:** native split-band.
  - Biquad HP (2× cascaded, LR4) feeding a DynamicsCompressor (ratio 20, attack 0, release ~0.05 s), plus a complementary LP, summed.
  - Weakness: the native compressor's built-in lookahead (Chromium ≈6 ms [?]) delays the high band against the low band. That causes phase smear at the crossover, so the low band would need a matching DelayNode.
  - The Faust version avoids all of this.

---

## 5. Pitch and time

| Option | Quality | Formants | Latency | License | Verdict |
|---|---|---|---|---|---|
| Tone.PitchShift | Grainy, chorusy above ±3 st (dual delay-line crossfade) | No | ≈ windowSize | MIT | Lo-fi effect only |
| Faust `ef.transpose` | Same class as Tone.PitchShift | No | window | STK/MIT | Same |
| SoundTouchJS (WSOLA) | Good on speech, smeary on polyphonic | No | ~100 ms | LGPL-2.1 / MPL-2.0 | Fallback |
| **Signalsmith Stretch** | Very good, polyphonic | **Yes**: `formantCompensation`, `formantSemitones`, `formantBaseHz` | `latency()`; block ≈120 ms default, "cheaper" preset | **MIT** | **Pick** |
| Rubber Band WASM | Best-in-class, R3 engine | Yes | High | **GPL-2** | Avoid (or sidecar only) |
| pedalboard PitchShift | Rubber Band | Not exposed | offline | GPL-3 | Reference |

- **Vocals:** default to `formantCompensation: true`; this avoids the "chipmunk" sound.
- **Creative "gender" moves:** expose `formant` (semitones) separately.
- **Latency:** report it so other tracks can be compensated, or accept the latency as a send effect.

---

## 6. Recommendation: v1 device set

### 6.1 Devices

| # | id | Logic reference | Implementation | License |
|---|---|---|---|---|
| 1 | `eq` | Channel EQ | Native BiquadFilter ×8; HP and LP cascaded for 24/36/48 dB; curve drawn via `getFrequencyResponse` | — |
| 2 | `comp` | Compressor | **Faust** custom (own gain computer plus STK detector). Fallback: native DynamicsCompressor plus makeup Gain | ours, MIT |
| 3 | `deess` | DeEsser 2 | **Faust** custom (section 4) | ours |
| 4 | `gate` | Noise Gate | **Faust** `ef.gate`-style plus range and hysteresis | STK + ours |
| 5 | `sat` | Overdrive / ChromaGlow / Decapitator | Native WaveShaper (4× oversample, curve families) + pre/post biquads + mix | — |
| 6 | `crush` | Bitcrusher | Tone.BitCrusher (bits) + ~20-line AudioWorklet sample-and-hold (downsample) | MIT + ours |
| 7 | `filter` | AutoFilter | Tone.Filter (−12/−24/−48) + Tone.LFO; envelope mode via Tone.Follower | MIT |
| 8 | `delay` | Tape / Stereo Delay | Native graph: DelayNode ×2, feedback Gain, HP and LP in the loop, WaveShaper in the loop, LFO on delayTime (wow), ping-pong crossfeed | — |
| 9 | `reverb` | ChromaVerb / Space Designer | **Faust** `re.zita_rev1_stereo` + predelay + wet EQ + width | STK |
| 10 | `pitch` | Pitch Shifter | **Signalsmith Stretch** | MIT |
| 11 | `mod` | Chorus / Flanger / Phaser | Tone.Chorus (chorus and flanger modes), Tone.Phaser | MIT |
| 12 | `utility` | Gain / Direction Mixer / Stereo Spread | Native Gain, StereoPanner, M/S matrix (width), LR4 mono-maker, phase flip | — |
| 13 | `limiter` | Limiter / Adaptive Limiter | **Faust** custom lookahead brick-wall (true peak = 4× oversampled detector, v1.1) | ours |

- Suggested vocal chain preset: `gate → eq → deess → comp → sat → delay(send) → reverb(send) → limiter(master)`.
- `crush` is optional in v1.

### 6.2 Knob tables

Columns are id, label, unit, min, max, default and curve. **Curves:** `lin`; `log` (geometric, for Hz, ms and ratio); `db` (linear in dB); `enum`; `bool`.

**eq** — 8 bands. `b{n}` is the prefix for each band. Words: bright, airy, dull, muddy, boxy, harsh, thin, warm, boomy, nasal, presence.

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| hp_on / lp_on | Low Cut / High Cut | bool | | | false | bool |
| hp_freq | Low Cut Freq | Hz | 20 | 2000 | 80 | log |
| hp_slope | Low Cut Slope | dB/oct | 12 | 48 | 24 | enum 12/24/36/48 |
| lp_freq | High Cut Freq | Hz | 1000 | 20000 | 18000 | log |
| lp_slope | High Cut Slope | dB/oct | 12 | 48 | 12 | enum |
| ls_freq / ls_gain | Low Shelf Freq / Gain | Hz / dB | 20 / −24 | 1000 / 24 | 100 / 0 | log / db |
| b{1..4}_freq | Bell n Freq | Hz | 20 | 20000 | 200, 500, 2500, 6000 | log |
| b{1..4}_gain | Bell n Gain | dB | −24 | 24 | 0 | db |
| b{1..4}_q | Bell n Q | — | 0.1 | 18 | 1.0 | log |
| hs_freq / hs_gain | High Shelf Freq / Gain | Hz / dB | 1000 / −24 | 20000 / 24 | 10000 / 0 | log / db |
| out | Output | dB | −24 | 24 | 0 | db |

**comp** — words: punchy, tight, glue, squash, smooth, even, controlled, pumping, "stand out" (with eq presence).

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| style | Style | enum | | | clean | clean / vca / fet / opto (preset attack, release, knee and detector) |
| thresh | Threshold | dB | −60 | 0 | −18 | db |
| ratio | Ratio | :1 | 1 | 20 | 3 | log |
| knee | Knee | dB | 0 | 24 | 6 | lin |
| attack | Attack | ms | 0.1 | 200 | 10 | log |
| release | Release | ms | 10 | 2000 | 120 | log |
| auto_rel | Auto Release | bool | | | false | bool |
| makeup | Makeup | dB | −12 | 24 | 0 | db |
| auto_gain | Auto Gain | bool | | | false | bool |
| sc_hpf | Sidechain HPF | Hz | 20 | 500 | 20 | log |
| detector | Detector | enum | | | peak | peak / rms |
| mix | Mix | % | 0 | 100 | 100 | lin |

Output meter: `gr_db`. It is also reported to the agent as text.

**deess** — words: harsh S, sibilant, spitty, sharp, "too much ess", lisp (negative).

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| freq | Frequency | Hz | 2000 | 16000 | 6500 | log |
| thresh | Threshold | dB | −60 | 0 | −24 | db |
| range | Max Reduction | dB | 0 | 24 | 6 | lin |
| mode | Detection | enum | | | relative | relative / absolute |
| band | Range | enum | | | split | split / wide |
| shape | Filter | enum | | | bandpass | bandpass / highshelf |
| listen | Listen | bool | | | false | bool |

**gate** — words: noisy, hiss, bleed, clean up, tighten tails, choppy (negative).

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| thresh | Threshold | dB | −90 | 0 | −50 | db |
| range | Reduction | dB | −90 | 0 | −40 | db |
| hyst | Hysteresis | dB | 0 | 12 | 3 | lin |
| attack | Attack | ms | 0.1 | 50 | 1 | log |
| hold | Hold | ms | 0 | 500 | 30 | lin |
| release | Release | ms | 5 | 2000 | 100 | log |
| key_hpf / key_lpf | Key Low / High Cut | Hz | 20 / 1000 | 2000 / 20000 | 20 / 20000 | log |

**sat** — words: gritty, warm, dirty, crunchy, fuzzy, tape, tube, saturated, aggressive, analog, "more harmonics".

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| model | Model | enum | | | tape | tape (tanh) / tube (asymmetric) / transistor (hard knee) / fuzz (fold) |
| drive | Drive | dB | 0 | 36 | 6 | lin |
| tone | Tone | Hz | 1000 | 20000 | 12000 | log |
| low_cut | Low Cut (pre) | Hz | 20 | 500 | 20 | log |
| bias | Bias / Asymmetry | — | 0 | 1 | 0 | lin |
| auto_gain | Auto Gain | bool | | | true | bool |
| mix | Mix | % | 0 | 100 | 100 | lin |
| out | Output | dB | −24 | 12 | 0 | db |

**crush** — words: lo-fi, crunchy, retro, 8-bit, broken, digital.

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| bits | Resolution | bit | 1 | 16 | 12 | lin (int) |
| downsample | Downsample | × | 1 | 50 | 1 | log |
| mix | Mix | % | 0 | 100 | 100 | lin |

**filter** — words: dark, muffled, underwater, telephone, sweep, wobble, open up, filtered, radio.

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| type | Type | enum | | | lowpass | lowpass / highpass / bandpass / notch |
| slope | Slope | dB/oct | 12 | 48 | 24 | enum 12/24/48 |
| cutoff | Cutoff | Hz | 20 | 20000 | 20000 | log |
| reso | Resonance (Q) | — | 0.5 | 20 | 0.7 | log |
| lfo_rate | LFO Rate | Hz or note | 0.05 | 20 | 1 | log; tempo-sync option |
| lfo_depth | LFO Depth | oct | 0 | 6 | 0 | lin |
| lfo_shape | LFO Shape | enum | | | sine | sine / triangle / saw / square / random |
| env_amt | Envelope Amount | oct | −6 | 6 | 0 | lin |
| mix | Mix | % | 0 | 100 | 100 | lin |

**delay** — words: echo, slapback, spacey, dub, ping-pong, tape echo, wide, trailing.

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| sync | Sync | bool | | | true | bool |
| time_note | Time (synced) | enum | | | 1/8 | 1/32 … 1/1, dotted, triplet |
| time_ms | Time | ms | 1 | 2000 | 375 | log |
| feedback | Feedback | % | 0 | 110 | 35 | lin (>100 means runaway, a creative option) |
| pingpong | Ping-Pong | bool | | | false | bool |
| low_cut / high_cut | Low / High Cut (loop) | Hz | 20 / 500 | 2000 / 20000 | 150 / 6000 | log |
| sat | Tape Saturation | % | 0 | 100 | 0 | lin |
| wow | Wow / Flutter | % | 0 | 100 | 0 | lin |
| width | Stereo Spread | % | 0 | 100 | 50 | lin |
| mix | Mix | % | 0 | 100 | 25 | lin |

**reverb** (zita_rev1) — words: spacious, roomy, distant, wet, lush, ambient, cathedral, dry (negative), close, intimate.

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| predelay | Predelay | ms | 0 | 200 | 20 | lin |
| decay | Decay (mid T60) | s | 0.2 | 12 | 2.0 | log |
| low_ratio | Low Decay × | × | 0.5 | 2 | 1.2 | log (maps to t60dc = decay × ratio) |
| xover | Low Crossover | Hz | 50 | 1000 | 200 | log |
| damping | Damping (HF decay freq) | Hz | 1500 | 20000 | 6000 | log |
| size | Size | % | 0 | 100 | 50 | lin (scales the zita delay lengths; v1.1; v1 maps it to decay and predelay) |
| low_cut / high_cut | Wet Low / High Cut | Hz | 20 / 1000 | 1000 / 20000 | 200 / 12000 | log |
| width | Width | % | 0 | 150 | 100 | lin |
| mix | Mix | % | 0 | 100 | 20 | lin |

**pitch** (Signalsmith) — words: higher, lower, octave up/down, chipmunk, deep, demonic, detune, thicken (with mix).

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| semis | Semitones | st | −24 | 24 | 0 | lin (int) |
| cents | Cents | ct | −100 | 100 | 0 | lin |
| formant_keep | Keep Formants | bool | | | true | bool |
| formant | Formant Shift | st | −12 | 12 | 0 | lin |
| tonality | Tonality Limit | Hz | 2000 | 16000 | 8000 | log |
| mix | Mix | % | 0 | 100 | 100 | lin |

**mod** — words: chorus, shimmer, wobbly, swirly, jet, thick, doubled, 80s, vintage motion.

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| mode | Mode | enum | | | chorus | chorus / flanger / phaser |
| rate | Rate | Hz | 0.05 | 10 | 0.8 | log |
| depth | Depth | % | 0 | 100 | 50 | lin |
| delay | Delay (chorus/flanger) | ms | 0.5 | 20 | 7 / 2 | log |
| feedback | Feedback | % | −95 | 95 | 0 | lin |
| stages | Stages (phaser) | — | 2 | 12 | 6 | lin (even int) |
| spread | Stereo Phase | ° | 0 | 180 | 90 | lin |
| mix | Mix | % | 0 | 100 | 50 | lin |

**utility** — words: wider, narrower, mono, centered, louder, quieter, flip phase, focus the low end.

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| gain | Gain | dB | −48 | 24 | 0 | db |
| pan | Pan | — | −1 | 1 | 0 | lin |
| width | Width | % | 0 | 200 | 100 | lin (0 = mono, M/S side gain) |
| mono_below | Mono Below | Hz | 20 | 500 | 20 (off) | log |
| phase_l / phase_r | Invert L / R | bool | | | false | bool |
| swap | Swap L/R | bool | | | false | bool |

**limiter** — words: louder, loud, maximize, master, "don't clip", ceiling, punchy (light).

| id | label | unit | min | max | default | curve |
|---|---|---|---|---|---|---|
| gain | Input Gain | dB | 0 | 24 | 0 | db |
| ceiling | Ceiling | dBFS | −12 | 0 | −1 | db |
| release | Release | ms | 1 | 1000 | 60 | log |
| lookahead | Lookahead | ms | 0 | 10 | 5 | lin (reported as latency) |
| true_peak | True Peak | bool | | | false | bool (v1.1) |

### 6.3 Knob catalog JSON: one file that the UI, the agent and the renderer all read

This follows the open decision in `session-plan.md`: adding a device should mean adding data, not code. The implementation binding is `impl.module` plus `params[].target`.

```jsonc
// app/src/core/catalog.schema.json  (JSON Schema 2020-12, abridged)
{
  "$id": "lattice/knob-catalog",
  "type": "object",
  "required": ["version", "devices"],
  "properties": {
    "version": { "type": "integer" },
    "devices": { "type": "array", "items": { "$ref": "#/$defs/device" } }
  },
  "$defs": {
    "device": {
      "type": "object",
      "required": ["id", "label", "category", "impl", "params"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
        "label": { "type": "string" },
        "category": { "enum": ["eq", "dynamics", "saturation", "filter", "delay", "reverb", "pitch", "modulation", "utility"] },
        "logicRef": { "type": "string" },           // "Channel EQ" — for the agent's priors and UI tooltips
        "impl": {
          "type": "object",
          "required": ["kind", "module"],
          "properties": {
            "kind": { "enum": ["native", "tone", "faust", "worklet", "signalsmith", "wam"] },
            "module": { "type": "string" },          // builder id or wasm path
            "license": { "type": "string" },         // SPDX
            "latencyParam": { "type": "string" }     // param whose value adds latency, e.g. "lookahead"
          }
        },
        "params": { "type": "array", "items": { "$ref": "#/$defs/param" } },
        "meters": { "type": "array", "items": { "type": "string" } },   // e.g. ["gr_db"]
        "words": { "type": "array", "items": { "type": "string" } },    // device-level vocabulary
        "presets": { "type": "object", "additionalProperties": { "type": "object" } }
      }
    },
    "param": {
      "type": "object",
      "required": ["id", "label", "type", "default"],
      "properties": {
        "id": { "type": "string" },
        "label": { "type": "string" },
        "type": { "enum": ["float", "int", "enum", "bool"] },
        "unit": { "enum": ["Hz", "dB", "dBFS", "ms", "s", "%", "st", "ct", "oct", ":1", "x", "deg", "bit", "dB/oct", ""] },
        "min": { "type": "number" }, "max": { "type": "number" },
        "default": {},
        "curve": { "enum": ["lin", "log", "db"] },       // UI knob travel and agent "nudge" steps
        "step": { "type": "number" },
        "options": { "type": "array" },                 // for enum params
        "agentRange": { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 }, // sane bounds Muse may set without asking
        "nudge": { "type": "number" },                  // size of "a bit more", in curve space (e.g. 3 dB, 1/3 octave)
        "group": { "type": "string" },                  // UI section, e.g. "band 3"
        "target": { "type": "string" },                 // binding: Faust path "/comp/thresh", Tone prop "filter.frequency", etc.
        "smoothingMs": { "type": "number" },
        "tempoSync": { "type": "boolean" },
        "words": { "type": "array", "items": { "type": "string" } },   // e.g. ["gritty","dirty"] on sat.drive
        "help": { "type": "string" }                    // one line the agent sees
      }
    }
  }
}
```

Example parameter entry:
```json
{ "id": "drive", "label": "Drive", "type": "float", "unit": "dB", "min": 0, "max": 36, "default": 6,
  "curve": "lin", "agentRange": [0, 24], "nudge": 3, "target": "pre.gain",
  "words": ["gritty", "dirty", "crunchy", "saturated", "warm"], "help": "Input gain into the saturator; more = more harmonics" }
```

- Section 6.2 maps directly onto this format.
- The S2 vocabulary layer can live in a sibling `vocab.json` with entries like `{word, sourceTypes, moves: [{device, param, op: set|add|mul, value}]}`. Its `param` ids are checked against the catalog.

---

## 7. Gap list (what we actually have to build)

| # | Item | Size | Notes |
|---|---|---|---|
| 1 | **Faust build pipeline**: `@grame/faustwasm` as a devDependency; script `faust/*.dsp → public/dsp/<id>/{dsp-module.wasm, dsp-meta.json}`; commit the artifacts | S | No runtime compiler shipped. npm install is deferred (disk) |
| 2 | **Faust `comp.dsp`**: detector (peak/RMS, SC HPF), soft-knee gain computer, attack/release (+auto), makeup/auto gain, mix (latency-aligned dry), GR meter output | M | Write our own; the knee versions in the Faust libraries are GPL |
| 3 | **Faust `deess.dsp`** (section 4) | S | |
| 4 | **Faust `gate.dsp`**: range, hysteresis, hold, key filters | S | Base on the `ef.gate_stereo` structure (STK) |
| 5 | **Faust `limiter.dsp`**: lookahead brick-wall; true peak later | S–M | Not `limiter_lad` (GPL) |
| 6 | **Faust `reverb.dsp`**: zita_rev1 + predelay + wet EQ + width + mix | S | |
| 7 | **Device builders** for native/Tone devices: eq (8-band, cascaded slopes, curve), sat (curve families, oversample, auto gain), delay (filtered feedback loop, wow, ping-pong, sync), utility (M/S, mono-maker LR4), filter (LFO + env), mod (flanger mode via Chorus) | M | Graph code only, no new DSP |
| 8 | **Downsample worklet** for crush | XS | |
| 9 | **Signalsmith integration** for pitch: live-input mode per track, latency reporting | S | Check that it runs in an `OfflineAudioContext` [?] |
| 10 | **Parameter layer**: catalog loader, curve mapping (knob 0..1 ↔ value), smoothing (`setTargetAtTime`), enum and bool handling, state in the session model, hand-edit log events | M | Shared by UI and agent |
| 11 | **Offline render**: the same chain builder for `OfflineAudioContext` (module re-registration per context), wired into `useExportWav` and a headless render entry point for the sidecar and tests | M | Replaces pedalboard as the render engine |
| 12 | **Measurement harness**: headless Chromium render → WAV → pytest (band energy, centroid, LUFS, GR) per device | M | S1 "done when" |
| 13 | **Latency compensation** for pitch and limiter lookahead (or a "send-only" rule) | S | |
| 14 | **Knob panel UI** generated from the catalog; GR and level meters via worklet `port` messages and native `reduction` | M | |
| 15 | **Vocabulary map** (S2) on top of the `words` / `nudge` / `agentRange` fields | M | Separate stream |
| 16 | (v2) Airwindows emscripten builds (DeEss, ToTape9, Console) for character; convolution IR set (CC0) for a Space Designer-style device; true-peak limiter; ChromaVerb-style damping EQ | L | Optional |

**Not needed:** pedalboard parity code, Tuna, Csound, RNBO, Rubber Band.

---

## Sources

- Apple Logic Pro for iPad user guide, effects chapters (slugs per section): https://support.apple.com/guide/logicpro-ipad/
- MusicTech, Logic compressor circuit types: https://musictech.com/tutorials/logic-pro/understanding-compressor-circuit-types-in-logic
- FabFilter Pro-C 2 help: https://fabfilter.com/help/pro-c/using/dynamicscontrols and https://fabfilter.com/help/pro-c/using/timecontrols
- FabFilter Pro-DS help: https://www.fabfilter.com/help/pro-ds/using/basiccontrols
- Soundtoys Decapitator manual: https://www.soundtoys.com/wp-content/uploads/Decapitator-Manual.pdf
- ValhallaRoom controls: https://valhalladsp.com/?p=734 ; VintageVerb review: https://musicradar.com/reviews/tech/valhalladsp-vintageverb-574692
- pedalboard type stubs: https://raw.githubusercontent.com/spotify/pedalboard/master/pedalboard_native/__init__.pyi ; docs (v0.9.26): https://spotify.github.io/pedalboard/reference/pedalboard.html
- Tone.js: https://github.com/Tonejs/Tone.js (source read from `app/node_modules/tone@15.1.22`)
- waveform-playlist: https://github.com/naomiaro/waveform-playlist (types and bundle read from `app/node_modules/@waveform-playlist/browser@16.0.0`)
- Tuna node reference: https://github.com/Theodeus/tuna/wiki/Node-examples
- Faust libraries (license declarations read from source): https://github.com/grame-cncm/faustlibraries ; faustwasm: https://github.com/grame-cncm/faustwasm
- WAM community index: https://www.webaudiomodules.com/community/plugins.json ; https://github.com/boourns/wam-community
- Elementary (dynamics source): https://github.com/elemaudio/elementary
- Airwindows: https://github.com/airwindows/airwindows ; airwin2rack: https://github.com/baconpaul/airwin2rack
- Signalsmith Stretch (npm README): https://www.npmjs.com/package/signalsmith-stretch
- RNBO export licensing: https://support.cycling74.com/hc/en-us/articles/10730031661587
- Licenses and versions: GitHub REST API (`/repos/...`) and the npm registry, queried 2026-10-26
