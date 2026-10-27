"""List separated stems as transcription jobs.

    spikes/j_evals/env.sh amt python spikes/j_evals/stems.py synth|real

synth: vocals stems of the hum/layered phone clips (all three separators) + htdemucs_6s bass
       and piano stems of the layered clips.
real:  every stem except near-silent ones (peak < -40 dBFS) of every real clip.
Writes $LATTICE_OUT/stems_<which>.json ({"<sep>--<clip>--<stem>": path}) and the YourMT3
job list $LATTICE_OUT/amt/jobs_ymt3_stems_<which>.json.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

OUT = Path(os.environ["LATTICE_OUT"])


def main(which):
    jobs = {}
    for sep_dir in sorted((OUT / "sep").iterdir()):
        if not sep_dir.is_dir():
            continue
        for clip_dir in sorted(p for p in sep_dir.iterdir() if p.is_dir()):
            clip = clip_dir.name
            is_synth = clip.endswith("__phone") or clip.endswith("__clean")
            if (which == "synth") != is_synth:
                continue
            for wav in sorted(clip_dir.glob("*.wav")):
                stem = wav.stem
                if which == "synth":
                    keep = stem == "vocals" or (sep_dir.name == "htdemucs_6s" and clip.startswith("layered") and stem in ("bass", "piano"))
                else:
                    y, _ = sf.read(wav)
                    keep = np.max(np.abs(y)) > 0.01
                if keep:
                    jobs[f"{sep_dir.name}--{clip}--{stem}"] = str(wav)
    (OUT / f"stems_{which}.json").write_text(json.dumps(jobs, indent=1))
    ymt3 = [{"in": p, "out": str(OUT / "amt/pred/yourmt3" / f"{k}.mid")} for k, p in jobs.items()]
    (OUT / f"amt/jobs_ymt3_stems_{which}.json").write_text(json.dumps(ymt3, indent=1))
    print(len(jobs))


if __name__ == "__main__":
    main(sys.argv[1])
