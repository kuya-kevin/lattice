"""Synthetic phone-quality set with known MIDI, for scoring audio-to-MIDI.

    spikes/j_evals/env.sh amt python spikes/j_evals/synth_set.py

Four categories, four clips each (8 bars, random key/tempo, fixed seeds):
- hum:     monophonic melody, GM voice "oohs"/"aahs" and flute as a whistle stand-in (TimGM6mb's
           whistle preset plays ~10 semitones flat), with per-note detune and vibrato
- bass:    monophonic bass line, GM finger/pick/fretless/synth bass
- keys:    piano / e-piano, triads on beats 1 and 3 plus a right-hand melody (polyphonic)
- layered: hum + piano chords + bass mixed (what a layered voice note looks like)
Rendered with TinySoundFont and the TimGM6mb GM SoundFont that ships with pretty_midi (local
test use only). Each clip is written clean and "phone" degraded:
  room reverb (RT60 ~0.35-0.6 s) -> 120 Hz high-pass, 7.5 kHz low-pass -> background noise
  (pink + 50 Hz mains hum, SNR 12-20 dB) -> fast AGC/compression -> AAC 64 kb/s round trip.
Writes $LATTICE_OUT/amt/synth/{truth/<id>.mid, audio/<id>__clean.wav, audio/<id>__phone.wav,
manifest.json}. Truth MIDI has one instrument per part, named hum / bass / keys.
"""
import io
import json
import os
from pathlib import Path

import av
import numpy as np
import pretty_midi
import soundfile as sf
import tinysoundfont
from scipy.signal import butter, fftconvolve, lfilter, sosfilt

SR = 44100
OUT = Path(os.environ["LATTICE_OUT"]) / "amt" / "synth"
SF2 = Path(pretty_midi.__file__).parent / "TimGM6mb.sf2"
MAJOR, MINOR = [0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10]
PROGRAMS = {"hum": [53, 53, 52, 73], "bass": [33, 34, 35, 38], "keys": [0, 0, 4, 1]}


def scale_notes(tonic, mode, lo, hi):
    steps = MAJOR if mode == "major" else MINOR
    return [p for p in range(lo, hi + 1) if (p - tonic) % 12 in steps]


def melody(rng, pool, bars, spb, start_idx=None, rest_p=0.12):
    """Stepwise-ish monophonic line: (pitch, start, end) in seconds."""
    notes, t, end = [], 0.0, bars * 4 * spb
    i = start_idx if start_idx is not None else len(pool) // 2
    while t < end - 1e-6:
        dur = rng.choice([0.5, 1, 1, 1.5, 2]) * spb
        dur = min(dur, end - t)
        if rng.random() > rest_p:
            i = int(np.clip(i + rng.choice([-2, -1, -1, 0, 1, 1, 2, 3, -3]), 0, len(pool) - 1))
            notes.append((pool[i], t, t + dur * 0.92))
        t += dur
    return notes


