"""Curate a small reference set of CC0 / CC-BY one-shots and textures from Freesound.

Run from spikes/:  uv run python h_freesound/curate.py [--target 8] [--offline]

Outputs (data/ is git-ignored):
  data/freesound/audio/<category>/<id>.mp3   HQ preview (as served by Freesound)
  data/freesound/audio/<category>/<id>.wav   mono 22050 Hz, leading/trailing silence trimmed
  data/freesound/manifest.json / manifest.csv   kept sounds, labels, measurements, split
  data/freesound/dropped.json                   candidates rejected by local QC, with reasons
  data/freesound/README.md                      attribution list
  data/freesound/cache/search/*.json            cached search responses (reruns cost 0 requests)
  data/freesound/requests.log                   one line per real network request (no key)

The API key is read from FREESOUND_API_KEY in the repo .env and sent only in the
Authorization header. It is never printed or written to disk.
"""
import argparse
import csv
import hashlib
import json
import os
import random
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import librosa
import numpy as np
import requests
import soundfile as sf
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "freesound"
CACHE = OUT / "cache" / "search"
API = "https://freesound.org/apiv2/search/"
SR = 22050

FIELDS = ",".join([
    "id", "name", "tags", "description", "license", "username", "url", "pack", "duration",
    "previews", "brightness", "warmth", "roughness", "hardness", "depth", "pitch", "note_name",
    "note_confidence", "bpm", "single_event", "loopable", "num_downloads", "avg_rating",
])
TIMBRE = ["brightness", "warmth", "roughness", "hardness", "depth"]

# Only CC0 and CC-BY. The filter limits the search; LICENSE_OK re-checks every result.
LICENSE_FILTER = 'license:("Attribution" OR "Creative Commons 0")'
LICENSE_OK = re.compile(r"creativecommons\.org/(publicdomain/zero/1\.0|licenses/by/\d\.\d)/?$")

BRIGHT_BINS = {"dark": "[0 TO 40]", "mid": "[40 TO 62]", "bright": "[62 TO 100]"}
BAD_TAGS = {"loop", "loops", "drumloop", "drum-loop", "beat", "groove", "melody", "melodic",
            "arpeggio", "arp", "sequence", "song", "music", "phrase", "riff", "progression"}
GOOD_TAGS = {"one-shot", "oneshot", "one shot", "single-note", "singlenote", "note", "hit",
             "single", "sample", "multisample", "stab"}

