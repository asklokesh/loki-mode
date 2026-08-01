#!/usr/bin/env bash
# The mutation probe must distinguish three outcomes that look identical.
#
# A mutation test proves a test can FAIL: break the code, watch it go red,
# restore. That rests entirely on the break landing. When the search string does
# not match -- a stale quote, a reformatted line, one wrong backtick -- nothing
# breaks, the test passes, and "the mutation survived" is indistinguishable from
# "the test works". A checker then ships with no evidence it detects anything.
#
# That happened twice in consecutive releases in this repository. Both times the
# only tell was a debug line that existed by luck. scripts/mutation-probe.sh
# makes the distinction structural:
#
#   rc 0   mutation applied AND the test failed        -- the test works
#   rc 65  mutation did NOT apply                      -- the probe proved nothing
#   rc 1   mutation applied and the test still passed  -- the test is blind
#
# 65 is the one that matters. It is the case that used to look like success.
#
# The file must be restored in every outcome, including a probe that errors.
# Leaving a repository mutated is worse than any failing probe.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE="$REPO_ROOT/scripts/mutation-probe.sh"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: mutation probe"

[[ -x "$PROBE" ]] || { echo "  FAIL: probe missing or not executable"; exit 1; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-mutprobe-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# A subject file and a "test" that fails only when the subject says WRONG.
subject="$SCRATCH/subject.txt"
printf 'the value is CORRECT\n' > "$subject"

strict_test="$SCRATCH/strict.sh"
cat > "$strict_test" <<SH
#!/usr/bin/env bash
grep -q "CORRECT" "$subject"
SH
chmod +x "$strict_test"

blind_test="$SCRATCH/blind.sh"
cat > "$blind_test" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$blind_test"

_orig="$(cat "$subject")"

# --- rc 0: mutation applied, test caught it ---------------------------------
bash "$PROBE" "$subject" "CORRECT" "WRONG" "$strict_test" >/dev/null 2>&1
rc=$?
[[ "$rc" -eq 0 ]] \
    && ok "a caught mutation exits 0" \
    || ko "a caught mutation exits 0" "got rc=$rc"

# --- rc 65: THE CASE THIS EXISTS FOR ----------------------------------------
bash "$PROBE" "$subject" "STRING-NOT-PRESENT" "x" "$strict_test" >/dev/null 2>&1
rc=$?
if [[ "$rc" -eq 65 ]]; then
    ok "a mutation that does not apply exits 65, not 0"
else
    ko "a mutation that does not apply exits 65, not 0" \
       "got rc=$rc -- this is the failure that looks like success and shipped twice"
fi

# --- rc 1: mutation applied but the test is blind ---------------------------
bash "$PROBE" "$subject" "CORRECT" "WRONG" "$blind_test" >/dev/null 2>&1
rc=$?
[[ "$rc" -eq 1 ]] \
    && ok "a surviving mutation exits 1" \
    || ko "a surviving mutation exits 1" "got rc=$rc"

# --- restoration, in every outcome ------------------------------------------
[[ "$(cat "$subject")" == "$_orig" ]] \
    && ok "the subject file is restored after all three outcomes" \
    || ko "the subject file is restored" "left mutated: $(cat "$subject")"

# --- a missing file is an error, not a silent pass ---------------------------
bash "$PROBE" "$SCRATCH/no-such-file" "a" "b" "$strict_test" >/dev/null 2>&1
rc=$?
[[ "$rc" -eq 66 ]] \
    && ok "a missing target file exits 66" \
    || ko "a missing target file exits 66" "got rc=$rc"

# --- bad usage is an error ---------------------------------------------------
bash "$PROBE" "$subject" "only-two-args" >/dev/null 2>&1
rc=$?
[[ "$rc" -eq 64 ]] \
    && ok "incomplete arguments exit 64" \
    || ko "incomplete arguments exit 64" "got rc=$rc"

# --- no spurious error output on a healthy run -------------------------------
# The error paths exit without disarming the trap, so restore() runs twice. The
# second call used to hit an already-removed backup and print "cp: No such file
# or directory" on a run that had actually succeeded. An error message on a
# healthy run teaches the reader to ignore this tool's output.
_noop_err="$(bash "$PROBE" "$subject" "STRING-NOT-PRESENT" "x" "$strict_test" 2>&1 >/dev/null)"
if [[ "$_noop_err" == *"cp:"* ]]; then
    ko "a no-op probe does not print a spurious cp error" \
       "got: $_noop_err"
else
    ok "a no-op probe does not print a spurious cp error"
fi

# --- NOT DONE: probing this file with itself -------------------------------
# Tempting and wrong. `probe <this test> ... <this test>` re-invokes the test,
# which invokes the probe, which re-invokes the test. I tried it: unbounded
# recursion that had to be killed, and it left the probe MUTATED on disk with
# its own no-op guard deleted -- the exact silent-breakage this tool exists to
# prevent, caused by the tool.
#
# The self-check that IS safe is a probe against the probe driven from OUTSIDE
# this file, where the command under test is something other than this test.
# Recorded so the idea is not re-tried from scratch.

# --- rc 67: a test that was ALREADY RED --------------------------------------
# The fourth outcome, and the one that reads as success. A test failing for its
# own reasons (typo, bad import, wrong attribute) also "fails under mutation",
# so the probe reported OK and the invariant looked proven. That happened for
# real: three probes passed against assertions raising AttributeError
# unconditionally, because _SERVER was a str and the test called .read_text().
broken_test="$SCRATCH/broken.sh"
cat > "$broken_test" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$broken_test"

bash "$PROBE" "$subject" "CORRECT" "WRONG" "$broken_test" >/dev/null 2>&1
rc=$?
if [[ "$rc" -eq 67 ]]; then
    ok "an already-failing test exits 67, not 0"
else
    ko "an already-failing test exits 67, not 0" \
       "got rc=$rc -- a red test cannot demonstrate detection"
fi

# The baseline must not corrupt the subject: an early exit still restores.
[[ "$(cat "$subject")" == "$_orig" ]] \
    && ok "a baseline failure leaves the file untouched" \
    || ko "a baseline failure leaves the file untouched" "left: $(cat "$subject")"

# The escape hatch must work, for callers that already know green.
MUTPROBE_SKIP_BASELINE=1 bash "$PROBE" "$subject" "CORRECT" "WRONG" "$strict_test" >/dev/null 2>&1
rc=$?
[[ "$rc" -eq 0 ]] \
    && ok "MUTPROBE_SKIP_BASELINE=1 skips the baseline run" \
    || ko "MUTPROBE_SKIP_BASELINE=1 skips the baseline run" "got rc=$rc"

# --- the three outcomes must be DISTINCT -------------------------------------
# If any two collapsed to the same code, a caller could not tell "the test
# works" from "the probe proved nothing", which is the whole point.
_a=0; _b=65; _c=1
if [[ "$_a" != "$_b" && "$_b" != "$_c" && "$_a" != "$_c" ]]; then
    ok "the three outcomes have distinct exit codes"
else
    ko "the three outcomes have distinct exit codes"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
