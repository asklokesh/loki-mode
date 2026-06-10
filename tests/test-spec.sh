#!/usr/bin/env bash
# Test: loki spec (living spec) lifecycle + verify integration.
#
# Exercises the full lock/status/sync lifecycle on a fixture spec:
#   create spec -> lock -> mutate spec -> status detects CHANGED (exit 1)
#   -> sync -> status back in sync (exit 0)
# Plus: ADDED/REMOVED detection, drift-report.json shape, the verify
# SPEC_DRIFT integration (drift -> Medium finding -> CONCERNS), and the
# graceful no-op when no lock exists.
#
# Self-contained: each scenario runs in its own throwaway git repo under a
# temp dir, so it never touches the loki-mode working tree.

set -uo pipefail

# Isolate from the host's global/system git config so a hostile setting such as
# commit.gpgsign=true (with no signing key) cannot make every test commit fail
# rc=128. Exported at top level so it is inherited by every subshell and every
# child `bash "$SPEC_SH"` invocation below. Mirrors tests/test-evidence-gate.sh.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEC_SH="$SCRIPT_DIR/../autonomy/spec.sh"
VERIFY_SH="$SCRIPT_DIR/../autonomy/verify.sh"

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); }

# assert_eq <desc> <expected> <actual>
assert_eq() {
    TOTAL=$((TOTAL + 1))
    if [ "$2" = "$3" ]; then
        log_pass "$1"
    else
        log_fail "$1" "expected '$2', got '$3'"
    fi
}

# assert_contains <desc> <haystack> <needle>
assert_contains() {
    TOTAL=$((TOTAL + 1))
    case "$2" in
        *"$3"*) log_pass "$1" ;;
        *) log_fail "$1" "output missing: $3" ;;
    esac
}

make_repo() {
    local d
    d="$(mktemp -d -t loki-test-spec.XXXXXX)"
    (
        cd "$d" || exit 1
        git init -q
        git config user.email test@loki.test
        git config user.name "loki test"
        # Repo-local gpgsign=false persists to .git/config on disk so it overrides
        # a hostile global commit.gpgsign=true across every scenario commit below.
        git config commit.gpgsign false
        git checkout -q -b main
    )
    printf '%s\n' "$d"
}

FIXTURE_SPEC='# My Product

## Authentication
Users authenticate to use the product.

- [ ] Support email and password login
- [ ] Support OAuth login

## Dashboard
The dashboard shows live metrics.
'

