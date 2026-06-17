#!/usr/bin/env bash
# test-run-start-estimate.sh
#
# C4 regression test: before any real spend, run_autonomous must SHOW the user
#   (a) the budget-guard state (the cap, or that no cap is set), and
#   (b) on the non-TTY route, a cost/time estimate parsed from the real
#       estimator (loki plan --json) -- never a fabricated figure.
# The hard cap itself is enforced by check_budget_limit, which touches
# .loki/PAUSE at the cap. This test asserts BOTH halves are real, not vacuous:
#
#   1. show_run_start_estimate prints the no-cap disclosure when BUDGET_LIMIT
#      is empty, and the cap + pause-at-cap promise when it is set.
#   2. check_budget_limit FIRES at the cap: seeded spend >= cap returns 0
#      (exceeded) AND creates .loki/PAUSE -- the guard the disclosure promises.
#   3. Non-vacuity: deliberately opposite states are proven to differ, so the
#      assertions can actually distinguish behavior (a passing test that cannot
#      fail proves nothing).
#
# Self-contained: SOURCES autonomy/run.sh (its main() is guarded by a
# BASH_SOURCE==$0 check, so sourcing defines the functions WITHOUT running the
# orchestrator), then exercises the two real functions in throwaway temp dirs.
# No network, no live run. The estimate subprocess path is NOT depended on for
# pass/fail (it is TTY-gated and best-effort); the deterministic disclosure and
# the guard-at-cap behavior are what we assert.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

[ -f "$RUN_SH" ] || { echo "FAIL: cannot find $RUN_SH"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-c4-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Source run.sh to obtain the REAL function definitions. main() is guarded, so
# nothing executes. cd into the temp dir first so any boot-time top-level code
# writes into the throwaway dir, never the repo root (hermetic under local-ci).
# Silence any boot-time log noise.
cd "$TMP" || { echo "FAIL: cannot cd to temp dir"; exit 1; }
# shellcheck disable=SC1090
source "$RUN_SH" >/dev/null 2>&1

# Confirm the functions under test actually exist (catches a rename that would
# otherwise make this whole test silently vacuous).
type show_run_start_estimate >/dev/null 2>&1 || { echo "FAIL: show_run_start_estimate not defined by run.sh"; exit 1; }
type check_budget_limit      >/dev/null 2>&1 || { echo "FAIL: check_budget_limit not defined by run.sh"; exit 1; }

# Make log output plain + capturable, and neuter event emission.
log_info()  { echo "[INFO] $*"; }
log_warn()  { echo "[WARN] $*"; }
log_error() { echo "[ERROR] $*"; }
emit_event_json() { :; }
ITERATION_COUNT=0

# --- Test 1: no-cap disclosure shown at run start ---
out="$(BUDGET_LIMIT="" show_run_start_estimate "" </dev/null 2>&1)"
if printf '%s' "$out" | grep -q "no cap set"; then
  pass "no-cap disclosure shown at run start"
else
  fail "no-cap disclosure missing (got: $out)"
fi

# --- Test 2: cap disclosure includes the pause-at-cap promise ---
out="$(BUDGET_LIMIT="5.00" show_run_start_estimate "" </dev/null 2>&1)"
if printf '%s' "$out" | grep -q 'hard cap \$5.00' && printf '%s' "$out" | grep -q "PAUSE"; then
  pass "cap + pause-at-cap promise shown at run start"
else
  fail "cap disclosure missing cap or pause promise (got: $out)"
fi

# --- Test 2b (non-vacuity): a cap-set run must NOT print the no-cap text ---
if printf '%s' "$out" | grep -q "no cap set"; then
  fail "non-vacuity: cap-set run wrongly printed the no-cap disclosure"
else
  pass "non-vacuity: cap-set and no-cap disclosures are distinguishable"
fi

# --- Test 3: budget guard FIRES at the cap (seed spend >= cap) ---
GDIR="$TMP/guard-fire"
mkdir -p "$GDIR/.loki/metrics/efficiency" "$GDIR/.loki/signals"
cat > "$GDIR/.loki/metrics/efficiency/iter-1.json" <<'EFF'
{"model": "opus", "cost_usd": 6.50}
EFF
out="$(cd "$GDIR" && BUDGET_LIMIT="5.00" check_budget_limit && echo "RC=exceeded" || echo "RC=within")"
if printf '%s' "$out" | grep -q "RC=exceeded" && [ -f "$GDIR/.loki/PAUSE" ]; then
  pass "budget guard fires at cap: returns exceeded AND touches .loki/PAUSE"
else
  fail "budget guard did not fire at cap (out: $out; PAUSE exists: $([ -f "$GDIR/.loki/PAUSE" ] && echo yes || echo no))"
fi

# --- Test 4 (non-vacuity): spend below cap must NOT fire / NOT create PAUSE ---
GDIR2="$TMP/guard-within"
mkdir -p "$GDIR2/.loki/metrics/efficiency" "$GDIR2/.loki/signals"
cat > "$GDIR2/.loki/metrics/efficiency/iter-1.json" <<'EFF'
{"model": "opus", "cost_usd": 1.00}
EFF
out="$(cd "$GDIR2" && BUDGET_LIMIT="100.00" check_budget_limit && echo "RC=exceeded" || echo "RC=within")"
if printf '%s' "$out" | grep -q "RC=within" && [ ! -f "$GDIR2/.loki/PAUSE" ]; then
  pass "non-vacuity: spend below cap does not fire the guard or pause"
else
  fail "guard fired below cap (out: $out; PAUSE exists: $([ -f "$GDIR2/.loki/PAUSE" ] && echo yes || echo no))"
fi

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "OK: all C4 run-start estimate + budget-guard assertions passed"
  exit 0
else
  echo "FAILED: $FAILS assertion(s) failed"
  exit 1
fi