# kind: pitched | drum | texture. queries: search terms. dur: duration filter range.
CATEGORIES = {
    # Pitched one-shots
    "synth_lead": dict(kind="pitched", queries=["synth lead", "lead synth note"]),
    "synth_bass": dict(kind="pitched", queries=["synth bass", "808 bass", "bass one shot"]),
    "pad": dict(kind="pitched", queries=["synth pad", "pad note"], dur=(0.5, 8.0), allow_chord=True),
    "pluck": dict(kind="pitched", queries=["pluck synth", "pluck"]),
    "electric_piano": dict(kind="pitched", queries=["electric piano", "rhodes", "wurlitzer"]),
    "piano_note": dict(kind="pitched", queries=["piano note", "piano single note"]),
    "bell_mallet": dict(kind="pitched", queries=["bell note", "marimba", "vibraphone", "glockenspiel"],
                        min_voiced=0.35),
    "brass_stab": dict(kind="pitched", queries=["brass stab", "synth stab", "brass note", "horn note"],
                       min_voiced=0.4),
    "organ": dict(kind="pitched", queries=["organ note", "organ"]),
    "strings_note": dict(kind="pitched", queries=["violin note", "cello note", "viola note", "strings note"]),
    # Drum one-shots
    "kick": dict(kind="drum", queries=["kick drum", "kick"]),
    "snare": dict(kind="drum", queries=["snare drum", "snare"]),
    "clap": dict(kind="drum", queries=["clap", "handclap"]),
    "closed_hat": dict(kind="drum", queries=["closed hihat", "closed hi-hat", "closed hat"]),
    "open_hat": dict(kind="drum", queries=["open hihat", "open hi-hat", "open hat"], dur=(0.1, 4.0)),
    "percussion": dict(kind="drum", queries=["percussion one shot", "conga", "shaker", "rim shot", "cowbell"]),
    # Textures
    "noise_vinyl": dict(kind="texture", queries=["vinyl crackle", "white noise", "tape hiss"], dur=(1.0, 10.0)),
    "riser": dict(kind="texture", queries=["riser", "uplifter", "sweep riser"], dur=(1.0, 10.0)),
}
# Label sanity: name or tags must mention the category (MUST), and the name must not suggest
# another instrument (NOT). Freesound search is loose (e.g. "EP 2 G#1" under piano, kicks under 808).
MUST = {
    "synth_lead": r"lead", "synth_bass": r"bass|808|sub", "pad": r"pad",
    "pluck": r"pluck|pizz", "electric_piano": r"rhodes|wurli|electric[ -]?piano|e-?piano|\bep\b|keys",
    "piano_note": r"piano", "bell_mallet": r"bell|marimba|vibraphone|glock|xylophone|mallet|tubular|celesta",
    "brass_stab": r"brass|horn|trumpet|trombone|tuba|stab", "organ": r"organ",
    "strings_note": r"violin|viola|cello|string|contrabass",
    "kick": r"kick|kik", "snare": r"snare", "clap": r"clap",
    "closed_hat": r"closed[ -]?h(i|igh)?[ -]?hat|closed[ -]?hat|hat[ -]closed|\bchh\b",
    "open_hat": r"open[ -]?h(i|igh)?[ -]?hat|open[ -]?hat|hat[ -]open|\bohh?\b",
    "percussion": r"conga|bongo|shaker|rim|cowbell|tambourine|clave|woodblock|cabasa|guiro|timbale|tabla|djembe",
    "noise_vinyl": r"vinyl|noise|hiss|crackle|static", "riser": r"riser|uplift|sweep|rise",
}
NOT = {
    "synth_lead": r"bass|kick|kik", "synth_bass": r"kick|kik|drum", "pad": r"piano|bell",
    "electric_piano": r"minor|major|chord", "piano_note": r"\bep\b|electric|rhodes|toy|wurli",
    "bell_mallet": r"bass", "brass_stab": r"sfx|sci-?fi", "closed_hat": r"open|phrase|log ?drum|case",
    "open_hat": r"clos", "percussion": r"kick|snare|hi-?hat",
}
DEFAULT_DUR = {"pitched": (0.3, 6.0), "drum": (0.05, 3.0), "texture": (1.0, 10.0)}


# ---------------------------------------------------------------- network
class Client:
    def __init__(self, offline=False):
        load_dotenv(ROOT / ".env")
        key = os.environ.get("FREESOUND_API_KEY")
        if not key and not offline:
            sys.exit("FREESOUND_API_KEY missing from .env")
        self.s = requests.Session()
        if key:
            self.s.headers["Authorization"] = f"Token {key}"
        self.offline = offline
        self.n_search = 0
        self.n_download = 0
        self._last = 0.0
        self.log = open(OUT / "requests.log", "a")

    def _throttle(self, gap):
        wait = self._last + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    def _get(self, url, params=None, gap=1.1):
        for attempt in range(5):
            self._throttle(gap)
            r = self.s.get(url, params=params, timeout=60)
            if r.status_code == 429:
                time.sleep(30 * (attempt + 1))
                continue
            r.raise_for_status()
            return r
        raise RuntimeError(f"rate-limited repeatedly on {url}")

    def search(self, query, flt, page_size=60):
        params = dict(query=query, filter=flt, fields=FIELDS, page_size=page_size, sort="score")
        h = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:16]
        path = CACHE / f"{h}.json"
        if path.exists():
            return json.loads(path.read_text())["results"]
        if self.offline:
            return []
        r = self._get(API, params)
        self.n_search += 1
        self.log.write(f"{time.strftime('%F %T')} search {query!r} {flt!r}\n")
        data = r.json()
        path.write_text(json.dumps({"params": params, "results": data.get("results", []),
                                    "count": data.get("count")}))
        return data.get("results", [])

    def download(self, url, dest):
        if dest.exists() and dest.stat().st_size > 0:
            return True
        if self.offline:
            return False
        r = self._get(url, gap=0.5)
        self.n_download += 1
        self.log.write(f"{time.strftime('%F %T')} preview {url}\n")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
        return True


# ---------------------------------------------------------------- candidates
def pack_id(s):
    m = re.search(r"/packs/(\d+)/", s.get("pack") or "")
    return m.group(1) if m else None


def licence_name(url):
    if "publicdomain/zero" in url:
        return "CC0-1.0"
    m = re.search(r"licenses/by/(\d\.\d)", url)
    return f"CC-BY-{m.group(1)}" if m else url


