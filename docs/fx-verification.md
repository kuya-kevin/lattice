# Effects engine: verification

Written 2026-10-27 (S1). Spec: `docs/plugin-catalog.md`. This page covers how the 13 devices are built and how each one is checked against a published reference, with the measured numbers.

## 1. How it is built

- **One catalog.** `app/src/fx/catalog.json` holds the knobs for all 13 devices: id, unit, range, default, curve, `agentRange`, `nudge`, `words` and binding `target`.
  - Schema: `catalog.schema.json`. Loader and types: `catalog.ts`. Seed word-to-move map for S2: `vocab.json`.
  - The UI, the agent tools and the renderer all read this one file. A vitest test checks that `vocab.json` only names real params with legal values.
- **One chain builder.** `ChainHost` (`app/src/fx/engine/host.ts`) builds a track's insert chain between a fixed input and output.
  - Live, it is inserted by waveform-playlist's per-track `effects(graphEnd, destination)` hook (`engine/live.ts`).
  - Offline, the same class runs in an `OfflineAudioContext` (`engine/render.ts`: `renderChain`, `renderTrack`, `encodeWav`).
  - Value changes call `update()`. Params flagged `rebuild` (filter type, EQ slope, mod mode) rebuild only that device.
- **Session model.** `Track.devices: DeviceInstance[]` stores the chain and every knob value.
  - Tools: `list_devices`, `insert_device`, `set_param` (ops set/add/mul/nudge), `remove_device`, `bypass_device` and `move_device` (`app/src/fx/tools.ts`).
  - Values are clamped to the catalog ranges. Muse is also held to each knob's `agentRange`, and the result tells it to ask the user before going further.
  - UI knob moves go through the same tools, so `runTool` logs them as hand edits. `summarize()` shows each chain to Muse as text.
- **Native AudioContext.** `main.tsx` calls `configureGlobalContext({ nativeAudioContext: true })`, so native and AudioWorklet nodes can be spliced into waveform-playlist's Tone graph. waveform-playlist supports this mode.

### Per device: native or Faust

| id | Implementation | Source / license |
|---|---|---|
| utility | Native: 2x2 gain matrix (M/S width, phase, swap), StereoPanner, LR4 mono-maker | ours, MIT |
| eq | Native BiquadFilter: Butterworth HP/LP cascades 12–48 dB/oct, RBJ shelves and 4 bells | ours, MIT |
| comp | **Faust** `comp.dsp`: our own Giannoulis soft-knee gain computer, branching smoother, peak/RMS, SC HPF, auto release, auto gain, mix, GR meter | ours, MIT (no GPL compressors.lib code) |
| deess | **Faust** `deess.dsp`: SVF band or LR4 high band detector, relative/absolute, split/wide, listen | ours + STK-4.3 filters |
| gate | **Faust** `gate.dsp`: Schmitt trigger (hysteresis), hold counter, dB-domain attack/release, key HP/LP | ours + STK-4.3 filters |
| limiter | **Faust** `limiter.dsp`: lookahead brick-wall (sliding max of reduction + moving average + upward-only release) | ours, MIT (no `limiter_lad`) |
| sat | Native WaveShaper, 4x oversampled; tape/tube/transistor/fuzz curves with drive folded in; pre-HP, DC blocker, tone LP, auto gain, latency-aligned dry/wet | ours, MIT |
| filter | Native biquad cascade (exact Butterworth at reso 0.707), LFO and envelope follower on `detune` (exponential) | ours, MIT |
| delay | Native: main tap + loop delay compensated for the browser's 128-frame cycle delay, HP/LP/soft clip in the loop, ping-pong, spread, wow/flutter, sync | ours, MIT |
| reverb | **Faust** `reverb.dsp`: `re.zita_rev1_stereo` + our predelay, wet EQ, M/S width, mix | STK-4.3 + ours |
| pitch | **Signalsmith Stretch** 1.3.2 (vendored `.mjs`, WASM worklet); dry path delayed by `latency()` | MIT |
| mod | Native: chorus/flanger (modulated delay + feedback, phase-offset R LFO), phaser (allpass cascade on `detune`) | ours, MIT |
| crush | Own AudioWorklet (`engine/worklets.js`): quantizer + sample-and-hold | ours, MIT |

