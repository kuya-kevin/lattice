"""Curate realistic "producer material" from Freesound (CC0 / CC-BY only).

Second Freesound set, next to the one-shot set from curate.py. Where curate.py wants clean single
notes, this one wants the messy input a producer actually brings to Lattice (see docs/session-plan.md,
"Producer workflow"): phone/room recordings of instruments, hummed or whistled ideas, layered takes for
source separation, dry vocals for the vocal chain, slightly loose live drums for quantize, and multi-note
bass / keys phrases for audio-to-MIDI.

Run from spikes/:  uv run python h_freesound/curate_material.py [--target 8] [--offline] [--dry-run]

Outputs (data/ is git-ignored; in a worktree the main checkout's data/ and .env are used):
  data/freesound_material/audio/<category>/<id>.mp3   HQ preview (as served by Freesound)
  data/freesound_material/audio/<category>/<id>.wav   44.1 kHz PCM16, source channel count, untrimmed
  data/freesound_material/manifest.json / .csv        kept sounds, labels, reasons, measurements
  data/freesound_material/dropped.json                candidates rejected by local QC, with reasons
  data/freesound_material/stats.json                  per-category counts and request totals
  data/freesound_material/README.md                   attribution list
  data/freesound_material/cache/search/*.json         cached search responses (reruns cost 0 requests)
  data/freesound_material/requests.log                one line per real network request (no key)

The API key is read from FREESOUND_API_KEY in the repo .env and sent only in the Authorization
header. It is never printed or written to disk.
"""
import argparse
import csv
import hashlib
import json
import os
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


def main_root():
    """Repo root of the main checkout (data/ and .env live there, also when run from a worktree)."""
    if os.environ.get("LATTICE_ROOT"):
        return Path(os.environ["LATTICE_ROOT"])
    root = Path(__file__).resolve().parents[2]
    parts = root.parts
    if ".claude" in parts and "worktrees" in parts:
        return Path(*parts[: parts.index(".claude")])
    return root


ROOT = main_root()
OUT = ROOT / "data" / "freesound_material"
CACHE = OUT / "cache" / "search"
API = "https://freesound.org/apiv2/search/"
SR = 44100
DUR = (3.0, 60.0)
MAX_REQUESTS = 145  # hard budget for one run (searches + preview downloads)

FIELDS = ",".join([
    "id", "name", "tags", "description", "license", "username", "url", "pack", "duration",
    "channels", "samplerate", "type", "previews", "bpm", "num_downloads", "avg_rating", "num_ratings",
])

LICENSE_FILTER = 'license:("Attribution" OR "Creative Commons 0")'
LICENSE_OK = re.compile(r"creativecommons\.org/(publicdomain/zero/1\.0|licenses/by/\d\.\d)/?$")

INSTR = r"piano|guitar|synth|keyboard|keys|ukulele|uke|violin|cello|organ|rhodes|accordion|harmonica|mandolin|banjo"
LOFI = (r"phone|iphone|mobile|cell|smartphone|field[ -]?recording|room|live|recorded|zoom|handheld|"
        r"lo-?fi|dictaphone|voice[ -]?memo|tascam|h4n|h2n|olympus|amateur|rehearsal|practice|busk|street")
FX_TAGS = {"reverb", "delay", "echo", "autotune", "auto-tune", "vocoder", "processed", "effect", "effects",
           "fx", "distortion", "distorted", "pitch-shift", "pitched", "reversed", "glitch", "remix"}
SYNTHETIC = {"generated", "synthesized", "software", "midi", "vst", "daw", "ableton", "fl-studio", "garageband"}

# Each category: queries, all regexes in MUST must match name+tags(+description when "desc" is set),
# NOT must not match the name+tags, plus a reason template and local QC kind.
DAW_DESC = r"rendered|ableton|fl ?studio|flstudio|programmed|drum machine|\bvst\b|garageband|logic pro|sample pack"
NOTE_NAME = r"^\d+ - [a-g]|\b[a-g](s|#|b)?\d_rr|_rr\d|^[a-g](s|#)?\d\b|one octave"

