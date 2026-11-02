"""The whole sidecar (prep.py) on the 16 synthetic phone clips, for scoring with score_cleanup.py.

    spikes/j_evals/env.sh amt python spikes/k_source_prep/run_synth.py <out name> [--pilot] [--only <prefix>] [prep.py options]

Writes $LATTICE_BIGDISK/out-k/<out name>/<clip>/ (manifest, MIDI, stems) and appends one JSON line
per clip to $LATTICE_BIGDISK/out-k/<out name>/progress.log: content, transcriber per stem, F1 of
the cleaned stem against its part, warnings, seconds. Longest clip first; --pilot runs only that
one; --only hum runs only the clips whose name starts with hum. Stops on the first crash. Example: `run_synth.py synth_meta`.
"""
import json
import os
import sys
import time
import traceback
from pathlib import Path

import pretty_midi
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "j_evals"))
import prep  # noqa: E402
from score_amt import f1  # noqa: E402

EVALS = Path(os.environ["LATTICE_OUT"])
AUDIO = EVALS / "amt" / "synth" / "audio"
TRUTH = EVALS / "amt" / "synth" / "truth"
PART = {"melody": "hum", "bass": "bass", "keys": "keys"}


def main():
    name, rest = sys.argv[1], sys.argv[2:]
    pilot = "--pilot" in rest
    rest = [a for a in rest if a != "--pilot"]
    only = ""
    if "--only" in rest:
        i = rest.index("--only")
        only = rest[i + 1]
        del rest[i : i + 2]
    root = Path(os.environ["LATTICE_BIGDISK"]) / "out-k" / name
    root.mkdir(parents=True, exist_ok=True)
    log = root / "progress.log"
    print(f"log: {log}", flush=True)
    clips = sorted(AUDIO.glob(f"{only}*__phone.wav"), key=lambda p: -sf.info(str(p)).duration)
    for wav in clips[:1] if pilot else clips:
        clip = wav.stem.split("__")[0]
        cat = clip.split("_")[0]
        t = time.time()
        rec = {"clip": clip}
        try:
            m = prep.run(str(wav), str(root / clip), prep.parse([str(wav), str(root / clip), *rest]))
            parts = {i.name: i.notes for i in pretty_midi.PrettyMIDI(str(TRUTH / f"{clip}.mid")).instruments}
            stems = {}
            for s in m["stems"]:
                if s.get("audio_only"):
                    stems[s["name"]] = {"transcriber": "none (audio only)"}
                    continue
                part = cat if cat != "layered" else PART.get(s["name"])
                notes = pretty_midi.PrettyMIDI(str(root / clip / s["midi"])).instruments[0].notes
                stems[s["name"]] = {"transcriber": s["transcriber"], "notes": len(notes),
                                    **({"f1": round(f1(parts[part], notes)["f"], 3)} if part in parts else {})}
            rec.update(status="ok", content=m["content"], stems=stems, warnings=m["warnings"])
        except Exception as e:
            rec.update(status="fail", error=f"{type(e).__name__}: {str(e)[:300]}")
            traceback.print_exc()
        rec["secs"] = round(time.time() - t, 1)
        with log.open("a") as fh:
            fh.write(json.dumps(rec) + "\n")
        print(json.dumps(rec), flush=True)
        if rec["status"] != "ok":
            sys.exit(1)


if __name__ == "__main__":
    main()
