"""Spike M, step 1: clean each input with every variant and save the audio.

Question: do the community Mel-RoFormer denoise / dereverb models (loaded through
python-audio-separator, the library the `sep` env already uses) beat noisereduce as the
cleanup in front of audio to MIDI, and do they sound better on real voice notes?

    # model variants (sep env; MPS on the Mac, CUDA on the 3090)
    spikes/j_evals/env.sh sep python spikes/m_cleanup_models/clean.py models [--pilot]
    # noisereduce (spikes uv project, where b_cleanup ran)
    cd spikes && LATTICE_BIGDISK=... uv run python m_cleanup_models/clean.py nr [--pilot]

Inputs: the 16 synthetic phone clips ($LATTICE_OUT/amt/synth/audio/*__phone.wav, from
j_evals/synth_set.py; they have room reverb and noise baked in) and the real voice notes in
data/voice_notes/. Writes $LATTICE_BIGDISK/out-m/audio/<variant>/<clip>.wav (mono 44.1 kHz)
and one JSON line per file to $LATTICE_BIGDISK/out-m/clean.log (seconds, stems seen).
--pilot runs only the longest input. Stops on the first failure.
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
REPO = Path(__file__).resolve().parents[2]
BIG = Path(os.environ["LATTICE_BIGDISK"])
OUT = BIG / "out-m"
SYNTH = Path(os.environ.get("LATTICE_OUT", BIG / "out-evals")) / "amt" / "synth" / "audio"
REAL = REPO / "data" / "voice_notes"
WEIGHTS = BIG / "models" / "audio-separator"

DENOISE = "denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt"  # stems: dry*, other
DEREVERB = "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"  # stems: noreverb*, reverb
# variant -> chain of audio-separator checkpoints (applied in order)
MODELS = {"mr_denoise": [DENOISE], "mr_dereverb": [DEREVERB], "mr_both": [DENOISE, DEREVERB]}
KEEP = {DENOISE: "dry", DEREVERB: "noreverb"}  # the stem we keep (audio-separator --list_models marks it *)


def stem_name(path: Path) -> str:
    m = re.search(r"_\(([^)]+)\)", path.name)  # audio-separator names outputs <in>_(<Stem>)_<model>.wav
    return (m.group(1) if m else path.stem).lower()


def inputs(pilot: bool) -> dict[str, Path]:
    files = {p.stem.split("__")[0]: p for p in sorted(SYNTH.glob("*__phone.wav"))}
    files |= {f"real_{p.stem}": p for p in sorted(REAL.glob("*.wav"))}
    if not files:
        sys.exit(f"no inputs in {SYNTH} or {REAL}")
    if pilot:
        k = max(files, key=lambda k: sf.info(str(files[k])).duration)
        files = {k: files[k]}
    return files


def load_mono(path: Path) -> np.ndarray:
    import librosa
    y, _ = librosa.load(str(path), sr=SR, mono=True)
    return y.astype(np.float32)


def log(rec: dict):
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / "clean.log").open("a") as fh:
        fh.write(json.dumps(rec) + "\n")
    print(json.dumps(rec), flush=True)


def quietest_window(y, seconds=0.5):  # same recipe as b_cleanup/run_noisereduce.py
    w = int(seconds * SR)
    hop = w // 4
    energy = [np.mean(y[i : i + w] ** 2) for i in range(0, len(y) - w, hop)]
    start = int(np.argmin(energy)) * hop
    return y[start : start + w]


def run_nr(files):
    import noisereduce as nr
    dest = OUT / "audio" / "nr"
    dest.mkdir(parents=True, exist_ok=True)
    for cid, path in files.items():
        y = load_mono(path)
        t = time.time()
        clean = nr.reduce_noise(y=y, sr=SR, stationary=True, y_noise=quietest_window(y), prop_decrease=1.0)
        sf.write(dest / f"{cid}.wav", clean.astype(np.float32), SR)
        log({"variant": "nr", "clip": cid, "audio_s": round(len(y) / SR, 1), "secs": round(time.time() - t, 2)})


def run_models(files):
    # audio-separator shells out to ffmpeg; use the static one from imageio-ffmpeg (as j_evals/separate.py)
    import imageio_ffmpeg
    tmp_root = Path(tempfile.mkdtemp(dir=os.environ.get("TMPDIR")))
    (tmp_root / "bin").mkdir()
    (tmp_root / "bin" / "ffmpeg").symlink_to(imageio_ffmpeg.get_ffmpeg_exe())
    os.environ["PATH"] = f"{tmp_root / 'bin'}:{os.environ['PATH']}"
    from audio_separator.separator import Separator

    WEIGHTS.mkdir(parents=True, exist_ok=True)
    for d in ("raw", *MODELS):
        (OUT / "audio" / d).mkdir(parents=True, exist_ok=True)
    for cid, path in files.items():  # raw = the same mono 44.1 kHz file the others start from
        sf.write(OUT / "audio" / "raw" / f"{cid}.wav", load_mono(path), SR)

    seps: dict[str, Separator] = {}
    done: dict[tuple[str, str], Path] = {}  # (chain prefix, clip) -> output, so mr_both reuses mr_denoise
    for variant, chain in MODELS.items():
        for cid in files:
            src = OUT / "audio" / "raw" / f"{cid}.wav"
            infer = 0.0  # model time only: loading and downloading weights are left out
            stems_seen = []
            for i, ckpt in enumerate(chain):
                key = ("+".join(chain[: i + 1]), cid)
                if key in done:
                    src = done[key]
                    continue
                if ckpt not in seps:
                    work = tmp_root / ckpt
                    work.mkdir()
                    s = Separator(output_dir=str(work), model_file_dir=str(WEIGHTS), output_format="WAV", log_level=30)
                    s.load_model(model_filename=ckpt)
                    seps[ckpt] = s
                sep = seps[ckpt]
                stereo = tmp_root / f"{cid}.in.wav"  # Roformer configs expect 2 channels
                y = load_mono(src)
                sf.write(stereo, np.stack([y, y], axis=1), SR)
                t = time.time()
                outs = [Path(sep.output_dir) / Path(o).name for o in sep.separate(str(stereo))]
                infer += time.time() - t
                names = [stem_name(o) for o in outs]
                stems_seen.append(names)
                keep = [o for o, n in zip(outs, names) if n == KEEP[ckpt]]
                if len(keep) != 1:
                    raise RuntimeError(f"{ckpt}: can't tell which stem to keep from {names}")
                step = tmp_root / f"{cid}.{i}.{variant}.wav"
                sf.write(step, load_mono(keep[0]), SR)
                for o in outs:
                    o.unlink(missing_ok=True)
                done[key] = src = step
            shutil.copy(src, OUT / "audio" / variant / f"{cid}.wav")
            log({"variant": variant, "clip": cid, "audio_s": round(sf.info(str(src)).duration, 1),
                 "secs": round(infer, 2), "stems": stems_seen})
    shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    which = sys.argv[1]
    files = inputs("--pilot" in sys.argv)
    {"nr": run_nr, "models": run_models}[which](files)
