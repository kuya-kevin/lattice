# Spike K: source prep sidecar (voice note → isolated parts → MIDI)

The "Source prep (sidecar)" box of `docs/architecture.md` diagram B, built on the spike J results.
Lattice calls it through the `extract_midi` tool (see "App wiring" below).

```
voice note (wav / m4a)
  └─ load, mono 44.1 kHz, (--denoise: spectral gating from the quietest 0.5 s)
  └─ analyse: percussive ratio (HPSS), pyin voiced fraction, beat-tracker BPM
       ├─ percussive + unvoiced ─────────────────────────────────────→ drums (no separation)
       ├─ pyin clarity ≥ 0.5 (solo voice, whistle) → hum: noisereduce ──→ pyin (no separation)
       └─ Meta Demucs htdemucs_6s (sep env, MIT)
            vocal share > 0.7 → hum: noisereduce ──→ pyin
            vocal share < 0.2 → instrument:
                 bass stem ≥ 0.6 of the rest → bass: bass stem ──→ pyin
                 else                        → keys: stays audio
            otherwise → layered:
                 vocals ───────────────→ melody: pyin
                 bass ─────────────────→ bass: pyin
                 piano+guitar+other (summed) → keys: stays audio (pyin if one clear line)
                 drums (only if the mix is percussive) → onset drum detector
  └─ one tempo for the note: 1/8-grid fit of all onsets (+ beat-tracker hint), with a confidence
  └─ cleanup per stem (cleanup.py): range limits → octave fix (melody) → confidence/velocity
     pruning → merge split notes (melody) / overlapping duplicates (bass) → mono overlap
     resolution (melody, bass) → min length → stray notes (melody) → key detect + snap rare out-of-key notes →
     quantize (grid, strength) only when tempo confidence ≥ 0.45 (or --bpm / --always-quantize)
  └─ midi/<stem>.mid (+ .raw.mid), stems/*.wav, manifest.json
```

Demucs is the only model. Since Nov 1 every other model is gone from this folder (hackathon rule:
Meta models only at runtime). Results from before then are kept below as history.

## Run

```bash
export LATTICE_BIGDISK=<bigdisk>
spikes/k_source_prep/run.sh <in audio> <out_dir> [--mode auto|hum|keys|bass|drums|layered]
    [--separate auto|none] [--denoise] [--grid off|1/4|1/8|1/8T|1/16|1/16T|1/32]
    [--strength 0-1] [--bpm N] [--always-quantize] [--no-key-snap] [--min-len S]
```

`run.sh` runs `prep.py` in the j_evals `amt` env; separation (`separate.py`) runs in the `sep` env as
a separate process. It prints `MANIFEST <path>` last. Manifest schema: see `prep.py`.

| Script | Env | What it does |
|---|---|---|
| `prep.py` / `run.sh` | amt | the sidecar CLI (above) |
| `engineer.py` / `run_engineer.sh` | sep | `cleanup_noise`, `quantize_drums`, `split_stems`, drum hits, sound regions |
| `test_cleanup.py` | amt | known-answer test for the stray-note filter |
| `cleanup.py` | any (numpy) | note cleanup, key detection, tempo estimate, quantize |
| `drums.py` | amt | onset drum/beatbox → kick 36 / snare 38 / hat 42 (multi-label per onset) |
| `transcribers.py` | amt | pyin |
| `separate.py` | sep | Demucs htdemucs_6s on one file |
| `run_synth.py` | amt | prep.py on the 16 synthetic phone clips, one log line per clip |
| `score_cleanup.py`, `drum_eval.py`, `renders.py` | amt | scoring and listening renders |

## Results, Meta-only route (2026-11-01)

Note F1 at onset ±50 ms on the same 16 synthetic phone clips. The router picked a sensible category
on 16/16. Solo voice and whistle use noisereduce (the `cleanup_noise` step) then pyin, with no Demucs.
Demucs output varies a little from run to run, so its rows can move by about 0.03.

