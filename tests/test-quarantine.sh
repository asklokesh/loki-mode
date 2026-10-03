#!/usr/bin/env bash
# Quarantine (CEO Part C item 14). tests/quarantine.txt lists a suite whose
# failure is reported but does not block; an invalid entry (expired, more
# than 7 days out, or a moat/review suite) must fail the whole run instead of
# being silently ignored or silently accepted.
#
# Drives the REAL run-all-tests.sh rather than re-implementing its quarantine
# logic a second time (the same choice test-shard-coverage.sh and
# test-run-all-dispatch.sh already made) -- a second copy is exactly how the
# two drift apart. Running the actual ~500-suite registration list per
# scenario would blow the budget, so each scenario gets its own copy of the
# runner with the "# Run all tests" .. "# Summary" block swapped for one or
# two fixture suites; the quarantine block under test is untouched real code.

set -uo pipefail

# Both are inherited from the environment if the caller set them (CI and
# local-ci.sh run this whole suite under LOKI_TEST_SHARD=k/n). Left set, every
# fixture runner below -- each with exactly one run_test call -- would inherit
# shard mode too: the LPT pass always places a single suite on shard 0, so any
# other shard would skip it, print "Tests Run: 0", and exit 0 -- a fixture
# that never ran, not a suite that passed.
unset LOKI_TEST_SHARD LOKI_TEST_LIST

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/run-all-tests.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-quarantine-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# Runner copies resolve REPO_ROOT to $WORK: give them the hermetic-HOME lib and lib-tmp
# the real runner requires (FC-07). Fixtures keep the guard intact instead of bypassing it.
mkdir -p "$WORK/tests" "$WORK/eval/loki10"
cp -R "$SCRIPT_DIR/lib" "$WORK/tests/lib"
cp "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh" "$WORK/eval/loki10/"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

# Build one scenario: a runner copy in its own subdir, registered against the
# given run_test lines, with the given quarantine.txt content (may be empty).
_scenario() {
    local dir="$1" run_test_lines="$2" quarantine_body="$3"
    mkdir -p "$dir"
    cp "$RUNNER" "$dir/run-all-tests.sh"
    python3 - "$dir/run-all-tests.sh" "$run_test_lines" <<'PYEOF'
import sys
path, lines = sys.argv[1], sys.argv[2]
with open(path) as f:
    content = f.read()
start = content.index("# Run all tests")
end = content.index("# Summary")
content = content[:start] + "# Run all tests\n" + lines + "\n\n" + content[end:]
with open(path, "w") as f:
    f.write(content)
PYEOF
    printf '%s' "$quarantine_body" > "$dir/quarantine.txt"
}

_fail_script() {
    printf '#!/usr/bin/env bash\nexit 1\n' > "$1"
    chmod +x "$1"
}

_pass_script() {
    printf '#!/usr/bin/env bash\nexit 0\n' > "$1"
    chmod +x "$1"
}

_future_date() {
    date -u -v+"$1"d +%Y-%m-%d 2>/dev/null || date -u -d "+$1 days" +%Y-%m-%d
}

echo "T1 -- a listed failing suite is non-blocking"
d1="$WORK/t1"
_scenario "$d1" 'run_test "Fail Suite" "$SCRIPT_DIR/fail.sh"' \
    "$(printf 'fail.sh\tqa\t%s\tISSUE-1\n' "$(_future_date 3)")"
_fail_script "$d1/fail.sh"
out1="$(bash "$d1/run-all-tests.sh" 2>&1)"; rc1=$?
if [ "$rc1" -eq 0 ]; then
    ok "listed failing suite: run exits 0"
else
    bad "listed failing suite: run exited $rc1, expected 0"
fi
if printf '%s' "$out1" | grep -q "QUARANTINED"; then
    ok "listed failing suite: reported as QUARANTINED"
else
    bad "listed failing suite: no QUARANTINED marker in output"
fi
if printf '%s' "$out1" | grep -q "Failed:[[:space:]]*0"; then
    ok "listed failing suite: Failed count stayed 0"
else
    bad "listed failing suite: Failed count was not 0"
fi

# Red-then-green control: the SAME fixture with an EMPTY quarantine.txt must
# block. This proves the quarantine entry -- not something else -- is what
# made T1 non-blocking.
echo
echo "T1-control -- the same failing suite blocks with no quarantine entry"
d1c="$WORK/t1c"
_scenario "$d1c" 'run_test "Fail Suite" "$SCRIPT_DIR/fail.sh"' ""
_fail_script "$d1c/fail.sh"
bash "$d1c/run-all-tests.sh" >/dev/null 2>&1
rc1c=$?
if [ "$rc1c" -ne 0 ]; then
    ok "unlisted control: same fixture blocks without a quarantine entry (rc=$rc1c)"
else
    bad "unlisted control: exited 0 even with no quarantine entry"
fi

echo
echo "T2 -- an expired entry is rejected (fails the run, no suite executes)"
d2="$WORK/t2"
_scenario "$d2" 'run_test "Pass Suite" "$SCRIPT_DIR/pass.sh"' \
    "$(printf 'pass.sh\tqa\t2020-01-01\tISSUE-2\n')"
