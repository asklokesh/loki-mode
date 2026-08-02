#!/usr/bin/env bash
# The documented provider order must be the order the code actually uses.
#
# WHY THIS IS NOT A DOCS NITPICK. v8.76.0 was a user-blocking bug caused by
# exactly this: a SECOND list of providers that had drifted from
# auto_detect_provider(). It omitted opencode, and because that list backed the
# pre-flight gate, an opencode-only machine was told it had no AI provider CLI
# and could not start a build at all.
#
# skills/providers.md was the same drift in the docs. It listed four providers,
# never mentioned opencode, and presented LOKI_PROVIDER as something you must
# set -- describing the world as it was before v8.64.0 wired auto-detection.
# A user reading it would conclude their working machine was unsupported.
#
# Docs are a surface like any other. This pins the documented order to the
# authority, so the doc cannot quietly describe a different product.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOADER="$REPO_ROOT/providers/loader.sh"
DOC="$REPO_ROOT/skills/providers.md"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: the provider docs match the provider code"

# --- the authority -----------------------------------------------------------
_auto="$(sed -n '/^auto_detect_provider()/,/^}/p' "$LOADER" \
         | sed -n 's/.*for p in \(.*\); do.*/\1/p' | head -1)"
if [ -z "$_auto" ]; then
    bad "could not read the order from auto_detect_provider; test is inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
ok "read the authoritative order from providers/loader.sh"

# --- every provider the code knows must appear in the doc --------------------
# Asserted INDIVIDUALLY, never as a count: a count cannot say WHICH provider is
# undocumented, and this repo has paid for exactly that shortcut before.
for _p in $_auto; do
    if grep -q -- "$_p" "$DOC"; then
        ok "the doc mentions $_p"
    else
        bad "the doc never mentions $_p, so a $_p user reads that they are unsupported"
    fi
done

# --- the documented PRIORITY ORDER must match ---------------------------------
# Order is not cosmetic: it decides which provider actually runs when several
# are installed. A doc naming a different first choice sends the user to the
# wrong place when a run does not behave as they expect.
_doc_order="$(grep -oE '^claude > [a-z> ]+$' "$DOC" | head -1 | tr -d ' ')"
_auto_arrow="$(printf '%s' "$_auto" | tr ' ' '\n' | paste -sd'>' -)"
if [ -z "$_doc_order" ]; then
    bad "the doc states no priority order, so auto-detection is unexplained"
elif [ "$_doc_order" = "$_auto_arrow" ]; then
    ok "the documented priority order matches the code exactly"
else
    bad "order drift -- doc=[$_doc_order] code=[$_auto_arrow]"
fi

# --- it must not still say a provider is REQUIRED -----------------------------
# The pre-v8.64.0 world. A doc that says you must pick one hides the feature
# whose whole point is that you do not.
if grep -qiE 'auto-detect|auto_detect|automatically' "$DOC"; then
    ok "the doc explains that a provider is auto-detected"
else
    bad "the doc never mentions auto-detection, describing the pre-v8.64.0 product"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
