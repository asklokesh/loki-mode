#!/usr/bin/env bash
# tests/test-enforce-mutation-integrity.sh -- regression guard for
# enforce_mutation_integrity() (autonomy/run.sh:10505).
#
# WHAT THIS GUARDS
#   enforce_mutation_integrity() wraps tests/detect-test-mutations.sh (the real
#   Quality Gate #9 detector, run --block-high against TARGET_DIR) and blocks
#   the iteration (rc 1) iff the detector's output contains at least one
#   "[HIGH]" line, else passes (rc 0) and routes any MEDIUM/LOW lines to an
#   advisory findings file. There was no test driving this gate against a REAL
#   project fixture with an actual HIGH-severity finding -- a regression that
#   stopped counting [HIGH] lines (or swallowed the detector's rc) would let a
#   test-fitted commit (assertions mutated to match buggy output) sail through
#   completion ungated.
#
#   The only detector check that produces a [HIGH] finding is Check 5
#   (assertion value mutations in git commits): a commit that changes BOTH an
#   implementation file and more than 2 existing assertion values in a test
#   file. New test files are coverage, not mutations. This
#   test builds a real git-fixture project with exactly that commit shape (a
#   HIGH fixture) and a clean sibling project with no such commit (a clean
#   fixture), and drives the actual detector through the actual gate wrapper --
#   no finding is hand-fed, both fixtures are real project trees.
#
# STRATEGY
#   Extract ONLY enforce_mutation_integrity() from run.sh by name (avoids
#   sourcing the whole file). Point SCRIPT_DIR at the real autonomy/ dir so the
#   gate finds the real tests/detect-test-mutations.sh detector, and TARGET_DIR
#   at each fixture project in turn.
#
#   RUN_SH overridable so the non-vacuity self-check can point at a mutated copy.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
RUN_SH="${LOKI_RUN_SH_OVERRIDE:-$REPO_ROOT/autonomy/run.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v git >/dev/null 2>&1; then
    echo "SKIP: git not installed. (Not a fail.)"; exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"; exit 0
fi
if [ ! -f "$REPO_ROOT/tests/detect-test-mutations.sh" ]; then
    echo "SKIP: tests/detect-test-mutations.sh not found. (Not a fail.)"; exit 0
fi

# Extract ONLY enforce_mutation_integrity() from run.sh. Function spans from
# its `() {` line to the first line that is exactly `}` at column 0.
_fn="$(awk '/^enforce_mutation_integrity\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
if [ -z "$_fn" ]; then
    echo "SKIP: enforce_mutation_integrity not found in run.sh. Implementation not landed. (Not a fail.)"
    exit 0
fi

# Stub the two log helpers the function calls; SCRIPT_DIR points at the real
# autonomy/ dir so `$SCRIPT_DIR/../tests/detect-test-mutations.sh` resolves to
# the real detector (this test exercises the REAL detector, not a stub of it).
log_info() { :; }
log_warn() { :; }
SCRIPT_DIR="$REPO_ROOT/autonomy"
LOKI_GATE_TIMEOUT=60

# shellcheck disable=SC1090
eval "$_fn"

if ! type enforce_mutation_integrity >/dev/null 2>&1; then
    echo "SKIP: enforce_mutation_integrity did not eval cleanly. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-mutation-gate-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

git_id() { git config user.email "loki-test@test.local"; git config user.name "Loki Test"; }

# ---------------------------------------------------------------------------
# Fixture A (HIGH): a commit changes an implementation file AND mutates >2
# assertion values in the same commit -- the exact "fit the test to the
# buggy code" shape Check 5 flags as [HIGH].
# ---------------------------------------------------------------------------
HIGH_PROJ="$WORK/high-fixture"
mkdir -p "$HIGH_PROJ/tests" "$HIGH_PROJ/src"
( cd "$HIGH_PROJ" && git init -q && git_id
  cat > src/calc.js <<'EOF'
function add(a, b) { return a + b; }
module.exports = { add };
EOF
  cat > tests/calc.test.js <<'EOF'
const { add } = require('../src/calc');
test('add 2+2', () => { expect(add(2,2)).toBe(4); });
test('add 3+3', () => { expect(add(3,3)).toBe(6); });
test('add 0+0', () => { expect(add(0,0)).toBe(0); });
EOF
  git add -A && git commit -q -m "initial: add() implementation + tests"
  # Same commit changes the implementation (introduces an off-by-one bug) AND
  # mutates all three assertion expected-values to match the new buggy output.
  cat > src/calc.js <<'EOF'
function add(a, b) { return a + b + 1; }
module.exports = { add };
EOF
  cat > tests/calc.test.js <<'EOF'
const { add } = require('../src/calc');
test('add 2+2', () => { expect(add(2,2)).toBe(5); });
test('add 3+3', () => { expect(add(3,3)).toBe(7); });
test('add 0+0', () => { expect(add(0,0)).toBe(1); });
EOF
  git add -A && git commit -q -m "fix add() off-by-one (fits tests to buggy output)"
)