CATEGORIES = {
    "phone_instrument": dict(
        desc="instrument (piano / guitar / synth) recorded on a phone or in a room, with room noise",
        queries=["piano iphone recording", "piano phone", "guitar phone recording", "guitar iphone",
                 "busking guitar", "acoustic guitar field recording", "upright piano recording",
                 "piano room recording"],
        must=[INSTR, LOFI], must_in_desc=True,
        not_=r"\bsinging|\bvocal|\bvoice\b|\bsing\b|drum|loop|sample pack|one[ -]?shot|\bsfx\b|soundaction|"
             r"typing|typewriter|notification|zipp|holder|thrown|impact|mouse|lighter|scary|horror|"
             r"strings changing|tuning|detuned|multisample|broken|" + NOTE_NAME,
        not_desc=DAW_DESC + r"|soundactions? dataset|multisample|computer keyboard|typing",
        bad_tags=FX_TAGS | SYNTHETIC | {"single-note", "one-shot", "oneshot", "multisample", "typing"},
        qc="noisy"),
    "hum_whistle_beatbox": dict(
        desc="hummed, whistled or beatboxed idea, phone-quality voice",
        queries=["humming melody", "hum melody voice", "whistling melody", "whistling tune",
                 "beatbox", "beatbox beat"],
        must=[r"hum(s|ming|med)?\b|whistl|beat[ -]?box"],
        not_=r"\bwind\b|kettle|referee|train|bird|machine|motor|electric hum|mains|\bbuzz|fridge|refrigerator|"
             r"transformer|neon|ambien|60 ?hz|50 ?hz|wolf|dog|steam|music ?box|instrumental|tin whistle|synth|"
             r"roland|flute|radio|effects|celtic|car beatbox",
        not_desc=r"synthesi[sz]ed|roland|fl ?studio|flstudio|tin whistle|synthetic|music box",
        bad_tags=FX_TAGS | SYNTHETIC | {"electrical", "electricity", "drone", "noise", "industrial", "appliance"},
        qc="voice"),
    "layered_multi": dict(
        desc="several sources at once (voice + instrument, band, ensemble) for source separation",
        queries=["singing guitar", "busker singing", "piano singing", "guitar vocals", "band rehearsal",
                 "street musicians", "jam session band"],
        must=[r"sing|vocal|voice|band|rehearsal|ensemble|musicians|jam|busk|duo|trio|song"],
        # needs evidence of more than one source (in name, tags or description)
        multi=r"((sing|vocal|voice|song)[^.]{0,80}(guitar|piano|ukulele|keyboard|accordion|drum|band)|"
              r"(guitar|piano|ukulele|keyboard|accordion|drum)[^.]{0,80}(sing|vocal|voice)|"
              r"\bband\b|ensemble|\bjam\b|\bduo\b|\btrio\b|rehears|guitarists|musicians)",
        not_=r"\bloop\b|one[ -]?shot|\bsfx\b|crowd|applause|bird|one note|scales?\b|blast|train|"
             r"ambian|ambien|feedback|bugle|versilian|triangle|gong|bowls|didgeridoo|\bdog",
        not_desc=r"one-shot from versilian|\bdog\b|distortion added|" + DAW_DESC,
        bad_tags=SYNTHETIC | {"one-shot", "oneshot", "speech"},
        qc="music"),
    "dry_vocal": dict(
        desc="dry sung vocal take (a cappella, no effects) for vocal-chain tests",
        queries=["acapella", "acapella vocal dry", "dry vocal singing", "female vocal acapella",
                 "male vocal acapella", "sibilance", "vocal take", "singing voice dry"],
        must=[r"acapella|a[ -]?capp?ella|vocal|sing|voice|sung"],
        not_=r"speech|talk|spoken|narrat|scream|choir|chant|robot|drum|guitar|piano|\bloop\b|chop|stab|shout|"
             r"laugh|throat|strings|flute|wet|scale|sketch|beatbox|rap\b|reverb|moo\b|animal|toon",
        not_desc=r"reverb added|with reverb|autotune|auto-tune|pitch[ -]?shift|vocoder|processed|grunt|"
                 r"video ?game|game character|for a (male|female) character",
        bad_tags=FX_TAGS | SYNTHETIC | {"speech", "talking", "spoken", "choir", "processed-vocal", "rap"},
        qc="voice"),
    "drum_loop_live": dict(
        desc="live / played drum groove, slightly off the grid, for quantize tests",
        queries=["live drums groove", "drummer groove", "acoustic drum beat live", "drum loop acoustic live",
                 "drum beat recorded", "drum kit performance"],
        must=[r"drum|kit|snare|groove|beat|break"],
        not_=r"one[ -]?shot|single hit|hits|bass drum|splash|\bride\b|china|crash|machine|808|909|electronic|"
             r"edm|trap|\bsynth|bongo|djembe|tabla|conga|cajon|steel ?drum|tongue drum|hang ?drum|marching|"
             r"versilian|beatbox|pandeiro|industrial",
        not_desc=DAW_DESC + r"|one-shot",
        bad_tags=SYNTHETIC | {"one-shot", "oneshot", "single-hit", "drum-machine", "electronic", "808", "909"},
        qc="drums"),
    "bass_keys_phrase": dict(
        desc="multi-note bass line or piano / keys phrase for audio-to-MIDI",
        queries=["bass guitar riff", "bass line", "synth bass line", "piano melody", "piano phrase",
                 "rhodes chords"],
        must=[r"bass|piano|rhodes|keys|wurli|keyboard|organ"],
        groups={"bass": r"bass", "keys": r"piano|rhodes|keys|wurli|keyboard|organ"},
        not_=r"one[ -]?shot|single note|\bnote [a-g]|drum|\bkick|vocal|sing|\bsfx\b|string|cello|violin|"
             r"bassoon|clarinet|808 kick|backwards|reverse|\bfx\b|" + NOTE_NAME,
        bad_tags=FX_TAGS | {"one-shot", "oneshot", "single-note", "drums", "vocal", "singing"},
        qc="phrase"),
}


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

    @property
    def n(self):
        return self.n_search + self.n_download

    def _throttle(self, gap):
        wait = self._last + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    def _get(self, url, params=None, gap=1.1):
        if self.n >= MAX_REQUESTS:
            raise BudgetExceeded()
        for attempt in range(5):
            self._throttle(gap)
            r = self.s.get(url, params=params, timeout=90)
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
        self.log.flush()
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
        self.log.flush()
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
        return True