def reject_meta(s, spec):
    """Metadata-level exclusions. Returns a reason string or None."""
    if not LICENSE_OK.search(s.get("license") or ""):
        return "licence"
    tags = {t.lower() for t in s.get("tags", [])}
    name = (s.get("name") or "").lower()
    cat = spec["name"]
    if not re.search(MUST[cat], name + " " + " ".join(tags)):
        return "off-category"
    if cat in NOT and re.search(NOT[cat], name):
        return "off-category"
    bad = tags & BAD_TAGS
    if not spec.get("allow_chord"):
        bad |= tags & {"chord", "chords"}
    if bad or re.search(r"\bloop", name):
        return f"tag:{sorted(bad)[0] if bad else 'loop-in-name'}"
    if spec["kind"] != "texture" and s.get("loopable"):
        return "loopable"
    if "preview-hq-mp3" not in (s.get("previews") or {}):
        return "no-preview"
    return None


def gather(client, cat, spec):
    """Search every query x brightness bin; return scored candidate list (best first)."""
    lo, hi = spec.get("dur", DEFAULT_DUR[spec["kind"]])
    base = f"{LICENSE_FILTER} duration:[{lo} TO {hi}]"
    if spec["kind"] == "pitched":
        base += " note_confidence:[0.5 TO *]"
    elif spec["kind"] == "drum":
        base += " single_event:true"
    bins = BRIGHT_BINS if spec["kind"] != "texture" else {"any": None}
    cands = {}
    for q in spec["queries"]:
        for bname, rng in bins.items():
            flt = base + (f" brightness:{rng}" if rng else "")
            for rank, s in enumerate(client.search(q, flt)):
                if s["id"] in cands:
                    continue
                why = reject_meta(s, spec)
                if why:
                    continue
                tags = {t.lower() for t in s.get("tags", [])}
                score = 1.0 / (1 + rank / 15)
                score += 0.3 * bool(tags & GOOD_TAGS)
                score += 0.2 * bool(s.get("single_event"))
                if spec["kind"] == "pitched":
                    score += 0.3 * (s.get("note_confidence") or 0)
                score += 0.1 * min((s.get("num_downloads") or 0) / 2000, 1)
                s["_bin"], s["_query"], s["_score"] = bname, q, score
                cands[s["id"]] = s
    return sorted(cands.values(), key=lambda s: -s["_score"])


def selection_order(cands, kind):
    """Round-robin over brightness bins; inside a bin prefer pitches (octaves) not yet seen."""
    by_bin = defaultdict(list)
    for s in cands:
        by_bin[s["_bin"]].append(s)
    octaves = Counter()
    out = []
    while any(by_bin.values()):
        for b in list(by_bin):
            pool = by_bin[b]
            if not pool:
                continue
            def key(s):
                if kind != "pitched" or not s.get("pitch"):
                    return -s["_score"]
                return -(s["_score"] - 0.25 * octaves[int(np.log2(max(s["pitch"], 20) / 27.5))])
            pool.sort(key=key)
            s = pool.pop(0)
            if kind == "pitched" and s.get("pitch"):
                octaves[int(np.log2(max(s["pitch"], 20) / 27.5))] += 1
            out.append(s)
    return out


