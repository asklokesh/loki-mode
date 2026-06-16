#!/usr/bin/env bash
# Test: spec-drift severity is blocking (P2-6).
#
# Acceptance: once a spec lock exists, REAL drift (the spec changed vs the lock)
# must emit a High-severity SPEC_DRIFT finding so that `loki verify` (default
# --block-on critical,high) returns BLOCKED. An UNLOCKED workflow or an
# unchanged (in-sync) spec must NEVER block: no lock = gate skipped, in-sync =
# gate pass, neither emits a blocking finding.
#
# This complements tests/test-spec.sh (full lifecycle) with a focused matrix on
# the severity/verdict contract that P2-6 changed (Medium/CONCERNS -> High/BLOCKED).
#
# Self-contained: each scenario runs in its own throwaway git repo under a temp
# dir, so it never touches the loki-mode working tree.

set -uo pipefail

# Isolate from the host's global/system git config so a hostile setting such as
# commit.gpgsign=true (with no signing key) cannot make every test commit fail
# rc=128. Mirrors tests/test-spec.sh.
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

# assert_not_contains <desc> <haystack> <needle>
assert_not_contains() {
    TOTAL=$((TOTAL + 1))
    case "$2" in
        *"$3"*) log_fail "$1" "output unexpectedly contains: $3" ;;
        *) log_pass "$1" ;;
    esac
}

