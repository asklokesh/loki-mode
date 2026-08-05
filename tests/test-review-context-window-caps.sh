#!/usr/bin/env bash
# tests/test-review-context-window-caps.sh -- review size caps derive from
# PROVIDER_CONTEXT_WINDOW instead of a fixed byte count.
#
# Exercises the REAL review_effective_cap from autonomy/run.sh by sourcing it
# (main() and the self-copy block are both guarded by
# [[ "${BASH_SOURCE[0]}" == "${0}" ]], so sourcing runs neither).
#
# IMPORTANT: do NOT set LOKI_RUNNING_FROM_TEMP=1. run.sh installs an EXIT trap
# `rm -f "${BASH_SOURCE[0]}"` when that var is 1, which at this test's EXIT would
# delete THIS file.
#
# The properties that matter:
#   1. A small window shrinks the cap (the motivating local-12b/14b case).
#   2. An unset window reproduces the historical defaults exactly, so nothing
#      changes for current users.
#   3. The operator env override beats both.
#   4. prompt_cap > diff_cap survives derivation. If they ever came out equal, a
#      diff that passes the diff gate would build a prompt that always fails the
#      prompt gate: every review blocks, fail-closed, with no visible cause.
#   5. Every shipped provider's real window still yields today's exact defaults.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: autonomy/run.sh not found. (Not a fail.)"; exit 0
fi

# Source from a scratch dir: run.sh's top-level provider block does
# `mkdir -p .loki/state` and writes .loki/state/provider into the CWD, which
# would dirty the repo when this test runs from the repo root.
_TMPD=$(mktemp -d 2>/dev/null || mktemp -d -t lokicaps)
trap 'rm -rf "$_TMPD"' EXIT
cd "$_TMPD" || { echo "SKIP: could not enter temp dir. (Not a fail.)"; exit 0; }

# shellcheck source=/dev/null
source "$RUN_SH" >/dev/null 2>&1 || true

if ! command -v review_effective_cap >/dev/null 2>&1 \
   && [ "$(type -t review_effective_cap 2>/dev/null)" != "function" ]; then
    echo "FAIL: review_effective_cap not defined after sourcing run.sh"; exit 1
fi

DEFAULT_PROMPT=425000
DEFAULT_DIFF=400000

expect_eq() {
    local label="$1" got="$2" want="$3"
    if [ "$got" = "$want" ]; then ok "$label"; else bad "$label" "got $got, want $want"; fi
}

# 1. Small window (an 8k local model) shrinks BOTH caps well below the defaults.
PROVIDER_CONTEXT_WINDOW=8000
p=$(review_effective_cap "" "$DEFAULT_PROMPT")
d=$(review_effective_cap "" "$DEFAULT_DIFF")
if [ "$p" -lt "$DEFAULT_PROMPT" ] && [ "$p" -gt 0 ]; then
    ok "8k window shrinks prompt cap below default (got $p)"
else
    bad "8k window shrinks prompt cap" "got $p, want 0 < cap < $DEFAULT_PROMPT"
fi
expect_eq "8k window tracks the window, not 425000" "$p" 18000
# Scaled by 400000/425000 to preserve the scaffolding gap below the prompt cap.
expect_eq "8k window diff cap tracks the window" "$d" 16941

# A 32k window also derives, and derives LARGER than the 8k one: the cap must
# actually track the window, not merely be "some smaller constant".
PROVIDER_CONTEXT_WINDOW=32000
p32=$(review_effective_cap "" "$DEFAULT_PROMPT")
if [ "$p32" -gt "$p" ] && [ "$p32" -lt "$DEFAULT_PROMPT" ]; then
    ok "32k window derives larger than 8k but under default ($p32 > $p)"
else
    bad "32k window scales with window" "got $p32 vs 8k=$p"
fi