# ---------------------------------------------------------------- local QC
def analyse(mp3, kind, spec):
    """Load, trim, QC. Returns (measurements dict, reject reason or None, trimmed audio)."""
    y, _ = librosa.load(mp3, sr=SR, mono=True)
    if len(y) == 0:
        return {}, "empty", None
    peak = float(np.max(np.abs(y)))
    peak_db = 20 * np.log10(peak + 1e-12)
    m = {"peak_db": round(peak_db, 1)}
    if peak_db < -35:
        return m, "near-silent", None
    yt, _ = librosa.effects.trim(y, top_db=40, frame_length=1024, hop_length=256)
    m["trimmed_duration"] = round(len(yt) / SR, 3)
    rms = librosa.feature.rms(y=yt, frame_length=1024, hop_length=256)[0]
    if 20 * np.log10(rms.max() + 1e-12) < -45:
        return m, "near-silent", None
    if kind == "drum":
        if m["trimmed_duration"] < 0.03:
            return m, "too-short", None
        env = librosa.onset.onset_strength(y=yt, sr=SR, hop_length=256)
        on = librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=256, delta=0.2,
                                        wait=int(0.05 * SR / 256), units="frames")
        strong = [o for o in on if env[o] >= 0.3 * env.max()] if len(on) else []
        m["onsets"] = max(len(strong), 1)
        if m["onsets"] > 2:
            return m, f"onsets={m['onsets']}", None
    elif kind == "pitched":
        if m["trimmed_duration"] < 0.2:
            return m, "too-short", None
        seg = yt[: 4 * SR]
        f0, voiced, _ = librosa.pyin(seg, fmin=30, fmax=4200, sr=SR, frame_length=2048, hop_length=256)
        r = librosa.feature.rms(y=seg, frame_length=2048, hop_length=256)[0][: len(f0)]
        loud = r >= r.max() * 10 ** (-30 / 20)  # frames within 30 dB of the peak
        vf = float(np.mean(voiced[loud])) if loud.any() else 0.0
        m["voiced_frac"] = round(vf, 3)
        if vf < spec.get("min_voiced", 0.5) or voiced.sum() < 5:
            return m, f"unvoiced({vf:.2f})", None
        midi = np.round(librosa.hz_to_midi(f0[voiced])).astype(int)
        main = Counter(midi).most_common(1)[0][0]
        pc_off = (midi - main) % 12
        other = ~np.isin(pc_off, [11, 0, 1])  # octave errors count as the same note
        # Stable other notes: runs >= ~100 ms on one rounded pitch outside main's pitch class.
        stable = set()
        run_note, run_len = None, 0
        for n, o in zip(midi, other):
            if o and n == run_note:
                run_len += 1
            else:
                run_note, run_len = (n if o else None), (1 if o else 0)
            if run_len >= 9:
                stable.add(n % 12)
        m["other_note_frac"] = round(float(other.mean()), 3)
        m["n_notes"] = 1 + len(stable)
        if not spec.get("allow_chord") and other.mean() > 0.3 and stable:
            return m, f"multi-note({m['n_notes']})", None
        if len(stable) >= 2 and other.mean() > 0.3:
            return m, f"multi-note({m['n_notes']})", None
        f_main = f0[voiced][np.abs(librosa.hz_to_midi(f0[voiced]) - main) <= 1]
        f = float(np.median(f_main))
        m["f0_hz"] = round(f, 2)
        m["f0_note"] = librosa.hz_to_note(f, unicode=False)
    return m, None, yt