class BudgetExceeded(Exception):
    pass


# ---------------------------------------------------------------- candidates
def pack_id(s):
    m = re.search(r"/packs/(\d+)/", s.get("pack") or "")
    return m.group(1) if m else None


def licence_name(url):
    if "publicdomain/zero" in url:
        return "CC0-1.0"
    m = re.search(r"licenses/by/(\d\.\d)", url)
    return f"CC-BY-{m.group(1)}" if m else url


def text_of(s, desc=False):
    t = (s.get("name") or "") + " " + " ".join(s.get("tags", []))
    if desc:
        t += " " + re.sub(r"<[^>]+>", " ", s.get("description") or "")
    return t.lower()


def reject_meta(s, spec):
    """Metadata-level exclusions. Returns a reason string or None."""
    if not LICENSE_OK.search(s.get("license") or ""):
        return "licence"
    if not (DUR[0] <= (s.get("duration") or 0) <= DUR[1]):
        return "duration"
    nt = text_of(s)
    full = text_of(s, desc=True)
    for i, pat in enumerate(spec["must"]):
        # the first MUST (what it is) has to be in name/tags; later ones (recording condition) may be in desc
        hay = full if (spec.get("must_in_desc") and i > 0) else nt
        if not re.search(pat, hay):
            return "off-category"
    if spec.get("not_") and re.search(spec["not_"], nt):
        return "off-category:not"
    if spec.get("not_desc") and re.search(spec["not_desc"], full):
        return "off-category:desc"
    if spec.get("multi") and not re.search(spec["multi"], full):
        return "not-multi-source"
    tags = {t.lower() for t in s.get("tags", [])}
    bad = tags & spec.get("bad_tags", set())
    if bad:
        return f"tag:{sorted(bad)[0]}"
    if "preview-hq-mp3" not in (s.get("previews") or {}):
        return "no-preview"
    return None