**Faust pipeline:**
- `app/scripts/build-faust.mjs` compiles `src/fx/faust/*.dsp` ahead of time with `@grame/faustwasm` 0.19.1 (`-lang wasm-i`, single precision, `-ftz 2`). Point `FAUSTWASM_DIR` at an install of it; it is not an app dependency.
- Output goes to `src/fx/faust/build/<id>.{wasm,json}`, plus `wasm.ts`, a base64 copy. Each module is 7–19 KB.
- The runtime is our own ~100-line host (`engine/worklets.js`, processor `lattice-faust`), not the faustwasm runtime. The libfaust compiler never ships.
- Only permissive library functions are used: STK-4.3 filters and `zita_rev1`, plus GRAME-LGPL-with-exception `basics`/`delays` helpers.
- The same worklet file runs the Faust devices in vitest, in Node.

## 2. How to run the verification

```
FX_OUT=<out dir> LATTICE_DATA=<repo>/data spikes/fx_verify/run.sh
```

The script runs three steps:
1. `spikes/fx_verify/signals.py` writes the test signals and `cases.json` (142 cases).
2. `app/e2e-fx/render.spec.ts` (`playwright.fx.config.ts`, port 5180) renders every case through the real engine in headless Chromium at 48 kHz. All 142 renders take 4.8 s.
3. `spikes/fx_verify/test_fx.py` (pytest) measures the renders and writes `$FX_OUT/results.{md,json}`.

The references are computed independently in `measure.py`: RBJ coefficients, Butterworth Qs, the Giannoulis static curve, Schroeder integration and BS.1770 K-weighting.

**Result (2026-10-27):** 68 passed, 2 xfailed (a known pitch gap, section 4). App tests: vitest 45, e2e smoke + shortcuts 9, plus `e2e/fx-panel.spec.ts`.

## 3. Results

Rows marked "info" are reported but not asserted. The full table, with every case, is `$FX_OUT/results.md`.

