"""Known-answer test for the melody stray-note filter in cleanup.py:

    LATTICE_BIGDISK=... spikes/j_evals/env.sh amt python spikes/k_source_prep/test_cleanup.py
"""
from cleanup import CleanupOptions, Note, clean


def line(*extra):
    return [Note(p, i * 0.5, i * 0.5 + 0.4, 80, 0.9) for i, p in enumerate([50, 52, 53, 55, 57, 55])] + list(extra)


opt = CleanupOptions(role="melody", quantize=None, key_snap=False, octave_fix=False)
r = clean(line(Note(87, 3.1, 3.26, 80, 0.9)), opt)  # far and short: noise
assert r.steps["stray"] == 1 and all(n.pitch < 87 for n in r.notes)
r = clean(line(Note(87, 3.1, 3.6, 80, 0.9)), opt)  # far but held: sung
assert r.steps["stray"] == 0 and any(n.pitch == 87 for n in r.notes)
r = clean(line(Note(69, 3.1, 3.26, 80, 0.9)), opt)  # a short note within range stays
assert r.steps["stray"] == 0 and any(n.pitch == 69 for n in r.notes)
print("stray filter ok")