def compare_pitch(s, m):
    """How Freesound's pitch / note_name compare with our pyin f0."""
    out = {}
    f = m.get("f0_hz")
    if not f:
        return out
    if s.get("pitch"):
        c = 1200 * np.log2(s["pitch"] / f)
        out["fs_pitch_cents_off"] = round(float(c), 1)
        out["fs_pitch_ok"] = bool(abs(c) <= 50)
        out["fs_pitch_ok_any_octave"] = bool(abs(((c + 600) % 1200) - 600) <= 50)
    if s.get("note_name"):
        try:
            fs_midi = librosa.note_to_midi(s["note_name"])
            mm = int(round(librosa.hz_to_midi(f)))
            out["fs_note_ok"] = fs_midi == mm
            out["fs_note_ok_pitch_class"] = (fs_midi - mm) % 12 == 0
        except Exception:
            pass
    return out


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=8, help="sounds to keep per category")
    ap.add_argument("--max-tries", type=int, default=22, help="downloads per category before giving up")
    ap.add_argument("--offline", action="store_true", help="use caches only, no network")
    ap.add_argument("--only", nargs="*", help="limit to these categories")
    args = ap.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    client = Client(offline=args.offline)
    kept, dropped, seen = [], [], set()
    stats = {}

    for cat, spec in CATEGORIES.items():
        if args.only and cat not in args.only:
            continue
        kind = spec["kind"]
        spec["name"] = cat
        cands = selection_order(gather(client, cat, spec), kind)
        per_pack, per_user = Counter(), Counter()
        st = Counter(candidates=len(cands))
        tries = 0
        for s in cands:
            if sum(1 for k in kept if k["category"] == cat) >= args.target or tries >= args.max_tries:
                break
            if s["id"] in seen:
                continue
            p, u = pack_id(s), s.get("username")
            if (p and per_pack[p] >= 2) or per_user[u] >= 2:
                continue
            seen.add(s["id"])
            tries += 1
            d = OUT / "audio" / cat
            mp3, wav = d / f"{s['id']}.mp3", d / f"{s['id']}.wav"
            try:
                if not client.download(s["previews"]["preview-hq-mp3"], mp3):
                    st["drop:not-cached"] += 1
                    continue
                m, why, yt = analyse(mp3, kind, spec)
            except Exception as e:  # bad file / network error: record and move on
                m, why, yt = {}, f"error:{type(e).__name__}", None
            if why:
                st[f"drop:{why.split('(')[0].split('=')[0]}"] += 1
                dropped.append({"id": s["id"], "category": cat, "name": s["name"], "reason": why,
                                "url": s["url"], **m})
                for f in (mp3, wav):
                    f.unlink(missing_ok=True)
                continue
            sf.write(wav, yt, SR, subtype="PCM_16")
            per_pack[p] += bool(p)
            per_user[u] += 1
            st["kept"] += 1
            kept.append({
                "id": s["id"], "category": cat, "kind": kind, "name": s["name"],
                "tags": s.get("tags", []), "description": s.get("description", ""),
                "license": s["license"], "license_name": licence_name(s["license"]),
                "username": u, "url": s["url"], "pack_id": p,
                **{k: s.get(k) for k in TIMBRE},
                "fs_pitch": s.get("pitch"), "fs_note_name": s.get("note_name"),
                "fs_note_confidence": s.get("note_confidence"), "fs_bpm": s.get("bpm"),
                "fs_single_event": s.get("single_event"), "duration": s.get("duration"),
                **m, **compare_pitch(s, m),
                "search_query": s["_query"], "brightness_bin": s["_bin"],
                "mp3": str(mp3.relative_to(ROOT)), "wav": str(wav.relative_to(ROOT)),
            })
        stats[cat] = dict(st)
        print(f"{cat:15s} kept {st['kept']:2d}  " +
              " ".join(f"{k}={v}" for k, v in sorted(st.items()) if k.startswith("drop")), flush=True)

    # Stratified ~20% test split, deterministic.
    rng = random.Random(1234)
    by_cat = defaultdict(list)
    for k in kept:
        by_cat[k["category"]].append(k)
    for cat, items in by_cat.items():
        items.sort(key=lambda k: k["id"])
        n_test = max(1, round(0.2 * len(items))) if len(items) >= 3 else 0
        test = set(rng.sample([k["id"] for k in items], n_test))
        for k in items:
            k["split"] = "test" if k["id"] in test else "train"

    (OUT / "manifest.json").write_text(json.dumps(kept, indent=1, ensure_ascii=False))
    (OUT / "dropped.json").write_text(json.dumps(dropped, indent=1, ensure_ascii=False))
    (OUT / "stats.json").write_text(json.dumps(stats, indent=1))
    cols = sorted({c for k in kept for c in k}, key=lambda c: list(kept[0]).index(c) if c in kept[0] else 99)
    with open(OUT / "manifest.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for k in kept:
            w.writerow({**k, "tags": ";".join(k["tags"])})
    write_readme(kept)
    # Remove audio of sounds no longer in the manifest (e.g. after changing the rules).
    if not args.only:
        keep = {k["mp3"] for k in kept} | {k["wav"] for k in kept}
        for f in (OUT / "audio").rglob("*"):
            if f.is_file() and str(f.relative_to(ROOT)) not in keep:
                f.unlink()
    lic = Counter(k["license_name"] for k in kept)
    print(f"\nkept {len(kept)}  dropped {len(dropped)}  licences {dict(lic)}")
    print(f"network this run: {client.n_search} search requests, {client.n_download} preview downloads")


def write_readme(kept):
    lines = [
        "# Freesound reference set (Lattice)", "",
        "Built by `spikes/h_freesound/curate.py`. Audio is Freesound HQ MP3 previews plus trimmed",
        "mono 22050 Hz WAVs. Only CC0 and CC-BY sounds. CC-BY sounds require attribution",
        "(author, title, link, licence) wherever they are used or shown.", "",
        f"{len(kept)} sounds. Labels and measurements are in `manifest.json` / `manifest.csv`.", "",
        "## Attribution", "",
    ]
    for cat in CATEGORIES:
        items = [k for k in kept if k["category"] == cat]
        if not items:
            continue
        lines += [f"### {cat}", ""]
        for k in items:
            lines.append(f"- \"{k['name']}\" by {k['username']} ({k['url']}), licensed "
                         f"[{k['license_name']}]({k['license']})")
        lines.append("")
    (OUT / "README.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
