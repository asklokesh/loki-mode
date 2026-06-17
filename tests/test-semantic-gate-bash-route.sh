#!/usr/bin/env bash
# tests/test-semantic-gate-bash-route.sh -- regression guard for v7.53.0 P1-3
# "semantic test-authenticity gate, bash route".
#
# WHAT THIS GUARDS
#   v7.53.0 wired the semantic detector (tests/detect-semantic-test-problems.sh)
#   into the BASH route (autonomy/run.sh). v7.57.0 split the posture into two
#   independent arms (see autonomy/run.sh:8329-8337):
#     - SURFACING/ADVISORY: now DEFAULT-ON, gated on LOKI_GATE_SEMANTIC_TESTS
#       (default TRUE). The mid-iteration advisory arm runs every iteration,
#       writes findings, and only surfaces (track_gate_failure) -- it NEVER
#       blocks completion.
#     - COMPLETION-BLOCKING: stays OPT-IN, gated on a SEPARATE flag
#       LOKI_GATE_SEMANTIC_TESTS_BLOCK (default OFF). Only when set does the
#       completion-promise elif reject a completion claim on a CRIT/HIGH finding.
#   The Bun route's semantics are covered by
#   loki-ts/tests/runner/quality_gates.test.ts. This test covers the BASH route:
#     A) DEFAULT BEHAVIOR (two static guard-literal assertions):
#        A1) the mid-iteration advisory arm is DEFAULT-ON -- its guard uses
#            `${LOKI_GATE_SEMANTIC_TESTS:-true}` (default true). Fails if someone
#            reverts the default to off (e.g. `:-false`).
#        A2) the completion-BLOCKING elif is OPT-IN -- it is gated on
#            `${LOKI_GATE_SEMANTIC_TESTS_BLOCK:-false}` (default off). Fails if
#            the *_BLOCK opt-in is removed (i.e. if blocking became default-on or
#            was folded back onto LOKI_GATE_SEMANTIC_TESTS).
#        Net contract: default = gate runs ADVISORY (surfaces, does not block
#        completion); blocking requires LOKI_GATE_SEMANTIC_TESTS_BLOCK.
#     B) WHEN ON, BLOCKING SEMANTICS: enforce_semantic_integrity returns 1 on a
#        CRITICAL/HIGH finding (BLOCK) and 0 on a clean tree / absent detector
#        (deny-filtered: never false-fires).
#
# STRATEGY
#   (A) is two static guard-literal assertions against run.sh (the knobs ARE the
#   call-site guards; there is no separately-invokable "default path").
#   (B) extracts enforce_semantic_integrity() from run.sh and drives it against
#   throwaway TARGET_DIRs, mirroring tests/test-semantic-test-detector.sh
#   fixtures.
#
#   RUN_SH overridable for the non-vacuity self-check.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
RUN_SH="${LOKI_RUN_SH_OVERRIDE:-$REPO_ROOT/autonomy/run.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"; exit 0
fi

# ---------------------------------------------------------------------------
# Case A (static): the v7.57.0 default contract.
#   A1) the mid-iteration advisory arm is DEFAULT-ON: its guard reads
#       ${LOKI_GATE_SEMANTIC_TESTS:-true} (default true). If someone reverts the
#       default to off, this assertion fails.
#   A2) the completion-BLOCKING elif is OPT-IN: it is gated on the SEPARATE flag
#       ${LOKI_GATE_SEMANTIC_TESTS_BLOCK:-false} (default off). If the *_BLOCK
#       opt-in is removed (blocking made default-on / folded back onto the
#       surfacing flag), this assertion fails.
# Together: default = advisory surfacing (no completion block); blocking is
# opt-in via LOKI_GATE_SEMANTIC_TESTS_BLOCK.
# ---------------------------------------------------------------------------
echo "Case A1: advisory/surfacing arm is DEFAULT-ON (guarded by \${LOKI_GATE_SEMANTIC_TESTS:-true})"
if grep -Eq '\$\{LOKI_GATE_SEMANTIC_TESTS:-true\}"[[:space:]]*=[[:space:]]*"true"' "$RUN_SH"; then
    ok "caseA1 semantic surfacing arm default-ON (LOKI_GATE_SEMANTIC_TESTS:-true)"
else
    bad "caseA1 default-on surfacing guard missing" "expected the \${LOKI_GATE_SEMANTIC_TESTS:-true} == true guard at the advisory call site"
fi

