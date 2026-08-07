#!/usr/bin/env bash
# A dependency must not decide the complexity tier.
#
# THE DEFECT. detect_complexity's has_external grep (autonomy/run.sh) pruned
# NOTHING, while the find eleven lines above it prunes node_modules, .git,
# vendor, dist, build and __pycache__. Same function, same intent, inconsistent
# implementation. With --include "*.json" that meant ANY transitive dependency
# whose package.json mentions azure, stripe or aws-sdk set has_external=true.
#
# WHY IT MATTERED SO MUCH. has_external does not merely block "simple" -- in the
# final classifier it jumps straight to "complex", skipping "standard". So a
# one-liner in any repo that had ever run npm install landed on the MOST
# expensive tier, which runs the architecture doc suite (up to 300s of silence
# per attempt) and holds the council's forced minimum-iteration floor at 3
# instead of 1. A prior incident matches exactly: a coffee landing page took
# 1h34m over 11 iterations because the simple fast-path never engaged. The fast
# path was correctly built and correctly wired the entire time; this one missing
# prune made it unreachable.
#
# TEST 2 IS THE ONE THAT MATTERS. A prune is only correct if it still detects a
# REAL integration. Excluding too much would trade a slow-but-safe
# misclassification for a fast-and-wrong one, which is worse. Both directions are
# asserted, and a fix that passes only test 1 must fail this suite.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: a dependency does not decide the complexity tier"

[ -f "$RUN_SH" ] || { echo "  FAIL: $RUN_SH missing"; exit 1; }

# Run the REAL predicate, extracted from run.sh, so this test cannot drift from
# the implementation the way a hand-copied pattern would.
# Joins the continued lines, drops the leading `if` and the trailing `; then`,
# and points it at the fixture dir. Without stripping those, eval sees a
# malformed `if` with embedded backslash-newlines and the predicate always
# returns false -- which looks exactly like "the prune excludes too much" and
# sent me chasing a fix for a bug that was in this extraction, not in run.sh.
_extract_grep() {
    sed -n '/# Check for external integrations/,/^    fi$/p' "$RUN_SH" \
        | sed -n '/grep -rq/,/2>\/dev\/null; then/p' \
        | tr '\n' ' ' \
        | sed 's/\\ / /g' \
        | sed 's/"\$target_dir"/./' \
        | sed 's/^[[:space:]]*if[[:space:]]*//' \
        | sed 's/;[[:space:]]*then[[:space:]]*$//'
}
_GREP="$(_extract_grep)"

if [ -z "$_GREP" ]; then
    echo "  FAIL: could not extract the has_external grep from run.sh"
    exit 1
fi

_has_external() { ( cd "$1" && eval "$_GREP" >/dev/null 2>&1 ); }

# --- 1. A dependency-only mention must NOT set has_external ------------------
T="$(mktemp -d)"
mkdir -p "$T/node_modules/some-dep"
printf '{"dependencies":{"@azure/core":"1.0.0"}}\n' > "$T/node_modules/some-dep/package.json"
printf '{"name":"tiny"}\n' > "$T/package.json"
printf 'console.log(1)\n' > "$T/app.js"
if _has_external "$T"; then
    bad "a dependency naming azure forced the tier (the 1h34m defect is back)"
else
    ok "a dependency-only mention does not force the expensive tier"
fi

# --- 2. THE GUARD AGAINST OVER-CORRECTING: real integrations still detected --
printf 'import Stripe from "stripe"\nexport const s = new Stripe(process.env.KEY)\n' > "$T/pay.ts"
if _has_external "$T"; then
    ok "a REAL integration in the project's own source is still detected"
else
    bad "a real stripe import was missed -- the prune excludes too much, which is worse than the original bug"
fi
rm -rf "$T"

# --- 2b. THE MANIFEST BOUNDARY, asserted rather than accidental --------------
# Test 1 puts the mention inside node_modules, so it says nothing about a
# dependency declared in the project's OWN package.json. That case was
# undocumented in either direction, and it is the one most likely to be
# "fixed" by mistake later.
#
# It must stay TRUE, deliberately: declaring the Azure SDK in your own
# dependencies IS evidence of an integration, and the whole point of test 2 is
# that suppressing real signal is worse than the original bug. Recorded here so
# the next person reads it as intent and not as an oversight.
T="$(mktemp -d)"
printf '{"name":"app","dependencies":{"@azure/core":"^1.0.0"}}\n' > "$T/package.json"
printf 'export default function Page(){return "hi"}\n' > "$T/page.jsx"
if _has_external "$T"; then
    ok "a dependency declared in the project's OWN manifest still counts (intended)"
else
    bad "a declared SDK dependency no longer counts -- real signal was suppressed"
fi
rm -rf "$T"

# A plain project with no integration must NOT trip, manifest included. This is
# the coffee-landing-page shape: verified against a real `npm i next react
# react-dom` tree, whose lockfile contains none of the terms.
T="$(mktemp -d)"
printf '{"name":"landing","dependencies":{"next":"^16.0.0","react":"^19.0.0"}}\n' > "$T/package.json"
printf 'export default function Page(){return "coffee"}\n' > "$T/page.jsx"
if _has_external "$T"; then
    bad "a plain landing page trips the external check -- it lands on the expensive tier"
else
    ok "a plain landing page with ordinary deps stays eligible for the fast path"
fi
rm -rf "$T"

# --- 3. Each excluded directory is genuinely inert ---------------------------
# Checked individually rather than as a set: a single wrong --exclude-dir would
# otherwise hide behind the others passing.
for d in node_modules vendor dist build .venv; do
    T="$(mktemp -d)"
    mkdir -p "$T/$d/pkg"
    printf '{"x":"aws-sdk"}\n' > "$T/$d/pkg/package.json"
    printf 'console.log(1)\n' > "$T/app.js"
    if _has_external "$T"; then
        bad "a hit inside $d/ still forces the tier"
    else
        ok "$d/ is excluded"
    fi
    rm -rf "$T"
done

# --- 4. The source of truth is run.sh, not this test -------------------------
# If someone removes the excludes from run.sh, extraction must surface it here
# rather than this file quietly testing its own copy of the pattern.
if printf '%s' "$_GREP" | grep -q "exclude-dir=node_modules"; then
    ok "the extracted predicate carries the excludes (test reads run.sh, not a copy)"
else
    bad "run.sh's has_external grep no longer excludes node_modules"
fi

# --- 5. The sibling find and this grep agree on what to ignore ---------------
# The original defect was precisely that these two disagreed.
_find_block="$(sed -n '/file_count=\$(find/,/wc -l/p' "$RUN_SH")"
_missing=""
for d in node_modules vendor dist build; do
    printf '%s' "$_find_block" | grep -q "$d" || continue
    printf '%s' "$_GREP" | grep -q "exclude-dir=$d" || _missing="$_missing $d"
done
if [ -z "$_missing" ]; then
    ok "the grep ignores everything the sibling find ignores"
else
    bad "grep and find disagree on:$_missing (the original defect)"
fi

# --- 6. Syntax --------------------------------------------------------------
if bash -n "$RUN_SH" 2>/dev/null; then
    ok "run.sh parses"
else
    bad "run.sh has a syntax error"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
