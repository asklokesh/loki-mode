#!/usr/bin/env bash
# test-checklist-gate-failclosed.sh -- RUN-25 iter 13 (Wave B #4): the council
# checklist hard gate must fail CLOSED when the verification-results.json is
# PRESENT-but-corrupt (a checklist WAS generated, possibly with a failing
# critical item, but we cannot read it). The old code printed PASS on
# JSONDecodeError and ended the subshell with `|| echo PASS`, clearing the FIRST
# hard gate on a broken file/host -- a fake-green.
#
# Sources the REAL completion-council.sh (source-time is definitions only) and
# stubs the logging helpers (defined in run.sh), following the proven pattern of
# tests/test-council-track-iteration.sh. No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC="$SCRIPT_DIR/../autonomy/completion-council.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }

[ -f "$CC" ] || { echo "FATAL: completion-council.sh not found"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }

# Stub the loggers (live in run.sh, not this file) BEFORE sourcing.
log_info() { :; }
log_warn() { :; }
log_error() { :; }
log_success() { :; }
log_header() { :; }
record_trust_event_bash() { :; }

# shellcheck disable=SC1090
source "$CC" 2>/dev/null || true

type council_checklist_gate >/dev/null 2>&1 \
  || { echo "FATAL: council_checklist_gate not defined after sourcing"; exit 2; }

# run_gate <cwd> : run the real gate from <cwd> with a writable state dir; echo
# PASS if rc 0 else BLOCK.
run_gate() {
    local dir="$1"
    (
        cd "$dir" || exit 3
        COUNCIL_STATE_DIR="$dir/.loki/council"
        mkdir -p "$COUNCIL_STATE_DIR"
        if council_checklist_gate; then echo "PASS"; else echo "BLOCK"; fi
    )
}

mkroot() { local d; d="$(mktemp -d)"; mkdir -p "$d/.loki/checklist"; echo "$d"; }

# 1. absent checklist -> PASS (backwards compatible, nothing to verify)
D1="$(mkroot)"
[ "$(run_gate "$D1")" = "PASS" ] && ok || fail "absent checklist should pass-through (rc 0)"
rm -rf "$D1"

# 2. PRESENT-but-corrupt results -> BLOCK (fail closed)
D2="$(mkroot)"
printf 'not valid json {{{\n' > "$D2/.loki/checklist/verification-results.json"
[ "$(run_gate "$D2")" = "BLOCK" ] && ok || fail "corrupt results should BLOCK (fail-closed), got PASS"
rm -rf "$D2"

# 3. empty file (0 bytes, present) -> BLOCK (unparseable)
D3="$(mkroot)"
: > "$D3/.loki/checklist/verification-results.json"
[ "$(run_gate "$D3")" = "BLOCK" ] && ok || fail "empty results file should BLOCK, got PASS"
rm -rf "$D3"

# 4. clean results with a failing CRITICAL item -> BLOCK
D4="$(mkroot)"
cat > "$D4/.loki/checklist/verification-results.json" <<'JSON'
{"categories":[{"items":[{"priority":"critical","status":"failing","id":"x","title":"boom"}]}]}
JSON
[ "$(run_gate "$D4")" = "BLOCK" ] && ok || fail "critical failing item should BLOCK"
rm -rf "$D4"

# 5. clean results, all verified -> PASS (control: not over-blocking)
D5="$(mkroot)"
cat > "$D5/.loki/checklist/verification-results.json" <<'JSON'
{"categories":[{"items":[{"priority":"critical","status":"verified","id":"x","title":"ok"}]}]}
JSON
[ "$(run_gate "$D5")" = "PASS" ] && ok || fail "all-verified checklist should PASS (control)"
rm -rf "$D5"

# 6. RUN-25 iter 15 (Wave B #10): a FAILED re-verify must invalidate stale green
# results so the gate reads BLOCK, not the last iteration's cached pass.
if type council_reverify_checklist >/dev/null 2>&1; then
    D6="$(mkroot)"
    # last iteration's GREEN results + a checklist.json so reverify runs
    cat > "$D6/.loki/checklist/verification-results.json" <<'JSON'
{"categories":[{"items":[{"priority":"critical","status":"verified","id":"x","title":"ok"}]}]}
JSON
    echo '{"items":[]}' > "$D6/.loki/checklist/checklist.json"
    reverify_then_gate=$(
        cd "$D6" || exit 3
        COUNCIL_STATE_DIR="$D6/.loki/council"; mkdir -p "$COUNCIL_STATE_DIR"
        checklist_verify() { return 3; } # simulate a re-verify crash this iteration
        council_reverify_checklist
        if council_checklist_gate; then echo "PASS"; else echo "BLOCK"; fi
    )
    [ "$reverify_then_gate" = "BLOCK" ] && ok || fail "failed re-verify should invalidate stale green -> gate BLOCK, got PASS"
    rm -rf "$D6"
fi

echo ""
echo "test-checklist-gate-failclosed: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
