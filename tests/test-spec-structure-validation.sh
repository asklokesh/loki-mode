#!/usr/bin/env bash
# Test: Deterministic Spec-Structure Validation (P2-5)
# Exercises prd-analyzer.py's validate_structure() pass: a malformed spec
# (missing referenced file, no headings, garbage, or self-contradiction) is
# flagged early in the observations file with an actionable message, while a
# well-formed spec passes cleanly.
#
# Validation channel: the observations markdown file (run.sh discards the
# analyzer's stderr and swallows its exit code, so the observations file is
# the durable, visible result). Exit code stays 0 for structurally-suspect
# but non-empty specs by design.
#
# Note: Not using -e to allow collecting all test results.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ANALYZER="$PROJECT_ROOT/autonomy/prd-analyzer.py"
PYTHON3="${PYTHON3:-python3}"

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
# shellcheck disable=SC2034
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); }

_TEST_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/loki-spec-struct-test-XXXXXX")
trap 'rm -rf "$_TEST_TMPDIR"' EXIT

echo "========================================"
echo "Spec-Structure Validation Tests (P2-5)"
echo "========================================"
echo "Analyzer: $ANALYZER"
echo "Python:   $($PYTHON3 --version 2>&1)"
echo "Temp:     $_TEST_TMPDIR"
echo ""

if [ ! -f "$ANALYZER" ]; then
    echo -e "${RED}Error: prd-analyzer.py not found at $ANALYZER${NC}"
    exit 1
fi

# run_analyzer <spec_path> <out_path> : runs analyzer, echoes stdout, returns exit code
run_analyzer() {
    "$PYTHON3" "$ANALYZER" "$1" --output "$2" 2>"$_TEST_TMPDIR/stderr.log"
}

# ------------------------------------------------------------------
# Test 0: syntax
# ------------------------------------------------------------------
out=$($PYTHON3 -m py_compile "$ANALYZER" 2>&1) \
    && log_pass "analyzer syntax: py_compile passes" \
    || log_fail "analyzer syntax: py_compile fails" "$out"

# ------------------------------------------------------------------
# Test 1: WELL-FORMED spec -> structure PASS, clean
# ------------------------------------------------------------------
GOOD="$_TEST_TMPDIR/good.md"
GOOD_OUT="$_TEST_TMPDIR/good-obs.md"
cat > "$GOOD" <<'EOF'
# Task Tracker PRD

## Features
- Users can create tasks
- Users can mark tasks done
- Users can filter by status

## Tech Stack
- React + Node.js + Postgres

## Acceptance Criteria
- [ ] A task can be created and persisted
- [ ] A completed task is visually distinct
EOF
stdout=$(run_analyzer "$GOOD" "$GOOD_OUT"); rc=$?
if [ "$rc" -eq 0 ] \
   && grep -q "## Structural Validation" "$GOOD_OUT" \
   && grep -A2 "## Structural Validation" "$GOOD_OUT" | grep -q "PASS" \
   && echo "$stdout" | grep -q "PRD structure check: PASS"; then
    log_pass "well-formed spec: structure PASS, exit 0"
else
    log_fail "well-formed spec" "rc=$rc stdout='$stdout' obs=$(grep -A3 'Structural Validation' "$GOOD_OUT" 2>/dev/null | tr '\n' '|')"
fi

# ------------------------------------------------------------------
# Test 2: NO HEADINGS (one-line-brief style) -> WARNING, not FAIL
# (one-line briefs are a supported input mode; flag but do not fail)
# ------------------------------------------------------------------
NOHEAD="$_TEST_TMPDIR/nohead.md"
NOHEAD_OUT="$_TEST_TMPDIR/nohead-obs.md"
cat > "$NOHEAD" <<'EOF'
Build me a thing that lets users create tasks and mark them done.
It should use React and Node and Postgres and have a nice UI.
Make sure tasks persist and can be filtered.
EOF
stdout=$(run_analyzer "$NOHEAD" "$NOHEAD_OUT"); rc=$?
if [ "$rc" -eq 0 ] \
   && grep -A2 "## Structural Validation" "$NOHEAD_OUT" | grep -q "PASS" \
   && grep -qi "no Markdown headings" "$NOHEAD_OUT" \
   && echo "$stdout" | grep -q "PASS with"; then
    log_pass "no-headings spec: WARNING (not FAIL), actionable message"
