#!/usr/bin/env bash
# Source prep sidecar entry point (what the app spawns):
#   LATTICE_BIGDISK=<bigdisk> spikes/k_source_prep/run.sh <in audio> <out_dir> [prep.py options]
# Runs prep.py in the j_evals `amt` env; separation and YourMT3+ run in their own envs.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/../j_evals/env.sh" amt python "$HERE/prep.py" "$@"
