#!/usr/bin/env bash
# test-loki-why-stall.sh -- RUN-25 iter 23 (Wave D #6): `loki why` on a paused/
# stuck run now names the REAL stall reason (the runner's UNCERTAINTY_ESCALATION
# stuck-detector + the convergence signal) instead of a generic "resume" hint, so
# an operator asking "why is it stuck" gets a real answer. Reads existing state
# files only. Drives the REAL command via bin/loki (the why body has an embedded
# heredoc that defeats awk-extraction, so we exercise it end to end).
#
# No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$REPO/bin/loki"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }
[ -f "$BIN" ] || { echo "FATAL: bin/loki not found"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }

why_in() {
    # $1 = working dir; runs `loki why` (bash route) there, prints combined output.
    ( cd "$1" && LOKI_LEGACY_BASH=1 bash "$BIN" why 2>&1 )
}

mkrun() {
    # Create a temp run dir with a paused state; echo the dir.
    local d; d="$(mktemp -d)"
    mkdir -p "$d/.loki/state" "$d/.loki/signals" "$d/.loki/council"
    printf '%s\n' '{"status":"paused","iterationCount":7,"lastExitCode":0}' > "$d/.loki/autonomy-state.json"
    echo "$d"
}

# 1. WITHOUT the marker: no stall-reason block (generic paused guidance).
D1="$(mkrun)"
OUT1="$(why_in "$D1")"
echo "$OUT1" | grep -qi "Stall reason" && fail "no marker should NOT print a stall reason" || ok
echo "$OUT1" | grep -qi "Outcome" && ok || fail "why should still print the outcome"
rm -rf "$D1"

# 2. WITH UNCERTAINTY_ESCALATION: names the real stall reason + unstick guidance.
D2="$(mkrun)"
touch "$D2/.loki/signals/UNCERTAINTY_ESCALATION"
printf '%s\n' "iter7 no_change consecutive=4" > "$D2/.loki/council/convergence.log"
OUT2="$(why_in "$D2")"
echo "$OUT2" | grep -qi "Stall reason" && ok || fail "marker present should print a Stall reason"
echo "$OUT2" | grep -qi "UNCERTAINTY_ESCALATION" && ok || fail "should name the UNCERTAINTY_ESCALATION detector"
echo "$OUT2" | grep -q "consecutive=4" && ok || fail "should surface the convergence signal tail"
echo "$OUT2" | grep -qi "loki steer" && ok || fail "should suggest loki steer to unstick"
rm -rf "$D2"

echo ""
echo "test-loki-why-stall: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
