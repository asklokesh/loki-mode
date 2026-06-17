#!/usr/bin/env bash
# Test: `loki status` renders sane values when state files are empty.
#
# Regression: cmd_status read several state files through
#   value=$(jq '...' file 2>/dev/null || echo "<fallback>")
# That pattern assumes jq exits non-zero on bad input. But an *empty* or
# whitespace-only JSON file makes jq exit 0 while printing nothing, so the
# `|| echo <fallback>` arm never fires and the captured value is the empty
# string. The result was status lines like:
#       Pending Tasks:                 (blank, should be 0)
#       Orchestrator State:
#                                      (blank line, should be "unknown")
# Empty queue / state files are a NORMAL runtime state (run.sh truncates or
# pre-creates them), so this is a real correctness bug in the human-readable
# status output, not a contrived input.
#
# This test exercises the real `loki status` command end-to-end against a
# throwaway .loki/ populated with empty/whitespace-only files, and asserts the
# rendered values are the expected non-empty fallbacks. It is non-vacuous: it
# pins the *output text*, not merely the exit code, and would FAIL against the
# pre-fix code (which printed blanks).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL+1)); }

# jq is required for cmd_status; skip cleanly if absent (CI minimal images).
if ! command -v jq >/dev/null 2>&1; then
    echo -e "${YELLOW}[SKIP]${NC} jq not installed -- cmd_status requires jq"
    exit 0
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/loki-status-empty-XXXXXX")
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

mkdir -p "$WORK_DIR/.loki/state" "$WORK_DIR/.loki/queue" "$WORK_DIR/.loki/metrics"

# ---------------------------------------------------------------------------
# Case A: whitespace-only files (jq exits 0, prints nothing)
# ---------------------------------------------------------------------------
echo -e "${YELLOW}=== Case A: whitespace-only state files ===${NC}"
printf '\n'  > "$WORK_DIR/.loki/queue/pending.json"
printf '   ' > "$WORK_DIR/.loki/state/orchestrator.json"

out_a=$(cd "$WORK_DIR" && "$LOKI" status 2>/dev/null || true)

TOTAL=$((TOTAL+1))
# Pending Tasks line must end in a numeric 0, never a blank.
pending_line=$(echo "$out_a" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^Pending Tasks:')
if echo "$pending_line" | grep -Eq '^Pending Tasks:[[:space:]]+0$'; then
    log_pass "Pending Tasks renders '0' for whitespace-only pending.json"
else
    log_fail "Pending Tasks (whitespace)" "got: [$pending_line]"
fi

TOTAL=$((TOTAL+1))
# Orchestrator State must print 'unknown', not a blank line.
orch_val=$(echo "$out_a" | sed 's/\x1b\[[0-9;]*m//g' \
    | awk '/^Orchestrator State:/{getline; print; exit}')
if [ "$orch_val" = "unknown" ]; then
    log_pass "Orchestrator State renders 'unknown' for whitespace-only file"
else
    log_fail "Orchestrator State (whitespace)" "got: [$orch_val]"
fi

# ---------------------------------------------------------------------------
# Case B: zero-byte files
# ---------------------------------------------------------------------------
echo ""
echo -e "${YELLOW}=== Case B: zero-byte state files ===${NC}"
: > "$WORK_DIR/.loki/queue/pending.json"
: > "$WORK_DIR/.loki/state/orchestrator.json"

out_b=$(cd "$WORK_DIR" && "$LOKI" status 2>/dev/null || true)

TOTAL=$((TOTAL+1))
pending_line_b=$(echo "$out_b" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^Pending Tasks:')
if echo "$pending_line_b" | grep -Eq '^Pending Tasks:[[:space:]]+0$'; then
    log_pass "Pending Tasks renders '0' for zero-byte pending.json"
else
    log_fail "Pending Tasks (zero-byte)" "got: [$pending_line_b]"
fi

# ---------------------------------------------------------------------------
# Case C: no regression -- a real array of tasks still counts correctly
# ---------------------------------------------------------------------------
echo ""
echo -e "${YELLOW}=== Case C: no regression on valid input ===${NC}"
printf '[{"id":1},{"id":2},{"id":3}]' > "$WORK_DIR/.loki/queue/pending.json"
printf '{"currentPhase":"build"}'     > "$WORK_DIR/.loki/state/orchestrator.json"

out_c=$(cd "$WORK_DIR" && "$LOKI" status 2>/dev/null || true)

TOTAL=$((TOTAL+1))
pending_line_c=$(echo "$out_c" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^Pending Tasks:')
if echo "$pending_line_c" | grep -Eq '^Pending Tasks:[[:space:]]+3$'; then
    log_pass "Pending Tasks renders '3' for a 3-element array (no regression)"
else
    log_fail "Pending Tasks (valid array)" "got: [$pending_line_c]"
fi

TOTAL=$((TOTAL+1))
orch_val_c=$(echo "$out_c" | sed 's/\x1b\[[0-9;]*m//g' \
    | awk '/^Orchestrator State:/{getline; print; exit}')
if [ "$orch_val_c" = "build" ]; then
    log_pass "Orchestrator State renders 'build' for a valid file (no regression)"
else
    log_fail "Orchestrator State (valid)" "got: [$orch_val_c]"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "===================================================="
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} (of $TOTAL)"
echo "===================================================="

[ "$FAIL" -gt 0 ] && exit 1
exit 0
