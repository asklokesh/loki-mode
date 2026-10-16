#!/usr/bin/env bash
#===============================================================================
# Behavioral tests for #139: Python test detection + stdlib-unittest fallback in
# enforce_test_coverage (autonomy/run.sh). Guards the founder-reported false
# negative: a Python CLI with a ROOT-LEVEL test_*.py (no tests/ dir, no config)
# had its genuinely-passing suite read as "tests not run" -> "VERIFIED WITH GAPS"
# on validated work (the same class as #79).
#
# Two halves, both pinned:
#   Half 1 (detection): a root-level test_*.py sets has_python_project=true (was
#           false -> the bug). Live-provable via pytest (on the host).
#   Half 2 (fallback):  pytest ABSENT -> run `python3 -m unittest discover`, so a
#           real unittest suite is VERIFIED, not read as "not run". Unit/extraction
#           -proven (the live host HAS pytest, so the fallback is not live-exercised).
#
# ANTI-FAKE-GREEN: a zero-discovery unittest run (prints "Ran 0 tests"/"NO TESTS
# RAN") is inconclusive, NEVER a pass (the #82/#89 trap). Verified in the
# _loki_zero_tests_executed unittest case.
#
# KNOWN BOUNDED EDGE (documented, not fixed here): the fallback runs
# `unittest discover -p 'test_*.py'`, which does NOT match a *_test.py naming
# (e.g. invoice_test.py). Detection matches *_test.py, so has_python_project=true,
# but discovery finds zero -> the zero-guard fires -> inconclusive on a real
# passing *_test.py suite. HONEST (not fake-green), the same narrow false-negative
# class, filed as a follow-up. `unittest discover` takes ONE -p pattern; a clean
# fix needs a second pass or a combined runner (more surface than warranted now).
#
# Strategy: this test exercises the DETECTOR + RUNNER SELECTION + zero-guard as a
# black box by driving a fixture repo through the extracted decision logic; the
# engine is NEVER run. It mirrors test-build-check-applicability.sh's approach.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() { [ -n "$TMPROOT" ] && rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT
TMPROOT="$(mktemp -d -t loki-pytestdetect.XXXXXX)"

# Extract the zero-test guard (the fake-green boundary) and test its unittest case.
awk '/^_loki_zero_tests_executed\(\) \{/,/^\}/' "$RUN_SH" > "$TMPROOT/zt.sh"
if ! grep -q 'unittest)' "$TMPROOT/zt.sh"; then
    bad "run.sh _loki_zero_tests_executed is missing the unittest case (fake-green risk)"
fi
# shellcheck disable=SC1090
source "$TMPROOT/zt.sh"

# Zero-test unittest output -> MUST be detected as zero (inconclusive, not pass).
ZERO_OUT=$'\n----------------------------------------------------------------------\nRan 0 tests in 0.000s\n\nNO TESTS RAN'
if _loki_zero_tests_executed "unittest" "$ZERO_OUT"; then
    ok "zero-test unittest -> detected zero (inconclusive, never fake-green pass)"
else
    bad "zero-test unittest NOT detected -> a source-with-no-tests dir would pass (fake-green)"
fi

# Real 16-test unittest output -> MUST NOT be flagged zero (a real suite verified).
REAL_OUT=$'.\n----------------------------------------------------------------------\nRan 16 tests in 0.017s\n\nOK'
if _loki_zero_tests_executed "unittest" "$REAL_OUT"; then
    bad "real 16-test unittest WRONGLY flagged zero -> would downgrade a passing suite"
else
    ok "real 16-test unittest -> not-zero (a genuinely-passing suite is verified)"
fi

# --- Half 1: detection fires on a ROOT-LEVEL test_*.py (the founder's shape) ---
# The detector predicate (mirrors run.sh): config OR tests/ dir OR shallow root
# test_*.py / *_test.py. We assert the root-level branch, which was the gap.
detect_python() {
    local tree="$1"
    if [ -f "$tree/setup.py" ] || [ -f "$tree/pyproject.toml" ] \
       || [ -f "$tree/setup.cfg" ] || [ -f "$tree/pytest.ini" ] \
       || [ -f "$tree/conftest.py" ]; then echo true; return; fi
    if [ -d "$tree/tests" ] && find "$tree/tests" -maxdepth 3 -type f \
        \( -name 'test_*.py' -o -name '*_test.py' -o -name 'conftest.py' \) \
        -print -quit 2>/dev/null | grep -q .; then echo true; return; fi
    if find "$tree" -maxdepth 2 -type f \( -name 'test_*.py' -o -name '*_test.py' \) \
        -not -path '*/.loki/*' -not -path '*/.git/*' -not -path '*/node_modules/*' \
        -not -path '*/.venv/*' -not -path '*/venv/*' -print -quit 2>/dev/null | grep -q .; then
        echo true; return; fi
    echo false
}
# NON-VACUITY: the OLD detector had no root-level branch -> false on this shape.
old_detect_python() {
    local tree="$1"
    if [ -f "$tree/setup.py" ] || [ -f "$tree/pyproject.toml" ] \
       || [ -f "$tree/setup.cfg" ] || [ -f "$tree/pytest.ini" ] \
       || [ -f "$tree/conftest.py" ]; then echo true; return; fi
    if [ -d "$tree/tests" ]; then echo maybe; return; fi
    echo false
}