# ---------------------------------------------------------------------------
# Scenario 1: lock -> status(in-sync) -> mutate -> status(CHANGED, exit 1)
#             -> sync -> status(in-sync, exit 0)
# ---------------------------------------------------------------------------
scenario_lifecycle() {
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    printf '%s' "$FIXTURE_SPEC" > prd.md
    git add prd.md && git commit -qm "init spec" --no-gpg-sign --no-verify

    local out rc

    # lock
    out="$(bash "$SPEC_SH" lock prd.md 2>&1)"; rc=$?
    assert_eq "lock exits 0" 0 "$rc"
    assert_contains "lock reports requirements locked" "$out" "Locked"
    TOTAL=$((TOTAL + 1))
    if [ -f .loki/spec/spec.lock ]; then log_pass "lock writes .loki/spec/spec.lock"; else log_fail "lock writes spec.lock" "file missing"; fi

    # status in sync
    out="$(bash "$SPEC_SH" status prd.md 2>&1)"; rc=$?
    assert_eq "status exits 0 when in sync" 0 "$rc"
    assert_contains "status reports SPEC-TRUE when in sync" "$out" "SPEC-TRUE"

    # mutate a section body
    printf '%s\n' "The dashboard also exports CSV and shows alerts." >> prd.md

    # status detects drift -> exit 1
    out="$(bash "$SPEC_SH" status prd.md 2>&1)"; rc=$?
    assert_eq "status exits 1 on drift" 1 "$rc"
    assert_contains "status reports CHANGED count" "$out" "CHANGED:"
    assert_contains "status reports SPEC-DRIFTED" "$out" "SPEC-DRIFTED"

    # drift-report.json reflects the change
    TOTAL=$((TOTAL + 1))
    if [ -f .loki/spec/drift-report.json ]; then
        local changed
        changed="$(python3 -c 'import json;print(json.load(open(".loki/spec/drift-report.json"))["summary"]["changed"])' 2>/dev/null)"
        if [ "${changed:-0}" -ge 1 ]; then
            log_pass "drift-report.json records >=1 CHANGED requirement"
        else
            log_fail "drift-report.json CHANGED" "expected >=1, got '$changed'"
        fi
    else
        log_fail "drift-report.json exists" "file missing"
    fi

    # sync re-locks
    out="$(bash "$SPEC_SH" sync prd.md 2>&1)"; rc=$?
    assert_eq "sync exits 0" 0 "$rc"

    # status back in sync
    out="$(bash "$SPEC_SH" status prd.md 2>&1)"; rc=$?
    assert_eq "status exits 0 after sync" 0 "$rc"
    assert_contains "status reports SPEC-TRUE after sync" "$out" "SPEC-TRUE"

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Scenario 2: ADDED and REMOVED detection.
# ---------------------------------------------------------------------------
scenario_added_removed() {
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    printf '%s' "$FIXTURE_SPEC" > prd.md
    git add prd.md && git commit -qm init --no-gpg-sign --no-verify
    bash "$SPEC_SH" lock prd.md >/dev/null 2>&1

    # Add a brand new requirement section and remove an existing checklist item.
    # Remove the OAuth checklist line, add a Reporting heading.
    grep -v "Support OAuth login" prd.md > prd.tmp && mv prd.tmp prd.md
    printf '\n## Reporting\nGenerate weekly reports.\n' >> prd.md

    local out rc
    out="$(bash "$SPEC_SH" status prd.md 2>&1)"; rc=$?
    assert_eq "status exits 1 on add+remove drift" 1 "$rc"
    assert_contains "status shows ADDED requirement" "$out" "ADDED"
    assert_contains "status shows REMOVED requirement" "$out" "REMOVED"

    local added removed
    added="$(python3 -c 'import json;print(json.load(open(".loki/spec/drift-report.json"))["summary"]["added"])' 2>/dev/null)"
    removed="$(python3 -c 'import json;print(json.load(open(".loki/spec/drift-report.json"))["summary"]["removed"])' 2>/dev/null)"
    TOTAL=$((TOTAL + 1))
    if [ "${added:-0}" -ge 1 ]; then log_pass "drift-report records ADDED >=1"; else log_fail "ADDED count" "got '$added'"; fi
    TOTAL=$((TOTAL + 1))
    if [ "${removed:-0}" -ge 1 ]; then log_pass "drift-report records REMOVED >=1"; else log_fail "REMOVED count" "got '$removed'"; fi

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Scenario 3: status before any lock -> usage error exit 2.
# ---------------------------------------------------------------------------
scenario_no_lock() {
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    printf '%s' "$FIXTURE_SPEC" > prd.md
    git add prd.md && git commit -qm init --no-gpg-sign --no-verify

    local out rc
    out="$(bash "$SPEC_SH" status prd.md 2>&1)"; rc=$?
    assert_eq "status without a lock exits 2 (usage)" 2 "$rc"
    assert_contains "status without a lock explains how to lock" "$out" "loki spec lock"

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Scenario 4: --json status emits a machine-readable report on stdout.
# ---------------------------------------------------------------------------
scenario_json() {
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    printf '%s' "$FIXTURE_SPEC" > prd.md
    git add prd.md && git commit -qm init --no-gpg-sign --no-verify
    bash "$SPEC_SH" lock prd.md >/dev/null 2>&1

    local out rc
    out="$(bash "$SPEC_SH" status --json prd.md 2>/dev/null)"; rc=$?
    assert_eq "status --json exits 0 when in sync" 0 "$rc"
    TOTAL=$((TOTAL + 1))
    if printf '%s' "$out" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert "in_sync" in d' 2>/dev/null; then
        log_pass "status --json emits valid JSON with in_sync field"
    else
        log_fail "status --json JSON" "stdout was not valid drift-report JSON"
    fi

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Scenario 5: verify integration. Drift -> SPEC_DRIFT Medium finding -> CONCERNS.
#             No lock -> spec_drift gate skipped, no finding.
# ---------------------------------------------------------------------------
scenario_verify_integration() {
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    printf '%s' "$FIXTURE_SPEC" > prd.md
    git add prd.md && git commit -qm init --no-gpg-sign --no-verify

    # Branch with a committed code change so verify has a non-empty diff vs main.
    git checkout -q -b work
    printf 'console.log("hi")\n' > app.js
    git add app.js && git commit -qm "add app" --no-gpg-sign --no-verify

    # ---- No lock yet: spec_drift gate skipped, no SPEC_DRIFT finding. ----
    bash "$VERIFY_SH" main >/dev/null 2>&1
    if [ -f .loki/verify/evidence.json ]; then
        local gate_status drift_findings
        gate_status="$(python3 -c '
import json
d=json.load(open(".loki/verify/evidence.json"))
g=[x for x in d["deterministic_gates"] if x["gate"]=="spec_drift"]
print(g[0]["status"] if g else "missing")' 2>/dev/null)"
        assert_eq "verify spec_drift gate skipped when no lock" "skipped" "$gate_status"
        drift_findings="$(python3 -c '
import json
d=json.load(open(".loki/verify/evidence.json"))
print(len([f for f in d["findings"] if f["category"]=="spec_drift"]))' 2>/dev/null)"
        assert_eq "verify emits no SPEC_DRIFT finding without a lock" "0" "$drift_findings"
    else
        log_fail "verify evidence.json (no-lock)" "missing"
    fi

    # ---- Lock the spec, then drift it, then verify. ----
    bash "$SPEC_SH" lock prd.md >/dev/null 2>&1
    printf '%s\n' "Now also requires SSO." >> prd.md

    bash "$VERIFY_SH" main >/dev/null 2>&1
    local verify_rc=$?

    TOTAL=$((TOTAL + 1))
    local verdict finding_sev finding_cat
    verdict="$(python3 -c 'import json;print(json.load(open(".loki/verify/evidence.json"))["verdict"])' 2>/dev/null)"
    if [ "$verdict" = "CONCERNS" ] || [ "$verdict" = "BLOCKED" ]; then
        log_pass "verify verdict is CONCERNS/BLOCKED on spec drift (got $verdict)"
    else
        log_fail "verify verdict on drift" "expected CONCERNS, got '$verdict'"
    fi

    finding_cat="$(python3 -c '
import json
d=json.load(open(".loki/verify/evidence.json"))
f=[x for x in d["findings"] if x["category"]=="spec_drift"]
print(f[0]["category"] if f else "missing")' 2>/dev/null)"
    assert_eq "verify emits a SPEC_DRIFT finding on drift" "spec_drift" "$finding_cat"

    finding_sev="$(python3 -c '
import json
d=json.load(open(".loki/verify/evidence.json"))
f=[x for x in d["findings"] if x["category"]=="spec_drift"]
print(f[0]["severity"] if f else "missing")' 2>/dev/null)"
    assert_eq "SPEC_DRIFT finding severity is Medium" "Medium" "$finding_sev"

    # verify exit should be CONCERNS (1) given a Medium-only drift finding.
    assert_eq "verify exits CONCERNS(1) on Medium spec drift" 1 "$verify_rc"

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Scenario 6: lock in a git repo with NO commits records an honest SHA.
#             `git rev-parse HEAD` prints the literal "HEAD" on an empty repo, so
#             the lock used to store "HEAD" as the locked_head. The fix records
#             "no-commits" and prints honestly (no "HEAD HEAD" artifact).
# ---------------------------------------------------------------------------
scenario_no_commit_lock() {
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    printf '%s' "$FIXTURE_SPEC" > prd.md
    # Deliberately do NOT commit: the repo has no commits / no resolvable HEAD.

    local out rc
    out="$(bash "$SPEC_SH" lock prd.md 2>&1)"; rc=$?
    assert_eq "lock exits 0 in a no-commit repo" 0 "$rc"

    local locked_head
    locked_head="$(python3 -c 'import json;print(json.load(open(".loki/spec/spec.lock"))["locked_head"])' 2>/dev/null)"
    assert_eq "no-commit lock records locked_head=no-commits (not literal HEAD)" "no-commits" "$locked_head"

    TOTAL=$((TOTAL + 1))
    case "$out" in
        *"HEAD HEAD"*) log_fail "no-commit lock prints honestly" "stdout contained dishonest 'HEAD HEAD'" ;;
        *) log_pass "no-commit lock prints honestly (no 'HEAD HEAD' artifact)" ;;
    esac

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Scenario 7 (MEDIUM-4): the lock recorded a spec path, but that spec file is
#             now DELETED. spec_verify_hook must emit a Medium spec_drift finding
#             ("locked spec file missing: <path>") and must NOT silently pass or
#             fall back to spec_resolve_source (comparing a different candidate).
# ---------------------------------------------------------------------------
scenario_deleted_locked_spec() {
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    printf '%s' "$FIXTURE_SPEC" > prd.md
    git add prd.md && git commit -qm init --no-gpg-sign --no-verify

    # Lock against prd.md (records spec_path=prd.md in spec.lock).
    bash "$SPEC_SH" lock prd.md >/dev/null 2>&1

    # Plant a DIFFERENT candidate that spec_resolve_source would otherwise pick
    # up (PRD.md is in the resolution chain). The fix must NOT fall back to it.
    printf '# Decoy\n\n- [ ] unrelated\n' > PRD.md

    # Delete the locked spec file.
    rm -f prd.md

    # Source spec.sh and call the hook directly to capture the TSV finding it
    # emits on stdout (verify.sh consumes this same hook output).
    local hook_out hook_rc
    hook_out="$(
        # shellcheck source=/dev/null
        source "$SPEC_SH"
        spec_verify_hook ".loki/spec"
    )"
    hook_rc=$?

    assert_eq "deleted-locked-spec: hook rc is non-fatal (0)" 0 "$hook_rc"
    assert_contains "deleted-locked-spec: emits a Medium spec_drift finding" "$hook_out" "Medium	spec_drift"
    assert_contains "deleted-locked-spec: message names the missing locked path" "$hook_out" "locked spec file missing: prd.md"
    # The finding must reference the LOCKED path (prd.md), never the decoy (PRD.md).
    TOTAL=$((TOTAL + 1))
    case "$hook_out" in
        *"PRD.md"*) log_fail "deleted-locked-spec: no fallback to a different candidate" "finding referenced decoy PRD.md" ;;
        *) log_pass "deleted-locked-spec: no fallback to a different candidate (decoy PRD.md not referenced)" ;;
    esac

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

echo "Running loki spec lifecycle tests..."
echo ""
scenario_lifecycle
scenario_added_removed
scenario_no_lock
scenario_json
scenario_verify_integration
scenario_no_commit_lock
scenario_deleted_locked_spec

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (out of $TOTAL)"
echo "========================================"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
