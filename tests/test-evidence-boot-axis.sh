#!/usr/bin/env bash
# test-evidence-boot-axis.sh -- RUN-25 iter 20 (Wave D #1): the completion
# evidence gate now has a RUNTIME-BOOT axis. The most load-bearing claim of a
# spec-to-product builder is "the app runs", and the gate never checked it. A
# SERVEABLE app confirmed unhealthy -> BLOCK; a non-web project (no serveable
# runner) or an un-probed one -> inconclusive pass-through (must not deadlock a
# CLI/library). app_runner_health_check already writes .loki/app-runner/health.json.
#
# Drives the REAL council_evidence_gate (sourced) with synthetic app-runner
# fixtures, isolating the boot axis by making the diff + test axes pass. No emojis.
# No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC="$SCRIPT_DIR/../autonomy/completion-council.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }
[ -f "$CC" ] || { echo "FATAL: completion-council.sh not found"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }

log_info() { :; }
log_warn() { :; }
log_error() { :; }
log_success() { :; }
log_header() { :; }
record_trust_event_bash() { :; }
# shellcheck disable=SC1090
source "$CC" 2>/dev/null || true
type council_evidence_gate >/dev/null 2>&1 || { echo "FATAL: council_evidence_gate not defined"; exit 2; }

# gate_boot <state-json | ""> <health-json | ""> : run the gate in a temp repo
# where the diff + test axes are made to PASS (a real commit + a green
# test-results.json), so ONLY the boot axis can cause a block. echo PASS if the
# gate returns 0, else BLOCK.
gate_boot() {
    local state="$1" health="$2"
    (
        d="$(mktemp -d)"; cd "$d" || exit 3
        git init -q; git config user.email t@t; git config user.name t; git config commit.gpgsign false
        echo "base" > f.txt; git add -A; git commit -qm init
        # non-empty diff vs run-start SHA (satisfies the diff axis)
        _LOKI_RUN_START_SHA="$(git rev-parse HEAD)"
        echo "changed" >> f.txt; git add -A
        mkdir -p .loki/quality .loki/app-runner .loki/council
        # green test results (satisfies the test axis affirmatively)
        printf '%s\n' '{"runner":"vitest","pass":true,"status":"passed","passed_count":1,"failed_count":0}' > .loki/quality/test-results.json
        [ -n "$state" ] && printf '%s\n' "$state" > .loki/app-runner/state.json
        [ -n "$health" ] && printf '%s\n' "$health" > .loki/app-runner/health.json
        COUNCIL_STATE_DIR="$d/.loki/council"
        # provenance re-run would need the test to actually pass on old code; keep
        # it simple by disabling the provenance re-run path (no LOKI_TEST_COMMAND).
        if council_evidence_gate; then echo "PASS"; else echo "BLOCK"; fi
        rm -rf "$d"
    )
}

SERVEABLE_HEALTHY_STATE='{"status":"running","primary_service":"web","url":"http://localhost:3000"}'
SERVEABLE_UNHEALTHY_STATE='{"status":"running","primary_service":"web","url":"http://localhost:3000"}'
HEALTH_OK='{"ok": true, "checked_at": "t"}'
HEALTH_BAD='{"ok": false, "checked_at": "t"}'

# 1. serveable app + healthy -> PASS (boot axis affirmative, not blocking)
[ "$(gate_boot "$SERVEABLE_HEALTHY_STATE" "$HEALTH_OK")" = "PASS" ] && ok || fail "serveable+healthy should PASS"

# 2. serveable app + UNHEALTHY -> BLOCK (the app does not serve -> not done)
[ "$(gate_boot "$SERVEABLE_UNHEALTHY_STATE" "$HEALTH_BAD")" = "BLOCK" ] && ok || fail "serveable+unhealthy should BLOCK (boot_fails)"

# 3. NO app-runner artifacts (CLI/library) -> PASS (inconclusive pass-through)
[ "$(gate_boot "" "")" = "PASS" ] && ok || fail "no app-runner (CLI/library) should PASS (inconclusive)"

# 4. non-serveable runner (status none) + unhealthy -> PASS (nothing to boot)
[ "$(gate_boot '{"status":"none","primary_service":"","url":""}' "$HEALTH_BAD")" = "PASS" ] && ok || fail "non-serveable runner should PASS (inconclusive, not blocked)"

# 5. serveable app but NO health probe recorded -> PASS (inconclusive pass-through)
[ "$(gate_boot "$SERVEABLE_HEALTHY_STATE" "")" = "PASS" ] && ok || fail "serveable but un-probed should PASS (inconclusive)"

# 6. opt-out LOKI_EVIDENCE_BOOT_GATE=0: even a serveable+unhealthy app does NOT block
if [ "$(LOKI_EVIDENCE_BOOT_GATE=0 gate_boot "$SERVEABLE_UNHEALTHY_STATE" "$HEALTH_BAD")" = "PASS" ]; then ok; else fail "LOKI_EVIDENCE_BOOT_GATE=0 should disable the boot block"; fi

# 7. the block report RECORDS the boot axis (checks.boot.ok == false), so a
# consumer can tell WHICH axis blocked. Run the gate leaving the report in place.
BR="$(
    d="$(mktemp -d)"; cd "$d" || exit 3
    git init -q; git config user.email t@t; git config user.name t; git config commit.gpgsign false
    echo "base" > f.txt; git add -A; git commit -qm init
    _LOKI_RUN_START_SHA="$(git rev-parse HEAD)"
    echo "changed" >> f.txt; git add -A
    mkdir -p .loki/quality .loki/app-runner .loki/council
    printf '%s\n' '{"runner":"vitest","pass":true,"status":"passed","passed_count":1,"failed_count":0}' > .loki/quality/test-results.json
    printf '%s\n' "$SERVEABLE_UNHEALTHY_STATE" > .loki/app-runner/state.json
    printf '%s\n' "$HEALTH_BAD" > .loki/app-runner/health.json
    COUNCIL_STATE_DIR="$d/.loki/council"
    council_evidence_gate >/dev/null 2>&1 || true
    cat "$d/.loki/council/evidence-block.json" 2>/dev/null
    rm -rf "$d"
)"
if command -v python3 >/dev/null 2>&1; then
    echo "$BR" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d['checks']['boot']['ok'] is False else 1)" 2>/dev/null \
        && ok || fail "block report should record checks.boot.ok=false on a boot block"
else
    ok  # no python3: skip the JSON assertion, don't fail the suite
fi

echo ""
echo "test-evidence-boot-axis: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
