"""YourMT3+ (YPTF.MoE+Multi, noPS checkpoint) on a batch of files, one model load.

    spikes/j_evals/env.sh yourmt3 python spikes/j_evals/yourmt3_run.py jobs.json

jobs.json: [{"in": "a.wav", "out": "a.mid"}, ...]. Writes <jobs>.result.json with timings
and peak VRAM. Code follows model_helper.transcribe in the HF space, but loads audio with
soundfile and writes the MIDI where asked.
"""
import json
import os
import shutil
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio

REPO = Path(os.environ["YOURMT3_REPO"])
sys.path.insert(0, str(REPO / "amt/src"))
sys.path.insert(0, str(REPO))
os.chdir(REPO)  # the checkpoint path is resolved relative to amt/logs

from model_helper import load_model_checkpoint  # noqa: E402
from utils.audio import slice_padded_array  # noqa: E402
from utils.event2note import merge_zipped_note_events_and_ties_to_notes  # noqa: E402
from utils.note2event import mix_notes  # noqa: E402
from utils.utils import write_model_output_as_midi  # noqa: E402

CKPT = "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops@last.ckpt"
ARGS = [CKPT, "-p", "2024", "-tk", "mc13_full_plus_256", "-dec", "multi-t5", "-nl", "26", "-enc", "perceiver-tf",
        "-sqr", "1", "-ff", "moe", "-wf", "4", "-nmoe", "8", "-kmoe", "2", "-act", "silu", "-epe", "rope",
        "-rp", "1", "-ac", "spec", "-hop", "300", "-atc", "1", "-pr", "16"]


def transcribe(model, wav_path, out_mid):
    y, sr = sf.read(wav_path, dtype="float32", always_2d=True)
    audio = torch.from_numpy(y.mean(axis=1)).unsqueeze(0)
    audio = torchaudio.functional.resample(audio, sr, model.audio_cfg["sample_rate"])
    segs = slice_padded_array(audio, model.audio_cfg["input_frames"], model.audio_cfg["input_frames"])
    segs = torch.from_numpy(segs.astype("float32")).to("cuda").unsqueeze(1)
    pred_token_arr, _ = model.inference_file(bsz=8, audio_segments=segs)
    n_items = segs.shape[0]
    starts = [model.audio_cfg["input_frames"] * i / model.audio_cfg["sample_rate"] for i in range(n_items)]
    notes_per_ch, errs = [], Counter()
    for ch in range(model.task_manager.num_decoding_channels):
        arr = [a[:, ch, :] for a in pred_token_arr]
        zipped, _, _ = model.task_manager.detokenize_list_batches(arr, starts, return_events=True)
        notes, err = merge_zipped_note_events_and_ties_to_notes(zipped)
        notes_per_ch.append(notes)
        errs += err
    notes = mix_notes(notes_per_ch)
    with tempfile.TemporaryDirectory() as tmp:
        write_model_output_as_midi(notes, tmp, "x", model.midi_output_inverse_vocab)
        Path(out_mid).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(Path(tmp) / "model_output" / "x.mid", out_mid)
    return len(y) / sr


def main(jobs_file):
    jobs = json.loads(Path(jobs_file).read_text())
    t0 = time.time()
    model = load_model_checkpoint(args=ARGS, device="cpu").to("cuda")
    load_s = time.time() - t0
    torch.cuda.reset_peak_memory_stats()
    results, total_audio, total_s = [], 0.0, 0.0
    for job in jobs:
        t = time.time()
        dur = transcribe(model, job["in"], job["out"])
        took = time.time() - t
        total_audio += dur
        total_s += took
        results.append({**job, "audio_s": round(dur, 2), "seconds": round(took, 2)})
        print(f"{Path(job['in']).name}: {took:.1f}s for {dur:.1f}s", flush=True)
    summary = {"load_s": round(load_s, 1), "audio_s": round(total_audio, 1), "seconds": round(total_s, 1),
               "rtf": round(total_s / max(total_audio, 1e-9), 3),
               "peak_vram_mb": round(torch.cuda.max_memory_allocated() / 2**20), "jobs": results}
    Path(str(jobs_file).replace(".json", ".result.json")).write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != "jobs"}))


if __name__ == "__main__":
    main(sys.argv[1])
