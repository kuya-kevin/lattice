"""Write the input lists the other scripts read: $LATTICE_OUT/inputs_{synth,real}.json.

    spikes/j_evals/env.sh amt python spikes/j_evals/inputs.py
"""
import json
import os
from pathlib import Path

OUT = Path(os.environ["LATTICE_OUT"])
DATA = Path(os.environ["LATTICE_DATA"])
VOICE = [112, 114, 119, 143, 145, 146, 149, 150]
FS_CATS = ["bass_keys_phrase", "layered_multi", "hum_whistle_beatbox"]


def main():
    synth = {}
    for f in sorted((OUT / "amt/synth/audio").glob("*.wav")):
        synth[f.stem] = str(f)
    real = {f"vn_{n}": str(DATA / f"voice_notes/new_recording_{n}.wav") for n in VOICE}
    real["vn_drum_loop"] = str(DATA / "voice_notes/vn-drum-loop.wav")
    manifest = json.loads((DATA / "freesound_material/manifest.json").read_text())
    for rec in manifest:
        if rec["category"] in FS_CATS:
            wav = DATA / "freesound_material/audio" / rec["category"] / f"{rec['id']}.wav"
            if wav.exists():
                real[f"fs_{rec['category']}_{rec['id']}"] = str(wav)
    (OUT / "inputs_synth.json").write_text(json.dumps(synth, indent=1))
    (OUT / "inputs_real.json").write_text(json.dumps(real, indent=1))
    # separation only needs the phone versions of the multi-part and hum clips
    sep = {k: v for k, v in synth.items() if k.endswith("__phone") and k.split("_")[0] in ("layered", "hum")}
    (OUT / "inputs_sep_synth.json").write_text(json.dumps(sep, indent=1))
    print(len(synth), len(real), len(sep))


if __name__ == "__main__":
    main()
