#!/usr/bin/env bash
# Every real top-level command must appear in BOTH shell completions.
#
# WHY A COVERAGE GATE RATHER THAN THREE ASSERTIONS. `handoff`, `receipt` and
# `cp` were each missing from a completion file. Adding three named checks
# would fix those three and catch none of the next ones. This repo has shipped
# a command without its cross-cutting registrations at least four separate
# times -- it is a CLASS of defect, and a per-feature test cannot see a class.
#
# WHY THIS PROBES THE CLI INSTEAD OF PARSING IT. Static extraction does not
# work here, and this is the interesting part. `autonomy/loki` dispatches on a
# large case statement, but NESTED case statements (subcommand arguments) sit
# at the same indentation as the top-level ones. Parsing by indent yields
# `python`, `jest`, `rust`, `critical` and ~70 others as "missing commands" --
# all false positives, all subcommand arguments. Measured: naive parsing
# reported 239 candidates; probing the CLI found 111 real commands.
#
# So the only reliable oracle is the CLI itself: a real command does not answer
# "Unknown command". That is slower than a grep and it is correct, which is the
# right trade for a gate that must not cry wolf.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
BASH_COMP="$REPO_ROOT/completions/loki.bash"
ZSH_COMP="$REPO_ROOT/completions/_loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

for f in "$LOKI" "$BASH_COMP" "$ZSH_COMP"; do
    [ -f "$f" ] || { printf 'FAIL: missing %s\n' "$f"; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Candidate labels from the main dispatch case. Over-collects on purpose: the
# probe below is what decides, so a false candidate costs one probe and a
# MISSED candidate would be a hole in the gate.
DISPATCH_START="$(grep -n '^main()' "$LOKI" | head -1 | cut -d: -f1)"
[ -n "$DISPATCH_START" ] || { echo "FAIL: could not locate main() in $LOKI"; exit 1; }

awk -v start="$DISPATCH_START" '
    NR > start && /^[[:space:]]+[a-z][a-z0-9|_-]*\)/ {
        s = $0
        sub(/^[[:space:]]+/, "", s)
        sub(/\).*/, "", s)
        n = split(s, a, "|")
        for (i = 1; i <= n; i++) print a[i]
    }
' "$LOKI" | sort -u > "$WORK/candidates.txt"

# Probe each candidate. A real command prints help or acts; a subcommand
# argument reaching the top level prints "Unknown command".
# TWO NON-OBVIOUS REQUIREMENTS, each of which silently broke this probe once.
#
# 1. The output is CAPTURED, then matched -- never `cli | head | grep -q`.
#    Under `set -o pipefail` (on above), `head` closes the pipe as soon as it
#    has its lines, the CLI dies of SIGPIPE, and the PIPELINE's status is
#    nonzero no matter what grep found. Every candidate then looks real: the
#    gate reported 269 commands instead of 112 and flagged ~90 subcommand
#    arguments as missing completions. The identical logic outside pipefail
#    behaved correctly, which is what made it confusing.
#
# 2. `</dev/null` keeps the CLI from consuming the loop's stdin, which would
#    otherwise eat the candidate list after the first iteration.
# 3. EVERY PROBE IS TIME-BOUNDED, and this is not defensive padding.
#
#    This loop runs `loki <c> --help` for all ~274 candidates, and `help` is
#    one of them. `loki help --help` used to delegate to itself unboundedly
#    (fixed in ccf8dcbb), spawning a process per level until the fork table
#    was exhausted. The probe had no timeout, so the whole suite was killed:
#    the weekly integrity audit reported rc143 (SIGTERM, 128+15) with no
#    indication of WHICH command hung, and a reader saw a dead job rather
#    than a named defect.
#
#    A blanket skip of `help` would have hidden exactly the bug that needed
#    fixing. The bound is per-command instead, so a future recursion in ANY
#    command is reported by NAME and the remaining candidates still run.
#
#    A timed-out probe is NOT treated as "Unknown command": that would
#    silently drop a real command from the coverage set and the gate would
#    pass while checking less. It is recorded as a FAILURE with the culprit.
_probe() {
    if command -v timeout >/dev/null 2>&1; then
        timeout 15 "$@"
    elif command -v gtimeout >/dev/null 2>&1; then
        gtimeout 15 "$@"
    else
        "$@"
    fi
}

