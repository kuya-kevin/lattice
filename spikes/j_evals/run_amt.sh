#!/usr/bin/env bash
# Whole audio-to-MIDI eval: synthetic set (scored) and real material (listening only).
#   spikes/j_evals/run_amt.sh [synth|real|all] [--skip-sep]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E="$HERE/env.sh"
O=${LATTICE_BIGDISK:?set LATTICE_BIGDISK to the big-disk project folder}/out-evals
which=${1:-all}
skip_sep=${2:-}
cd "$HERE"

ymt3_jobs() {  # $1 inputs json, $2 jobs json
  "$E" amt python -c "import json; s=json.load(open('$1')); json.dump([{'in': p, 'out': '$O/amt/pred/yourmt3/' + k + '.mid'} for k, p in s.items()], open('$2', 'w'))"
}

if [[ $which == synth || $which == all ]]; then
  "$E" amt python synth_set.py
  "$E" amt python inputs.py
  [[ $skip_sep == --skip-sep ]] || "$E" sep python separate.py "$O/inputs_sep_synth.json"
  "$E" amt python stems.py synth
  "$E" amt python transcribe.py "$O/inputs_synth.json" basic_pitch basic_pitch_clean pyin bytedance_piano
  "$E" amt python transcribe.py "$O/stems_synth.json" basic_pitch basic_pitch_clean pyin bytedance_piano
  ymt3_jobs "$O/inputs_synth.json" "$O/amt/jobs_ymt3_synth.json"
  "$E" yourmt3 python yourmt3_run.py "$O/amt/jobs_ymt3_synth.json"
  "$E" yourmt3 python yourmt3_run.py "$O/amt/jobs_ymt3_stems_synth.json"
  "$E" amt python score_amt.py
fi

if [[ $which == real || $which == all ]]; then
  "$E" amt python inputs.py
  [[ $skip_sep == --skip-sep ]] || "$E" sep python separate.py "$O/inputs_real.json"
  "$E" amt python stems.py real
  "$E" amt python transcribe.py "$O/inputs_real.json" basic_pitch_clean pyin bytedance_piano
  "$E" amt python transcribe.py "$O/stems_real.json" basic_pitch_clean
  ymt3_jobs "$O/inputs_real.json" "$O/amt/jobs_ymt3_real.json"
  "$E" yourmt3 python yourmt3_run.py "$O/amt/jobs_ymt3_real.json"
  "$E" yourmt3 python yourmt3_run.py "$O/amt/jobs_ymt3_stems_real.json"
  "$E" amt python listen.py
fi
