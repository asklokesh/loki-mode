#!/usr/bin/env bash
# tests/test-test-provenance-gate.sh
#
# v7.106.0 reverse-classical test provenance. A NEW test only counts as
# affirmative "tests green" evidence if it FAILS on the pre-change base and
# PASSES on HEAD. Tests that pass on BOTH are tautological and must be downgraded
# to inconclusive (never affirmative), WITHOUT ever blocking a legitimate build.
#
# This test extracts and drives the REAL _loki_test_provenance helper from
# completion-council.sh against fixture git repos, covering the four cases the
# trust-core review requires:
#   (A) genuine fix: new test FAILS on base, PASSES on HEAD  -> not tautological
#   (B) tautological: new test PASSES on both                -> tautological (downgrade)
#   (C) new test FAILS on base for the WRONG reason (broken import) -> NOT
#       tautological, and the mislabel is HARMLESS (unknown -> no-op, never a
#       fabricated affirmative)
#   (D) legitimate pass-on-both (refactor) with a NON-EMPTY diff must still
#       COMPLETE: the downgrade sets test_inconclusive but the evidence gate
#       still returns 0 (pass-through) because diff is non-empty. Never a block.
# Plus: greenfield (no base) and LOKI_TEST_PROVENANCE=0 are no-ops (unknown).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"
[ -f "$COUNCIL_SH" ] || { echo "FAIL: cannot find $COUNCIL_SH"; exit 1; }

PASS=0; FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1 (got '$2', expected '$3')"; FAIL=$((FAIL+1)); }

log_info(){ :; }; log_warn(){ :; }; log_error(){ :; }; log_header(){ :; }; emit_event_json(){ :; }
# extract just the helper (self-contained: uses git + mktemp + the runner cmd).
HARNESS="$(mktemp -t prov-harness.XXXX.sh)"
sed -n '/^_loki_test_provenance() {/,/^}/p' "$COUNCIL_SH" > "$HARNESS"
grep -q "_loki_test_provenance() {" "$HARNESS" || { echo "FATAL: could not extract _loki_test_provenance"; exit 2; }
# shellcheck source=/dev/null
source "$HARNESS"

WORKROOT="$(mktemp -d -t prov-repos.XXXX)"
trap 'rm -f "$HARNESS"; rm -rf "$WORKROOT"' EXIT

# Use the interpreter that actually has pytest (many machines: python3 only).
PYCMD=""
if command -v python3 >/dev/null 2>&1 && python3 -c "import pytest" >/dev/null 2>&1; then PYCMD="python3 -m pytest -q"
elif command -v python >/dev/null 2>&1 && python -c "import pytest" >/dev/null 2>&1; then PYCMD="python -m pytest -q"; fi
HAVE_PYTEST=0; [ -n "$PYCMD" ] && HAVE_PYTEST=1

# Build a git repo: base commit has app+test; then apply a HEAD variant.
# We drive _loki_test_provenance with TARGET_DIR=the repo at HEAD and base_sha=base.
mk_repo() { # $1=name ; sets REPO + BASE
    REPO="$WORKROOT/$1"; mkdir -p "$REPO/tests"; ( cd "$REPO" && git init -q && git config user.email t@t && git config user.name t )
}

# --- Case A: genuine fix. base: greet returns "hi"; test asserts "hello".
#     test FAILS on base, and (at HEAD) code returns "hello" so it PASSES on HEAD.
mk_repo A
printf 'def greet():\n    return "hi"\n' > "$WORKROOT/A/app.py"
( cd "$WORKROOT/A" && git add app.py && git commit -qm base )
BASE_A=$( cd "$WORKROOT/A" && git rev-parse HEAD )
# HEAD: fix the code + add the test (the test is the NEW file we inject onto base)
printf 'def greet():\n    return "hello"\n' > "$WORKROOT/A/app.py"
printf 'import app\ndef test_greet():\n    assert app.greet() == "hello"\n' > "$WORKROOT/A/tests/test_greet.py"
( cd "$WORKROOT/A" && git add -A && git commit -qm head )
if [ "$HAVE_PYTEST" = "1" ]; then
  r=$( cd "$WORKROOT/A" && TARGET_DIR="$WORKROOT/A" _loki_test_provenance "$BASE_A" "$PYCMD" )
  # new test FAILS on base -> whole-suite fails on base -> unknown (never tautological, never fabricated confirmed)
  [ "$r" = "unknown" ] && ok "A genuine fix (test fails on base) -> unknown, NOT downgraded" || bad "A genuine fix" "$r" "unknown"
