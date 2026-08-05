#!/usr/bin/env bash
# Test: `stat` fallbacks in the test suite must probe the GNU form FIRST.
#
# THE BUG (found 2026-07-28, after the Tests workflow started running again):
#   Several tests read a file mode or mtime with
#       stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f" 2>/dev/null
#   That reads correctly on macOS and is WRONG on Linux. GNU coreutils `stat -f`
#   is not "format" -- it means "display filesystem status", and it EXITS 0. So
#   on a Linux runner the first command SUCCEEDS with unrelated output
#   (`File: "..."`) and the `||` fallback never fires. The assertion then
#   compares a filesystem-status blob against an expected mode like "600".
#
#   This silently failed 5 shell-test suites on every CI run. It was invisible
#   for four days because the workflow itself was not starting (a `secrets`
#   reference in an `if:`), so nobody saw the output.
#
# THE RULE: probe `stat -c` (GNU) FIRST. On macOS `stat -c` is a genuine error
# and exits non-zero, so the fallback to `stat -f` is sound in that direction.
# The reverse is not.
#
# Proven directions:
#   POSITIVE  : no test file uses the macOS-first ordering.
#               RED before the fix (5 files did).
#   SEMANTIC  : the GNU-first expression returns the REAL mode on this machine,
#               so the guard cannot pass by making every reader return junk.
#   NEGATIVE  : `stat -f` alone does NOT yield a bare numeric mode everywhere --
#               documents WHY the ordering matters rather than trusting a
#               comment. Skipped on macOS, where `stat -f '%Lp'` is correct.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "=== stat portability (GNU-first ordering) ==="

# ---- POSITIVE: no macOS-first ordering anywhere in tests/ -------------------
# Match the ordering in CODE only; the explanatory comments in the fixed files
# legitimately quote the broken form, so require a line that is not a comment.
offenders=""
while IFS= read -r line; do
    file="${line%%:*}"
    rest="${line#*:}"
    lineno="${rest%%:*}"
    body="${rest#*:}"
    # strip leading whitespace, skip comment lines
    trimmed="$(printf '%s' "$body" | sed 's/^[[:space:]]*//')"
    case "$trimmed" in
        '#'*) continue ;;
    esac
    offenders="${offenders}${file}:${lineno}\n"
# Exclude THIS file: it necessarily contains the broken pattern as the grep
# needle, and matching itself would make the guard permanently red.
done < <(grep -rn "stat -f[^|]*|| *stat -c" "$SCRIPT_DIR"/*.sh 2>/dev/null \
           | grep -v "test-stat-portability.sh:" || true)

if [ -z "$offenders" ]; then
    ok "no test uses the macOS-first 'stat -f ... || stat -c ...' ordering"
else
    bad "macOS-first stat ordering found (breaks on Linux runners):"
    printf "%b" "$offenders" | sed 's/^/        /'
fi

# ---- SEMANTIC: the GNU-first expression actually reads a mode --------------
# Guards against "fixing" the ordering into something that returns nothing.
TMP="$(mktemp "${TMPDIR:-/tmp}/loki-statport-XXXXXX")"
chmod 640 "$TMP"
mode="$(stat -c '%a' "$TMP" 2>/dev/null || stat -f '%Lp' "$TMP" 2>/dev/null)"
if [ "$mode" = "640" ]; then
    ok "GNU-first reader returns the real mode (640) on this platform"
else
    bad "GNU-first reader returned '$mode', expected '640'"
fi

# ---- NEGATIVE: show WHY the order matters, on Linux ------------------------
# On Linux, `stat -f` succeeds with filesystem status -- proving the macOS-first
# `||` can never fall through. On macOS `stat -f '%Lp'` is the correct reader,
# so there is nothing to prove and the check is skipped.
if stat -c '%a' "$TMP" >/dev/null 2>&1; then
    wrong="$(stat -f '%Lp' "$TMP" 2>/dev/null || true)"
    if [ "$wrong" = "640" ]; then
        bad "expected 'stat -f' NOT to yield a bare mode on a GNU system, got '$wrong'"
    else
        ok "on GNU, 'stat -f' does not yield a bare mode (so || never fires)"
    fi
else
    echo "  SKIP  macOS: 'stat -f' is the correct reader here, nothing to contrast"
fi
rm -f "$TMP"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