else
    log_fail "no-headings spec" "rc=$rc stdout='$stdout' obs=$(grep -A4 'Structural Validation' "$NOHEAD_OUT" 2>/dev/null | tr '\n' '|')"
fi

# ------------------------------------------------------------------
# Test 2b: GARBAGE / no readable text -> structure FAIL (the only ISSUE case)
# ------------------------------------------------------------------
GARBAGE="$_TEST_TMPDIR/garbage.md"
GARBAGE_OUT="$_TEST_TMPDIR/garbage-obs.md"
printf '!!! ??? ... --- *** ### @@@ %%%%\n' > "$GARBAGE"
stdout=$(run_analyzer "$GARBAGE" "$GARBAGE_OUT"); rc=$?
if [ "$rc" -eq 0 ] \
   && grep -A2 "## Structural Validation" "$GARBAGE_OUT" | grep -q "FAIL" \
   && grep -qi "no readable text" "$GARBAGE_OUT" \
   && echo "$stdout" | grep -q "PRD structure check: FAIL"; then
    log_pass "garbage spec (no word chars): structure FAIL with actionable message"
else
    log_fail "garbage spec" "rc=$rc stdout='$stdout' obs=$(grep -A4 'Structural Validation' "$GARBAGE_OUT" 2>/dev/null | tr '\n' '|')"
fi

# ------------------------------------------------------------------
# Test 3: REFERENCES A NONEXISTENT LOCAL FILE -> WARNING (PASS w/ warning)
# ------------------------------------------------------------------
REFMISS="$_TEST_TMPDIR/refmiss.md"
REFMISS_OUT="$_TEST_TMPDIR/refmiss-obs.md"
cat > "$REFMISS" <<'EOF'
# Spec With Broken Reference

## Overview
See the [architecture doc](./does-not-exist-arch.md) for details.

## Features
- Users can log in
EOF
stdout=$(run_analyzer "$REFMISS" "$REFMISS_OUT"); rc=$?
if [ "$rc" -eq 0 ] \
   && grep -qi "Referenced local file not found" "$REFMISS_OUT" \
   && grep -q "does-not-exist-arch.md" "$REFMISS_OUT" \
   && echo "$stdout" | grep -q "warning"; then
    log_pass "missing referenced local file: flagged as warning, exit 0"
else
    log_fail "missing referenced local file" "rc=$rc stdout='$stdout' obs=$(grep -A2 'Warnings' "$REFMISS_OUT" 2>/dev/null | tr '\n' '|')"
fi

# ------------------------------------------------------------------
# Test 4: REFERENCE THAT EXISTS -> no warning
# ------------------------------------------------------------------
REFOK="$_TEST_TMPDIR/refok.md"
REFOK_OUT="$_TEST_TMPDIR/refok-obs.md"
echo "# Arch" > "$_TEST_TMPDIR/real-arch.md"
cat > "$REFOK" <<'EOF'
# Spec With Valid Reference

## Overview
See the [architecture doc](./real-arch.md) for details.

## Features
- Users can log in
EOF
stdout=$(run_analyzer "$REFOK" "$REFOK_OUT"); rc=$?
if [ "$rc" -eq 0 ] \
   && ! grep -qi "Referenced local file not found" "$REFOK_OUT"; then
    log_pass "existing referenced local file: no false-positive warning"
else
    log_fail "existing referenced local file" "rc=$rc obs=$(grep -A2 'Warnings' "$REFOK_OUT" 2>/dev/null | tr '\n' '|')"
fi

# ------------------------------------------------------------------
# Test 5: EXTERNAL URL + aspirational build paths -> NOT flagged
# (a PRD describing files to be BUILT must not be flagged)
# ------------------------------------------------------------------
ASPIRE="$_TEST_TMPDIR/aspire.md"
ASPIRE_OUT="$_TEST_TMPDIR/aspire-obs.md"
cat > "$ASPIRE" <<'EOF'
# Spec With External Link and Build Targets