_pass_script "$d2/pass.sh"
out2="$(bash "$d2/run-all-tests.sh" 2>&1)"; rc2=$?
if [ "$rc2" -ne 0 ]; then
    ok "expired entry: run rejected (rc=$rc2)"
else
    bad "expired entry: run exited 0, should have been rejected"
fi
if printf '%s' "$out2" | grep -qi "expired"; then
    ok "expired entry: rejection names the reason"
else
    bad "expired entry: no 'expired' reason in output"
fi
if printf '%s' "$out2" | grep -q "Running: Pass Suite"; then
    bad "expired entry: a suite ran despite the invalid quarantine file"
else
    ok "expired entry: no suite executed"
fi

echo
echo "T3 -- a moat entry is rejected"
d3="$WORK/t3"
_scenario "$d3" 'run_test "Pass Suite" "$SCRIPT_DIR/pass.sh"' \
    "$(printf 'moat/p1-portable-proof.sh\tqa\t%s\tISSUE-3\n' "$(_future_date 3)")"
_pass_script "$d3/pass.sh"
out3="$(bash "$d3/run-all-tests.sh" 2>&1)"; rc3=$?
if [ "$rc3" -ne 0 ]; then
    ok "moat entry: run rejected (rc=$rc3)"
else
    bad "moat entry: run exited 0, should have been rejected"
fi
if printf '%s' "$out3" | grep -qi "moat"; then
    ok "moat entry: rejection names moat"
else
    bad "moat entry: no 'moat' reason in output"
fi

echo
echo "T3b -- a *review* entry is rejected"
d3b="$WORK/t3b"
_scenario "$d3b" 'run_test "Pass Suite" "$SCRIPT_DIR/pass.sh"' \
    "$(printf 'test-code-review-self-copy.sh\tqa\t%s\tISSUE-3b\n' "$(_future_date 3)")"
_pass_script "$d3b/pass.sh"
out3b="$(bash "$d3b/run-all-tests.sh" 2>&1)"; rc3b=$?
if [ "$rc3b" -ne 0 ]; then
    ok "review entry: run rejected (rc=$rc3b)"
else
    bad "review entry: run exited 0, should have been rejected"
fi
if printf '%s' "$out3b" | grep -qi "review"; then
    ok "review entry: rejection names review"
else
    bad "review entry: no 'review' reason in output"
fi

echo
echo "T3d -- a bare basename that names a real script under tests/moat/ is rejected"
d3d="$WORK/t3d"
_scenario "$d3d" 'run_test "Pass Suite" "$SCRIPT_DIR/pass.sh"' \
    "$(printf 'p1-portable-proof.sh\tqa\t%s\tISSUE-3d\n' "$(_future_date 3)")"
_pass_script "$d3d/pass.sh"
mkdir -p "$d3d/moat"
_pass_script "$d3d/moat/p1-portable-proof.sh"
out3d="$(bash "$d3d/run-all-tests.sh" 2>&1)"; rc3d=$?
if [ "$rc3d" -ne 0 ]; then
    ok "bare-basename moat entry: run rejected (rc=$rc3d)"
else
    bad "bare-basename moat entry: run exited 0, should have been rejected"
fi
if printf '%s' "$out3d" | grep -qi "moat"; then
    ok "bare-basename moat entry: rejection names moat"
else
    bad "bare-basename moat entry: no 'moat' reason in output"
fi

echo
echo "T3c -- an entry more than 7 days out is rejected"
d3c="$WORK/t3c"
_scenario "$d3c" 'run_test "Pass Suite" "$SCRIPT_DIR/pass.sh"' \
    "$(printf 'pass.sh\tqa\t%s\tISSUE-3c\n' "$(_future_date 30)")"
_pass_script "$d3c/pass.sh"
bash "$d3c/run-all-tests.sh" >/dev/null 2>&1
rc3c=$?
if [ "$rc3c" -ne 0 ]; then
    ok "more-than-7-days entry: run rejected (rc=$rc3c)"
else
    bad "more-than-7-days entry: run exited 0, should have been rejected"
fi

echo
echo "T4 -- an unlisted failure still blocks"
d4="$WORK/t4"
_scenario "$d4" 'run_test "Fail Suite" "$SCRIPT_DIR/fail.sh"' \
    "$(printf 'other-suite.sh\tqa\t%s\tISSUE-4\n' "$(_future_date 3)")"
_fail_script "$d4/fail.sh"
out4="$(bash "$d4/run-all-tests.sh" 2>&1)"; rc4=$?
if [ "$rc4" -ne 0 ]; then
    ok "unlisted failure: run exits non-zero"
else
    bad "unlisted failure: run exited 0, should have blocked"
fi
if printf '%s' "$out4" | grep -q "✗ Fail Suite FAILED"; then
    ok "unlisted failure: reported as a normal FAILED, not quarantined"
else
    bad "unlisted failure: no normal FAILED marker in output"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
