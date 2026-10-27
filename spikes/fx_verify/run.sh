#!/usr/bin/env bash
# Effects verification, end to end: signals -> headless Chromium renders -> measurements.
#   FX_OUT=/path/to/out-fx spikes/fx_verify/run.sh [pytest args]
# Uses the uv project in spikes/ (set UV_* env vars as in HANDOFF if caches live elsewhere)
# and Playwright's Chromium (set PLAYWRIGHT_BROWSERS_PATH if it is not in the default place).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
export FX_OUT="${FX_OUT:-$repo/out/fx}"
mkdir -p "$FX_OUT"
(cd "$repo/spikes" && uv run python fx_verify/signals.py)
(cd "$repo/app" && npx playwright test -c playwright.fx.config.ts)
(cd "$repo/spikes" && uv run --with pytest pytest fx_verify -q -p no:cacheprovider "$@")
echo "results: $FX_OUT/results.md"