## Overview
Reference the [API guide](https://example.com/api.md) online.

## Features
- Create `src/app.py` and `src/models.py` as part of the build
- Users can create tasks
EOF
stdout=$(run_analyzer "$ASPIRE" "$ASPIRE_OUT"); rc=$?
# external URL is skipped; bare code paths (no markdown link) are skipped.
if [ "$rc" -eq 0 ] \
   && ! grep -qi "Referenced local file not found" "$ASPIRE_OUT"; then
    log_pass "external URL + aspirational build paths: not flagged (no false positives)"
else
    log_fail "external URL + aspirational paths" "rc=$rc obs=$(grep -A2 'Warnings' "$ASPIRE_OUT" 2>/dev/null | tr '\n' '|')"
fi

# ------------------------------------------------------------------
# Test 6: TRIVIAL SELF-CONTRADICTION -> WARNING (basic, shallow heuristic)
# (demoted from FAIL: a subject-less lexical guess must not fail a spec)
# ------------------------------------------------------------------
CONTRA="$_TEST_TMPDIR/contra.md"
CONTRA_OUT="$_TEST_TMPDIR/contra-obs.md"
cat > "$CONTRA" <<'EOF'
# Contradictory Spec

## Requirements
- The system must store passwords in plaintext
- The system must not store passwords in plaintext

## Features
- Users can log in
EOF
stdout=$(run_analyzer "$CONTRA" "$CONTRA_OUT"); rc=$?
if [ "$rc" -eq 0 ] \
   && grep -A2 "## Structural Validation" "$CONTRA_OUT" | grep -q "PASS" \
   && grep -qi "self-contradiction" "$CONTRA_OUT"; then
    log_pass "trivial self-contradiction: WARNING (not FAIL), actionable message"
else
    log_fail "trivial self-contradiction" "rc=$rc obs=$(grep -A5 'Structural Validation' "$CONTRA_OUT" 2>/dev/null | tr '\n' '|')"
fi

# ------------------------------------------------------------------
# Test 6b: DIFFERENT-SUBJECT shared predicate -> must NOT FAIL
# (regression guard: "all data must be encrypted" + "public assets must not
#  be encrypted" share predicate "be encrypted" but do not actually conflict)
# ------------------------------------------------------------------
NOFP="$_TEST_TMPDIR/nofp.md"
NOFP_OUT="$_TEST_TMPDIR/nofp-obs.md"
cat > "$NOFP" <<'EOF'
# Encryption Spec

## Requirements
- All user data must be encrypted at rest.
- Public marketing assets must not be encrypted.

## Features
- Users can log in
EOF
stdout=$(run_analyzer "$NOFP" "$NOFP_OUT"); rc=$?
if [ "$rc" -eq 0 ] \
   && grep -A2 "## Structural Validation" "$NOFP_OUT" | grep -q "PASS"; then
    log_pass "different-subject shared predicate: does NOT FAIL the spec"
else
    log_fail "different-subject shared predicate" "rc=$rc obs=$(grep -A5 'Structural Validation' "$NOFP_OUT" 2>/dev/null | tr '\n' '|')"
fi

# ------------------------------------------------------------------
# Test 7: EMPTY spec -> hard error exit 1 (preserved load() behavior)
# ------------------------------------------------------------------
EMPTY="$_TEST_TMPDIR/empty.md"
: > "$EMPTY"
"$PYTHON3" "$ANALYZER" "$EMPTY" --output "$_TEST_TMPDIR/empty-obs.md" >/dev/null 2>"$_TEST_TMPDIR/empty-err.log"; rc=$?
if [ "$rc" -ne 0 ] && grep -qi "empty" "$_TEST_TMPDIR/empty-err.log"; then
    log_pass "empty spec: hard error exit 1 (load() behavior preserved)"
else
    log_fail "empty spec" "expected non-zero exit with 'empty' message, rc=$rc err=$(cat "$_TEST_TMPDIR/empty-err.log")"
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