| category | route | F1 | before Nov 1 |
|---|---|---|---|
| hum | noisereduce → pyin | 0.67 | 0.84 |
| bass | Demucs bass → pyin | 0.91 | 0.97 |
| keys | stays audio | no MIDI | 0.90 |
| layered → hum | Demucs vocals → pyin | 0.81 | 0.89 |
| layered → bass | Demucs bass → pyin | 0.81 | 0.96 |
| layered → keys | stays audio | no MIDI | 0.68 |

- The hum average understates the result: `hum_2` scores 0.00 with the right pitches, because every
  note lands about 60 ms late, past the ±50 ms window. The other three score 0.77, 0.95 and 0.95.
- Bass reads better from the Demucs stem (0.89-0.91) than from the recording (0.81).
- On hums, noisereduce → pyin tied the Demucs vocal stem → pyin on three clips and beat it on the whistle (0.95 vs 0.52).
- pyin clarity can't tell a low bass from chords (both under 0.27), so the bass stem's share decides
  first (0.92-0.96 on bass clips, at most 0.58 elsewhere).
- Demucs takes about 7 s on a 20 s clip on the Mac. A whole run takes about 12 s for a solo voice, 16 s for bass or keys, 25 s for layers.
- A real acapella with room noise (18.9 s, pyin clarity 0.67) routed to `hum`: 51 notes, B2-A3, in 12 s.
  noisereduce took its noise floor from -37.7 to -62.9 dB; the Demucs vocal stem stayed at -37.8 dB.
  The two routes name the same pitch wherever both have a note. Whether the notes are right is for the ear to judge.

## History: results with non-Meta models (2026-10-27)

### Cleanup on the synthetic phone set (mir_eval note F1, onset ±50 ms, 4 clips per row)

Full sidecar (router + cleanup) on the 16 phone clips:

| category | router picks | raw | after cleanup | + 1/16 quantize (est. tempo) |
|---|---|---|---|---|
| hum | Mel-RoFormer vocals → pyin | 0.60 | 0.62 | 0.67 |
| bass | basic-pitch | 0.83 | 0.96 | 0.98 |
| keys | basic-pitch | 0.79 | 0.79 | 0.79 |
| layered → hum | Mel-RoFormer vocals → basic-pitch | 0.77 | 0.88 | 0.89 |
| layered → bass | htdemucs bass → basic-pitch | 0.79 | 0.87 | 0.89 |
| layered → keys | htdemucs piano+guitar+other summed → basic-pitch | 0.58 | 0.58 | 0.59 |

Layered keys stays weak: YourMT3+ on the htdemucs piano stem gets 0.70 (opt-in, needs the GPU).
Summing piano+other costs ~0.03 against the piano stem alone, but stops one piano part from
coming out as two duplicate tracks (seen on voice note 145).

The router picked the right category for 16/16 clips. The tempo estimate matched the true tempo on
16/16 clips (within 0.25%; confidence 0.53-0.90). Cleanup on yesterday's predictions per
transcriber is in `<bigdisk>/out-k/cleanup_f1.md`. Highlights: basic-pitch bass 0.84 → 0.97
(mono resolution removes its octave overtones), basic-pitch hum 0.36 → 0.71, YourMT3+ keys
0.90 → 0.91, Mel-RoFormer vocals → basic-pitch in a layered mix 0.78 → 0.90.

What the ablation showed (and the defaults now follow):
- Merging same-pitch notes split by a short gap is essential for hum (basic-pitch 0.37 → 0.64)
  but wrecks keys and bass, whose repeated chords/notes are real re-attacks (keys 0.78 → 0.64).
  So: merge for melodies only; bass/keys merge only overlapping duplicates.
- The octave fix helps nothing on hum and costs 0.17 on bass (bass lines jump octaves on purpose):
  melodies only.