make_repo() {
    local d
    d="$(mktemp -d -t loki-test-spec-sev.XXXXXX)"
    (
        cd "$d" || exit 1
        git init -q
        git config user.email test@loki.test
        git config user.name "loki test"
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

# Read a field from .loki/verify/evidence.json.
evidence_field() {
    python3 -c 'import json,sys; print(json.load(open(".loki/verify/evidence.json"))[sys.argv[1]])' "$1" 2>/dev/null
}

# First spec_drift finding severity (or "missing").
spec_drift_severity() {
    python3 -c '
import json
d=json.load(open(".loki/verify/evidence.json"))
f=[x for x in d["findings"] if x["category"]=="spec_drift"]
print(f[0]["severity"] if f else "missing")' 2>/dev/null
}

# Count of spec_drift findings.
spec_drift_count() {
    python3 -c '
import json
d=json.load(open(".loki/verify/evidence.json"))
print(len([x for x in d["findings"] if x["category"]=="spec_drift"]))' 2>/dev/null
}

# spec_drift gate status (or "missing").
spec_drift_gate_status() {
    python3 -c '
import json
d=json.load(open(".loki/verify/evidence.json"))
g=[x for x in d["deterministic_gates"] if x["gate"]=="spec_drift"]
print(g[0]["status"] if g else "missing")' 2>/dev/null
}

# Stage a repo with a committed spec + a committed code change so verify has a
# non-empty diff vs main (verify requires a committed delta to produce a verdict).
stage_repo_with_code() {
    printf '%s' "$FIXTURE_SPEC" > prd.md
    git add prd.md && git commit -qm init --no-gpg-sign --no-verify
    git checkout -q -b feat
    printf 'console.log("app");\n' > app.js
    git add app.js && git commit -qm "add app" --no-gpg-sign --no-verify
}

# ---------------------------------------------------------------------------
# Scenario A: locked + DRIFTED -> High finding -> verify BLOCKED (exit 2).
#             This is the core P2-6 contract.
# ---------------------------------------------------------------------------
scenario_locked_drift_blocks() {
    echo "--- Scenario A: locked + drifted -> High / BLOCKED ---"
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    stage_repo_with_code

    # Lock the spec, then drift it (append a new requirement section).
    bash "$SPEC_SH" lock prd.md >/dev/null 2>&1
    printf '\n## Billing\nNow also requires a billing module.\n' >> prd.md

    bash "$VERIFY_SH" main >/dev/null 2>&1
    local verify_rc=$?

    assert_eq "A: spec_drift gate FAILS on drift" "fail" "$(spec_drift_gate_status)"
    assert_eq "A: emits exactly one SPEC_DRIFT finding" "1" "$(spec_drift_count)"
    assert_eq "A: SPEC_DRIFT finding severity is High" "High" "$(spec_drift_severity)"
    assert_eq "A: verify verdict is BLOCKED" "BLOCKED" "$(evidence_field verdict)"
    assert_eq "A: verify exits BLOCKED(2) on High spec drift" 2 "$verify_rc"

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Scenario B: NO lock -> spec_drift gate skipped, no finding, NOT blocked by
#             spec drift. A first-run / unlocked workflow must never be blocked
#             by the spec-drift gate (the lock is opt-in: it is the explicit
#             "this spec is the contract" declaration).
# ---------------------------------------------------------------------------
scenario_unlocked_no_block() {
    echo "--- Scenario B: unlocked -> gate skipped, no spec-drift block ---"
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    stage_repo_with_code

    # Drift the spec, but NEVER lock it. There is no contract to violate.
    printf '\n## Billing\nNow also requires a billing module.\n' >> prd.md

    bash "$VERIFY_SH" main >/dev/null 2>&1

    assert_eq "B: spec_drift gate is SKIPPED without a lock" "skipped" "$(spec_drift_gate_status)"
    assert_eq "B: no SPEC_DRIFT finding without a lock" "0" "$(spec_drift_count)"

    # The verdict here is driven by the rest of verify (app.js is clean), so with
    # no spec lock the spec-drift gate cannot contribute a block: verdict must be
    # VERIFIED. (If verify's non-spec gates ever change, this catches a spec-drift
    # gate that wrongly fired without a lock.)
    assert_eq "B: verdict VERIFIED (unlocked drift does not block)" "VERIFIED" "$(evidence_field verdict)"

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Scenario C: locked + UNCHANGED -> spec_drift gate passes, no finding, no
#             spec-drift block. Locking and then NOT changing the spec is the
#             happy path and must never block.
# ---------------------------------------------------------------------------
scenario_locked_unchanged_no_block() {
    echo "--- Scenario C: locked + unchanged -> gate pass, no block ---"
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    stage_repo_with_code

    # Lock the spec and leave it untouched: the spec and lock agree.
    bash "$SPEC_SH" lock prd.md >/dev/null 2>&1

    bash "$VERIFY_SH" main >/dev/null 2>&1

    assert_eq "C: spec_drift gate PASSES when spec unchanged" "pass" "$(spec_drift_gate_status)"
    assert_eq "C: no SPEC_DRIFT finding when in sync" "0" "$(spec_drift_count)"

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Scenario D: locked + DELETED spec file -> High finding (consistent with
#             content drift). The contract the lock binds no longer exists, so
#             it must block just like content drift. Tests the hook directly.
# ---------------------------------------------------------------------------
scenario_locked_deleted_blocks() {
    echo "--- Scenario D: locked + deleted spec -> High finding ---"
    local repo; repo="$(make_repo)"
    cd "$repo" || return
    printf '%s' "$FIXTURE_SPEC" > prd.md
    git add prd.md && git commit -qm init --no-gpg-sign --no-verify

    bash "$SPEC_SH" lock prd.md >/dev/null 2>&1
    rm -f prd.md

    local hook_out hook_rc
    hook_out="$(
        # shellcheck source=/dev/null
        source "$SPEC_SH"
        spec_verify_hook ".loki/spec"
    )"
    hook_rc=$?

    assert_eq "D: hook rc is non-fatal (0)" 0 "$hook_rc"
    assert_contains "D: deleted locked spec emits a High spec_drift finding" "$hook_out" "High	spec_drift"
    assert_contains "D: message names the missing locked path" "$hook_out" "locked spec file missing: prd.md"

    cd "$SCRIPT_DIR" || true
    rm -rf "$repo"
}

main() {
    echo "================================================================"
    echo "spec-drift severity (P2-6): locked drift blocks; unlocked never does"
    echo "================================================================"
    scenario_locked_drift_blocks
    scenario_unlocked_no_block
    scenario_locked_unchanged_no_block
    scenario_locked_deleted_blocks

    echo "----------------------------------------------------------------"
    echo "Total: $TOTAL  Pass: $PASS  Fail: $FAIL"
    [ "$FAIL" -eq 0 ]
}

main "$@"