: > "$WORK/real.txt"
: > "$WORK/hung.txt"
while read -r c; do
    case "$c" in -*|'') continue ;; esac
    # Reset per iteration. `_prc` persists once set, so without this a single
    # timeout would mark every LATER command as hung too -- one real culprit
    # rendered as dozens, which is worse than none.
    _prc=0
    # Capture the status of the PROBE, not of the assignment. `x="$(cmd || true)"`
    # always yields 0, so `$?` afterwards reads the assignment and every timeout
    # would be invisible. The `|| true` is therefore dropped here and the status
    # taken directly.
    probe_out="$(_probe "$LOKI" "$c" --help </dev/null 2>&1)" || _prc=$?
    _prc="${_prc:-0}"
    # 124 = timeout(1) killed it; 137 = SIGKILL after a stuck TERM.
    if [ "$_prc" = "124" ] || [ "$_prc" = "137" ]; then
        printf '%s\n' "$c" >> "$WORK/hung.txt"
        continue
    fi
    case "$probe_out" in
        *"Unknown command"*) ;;
        *) printf '%s\n' "$c" >> "$WORK/real.txt" ;;
    esac
done < "$WORK/candidates.txt"

if [ -s "$WORK/hung.txt" ]; then
    while read -r _hc; do
        bad "PROBE HUNG: 'loki $_hc --help' did not return within 15s -- it is
     recursing or blocking. This is the defect that made the weekly audit
     exit 143 with no culprit named."
    done < "$WORK/hung.txt"
fi

real_count=$(wc -l < "$WORK/real.txt" | tr -d ' ')
if [ "$real_count" -lt 50 ]; then
    # A collapsed count means the probe broke (CLI cannot start, help changed
    # wording), not that the CLI shrank. Failing loudly beats reporting full
    # coverage over an empty set -- a gate that passes vacuously is worse than
    # no gate.
    bad "only ${real_count} commands resolved; the probe is broken, not the CLI"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi
ok "resolved ${real_count} real top-level commands by probing the CLI"

# A command counts as covered if its name appears as a whole word. Both files
# use different shapes (a flat string in bash, 'name:description' in zsh), so
# matching structure rather than a word would need two parsers and would break
# whenever either file's style changed.
check_file() {
    local file="$1" label="$2" missing="" alt=""
    while read -r c; do
        # A command may be dispatched under one spelling and completed under
        # another: `self_update` is the case label, while both completion files
        # register `self-update`. Both spellings work at the CLI, and the
        # hyphenated one is what a user types, so accept either. Without this
        # the gate reports a phantom gap and trains people to ignore it.
        alt="$(printf '%s' "$c" | tr '_' '-')"
        grep -qw -- "$c" "$file" || grep -qw -- "$alt" "$file" \
            || missing="${missing}${c} "
    done < "$WORK/real.txt"

    if [ -z "$missing" ]; then
        ok "${label} covers every real command"
    else
        bad "${label} is missing: ${missing}"
    fi
}

check_file "$BASH_COMP" "bash completion"
check_file "$ZSH_COMP" "zsh completion"

# Guard the three that motivated this gate, so a regression names them directly
# instead of appearing inside a long list.
for c in handoff receipt cp; do
    if grep -qw -- "$c" "$BASH_COMP" && grep -qw -- "$c" "$ZSH_COMP"; then
        ok "'${c}' is registered in both completions"
    else
        bad "'${c}' missing from a completion file (this is the regression this gate exists for)"
    fi
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
