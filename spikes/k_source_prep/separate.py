"""Separate one file into stems (runs in the j_evals `sep` env, called by prep.py).

    spikes/j_evals/env.sh sep python spikes/k_source_prep/separate.py <in.wav> <out_dir> <model> [<model> ...]

Model: htdemucs_6s (Meta Demucs, MIT; vocals, drums, bass, guitar, piano, other). Writes <out_dir>/<model>-<stem>.wav and prints one JSON line with the paths.
Weights are read from $LATTICE_BIGDISK/models/audio-separator (downloaded there on first use).
"""
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

import imageio_ffmpeg

# audio-separator shells out to `ffmpeg`; there is none on this machine
_bin = Path(os.environ.get("TMPDIR", tempfile.gettempdir())) / "ffmpeg-bin"
_bin.mkdir(parents=True, exist_ok=True)
if not (_bin / "ffmpeg").exists():
    (_bin / "ffmpeg").symlink_to(imageio_ffmpeg.get_ffmpeg_exe())
os.environ["PATH"] = f"{_bin}:{os.environ['PATH']}"

from audio_separator.separator import Separator  # noqa: E402

WEIGHTS = Path(os.environ["LATTICE_BIGDISK"]) / "models" / "audio-separator"
MODELS = {"htdemucs_6s": "htdemucs_6s.yaml"}


def main(src, out_dir, *models):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    result = {}
    for short in models:
        tmp = Path(tempfile.mkdtemp(dir=os.environ.get("TMPDIR")))
        sep = Separator(output_dir=str(tmp), model_file_dir=str(WEIGHTS), output_format="WAV", log_level=40)
        sep.load_model(model_filename=MODELS[short])
        for o in sep.separate(src):
            m = re.search(r"_\(([^)]+)\)_", Path(o).name)
            stem = m.group(1).lower() if m else Path(o).stem
            dest = out / f"{short}-{stem}.wav"
            shutil.move(str(tmp / Path(o).name), dest)
            result[f"{short}-{stem}"] = str(dest)
        shutil.rmtree(tmp, ignore_errors=True)
        del sep
    print("RESULT " + json.dumps(result), flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
