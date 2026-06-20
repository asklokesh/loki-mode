#!/usr/bin/env bash
# Test: Dashboard Navigation UAT (v7.5.15)
#
# Closes UAT gaps from v7.5.12 dashboard testing:
#   1. loki web vs loki dashboard confusion (clarify in --help)
#   3. Escalations feature has no sidebar entry (add nav item + stub)
#
# Gap #2 (parent-shell exit dependency) is NOT covered here -- it requires
# deeper investigation than the v7.5.15 scope.
#
# Run: bash tests/test-dashboard-nav-uat.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
ESC_COMPONENT="$REPO_ROOT/dashboard-ui/components/loki-escalations.js"
BUILD_SCRIPT="$REPO_ROOT/dashboard-ui/scripts/build-standalone.js"
BUILT_HTML="$REPO_ROOT/dashboard/static/index.html"

PASS=0
FAIL=0
TOTAL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

assert() {
    local desc="$1"
    local result="$2"
    TOTAL=$((TOTAL + 1))
    if [ "$result" = "0" ]; then
        printf "${GREEN}PASS${NC} %s\n" "$desc"
        PASS=$((PASS + 1))
    else
        printf "${RED}FAIL${NC} %s\n" "$desc"
        FAIL=$((FAIL + 1))
    fi
}

run_help() {
    local cmd="$1"
    bash "$LOKI" "$cmd" --help 2>&1 || true
}

# ---------------------------------------------------------------------------
# Item 1: web vs dashboard help clarification
# ---------------------------------------------------------------------------

DASHBOARD_HELP="$(run_help dashboard)"
WEB_HELP="$(run_help web)"

# Both --help outputs must mention the OTHER command (so users see the relationship)
echo "$DASHBOARD_HELP" | grep -q "loki web"
assert "loki dashboard --help mentions 'loki web'" "$?"

echo "$WEB_HELP" | grep -q "loki dashboard"
assert "loki web --help mentions 'loki dashboard'" "$?"

# dashboard --help must still distinguish itself from the (deprecated) web UI.
echo "$DASHBOARD_HELP" | grep -qiE "not the same|different from|alias for|use loki web"
assert "loki dashboard --help clarifies the difference from loki web" "$?"

# web --help must resolve the confusion at the source: as of F55 (v7.88.1) the
# deprecated `loki web` now LAUNCHES the dashboard, so its help must make clear it
# is deprecated and points to / launches loki dashboard (the confusion is gone
# because they are no longer two separate UIs). Accept either the old "difference"
# wording or the new "deprecated / now launches the dashboard" wording.
echo "$WEB_HELP" | grep -qiE "not the same|different from|alias for|use loki dashboard|deprecated|launch(es)? the dashboard|canonical command is .?loki dashboard"
assert "loki web --help clarifies its relationship to loki dashboard" "$?"

# ---------------------------------------------------------------------------
# Item 3: Escalations nav + component
# ---------------------------------------------------------------------------

# New component file must exist
[ -f "$ESC_COMPONENT" ]
assert "loki-escalations.js component file exists" "$?"

# Component file must define a custom element and export a class
grep -q "class LokiEscalations" "$ESC_COMPONENT"
assert "loki-escalations.js exports LokiEscalations class" "$?"

grep -q "customElements.define('loki-escalations'" "$ESC_COMPONENT"
assert "loki-escalations.js registers the loki-escalations custom element" "$?"

# The build script must include the new nav button + section page
grep -q 'data-section="escalations"' "$BUILD_SCRIPT"
assert "build-standalone.js has escalations sidebar nav button" "$?"

grep -q 'id="page-escalations"' "$BUILD_SCRIPT"
assert "build-standalone.js has page-escalations section" "$?"

grep -q "<loki-escalations" "$BUILD_SCRIPT"
assert "build-standalone.js renders loki-escalations component" "$?"

# Built HTML must include all three (proves the build was run after the edit)
if [ -f "$BUILT_HTML" ]; then
    grep -q 'id="nav-escalations"' "$BUILT_HTML"
    assert "dashboard/static/index.html includes nav-escalations button (built)" "$?"

    grep -q 'id="page-escalations"' "$BUILT_HTML"
    assert "dashboard/static/index.html includes page-escalations section (built)" "$?"
else
    echo "  (skip) dashboard/static/index.html not present; run dashboard-ui build to generate"
fi

# Node syntax check on the new component (best-effort: catches obvious parse errors)
if command -v node >/dev/null 2>&1; then
    node --check "$ESC_COMPONENT" >/dev/null 2>&1
    assert "node --check on loki-escalations.js" "$?"
else
    echo "  (skip) node not available; cannot syntax-check loki-escalations.js"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "Total:  $TOTAL"
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [ "$FAIL" -eq 0 ]; then
    exit 0
else
    exit 1
fi