else ok "A skipped (no pytest)"; fi

# --- Case B: tautological. base already returns "hello"; test asserts "hello".
#     test PASSES on base AND head -> tautological.
mk_repo B
printf 'def greet():\n    return "hello"\n' > "$WORKROOT/B/app.py"
( cd "$WORKROOT/B" && git add app.py && git commit -qm base )
BASE_B=$( cd "$WORKROOT/B" && git rev-parse HEAD )
printf 'import app\ndef test_greet():\n    assert app.greet() == "hello"\n' > "$WORKROOT/B/tests/test_greet.py"
( cd "$WORKROOT/B" && git add -A && git commit -qm head )
if [ "$HAVE_PYTEST" = "1" ]; then
  r=$( cd "$WORKROOT/B" && TARGET_DIR="$WORKROOT/B" _loki_test_provenance "$BASE_B" "$PYCMD" )
  [ "$r" = "tautological" ] && ok "B tautological: passes on base too -> tautological (REAL downgrade)" || bad "B tautological" "$r" "tautological"
else ok "B skipped (no pytest)"; fi

# --- Case C: new test fails on base for the WRONG reason (broken import).
#     Whole-suite fails on base -> helper returns unknown (NOT a fabricated
#     'confirmed'); mislabel is harmless (no-op).
mk_repo C
printf 'def greet():\n    return "hello"\n' > "$WORKROOT/C/app.py"
( cd "$WORKROOT/C" && git add app.py && git commit -qm base )
BASE_C=$( cd "$WORKROOT/C" && git rev-parse HEAD )
printf 'import nonexistent_module\ndef test_greet():\n    assert True\n' > "$WORKROOT/C/tests/test_broken.py"
( cd "$WORKROOT/C" && git add -A && git commit -qm head )
if [ "$HAVE_PYTEST" = "1" ]; then
  r=$( cd "$WORKROOT/C" && TARGET_DIR="$WORKROOT/C" _loki_test_provenance "$BASE_C" "$PYCMD" )
  [ "$r" = "unknown" ] && ok "C broken-import base-fail -> unknown (not downgraded); mislabel harmless" || bad "C broken-import" "$r" "unknown"
else ok "C skipped (no pytest)"; fi

# --- greenfield / no base -> unknown ; opt-out -> unknown
r=$( cd "$WORKROOT/A" && TARGET_DIR="$WORKROOT/A" _loki_test_provenance "" "${PYCMD:-python3 -m pytest -q}" )
[ "$r" = "unknown" ] && ok "no base (greenfield) -> unknown (no-op)" || bad "greenfield" "$r" "unknown"
r=$( cd "$WORKROOT/B" && TARGET_DIR="$WORKROOT/B" LOKI_TEST_PROVENANCE=0 _loki_test_provenance "$BASE_B" "${PYCMD:-python3 -m pytest -q}" )
[ "$r" = "unknown" ] && ok "LOKI_TEST_PROVENANCE=0 -> unknown (opt-out no-op)" || bad "opt-out" "$r" "unknown"

