"""Source prep sidecar: voice note -> (denoise) -> stems -> per-stem transcriber -> cleanup -> MIDI + manifest.

    spikes/k_source_prep/run.sh <in audio> <out_dir> [options]       # = env.sh amt python prep.py ...

Options (all optional):
  --mode auto|hum|keys|bass|drums|layered   what the recording is (auto: decided from the audio)
  --separate auto|none                       auto: htdemucs_6s (Meta Demucs, MIT), except for drums and a solo voice
  --denoise                                  spectral gating before everything (profile: quietest 0.5 s)
  --grid off|1/4|1/8|1/8T|1/16|1/16T|1/32    quantize grid (default 1/16)
  --strength 0-1                             quantize strength (default 1)
  --bpm N                                    use this tempo instead of estimating one
  --always-quantize                          quantize even when the tempo estimate is unsure (< 0.45)
  --no-key-snap                              keep out-of-key notes
  --min-len S                                minimum note length in seconds

The only model here is Demucs. A solo voice or whistle skips it: noisereduce (engineer.py, the same
cleanup as cleanup_noise), then pyin. Other single lines come from their Demucs stem through pyin,
and drums through onset detection (all DSP). Meta has no chord transcription model, so a chordal part keeps its Demucs stem as audio:
its manifest entry has `audio_only: true`, no notes and no MIDI.

Writes <out_dir>/manifest.json (schema below), <out_dir>/midi/<stem>.mid (cleaned) and
<stem>.raw.mid, <out_dir>/stems/*.wav, <out_dir>/input.wav (mono 44.1 kHz). Prints one line
`MANIFEST <path>` at the end, which the app's bridge looks for.

Manifest (version 1):
  {version, input, duration, mode, content, analysis{...}, tempo{bpm, offset, confidence, source},
   key{name, tonic, mode, r} | null, settings{...}, separation[...], warnings[...], timing{...},
   stems: [{name, role, instrument, is_drum, audio, transcriber, midi, raw_midi, raw_notes,
            notes_count, range, confidence, cleanup{...}, notes: [{pitch, start, end, velocity}]},
           ...or {name, role, instrument, is_drum, audio, transcriber: "none", audio_only: true, midi: null,
                  raw_midi: null, raw_notes: 0, notes_count: 0, range: null, confidence: 0, notes: []}]}
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import pretty_midi
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cleanup as C  # noqa: E402
import drums as D  # noqa: E402
import transcribers as T  # noqa: E402

ENV_SH = HERE.parent / "j_evals" / "env.sh"
SR = 44100
# Below this tempo confidence the notes are not quantized (synthetic set at a steady tempo:
# 0.53-0.90; free-time real voice notes: 0.11-0.40).
MIN_TEMPO_CONF = 0.45
# Router thresholds, measured on the 16 synthetic phone clips (spikes/k_source_prep/README.md).
VOCAL_HUM = 0.7  # htdemucs vocal share of the energy above this: only a hum
VOCAL_INSTRUMENT = 0.2  # below this: no voice
BASS_STEM = 0.6  # htdemucs bass stem's share of the non-vocal energy above this: a bass (clips 0.92-0.96, others < 0.6)
LINE_CLARITY = 0.5  # line_stats clarity at or above this: one line, not chords (hums and whistles 0.61-0.75, chords and mixes < 0.27)


def _np(o):
    return o.item() if hasattr(o, "item") else str(o)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- audio


def load_audio(path: str, sr: int = SR) -> np.ndarray:
    try:
        y, file_sr = sf.read(path, dtype="float32", always_2d=True)
        y = y.mean(axis=1)
    except Exception:  # m4a/aac/mp3: decode with PyAV (no system ffmpeg here)
        import av
        chunks = []
        with av.open(path) as c:
            file_sr = c.streams.audio[0].rate
            for fr in c.decode(audio=0):
                a = fr.to_ndarray()
                chunks.append(a.mean(axis=0) if a.ndim == 2 else a)
        y = np.concatenate(chunks).astype(np.float32)
    if file_sr != sr:
        y = librosa.resample(y, orig_sr=file_sr, target_sr=sr)
    return y


def denoise(y: np.ndarray, sr: int, seconds: float = 0.5, reduce_db: float = 18) -> np.ndarray:
    """Stationary spectral gating (the noisereduce idea): noise profile from the quietest window."""
    from scipy.signal import istft, stft
    w = int(seconds * sr)
    hop = max(w // 4, 1)
    if len(y) < 2 * w:
        return y
    energy = [np.mean(y[i : i + w] ** 2) for i in range(0, len(y) - w, hop)]
    s = int(np.argmin(energy)) * hop
    _, _, N = stft(y[s : s + w], fs=sr, nperseg=2048)
    noise = np.mean(np.abs(N), axis=1, keepdims=True)
    std = np.std(np.abs(N), axis=1, keepdims=True)
    _, _, Z = stft(y, fs=sr, nperseg=2048)
    mag = np.abs(Z)
    thresh = noise + 1.5 * std
    mask = np.clip((mag - thresh) / (thresh + 1e-9), 0, 1)
    from scipy.ndimage import uniform_filter
    mask = uniform_filter(mask, size=(3, 5))
    floor = 10 ** (-reduce_db / 20)
    _, out = istft(Z * (floor + (1 - floor) * mask), fs=sr, nperseg=2048)
    return out[: len(y)].astype(np.float32)


def energy(path_or_y) -> float:
    y = path_or_y if isinstance(path_or_y, np.ndarray) else load_audio(path_or_y)
    return float(np.mean(y**2))


# ---------------------------------------------------------------- analysis / routing


def analyse(y: np.ndarray, sr: int) -> dict:
    """Cheap content features on (up to) the first 60 s."""
    z = librosa.resample(y[: 60 * sr], orig_sr=sr, target_sr=22050)
    perc = D.percussive_ratio(z)
    f0, voiced, prob = librosa.pyin(z, fmin=55, fmax=1400, sr=22050, frame_length=2048, hop_length=512)
    rms = librosa.feature.rms(y=z, hop_length=512)[0][: len(voiced)]
    loud = rms > 0.1 * np.percentile(rms, 95)
    vf = float(np.mean(voiced[loud])) if loud.any() else 0.0
    med = float(np.nanmedian(librosa.hz_to_midi(f0[voiced]))) if voiced.any() else None
    tempo = float(np.atleast_1d(librosa.beat.beat_track(y=z, sr=22050)[0])[0])
    return {"percussive_ratio": round(perc, 3), "voiced_fraction": round(vf, 3),
            "median_pitch": round(med, 1) if med else None, "beat_tracker_bpm": round(tempo, 1)}


def is_drums(analysis: dict) -> bool:
    return analysis["percussive_ratio"] > 0.45 and analysis["voiced_fraction"] < 0.35


def line_stats(path: str) -> dict:
    """How much the audio behaves like one line, from pyin on (up to) the first 60 s: `clarity` is
    the mean voiced probability over the loud frames (chords confuse pyin, so it drops; so does a
    low bass in a short window, which is why the bass stem is checked first)."""
    z = load_audio(path, 22050)[: 60 * 22050]
    _, voiced, prob = librosa.pyin(z, fmin=38, fmax=1400, sr=22050, frame_length=2048, hop_length=512)
    rms = librosa.feature.rms(y=z, hop_length=512)[0][: len(voiced)]
    loud = rms > 0.1 * np.percentile(rms, 95)
    return {"clarity": round(float(np.mean(prob[loud])) if loud.any() else 0.0, 3)}


def noise_clean(src: str, dest: str) -> None:
    """The cleanup_noise step (noisereduce), run in the `sep` env where engineer.py lives."""
    cmd = [str(ENV_SH), "sep", "python", str(HERE / "engineer.py"), "cleanup", src, dest]
    p = subprocess.run(cmd, capture_output=True, text=True, env=os.environ.copy())
    if p.returncode != 0 or not Path(dest).exists():
        raise RuntimeError(f"noise cleanup failed ({p.returncode}): {p.stderr[-2000:]}")


def separate(src: str, out_dir: Path, models: list[str]) -> dict[str, str]:
    cmd = [str(ENV_SH), "sep", "python", str(HERE / "separate.py"), src, str(out_dir), *models]
    log("separating:", " ".join(models))
    p = subprocess.run(cmd, capture_output=True, text=True, env=os.environ.copy())
    for line in p.stdout.splitlines():
        if line.startswith("RESULT "):
            return json.loads(line[7:])
    raise RuntimeError(f"separation failed ({p.returncode}): {p.stderr[-2000:]}")


# ---------------------------------------------------------------- output


def write_midi(notes: list[C.Note], path: Path, bpm: float, drum: bool = False, name: str = ""):
    pm = pretty_midi.PrettyMIDI(initial_tempo=float(bpm))
    inst = pretty_midi.Instrument(program=0, is_drum=drum, name=name)
    inst.notes = [pretty_midi.Note(velocity=int(np.clip(n.velocity, 1, 127)), pitch=int(n.pitch), start=float(n.start), end=float(n.end)) for n in notes]
    pm.instruments.append(inst)
    pm.write(str(path))


def note_range(notes):
    if not notes:
        return None
    return [pretty_midi.note_number_to_name(min(n.pitch for n in notes)), pretty_midi.note_number_to_name(max(n.pitch for n in notes))]


# ---------------------------------------------------------------- main


def plan_stems(mode: str, stems: dict[str, str], input_wav: str, analysis: dict) -> tuple[str, list[dict], list[str]]:
    """Decide the content and which stem goes to which transcriber.
    Returns (content, [{name, audio, role, transcriber}], warnings)."""
    warns: list[str] = []
    hd = {k.split("-", 1)[1]: v for k, v in stems.items() if k.startswith("htdemucs_6s-")}
    voc = hd.get("vocals")
    solo = analysis.get("line", {}).get("clarity", 0) >= LINE_CLARITY
    e = {k: energy(v) for k, v in hd.items() if k != "vocals"}
    tot = sum(e.values()) + 1e-12
    content = mode
    if mode == "auto":
        if is_drums(analysis):
            content = "drums"
        elif solo:
            content = "hum"
        elif voc and e:
            ev = energy(voc)
            share = ev / (ev + tot)
            analysis["vocal_share"] = round(share, 3)
            content = "hum" if share > VOCAL_HUM else "instrument" if share < VOCAL_INSTRUMENT else "layered"
        else:
            content = "instrument"
    if content == "instrument":  # bass or keys (a single line was caught by `solo`)
        content = "bass" if e.get("bass", 0) / tot >= BASS_STEM else "keys"
    if content == "hum":  # the whole recording, cleaned in run(): as good as the Demucs vocal stem, and faster
        return content, [{"name": "melody", "audio": input_wav, "role": "melody", "transcriber": "pyin", "denoise": True}], warns
    if content == "bass":
        return content, [{"name": "bass", "audio": hd.get("bass") or input_wav, "role": "bass", "transcriber": "pyin"}], warns
    if content == "keys":
        return content, [keys_part(input_wav, warns)], warns
    if content == "drums":
        return content, [{"name": "drums", "audio": input_wav, "role": "drums", "transcriber": "onsets"}], warns
    # layered: vocals -> melody; bass / piano / guitar / other / drums from the same htdemucs_6s run
    plan = [{"name": "melody", "audio": voc or input_wav, "role": "melody", "transcriber": "pyin"}]
    if not hd:
        warns.append("layered but no stems (separate=none): only the melody was transcribed")
        return content, plan, warns
    analysis["stem_shares"] = {k: round(v / tot, 3) for k, v in e.items()}
    if e.get("bass", 0) / tot > 0.08:
        plan.append({"name": "bass", "audio": hd["bass"], "role": "bass", "transcriber": "pyin"})
    # one chords/keys part: htdemucs splits a phone piano between "piano" and "other" (and
    # sometimes "guitar"), so sum the ones that carry energy
    harm = [k for k in ("piano", "guitar", "other") if e.get(k, 0) / tot > 0.05]
    if sum(e.get(k, 0) for k in harm) / tot > 0.15:
        dest = Path(hd[harm[0]]).with_name("htdemucs_6s-keys_sum.wav")
        if len(harm) > 1:
            ys = [load_audio(hd[k]) for k in harm]
            n = min(len(x) for x in ys)
            sf.write(dest, sum(x[:n] for x in ys), SR)
        else:
            dest = Path(hd[harm[0]])
        analysis["keys_from"] = harm
        plan.append(keys_part(str(dest), warns))
    # htdemucs puts plucks and consonants in "drums" on non-drum notes: only trust it when the
    # mix itself is percussive
    if e.get("drums", 0) / tot > 0.15 and analysis.get("percussive_ratio", 0) > 0.25:
        plan.append({"name": "drums", "audio": hd["drums"], "role": "drums", "transcriber": "onsets"})
    return content, plan, warns


def keys_part(audio: str, warns: list[str]) -> dict:
    """A single line on keys still becomes notes; chords stay audio (no Meta chord transcriber)."""
    if line_stats(audio)["clarity"] >= LINE_CLARITY:
        return {"name": "keys", "audio": audio, "role": "keys", "transcriber": "pyin"}
    warns.append("keys: chords stay audio, because there is no Meta model that transcribes chords (split_stems puts the stem on a track)")
    return {"name": "keys", "audio": audio, "role": "keys", "transcriber": "none"}


def run(src: str, out_dir: str, opts) -> dict:
    t0 = time.time()
    out = Path(out_dir)
    (out / "midi").mkdir(parents=True, exist_ok=True)
    (out / "stems").mkdir(parents=True, exist_ok=True)
    timing: dict[str, float] = {}
    warns: list[str] = []

    y = load_audio(src)
    if opts.denoise:
        y = denoise(y, SR)
    y = 0.9 * y / (np.max(np.abs(y)) + 1e-9)
    input_wav = str(out / "input.wav")
    sf.write(input_wav, y, SR)
    analysis = analyse(y, SR)
    timing["analyse"] = round(time.time() - t0, 1)

    # separation
    t = time.time()
    stems: dict[str, str] = {}
    models: list[str] = []
    if opts.mode == "auto" and not is_drums(analysis):
        analysis["line"] = line_stats(input_wav)
    solo = opts.mode == "hum" or analysis.get("line", {}).get("clarity", 0) >= LINE_CLARITY
    if opts.separate != "none" and opts.mode != "drums" and not solo and not (opts.mode == "auto" and is_drums(analysis)):
        models = ["htdemucs_6s"]
        stems = separate(input_wav, out / "stems", models)
    timing["separate"] = round(time.time() - t, 1)
    content, plan, w = plan_stems(opts.mode, stems, input_wav, analysis)
    warns += w
    for p in plan:
        if p.get("denoise"):
            t = time.time()
            p["audio"] = str(out / "stems" / "voice_cleaned.wav")
            noise_clean(input_wav, p["audio"])
            timing["noise_clean"] = round(time.time() - t, 1)

    # transcribe + clean each stem
    hint = analysis.get("beat_tracker_bpm")
    raw_by_stem: dict[str, list[C.Note]] = {}
    for p in plan:
        t = time.time()
        if p["transcriber"] == "onsets":
            yd = load_audio(p["audio"])
            hits = D.detect(yd, SR)
            raw_by_stem[p["name"]] = [C.Note(h["pitch"], h["time"], h["time"] + 0.1, h["velocity"], 1.0) for h in hits]
        elif p["transcriber"] == "pyin":
            # melody: fmin 80 Hz keeps pyin off 50/60 Hz mains hum; bass: down to D#1
            fmin = 38 if p["role"] == "bass" else 80
            raw_by_stem[p["name"]] = T.pyin(load_audio(p["audio"], 22050), 22050, fmin=fmin)
        else:
            raw_by_stem[p["name"]] = []
        timing[f"transcribe_{p['name']}"] = round(time.time() - t, 1)

    # one tempo for the whole note: estimated from all pitched + drum onsets together
    tempo = None
    if opts.bpm:
        tempo = {"bpm": opts.bpm, "source": "given"}
    else:
        onsets = [n.start for p in plan for n in raw_by_stem[p["name"]] if n.conf >= 0.3]
        tempo = C.estimate_tempo(onsets, hint=hint)
        if tempo:
            tempo["source"] = "onsets"
    grid = None if opts.grid == "off" else opts.grid
    if grid and not opts.bpm and not opts.always_quantize and (not tempo or tempo.get("confidence", 0) < MIN_TEMPO_CONF):
        # free-time playing: a grid at a guessed tempo would move notes to the wrong places.
        # The app can still quantize later at the session tempo.
        warns.append(f"tempo unclear (confidence {tempo.get('confidence') if tempo else 'n/a'} < {MIN_TEMPO_CONF}): notes left unquantized")
        grid = None
    if tempo:
        tempo["quantized"] = bool(grid)

    out_stems, all_clean = [], []
    for p in plan:
        if p["transcriber"] == "none":
            out_stems.append({
                "name": p["name"], "role": p["role"], "instrument": "piano", "is_drum": False,
                "audio": os.path.relpath(p["audio"], out), "transcriber": "none", "audio_only": True,
                "midi": None, "raw_midi": None, "raw_notes": 0, "notes_count": 0, "range": None,
                "confidence": 0.0, "notes": [],
            })
            continue
        raw = raw_by_stem[p["name"]]
        is_drum = p["role"] == "drums"
        write_midi(raw, out / "midi" / f"{p['name']}.raw.mid", tempo["bpm"] if tempo else 120, is_drum, p["name"])
        if is_drum:
            notes, steps = raw, {"in": len(raw)}
            if tempo and grid:
                notes, steps["quantized"] = C.quantize_notes(raw, tempo["bpm"], grid, opts.strength, tempo.get("offset", 0.0), ends=False)
            steps["out"] = len(notes)
            res = C.CleanupResult(notes, None, tempo, steps)
        else:
            co = C.CleanupOptions(role=p["role"], key_snap=not opts.no_key_snap, quantize=grid, strength=opts.strength,
                                  bpm=tempo["bpm"] if tempo else None, min_len=opts.min_len,
                                  min_conf=0.3 if p["transcriber"] == "pyin" else 0.25)
            res = C.clean(raw, co)
            all_clean += res.notes
        notes = res.notes
        write_midi(notes, out / "midi" / f"{p['name']}.mid", tempo["bpm"] if tempo else 120, is_drum, p["name"])
        conf = float(np.mean([n.conf for n in notes])) if notes else 0.0
        out_stems.append({
            "name": p["name"], "role": p["role"], "instrument": "drums" if is_drum else "piano", "is_drum": is_drum,
            "audio": os.path.relpath(p["audio"], out), "transcriber": p["transcriber"],
            "midi": f"midi/{p['name']}.mid", "raw_midi": f"midi/{p['name']}.raw.mid",
            "raw_notes": len(raw), "notes_count": len(notes), "range": note_range(notes) if not is_drum else None,
            "confidence": round(conf, 3), "cleanup": res.steps, **({"denoised": "noisereduce"} if p.get("denoise") else {}),
            **({"drum_classes": {c: sum(1 for n in notes if n.pitch == D.GM[c]) for c in D.GM}} if is_drum else {}),
            "notes": [{"pitch": int(n.pitch), "start": round(n.start, 4), "end": round(n.end, 4), "velocity": int(n.velocity)} for n in notes],
        })
        if not notes:
            warns.append(f"{p['name']}: no notes survived cleanup ({len(raw)} raw)")
    key = C.detect_key(all_clean)
    manifest = {
        "version": 1, "input": Path(src).name, "duration": round(len(y) / SR, 3), "mode": opts.mode, "content": content,
        "analysis": analysis, "tempo": tempo, "key": key,
        "settings": {"min_tempo_confidence": MIN_TEMPO_CONF, "separate": opts.separate, "denoise": opts.denoise, "grid": opts.grid, "strength": opts.strength,
                     "key_snap": not opts.no_key_snap},
        "separation": [{"model": m, "licence": "MIT"} for m in models], "warnings": warns,
        "timing": {**timing, "total": round(time.time() - t0, 1)}, "stems": out_stems,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, default=_np))
    return manifest


def parse(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("src")
    ap.add_argument("out_dir")
    ap.add_argument("--mode", default="auto", choices=["auto", "hum", "keys", "bass", "drums", "layered"])
    ap.add_argument("--separate", default="auto", choices=["auto", "none"])
    ap.add_argument("--denoise", action="store_true")
    ap.add_argument("--grid", default="1/16", choices=["off", *C.GRIDS])
    ap.add_argument("--strength", type=float, default=1.0)
    ap.add_argument("--bpm", type=float, default=None)
    ap.add_argument("--always-quantize", action="store_true", help="quantize even when the tempo estimate is unsure")
    ap.add_argument("--no-key-snap", action="store_true")
    ap.add_argument("--min-len", type=float, default=None)
    return ap.parse_args(argv)


if __name__ == "__main__":
    a = parse()
    m = run(a.src, a.out_dir, a)
    log(json.dumps({k: m[k] for k in ("content", "tempo", "key", "warnings")}, default=str))
    log({s["name"]: (s["transcriber"], s["raw_notes"], s["notes_count"], s["range"]) for s in m["stems"]})
    print("MANIFEST " + str(Path(a.out_dir) / "manifest.json"), flush=True)
