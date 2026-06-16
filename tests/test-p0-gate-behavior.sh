#!/usr/bin/env bash
# tests/test-p0-gate-behavior.sh -- BEHAVIORAL proof for the P0 detector gates
# (docs/P0-SWEEP-PLAN.md section 4, P0-3). The companion acceptance suite
# (tests/test-p0-verification-sweep.sh) proves the gates are WIRED (grep/structure);
# this suite proves they actually BLOCK by driving the real gate functions against
# throwaway fixtures and asserting both the return code AND the side effects.
#
# Strategy (mirrors tests/test-evidence-gate.sh):
#   1. Source the REAL autonomy/run.sh. Sourcing is inert -- run.sh guards `main`
#      behind BASH_SOURCE==$0, so nothing runs at source time.
#   2. Stub the log_* helpers AFTER the source line. run.sh DEFINES log_info/
#      log_warn/etc. at source time, so stubbing before would be clobbered.
#   3. For each case, mktemp -d a fixture dir, write a test file that the detector
#      will (or will not) flag, then call the real gate with TARGET_DIR exported.
#      We do NOT set LOKI_RUNNING_FROM_TEMP=1.
#
# Contract under test (verified against run.sh:7549/7611 + the detector sources):
#   enforce_mock_integrity      -> runs detect-mock-problems.sh --strict with
#       LOKI_SCAN_DIR=TARGET_DIR. CRITICAL/HIGH -> return 1 + write
#       TARGET_DIR/.loki/quality/mock-findings.txt; clean -> return 0.
#   enforce_mutation_integrity  -> runs detect-test-mutations.sh (NO --strict) with
#       LOKI_SCAN_DIR=TARGET_DIR. Blocks (return 1) ONLY when stdout has a [HIGH]
#       line; MED/LOW route to mutation-findings.txt and return 0.
#
# The whole point of the gate is LOKI_SCAN_DIR redirection: the detector must scan
# the FIXTURE, not the loki-mode tree. Each blocking case asserts the findings file
# names the fixture's own test file -- if the redirect silently broke, the detector
# would scan loki-mode and the finding would name a loki-mode file (or not fire),
# and that assertion would FAIL. That is the real proof, not just rc + file-exists.
#
# Cases:
#   a. Mock gate BLOCKS    -- fixture test with `expect(1).toBe(1)` (imports source
#                             so only the tautological HIGH path fires) -> rc 1 +
#                             mock-findings.txt exists + names the fixture file.
#   b. Mock gate PASSES    -- clean fixture (imports source + real assertion) -> rc 0.
#   c. Mutation NO over-block on MED-only -- low-assertion-density .test.js (MEDIUM,
#                             no HIGH) -> rc 0 + mutation-findings.txt records the
#                             advisory finding. Proves --strict was correctly avoided
#                             (--strict would have exited 1 on the MEDIUM).
#   d. Mutation gate BLOCKS on HIGH -- git fixture with one commit changing >2
#                             assertion values alongside impl -> rc 1 +
#                             mutation-findings.txt has a [HIGH] line.
#
# Each case cleans up its own mktemp dir. Final Total/Passed/Failed; exit nonzero
# on any FAIL.
#
# Skips gracefully (exit 0) when prerequisites are missing or the gate functions
# have not landed yet. The absent-impl skip is LOUD on purpose: after the gates
# land this suite MUST show PASS lines, not the SKIP banner.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Environment guards (skip, do not fail, when prerequisites are missing).
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
    echo "SKIP: git not installed; the mutation HIGH case needs a git fixture. (Not a fail.)"
    exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"
    exit 0
fi
for det in detect-mock-problems.sh detect-test-mutations.sh; do
    if [ ! -f "$SCRIPT_DIR/$det" ]; then
        echo "SKIP: tests/$det not found; cannot exercise the gate. (Not a fail.)"
        exit 0
    fi
done

# ---------------------------------------------------------------------------
# Source the real run.sh, THEN stub the log_* helpers (run.sh defines them at
# source time, so stubbing afterwards is required). Sourcing is inert: run.sh
# guards `main` behind BASH_SOURCE==$0.
# ---------------------------------------------------------------------------
# shellcheck source=/dev/null
source "$RUN_SH" >/dev/null 2>&1 || true