- Cleanup hurts YourMT3+ on hum (0.47 → 0.37); the router never sends hum to YourMT3+.

### MuScriptor medium as the transcriber (Oct 27, default since)

`--transcriber muscriptor` (default) sends the pitched stems to MuScriptor medium in a separate
process (j_evals `muscriptor` env, about 2.3 GB VRAM), except a layered note's melody, which stays
on basic-pitch. `--transcriber classic` is the table above. A stem falls back to classic, with a
warning, when MuScriptor fails, isn't installed, has < 3 GB free VRAM, or finds no notes.
Same 16 phone clips, after cleanup + quantize (`run_synth.py`, `score_cleanup.py synth synth_muscriptor`):

| category | classic | MuScriptor sidecar |
|---|---|---|
| hum | 0.67 | **0.84** |
| bass | **0.98** | 0.97 |
| keys | 0.79 | **0.90** |
| layered → hum | **0.89** (basic-pitch, kept) | 0.89 |
| layered → bass | 0.89 | **0.96** |
| layered → keys | 0.59 | **0.68** |

- **Hum goes in whole.** On the Mel-RoFormer vocal stem MuScriptor's onsets came 70-80 ms late on
  2 of 4 clips (F1 0.00 at ±50 ms) or it heard nothing. On the raw recording the lag is under 11 ms
  and hum averages 0.84 (vs 0.42 from the stem).
- **The cleanup barely matters for MuScriptor.** Raw is equal or slightly better (keys 0.93 raw vs
  0.90 after); it stays for key snap and quantize. On one clip the melody octave fix kept the wrong
  octave of a doubled note.
- htdemucs stems vary slightly from run to run, so MuScriptor note counts on layered real notes
  change between runs (e.g. vn_112 keys 343 vs 456). MuScriptor itself is deterministic (greedy).
- Real voice notes (all 9) ran clean through `run.sh` in 10-42 s each. The listening page is
  `<bigdisk>/out-k/listen_compare/index.html`; the user judged the new output good (Oct 27).
- On the Mac the weights go wherever `LATTICE_BIGDISK` points (`$LATTICE_BIGDISK/hf/`); setup steps
  are in `docs/backlog.md` B3a.

### Drums (`drum_eval.py`, 6 synthetic GM-kit clips, phone-degraded)

Onset F1 0.94; per class kick 0.73, snare 0.56, hat 0.89. The thresholds were tuned on these
same clips, so this is optimistic, and a GM kit is not a beatbox.

### Real voice notes

See the session report; renders are in `<bigdisk>/out-k/listen/<clip>/` (`all.wav`, `ab__*.wav`
with the render left and the input right, `notes.txt`). Most real notes are played in free time
(tempo confidence 0.11-0.40), so they are left unquantized; quantize them in Lattice at the
session tempo (`quantize_midi`).

## App wiring

- `app/src/node/sourcePrep.ts` spawns `run.sh` (Electron main via IPC `source:put` + the
  `AppSidecar.extractMidi`; dev:web via the Vite middleware `POST /api/sidecar/extract-midi`).
  Work files go to `$LATTICE_SIDECAR_WORK`, else `<bigdisk>/out-k/app`, else the OS temp dir.
  `$LATTICE_SIDECAR_MOCK=<manifest.json>` returns a fixture instead (e2e tests).
- The renderer uploads each source as a mono WAV (`Bridge.putSourceAudio`) when it loads, so Muse
  can call `extract_midi` too.
- `extract_midi` adds one MIDI track per stem, aligned with the audio clip, and sets the session
  tempo/key when the note was quantized and the session has nothing else. `quantize_midi`
  quantizes at the session tempo. MIDI clips (`Clip.midi`) play through a built-in offline synth
  (one piano-like voice, a synthesized kit for drums), rendered to an AudioBuffer.

## Licences

htdemucs_6s (MIT), pyin/librosa (ISC), noisereduce (MIT), audio-separator (MIT, runs Demucs).