| Device | Check (reference) | Reference | Measured | Tolerance |
|---|---|---|---|---|
| utility | gain −6 / +12 dB | −6.00 / +12.00 | −6.000 / +12.000 | ±0.01 dB |
| utility | M/S width 0/50/150/200 %: side gain (mid unchanged) | −∞ / −6.02 / +3.52 / +6.02 dB | −582 / −6.02 / +3.52 / +6.02 (mid ±0.000) | ±0.01 dB |
| utility | mono below 200 Hz: side at 100 Hz / 2 kHz (LR4 = Butterworth-2 squared) | −24.61 / 0 dB | −24.61 / −0.001 | ±0.5 / ±0.05 dB |
| utility | phase L + swap; pan hard left (W3C StereoPanner) | exact | error 0; R = −600 dB | < 1e-6 |
| eq | 4 bells, 2 shelves, output gain vs RBJ cookbook | 0 dB error | max 0.0014 dB | ±0.25 dB |
| eq | HP 100 Hz 12/24/48 dB/oct, LP 5 kHz 36 dB/oct vs RBJ Butterworth cascades (where H_ref > −40 dB) | 0 dB | 0.039 / 0.049 / 0.21 / 0.00001 dB | ±0.25 dB |
| eq | \|H(fc)\| for all HP/LP slopes | −3.01 dB | −3.009 to −3.011 | ±0.1 dB |
| eq | vocal combo (HP 24 + 2 bells + high shelf) | 0 dB | 0.062 dB | ±0.25 dB |
| filter | LP 1k/24, HP 500/12, LP 2k/48, BP 1k Q2, LP 1k Q4 vs RBJ | 0 dB | ≤ 0.006 dB | ±0.25 dB |
| filter | LFO 1 Hz, 2 oct: centroid modulation rate; max/min | 1.0 Hz; > 2 | 0.99 Hz; 14.5 | ±0.1 Hz |
| comp | static curve, −60…0 dB, T −24 R 4 knee 0 / knee 12; T −30 R 20 (Giannoulis 2012 eq. 4) | 0 dB error | ≤ 0.00008 dB | ±0.1 dB |
| comp | attack / release time constants (63 %), 10/200 ms and 1/50 ms | 10 / 200; 1 / 50 ms | 10.0 / 199.8; 1.0 / 50.0 | ±5 % |
| comp | steady GR at −10 dBFS; makeup +6 with mix 50 % | 10.5 dB; −1.962 dB | 10.50; −1.962 | ±0.05 dB |
| limiter | sample peak at gain +12/+18/+9 (ceiling −1/−3/−1) | ≤ ceiling | −1.000 / −3.000 / −1.000 | +0.01 dB |
| limiter | latency at lookahead 5 ms; unity gain below ceiling | 240 samples; 1 | 240; 1.000 | exact; ±1e-5 |
| limiter | true peak 4x (BS.1770), info | ceiling | −0.40 / −1.81 / +1.45 dBTP | info: true peak is v1.1 |
| gate | attenuation when closed, range −40 | 40 dB | 39.98 | ±0.1 dB |
| gate | hysteresis: −52 dBFS after open (thresh −50, hyst 3) stays open; −56 closes | 0 / 40 dB | 0.00 / 39.98 | ±0.1 dB |
| gate | attack 5 ms, hold 100 ms, release 50 ms (dB domain) | 5 / 100 / 50 ms | 5.00 / 99.99 / 49.99 | ±5 %, ±1 ms |
| deess | synthetic vowel + "s" bursts, range 9: band-centre reduction on "s" (split / wide / high-shelf) | ≈ 9 dB | 8.43 / 8.99 / 7.32 | 7 to 9.5 dB |
| deess | same: level change on vowels | 0 dB | −0.0001 / −0.04 / −0.000002 | ±0.5 dB |
| deess | range 0: output equals input (notch + band sums to input) | 0 | 0 | < 1e-5 |
| deess | real sibilant takes (Freesound 39913, 435156): 5–10 kHz reduction on sibilant frames | > 2 dB | 3.87 / 4.66 | > 2 dB |
| deess | same: change on non-sibilant frames | 0 dB | −0.0003 / −0.034 | ±0.5 dB |
| sat | THD (h2–h15) of a −12 dBFS 1 kHz sine at drive 0/6/12/24/36 dB vs the same curve in numpy (8x oversampled), tape | −45.2 / −33.6 / −23.0 / −10.1 / −7.0 dB | −45.2 / −33.6 / −23.0 / −10.1 / −7.0 | ±1 dB |
| sat | same for tube / transistor / fuzz (15 cases) | — | all within 0.09 dB of the reference | ±1 dB |
| sat | auto gain level change; mix 50 % wet/dry alignment | 0 dB; lag 0 | −0.014 dB; lag 0, null −152 dB | ±0.3 dB |
| sat | even harmonics: biased tube h2 vs symmetric tape h2 | > −40 / < −80 dBc | −19.7 / −86.6 dBc | — |
| delay | echo times 250 ms (free), 1/8 at 120 BPM, dotted 1/8 at 100 BPM | 250/500/750; 450/900/1350 ms | exact (±0 samples) | ±1 sample |
| delay | echo-to-echo ratio at feedback 50 % / 30 % (J.O. Smith, feedback comb) | −6.02 / −10.46 dB | −6.021 / −10.46 | ±0.1 dB |
| delay | ping-pong sides; spread 50 % R offset; feedback 110 % stays bounded | L,R,L; 360 samples; finite | L,R,L; 360; peak 1.76 | — |
| reverb | RT60 (T30, 1 kHz octave, Schroeder integration) at decay 0.5/1/2/4 s | 0.5 / 1 / 2 / 4 s | 0.496 / 1.08 / 2.02 / 4.09 | ±15 % |
| reverb | broadband T30, info | — | 0.38 / 0.90 / 1.74 / 3.57 s | info |
| reverb | predelay 50 / 120 ms (onset shift) | 50 / 120 ms | 50.0 / 120.0 | ±0.1 ms |
| reverb | damping 3 kHz: RT60(8k)/RT60(1k); width 0: side/mid | < 0.75; −∞ | 0.43; −540 dB | — |
| pitch | 440 Hz sine, +7 / +3 st 37 ct / +12 / −5 st −20 ct, formants off & on | 0 ct | −0.13 … +3.7 ct | ±5 ct |
| pitch | 440 Hz sine, −12 st (output 220 Hz) | 0 ct | +6.6 ct (xfail, section 4) | ±5 ct |
| pitch | 220 Hz harmonic tone, −12 / −7 / +5 / +12 st (harmonic-comb f0) | 0 ct | +1.2 / +0.7 / +0.65 / +0.2 ct | ±5 ct |
| mod | chorus 1 Hz, depth 50 %, 7 ms: peak FM deviation, f0·2π·rate·depth·delay (Dattorro 1997 part 2) | 21.99 Hz | 22.01 Hz | ±10 % |
| mod | phaser at mix 100 %: energy change (allpass cascade is lossless) | 0 dB | +0.0006 dB | ±0.2 dB |
| mod | flanger mix 50 %, fb 50 %: comb notch depth | > 12 dB | 17.1 dB | — |
| crush | SNR at 4/8/12 bit vs 6.02N + 1.76 dB (input −0.5 dBFS) | 25.3 / 49.4 / 73.5 dB | 24.6 / 49.4 / 73.5 | ±3 / ±1.5 dB |
| crush | downsample x4: fraction of held samples | 0.75 | 0.750 | ±0.01 |
| chain | gate → eq → deess → comp → sat → delay → reverb → limiter on a real vocal | peak ≤ −1 dBFS | −9.4 dBFS, −24.4 LUFS | — |