def chords(rng, tonic, mode, bars, spb):
    degrees = [0, 5, 3, 4] if mode == "major" else [0, 5, 3, 6]  # I vi IV V / i VI iv VII-ish
    steps = MAJOR if mode == "major" else MINOR
    out = []
    for b in range(bars):
        d = degrees[b % 4] if rng.random() > 0.2 else int(rng.integers(0, 7))
        root = 48 + tonic + steps[d]
        triad = [root, 48 + tonic + steps[(d + 2) % 7] + 12 * ((d + 2) // 7), 48 + tonic + steps[(d + 4) % 7] + 12 * ((d + 4) // 7)]
        for half in (0, 2):
            s = (b * 4 + half) * spb
            for p in triad:
                out.append((int(p), s, s + 1.9 * spb))
    return out


def bassline(rng, tonic, mode, bars, spb):
    pool = scale_notes(tonic, mode, 33, 52)
    roots = [p for p in pool if (p - tonic) % 12 == 0]
    notes = []
    for b in range(bars):
        root = roots[0] if b % 2 == 0 else int(rng.choice(pool[:8]))
        pattern = rng.choice([[0, 1, 2, 3], [0, 1.5, 2, 3], [0, 2, 2.5, 3.5], [0, 0.5, 2, 3]])
        for k, beat in enumerate(pattern):
            p = root if k == 0 else int(rng.choice([root, root + 7 if root + 7 in pool else root, *pool[:10]]))
            s = (b * 4 + beat) * spb
            notes.append((p, s, s + 0.45 * spb))
    return notes


def render(parts, seconds, rng, vibrato=False):
    """parts: list of (program, notes, gain). Each part on its own channel; mono float32 out."""
    synth = tinysoundfont.Synth(samplerate=SR)
    sfid = synth.sfload(str(SF2))
    events = []
    for ch, (prog, notes, _) in enumerate(parts):
        synth.program_select(ch, sfid, 0, prog)
        synth.pitchbend_range(ch, 2.0)
        for p, s, e in notes:
            vel = int(np.clip(rng.normal(90, 12), 50, 120))
            detune = rng.normal(0, 12) if vibrato and prog in (52, 53, 73) else 0.0  # cents
            events.append((s, 1, ch, p, vel, detune))
            events.append((e, 0, ch, p, 0, 0.0))
    events.sort(key=lambda x: (x[0], x[1]))
    total = int((seconds + 1.0) * SR)
    out = np.zeros((total, 2), dtype=np.float32)
    pos, block = 0, 256
    detune_now = {}
    ei = 0
    while pos < total:
        while ei < len(events) and events[ei][0] * SR <= pos:
            t, on, ch, p, vel, det = events[ei]
            if on:
                synth.noteon(ch, p, vel)
                detune_now[ch] = det
            else:
                synth.noteoff(ch, p)
            ei += 1
        if vibrato:
            for ch, (prog, _, _) in enumerate(parts):
                if prog in (52, 53, 73):
                    cents = detune_now.get(ch, 0.0) + 18 * np.sin(2 * np.pi * 5.3 * pos / SR)
                    synth.pitchbend(ch, int(8192 + 8191 * np.clip(cents / 200, -1, 1)))
        n = min(block, total - pos)
        out[pos : pos + n] = np.frombuffer(synth.generate(n), dtype=np.float32).reshape(-1, 2)
        pos += n
    return out.mean(axis=1)


def render_parts(parts, seconds, rng):
    """Render each part alone (so per-part gains are exact) and mix."""
    mix = None
    for prog, notes, gain in parts:
        y = render([(prog, notes, gain)], seconds, rng, vibrato=True)
        y = gain * y / max(np.sqrt(np.mean(y**2)), 1e-9) * 0.1
        mix = y if mix is None else mix + y
    return mix


def pink(n, rng):
    w = rng.standard_normal(n)
    b = [0.049922035, -0.095993537, 0.050612699, -0.004408786]
    a = [1, -2.494956002, 2.017265875, -0.522189400]
    return lfilter(b, a, w)


def aac_roundtrip(y, sr, bitrate=64000):
    buf = io.BytesIO()
    with av.open(buf, "w", format="mp4") as c:
        st = c.add_stream("aac", rate=sr)
        st.bit_rate = bitrate
        st.layout = "mono"
        frame_len = 1024
        pcm = np.clip(y, -1, 1).astype(np.float32)
        for i in range(0, len(pcm), frame_len):
            fr = av.AudioFrame.from_ndarray(pcm[None, i : i + frame_len], format="fltp", layout="mono")
            fr.sample_rate = sr
            for pkt in st.encode(fr):
                c.mux(pkt)
        for pkt in st.encode(None):
            c.mux(pkt)
    buf.seek(0)
    chunks = []
    with av.open(buf) as c:
        for fr in c.decode(audio=0):
            chunks.append(fr.to_ndarray().mean(axis=0))
    z = np.concatenate(chunks)
    # AAC adds priming delay; align back to the input by cross-correlating the first second.
    lag = int(np.argmax(np.correlate(z[: sr + 4096], y[:sr], mode="valid")))
    z = z[lag : lag + len(y)]
    return np.pad(z, (0, len(y) - len(z)))


def phone(y, rng):
    rt60 = rng.uniform(0.35, 0.6)
    t = np.arange(int(rt60 * SR)) / SR
    ir = rng.standard_normal(len(t)) * np.exp(-6.9 * t / rt60)
    ir[0] = 0
    ir = ir / np.sqrt(np.sum(ir**2)) * rng.uniform(0.3, 0.5)
    ir[0] = 1.0
    y = fftconvolve(y, ir)[: len(y)]
    y = sosfilt(butter(2, 120, "hp", fs=SR, output="sos"), y)
    y = sosfilt(butter(4, 7500, "lp", fs=SR, output="sos"), y)
    snr = rng.uniform(12, 20)
    noise = pink(len(y), rng) + 0.3 * np.sin(2 * np.pi * 50 * np.arange(len(y)) / SR) * np.std(pink(SR, rng))
    noise *= np.sqrt(np.mean(y**2) / np.mean(noise**2)) / 10 ** (snr / 20)
    y = y + noise
    env = np.sqrt(lfilter([0.002], [1, -0.998], y**2) + 1e-8)  # fast AGC, ~10 ms
    y = y / env**0.5 * np.sqrt(np.mean(env))
    y = 0.5 * y / np.max(np.abs(y))
    return aac_roundtrip(y, SR), {"rt60": round(rt60, 2), "snr_db": round(snr, 1)}


def main():
    (OUT / "truth").mkdir(parents=True, exist_ok=True)
    (OUT / "audio").mkdir(parents=True, exist_ok=True)
    manifest = []
    for cat_i, cat in enumerate(["hum", "bass", "keys", "layered"]):
        for k in range(4):
            rng = np.random.default_rng(1000 * cat_i + k)
            tonic, mode = int(rng.integers(0, 12)), str(rng.choice(["major", "minor"]))
            bpm = float(rng.integers(80, 121))
            spb, bars = 60 / bpm, 8
            seconds = bars * 4 * spb
            parts = {}
            if cat in ("hum", "layered"):
                prog = PROGRAMS["hum"][k] if cat == "hum" else 53
                lo, hi = (67, 84) if prog == 73 else (55, 74)
                parts["hum"] = (prog, melody(rng, scale_notes(tonic, mode, lo, hi), bars, spb), 1.0)
            if cat in ("bass", "layered"):
                prog = PROGRAMS["bass"][k] if cat == "bass" else 33
                parts["bass"] = (prog, bassline(rng, tonic, mode, bars, spb), 0.8 if cat == "layered" else 1.0)
            if cat in ("keys", "layered"):
                prog = PROGRAMS["keys"][k] if cat == "keys" else 0
                notes = chords(rng, tonic, mode, bars, spb)
                if cat == "keys":
                    notes += melody(rng, scale_notes(tonic, mode, 67, 84), bars, spb, rest_p=0.25)
                parts["keys"] = (prog, notes, 0.6 if cat == "layered" else 1.0)
            y = render_parts(list(parts.values()), seconds, rng)
            y = 0.5 * y / np.max(np.abs(y))
            yp, deg = phone(y, rng)
            cid = f"{cat}_{k}"
            sf.write(OUT / "audio" / f"{cid}__clean.wav", y, SR)
            sf.write(OUT / "audio" / f"{cid}__phone.wav", yp, SR)
            pm = pretty_midi.PrettyMIDI(initial_tempo=bpm)
            for name, (prog, notes, _) in parts.items():
                inst = pretty_midi.Instrument(program=prog, name=name)
                inst.notes = [pretty_midi.Note(velocity=100, pitch=int(p), start=s, end=e) for p, s, e in notes]
                pm.instruments.append(inst)
            pm.write(str(OUT / "truth" / f"{cid}.mid"))
            rec = {"id": cid, "category": cat, "key": f"{tonic} {mode}", "bpm": bpm, "seconds": round(seconds, 2),
                   "programs": {n: p[0] for n, p in parts.items()}, "n_notes": {n: len(p[1]) for n, p in parts.items()}, **deg}
            manifest.append(rec)
            print(rec, flush=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