log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_success() { :; }
log_debug()   { :; }
log_step()    { :; }
log_header()  { :; }

# Loud, intentional skip if the implementation has not landed.
if ! type enforce_mock_integrity >/dev/null 2>&1 || ! type enforce_mutation_integrity >/dev/null 2>&1; then
    echo "SKIP: enforce_mock_integrity / enforce_mutation_integrity not yet defined in"
    echo "      $RUN_SH. The P0-3 gates have not landed. Re-run after the dev slice --"
    echo "      this suite MUST then report PASS lines, not this SKIP."
    exit 0
fi

# ---------------------------------------------------------------------------
# Per-case fixture root. Each fixture is its own mktemp -d, removed at case end.
# ---------------------------------------------------------------------------
make_fixture() { mktemp -d -t loki-p0-gate.XXXXXX; }

# Call enforce_mock_integrity inside a fixture with TARGET_DIR exported. Sets
# globals MOCK_RC and MOCK_FINDINGS (path to the findings file).
run_mock_gate() {
    local fix="$1"
    MOCK_FINDINGS="$fix/.loki/quality/mock-findings.txt"
    (
        cd "$fix" || exit 99
        export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
        export TARGET_DIR="$fix"
        enforce_mock_integrity
    )
    MOCK_RC=$?
}

# Call enforce_mutation_integrity inside a fixture with TARGET_DIR exported. Sets
# globals MUT_RC and MUT_FINDINGS.
run_mutation_gate() {
    local fix="$1"
    MUT_FINDINGS="$fix/.loki/quality/mutation-findings.txt"
    (
        cd "$fix" || exit 99
        export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
        export TARGET_DIR="$fix"
        enforce_mutation_integrity
    )
    MUT_RC=$?
}

# ===========================================================================
# Case a: Mock gate BLOCKS on a tautological assertion.
#   The fixture imports source (../) so the "never imports source" CRITICAL path
#   does NOT fire -- only the tautological HIGH path -- isolating the assertion
#   under test. Both rc=1 + findings-file presence + the findings file naming the
#   FIXTURE's own test file (proving LOKI_SCAN_DIR redirected the scan, not the
#   loki-mode tree).
# ===========================================================================
echo "Case a: mock gate BLOCKS on tautological assertion -> rc 1 + findings name fixture"
fix_a="$(make_fixture)"
mkdir -p "$fix_a/src"
printf 'export function add(a, b) { return a + b; }\n' > "$fix_a/src/calc.js"
cat > "$fix_a/src/calc.test.js" <<'EOF'
import { add } from '../src/calc.js';
test('tautology that the mock detector must flag', () => {
  expect(1).toBe(1);
});
EOF
run_mock_gate "$fix_a"
if [ "$MOCK_RC" -eq 1 ]; then ok "case a rc=1 (mock gate blocked)"; else bad "case a rc=1" "got rc=$MOCK_RC"; fi
if [ -f "$MOCK_FINDINGS" ]; then ok "case a mock-findings.txt written"; else bad "case a findings file written" "missing"; fi
# Prove the FIXTURE was scanned, not loki-mode: the findings must name our file.
if grep -q "calc.test.js" "$MOCK_FINDINGS" 2>/dev/null; then
    ok "case a findings name the fixture file (LOKI_SCAN_DIR redirected the scan)"
else
    bad "case a findings name fixture file" "calc.test.js not in $(cat "$MOCK_FINDINGS" 2>/dev/null | tr '\n' '|')"
fi
rm -rf "$fix_a"

# ===========================================================================
# Case b: Mock gate PASSES on a clean fixture (imports source + real assertion,
#   no tautology, no excessive internal mocks) -> rc 0.
# ===========================================================================
echo "Case b: mock gate PASSES on a clean fixture -> rc 0"
fix_b="$(make_fixture)"
mkdir -p "$fix_b/src"
printf 'export function add(a, b) { return a + b; }\n' > "$fix_b/src/calc.js"
cat > "$fix_b/src/calc.test.js" <<'EOF'
import { add } from '../src/calc.js';
test('add returns the real sum', () => {
  expect(add(2, 3)).toBe(5);
});
EOF
run_mock_gate "$fix_b"
if [ "$MOCK_RC" -eq 0 ]; then ok "case b rc=0 (clean fixture passes)"; else bad "case b rc=0" "got rc=$MOCK_RC"; fi
rm -rf "$fix_b"

