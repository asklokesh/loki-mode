#!/usr/bin/env bash
# Every gate detector must ship in the npm package.
#
# THE DEFECT THIS EXISTS FOR. Four quality gates shell out to detectors under
# tests/:
#
#   enforce_mock_integrity        tests/detect-mock-problems.sh
#   enforce_mutation_integrity    tests/detect-test-mutations.sh
#   (semantic)                    tests/detect-semantic-test-problems.sh
#   (invariants)                  tests/detect-invariant-violations.sh
#
# package.json's files[] had NO tests/ entry, so the published package shipped
# ZERO files in tests/. Mutation-integrity is fail-CLOSED by design (correct: a
# missing detector must not read as "nothing found"), so every npm user hit this
# on EVERY iteration:
#
#   [HIGH] mutation detector unavailable: .../loki-mode/autonomy/../tests/detect-test-mutations.sh
#
# Found in real telemetry: a FireLater run showed mutation_integrity failing
# 3 of 3 iterations in 0-1 SECONDS each. Real mutation analysis cannot run in
# zero seconds; that was the fail-closed branch firing instantly, forever.
#
# The cost is exactly the founder's complaint: a gate that can never pass forces
# another iteration every time, so first-pass completion was impossible for any
# installed user regardless of how good the model's output was.
#
# WHY A UNIT TEST WOULD NOT HAVE CAUGHT IT. The detectors exist in the repo and
# run fine from a git checkout, so every in-repo test passed. Only the PACKAGED
# artifact was broken. This asserts against package.json's files[] and, when npm
# is available, against the real tarball.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: gate detectors are packaged"

# Derive the required list FROM run.sh rather than hardcoding it, so a newly
# added gate is covered automatically. A hardcoded list would pass while a
# fifth detector shipped missing -- the same class of bug, one gate later.
mapfile -t NEEDED < <(grep -oE 'tests/detect-[a-z-]+\.sh' autonomy/run.sh | sort -u)

if [ "${#NEEDED[@]}" -eq 0 ]; then
    bad "found no detector references in run.sh -- this test is inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
ok "run.sh references ${#NEEDED[@]} detector(s)"

# --- each referenced detector must exist ------------------------------------
for d in "${NEEDED[@]}"; do
    if [ -f "$REPO_ROOT/$d" ]; then
        ok "exists in repo: $d"
    else
        bad "run.sh calls a detector that does not exist: $d"
    fi
done

# --- each must be listed in package.json files[] ----------------------------
# This is the assertion that would have caught the shipped defect.
for d in "${NEEDED[@]}"; do
    if LOKI_D="$d" python3 -c "
import json, os, sys
files = json.load(open('package.json')).get('files', [])
d = os.environ['LOKI_D']
# An exact entry, or a directory entry that would include it.
sys.exit(0 if (d in files or any(
    f.rstrip('/') == os.path.dirname(d) or f == 'tests' or f == 'tests/**'
    for f in files)) else 1)
" 2>/dev/null; then
        ok "packaged: $d"
    else
        bad "NOT in package.json files[]: $d -- the gate fail-closes for every npm user"
    fi
done

# --- the real tarball, when npm is available --------------------------------
# files[] can be right while an .npmignore or a pack quirk still drops it, so
# the authoritative check is the tarball itself.
if command -v npm >/dev/null 2>&1; then
    pack_out="$(npm pack --dry-run 2>&1 || true)"
    if [ -z "$pack_out" ]; then
        echo "  SKIP: npm pack produced no output"
    else
        _miss=""
        for d in "${NEEDED[@]}"; do
            case "$pack_out" in *"$d"*) ;; *) _miss="$_miss $d" ;; esac
        done
        if [ -z "$_miss" ]; then
            ok "every detector appears in the real npm tarball"
        else
            bad "missing from the tarball:$_miss"
        fi
    fi
else
    echo "  SKIP: npm unavailable; files[] assertions above still apply"
fi

# --- the gates must stay fail-closed ----------------------------------------
# Fixing packaging must NOT tempt anyone to make a missing detector pass. A gate
# that cannot run must never report "nothing found" -- that would convert this
# loud, diagnosable failure into a silent false green, which is strictly worse.
# Asserted on the CONTROL FLOW, not on the log text. An earlier version keyed on
# the phrase "-- BLOCK (fail-closed)"; a mutation that changed BOTH the message
# and `return 1` -> `return 0` therefore slipped through, because the assertion
# was reading the part of the line that carries no authority. The return value
# is what decides whether the build stops.
#
# NOT every gate is fail-closed, and asserting that they are was wrong. Checked
# against the source: mock-integrity deliberately returns 0 with a recorded
# reason (_LOKI_MOCK_INTEGRITY_REASON="detector_missing") -- it declines to
# judge rather than blocking. Mutation-integrity fail-CLOSES. Both are correct
# for their own gate, so the invariant is per-gate direction, not a blanket rule.
#
# What must hold either way: a missing detector is never silently ignored. It
# either blocks, or it records WHY it did not run.
_mut_branch="$(awk '/^enforce_mutation_integrity\(\)/,/^}/' autonomy/run.sh \
    | grep -A4 'if \[ ! -f "\$detector" \]; then')"
case "$_mut_branch" in
    *"return 1"*)
        ok "mutation-integrity fail-CLOSES on a missing detector" ;;
    *)
        bad "mutation-integrity no longer blocks on a missing detector -- silent false green" ;;
esac

_mock_branch="$(awk '/^enforce_mock_integrity\(\)/,/^}/' autonomy/run.sh \
    | grep -A4 'if \[ ! -f "\$detector" \]; then')"
case "$_mock_branch" in
    *_LOKI_MOCK_INTEGRITY_REASON*)
        ok "mock-integrity records WHY it did not run (fail-open, but not silent)" ;;
    *)
        bad "mock-integrity skips silently -- an unrun gate indistinguishable from a clean one" ;;
esac

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
