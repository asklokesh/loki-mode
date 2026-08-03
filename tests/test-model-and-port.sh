#!/usr/bin/env bash
# Test: v7.111.0 bug fixes
#   1. #62 stale model: no "claude-opus-4-7" (non-existent) anywhere in providers/;
#      catalog current is claude-opus-4-8.
#   2. wave-3 app-runner compose legacy-fallback port parse: a port RANGE
#      (e.g. "8080-8090:8080-8090") must resolve to the FIRST published host
#      port (8080), not the LAST (8090).
#
# Each port assertion proves OLD (buggy) vs FIXED (correct) so the regression
# is demonstrated, not just asserted.

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS_DIR="$SCRIPT_DIR/../providers"
APP_RUNNER="$SCRIPT_DIR/../autonomy/app-runner.sh"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }
log_skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; }

echo "========================================"
echo "v7.111.0 Model + Port Fix Tests"
echo "========================================"
echo ""

# ===========================================
# Test 1: No stale claude-opus-4-7 anywhere in providers/
# ===========================================
log_test "no stale claude-opus-4-7 anywhere in providers/"
if [ ! -d "$PROVIDERS_DIR" ]; then
    log_skip "providers/ dir not found (deps absent)"
else
    stale=$(grep -rn "claude-opus-4-7" "$PROVIDERS_DIR" 2>/dev/null || true)
    if [ -z "$stale" ]; then
        log_pass "providers/ has no claude-opus-4-7 references"
    else
        log_fail "providers/ still references claude-opus-4-7:"
        echo "$stale"
    fi
fi

# ===========================================
# Test 2: the catalog's planning model is a current Opus, not a stale pin
# ===========================================
#
# WHY THIS NO LONGER HARDCODES A VERSION. It asserted exactly
# "claude-opus-4-8" and went red the moment the catalog was updated to
# claude-opus-5 -- failing CI because the catalog was RIGHT. A test that
# pins a model name has to be edited on every model release, and until
# someone does, it reports the correct value as a defect.
#
# The property that actually matters is that latest_planning names a
# current Opus for planning, not that it names one particular release. So
# that is what is asserted. A regression to a superseded model (4-7, 4-8)
# or to a non-planning tier still fails, which is the thing this test was
# protecting.
log_test "model_catalog.json latest_planning is a current Opus"
catalog="$PROVIDERS_DIR/model_catalog.json"
# Superseded pins. Naming them explicitly keeps the anti-regression teeth
# that a bare "contains opus" check would lose.
_STALE_PLANNING="claude-opus-4-7 claude-opus-4-8"
if [ ! -f "$catalog" ]; then
    log_skip "model_catalog.json not found (deps absent)"
elif ! command -v python3 >/dev/null 2>&1; then
    log_skip "python3 not available"
else
    latest=$(python3 -c "import json,sys; d=json.load(open('$catalog')); print(d.get('providers',{}).get('claude',{}).get('latest_planning',''))" 2>/dev/null || true)
    _stale=0
    for _s in $_STALE_PLANNING; do
        [ "$latest" = "$_s" ] && _stale=1
    done
    if [ -z "$latest" ]; then
        # Absent is not a pass. An empty read means the key moved or the
        # catalog shape changed, and every check below it would be vacuous.
        log_fail "catalog latest_planning is EMPTY -- key missing or catalog shape changed"
    elif [ "$_stale" = "1" ]; then
        log_fail "catalog latest_planning = '$latest', which is a superseded model"
    elif case "$latest" in *opus*) true ;; *) false ;; esac; then
        log_pass "catalog latest_planning = $latest (a current Opus)"
    else
        log_fail "catalog latest_planning = '$latest' -- planning should use an Opus tier"
    fi
fi

