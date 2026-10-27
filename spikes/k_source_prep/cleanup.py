"""Note cleanup for phone-quality transcriptions (pure numpy; no model code).

A transcription is a list of `Note(pitch, start, end, velocity, conf)`. `clean()` runs, in order:

1. pitch range limits per role (drops mains hum at A1/A#1 under a hum, squeaks over a bass)
2. octave fix for melodies (a note an octave away from its neighbours is moved back)
3. confidence / velocity pruning (absolute floor, and relative to the loud notes)
4. merge repeats (melody: same pitch, gap below `merge_gap`, pyin and basic-pitch split held
   hums; bass/keys: only overlapping duplicates)
5. monophonic overlap resolution for mono roles (keep the stronger note, cut the other)
6. minimum note length
7. key detection (Krumhansl-Schmuckler, duration x velocity weighted) and scale snap of
   rare out-of-key notes (frequent ones are kept: borrowed chords, blue notes)
8. tempo estimate from note onsets (or a given BPM), then quantize starts (and ends) to a
   grid with a strength 0-1

Every step reports how many notes it touched, so the manifest can say what was done.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
SCALE = {"major": [0, 2, 4, 5, 7, 9, 11], "minor": [0, 2, 3, 5, 7, 8, 10]}
GRIDS = {"1/4": 1.0, "1/8": 0.5, "1/8T": 1 / 3, "1/16": 0.25, "1/16T": 1 / 6, "1/32": 0.125}  # in beats

# Pitch range per role (MIDI numbers). Hum/whistle: C3-C7; bass: A0-C4; keys: full piano.
RANGES = {"melody": (48, 96), "bass": (21, 60), "keys": (21, 108), "other": (28, 100)}
MONO_ROLES = {"melody", "bass"}


@dataclass
class Note:
    pitch: int
    start: float
    end: float
    velocity: int = 90
    conf: float = 1.0

    @property
    def dur(self) -> float:
        return self.end - self.start


@dataclass
class CleanupOptions:
    role: str = "keys"  # melody | bass | keys | other
    min_len: float | None = None  # s; default 0.09 mono, 0.06 poly
    min_conf: float = 0.25  # absolute confidence floor (0-1)
    rel_velocity: float = 0.25  # drop notes quieter than this x the 90th percentile velocity
    # Merge same-pitch notes split by a gap below this (s). Default per role: melody 0.06
    # (pyin / basic-pitch split held hums), bass and keys 0 (only overlapping duplicates:
    # repeated chords and bass notes are real re-attacks; merging them cost 0.15 F1 on keys).
    merge_gap: float | None = None
    pitch_range: tuple[int, int] | None = None  # default from RANGES[role]
    # Octave fix for melody only: bass lines jump octaves on purpose (it cost 0.17 F1 on bass).
    octave_fix: bool | None = None
    key_snap: bool = True
    rare_share: float = 0.05  # out-of-key pitch classes below this share of notes get snapped
    min_key_r: float = 0.6  # only snap when the key fit is at least this good
    bpm: float | None = None  # known tempo; None = estimate from the notes
    quantize: str | None = "1/16"  # a GRIDS key or None/"off"
    strength: float = 1.0  # 0 = no move, 1 = hard snap
    quantize_ends: bool = True


@dataclass
class CleanupResult:
    notes: list[Note]
    key: dict | None
    tempo: dict | None
    steps: dict = field(default_factory=dict)


# ---------------------------------------------------------------- key


def detect_key(notes: list[Note]) -> dict | None:
    if len(notes) < 4:
        return None
    hist = np.zeros(12)
    for n in notes:
        hist[n.pitch % 12] += n.dur * max(n.velocity, 1)
    if hist.std() == 0:
        return None
    scores = []
    for tonic in range(12):
        for mode, prof in (("major", MAJOR), ("minor", MINOR)):
            scores.append((float(np.corrcoef(hist, np.roll(prof, tonic))[0, 1]), tonic, mode))
    scores.sort(reverse=True)
    r, tonic, mode = scores[0]
    return {"name": f"{NAMES[tonic]} {mode}", "tonic": NAMES[tonic], "tonic_pc": tonic, "mode": mode, "r": round(r, 3),
            "runner_up": f"{NAMES[scores[1][1]]} {scores[1][2]}"}


def snap_pitch(pitch: int, tonic_pc: int, mode: str) -> int:
    allowed = {(tonic_pc + s) % 12 for s in SCALE[mode]}
    if pitch % 12 in allowed:
        return pitch
    for d in (-1, 1, -2, 2):  # nearest scale tone, prefer down
        if (pitch + d) % 12 in allowed:
            return pitch + d
    return pitch


# ---------------------------------------------------------------- tempo / grid


def _grid_error(onsets: np.ndarray, step: float) -> tuple[float, float]:
    """Best grid phase for `onsets` on a grid of `step` s, and the mean |deviation| / step."""
    ph = 2 * np.pi * (onsets / step)
    z = np.mean(np.exp(1j * ph))
    offset = (np.angle(z) / (2 * np.pi)) * step % step
    dev = (onsets - offset) / step
    dev = np.abs(dev - np.round(dev))
    return offset, float(dev.mean())


def estimate_tempo(onsets: list[float] | np.ndarray, lo: float = 70, hi: float = 160, hint: float | None = None) -> dict | None:
    """Tempo (BPM) and grid phase from note onsets: the BPM whose 1/8 grid the onsets fit best,
    preferring the hint (e.g. librosa's beat tracker) when it fits about as well.

    Scoring uses the 1/8-note grid: coarse enough that random onsets don't fit it (a fine grid
    fits anything), fine enough for typical melodies. Returns None with < 6 onsets."""
    x = np.sort(np.asarray(onsets, dtype=float))
    if len(x) < 6:
        return None
    cands = np.arange(lo, hi + 0.01, 0.25)
    errs = np.array([_grid_error(x, 60 / b / 2)[1] for b in cands])
    # random onsets give ~0.25; penalise faster tempi a little (finer grids fit more by chance)
    score = errs + 0.02 * (cands - lo) / (hi - lo)
    best = float(cands[int(np.argmin(score))])
    if hint:
        h = hint
        while h < lo:
            h *= 2
        while h > hi:
            h /= 2
        near = np.abs(cands - h) <= max(2.0, 0.03 * h)
        if near.any():
            hb = float(cands[near][int(np.argmin(score[near]))])
            if score[cands == hb][0] <= score.min() + 0.02:
                best = hb
    offset, err = _grid_error(x, 60 / best / 2)
    # confidence: 1 at a perfect fit, 0 at random (err 0.25)
    return {"bpm": round(best, 2), "offset": round(offset, 4), "fit_error": round(err, 3),
            "confidence": round(float(np.clip(1 - err / 0.25, 0, 1)), 2)}


def quantize_notes(notes: list[Note], bpm: float, grid: str, strength: float = 1.0, offset: float = 0.0, ends: bool = True) -> tuple[list[Note], int]:
    step = 60 / bpm * GRIDS[grid]
    out, moved = [], 0
    for n in notes:
        qs = offset + round((n.start - offset) / step) * step
        s = n.start + strength * (qs - n.start)
        e = n.end - n.start + s
        if ends:
            qe = offset + round((e - offset) / step) * step
            e = e + strength * (qe - e)
            if e - s < step * 0.5:
                e = s + step if strength >= 1 else max(e, s + 0.5 * step)
        moved += abs(s - n.start) > 1e-4
        out.append(replace(n, start=max(0.0, s), end=max(e, s + 0.01)))
    return out, moved


# ---------------------------------------------------------------- steps


def _mono(notes: list[Note]) -> tuple[list[Note], int]:
    """Resolve overlaps so at most one note sounds: the stronger (conf x velocity x length) wins."""
    notes = sorted(notes, key=lambda n: n.start)
    out: list[Note] = []
    cut = 0
    for n in notes:
        if out and n.start < out[-1].end - 1e-3:
            prev = out[-1]
            w = lambda m: m.conf * m.velocity * m.dur
            if n.start - prev.start < 0.03:  # same onset: keep one
                if w(n) > w(prev):
                    out[-1] = n
                cut += 1
                continue
            out[-1] = replace(prev, end=n.start)
            cut += 1
        out.append(n)
    return out, cut


def _merge(notes: list[Note], gap: float) -> tuple[list[Note], int]:
    by_pitch: dict[int, list[Note]] = {}
    for n in sorted(notes, key=lambda n: n.start):
        by_pitch.setdefault(n.pitch, []).append(n)
    out, merged = [], 0
    for ns in by_pitch.values():
        cur = ns[0]
        for n in ns[1:]:
            if n.start - cur.end <= gap if gap > 0 else n.start < cur.end - 1e-3:
                cur = replace(cur, end=max(cur.end, n.end), velocity=max(cur.velocity, n.velocity),
                              conf=(cur.conf * cur.dur + n.conf * n.dur) / max(cur.dur + n.dur, 1e-9))
                merged += 1
            else:
                out.append(cur)
                cur = n
        out.append(cur)
    return sorted(out, key=lambda n: (n.start, n.pitch)), merged


def _octave_fix(notes: list[Note], window: int = 4) -> tuple[list[Note], int]:
    notes = sorted(notes, key=lambda n: n.start)
    if len(notes) < 3:
        return notes, 0
    p = np.array([n.pitch for n in notes], float)
    out, fixed = [], 0
    for i, n in enumerate(notes):
        nb = np.r_[p[max(0, i - window) : i], p[i + 1 : i + 1 + window]]
        med = np.median(nb)
        best = n.pitch
        if abs(n.pitch - med) >= 9:
            for k in (-24, -12, 12, 24):
                if abs(n.pitch + k - med) < abs(best - med) and abs(n.pitch + k - med) <= 7:
                    best = n.pitch + k
        if best != n.pitch:
            fixed += 1
        out.append(replace(n, pitch=int(best)))
    return out, fixed


def clean(notes: list[Note], opt: CleanupOptions | None = None, onset_hint_bpm: float | None = None) -> CleanupResult:
    opt = opt or CleanupOptions()
    mono = opt.role in MONO_ROLES
    merge_gap = opt.merge_gap if opt.merge_gap is not None else (0.06 if opt.role == "melody" else 0.0)
    octave_fix = opt.octave_fix if opt.octave_fix is not None else opt.role == "melody"
    steps: dict[str, int] = {"in": len(notes)}
    lo, hi = opt.pitch_range or RANGES.get(opt.role, RANGES["other"])
    ns = [n for n in notes if lo <= n.pitch <= hi]
    steps["out_of_range"] = len(notes) - len(ns)

    if mono and octave_fix:
        ns, steps["octave_fixed"] = _octave_fix(ns)
        ns = [n for n in ns if lo <= n.pitch <= hi]

    before = len(ns)
    if ns:
        v90 = float(np.percentile([n.velocity for n in ns], 90))
        ns = [n for n in ns if n.conf >= opt.min_conf and n.velocity >= opt.rel_velocity * v90]
    steps["low_confidence"] = before - len(ns)

    ns, steps["merged"] = _merge(ns, merge_gap)
    if mono:
        ns, steps["overlaps_cut"] = _mono(ns)

    min_len = opt.min_len if opt.min_len is not None else (0.09 if mono else 0.06)
    before = len(ns)
    ns = [n for n in ns if n.dur >= min_len]
    steps["too_short"] = before - len(ns)
    if mono:  # removing blips can expose new same-pitch neighbours
        ns, m2 = _merge(ns, merge_gap)
        steps["merged"] += m2

    key = detect_key(ns)
    steps["snapped_to_key"] = 0
    if key and opt.key_snap and key["r"] >= opt.min_key_r and ns:
        share = np.bincount([n.pitch % 12 for n in ns], minlength=12) / len(ns)
        out = []
        for n in ns:
            p = snap_pitch(n.pitch, key["tonic_pc"], key["mode"]) if share[n.pitch % 12] < opt.rare_share else n.pitch
            steps["snapped_to_key"] += p != n.pitch
            out.append(replace(n, pitch=p))
        ns = out

    tempo = None
    if opt.bpm:
        tempo = {"bpm": float(opt.bpm), "source": "given"}
        if ns:
            tempo["offset"] = round(_grid_error(np.array([n.start for n in ns]), 60 / opt.bpm / 2)[0], 4)
    elif ns:
        tempo = estimate_tempo([n.start for n in ns], hint=onset_hint_bpm)
        if tempo:
            tempo["source"] = "notes"
    steps["quantized"] = 0
    if tempo and opt.quantize and opt.quantize != "off" and opt.strength > 0:
        ns, steps["quantized"] = quantize_notes(ns, tempo["bpm"], opt.quantize, opt.strength, tempo.get("offset", 0.0), opt.quantize_ends)
        # quantizing can stack same-pitch notes on one grid slot
        seen, dedup = set(), []
        for n in sorted(ns, key=lambda n: (n.start, n.pitch)):
            k = (n.pitch, round(n.start, 4))
            if k not in seen:
                seen.add(k)
                dedup.append(n)
        ns = dedup
        if mono:
            ns, _ = _mono(ns)
    steps["out"] = len(ns)
    return CleanupResult(notes=sorted(ns, key=lambda n: (n.start, n.pitch)), key=key, tempo=tempo, steps=steps)
