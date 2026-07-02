#!/usr/bin/env bash
# tests/test-completion-signal-consume.sh
#
# Regression test for the stale-completion-signal bug in run.sh
# check_task_completion_signal().
#
# BUG: when BOTH .loki/signals/TASK_COMPLETION_CLAIMED and
# .loki/signals/COMPLETION_REQUESTED exist, the function consumed only the
# active signal (TASK_COMPLETION_CLAIMED) and left COMPLETION_REQUESTED behind.
# The orphaned fallback then reads as a phantom completion claim on the next
# iteration and forces every-iteration council evaluation.
#
# FIX: the consume step now removes BOTH the active signal_file and the
# fallback_file. After a single call, .loki/signals is empty.
#
# This test extracts the real function body out of autonomy/run.sh (the function
# contains nested python heredocs, so it is sourced verbatim by exact line-range
# extraction rather than reconstructed) and drives it with both files present.
#
# Discriminating design: it also builds a "before-fix" variant of the SAME
# extracted body with exactly the final `rm -f "$fallback_file"` line removed,
# and asserts that variant DOES orphan COMPLETION_REQUESTED. That proves the
# test fails on the old behavior and passes on the fixed behavior (non-vacuous).
#
# Self-skips cleanly if bash/awk/mktemp are unavailable. python3 is optional:
# the function degrades to a hand-built JSON path when python3 is absent, which
# this test tolerates.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0

_ok() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_no() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "=== test-completion-signal-consume.sh ==="
echo "RUN_SH: $RUN_SH"

# ---- environment preflight / self-skip ---------------------------------------
missing=""
for tool in bash awk mktemp; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
    printf '  SKIP: required tool(s) absent:%s\n' "$missing"
    echo "=== results: 0 passed, 0 failed (skipped) ==="
    exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    printf '  SKIP: run.sh not found at %s\n' "$RUN_SH"
    echo "=== results: 0 passed, 0 failed (skipped) ==="
    exit 0
fi

TMP_ROOT="$(mktemp -d -t loki-signal-consume.XXXXXX)"
cleanup() { rm -rf "$TMP_ROOT" 2>/dev/null || true; }
trap cleanup EXIT

# ---- locate the function's exact line range in run.sh ------------------------
# Start line: the definition. End line: the first line that is EXACTLY a lone
# closing brace `}` (optionally surrounded by whitespace). This deliberately
# does NOT match `/^}/`: the function contains a nested python heredoc whose
# terminator line begins with `}` at column 0 (e.g. `}))" ... ; then`), so a
# bare `/^}/` would stop the extraction mid-function. The real close is a lone
# `}` on its own line.
START="$(grep -n '^check_task_completion_signal() {' "$RUN_SH" | head -1 | cut -d: -f1)"
if [ -z "$START" ]; then
    _no "could not locate check_task_completion_signal() in run.sh"
    echo "=== results: $PASS passed, $FAIL failed ==="
    [ "$FAIL" -eq 0 ]; exit $?
fi
END="$(awk -v s="$START" 'NR>s && /^[[:space:]]*}[[:space:]]*$/ {print NR; exit}' "$RUN_SH")"
if [ -z "$END" ]; then
    _no "could not locate closing brace of check_task_completion_signal()"
    echo "=== results: $PASS passed, $FAIL failed ==="
    [ "$FAIL" -eq 0 ]; exit $?
fi

FN="$TMP_ROOT/fn.sh"
awk -v s="$START" -v e="$END" 'NR>=s && NR<=e' "$RUN_SH" > "$FN"

# Harness = a stub for the only external dependency (emit_event_json) + the
# extracted function body verbatim.
HARNESS="$TMP_ROOT/harness.sh"
{
    echo 'emit_event_json() { :; }'
    cat "$FN"
} > "$HARNESS"

if bash -n "$HARNESS" 2>/dev/null; then
    _ok "extracted function body passes bash -n"
else
    _no "extracted function body failed bash -n (extraction boundary wrong?)"
fi

# Helper: seed both signal files in a fresh sandbox dir.
seed_signals() {
    local dir="$1"
    rm -rf "$dir" 2>/dev/null || true
    mkdir -p "$dir/.loki/signals"
    printf '{"statement":"done","evidence":"e","confidence":"high"}' \
        > "$dir/.loki/signals/TASK_COMPLETION_CLAIMED"
    printf 'please complete' \
        > "$dir/.loki/signals/COMPLETION_REQUESTED"
}

# ---- test 1: FIXED body consumes BOTH signals --------------------------------
SB1="$TMP_ROOT/fixed"
seed_signals "$SB1"
(
    cd "$SB1" || exit 3
    # shellcheck disable=SC1090
    source "$HARNESS"
    check_task_completion_signal >/dev/null 2>&1
)
REMAIN="$(ls -A "$SB1/.loki/signals" 2>/dev/null | tr '\n' ' ')"
if [ -z "${REMAIN// /}" ]; then
    _ok "both signals present -> single call leaves .loki/signals empty"
else
    _no "both signals present -> orphaned after call: [$REMAIN]"
fi

# ---- test 2 (discriminating): before-fix body DOES orphan the fallback -------
# Build a variant of the SAME extracted body with exactly the final
# `rm -f "$fallback_file"` line (the one immediately preceding `return 0`)
# removed. This is the pre-fix code. It MUST orphan COMPLETION_REQUESTED;
# if it does not, this test would be vacuous.
HARNESS_OLD="$TMP_ROOT/harness_old.sh"
awk '
    { line[NR]=$0 }
    END {
        for (i=1;i<=NR;i++) {
            if (line[i] ~ /^[[:space:]]*rm -f "\$fallback_file"/ && \
                line[i+1] ~ /^[[:space:]]*return 0[[:space:]]*$/) continue
            print line[i]
        }
    }' "$HARNESS" > "$HARNESS_OLD"

DIFF_LINES=$(( $(wc -l < "$HARNESS") - $(wc -l < "$HARNESS_OLD") ))
if [ "$DIFF_LINES" -eq 1 ] && bash -n "$HARNESS_OLD" 2>/dev/null; then
    SB2="$TMP_ROOT/oldsim"
    seed_signals "$SB2"
    (
        cd "$SB2" || exit 3
        # shellcheck disable=SC1090
        source "$HARNESS_OLD"
        check_task_completion_signal >/dev/null 2>&1
    )
    REMAIN_OLD="$(ls -A "$SB2/.loki/signals" 2>/dev/null | tr '\n' ' ')"
    if printf '%s' "$REMAIN_OLD" | grep -q "COMPLETION_REQUESTED"; then
        _ok "before-fix body orphans COMPLETION_REQUESTED (test is non-vacuous)"
    else
        _no "before-fix body did NOT orphan the fallback; test is vacuous [$REMAIN_OLD]"
    fi
else
    # Could not synthesize a clean single-line old variant; skip the
    # discriminator but do not fail (test 1 still asserts the fix).
    printf '  SKIP: could not synthesize single-line before-fix variant (diff=%s)\n' "$DIFF_LINES"
fi

echo ""
echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
