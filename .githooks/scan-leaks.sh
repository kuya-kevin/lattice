#!/usr/bin/env bash
# Leak scan: refuses keys, .env values, absolute home paths, and files from .env, data/ or out/.
# Prints file:line and what kind of leak, never the matched text.
#
#   .githooks/scan-leaks.sh               staged changes (the pre-commit hook runs this)
#   .githooks/scan-leaks.sh main...HEAD   everything a branch adds, before merging it
set -u

range="${1:-}"
main_checkout=$(cd "$(git rev-parse --git-common-dir)/.." && pwd) # .env lives here, not in worktrees

if [ -n "$range" ]; then diff_args=("$range"); else diff_args=(--cached); fi
files=$(git diff --name-only --diff-filter=ACMR "${diff_args[@]}")
# "path:line<TAB>text" for every added line
added=$(git diff -U0 --no-color --no-ext-diff --diff-filter=ACMR "${diff_args[@]}" | awk '
  /^\+\+\+ / { f = substr($0, 7); next }
  /^@@/      { match($0, /\+[0-9]+/); n = substr($0, RSTART + 1, RLENGTH - 1) - 1; next }
  /^\+/      { n++; print f ":" n "\t" substr($0, 2) }')

found=0
report() { echo "  $1  ($2)" >&2; found=1; }

# files that must never be committed
while IFS= read -r f; do
  case "$f" in
    .env.example | */.env.example) ;;
    .env | .env.* | */.env | */.env.*) report "$f" ".env file" ;;
    data/* | out/*) report "$f" "git-ignored data/out folder" ;;
  esac
done <<< "$files"

# patterns in added lines
check() { # kind, extended regex
  grep -E -- "$2" <<< "$added" | cut -f1 | while IFS= read -r loc; do [ -n "$loc" ] && echo "$loc|$1"; done
}
hits=$(
  check "absolute home path" '/Users/[A-Za-z0-9._-]+|/home/[a-z_][a-z0-9_-]*/|[A-Za-z]:\\+Users\\+|/private/(tmp|var/folders)/'
  check "private key" '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  check "Hugging Face token" 'hf_[A-Za-z0-9]{30,}'
  check "bearer token" 'Bearer [A-Za-z0-9._~+/=-]{20,}'
  check "key/token assignment" '(API_KEY|_TOKEN|SECRET|CLIENT_ID|PASSWORD)["'\'']?[[:space:]]*[:=][[:space:]]*["'\'']?[A-Za-z0-9_+/=-]{16,}'
)
# literal values from .env (and LATTICE_BIGDISK), matched as plain text
if [ -f "$main_checkout/.env" ]; then
  while IFS='=' read -r key value; do
    key=$(echo "$key" | tr -d '[:space:]'); value=$(echo "$value" | sed -e 's/^[[:space:]"'\'']*//' -e 's/[[:space:]"'\'']*$//')
    case "$key" in '' | \#*) continue ;; esac
    [ ${#value} -ge 8 ] || continue
    hits+=$'\n'$(grep -F -- "$value" <<< "$added" | cut -f1 | sed "s/\$/|value of $key from .env/")
  done < "$main_checkout/.env"
fi
if [ -n "${LATTICE_BIGDISK:-}" ] && [ ${#LATTICE_BIGDISK} -ge 4 ]; then
  hits+=$'\n'$(grep -F -- "$LATTICE_BIGDISK" <<< "$added" | cut -f1 | sed 's/$/|real LATTICE_BIGDISK path/')
fi
while IFS='|' read -r loc kind; do [ -n "$loc" ] && report "$loc" "$kind"; done <<< "$(sort -u <<< "$hits")"

if [ "$found" = 1 ]; then
  echo "Leak scan failed: remove the lines above (use env vars or <placeholders>), then try again." >&2
  exit 1
fi
