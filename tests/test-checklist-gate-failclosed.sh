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

# 7. Walled check author: when the author step fails (provider unavailable, so
# the reply is empty), the real checklist_author leaves the critical failing
# sentinel and the gate BLOCKs. A completed build cannot pass on a checklist
# nobody authored.
D7="$(mkroot)"
printf '# PRD\nGreet people.\n' > "$D7/spec.md"
printf '{}\n' > "$D7/package.json"
author_then_gate=$(
    cd "$D7" || exit 3
    COUNCIL_STATE_DIR="$D7/.loki/council"; mkdir -p "$COUNCIL_STATE_DIR"
    export CHECKLIST_ENABLED=true LOKI_PROVIDER=no-such-provider TMPDIR="$D7"
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/../autonomy/prd-checklist.sh"
    checklist_init "$D7/spec.md"
    checklist_author "$D7/spec.md" >/dev/null 2>&1
    echo "rc=$?"
    if council_checklist_gate; then echo "PASS"; else echo "BLOCK"; fi
)
case "$author_then_gate" in
    "rc=1"*BLOCK) ok ;;
    *) fail "failed author should leave the sentinel and BLOCK the gate, got: $(echo "$author_then_gate" | tr '\n' ' ')" ;;
esac
[ ! -e "$D7/.loki/checklist/checklist.json" ] && ok || fail "failed author must not leave a checklist.json"
rm -rf "$D7"

# 8. Operator reset: `loki spec checklist-reset <sha>` clears the sentinel for
# exactly one spec sha256, refuses while a run is live, and is the only path
# that does. Two projects each end with a failed author; the sha differs.
LOKI_BIN="$SCRIPT_DIR/../autonomy/loki"
make_failed_author() { # <dir> <spec text> ; prints the spec sha256
    local d="$1"
    mkdir -p "$d/.loki/checklist"
    printf '%s\n' "$2" > "$d/spec.md"
    printf '{}\n' > "$d/package.json"
    (
        cd "$d" || exit 3
        export CHECKLIST_ENABLED=true LOKI_PROVIDER=no-such-provider TMPDIR="$d"
        # shellcheck disable=SC1091
        . "$SCRIPT_DIR/../autonomy/prd-checklist.sh"
        checklist_init "$d/spec.md"
        checklist_author "$d/spec.md" >/dev/null 2>&1
    )
    python3 -I -S -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$d/spec.md"
}
reset_in() { # <dir> <sha> ; echoes combined output, returns rc
    ( cd "$1" && LOKI_DIR="$1/.loki" LOKI_NO_BROWSER=1 bash "$LOKI_BIN" spec checklist-reset "$2" 2>&1 )
}
D8="$(mkroot)"; D9="$(mkroot)"
SHA8="$(make_failed_author "$D8" '# PRD A')"
SHA9="$(make_failed_author "$D9" '# PRD B')"
R="$D8/.loki/checklist"
[ "$SHA8" != "$SHA9" ] && grep -q check_authoring_unknown "$R/verification-results.json" \
    && [ "$(run_gate "$D8")" = "BLOCK" ] && ok || fail "setup: failed author must leave the sentinel and a BLOCKing gate"

# unknown / malformed sha: clear error, nothing cleared
out="$(reset_in "$D8" "$SHA9")"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q "no sentinel for spec sha256" && [ -f "$R/author.json" ] \
    && grep -q check_authoring_unknown "$R/verification-results.json"; } && ok || fail "an unknown sha must be a clear error and clear nothing (rc=$rc: $out)"
out="$(reset_in "$D8" "nothex")"; rc=$?
{ [ "$rc" -eq 2 ] && [ -f "$R/author.json" ]; } && ok || fail "a malformed sha must be a usage error (rc=$rc)"

# live run: refuse while a recorded pid is alive
sleep 120 &
LIVE_PID=$!
printf '%s\n' "$LIVE_PID" > "$D8/.loki/loki.pid"
out="$(reset_in "$D8" "$SHA8")"; rc=$?
{ [ "$rc" -ne 0 ] && echo "$out" | grep -q "a run is live" && [ -f "$R/author.json" ] \
    && [ "$(run_gate "$D8")" = "BLOCK" ]; } && ok || fail "reset must refuse while a run is live and keep the gate closed (rc=$rc: $out)"
kill "$LIVE_PID" 2>/dev/null; wait "$LIVE_PID" 2>/dev/null
rm -f "$D8/.loki/loki.pid"

# reset the named sha: gate stays closed up to here, then opens; the other sha is untouched
out="$(reset_in "$D8" "$SHA8")"; rc=$?
{ [ "$rc" -eq 0 ] && echo "$out" | grep -q "Cleared the check_authoring_unknown sentinel for spec sha256 $SHA8" \
    && [ ! -e "$R/author.json" ] && [ ! -e "$R/verification-results.json" ]; } && ok || fail "reset of the named sha must clear and print what it cleared (rc=$rc: $out)"
[ "$(run_gate "$D8")" = "PASS" ] && ok || fail "after reset the gate must no longer fail closed on the cleared sentinel"
{ [ -f "$D9/.loki/checklist/author.json" ] && grep -q check_authoring_unknown "$D9/.loki/checklist/verification-results.json" \
    && [ "$(run_gate "$D9")" = "BLOCK" ]; } && ok || fail "another sha's sentinel must stay untouched and BLOCKing"
out="$(reset_in "$D8" "$SHA8")"; rc=$?
[ "$rc" -ne 0 ] && ok || fail "a second reset of the same sha must be an error, not a silent success"
rm -rf "$D8" "$D9"

echo ""
echo "test-checklist-gate-failclosed: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