# ===========================================================================
# Case c: Mutation gate does NOT over-block on a MED-only fixture. A
#   low-assertion-density .test.js (>5 tests, fewer assertions) produces a MEDIUM
#   finding but no HIGH. The gate runs WITHOUT --strict, so it must return 0 and
#   route the MEDIUM to mutation-findings.txt as advisory. This proves --strict
#   was correctly avoided: --strict would have exited 1 on the MEDIUM and the gate
#   would have over-blocked. The fixture is a plain mktemp dir (no git repo), so
#   the detector's commit-history HIGH check finds no repo and cannot fire.
# ===========================================================================
echo "Case c: mutation gate does NOT over-block on MED-only fixture -> rc 0 + advisory recorded"
fix_c="$(make_fixture)"
cat > "$fix_c/lowdensity.test.js" <<'EOF'
test('t1', () => { expect(1).toEqual(2); });
test('t2', () => {});
test('t3', () => {});
test('t4', () => {});
test('t5', () => {});
test('t6', () => {});
EOF
run_mutation_gate "$fix_c"
if [ "$MUT_RC" -eq 0 ]; then ok "case c rc=0 (MED-only does NOT block; --strict correctly avoided)"; else bad "case c rc=0" "got rc=$MUT_RC (gate over-blocked on MED -- did it pass --strict?)"; fi
if [ -f "$MUT_FINDINGS" ] && grep -qE '\[(MEDIUM|MED)\]' "$MUT_FINDINGS" 2>/dev/null; then
    ok "case c MEDIUM finding recorded as advisory (non-blocking)"
else
    bad "case c MED advisory recorded" "no MEDIUM line in $MUT_FINDINGS"
fi
rm -rf "$fix_c"

# ===========================================================================
# Case d: Mutation gate BLOCKS on a HIGH finding. A git fixture with one commit
#   that changes >2 assertion values alongside an implementation change (the
#   "fitting tests to code" signal) trips the detector's Check-5 HIGH path. The
#   gate (no --strict) must grep [HIGH] from stdout and return 1, writing the
#   finding to mutation-findings.txt. The detector reads git history from
#   LOKI_SCAN_DIR=TARGET_DIR, so the fixture repo (not loki-mode) is scanned.
# ===========================================================================
echo "Case d: mutation gate BLOCKS on a HIGH assertion-mutation commit -> rc 1 + [HIGH] in findings"
fix_d="$(make_fixture)"
(
    cd "$fix_d" || exit 1
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    git init -q
    git config user.email "test@loki.local"
    git config user.name "Loki Test"
    git config commit.gpgsign false
    printf 'export function f() { return 1; }\n' > impl.js
    cat > impl.test.js <<'T1'
import { f } from './impl.js';
test('a', () => { expect(f()).toBe(1); });
test('b', () => { expect(f()).toBe(1); });
test('c', () => { expect(f()).toBe(1); });
T1
    git add -A
    git commit -q --no-gpg-sign --no-verify -m "baseline" 2>/dev/null
    # Change impl AND >2 assertion values in ONE commit (the test-fitting signal).
    printf 'export function f() { return 2; }\n' > impl.js
    cat > impl.test.js <<'T2'
import { f } from './impl.js';
test('a', () => { expect(f()).toBe(2); });
test('b', () => { expect(f()).toBe(2); });
test('c', () => { expect(f()).toBe(2); });
T2
    git add -A
    git commit -q --no-gpg-sign --no-verify -m "fit tests to code" 2>/dev/null
) || bad "case d setup" "git fixture init failed"
run_mutation_gate "$fix_d"
if [ "$MUT_RC" -eq 1 ]; then ok "case d rc=1 (mutation gate blocked on HIGH)"; else bad "case d rc=1" "got rc=$MUT_RC"; fi
if [ -f "$MUT_FINDINGS" ] && grep -qF '[HIGH]' "$MUT_FINDINGS" 2>/dev/null; then
    ok "case d mutation-findings.txt has a [HIGH] line"
else
    bad "case d HIGH in findings" "no [HIGH] line in $MUT_FINDINGS"
fi
rm -rf "$fix_d"

# ---------------------------------------------------------------------------
echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