echo "Case A2: completion-BLOCKING elif is OPT-IN (gated by \${LOKI_GATE_SEMANTIC_TESTS_BLOCK:-false})"
if grep -Eq '\$\{LOKI_GATE_SEMANTIC_TESTS_BLOCK:-false\}"[[:space:]]*=[[:space:]]*"true"' "$RUN_SH"; then
    ok "caseA2 semantic completion-blocking gated by LOKI_GATE_SEMANTIC_TESTS_BLOCK (default off, opt-in)"
else
    bad "caseA2 opt-in blocking guard missing" "expected the \${LOKI_GATE_SEMANTIC_TESTS_BLOCK:-false} == true guard at the completion-promise elif"
fi

# ---------------------------------------------------------------------------
# Case B (behavioral): enforce_semantic_integrity blocking semantics.
# ---------------------------------------------------------------------------
DETECTOR="$REPO_ROOT/tests/detect-semantic-test-problems.sh"
if [ ! -f "$DETECTOR" ]; then
    echo "SKIP(B): detector not found; cannot exercise enforce_semantic_integrity. (Case A still ran.)"
    echo
    echo "semantic-gate-bash-route: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]; exit $?
fi

# Extract enforce_semantic_integrity() and eval (no run.sh top-level execution).
_fn="$(awk '/^enforce_semantic_integrity\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
if [ -z "$_fn" ]; then
    echo "SKIP(B): enforce_semantic_integrity not found in run.sh. (Case A still ran.)"
    echo
    echo "semantic-gate-bash-route: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]; exit $?
fi

log_info() { :; }
log_warn() { :; }
# SCRIPT_DIR must let "$SCRIPT_DIR/../tests/detect-semantic-test-problems.sh"
# resolve to the real detector.
SCRIPT_DIR="$REPO_ROOT/autonomy"
# shellcheck disable=SC1090
eval "$_fn"
if ! type enforce_semantic_integrity >/dev/null 2>&1; then
    echo "SKIP(B): enforce_semantic_integrity did not eval cleanly. (Case A still ran.)"
    echo
    echo "semantic-gate-bash-route: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]; exit $?
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-semgate-bash-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Fixture: clean (legitimate computed assertion) -> no CRITICAL/HIGH.
CLEAN="$WORK/clean"; mkdir -p "$CLEAN/src"
cat > "$CLEAN/src/math.ts" <<'EOF'
export function add(a: number, b: number): number { return a + b; }
EOF
cat > "$CLEAN/legit.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest';
import { add } from './src/math';
describe('legit', () => {
  it('computes', () => { expect(add(2, 2)).toBe(4); });
});
EOF

# Fixture: fake (literal echoed through a variable) -> HIGH.
FAKE="$WORK/fake"; mkdir -p "$FAKE"
cat > "$FAKE/fake.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest';
describe('fake', () => {
  it('echoes a literal through a variable', () => {
    const x = "hello";
    expect(x).toBe("hello");
  });
  it('echoes a numeric literal', () => {
    const n = 42;
    expect(n).toBe(42);
  });
});
EOF

run_gate() { ( TARGET_DIR="$1"; export TARGET_DIR; LOKI_GATE_TIMEOUT=60; export LOKI_GATE_TIMEOUT; enforce_semantic_integrity ); }

echo "Case B1: clean tree -> rc 0 (PASS, no false fire)"
rcb1=0; run_gate "$CLEAN" || rcb1=$?
[ "$rcb1" -eq 0 ] && ok "caseB1 clean tree -> rc 0" || bad "caseB1 clean tree blocked" "rc=$rcb1"

echo "Case B2: HIGH fake-test finding -> rc 1 (BLOCK)"
rcb2=0; run_gate "$FAKE" || rcb2=$?
[ "$rcb2" -eq 1 ] && ok "caseB2 HIGH finding -> rc 1 (block)" || bad "caseB2 HIGH did not block" "rc=$rcb2"

echo "Case B3: detector absent -> rc 0 (inconclusive, never block)"
# Point SCRIPT_DIR at a dir with no ../tests/detect-semantic-test-problems.sh.
rcb3=0
( SCRIPT_DIR="$WORK/no-detector/autonomy"; mkdir -p "$SCRIPT_DIR"
  # re-eval the function with the new SCRIPT_DIR in scope
  eval "$_fn"
  TARGET_DIR="$FAKE"; export TARGET_DIR
  enforce_semantic_integrity ) || rcb3=$?
[ "$rcb3" -eq 0 ] && ok "caseB3 detector absent -> rc 0 (pass-through)" || bad "caseB3 absent blocked" "rc=$rcb3"

# ---------------------------------------------------------------------------
echo
echo "semantic-gate-bash-route: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
