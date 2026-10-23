#!/usr/bin/env bash
# tests/test-monorepo-rejected-cmd-inconclusive.sh -- BACKLOG 62.
#
# A LOKI_MONOREPO_TEST_CMD rejected by the whitelist in enforce_test_coverage
# (autonomy/run.sh) ran nothing, yet it left test_passed=true and skipped the
# no-runner record, so test-results.json read pass:true and unit-tests.pass
# (which the receipt reads as "unit_tests passed") was touched.
#
# Contract: a rejected command records the no-runner shape, pass "inconclusive",
# status not_run, no unit-tests.pass (a stale one from an earlier iteration is
# removed), .test-results.iter stamped, _LOKI_TEST_SUITE_STATUS=not_run, rc 0.
# Positive control: a whitelisted command in the same fixture still records a
# real pass, so the fixture provably reaches the monorepo-custom branch.
#
# Sources the real run.sh (main and self-copy are inert when sourced) and calls
# the real enforce_test_coverage in a throwaway TARGET_DIR.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed. (Not a fail.)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/monorej.XXXXXX")" || { echo "FAIL: mktemp"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# cd before sourcing: provider detection writes .loki/state relative to CWD.
cd "$WORK" || exit 1
# shellcheck disable=SC1090
. "$RUN_SH"
log_info()  { :; }
log_warn()  { :; }
log_error() { :; }
log_step()  { :; }

field() {
    _F="$1/.loki/quality/test-results.json" _K="$2" python3 -c "
import json, os
try:
    v = json.load(open(os.environ['_F'])).get(os.environ['_K'])
except Exception:
    raise SystemExit(0)
print(json.dumps(v))"
}

make_monorepo() {
    local d="$WORK/$1"
    mkdir -p "$d/packages/a" "$d/.loki/quality"
    printf '%s\n' '{"name":"mono","private":true,"workspaces":["packages/*"]}' > "$d/package.json"
    printf '%s\n' '{"name":"a"}' > "$d/packages/a/package.json"
    # A stale pass marker from an earlier iteration must not survive.
    touch "$d/.loki/quality/unit-tests.pass"
    printf '%s\n' "$d"
}

# --- Rejected command -------------------------------------------------------
P="$(make_monorepo rejected)"
_LOKI_TEST_SUITE_STATUS=""
TARGET_DIR="$P" ITERATION_COUNT=7 LOKI_MONOREPO_TEST_CMD='npm test; true' enforce_test_coverage
rc=$?
[ "$rc" -eq 0 ] && ok "rejected: returns 0 (non-blocking)" || bad "rejected: rc" "got $rc"
v="$(field "$P" pass)"
[ "$v" = '"inconclusive"' ] && ok "rejected: pass is \"inconclusive\"" || bad "rejected: pass" "got $v"
v="$(field "$P" status)"
[ "$v" = '"not_run"' ] && ok "rejected: status not_run" || bad "rejected: status" "got $v"
v="$(field "$P" runner)"
[ "$v" = '"monorepo-custom-rejected"' ] && ok "rejected: runner names the rejection" || bad "rejected: runner" "got $v"
v="$(field "$P" exit_code)"
[ "$v" = 'null' ] && ok "rejected: exit_code null (nothing ran)" || bad "rejected: exit_code" "got $v"
[ ! -e "$P/.loki/quality/unit-tests.pass" ] && ok "rejected: no unit-tests.pass" || bad "rejected: unit-tests.pass present" ""
v="$(cat "$P/.loki/quality/.test-results.iter" 2>/dev/null)"
[ "$v" = "7" ] && ok "rejected: .test-results.iter stamped" || bad "rejected: .test-results.iter" "got '$v'"
[ "$_LOKI_TEST_SUITE_STATUS" = "not_run" ] && ok "rejected: _LOKI_TEST_SUITE_STATUS=not_run" || bad "rejected: suite status" "got '$_LOKI_TEST_SUITE_STATUS'"

# --- Positive control: whitelisted command runs and passes ------------------
P="$(make_monorepo accepted)"
rm -f "$P/.loki/quality/unit-tests.pass"
_LOKI_TEST_SUITE_STATUS=""
TARGET_DIR="$P" ITERATION_COUNT=7 LOKI_MONOREPO_TEST_CMD='true' enforce_test_coverage
rc=$?
[ "$rc" -eq 0 ] && ok "control: whitelisted command returns 0" || bad "control: rc" "got $rc"
v="$(field "$P" runner)"
[ "$v" = '"monorepo-custom"' ] && ok "control: fixture reaches monorepo-custom" || bad "control: runner" "got $v"
v="$(field "$P" pass)"
[ "$v" = 'true' ] && ok "control: pass true" || bad "control: pass" "got $v"
[ -e "$P/.loki/quality/unit-tests.pass" ] && ok "control: unit-tests.pass touched" || bad "control: unit-tests.pass missing" ""

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