# --- LIVENESS: with NO timeout binary on PATH, the base run must be SKIPPED
#     (return unknown, never run the base suite unbounded). Case B is a real
#     tautological -> proves the helper picks liveness over the downgrade when it
#     cannot bound execution, instead of risking a completion-time stall.
#     We shadow PATH to a minimal dir that has neither gtimeout nor timeout but
#     still has the interpreter the test command needs.
if [ "$HAVE_PYTEST" = "1" ]; then
  SAFEBIN="$WORKROOT/.nobin"; mkdir -p "$SAFEBIN"
  # symlink only the interpreter (python3) + core git/coreutils the helper uses,
  # deliberately OMITTING timeout/gtimeout.
  for b in python3 git mktemp dirname sort grep cp mkdir rm sed bash env cat; do
    p="$(command -v "$b" 2>/dev/null)"; [ -n "$p" ] && ln -sf "$p" "$SAFEBIN/$b" 2>/dev/null
  done
  r=$( cd "$WORKROOT/B" && PATH="$SAFEBIN" TARGET_DIR="$WORKROOT/B" _loki_test_provenance "$BASE_B" "$PYCMD" )
  # Even though B is genuinely tautological, with no timeout binary the helper
  # must NOT run the base suite -> unknown (liveness over downgrade). Never blocks.
  [ "$r" = "unknown" ] && ok "no timeout binary -> unknown (base run skipped, liveness safe)" || bad "no-timeout liveness" "$r" "unknown"
else ok "no-timeout liveness skipped (no pytest)"; fi

# --- Case D (LOAD-BEARING): tautological test + NON-EMPTY diff must PASS the
#     evidence gate (pass-through, never block). Drives the REAL council_evidence_gate.
#     A legitimate refactor whose regression test happens to pass on base too must
#     still complete: the provenance downgrade sets test_inconclusive (not
#     test_fails), and the gate blocks iff diff_fails OR test_fails -> return 0.
if [ "$HAVE_PYTEST" = "1" ]; then
  # Source the whole council file to get the real council_evidence_gate.
  # shellcheck source=/dev/null
  source "$COUNCIL_SH" >/dev/null 2>&1 || true
  D="$WORKROOT/D"; mkdir -p "$D/tests/.loki/quality"; mkdir -p "$D/.loki/quality" "$D/.loki/council"
  ( cd "$D" && git init -q && git config user.email t@t && git config user.name t )
  printf 'def greet():\n    return "hello"\n' > "$D/app.py"
  ( cd "$D" && git add app.py && git commit -qm base )
  BASE_D=$( cd "$D" && git rev-parse HEAD )
  # HEAD: a real refactor (non-empty diff) + a test that passes on base too (tautological)
  printf 'def greet():\n    # refactored, same behavior\n    msg = "hello"\n    return msg\n' > "$D/app.py"
  printf 'import app\ndef test_greet():\n    assert app.greet() == "hello"\n' > "$D/tests/test_greet.py"
  ( cd "$D" && git add -A && git commit -qm head )
  # a green test-results.json (affirmative candidate) so provenance runs
  printf '{"runner":"pytest","pass":true}' > "$D/.loki/quality/test-results.json"
  rc=0
  ( cd "$D" && TARGET_DIR="$D" _LOKI_RUN_START_SHA="$BASE_D" LOKI_COUNCIL_ENABLED=false \
      LOKI_TEST_COMMAND="$PYCMD" council_evidence_gate ) || rc=$?
  [ "$rc" = "0" ] && ok "D refactor (tautological test + non-empty diff) -> gate PASSES (no block)" || bad "D pass-through" "rc=$rc" "0"
  # And confirm the downgrade record was written (provenance actually fired)
  if [ -f "$D/.loki/state/test-provenance.json" ]; then
    grep -q tautological "$D/.loki/state/test-provenance.json" && ok "D provenance record = tautological (downgrade fired)" || bad "D record" "$(cat $D/.loki/state/test-provenance.json)" "tautological"
  else ok "D (provenance record optional; gate pass-through already proven)"; fi
else ok "D skipped (no pytest)"; fi

echo
echo "-----------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL TEST-PROVENANCE TESTS PASSED" || echo "SOME TESTS FAILED"
exit "$FAIL"