def gather(client, spec):
    """Search every query; return candidates grouped by query (each list best first)."""
    flt = f"{LICENSE_FILTER} duration:[{DUR[0]} TO {DUR[1]}]"
    by_q, seen = {}, set()
    for q in spec["queries"]:
        out = []
        for rank, s in enumerate(client.search(q, flt)):
            if s["id"] in seen or reject_meta(s, spec):
                continue
            seen.add(s["id"])
            score = 1.0 / (1 + rank / 15)
            score += 0.15 * min((s.get("num_downloads") or 0) / 1000, 1)
            score += 0.05 * (s.get("avg_rating") or 0) / 5 * min((s.get("num_ratings") or 0) / 3, 1)
            if spec["qc"] == "noisy" and re.search(r"phone|iphone|mobile|cell|voice memo|dictaphone",
                                                   text_of(s, desc=True)):
                score += 0.3
            s["_query"], s["_score"] = q, score
            out.append(s)
        by_q[q] = sorted(out, key=lambda s: -s["_score"])
    return by_q


def round_robin(by_q):
    pools = [list(v) for v in by_q.values()]
    out = []
    while any(pools):
        for p in pools:
            if p:
                out.append(p.pop(0))
    return out


# ---------------------------------------------------------------- local QC
def measure(y, sr):
    """Generic measurements on a mono signal: level, noise floor, bandwidth, sibilance."""
    m = {}
    peak = float(np.max(np.abs(y)))
    m["peak_db"] = round(20 * np.log10(peak + 1e-12), 1)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    rdb = 20 * np.log10(rms + 1e-9)
    m["rms_db"] = round(float(20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)), 1)
    live = rdb[rdb > -100] if (rdb > -100).any() else rdb  # ignore digital silence (fades, padding)
    m["noise_floor_db"] = round(float(np.percentile(live, 10)), 1)
    m["snr_est_db"] = round(float(np.percentile(live, 95) - np.percentile(live, 10)), 1)
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    loud = rdb[: S.shape[1]] > np.percentile(rdb, 50)
    spec = S[:, loud].mean(axis=1) if loud.any() else S.mean(axis=1)
    cum = np.cumsum(spec) / (spec.sum() + 1e-12)
    m["rolloff95_hz"] = int(freqs[np.searchsorted(cum, 0.95)])
    m["hf_above_8k_db"] = round(float(10 * np.log10(spec[freqs > 8000].sum() / (spec.sum() + 1e-12) + 1e-12)), 1)
    # Sibilance: share of active frames whose 4.5-10 kHz energy is within 3 dB of (or above) 0.1-4 kHz.
    hi = S[(freqs >= 4500) & (freqs <= 10000)].sum(axis=0)
    lo = S[(freqs >= 100) & (freqs < 4000)].sum(axis=0)
    loud_any = rdb[: S.shape[1]] > np.percentile(rdb, 95) - 30
    sib = (hi > 0.5 * lo) & loud_any
    m["sibilant_frac"] = round(float(sib.sum() / max(loud_any.sum(), 1)), 3)
    return m


def pitch_track(y, sr, fmin=50, fmax=1600, max_s=30):
    seg = librosa.resample(y[: max_s * sr], orig_sr=sr, target_sr=16000)
    f0, voiced, _ = librosa.pyin(seg, fmin=fmin, fmax=fmax, sr=16000, frame_length=2048, hop_length=320)
    return f0, voiced


