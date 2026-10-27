"""Spike G: can Meta's PE-AV be Muse's ears?

1. Knob sweeps: render our synth while turning one knob, and check that PE-AV's
   text-audio score for the matching word moves with it (Spearman rho per sweep).
2. Ratings: does PE-AV audio-audio similarity agree with the human listening-test
   ratings better than the spectral distance (rho -0.26) or MusicCoCa (+0.12)?
3. Freesound set (144 real sounds, 18 categories): zero-shot category accuracy, and
   whether its "bright"/"warm"/"rough" scores track Freesound's timbre scores.

Runs in envs/ears (transformers + torch, MPS):
    ../envs/ears/.venv/bin/python g_pe_av/test_ears.py ../out/c_recreate [facebook/pe-av-small]
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch
from scipy.signal import resample_poly
from scipy.stats import spearmanr
import soundfile as sf
from transformers import PeAudioVideoModel, PeAudioVideoProcessor

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "c_recreate"))
from synth import SR, default_patch, render  # noqa: E402

PE_SR = 48_000
DEVICE = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE != "cpu" else torch.float32
MAX_SECONDS = 5.0  # attention memory grows with clip length; 16 padded clips at once hit 17 GB on a 16 GB Mac
BATCH = 4

# (knob, values, word that should rise with the knob, word that should fall)
SWEEPS = [
    ("cutoff", [200, 400, 800, 1600, 3200, 6400, 12800], "a bright, crisp synth", "a dark, muffled synth"),
    ("drive", [0.0, 0.15, 0.3, 0.5, 0.7, 0.85, 1.0], "a gritty, distorted synth", "a clean synth"),
    ("noise", [0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5], "a noisy, breathy synth", "a pure synth tone"),
    ("attack", [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0], "a soft synth pad that swells in slowly", "a punchy synth with a sharp attack"),
    ("detune", [0, 5, 10, 15, 25, 35, 50], "a wide, detuned supersaw", "a single thin oscillator"),
    ("resonance", [0.0, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95], "a resonant, squelchy acid synth", "a smooth synth"),
]


class Ears:
    def __init__(self, name="facebook/pe-av-small"):
        self.proc = PeAudioVideoProcessor.from_pretrained(name)
        # The video tower's timm head mismatches the checkpoint in transformers 5.21; we only use audio + text.
        self.model = PeAudioVideoModel.from_pretrained(name, ignore_mismatched_sizes=True, dtype=DTYPE).to(DEVICE).eval()

    @torch.no_grad()
    def audio(self, clips, sr):
        out = []
        for i in range(0, len(clips), BATCH):
            batch = [resample_poly(c[: int(MAX_SECONDS * sr)], PE_SR, sr).astype(np.float32) for c in clips[i : i + BATCH]]
            fx = self.proc.feature_extractor(batch, sampling_rate=PE_SR, return_tensors="pt", padding=True)
            fx = {k: (v.to(DEVICE, DTYPE) if v.is_floating_point() else v.to(DEVICE)) for k, v in fx.items()}
            e = self.model.get_audio_embeds(fx["input_values"], fx.get("padding_mask"))
            e = getattr(e, "audio_embeds", e)
            out.append(torch.nn.functional.normalize(e.float(), dim=-1).cpu().numpy())
            if DEVICE == "mps":
                torch.mps.empty_cache()
        return np.concatenate(out)

    @torch.no_grad()
    def text(self, words):
        tok = self.proc.tokenizer(words, return_tensors="pt", padding=True).to(DEVICE)
        # transformers 5.21's get_text_audio_embeds paths are broken (missing method, and
        # hidden states not requested), so do what they intend: CLS token -> text-audio head.
        am = self.model.audio_model
        out = am.text_model(input_ids=tok["input_ids"], attention_mask=tok.get("attention_mask"), output_hidden_states=True, return_dict=True)
        e = am.text_audio_head(out.hidden_states[-1][:, 0])
        e = getattr(e, "text_audio_embeds", e)
        return torch.nn.functional.normalize(e.float(), dim=-1).cpu().numpy()


def knob_sweeps(ears):
    print("1. Knob sweeps at 220 Hz: rho between knob value and score(rising word) - score(falling word)")
    base = default_patch()
    for knob, values, up, down in SWEEPS:
        clips = [render(dict(base, **({"voices": 7} if knob == "detune" else {}), **{knob: v}), 220, 2.0, 1.2) for v in values]
        a = ears.audio(clips, SR)
        t = ears.text([up, down])
        score = a @ t[0] - a @ t[1]
        rho, p = spearmanr(values, score)
        print(f"   {knob:10s} rho {rho:+.2f} (p {p:.3f})  scores {np.round(score, 3).tolist()}")


def ratings(ears, c_out):
    rated = [json.loads(line) for line in (c_out.parent / "eval" / "ratings.jsonl").read_text().splitlines()]
    human, cos = [], []
    for r in rated:
        d = c_out / r["trial"]
        names = [c for c in r["scores"] if c != "hidden_reference"]
        clips = [sf.read(d / "reference.wav")[0]] + [sf.read(d / f"{c}.wav")[0] for c in names]
        e = ears.audio(clips, SR)
        for i, c in enumerate(names):
            human.append(r["scores"][c])
            cos.append(float(e[0] @ e[i + 1]))
    rho, p = spearmanr(human, cos)
    print(f"2. Ratings: PE-AV cosine vs human, n = {len(human)}: rho {rho:+.2f} (p {p:.3f})"
          "  [spectral distance -0.26 (sign flipped: lower = closer), MusicCoCa +0.12]")


CATEGORY_TEXT = {
    "synth_lead": "a synth lead note", "synth_bass": "a synth bass note", "pad": "a soft synth pad",
    "pluck": "a plucked synth note", "electric_piano": "an electric piano note", "piano_note": "an acoustic piano note",
    "bell_mallet": "a bell or mallet note", "brass_stab": "a brass stab", "organ": "an organ note",
    "strings_note": "a string section note", "kick": "a kick drum", "snare": "a snare drum", "clap": "a hand clap",
    "closed_hat": "a closed hi-hat", "open_hat": "an open hi-hat", "percussion": "a percussion hit",
    "noise_vinyl": "vinyl crackle noise", "riser": "a rising sweep effect",
}
TIMBRE = [("brightness", "a bright sound", "a dark sound"), ("warmth", "a warm sound", "a cold, thin sound"),
          ("roughness", "a rough, gritty sound", "a smooth sound"), ("hardness", "a hard, punchy sound", "a soft sound")]


def freesound(ears, root):
    manifest = json.loads((root / "data/freesound/manifest.json").read_text())
    clips = [sf.read(root / m["wav"])[0] for m in manifest]
    clips = [c.mean(axis=1) if c.ndim > 1 else c for c in clips]
    a = ears.audio(clips, 22050)
    cats = list(CATEGORY_TEXT)
    t = ears.text([CATEGORY_TEXT[c] for c in cats])
    pred = (a @ t.T).argmax(axis=1)
    truth = np.array([cats.index(m["category"]) for m in manifest])
    top3 = np.mean([truth[i] in np.argsort(-(a[i] @ t.T))[:3] for i in range(len(a))])
    print(f"3. Freesound, {len(a)} sounds: category top-1 {np.mean(pred == truth):.0%}, top-3 {top3:.0%} (chance {1 / len(cats):.0%})")
    for field, up, down in TIMBRE:
        tt = ears.text([up, down])
        rho, p = spearmanr([m[field] for m in manifest], a @ tt[0] - a @ tt[1])
        print(f"   {field:10s} vs Freesound score: rho {rho:+.2f} (p {p:.3f})")


if __name__ == "__main__":
    c_out = Path(sys.argv[1] if len(sys.argv) > 1 else "../out/c_recreate")
    ears = Ears(sys.argv[2] if len(sys.argv) > 2 else "facebook/pe-av-small")
    knob_sweeps(ears)
    ratings(ears, c_out)
    freesound(ears, Path(__file__).resolve().parents[2])
