#!/usr/bin/env bash
# scripts/impacted-gate.sh -- run only the shell suites a diff can affect (FC-31).
#
# Usage: bash scripts/impacted-gate.sh <base-ref> [head-ref]
#        bash scripts/local-ci.sh --impacted <base-ref>
#
# Selection is scripts/select-tests.sh (the one shared file-to-suite mapping).
# Only shell_test and moat suites run here; static checks, bun and pytest stay
# with the slice's own gate. Each suite runs under `timeout -k`, up to
# IMPACTED_JOBS at a time, and its rc is printed. Exit 0 only if all are 0.
# R0 (run everything) is reported and NOT run: the full Tier B run owns that.
set -uo pipefail
export LOKI_NO_BROWSER=1
export LOKI_CONTROL="${LOKI_CONTROL:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 2

BASE="${1:-}"
HEAD_REF="${2:-HEAD}"
if [ -z "$BASE" ]; then
    echo "usage: impacted-gate.sh <base-ref> [head-ref]" >&2
    exit 2
fi
JOBS="${IMPACTED_JOBS:-4}"
LIMIT="${IMPACTED_SUITE_TIMEOUT:-100}"

TB=""
if command -v timeout >/dev/null 2>&1; then TB="timeout"; elif command -v gtimeout >/dev/null 2>&1; then TB="gtimeout"; fi
[ -n "$TB" ] || { echo "impacted-gate: timeout/gtimeout not found" >&2; exit 2; }

# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT

SEL="$LOKI_RUN_TMP/selection.tsv"
bash "$SCRIPT_DIR/select-tests.sh" --base "$BASE" --head "$HEAD_REF" >"$SEL" || { echo "impacted-gate: selector failed" >&2; exit 2; }

if grep -q '^R0	ALL' "$SEL"; then
    echo "impacted-gate: R0 (broad-blast-radius diff); the full run owns this, not run here:"
    grep '^R0	ALL' "$SEL"
    exit 0
fi

SUITES="$LOKI_RUN_TMP/suites.txt"
# The selector's own fixture suite names many source paths as test data, so R3
# selects it for almost any diff and it takes minutes. It runs when it (R2) or
# the selector changes; a plain R3 mention is not a reason to run it here.
awk -F'\t' '($2=="shell_test" || $2=="moat") && !($1=="R3" && $3=="tests/test-select-tests.sh") && !seen[$3]++ {print $3}' "$SEL" >"$SUITES"
N="$(wc -l <"$SUITES" | tr -d ' ')"
echo "impacted-gate: $N shell suite(s) selected for $BASE..$HEAD_REF (jobs=$JOBS, ${LIMIT}s each)"
[ "$N" -gt 0 ] || { echo "impacted-gate: PASS (nothing impacted)"; exit 0; }

log_of() { printf '%s/%s.log' "$LOKI_RUN_TMP" "$(printf '%s' "$1" | tr '/' '_')"; }

run_suite() {
    local s="$1" rc
    "$TB" -k 10 "$LIMIT" bash "$s" >"$(log_of "$s")" 2>&1
    rc=$?
    printf '%s\t%s\n' "$rc" "$s" >>"$LOKI_RUN_TMP/results.tsv"
    echo "rc=$rc $s"
}

: >"$LOKI_RUN_TMP/results.tsv"
running=0
while IFS= read -r s; do
    [ -f "$s" ] || continue
    run_suite "$s" &
    running=$((running + 1))
    if [ "$running" -ge "$JOBS" ]; then
        wait -n 2>/dev/null || wait
        running=$((running - 1))
    fi
done <"$SUITES"
wait

FAILED="$(awk -F'\t' '$1!=0' "$LOKI_RUN_TMP/results.tsv")"
if [ -n "$FAILED" ]; then
    echo "impacted-gate: FAIL"
    while IFS=$'\t' read -r rc s; do
        echo "--- rc=$rc $s (tail) ---"
        tail -15 "$(log_of "$s")"
    done <<<"$FAILED"
    exit 1
fi
echo "impacted-gate: PASS ($N suites)"
