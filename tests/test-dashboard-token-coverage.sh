#!/usr/bin/env bash
# Every design token a component consumes must actually be defined.
#
# THE DEFECT. The SHIPPED dashboard consumed 72 var(--loki-*) tokens and defined
# 56. The other 34 -- including --loki-status-success, --loki-status-error,
# --loki-text-inverse and the model-tier colours --loki-opus/sonnet/haiku --
# resolved to nothing, so every use silently fell back to the hardcoded literal
# written beside it. Those literals are LIGHT-mode values, so the elements were
# wrong in dark mode and no theme switch could fix them.
#
# Concretely: loki-checklist-viewer.js writes
#   color: var(--loki-status-success, #22c55e)
# and dark mode defines --loki-success: #2ED8B6. Because --loki-status-success
# was never declared, a checklist pass rendered #22c55e -- a light-mode green on
# a dark background. Verified in the browser after the fix:
# getComputedStyle now returns #2ED8B6 for both.
#
# THE TEST ASSERTS AGAINST THE SHIPPED ARTIFACT, not the sources. That is the
# point: dashboard/static/index.html is what `loki web` serves, and a token can
# be defined in a source file that the build never inlines. Checking sources
# would have passed while the shipped page stayed broken -- the same
# packaged-artifact blind spot that let dist embed the wrong version for 27
# releases.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHIPPED="$REPO_ROOT/dashboard/static/index.html"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: every consumed dashboard token is defined"

[ -f "$SHIPPED" ] || { echo "  FAIL: $SHIPPED missing"; exit 1; }

_report="$(python3 - "$SHIPPED" <<'PY'
import re, sys
s = open(sys.argv[1], encoding="utf-8", errors="ignore").read()
used = set(re.findall(r"var\((--loki-[a-z0-9-]+)", s))
defined = set(re.findall(r"(--loki-[a-z0-9-]+)\s*:", s))
missing = sorted(used - defined)
print(len(used), len(defined), len(missing))
for t in missing:
    print(t)
PY
)"
_used="$(printf '%s' "$_report" | head -1 | cut -d' ' -f1)"
_def="$(printf '%s' "$_report" | head -1 | cut -d' ' -f2)"
_missing_n="$(printf '%s' "$_report" | head -1 | cut -d' ' -f3)"

# --- 1. THE DEFECT: no consumed token may be undefined -----------------------
if [ "${_missing_n:-1}" -eq 0 ]; then
    ok "all $_used consumed tokens are defined ($_def declared)"
else
    bad "$_missing_n of $_used consumed tokens are UNDEFINED -- each falls back to a light-mode literal:"
    printf '%s\n' "$_report" | tail -n +2 | head -8 | sed 's/^/         /'
fi

# --- 2. NON-VACUITY: the extraction must actually find tokens ---------------
# A regex that matched nothing would report "0 undefined" and pass forever.
if [ "${_used:-0}" -gt 20 ] && [ "${_def:-0}" -gt 20 ]; then
    ok "extraction is non-vacuous ($_used consumed, $_def defined)"
else
    bad "extraction found almost nothing (consumed=$_used defined=$_def) -- the assertion above proves nothing"
fi

# --- 3. Status tokens resolve per-theme, not to a frozen literal ------------
# The specific regression: a status colour must be declared in BOTH the light
# and dark blocks (directly or via an alias), or it cannot follow the theme.
for tok in "--loki-status-success" "--loki-status-error" "--loki-status-warning"; do
    n="$(grep -ao -- "$tok:" "$SHIPPED" | wc -l | tr -d ' ')"
    if [ "${n:-0}" -ge 2 ]; then
        ok "$tok is declared in multiple theme blocks ($n)"
    else
        bad "$tok declared $n time(s) -- it cannot differ between light and dark"
    fi
done

# --- 4. The shipped page still renders its own navigation -------------------
# Guard against a build that "succeeds" and emits the wrong artifact. I did
# exactly that once here: running build-standalone alone (instead of build:all)
# produced a file that overwrote the real dashboard. Nav text is the cheapest
# proof the right bundle landed.
_nav_ok=1
for label in "Spec Checklist" "Trust" "Quality" "App Runner"; do
    grep -aq "$label" "$SHIPPED" || { _nav_ok=0; bad "shipped dashboard is missing nav item '$label' -- wrong artifact built"; }
done
[ "$_nav_ok" = "1" ] && ok "the shipped bundle still contains its navigation"

# --- 5. Size sanity ---------------------------------------------------------
# The standalone bundle is a single inlined file; a few KB means the build
# emitted a shell instead of the app.
_sz="$(wc -c < "$SHIPPED" | tr -d ' ')"
if [ "${_sz:-0}" -gt 400000 ]; then
    ok "shipped bundle is a full build (${_sz} bytes)"
else
    bad "shipped bundle is only ${_sz} bytes -- likely a shell, not the app"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
