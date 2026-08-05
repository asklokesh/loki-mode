#!/usr/bin/env bash
# Every real top-level command must be reachable from `loki help`.
#
# WHY THIS EXISTS, and it is measured rather than assumed. Five separate items
# this session were capability that ALREADY EXISTED but could not be found:
# image signing (built, gated, documented nowhere), `loki plan` (the dry-run
# answer, unmentioned by `start --help`), the exit-20 contract (documented only
# in a Helm values comment), `loki ci` JSON (as --format json while everything
# else uses --json), and `loki tour` (never surfaced by the Bun route's doctor
# failure). Each was found by hand, one at a time.
#
# A gate finds the class. Word-of-mouth adoption needs a user to reach a result,
# and a feature they cannot find does not exist to them.
#
# MEASURED BEFORE BUILDING (the task required it): 43 of 112 real commands were
# absent from `loki help`, including `loki proof` -- the Evidence Receipt, the
# command the product's whole trust argument rests on. There is no fuller
# listing: `help --all`, `help all` and `commands` all return nothing.
#
# ENUMERATION PROBES THE CLI rather than parsing it. Nested case blocks sit at
# the same indentation as top-level ones, so static parsing yields ~70 false
# positives (`python`, `jest`, `rust` are `loki next` arguments, not commands).
# Measured: parsing gives 239 candidates, probing gives 112 real commands.
#
# SCOPE: this asserts the command is REACHABLE from help, not that its help
# text is good. A stricter check on wording would be judgment dressed as a
# gate, and would fail on prose changes that harm nobody.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DISPATCH_START="$(grep -n '^main()' "$LOKI" | head -1 | cut -d: -f1)"
[ -n "$DISPATCH_START" ] || { echo "FAIL: could not locate main() in $LOKI"; exit 1; }

awk -v start="$DISPATCH_START" '
    NR > start && /^[[:space:]]+[a-z][a-z0-9|_-]*\)/ {
        s = $0; sub(/^[[:space:]]+/, "", s); sub(/\).*/, "", s)
        n = split(s, a, "|")
        for (i = 1; i <= n; i++) print a[i]
    }
' "$LOKI" | sort -u > "$WORK/candidates.txt"

# Probe: a real command does not answer "Unknown command". Output is CAPTURED,
# never piped into a matcher -- under `set -o pipefail` a `| head` closes the
# pipe, the CLI dies of SIGPIPE, and the pipeline reports nonzero regardless of
# the match, which silently marks every candidate real.
: > "$WORK/real.txt"
while read -r c; do
    case "$c" in -*|'') continue ;; esac
    probe="$("$LOKI" "$c" --help </dev/null 2>&1 || true)"
    case "$probe" in
        *"Unknown command"*) ;;
        *) printf '%s\n' "$c" >> "$WORK/real.txt" ;;
    esac
done < "$WORK/candidates.txt"

real_count="$(wc -l < "$WORK/real.txt" | tr -d ' ')"
if [ "$real_count" -lt 50 ]; then
    # A collapsed count means the probe broke, not that the CLI shrank. Failing
    # loudly beats reporting full coverage over an empty set.
    bad "only ${real_count} commands resolved; the probe is broken, not the CLI"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi
ok "resolved ${real_count} real top-level commands by probing the CLI"

HELP_OUT="$("$LOKI" help </dev/null 2>&1 || true)"
if [ "$(printf '%s' "$HELP_OUT" | wc -l | tr -d ' ')" -lt 20 ]; then
    bad "'loki help' produced almost no output; the harness or help is broken"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi

missing=""
missing_n=0
while read -r c; do
    # Accept either spelling: `self_update` dispatches but `self-update` is what
    # a user types and what help lists. Rejecting that would be a phantom gap.
    alt="$(printf '%s' "$c" | tr '_' '-')"
    if printf '%s' "$HELP_OUT" | grep -qw -- "$c" \
       || printf '%s' "$HELP_OUT" | grep -qw -- "$alt"; then
        continue
    fi
    missing="${missing}${c} "
    missing_n=$((missing_n + 1))
done < "$WORK/real.txt"

if [ "$missing_n" -eq 0 ]; then
    ok "every real command is reachable from 'loki help'"
else
    bad "${missing_n} command(s) absent from 'loki help': ${missing}"
fi

# The Evidence Receipt is the product's trust argument. If a user cannot find
# it from help, the differentiator is invisible -- which is precisely the
# failure this gate exists to prevent, so it gets its own named assertion
# rather than being one entry in a long list.
for c in proof verify; do
    if printf '%s' "$HELP_OUT" | grep -qw -- "$c"; then
        ok "'loki ${c}' is discoverable from help"
    else
        bad "'loki ${c}' is absent from help -- the trust surface is unfindable"
    fi
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