# ---------------------------------------------------------------------------
# Fixture B (clean): implementation changes in a commit that touches NO test
# file -- nothing for Check 5 to flag.
# ---------------------------------------------------------------------------
CLEAN_PROJ="$WORK/clean-fixture"
mkdir -p "$CLEAN_PROJ/tests" "$CLEAN_PROJ/src"
( cd "$CLEAN_PROJ" && git init -q && git_id
  cat > src/calc.js <<'EOF'
function add(a, b) { return a + b; }
module.exports = { add };
EOF
  cat > tests/calc.test.js <<'EOF'
const { add } = require('../src/calc');
test('add 2+2', () => { expect(add(2,2)).toBe(4); });
test('add 3+3', () => { expect(add(3,3)).toBe(6); });
test('add 0+0', () => { expect(add(0,0)).toBe(0); });
EOF
  git add -A && git commit -q -m "initial: add() implementation + tests"
  cat > src/util.js <<'EOF'
function square(x) { return x * x; }
module.exports = { square };
EOF
  git add -A && git commit -q -m "add square() helper (no test changes)"
)

# ---------------------------------------------------------------------------
# Fixture C (greenfield): implementation and a brand-new test file land in the
# same commit. Added assertions have no prior expectations to weaken, so this
# must pass even when the new suite contains many assertions.
# ---------------------------------------------------------------------------
GREENFIELD_PROJ="$WORK/greenfield-fixture"
mkdir -p "$GREENFIELD_PROJ/src"
( cd "$GREENFIELD_PROJ" && git init -q && git_id
  echo "greenfield" > README.md
  git add README.md && git commit -q -m "initial"
  mkdir -p tests
  cat > src/calc.js <<'EOF'
function add(a, b) { return a + b; }
module.exports = { add };
EOF
  cat > tests/calc.test.js <<'EOF'
const { add } = require('../src/calc');
test('add 1+1', () => { expect(add(1,1)).toBe(2); });
test('add 2+2', () => { expect(add(2,2)).toBe(4); });
test('add 3+3', () => { expect(add(3,3)).toBe(6); });
test('add 4+4', () => { expect(add(4,4)).toBe(8); });
EOF
  git add src/calc.js tests/calc.test.js
  git commit -q -m "add implementation with first tests"
)

# ---------------------------------------------------------------------------
# Case 1: HIGH fixture -> gate BLOCKS (rc 1), findings file records it.
# ---------------------------------------------------------------------------
TARGET_DIR="$HIGH_PROJ"
rc=0; enforce_mutation_integrity || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "HIGH-severity commit fixture -> gate BLOCKS (rc 1)"
else
    bad "HIGH-severity commit fixture -> gate BLOCKS (rc 1)" "got rc=$rc"
fi
FINDINGS_A="$HIGH_PROJ/.loki/quality/mutation-findings.txt"
if [ -f "$FINDINGS_A" ] && grep -q 'HIGH' "$FINDINGS_A"; then
    ok "HIGH fixture -> findings file records the HIGH finding"
else
    bad "HIGH fixture -> findings file records the HIGH finding" "missing or empty: $FINDINGS_A"
fi

# ---------------------------------------------------------------------------
# Case 2: clean fixture -> gate PASSES (rc 0), no findings file left behind.
# ---------------------------------------------------------------------------
TARGET_DIR="$CLEAN_PROJ"
rc=0; enforce_mutation_integrity || rc=$?
if [ "$rc" -eq 0 ]; then
    ok "clean fixture (no test-touching commit) -> gate PASSES (rc 0)"
else
    bad "clean fixture (no test-touching commit) -> gate PASSES (rc 0)" "got rc=$rc"
fi
FINDINGS_B="$CLEAN_PROJ/.loki/quality/mutation-findings.txt"
if [ ! -f "$FINDINGS_B" ]; then
    ok "clean fixture -> no findings file left behind"
else
    bad "clean fixture -> no findings file left behind" "unexpected file: $FINDINGS_B"
fi

# ---------------------------------------------------------------------------
# Case 3: greenfield implementation plus new tests -> gate PASSES.
# ---------------------------------------------------------------------------
TARGET_DIR="$GREENFIELD_PROJ"
rc=0; enforce_mutation_integrity || rc=$?
if [ "$rc" -eq 0 ]; then
    ok "greenfield implementation with new tests -> gate PASSES (rc 0)"
else
    bad "greenfield implementation with new tests -> gate PASSES (rc 0)" "got rc=$rc"
fi
FINDINGS_C="$GREENFIELD_PROJ/.loki/quality/mutation-findings.txt"
if [ ! -f "$FINDINGS_C" ]; then
    ok "greenfield fixture -> no findings file left behind"
else
    bad "greenfield fixture -> no findings file left behind" "unexpected file: $FINDINGS_C"
fi

# ---------------------------------------------------------------------------
echo
echo "enforce-mutation-integrity: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
