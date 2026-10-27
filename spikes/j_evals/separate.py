"""Source separation with python-audio-separator: BS-RoFormer, Mel-RoFormer, htdemucs_6s.

    spikes/j_evals/env.sh sep python spikes/j_evals/separate.py inputs.json

inputs.json: {"<id>": "<wav path>", ...}. For each model writes
$LATTICE_OUT/sep/<model>/<id>/<stem>.wav (stem names lower-case: vocals, instrumental,
other, bass, drums, guitar, piano) and $LATTICE_OUT/sep/<model>/timing.json.
Weights go to $LATTICE_OUT/../models/audio-separator.
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

import imageio_ffmpeg
import soundfile as sf
import torch

# audio-separator shells out to `ffmpeg`; there is none on this machine, so expose the
# static binary from imageio-ffmpeg under that name.
_bin = Path(os.environ.get("TMPDIR", "/tmp")) / "ffmpeg-bin"
_bin.mkdir(parents=True, exist_ok=True)
if not (_bin / "ffmpeg").exists():
    (_bin / "ffmpeg").symlink_to(imageio_ffmpeg.get_ffmpeg_exe())
os.environ["PATH"] = f"{_bin}:{os.environ['PATH']}"

from audio_separator.separator import Separator  # noqa: E402

OUT = Path(os.environ["LATTICE_OUT"]) / "sep"
WEIGHTS = Path(os.environ["LATTICE_OUT"]).parent / "models" / "audio-separator"
MODELS = {
    "bs_roformer": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",  # vocals / instrumental
    "mel_roformer": "vocals_mel_band_roformer.ckpt",  # vocals / other (Kim)
    "htdemucs_6s": "htdemucs_6s.yaml",  # vocals, drums, bass, guitar, piano, other
}


def main(inputs_file, *only):
    inputs = json.loads(Path(inputs_file).read_text())
    WEIGHTS.mkdir(parents=True, exist_ok=True)
    for short, fname in MODELS.items():
        if only and short not in only:
            continue
        tmp = Path(tempfile.mkdtemp(dir=os.environ.get("TMPDIR")))
        sep = Separator(output_dir=str(tmp), model_file_dir=str(WEIGHTS), output_format="WAV", log_level=30)
        t0 = time.time()
        sep.load_model(model_filename=fname)
        load_s = time.time() - t0
        torch.cuda.reset_peak_memory_stats()
        timing, audio_s, run_s = {}, 0.0, 0.0
        for cid, path in inputs.items():
            dest = OUT / short / cid
            dest.mkdir(parents=True, exist_ok=True)
            t = time.time()
            outs = sep.separate(path)
            took = time.time() - t
            for o in outs:
                m = re.search(r"_\(([^)]+)\)_", Path(o).name)
                stem = m.group(1).lower() if m else Path(o).stem
                shutil.move(str(tmp / Path(o).name), dest / f"{stem}.wav")
            dur = sf.info(path).duration
            audio_s += dur
            run_s += took
            timing[cid] = {"audio_s": round(dur, 2), "seconds": round(took, 2)}
            print(f"{short} {cid}: {took:.1f}s for {dur:.1f}s -> {sorted(p.stem for p in dest.iterdir())}", flush=True)
        shutil.rmtree(tmp, ignore_errors=True)
        summary = {"model": fname, "load_s": round(load_s, 1), "audio_s": round(audio_s, 1), "seconds": round(run_s, 1),
                   "rtf": round(run_s / max(audio_s, 1e-9), 3),
                   "peak_vram_mb_torch": round(torch.cuda.max_memory_allocated() / 2**20), "files": timing}
        old = OUT / short / "timing.json"
        if old.exists():  # merge with earlier batches
            prev = json.loads(old.read_text())
            prev["files"].update(timing)
            summary["files"] = prev["files"]
        old.write_text(json.dumps(summary, indent=2))
        print({k: v for k, v in summary.items() if k != "files"}, flush=True)
        del sep
        torch.cuda.empty_cache()


if __name__ == "__main__":
    main(*sys.argv[1:])