A note on what "agreement" means for the native devices:
- EQ and filter run on the browser's own biquads, which follow the RBJ cookbook.
- These checks therefore prove our parameter wiring, not the browser's DSP: Butterworth section Qs, Web Audio's Q-in-dB for low-pass and high-pass, cascade order, and gain staging.

## 4. Known gaps and limits

- **Pitch on pure low tones.** Signalsmith Stretch on a pure sine lands +5 to +16 ct sharp when the *output* is below about 250 Hz.
  - Example: 440 Hz shifted −12 st reads +6.6 ct, and 220 Hz shifted −7 st reads +16 ct.
  - A 240 ms block (`configure({blockMs})`) did not fix it.
  - Harmonic material is accurate within 1.2 ct, measured on the harmonic comb. Real voices and instruments behave like that case.
- **Formant compensation drops the level of pure tones** (+12 st: −8.5 dB). The other info rows show −0.6 to −2.9 dB.
- **Limiter is sample-peak only.** True peak overshoots by up to 2.5 dB on noise bursts (BS.1770 4x). The `true_peak` knob is accepted but does nothing until v1.1 (oversampled detector).
- **zita-rev1 broadband T30** is 10–25 % below the nominal decay. The 1 kHz octave value tracks the knob within 8 %. Decay is specified as the mid-band T60, as in zita.
- **Feedback inside one native graph** carries a 128-frame minimum loop delay (Web Audio cycle rule).
  - The delay compensates for it: it measures the extra delay at startup.
  - The flanger cannot: with feedback, its effective loop is at least 2.67 ms.
  - The phaser has no feedback in v1.
