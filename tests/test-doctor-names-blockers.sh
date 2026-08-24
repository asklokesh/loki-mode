#!/usr/bin/env bash
# First-run funnel: doctor must NAME what is blocking, not just count it.
#
# THE LEAK THIS CLOSES. On a bare machine `loki doctor` emits 15 WARNINGS
# (sentrux, GPG receipt signing, bash >= 4, Bun, python3.12, truecolor,
# inline-image probe -- every one of them OPTIONAL) surrounding 2 real
# blockers, and then ended with:
#
#     Some required prerequisites are missing.
#     Install missing dependencies and run 'loki doctor' again.
#
# It never said WHICH. A first-time user cannot tell the two blockers from the
# fifteen things that do not matter, and the honest reading of that screen is
# "this needs a lot of setup". That is where someone closes the terminal, and
# it is the single highest-leverage point in the funnel: 200 forks against
# 1,028 stars says interest is not the problem, conversion is.
#
# The summary now names each blocker with its fix, states plainly that
# everything else is optional, and points at `loki tour` -- which works with no
# provider, no key and no spend -- so a blocked user still reaches a real
# result on their first minute.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-doctor-funnel.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "T1 -- a blocked user is told exactly what blocks them"

# Simulate a bare machine: minimal PATH (no node, no provider CLI) and a fresh
# HOME so no prior state leaks in.
out=$(HOME="$WORK" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
        bash "$LOKI" doctor 2>&1 | sed 's/\x1b\[[0-9;]*m//g')

if printf '%s' "$out" | grep -q "Blocking ("; then
    ok "summary states the blocking count under its own heading"
else
    bad "no 'Blocking (N)' heading -- user cannot separate blockers from noise"
fi

# The heading alone is not enough: the blockers must be ENUMERATED. This is the
# whole point, so assert on a specific one rather than on the heading's shape.
if printf '%s' "$out" | grep -q "No AI provider CLI"; then
    ok "the provider blocker is named in the summary"
else
    bad "provider blocker not named in the summary block"
fi

# A named problem with no command is still a dead end.
if printf '%s' "$out" | grep -q "npm install -g @anthropic-ai/claude-code"; then
    ok "the summary carries the exact fix command"
else
    bad "no fix command in the summary -- names the problem, not the remedy"
fi

# The 15 optional warnings must be explicitly demoted, or the user still reads
# the screen as "lots of setup required".
if printf '%s' "$out" | grep -qi "everything else above is optional"; then
    ok "optional warnings are explicitly demoted"
else
    bad "optional warnings not demoted -- the wall of yellow still reads as required"
fi

# A blocked user must still have somewhere to go RIGHT NOW. `loki tour` needs no
# provider, no key and no network, so it is always reachable.
if printf '%s' "$out" | grep -q "loki tour"; then
    ok "blocked user is pointed at a path that works with no provider"
else
    bad "blocked user has no working next step (dead end)"
fi

# Doctor must still FAIL. Naming blockers nicely while returning 0 would be a
# false green -- the exact thing this codebase exists to prevent.
HOME="$WORK" PATH="/usr/bin:/bin:/usr/sbin:/sbin" bash "$LOKI" doctor >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
    ok "doctor still exits non-zero when blocked (rc=$rc)"
else
    bad "doctor exited 0 despite blockers -- false green"
fi

echo
echo "T2 -- the blocker section is CONDITIONAL, not unconditional"

# Non-vacuity in the other direction: the section must not fire when there is
# nothing to report, or it becomes noise on every healthy run.
#
# ASSERT THE CONDITION, NOT THE HOST. The first version of this ran doctor on
# the test machine and required no blocker section -- which assumed the host is
# healthy. A GitHub runner has no provider CLI and no Node, so it legitimately
# HAS blockers, and the test failed on CI while passing on a developer laptop.
# The invariant that actually matters is the coupling: section present exactly
# when fail_count > 0. Derive both from the same run so the assertion holds on
# any host.
healthy=$(bash "$LOKI" doctor 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
_failed=$(printf '%s' "$healthy" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+')
[ -n "$_failed" ] || _failed=0

if [ "$_failed" -eq 0 ]; then
    if printf '%s' "$healthy" | grep -q "Blocking ("; then
        bad "blocker section printed although doctor reported 0 failures"
    else
        ok "no blocker section when doctor reports 0 failures"
    fi
else
    # This host has real blockers (a CI runner with no provider CLI, say). The
    # correct assertion here is the mirror image: the section MUST appear.
    if printf '%s' "$healthy" | grep -q "Blocking ("; then
        ok "blocker section present because this host reports $_failed failure(s)"
    else
        bad "doctor reported $_failed failure(s) but printed no blocker section"
    fi
fi

echo
echo "T3 -- machine-readable output is unaffected"

# The funnel change remains presentation-only for the JSON payload. Capture it
# before parsing because doctor now intentionally returns the readiness verdict
# as its process status too.
doctor_json="$(bash "$LOKI" doctor --json 2>/dev/null)"
if printf '%s' "$doctor_json" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    ok "doctor --json still emits valid JSON"
else
    bad "doctor --json broken by the funnel change"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
