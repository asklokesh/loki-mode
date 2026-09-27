#!/usr/bin/env bash
# tests/test-timeout-escalates.sh -- guard: a `timeout <N>` launch of
# autonomy/run.sh (directly, or via a $RUN_SH-style variable) or autonomy/loki
# must always escalate to SIGKILL with `-k`, never rely on plain `timeout`.
#
# E-00 incident: a `timeout 240 bash .../agent-<id>/autonomy/run.sh` process
# ran over 24 hours. It ignored SIGTERM, and plain `timeout` never escalates
# past the TERM it sends at N seconds -- there is no second signal, ever, so a
# child that traps or ignores TERM (or is itself stuck in an uninterruptible
# wait) runs forever. `timeout -k 10 N` sends TERM at N seconds and, if the
# process is still alive 10 seconds later, KILL.
#
# REWORK (E-00 review): the first cut only matched a literal `autonomy/loki`,
# `autonomy/run.sh` or a bare `RUN_SH` token on the SAME line as the `bash`
# keyword, so it covered about 5 of the ~50 real call sites and missed two
# reviewer-reproduced mutations:
#   - tests/test-why-honest-report.sh's `timeout N bash "$LOKI" why` (the
#     target is the "$LOKI"/"$LOKI_BIN" wrapper variable, not a literal path).
#   - tests/test-web-stop-scoping.sh's `TBIN="timeout N"` assigned on one
#     line and used as `$TBIN bash "$LOKI" ...` several lines later -- the
#     digit and the loki/run.sh target never appear on the same line at all.
# Fixed with two independent clauses below (T1, T2), covering every real
# fixed site (proven against the current tree) and both mutations (proven
# against a copy with each one re-introduced).
#
# Scope: tests/, scripts/, autonomy/ -- the same three directories this
# incident's own fix was grepped out of. Every file, not just *.sh, so a
# launcher with no extension (autonomy/loki itself) is not silently skipped.
# Comment lines (leading '#') are never treated as real calls in either
# clause, and clause T1's target check is narrow enough (LOKI/LOKI_BIN/RUN_SH
# as a whole token, never a longer LOKI_-prefixed env var like
# LOKI_COMPLEXITY) that a merely-adjacent env-var reference cannot forge a
# match. `--timeout N` (an app's own CLI flag, e.g. `loki review --timeout
# 12`) and `spawn_timeout N` (a substring inside a longer identifier) are
# excluded by requiring a non-identifier, non-hyphen character immediately
# before the word `timeout`/`gtimeout`.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Overridable so a mutation probe can point this at a throwaway scratch copy
# instead of ever touching the real tree (loki-verify: a mutation must go red
# in a copy, never in the file under test).
SCAN_ROOT="${TIMEOUT_ESCALATES_ROOT:-$REPO_ROOT}"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

# A real, un-escalated `timeout`/`gtimeout` command token: NOT preceded by an
# identifier character or a hyphen (rules out `spawn_timeout 99` and the
# app's own `--timeout 12` flag), immediately followed by whitespace then a
# digit, with no `-k` in between. Applied to a line padded with a leading
# space, so a match at true column 0 still has a boundary character to test.
UNESC_RE='[^A-Za-z0-9_-](g?timeout)[[:space:]]+[0-9]+'
# A loki/run.sh target as a whole token: LOKI, LOKI_BIN or RUN_SH (bare or
# braced), never a longer LOKI_-prefixed env var (LOKI_COMPLEXITY,
# LOKI_BUDGET_LIMIT, ...), plus the two literal paths.
TARGET_RE='\$\{?LOKI_BIN[^A-Za-z0-9_]|\$\{?LOKI[^A-Za-z0-9_]|\$\{?RUN_SH[^A-Za-z0-9_]|autonomy/loki|autonomy/run\.sh'
# A variable holding a bare timeout invocation as its whole value: `X="timeout
# N"` or `X="gtimeout N"`, no -k (an escalated value has `-k 10` between the
# digit and the closing quote, which this cannot match).
ASSIGN_RE='[A-Za-z_][A-Za-z0-9_]*="(g?timeout)[[:space:]]+[0-9]+[[:space:]]*"'

is_comment() {
    # $1: a source line. True if, once leading whitespace is stripped, it
    # starts with '#' -- a comment describing a call is not a real one.
    trimmed="${1#"${1%%[![:space:]]*}"}"
    case "$trimmed" in
        '#'*) return 0 ;;
        *) return 1 ;;
    esac
}

violations=""

echo "T1 -- a 'timeout <N>' naming a loki/run.sh target on the SAME line escalates with -k"
while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    file="${hit%%:*}"; rest="${hit#*:}"; lineno="${rest%%:*}"; line="${rest#*:}"
    is_comment "$line" && continue
    printf ' %s' "$line" | grep -qE "$UNESC_RE" || continue
    printf '%s' "$line" | grep -qE "$TARGET_RE" || continue
    violations="${violations}${file}:${lineno}: ${line}
"
done < <(grep -rnE '(g?timeout)[[:space:]]+[0-9]' \
    "$SCAN_ROOT/tests" "$SCAN_ROOT/scripts" "$SCAN_ROOT/autonomy" \
    --binary-files=without-match 2>/dev/null)

echo "T2 -- a variable assigned a bare 'timeout <N>' in a file that invokes loki/run.sh elsewhere escalates with -k"
while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    file="${hit%%:*}"; rest="${hit#*:}"; lineno="${rest%%:*}"; line="${rest#*:}"
    is_comment "$line" && continue
    printf '%s' "$line" | grep -qE "$ASSIGN_RE" || continue
    # Qualify only on a real, non-comment invocation elsewhere in this file --
    # not merely mentioning LOKI/RUN_SH in prose (autonomy/lib/claude-flags.sh
    # names "autonomy/loki" only in a comment and wraps npx, never loki/run.sh,
    # and must never qualify here).
    grep -vE '^[[:space:]]*#' "$file" 2>/dev/null | grep -qE "$TARGET_RE" || continue
    violations="${violations}${file}:${lineno}: ${line}
"
done < <(grep -rnE '=".*(g?timeout)[[:space:]]+[0-9]' \
    "$SCAN_ROOT/tests" "$SCAN_ROOT/scripts" "$SCAN_ROOT/autonomy" \
    --binary-files=without-match 2>/dev/null)

if [ -z "$violations" ]; then
    ok "no unescalated 'timeout N' launch of run.sh/autonomy/loki found under tests/, scripts/, autonomy/"
else
    bad "unescalated timeout launch(es) found (missing -k):"
    printf '%s' "$violations"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
