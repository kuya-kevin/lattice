"""Spike A: can Muse Spark 1.2 hear music usefully?

Two kinds of clips:
- C's synth targets, where we know the truth (pitch, waveform, attack, filter motion),
  so answers are scored automatically.
- Your voice notes (after B's cleanup), where answers are saved for you to score by hand.
"""
import json
import sys
from pathlib import Path

import librosa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "c_recreate"))
from muse import ask, audio_part, parse_json  # noqa: E402
from targets import IN_FAMILY  # noqa: E402

SYNTH_PROMPT = """You are a sound designer listening to one synth note.
Answer only what you can hear. Return JSON:
{"note": "<pitch as note name with octave, e.g. A3>",
 "waveform": "<saw | square | sine | mixed | not subtractive>",
 "attack": "<fast | medium | slow>",
 "filter_motion": "<none | opening | closing>",
 "unison_detune": "<none | slight | wide>",
 "distortion": "<none | some | heavy>",
 "description": "<one sentence a producer would say>",
 "confidence": <0..1>}"""

VOICE_PROMPT = """You are a sound engineer listening to a phone voice note a musician recorded as an idea.
Return JSON:
{"what_it_is": "<hummed melody | sung melody | beatbox | instrument | other: ...>",
 "tempo_bpm": <number or null>,
 "key_or_notes": "<key, or the notes you hear, or null>",
 "noise": "<what background noise you hear, if any>",
 "best_section": "<start-end seconds of the cleanest usable part>",
 "suggested_use": "<what a producer could turn this into>",
 "confidence": <0..1>}"""


def truth_for(name, patch, f0):
    return {
        "note": librosa.hz_to_note(f0, unicode=False),
        "waveform": "saw" if patch["saw"] > 2 * patch["square"] else "square" if patch["square"] > 2 * patch["saw"] else "mixed",
        "attack": "fast" if patch["attack"] < 0.03 else "slow" if patch["attack"] > 0.2 else "medium",
        "filter_motion": "closing" if patch["env_amount"] > 1 and patch["env_decay"] < 1 else "none",
        "unison_detune": "none" if patch["voices"] == 1 else "wide" if patch["detune"] > 20 else "slight",
        "distortion": "none" if patch["drive"] < 0.15 else "heavy" if patch["drive"] > 0.5 else "some",
    }


def main(c_out, voice_dir, out_path):
    results = {"synth": {}, "voice": {}}
    score, total = 0, 0
    for name, (patch, f0) in IN_FAMILY.items():
        wav = Path(c_out) / name / "reference.wav"
        reply = ask([{"type": "text", "text": SYNTH_PROMPT}, audio_part(wav)])
        try:
            got = parse_json(reply)
        except ValueError:
            got = {"raw": reply}
        truth = truth_for(name, patch, f0)
        hits = {k: str(got.get(k, "")).lower().strip() == v.lower() for k, v in truth.items()}
        # Octave errors are common and musically minor; score pitch class separately.
        hits["pitch_class"] = str(got.get("note", ""))[:-1].upper() == truth["note"][:-1].upper()
        score += sum(hits.values())
        total += len(hits)
        results["synth"][name] = {"truth": truth, "muse": got, "hits": hits}
        print(f"{name}: {sum(hits.values())}/{len(hits)}  {got.get('description', '')}")
    print(f"synth attributes correct: {score}/{total}")

    for wav in sorted(Path(voice_dir).glob("*.wav")):
        reply = ask([{"type": "text", "text": VOICE_PROMPT}, audio_part(wav)])
        try:
            got = parse_json(reply)
        except ValueError:
            got = {"raw": reply}
        results["voice"][wav.name] = got
        print(f"{wav.name}: {json.dumps(got)}")

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:4])
