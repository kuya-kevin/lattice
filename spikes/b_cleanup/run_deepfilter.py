"""Spike B: DeepFilterNet (speech enhancement) on the voice notes. Runs in envs/denoise (needs numpy<2)."""
import sys
import time
from pathlib import Path

from df.enhance import enhance, init_df, load_audio, save_audio

src = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

model, df_state, _ = init_df()
for wav in sorted(src.glob("*.wav")):
    audio, _ = load_audio(str(wav), sr=df_state.sr())
    t = time.perf_counter()
    clean = enhance(model, df_state, audio)
    dt = time.perf_counter() - t
    save_audio(str(out / wav.name), clean, df_state.sr())
    print(f"{wav.name}: {dt:.2f}s for {audio.shape[-1] / df_state.sr():.1f}s audio")
