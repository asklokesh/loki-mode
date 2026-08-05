#!/usr/bin/env bash
# A test that passes on a macOS laptop and fails on a Linux runner is a defect
# in the TEST, not in the code under test. This scans tests/*.sh for the two
# constructs that caused exactly that today, and names the file that carries one.
#
# THE TWO CONSTRUCTS.
#
#   1. script(1) takes its arguments DIFFERENTLY on the two platforms, and the
#      divergence is SILENT rather than an error:
#           BSD (macOS):     script -q /dev/null CMD ARGS...
#           util-linux (CI): script -q -c "CMD ARGS..." /dev/null
#      Under util-linux the BSD form reads /dev/null as the TYPESCRIPT FILE and
#      the rest as further operands, so the command never runs under a pty. No
#      usage error is printed; the test just observes "no output" and reports a
#      failure that has nothing to do with the feature.
#
#   2. stat(1) format flags are disjoint: BSD is `stat -f`, GNU is `stat -c`.
#      A file that calls only one form cannot read a size or a mode on the other
#      platform.
#
# WHAT THIS OWNS, AND WHAT IT DOES NOT.
#   This test owns PRESENCE: a divergent construct with no sibling form anywhere
#   in the same file. `tests/test-stat-portability.sh` owns ORDERING: when both
#   stat forms ARE present, the GNU probe must come first (GNU `stat -f` means
#   "filesystem status" and EXITS 0, so a macOS-first `||` never falls through).
#   The two rules are complementary. Do not merge them: presence without
#   ordering passes a broken file, ordering without presence never sees a file
#   that has only one form.
#
#   The `CI` env var is deliberately NOT scanned. Production code branches on
#   `[ -n "${CI:-}" ]` in many places, and "mentions CI without unsetting it" is
#   true of a dozen tests that legitimately assert the CI path. A regex cannot
#   tell the two intents apart, so a scan would be noise, not a guard.
#
# VACUITY IS THE FAILURE MODE THIS SHAPE EXISTS TO AVOID. A glob that matches
# nothing, or a regex that matches nothing, reports a clean bill of health. So
# before any "no violations" verdict is trusted, this asserts BOTH that files
# were scanned AND that the detector POSITIVELY IDENTIFIED the portable form in
# two known-good files. Membership in a glob proves the glob works; positive
# identification proves the detector can actually see the construct.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$(basename "${BASH_SOURCE[0]}")"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "=== CI-only divergence: platform-specific constructs in tests/*.sh ==="

# Known-good positive controls. Each must be seen USING the portable form, or
# the detector below is not measuring anything.
CONTROL_PTY="test-start-update-hint.sh"    # both script(1) forms, behaviour-probed
CONTROL_STAT="test-help-and-log-cap.sh"    # both stat(1) forms

# Count code occurrences of a pattern in a file, ignoring comment lines. The
# fixed files legitimately QUOTE the broken form in their explanatory comments,
# and this file necessarily contains every needle as a literal.
count_code() {
    local pattern="$1" file="$2" n=0 line trimmed
    while IFS= read -r line; do
        trimmed="${line#"${line%%[![:space:]]*}"}"
        case "$trimmed" in '#'*) continue ;; esac
        n=$((n + 1))
    done < <(grep -E -- "$pattern" "$file" 2>/dev/null || true)
    printf '%s' "$n"
}

# script(1): the BSD form is `-q <file> CMD`, the util-linux form is `-q -c CMD`.
# Match `-c` anywhere in the flag run so `-qc` and `script -q -c` both count.
PTY_BSD='(^|[^[:alnum:]_./-])script[[:space:]]+(-[[:alnum:]]+[[:space:]]+)*/dev/null'
PTY_LINUX='(^|[^[:alnum:]_./-])script[[:space:]]+(-[[:alnum:]]*c|-[[:alnum:]]+[[:space:]]+-c)'
STAT_BSD='stat[[:space:]]+(-[[:alnum:]]+[[:space:]]+)*-f'
STAT_GNU='stat[[:space:]]+(-[[:alnum:]]+[[:space:]]+)*-c'

scanned=0
violations=""
saw_control_pty=0
saw_control_stat=0

for f in "$SCRIPT_DIR"/*.sh; do
    base="$(basename "$f")"
    # Exclude SELF by exact basename, never a path prefix: an over-broad exclude
    # is a fail-closed hole, not a cosmetic one.
    [ "$base" = "$SELF" ] && continue
    scanned=$((scanned + 1))

    n_bsd_pty="$(count_code "$PTY_BSD" "$f")"
    n_lnx_pty="$(count_code "$PTY_LINUX" "$f")"
    if [ "$n_bsd_pty" -gt 0 ] && [ "$n_lnx_pty" -eq 0 ]; then
        violations="${violations}${base}: uses the BSD pty form 'script -q /dev/null CMD' with no 'script -q -c CMD /dev/null' fallback anywhere in the file (silently does not run under a pty on util-linux)"$'\n'
    elif [ "$n_lnx_pty" -gt 0 ] && [ "$n_bsd_pty" -eq 0 ]; then
        violations="${violations}${base}: uses the util-linux pty form 'script -q -c CMD /dev/null' with no BSD 'script -q /dev/null CMD' fallback anywhere in the file (fails on macOS)"$'\n'
    elif [ "$n_bsd_pty" -gt 0 ] && [ "$n_lnx_pty" -gt 0 ]; then
        [ "$base" = "$CONTROL_PTY" ] && saw_control_pty=1
    fi

    n_bsd_stat="$(count_code "$STAT_BSD" "$f")"
    n_gnu_stat="$(count_code "$STAT_GNU" "$f")"
    if [ "$n_bsd_stat" -gt 0 ] && [ "$n_gnu_stat" -eq 0 ]; then
        violations="${violations}${base}: uses the BSD form 'stat -f' with no 'stat -c' fallback anywhere in the file (fails on a GNU/Linux runner)"$'\n'
    elif [ "$n_gnu_stat" -gt 0 ] && [ "$n_bsd_stat" -eq 0 ]; then
        violations="${violations}${base}: uses the GNU form 'stat -c' with no 'stat -f' fallback anywhere in the file (fails on macOS)"$'\n'
    elif [ "$n_bsd_stat" -gt 0 ] && [ "$n_gnu_stat" -gt 0 ]; then
        [ "$base" = "$CONTROL_STAT" ] && saw_control_stat=1
    fi
done

# ---- VACUITY GUARDS, asserted BEFORE the verdict is trusted -----------------
if [ "$scanned" -gt 0 ]; then
    ok "scanned $scanned test files (the glob is live)"
else
    bad "scanned 0 test files; every verdict below would be vacuous"
fi

if [ "$saw_control_pty" -eq 1 ]; then
    ok "detector positively identified BOTH script(1) forms in $CONTROL_PTY"
else
    bad "detector did NOT see both script(1) forms in the known-good $CONTROL_PTY; the pty patterns match nothing, so a clean verdict is an absent measurement"
fi

if [ "$saw_control_stat" -eq 1 ]; then
    ok "detector positively identified BOTH stat(1) forms in $CONTROL_STAT"
else
    bad "detector did NOT see both stat(1) forms in the known-good $CONTROL_STAT; the stat patterns match nothing, so a clean verdict is an absent measurement"
fi

# ---- the verdict ------------------------------------------------------------
if [ -z "$violations" ]; then
    ok "no test file uses a platform-divergent construct without a fallback"
else
    bad "platform-divergent constructs found (green on macOS, red on a Linux runner):"
    printf '%s' "$violations" | sed 's/^/        /'
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