# ===========================================
# Test 3: runtime fallback echoes emit claude-opus-4-8 (not 4-7)
# Sources each provider file with catalog resolution disabled so the
# hardcoded `else`/`||` fallback echo is exercised directly.
# ===========================================
for prov in cline aider; do
    log_test "$prov.sh runtime default resolves to claude-opus-4-8 (no models.sh)"
    provfile="$PROVIDERS_DIR/$prov.sh"
    if [ ! -f "$provfile" ]; then
        log_skip "$prov.sh not found (deps absent)"
        continue
    fi
    # Isolate the _<prov>_default_from_catalog helper in a throwaway dir with
    # no models.sh, forcing the `else` branch (line 63/64) fallback echo.
    tmpd=$(mktemp -d 2>/dev/null || echo "/tmp/loki-modeltest-$$")
    mkdir -p "$tmpd"
    cp "$provfile" "$tmpd/$prov.sh"
    # Extract just the helper function definition and call it.
    result=$(cd "$tmpd" && bash -c "
        source ./$prov.sh 2>/dev/null || true
        # unset any LOKI_* overrides so the catalog helper is the source
        _${prov}_default_from_catalog 2>/dev/null
    " 2>/dev/null)
    rm -rf "$tmpd"
    # Assert against the CATALOG, not a hardcoded model name. This previously
    # required every provider to fall back to claude-opus-4-8, which
    # contradicted providers/model_catalog.json -- aider, cline and opencode
    # are declared there with open-weights defaults
    # (openrouter/deepseek/deepseek-v3.2). A test asserting that our
    # provider-agnostic CLIs default to a Claude model was encoding the bug
    # rather than catching it, and it is the same class as the stale
    # claude-opus-4-7 it was written to detect.
    expected=$(python3 -c "
import json,sys
d=json.load(open('providers/model_catalog.json'))['providers']
print(d.get('$prov',{}).get('latest_development',''))
" 2>/dev/null)
    if [ -n "$expected" ] && [ "$result" = "$expected" ]; then
        log_pass "$prov.sh no-models fallback matches the catalog ($expected)"
    elif [ "$result" = "claude-opus-4-7" ]; then
        log_fail "$prov.sh fallback echoes STALE claude-opus-4-7"
    else
        log_fail "$prov.sh fallback '$result' does not match catalog '$expected'"
    fi
done

# ===========================================
# Test 4: compose legacy-fallback port parse takes FIRST port of a range
# Proves OLD (greedy sed -> LAST port) vs FIXED (anchored sed -> FIRST port).
# ===========================================
log_test "compose port-range parse takes FIRST port (old vs fixed)"

# Old buggy pipeline (greedy '.*- *' consumes the range's internal dash).
old_parse() {
    grep -E '^\s*-\s*"?[0-9]' "$1" 2>/dev/null | head -1 \
        | sed 's/.*- *"*//;s/".*//;' \
        | awk -F: '{print $(NF-1)}' | awk -F- '{print $1}'
}
# Fixed pipeline: read the exact one-liner used in app-runner.sh so the test
# tracks the shipped code, then apply it.
fixed_line=""
if [ -f "$APP_RUNNER" ]; then
    fixed_line=$(grep -F 's/^[[:space:]]*-[[:space:]]*"?//' "$APP_RUNNER" 2>/dev/null | head -1)
fi
new_parse() {
    grep -E '^\s*-\s*"?[0-9]' "$1" 2>/dev/null | head -1 \
        | sed -E 's/^[[:space:]]*-[[:space:]]*"?//; s/".*$//' \
        | awk -F: '{print $(NF-1)}' | awk -F- '{print $1}'
}

# wave-3 repro: a compose file with a port RANGE mapping.
composed=$(mktemp -d 2>/dev/null || echo "/tmp/loki-porttest-$$")
mkdir -p "$composed"
cat > "$composed/docker-compose.yml" <<'YML'
services:
  web:
    image: nginx
    ports:
      - "8080-8090:8080-8090"
YML

if [ -z "$fixed_line" ]; then
    log_fail "app-runner.sh does not contain the anchored sed fix (regression!)"
else
    old_val=$(old_parse "$composed/docker-compose.yml")
    new_val=$(new_parse "$composed/docker-compose.yml")
    echo "  range '8080-8090:8080-8090': old=$old_val  fixed=$new_val"
    if [ "$old_val" = "8090" ] && [ "$new_val" = "8080" ]; then
        log_pass "range parse: old returns LAST (8090, buggy), fixed returns FIRST (8080)"
    else
        log_fail "range parse mismatch: expected old=8090 fixed=8080, got old=$old_val fixed=$new_val"
    fi
fi

# Non-range cases must be unchanged by the fix (no regression).
log_test "compose port parse unchanged for non-range mappings"
declare -a cases=(
    '      - "3000:3000"|3000'
    '      - "127.0.0.1:8080:80"|8080'
    '      - 5000:5000|5000'
)
noregress=1
for c in "${cases[@]}"; do
    line="${c%%|*}"; want="${c##*|}"
    printf '%s\n' "services:" "  web:" "    ports:" "$line" > "$composed/dc.yml"
    got=$(new_parse "$composed/dc.yml")
    if [ "$got" != "$want" ]; then
        log_fail "non-range case '$line' -> '$got' (expected '$want')"
        noregress=0
    fi
done
[ "$noregress" -eq 1 ] && log_pass "non-range mappings (simple/ip-bound/no-quote) all correct"
rm -rf "$composed"

# ===========================================
# Summary
# ===========================================
echo ""
echo "========================================"
echo -e "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo "========================================"

[ "$FAILED" -eq 0 ]