# 2. Unset window reproduces the historical defaults EXACTLY.
unset PROVIDER_CONTEXT_WINDOW
expect_eq "unset window keeps prompt default" \
    "$(review_effective_cap "" "$DEFAULT_PROMPT")" "$DEFAULT_PROMPT"
expect_eq "unset window keeps diff default" \
    "$(review_effective_cap "" "$DEFAULT_DIFF")" "$DEFAULT_DIFF"

# 3. Operator override wins over a small window (highest precedence).
PROVIDER_CONTEXT_WINDOW=8000
expect_eq "env override beats a small window" \
    "$(review_effective_cap 999 "$DEFAULT_PROMPT")" 999
unset PROVIDER_CONTEXT_WINDOW
expect_eq "env override beats the default" \
    "$(review_effective_cap 999 "$DEFAULT_PROMPT")" 999

# 4. Ordering invariant: prompt cap stays strictly above diff cap. This MUST be
# asserted on windows small enough to actually derive -- checking it at 200000
# (where both clamp to the defaults) tests the defaults, not the derivation, and
# would miss a derived-path deadlock entirely.
for w in 8000 32000 100000 141000; do
    PROVIDER_CONTEXT_WINDOW="$w"
    dp=$(review_effective_cap "" "$DEFAULT_PROMPT")
    dd=$(review_effective_cap "" "$DEFAULT_DIFF")
    if [ "$dp" -ge "$DEFAULT_PROMPT" ]; then
        bad "window $w should derive, not clamp" "prompt=$dp"
    elif [ "$dp" -gt "$dd" ]; then
        ok "derived prompt cap exceeds diff cap at window $w ($dp > $dd)"
    else
        bad "derived prompt cap must exceed diff cap at window $w" "prompt=$dp diff=$dd"
    fi
done

# 5. Fail safe: a garbage window must NOT yield an empty/non-numeric cap, which
# would make the caller's `[ ... -gt ... ]` exit 2 and dispatch an oversized review.
for junk in "abc" "" "-5" "12x"; do
    PROVIDER_CONTEXT_WINDOW="$junk"
    got=$(review_effective_cap "" "$DEFAULT_PROMPT")
    if [ "$got" = "$DEFAULT_PROMPT" ]; then
        ok "non-numeric window '$junk' falls back to the default"
    else
        bad "non-numeric window '$junk'" "got '$got', want $DEFAULT_PROMPT"
    fi
done

# 6. Every shipped provider keeps today's exact caps (no behavior change).
# Read the real windows out of providers/*.sh rather than hardcoding literals:
# hardcoded values stay green if someone lowers a provider's window, which is
# exactly the change that would silently shrink caps for existing users.
_checked=0
for f in "$REPO_ROOT"/providers/*.sh; do
    [ -f "$f" ] || continue
    w=$(grep -m1 '^PROVIDER_CONTEXT_WINDOW=' "$f" 2>/dev/null | cut -d= -f2 | tr -d ' "')
    case "$w" in ''|*[!0-9]*) continue ;; esac
    _checked=$((_checked + 1))
    # shellcheck disable=SC2034  # read by review_effective_cap, sourced from run.sh
    PROVIDER_CONTEXT_WINDOW="$w"
    gp=$(review_effective_cap "" "$DEFAULT_PROMPT")
    gd=$(review_effective_cap "" "$DEFAULT_DIFF")
    if [ "$gp" = "$DEFAULT_PROMPT" ] && [ "$gd" = "$DEFAULT_DIFF" ]; then
        ok "shipped provider $(basename "$f") (window $w) keeps defaults unchanged"
    else
        bad "shipped provider $(basename "$f") (window $w) changed behavior" \
            "prompt=$gp (want $DEFAULT_PROMPT), diff=$gd (want $DEFAULT_DIFF)"
    fi
done
if [ "$_checked" -gt 0 ]; then
    ok "found $_checked provider window declarations to check"
else
    bad "no provider windows found" "expected at least one providers/*.sh declaration"
fi
unset PROVIDER_CONTEXT_WINDOW

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
