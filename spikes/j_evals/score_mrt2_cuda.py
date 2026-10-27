"""Score the CUDA MRT2 renders like spikes/d_mrt2/score_mrt2.py and add them to summary.json.

Runs in the main spikes env (it reuses c_recreate/match.py):
    cd spikes && uv run python j_evals/score_mrt2_cuda.py <bigdisk>/transfer/out/c_recreate
A copy of summary.json is kept as summary.before_j_evals.json the first time.
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "c_recreate"))
from match import measure_note, spectral_distance  # noqa: E402

c_out = Path(sys.argv[1])
conds = sys.argv[2:] or ["mrt2", "mrt2_cuda_small", "mrt2_cuda_base"]
backup = c_out / "summary.before_j_evals.json"
if not backup.exists():
    shutil.copy(c_out / "summary.json", backup)
summary = json.loads((c_out / "summary.json").read_text())
rows = []
for name, rec in summary.items():
    ref, _ = sf.read(c_out / name / "reference.wav")
    line = [f"{name:24s}"]
    for cond in conds:
        f = c_out / name / f"{cond}.wav"
        if not f.exists():
            continue
        y, _ = sf.read(f)
        f0, gate = measure_note(y)
        cents = 1200 * np.log2(f0 / rec["true_f0"]) if f0 else None
        d = spectral_distance(ref, y)
        if cond != "mrt2":  # the Mac MLX result is already in summary.json
            rec["conditions"][cond] = {"distance": d, "f0": f0, "pitch_error_cents": cents, "gate": gate}
        line.append(f"{cond} {d:.3f} ({cents and round(cents)}c, gate {gate:.2f})")
    line.append(f"optimizer {rec['conditions']['optimizer']['distance']:.3f}, default {rec['conditions']['default']['distance']:.3f}")
    print(" | ".join(line))
(c_out / "summary.json").write_text(json.dumps(summary, indent=2, default=float))
