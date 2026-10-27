"""Spike D: score mrt2.wav against each reference and add it to summary.json.

    uv run python d_mrt2/score_mrt2.py ../out/c_recreate
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "c_recreate"))
from match import measure_note, spectral_distance  # noqa: E402

c_out = Path(sys.argv[1] if len(sys.argv) > 1 else "../out/c_recreate")
summary = json.loads((c_out / "summary.json").read_text())
for name, rec in summary.items():
    ref, _ = sf.read(c_out / name / "reference.wav")
    y, _ = sf.read(c_out / name / "mrt2.wav")
    f0, gate = measure_note(y)
    cents = 1200 * np.log2(f0 / rec["true_f0"]) if f0 else None
    rec["conditions"]["mrt2"] = {"distance": spectral_distance(ref, y), "f0": f0, "pitch_error_cents": cents, "gate": gate}
    print(
        f"{name:24s} mrt2 {rec['conditions']['mrt2']['distance']:.3f} | optimizer {rec['conditions']['optimizer']['distance']:.3f}"
        f" | default {rec['conditions']['default']['distance']:.3f} | pitch {f0 and round(f0, 1)} vs {rec['true_f0']:.1f}"
        f" ({cents and round(cents)} cents) gate {gate:.2f} vs {rec['gate']:.2f}"
    )
(c_out / "summary.json").write_text(json.dumps(summary, indent=2, default=float))
