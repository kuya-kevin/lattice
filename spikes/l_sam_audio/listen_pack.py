"""M4 listening pack: the same voice note through every separator, one folder per note.

    spikes/j_evals/env.sh amt python spikes/l_sam_audio/listen_pack.py jobs    # writes sam/jobs_listen.json, inputs_sep_listen.json
    (then separate.py and run_sam.py on those, see spikes/l_sam_audio/README.md)
    spikes/j_evals/env.sh amt python spikes/l_sam_audio/listen_pack.py pack    # writes $LATTICE_OUT/listen_sep/<note>/

Notes: <bigdisk>/transfer/data/voice_notes/new_recording_<n>.wav (local only, never in the repo).
Each folder holds 00_input.wav, htdemucs_6s-*.wav and sam_<size>-<prompt>.wav
(SAM target only; mono 48 kHz). Files are copies, loudness untouched, so levels compare as-is.
"""
import json
import os
import shutil
import sys
from pathlib import Path

BIG = Path(os.environ["LATTICE_BIGDISK"])
EV = Path(os.environ["LATTICE_OUT"])
NOTES = [112, 114, 119, 143, 145, 146]
VN = BIG / "transfer" / "data" / "voice_notes"
PROMPTS = ["singing voice", "humming", "piano", "bass", "drums"]
SIZES = ["small"]


def wav(n):
    return VN / f"new_recording_{n}.wav"


def jobs():
    (EV / "sam").mkdir(parents=True, exist_ok=True)
    js = [{"id": f"vn_{n}", "audio": str(wav(n)), "part": p.replace(" ", "_"), "text": p}
          for n in NOTES for p in PROMPTS]
    (EV / "sam" / "jobs_listen.json").write_text(json.dumps(js, indent=1))
    (EV / "inputs_sep_listen.json").write_text(json.dumps({f"vn_{n}": str(wav(n)) for n in NOTES}, indent=1))
    print(len(js), "SAM jobs per size;", len(NOTES), "notes for separate.py")


def pack():
    for n in NOTES:
        d = EV / "listen_sep" / f"vn_{n}"
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(wav(n), d / "00_input.wav")
        for model in ("htdemucs_6s",):
            for s in sorted((EV / "sep" / model / f"vn_{n}").glob("*.wav")):
                shutil.copy(s, d / f"{model}-{s.name}")
        for size in SIZES:
            for p in PROMPTS:
                t = EV / "sam" / size / f"vn_{n}__{p.replace(' ', '_')}" / "target.wav"
                if t.exists():
                    shutil.copy(t, d / f"sam_{size}-{p.replace(' ', '_')}.wav")
        print(d, len(list(d.glob("*.wav"))), "files")


if __name__ == "__main__":
    {"jobs": jobs, "pack": pack}[sys.argv[1]]()
