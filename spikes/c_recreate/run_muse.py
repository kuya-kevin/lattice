"""Spike C: Muse conditions, run after run_optimizer.py.

Muse can't hear music (its audio input is speech-to-text), so it reads the sound
through ears.py: measured features as text.

- muse_only:      Muse reads the reference's description and sets every knob.
- muse_revised:   Muse reads how its render differs from the reference and revises once
                  (the back-and-forth the sound-design loop depends on).
- muse_optimizer: Muse's revised patch seeds the search, and the knobs Muse marks as
                  certain stay fixed (Muse picks the structure, the optimizer fits numbers).

    uv run python run_muse.py ../../out/c_recreate [target ...]
"""
import json
import sys
from pathlib import Path

import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ears import GLOSSARY, compare, describe, to_text  # noqa: E402
from match import fit, spectral_distance  # noqa: E402
from muse import ask, parse_json, spend_report  # noqa: E402
from synth import BY_NAME, PARAMS, SR, default_patch, render  # noqa: E402

SCHEMA = "\n".join(f"- {p.name}: {p.lo}..{p.hi} {p.unit}{' (log)' if p.log else ''}: {p.doc}" for p in PARAMS)

DESIGN = f"""You are a sound designer recreating a sound on a simple subtractive synth.
The synth plays the same pitch and note length as the reference; you only set these knobs:
{SCHEMA}

You can't hear the reference; here are measurements of it.
{GLOSSARY}

Reference:
{{features}}

Return JSON only:
{{{{"patch": {{{{<every knob name>: <value>}}}},
 "certain": [<knob names you are confident about, which should not be searched further>],
 "rationale": "<one or two sentences>"}}}}"""

REVISE = """You set this patch: {patch}
Measured differences between the reference and your render, biggest first:
{diff}
Spectral distance to the reference: {dist:.3f} (lower is closer; 0 is identical).

Revise the patch to close the biggest differences. Return the same JSON."""


def clamp(patch):
    base = default_patch()
    base.update({k: v for k, v in patch.items() if k in BY_NAME})
    return {k: BY_NAME[k].from_unit(BY_NAME[k].to_unit(float(v))) for k, v in base.items()}


def main(c_out, only=()):
    c_out = Path(c_out)
    summary = json.loads((c_out / "summary.json").read_text())
    for name, rec in summary.items():
        if only and name not in only:
            continue
        d = c_out / name
        ref, _ = sf.read(d / "reference.wav")
        f0, gate = rec["conditions"]["optimizer"]["f0"], rec["gate"]
        seconds = len(ref) / SR
        conds = rec["conditions"]
        ref_feats = describe(ref, SR, f0, gate)
        design = DESIGN.format(features=to_text(ref_feats))

        reply1 = ask([{"type": "text", "text": design}])
        first = parse_json(reply1)
        p1 = clamp(first.get("patch", {}))
        y1 = render(p1, f0, seconds, gate)
        sf.write(d / "muse_only.wav", y1, SR)
        d1 = spectral_distance(ref, y1)
        conds["muse_only"] = {"distance": d1, "patch": p1, "rationale": first.get("rationale")}

        diff = compare(ref_feats, describe(y1, SR, f0, gate))
        second = parse_json(ask(
            [{"type": "text", "text": REVISE.format(patch=json.dumps(p1), diff=diff, dist=d1)}],
            history=[{"role": "user", "content": design}, {"role": "assistant", "content": reply1}],
        ))
        p2 = clamp(second.get("patch", {}))
        y2 = render(p2, f0, seconds, gate)
        sf.write(d / "muse_revised.wav", y2, SR)
        conds["muse_revised"] = {"distance": spectral_distance(ref, y2), "patch": p2, "rationale": second.get("rationale")}

        certain = [k for k in second.get("certain", []) if k in BY_NAME]
        p3, dist3, evals = fit(ref, f0, gate, x0=p2, sigma0=0.15, frozen={k: p2[k] for k in certain})
        sf.write(d / "muse_optimizer.wav", render(p3, f0, seconds, gate), SR)
        conds["muse_optimizer"] = {"distance": dist3, "patch": p3, "frozen": certain, "evals": evals}

        print(
            f"{name:24s} muse {d1:.3f} -> revised {conds['muse_revised']['distance']:.3f}"
            f" -> +optimizer {dist3:.3f} | optimizer alone {conds['optimizer']['distance']:.3f}"
            f" | default {conds['default']['distance']:.3f} | froze {certain}",
            flush=True,
        )
        (c_out / "summary.json").write_text(json.dumps(summary, indent=2, default=float))
    print("spend:", spend_report())


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../../out/c_recreate", set(sys.argv[2:]))
