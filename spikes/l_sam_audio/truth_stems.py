"""True per-part stems for the j_evals synthetic layered clips, so separation can be scored.

    spikes/j_evals/env.sh amt python spikes/l_sam_audio/truth_stems.py

Replays synth_set.py's seeds for layered_0..3 (same rng draws, in the same order) and keeps each
part's scaled render instead of only the mix. The stems are clean (before the phone chain, which is
non-linear: AGC and AAC), so they are the reference for separating both the clean and phone mixes.
Check: the stems sum to the existing `layered_k__clean.wav` within -40 dB, or the script fails.
Writes $LATTICE_OUT/amt/synth/stems/layered_<k>__<part>.wav (part = hum, bass, keys).
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "j_evals"))
import synth_set as S  # noqa: E402


def layered_parts(k):
    rng = np.random.default_rng(1000 * 3 + k)
    tonic, mode = int(rng.integers(0, 12)), str(rng.choice(["major", "minor"]))
    bpm = float(rng.integers(80, 121))
    spb, bars = 60 / bpm, 8
    seconds = bars * 4 * spb
    parts = {
        "hum": (53, S.melody(rng, S.scale_notes(tonic, mode, 55, 74), bars, spb), 1.0),
        "bass": (33, S.bassline(rng, tonic, mode, bars, spb), 0.8),
        "keys": (0, S.chords(rng, tonic, mode, bars, spb), 0.6),
    }
    stems = {}
    for name, (prog, notes, gain) in parts.items():  # same steps as S.render_parts
        y = S.render([(prog, notes, gain)], seconds, rng, vibrato=True)
        stems[name] = gain * y / max(np.sqrt(np.mean(y**2)), 1e-9) * 0.1
    scale = 0.5 / np.max(np.abs(sum(stems.values())))  # main() normalises the mix
    return {n: y * scale for n, y in stems.items()}


def main():
    out = S.OUT / "stems"
    out.mkdir(parents=True, exist_ok=True)
    worst = -np.inf
    for k in range(4):
        stems = layered_parts(k)
        mix, _ = sf.read(S.OUT / "audio" / f"layered_{k}__clean.wav")
        err = sum(stems.values()) - mix
        err_db = 10 * np.log10(np.sum(err**2) / np.sum(mix**2) + 1e-20)
        worst = max(worst, err_db)
        for name, y in stems.items():
            sf.write(out / f"layered_{k}__{name}.wav", y, S.SR)
        print(f"layered_{k}: stems sum vs mix {err_db:.1f} dB", flush=True)
    if worst > -40:
        sys.exit(f"FAIL: worst residual {worst:.1f} dB > -40 dB")
    print(f"OK: worst residual {worst:.1f} dB")


if __name__ == "__main__":
    main()
