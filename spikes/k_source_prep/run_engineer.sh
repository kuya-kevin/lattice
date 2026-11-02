#!/usr/bin/env bash
# Engineer sidecar entry point (B3: cleanup_noise, quantize_drums; split_stems), spawned by app/src/node/engineer.ts:
#   LATTICE_BIGDISK=<bigdisk> spikes/k_source_prep/run_engineer.sh <cleanup|quantize> <in.wav> <out.wav> [options]
# Runs engineer.py in the j_evals `sep` env (audio-separator for Demucs, noisereduce, librosa).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/../j_evals/env.sh" sep python "$HERE/engineer.py" "$@"
