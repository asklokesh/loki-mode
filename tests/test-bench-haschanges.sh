#!/usr/bin/env bash
#
# test-bench-haschanges.sh
#
# Regression test for the no-op QA validation gate in
# benchmarks/run-benchmarks.sh (qa_agent's "has_changes" check).
#
# BUG: the old check `has_changes = "+" in patch or "-" in patch` can never
# fail, because every unified diff contains "+++"/"---" headers (and often
# "@@ -n +n @@" hunk markers), so "+" and "-" are ALWAYS present even for an
# empty/no-op patch. The QA gate meant to catch a body-less patch was a no-op.
#
# FIX: test for actual change lines -- lines that start with "+" or "-" but
# are not the "+++"/"---" file headers. Hunk headers "@@" do not start with
# "+" or "-", so they are naturally excluded.
#
# This test replicates BOTH the old and new logic in Python (mirroring the
# exact expressions used in run-benchmarks.sh) and asserts:
#   - header-only diff           -> NEW has_changes == False
#   - diff with real +/- body    -> NEW has_changes == True
#   - hunk-header-only diff       -> NEW has_changes == False
# Non-vacuity proof:
#   - header-only diff           -> OLD has_changes == True (proves the bug)
#   - header-only diff           -> NEW has_changes == False (proves the fix)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/../benchmarks/run-benchmarks.sh"

# Guard: confirm the fixed expression is actually present in the target source
# so this test stays anchored to the real implementation (not just a copy).
if ! grep -q "any(l.startswith(('+', '-')) and not l.startswith(('+++', '---'))" "$TARGET"; then
    echo "FAIL: expected fixed has_changes expression not found in $TARGET"
    exit 1
fi

python3 - <<'PY'
import sys

def old_has_changes(patch):
    # Buggy original from run-benchmarks.sh:1389 (pre-fix)
    return "+" in patch or "-" in patch

def new_has_changes(patch):
    # Fixed version: real change lines only, excluding +++/--- file headers.
    return any(
        l.startswith(("+", "-")) and not l.startswith(("+++", "---"))
        for l in patch.splitlines()
    )

# Fixture 1: header-only diff (no body change lines at all)
header_only = (
    "--- a/path/to/file.py\n"
    "+++ b/path/to/file.py\n"
)

# Fixture 2: diff with real +/- body change lines
real_change = (
    "--- a/path/to/file.py\n"
    "+++ b/path/to/file.py\n"
    "@@ -10,6 +10,7 @@\n"
    " existing line\n"
    "+new line\n"
    "-removed line\n"
    " existing line\n"
)

# Fixture 3: hunk-header-only diff (@@ present, but no +/- body lines)
hunk_only = (
    "--- a/path/to/file.py\n"
    "+++ b/path/to/file.py\n"
    "@@ -10,6 +10,7 @@\n"
    " existing line\n"
    " another existing line\n"
)

failures = []

def check(name, got, want):
    status = "PASS" if got == want else "FAIL"
    print(f"  [{status}] {name}: got={got} want={want}")
    if got != want:
        failures.append(name)

print("NEW logic (the fix):")
check("header-only -> FALSE", new_has_changes(header_only), False)
check("real +/- body -> TRUE", new_has_changes(real_change), True)
check("hunk-header-only -> FALSE", new_has_changes(hunk_only), False)

print("Non-vacuity proof (OLD buggy logic):")
# OLD returns TRUE for header-only (the bug: gate can never catch it).
check("OLD header-only -> TRUE (bug present)", old_has_changes(header_only), True)
# NEW returns FALSE for the same input (the bug is fixed).
check("NEW header-only -> FALSE (bug fixed)", new_has_changes(header_only), False)
# Sanity: OLD and NEW agree on a real change.
check("OLD real +/- body -> TRUE", old_has_changes(real_change), True)

if failures:
    print(f"\nRESULT: FAIL ({len(failures)} assertion(s) failed): {failures}")
    sys.exit(1)

print("\nRESULT: PASS (all assertions, including non-vacuity proof)")
PY