def note_count(f0, voiced, min_frames=5):
    """Distinct stable notes (runs >= min_frames on one rounded MIDI pitch) and their pitch classes."""
    if voiced.sum() < min_frames:
        return 0, 0
    midi = np.where(voiced, np.round(librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0))), -1).astype(int)
    notes, run_note, run_len = [], None, 0
    for n in midi:
        if n >= 0 and n == run_note:
            run_len += 1
        else:
            run_note, run_len = n, 1
        if run_len == min_frames and n >= 0:
            notes.append(int(n))
    return len(notes), len(set(notes))


def grid_stats(y, sr):
    """Tempo, onset count and onset deviation from a 16th-note grid anchored on the beat tracker."""
    hop = 128  # ~2.9 ms at 44.1 kHz, so deviations are not quantized to one 11.6 ms frame
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, beats = librosa.beat.beat_track(onset_envelope=env, sr=sr, hop_length=hop)
    tempo = float(np.atleast_1d(tempo)[0])
    on = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, units="time", backtrack=False,
                                    wait=int(0.04 * sr / hop))
    m = {"tempo_bpm": round(tempo, 1), "n_onsets": int(len(on))}
    if tempo > 0 and len(beats) >= 4 and len(on) >= 8:
        bt = librosa.frames_to_time(beats, sr=sr, hop_length=hop)
        # Grid: 4 subdivisions between consecutive tracked beats (follows tempo drift).
        grid = np.concatenate([np.linspace(a, b, 5)[:-1] for a, b in zip(bt[:-1], bt[1:])] + [bt[-1:]])
        inside = on[(on >= bt[0] - 0.05) & (on <= bt[-1] + 0.05)]
        if len(inside):
            dev = np.abs(inside[:, None] - grid[None, :]).min(axis=1) * 1000
            m["grid_dev_median_ms"] = round(float(np.median(dev)), 1)
            m["grid_dev_p90_ms"] = round(float(np.percentile(dev, 90)), 1)
            ibi = np.diff(bt)
            m["beat_interval_cv"] = round(float(ibi.std() / ibi.mean()), 3)
    return m


def analyse(mp3, spec):
    """Load stereo-preserving at 44.1 kHz, measure, QC. Returns (measurements, reason or None, audio)."""
    y, _ = librosa.load(mp3, sr=SR, mono=False)
    if y.ndim == 1:
        y = y[None, :]
    if y.shape[-1] == 0:
        return {}, "empty", None
    mono = y.mean(axis=0)
    m = {"preview_channels": int(y.shape[0]), "preview_duration": round(y.shape[-1] / SR, 2)}
    if y.shape[0] == 2:
        # "fake stereo": identical channels
        diff = np.abs(y[0] - y[1]).max()
        m["stereo_identical"] = bool(diff < 1e-3)
    m.update(measure(mono, SR))
    if m["peak_db"] < -35:
        return m, "near-silent", None
    kind = spec["qc"]
    if kind == "voice" or kind == "noisy" or kind == "music":
        f0, voiced = pitch_track(mono, SR)
        m["voiced_frac"] = round(float(np.mean(voiced)), 3)
        n, d = note_count(f0, voiced)
        m["n_notes"], m["n_distinct_pitches"] = n, d
    if kind == "voice" and spec is CATEGORIES["dry_vocal"] and m["voiced_frac"] < 0.2:
        return m, f"unvoiced({m['voiced_frac']})", None
    if kind == "drums":
        m.update(grid_stats(mono, SR))
        if m["n_onsets"] < 8:
            return m, f"few-onsets({m['n_onsets']})", None
    if kind == "phrase":
        on = librosa.onset.onset_detect(y=mono, sr=SR, hop_length=512, units="time")
        m["n_onsets"] = int(len(on))
        f0, voiced = pitch_track(mono, SR, fmin=30, fmax=2000)
        n, d = note_count(f0, voiced)
        m["voiced_frac"] = round(float(np.mean(voiced)), 3)
        m["n_notes"], m["n_distinct_pitches"] = n, d
        if m["n_onsets"] < 4:
            return m, f"few-onsets({m['n_onsets']})", None
    return m, None, y


