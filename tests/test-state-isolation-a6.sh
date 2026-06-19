#!/usr/bin/env bash
#==============================================================================
# A6: multi-build-per-pod state isolation.
# Verifies autonomy-state.json is namespaced under .loki/sessions/<id>/ when
# LOKI_SESSION_ID is set, and uses the legacy .loki/autonomy-state.json path
# (byte-identical default) when it is unset.
#==============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNSH="$REPO/autonomy/run.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-a6-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 1

log_warn(){ :; }; log_info(){ :; }; log_error(){ :; }

# Source the three state functions out of run.sh by line range (resolved live).
S=$(grep -n '^_loki_state_file() {' "$RUNSH" | head -1 | cut -d: -f1)
E=$(grep -n '^load_queue_tasks() {' "$RUNSH" | head -1 | cut -d: -f1)
sed -n "${S},$((E-1))p" "$RUNSH" > "$WORK/funcs.sh"
# shellcheck disable=SC1090
source "$WORK/funcs.sh"

ITERATION_COUNT=0; MAX_RETRIES=3; BASE_WAIT=5; PRD_PATH="./prd.md"; RETRY_COUNT=0
pass=0; fail=0
ck(){ if [ "$1" = "$2" ]; then echo "  [PASS] $3"; pass=$((pass+1)); else echo "  [FAIL] $3 (got '$1' want '$2')"; fail=$((fail+1)); fi; }

echo "A6: multi-build-per-pod state isolation"
echo "======================================="

# Default path
unset LOKI_SESSION_ID || true
ITERATION_COUNT=5; save_state 2 running 0
ck "$([ -f .loki/autonomy-state.json ] && echo y)" "y" "default (no session id) writes legacy .loki/autonomy-state.json"
ck "$([ -d .loki/sessions ] && echo y || echo n)" "n" "default does not create .loki/sessions/"

# Two distinct sessions -> no collision
export LOKI_SESSION_ID=sA; ITERATION_COUNT=11; save_state 1 running 0
export LOKI_SESSION_ID=sB; ITERATION_COUNT=22; save_state 1 running 0
ck "$(python3 -c "import json;print(json.load(open('.loki/sessions/sA/autonomy-state.json'))['iterationCount'])")" "11" "session A state isolated (iter=11)"
ck "$(python3 -c "import json;print(json.load(open('.loki/sessions/sB/autonomy-state.json'))['iterationCount'])")" "22" "session B state isolated (iter=22, no clobber)"
ck "$(python3 -c "import json;print(json.load(open('.loki/autonomy-state.json'))['iterationCount'])")" "5" "legacy state untouched by session writes"

# Durable resume reads its own namespaced state
export LOKI_SESSION_ID=sA; export LOKI_DURABLE_STATE=1
mkdir -p .loki/state; printf 'sha' > .loki/state/start-sha
RETRY_COUNT=0; ITERATION_COUNT=0; load_state
ck "$ITERATION_COUNT" "11" "durable resume loads session A's own namespaced state"
unset LOKI_DURABLE_STATE

# LOW-2: LOKI_SESSION_ID intake sanitization. Source just the intake block
# (top-level `if`, resolved live by line range) and assert a traversal/option-
# looking value is reduced to a contained, path-safe form.
SS=$(grep -n '^if \[ -n "\${LOKI_SESSION_ID:-}" \]; then$' "$RUNSH" | head -1 | cut -d: -f1)
sed -n "${SS},$((SS+20))p" "$RUNSH" | awk 'NR==1{print;next} /^fi$/{print;exit} {print}' > "$WORK/sid_sanitize.sh"
sanitize_sid(){ # shellcheck disable=SC1090
    LOKI_SESSION_ID="$1"; source "$WORK/sid_sanitize.sh" 2>/dev/null; printf '%s' "${LOKI_SESSION_ID:-}"; }
ck "$(sanitize_sid '../../../tmp/x')" "_.._.._tmp_x" "traversal LOKI_SESSION_ID sanitized (slashes -> _, no escape)"
ck "$(sanitize_sid 'a/b c')" "a_b_c" "slash+space sanitized to underscores"
ck "$(sanitize_sid 'safe-id_123.v2')" "safe-id_123.v2" "already-safe id unchanged"
ck "$(sanitize_sid '...')" "session" "all-dot id collapses to safe literal"
case "$(sanitize_sid '../../etc')" in */*) ck "yes" "no" "sanitized id contains no slash" ;; *) ck "ok" "ok" "sanitized id contains no slash" ;; esac
unset LOKI_SESSION_ID || true

echo
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
