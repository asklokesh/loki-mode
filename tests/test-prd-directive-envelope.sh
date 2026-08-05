#!/usr/bin/env bash
# The task parser must ignore the hosted design-policy envelope only when its
# explicit terminator is present. The original PRD file remains untouched.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$ROOT/autonomy/run.sh"
TMPROOT="$(mktemp -d -t loki-prd-envelope.XXXXXX)"
PASS=0
FAIL=0
cleanup() { rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT
ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }

HARNESS="$TMPROOT/populate-prd.sh"
awk '/^populate_prd_queue\(\) \{/{found=1} found{print} found && /PRD task parsing complete/{tail=1} tail && /^\}/{exit}' \
    "$RUN_SH" > "$HARNESS"
log_step() { :; }
log_info() { :; }
log_warn() { :; }
# shellcheck disable=SC1090
source "$HARNESS"

run_case() {
    local dir="$1" prd="$2"
    mkdir -p "$dir/.loki/queue"
    (cd "$dir" && populate_prd_queue "$prd" >/dev/null 2>&1)
}

wrapped="$TMPROOT/wrapped"
mkdir -p "$wrapped"
cat > "$wrapped/spec.md" <<'PRD'
# Design policy

## Features
- Always use glass cards in every generated interface
- Always add decorative gradients to every section

--- END HOSTED PRODUCT POLICY DIRECTIVE ---

# Product catalog

## Requirements
- Build a searchable product catalog with category filters
PRD
before="$(shasum -a 256 "$wrapped/spec.md" | awk '{print $1}')"
run_case "$wrapped" "spec.md"
after="$(shasum -a 256 "$wrapped/spec.md" | awk '{print $1}')"
titles="$(python3 -c 'import json,sys; print("\n".join(t["title"] for t in json.load(open(sys.argv[1]))))' \
    "$wrapped/.loki/queue/pending.json")"
if [ "$before" = "$after" ]; then ok "wrapped PRD bytes remain unchanged"; else bad "wrapped PRD was modified"; fi
if printf '%s\n' "$titles" | grep -qx 'Build a searchable product catalog with category filters'; then
    ok "actual user requirement is queued"
else
    bad "actual user requirement is missing"
fi
if printf '%s\n' "$titles" | grep -qiE 'glass cards|decorative gradients'; then
    bad "policy examples leaked into the task queue"
else
    ok "policy examples are excluded"
fi

plain="$TMPROOT/plain"
mkdir -p "$plain"
cat > "$plain/spec.md" <<'PRD'
# Plain project

## Requirements
- Build an exportable audit report for administrators
PRD
before="$(shasum -a 256 "$plain/spec.md" | awk '{print $1}')"
run_case "$plain" "spec.md"
after="$(shasum -a 256 "$plain/spec.md" | awk '{print $1}')"
plain_title="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["title"])' \
    "$plain/.loki/queue/pending.json")"
if [ "$before" = "$after" ] && [ "$plain_title" = "Build an exportable audit report for administrators" ]; then
    ok "plain PRD behavior remains unchanged"
else
    bad "plain PRD behavior changed"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
