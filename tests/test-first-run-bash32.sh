#!/usr/bin/env bash
# The whole first-run path must work on macOS stock bash 3.2.
#
# WHY THE PATH AND NOT JUST ONE FUNCTION. v8.3.2 fixed `declare -A` in the
# quickstart template scorer, which returned ZERO templates on every Mac using
# /bin/bash. That was one bash-4 construct in one function, and it survived
# because the harness runs homebrew bash 5 -- our tests literally could not see
# the shell most of our users have.
#
# Fixing that one call site does not close the class. Any future bash-4-only
# construct anywhere in the first-run path reintroduces the same failure, and
# the first-run path is the least forgiving place to have one: a new user who
# hits an error or an empty screen in their first minute does not file an issue,
# they leave.
#
# So this walks the commands a brand-new user actually runs, in order, under
# /bin/bash EXPLICITLY. Running them under $SHELL would reproduce exactly the
# blind spot that let v8.3.2's bug ship.
#
# Deliberately NOT asserted here: anything requiring a provider, an API key,
# network, or spend. The point is what works before a user has committed
# anything, which is also the honest scope of what we advertise as keyless.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

if [ ! -x /bin/bash ]; then
    echo "  [SKIP] /bin/bash not present"
    echo "Results: 0 passed, 0 failed, 0 total"
    exit 0
fi

BASH_MAJOR=$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null || echo "?")
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loki-firstrun.XXXXXX")"
trap 'rm -rf "$HOME_DIR"' EXIT

echo "T1 -- the welcome screen renders (/bin/bash major $BASH_MAJOR)"

out=$(HOME="$HOME_DIR" /bin/bash "$LOKI" 2>&1)
if printf '%s' "$out" | grep -q "Loki Mode v"; then
    ok "bare loki prints the welcome banner"
else
    bad "bare loki did not print a welcome banner"
    printf '%s\n' "$out" | head -4 | sed 's/^/    /'
fi

# The ordered next-steps list is the entire funnel. If it renders empty or
# errors, a new user has no idea what to do next.
for step in "loki tour" "loki doctor" "loki quickstart"; do
    if printf '%s' "$out" | grep -q "$step"; then
        ok "welcome offers '$step'"
    else
        bad "welcome is missing '$step' -- the funnel has a hole"
    fi
done

# A bash-4 construct typically surfaces as this exact diagnostic.
if printf '%s' "$out" | grep -qE "invalid option|unbound variable|syntax error"; then
    bad "shell error in the welcome path under bash $BASH_MAJOR"
    printf '%s' "$out" | grep -E "invalid option|unbound variable|syntax error" | head -3 | sed 's/^/    /'
else
    ok "no shell errors in the welcome path"
fi

echo
echo "T2 -- loki tour works with no provider, no key, no network"

# This is the claim the README leads with, so it has to hold on the stock Mac
# shell specifically.
tour=$(HOME="$HOME_DIR" /bin/bash "$LOKI" tour 2>&1)
if printf '%s' "$tour" | grep -q "Evidence Receipt"; then
    ok "tour renders an Evidence Receipt"
else
    bad "tour did not render a receipt -- the keyless entry point is broken"
    printf '%s\n' "$tour" | head -5 | sed 's/^/    /'
fi

# The honest headline is the differentiator. A tour that printed a clean
# all-green sample would be exactly the marketing we refuse to ship.
if printf '%s' "$tour" | grep -q "VERIFIED WITH GAPS"; then
    ok "the sample receipt keeps its honest 'WITH GAPS' headline"
else
    bad "sample receipt no longer shows the honest gapped headline"
fi

if printf '%s' "$tour" | grep -qE "invalid option|unbound variable|syntax error"; then
    bad "shell error in the tour path under bash $BASH_MAJOR"
else
    ok "no shell errors in the tour path"
fi

echo
echo "T3 -- the quickstart scorer returns templates (the v8.3.2 regression)"

# Guards the specific bug by behaviour rather than by grepping for `declare -A`,
# so a different bash-4 construct in the same function still fails here.
qs=$(/bin/bash -c "source '$REPO_ROOT/autonomy/quickstart.sh' >/dev/null 2>&1; _qs_score_templates 'a todo app with auth'" 2>&1)
n=$(printf '%s\n' "$qs" | grep -cE '^[a-z0-9-]+$' || true)
if [ "$n" -ge 1 ]; then
    ok "scorer returned $n template(s) under /bin/bash"
else
    bad "scorer returned ZERO templates under /bin/bash (v8.3.2 regression)"
    printf '%s\n' "$qs" | head -3 | sed 's/^/    /'
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
