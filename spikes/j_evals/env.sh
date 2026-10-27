#!/usr/bin/env bash
# Run a command inside one of the j_evals uv environments, with every cache and temp file
# on the big disk (the root disk is nearly full).
#
#   spikes/j_evals/env.sh <env-name> python <script.py> [args...]
#
# <env-name> is a folder under envs/ (its pyproject.toml defines the env); the virtualenv
# itself lives at <bigdisk>/venvs/j-<env-name>.
set -euo pipefail
BIG=${LATTICE_BIGDISK:?set LATTICE_BIGDISK to the big-disk project folder}
export UV_CACHE_DIR=$BIG/uv-cache UV_LINK_MODE=copy UV_PYTHON_INSTALL_DIR=$BIG/uv-python
export HF_HUB_CACHE=$BIG/hf TORCH_HOME=$BIG/torch XDG_CACHE_HOME=$BIG/xdg-cache
export PIP_CACHE_DIR=$BIG/pip-cache TMPDIR=$BIG/tmp MAGENTA_HOME=$BIG/magenta
export NUMBA_CACHE_DIR=$BIG/xdg-cache/numba MPLCONFIGDIR=$BIG/xdg-cache/mpl
export LATTICE_OUT=$BIG/out-evals LATTICE_DATA=$BIG/transfer/data LATTICE_C=$BIG/transfer/out/c_recreate
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name=$1; shift
export UV_PROJECT_ENVIRONMENT=$BIG/venvs/j-$name YOURMT3_REPO=$BIG/repos/YourMT3
exec uv run --project "$HERE/envs/$name" "$@"