- **No latency compensation across tracks.** The limiter lookahead and pitch latency are reported in the panel and in `chainView`, but other tracks are not delayed to match.
- **waveform-playlist WAV export.** `useExportWav` renders through Tone's own offline context, which is not native, so our hook plays dry there and warns. Use `renderTrack` for agent and sidecar renders. The app has no export button yet.
- **Comp auto release is a heuristic.** Release scales from 0.3x to 1.7x with the 1-second average gain reduction. Auto gain adds half the reduction a 0 dBFS signal would get.
- **Size, Stereo Spread, flanger/phaser modes and the de-esser's "Relative" threshold** are not checked against Logic numerically. The Logic ranges in the catalog stay approximate (see plugin-catalog.md).

## 5. Optional Logic "golden bounce" (on the Mac)

`signals.py` also writes 24-bit copies of every test signal to `$FX_OUT/golden/` (17 files).

1. In Logic at 48 kHz, put `golden/<signal>.wav` on an audio track.
2. Insert the matching stock plugin with the settings of a case in `cases.json`:
   - `eq_*`: Channel EQ
   - `comp_*`: Compressor, Platinum Digital
   - `limiter_*`: Limiter, Precision
   - `gate_*`: Noise Gate
   - `deess_*`: DeEsser 2
   - `delay_*`: Stereo Delay
   - `sat_*`: Overdrive or ChromaGlow (character, not identical curves)
3. Bounce in place to `$FX_OUT/logic/<case>.wav`.
4. Run `uv run python fx_verify/compare_golden.py`. Per case it reports alignment lag, level difference, null depth and the worst 1/3-octave shape difference.

Expect close nulls for EQ, for delay timing and for the gate and limiter levels. Expect only "similar shape" for compressor character, saturation and reverb.

## References (checked 2026-10-27)

- R. Bristow-Johnson, *Cookbook formulae for audio EQ biquad filter coefficients* (as adopted in the W3C Web Audio API, BiquadFilterNode).
- D. Giannoulis, M. Massberg, J. D. Reiss, "Digital Dynamic Range Compressor Design: A Tutorial and Analysis", *J. Audio Eng. Soc.* 60(6), 399–408, 2012.
- J. Dattorro, "Effect Design, Part 1: Reverberator and Other Filters", *JAES* 45(9), 660–684, 1997, and "Part 2: Delay-Line Modulation and Chorus", *JAES* 45(10), 764–788, 1997.
- U. Zölzer (ed.), *DAFX: Digital Audio Effects*, 2nd ed., Wiley, 2011 (ch. 2 delays and modulation, ch. 4 dynamics and nonlinear processing).
- W. Pirkle, *Designing Audio Effect Plugins in C++*, 2nd ed., Routledge/Focal Press, 2019.
- J. D. Reiss, A. P. McPherson, *Audio Effects: Theory, Implementation and Application*, CRC Press, 2014.
- J. O. Smith III, *Physical Audio Signal Processing* and *Introduction to Digital Filters*, CCRMA, online books (feedback comb filters, Butterworth sections, zita-rev1 notes).
- V. Zavalishin, *The Art of VA Filter Design*, rev. 2.1.0, Native Instruments, 2018 (trapezoidal SVF behind `fi.svf`).
- M. R. Schroeder, "New Method of Measuring Reverberation Time", *JASA* 37(3), 409–412, 1965. ISO 3382-1:2009 (T30).
- S. H. Linkwitz, "Active Crossover Networks for Noncoincident Drivers", *JAES* 24(1), 2–8, 1976 (LR4).
- ITU-R BS.1770-5 (11/2023), loudness and true peak. EBU R 128 v4 (2020); v5 (2023) only adds references.
- Signalsmith Stretch (MIT): https://signalsmith-audio.co.uk/code/stretch/ . Faust libraries: https://github.com/grame-cncm/faustlibraries .