def reason(cat, spec, s, m):
    """Short human-readable justification for the label."""
    tags = {t.lower() for t in s.get("tags", [])}
    hits = sorted(t for t in tags if re.search("|".join(spec["must"]), t))[:4]
    bits = [f"query '{s['_query']}'"]
    if hits:
        bits.append("tags " + ", ".join(hits))
    if cat == "phone_instrument":
        hay = text_of(s, desc=True)
        cond = sorted(set(re.findall(LOFI, hay)))[:3]
        if cond:
            bits.append("recording: " + ", ".join(cond))
        bits.append(f"noise floor {m['noise_floor_db']} dB, rolloff95 {m['rolloff95_hz']} Hz")
    elif cat == "hum_whistle_beatbox":
        bits.append(f"voiced {m.get('voiced_frac')}, rolloff95 {m['rolloff95_hz']} Hz")
    elif cat == "layered_multi":
        bits.append(f"voiced {m.get('voiced_frac')}, {m.get('n_distinct_pitches')} distinct pitches")
    elif cat == "dry_vocal":
        bits.append(f"voiced {m.get('voiced_frac')}, sibilant frames {m['sibilant_frac']:.0%}"
                    + (" (sibilant)" if m.get("sibilant") else ""))
    elif cat == "drum_loop_live":
        bits.append(f"{m.get('tempo_bpm')} bpm, {m.get('n_onsets')} onsets, median grid dev "
                    f"{m.get('grid_dev_median_ms')} ms")
    elif cat == "bass_keys_phrase":
        bits.append(f"{m.get('n_onsets')} onsets, {m.get('n_distinct_pitches')} distinct pitches")
    return f"{spec['desc']}; " + "; ".join(bits)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=8, help="sounds to keep per category")
    ap.add_argument("--max-tries", type=int, default=13, help="downloads per category before giving up")
    ap.add_argument("--offline", action="store_true", help="use caches only, no network")
    ap.add_argument("--dry-run", action="store_true", help="search (cached) and list picks; no downloads")
    ap.add_argument("--only", nargs="*", help="limit to these categories")
    args = ap.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    client = Client(offline=args.offline)
    kept, dropped, seen, stats = [], [], set(), {}

    # Search everything first (cheap, cached), then download per category.
    searched = {}
    for cat, spec in CATEGORIES.items():
        if args.only and cat not in args.only:
            continue
        searched[cat] = round_robin(gather(client, spec))
        print(f"{cat:20s} {len(searched[cat])} candidates after metadata filters", flush=True)
    if args.dry_run:
        for cat, cands in searched.items():
            print(f"\n== {cat}")
            for s in cands[: args.target + 8]:
                print(f"  {s['id']:>7} {s['duration']:5.1f}s ch{s.get('channels')} {s['_query'][:22]:22s} "
                      f"{s['name'][:60]}")
        print(f"\nnetwork this run: {client.n_search} searches")
        return

    budget_hit = False
    for cat, cands in searched.items():
        spec = CATEGORIES[cat]
        per_pack, per_user, per_group = Counter(), Counter(), Counter()
        st = Counter(candidates=len(cands))
        tries = 0
        for s in cands:
            if st["kept"] >= args.target or tries >= args.max_tries or budget_hit:
                break
            if s["id"] in seen:
                continue
            p, u = pack_id(s), s.get("username")
            if (p and per_pack[p] >= 2) or per_user[u] >= 2:
                continue
            grp = None
            if spec.get("groups"):
                grp = next((g for g, pat in spec["groups"].items() if re.search(pat, text_of(s))), None)
                if per_group[grp] >= -(-args.target // len(spec["groups"])):
                    continue
            seen.add(s["id"])
            tries += 1
            d = OUT / "audio" / cat
            mp3, wav = d / f"{s['id']}.mp3", d / f"{s['id']}.wav"
            try:
                if not client.download(s["previews"]["preview-hq-mp3"], mp3):
                    st["drop:not-cached"] += 1
                    continue
                m, why, y = analyse(mp3, spec)
            except BudgetExceeded:
                budget_hit = True
                break
            except Exception as e:  # bad file / network error: record and move on
                m, why, y = {}, f"error:{type(e).__name__}", None
            if why:
                st[f"drop:{why.split('(')[0]}"] += 1
                dropped.append({"id": s["id"], "category": cat, "name": s["name"], "reason": why,
                                "url": s["url"], **m})
                for f in (mp3, wav):
                    f.unlink(missing_ok=True)
                continue
            sf.write(wav, y.T, SR, subtype="PCM_16")
            if cat == "dry_vocal":
                m["sibilant"] = bool(m["sibilant_frac"] >= 0.08)
            per_pack[p] += bool(p)
            per_user[u] += 1
            per_group[grp] += 1
            if grp:
                m["subgroup"] = grp
            st["kept"] += 1
            kept.append({
                "id": s["id"], "category": cat, "reason": reason(cat, spec, s, m), "name": s["name"],
                "tags": s.get("tags", []), "description": s.get("description", ""),
                "license": s["license"], "license_name": licence_name(s["license"]),
                "username": u, "url": s["url"], "pack_id": p,
                "duration": s.get("duration"), "channels": s.get("channels"),
                "fs_samplerate": s.get("samplerate"), "fs_type": s.get("type"), "fs_bpm": s.get("bpm"),
                "num_downloads": s.get("num_downloads"), **m, "search_query": s["_query"],
                "mp3": str(mp3.relative_to(ROOT)), "wav": str(wav.relative_to(ROOT)),
            })
        stats[cat] = dict(st)
        print(f"{cat:20s} kept {st['kept']:2d}  " +
              " ".join(f"{k}={v}" for k, v in sorted(st.items()) if k.startswith("drop")), flush=True)
    if budget_hit:
        print(f"!! request budget ({MAX_REQUESTS}) reached; stopped early", flush=True)

    (OUT / "manifest.json").write_text(json.dumps(kept, indent=1, ensure_ascii=False))
    (OUT / "dropped.json").write_text(json.dumps(dropped, indent=1, ensure_ascii=False))
    stats["_network_this_run"] = {"searches": client.n_search, "downloads": client.n_download}
    (OUT / "stats.json").write_text(json.dumps(stats, indent=1))
    if kept:
        cols = list(dict.fromkeys(c for k in kept for c in k))
        with open(OUT / "manifest.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for k in kept:
                w.writerow({**k, "tags": ";".join(k["tags"])})
    write_readme(kept)
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
        "# Freesound producer-material set (Lattice)", "",
        "Built by `spikes/h_freesound/curate_material.py`. Realistic, messy input for the producer",
        "workflow: phone/room instrument recordings, hummed/whistled/beatboxed ideas, layered takes",
        "for source separation, dry vocals for the vocal chain, loose live drums for quantize, and",
        "multi-note bass / keys phrases for audio-to-MIDI.", "",
        "Audio is the Freesound HQ MP3 preview plus a 44.1 kHz PCM16 WAV decoded from it (channel count",
        "kept, not trimmed or normalized). Only CC0 and CC-BY sounds. CC-BY sounds require attribution",
        "(author, title, link, licence) wherever they are used or shown.", "",
        f"{len(kept)} sounds. Labels, reasons and measurements are in `manifest.json` / `manifest.csv`.", "",
        "## Attribution", "",
    ]
    for cat, spec in CATEGORIES.items():
        items = [k for k in kept if k["category"] == cat]
        if not items:
            continue
        lines += [f"### {cat}", "", f"_{spec['desc']}_", ""]
        for k in items:
            lines.append(f"- \"{k['name']}\" by {k['username']} ({k['url']}), licensed "
                         f"[{k['license_name']}]({k['license']})")
        lines.append("")
    (OUT / "README.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
