#!/usr/bin/env bash
# run_test dispatches BOTH argument shapes it is actually given.
#
# Nearly every caller passes a bare path. Two pass a full command line
# ("python3 .../x.py"). `bash "$cmd"` treats that whole string as one filename,
# so those two died with "No such file or directory" and were counted as a
# product failure -- a real suite reported red for a quoting bug in the harness.
#
# The obvious fix, `bash -c "$test_file"` for everything, is worse than the bug:
# -c execve's the target, which needs the exec bit, and dozens of shell suites
# here are committed mode 100644. That swap converts every one of them into
# rc 126. This file pins both halves so neither regression can return.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$REPO_ROOT/tests/run-all-tests.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-dispatch-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: run_test dispatches paths and command lines"

# Extract run_test's dispatch decision rather than sourcing the whole runner
# (which would execute 396 suites). The branch under test is the two-line
# if/else; reproduce it verbatim and prove it on real files.
dispatch() {
    local test_file="$1"
    if [ -f "$test_file" ]; then
        bash "$test_file"
    else
        bash -c "$test_file"
    fi
}

# --- a NON-EXECUTABLE script must still run (the 100644 case) ---------------
noexec="$WORK/plain.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$noexec"
chmod 644 "$noexec"
if dispatch "$noexec" >/dev/null 2>&1; then
    ok "a mode-644 shell suite still runs (bash -c would be rc 126 here)"
else
    bad "a mode-644 shell suite failed: $?"
fi

# Prove the claim above rather than asserting it: -c on the same file must fail.
if bash -c "$noexec" >/dev/null 2>&1; then
    bad "bash -c ran a 644 file; the comment's rationale is wrong"
else
    ok "bash -c genuinely cannot run the 644 file (rc $?), so the branch is load-bearing"
fi

# --- a COMMAND LINE must run (the two python3 callers) ----------------------
pyfile="$WORK/probe.py"
printf 'import sys\nsys.exit(0)\n' > "$pyfile"
if dispatch "python3 $pyfile" >/dev/null 2>&1; then
    ok "a 'python3 <path>' command line runs"
else
    bad "a 'python3 <path>' command line failed: $?"
fi

# --- failures must still propagate, or the harness is blind ------------------
failing="$WORK/failing.sh"
printf '#!/usr/bin/env bash\nexit 3\n' > "$failing"
chmod 644 "$failing"
if dispatch "$failing" >/dev/null 2>&1; then
    bad "a failing suite reported success"
else
    ok "a failing path suite still reports failure"
fi

pyfail="$WORK/failing.py"
printf 'import sys\nsys.exit(4)\n' > "$pyfail"
if dispatch "python3 $pyfail" >/dev/null 2>&1; then
    bad "a failing command line reported success"
else
    ok "a failing command line still reports failure"
fi

# --- the real callers this fixes -------------------------------------------
# If someone rewrites these to bare paths the branch is still correct, so this
# is a canary rather than a contract: it says the command-line form is in use.
if grep -q 'run_test .*"python3 ' "$RUNNER"; then
    ok "the runner still has command-line callers this branch serves"
else
    bad "no command-line callers found; the else-branch may now be dead code"
fi

# --- the fix is present in the runner itself --------------------------------
if grep -q 'if \[ -f "$test_file" \]' "$RUNNER"; then
    ok "run_test branches on -f rather than assuming one shape"
else
    bad "run_test no longer branches on -f; the quoting bug can return"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