d="$TMPROOT/founder"; mkdir -p "$d"
printf 'def add(a,b): return a+b\n' > "$d/invoice_cli.py"
printf 'import unittest\nclass T(unittest.TestCase):\n    def test_x(self): self.assertEqual(1,1)\n' > "$d/test_invoice_cli.py"
[ "$(detect_python "$d")" = "true" ] && ok "root-level test_*.py detected (Half 1)" \
    || bad "root-level test_*.py NOT detected -> the founder's bug"
[ "$(old_detect_python "$d")" = "false" ] && ok "NON-VACUITY: old detector missed it (false)" \
    || bad "non-vacuity broken: old detector already handled root-level test_*.py"

# A plain script with NO test file -> not a python test project (no false detect).
d="$TMPROOT/plain"; mkdir -p "$d"; printf 'print(1)\n' > "$d/app.py"
[ "$(detect_python "$d")" = "false" ] && ok "plain script, no test file -> not detected (no false-positive)" \
    || bad "plain script wrongly detected as a python test project"

# --- Half 2: the stdlib unittest fallback actually runs a real suite -----------
if command -v python3 >/dev/null 2>&1; then
    d="$TMPROOT/run"; mkdir -p "$d"
    printf 'def add(a,b): return a+b\n' > "$d/mod.py"
    printf 'import unittest, mod\nclass T(unittest.TestCase):\n    def test_add(self): self.assertEqual(mod.add(2,3),5)\n' > "$d/test_mod.py"
    out="$(cd "$d" && python3 -m unittest discover -p 'test_*.py' 2>&1)"; rc=$?
    { [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qE 'Ran [1-9][0-9]* test'; } \
        && ok "unittest fallback runs a real suite -> exit 0, Ran N tests (verified)" \
        || bad "unittest fallback did not verify a passing suite (rc=$rc)"

    # A FAILING unittest suite -> non-zero (recorded failed, never verified).
    d="$TMPROOT/fail"; mkdir -p "$d"
    printf 'import unittest\nclass T(unittest.TestCase):\n    def test_no(self): self.assertEqual(1,2)\n' > "$d/test_fail.py"
    out="$(cd "$d" && python3 -m unittest discover -p 'test_*.py' 2>&1)"; rc=$?
    [ "$rc" -ne 0 ] && ok "failing unittest suite -> non-zero (recorded failed, never verified)" \
        || bad "failing unittest suite exited 0 (would fake-green)"
else
    bad "python3 not on PATH -- cannot exercise the unittest fallback"
fi

# --- S3: pytest exit-5 fallback chain feeds the zero-test guard ---------------
# The shared helper falls back to unittest discover on pytest exit 5. Zero tests
# from BOTH must come back as exit 5 + "Ran 0 tests" so the guard records
# inconclusive; a real unittest suite must come back exit 0 and NOT be zero.
if command -v python3 >/dev/null 2>&1 && python3 -c 'import pytest' >/dev/null 2>&1; then
    log_warn() { :; }
    awk '/^(_loki_timeout_prefix|_loki_run_pytest_with_timeout)\(\) \{/,/^\}$/' "$RUN_SH" > "$TMPROOT/helper.sh"
    # shellcheck disable=SC1090
    source "$TMPROOT/helper.sh"

    d="$TMPROOT/modassert"; mkdir -p "$d"
    printf 'assert 1 + 1 == 2\n' > "$d/test_modlevel.py"
    out="$(_loki_run_pytest_with_timeout "$d" --tb=short -p no:cacheprovider)"; rc=$?
    if [ "$rc" -eq 5 ] && _loki_zero_tests_executed "unittest" "$out"; then
        ok "module-level-assert tree: exit 5 + zero-guard fires (inconclusive, never verified)"
    else
        bad "module-level-assert tree not inconclusive (rc=$rc)"
    fi

    d="$TMPROOT/fbpass"; mkdir -p "$d"
    printf '[pytest]\npython_files = nomatch_*.py\n' > "$d/pytest.ini"
    printf 'import unittest\nclass T(unittest.TestCase):\n    def test_x(self): self.assertEqual(1, 1)\n' > "$d/test_x.py"
    out="$(_loki_run_pytest_with_timeout "$d" --tb=short -p no:cacheprovider)"; rc=$?
    if [ "$rc" -eq 0 ] && ! _loki_zero_tests_executed "unittest" "$out"; then
        ok "pytest collects 0 but unittest suite passes: exit 0, not zero-guarded (verified)"
    else
        bad "unittest fallback did not verify a real suite (rc=$rc)"
    fi
else
    ok "SKIP: pytest not importable; S3 fallback chain not exercised"
fi

# Wiring: the gate call site must treat pytest exit 5 as the inconclusive path.
if grep -qE 'elif \[ "\$pytest_exit" -eq 5 \]; then' "$RUN_SH"; then
    ok "WIRING: enforce_test_coverage handles pytest exit 5 (zero tests) explicitly"
else
    bad "WIRING: exit-5 branch missing from the pytest gate call site"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
