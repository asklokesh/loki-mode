#!/usr/bin/env bash
#===============================================================================
# Loki Mode - onboard JSON/YAML output quote-injection regression (WAVE10)
#
# cmd_onboard (loki onboard --format json|yaml) built its structured output
# with a `cat <<ENDJSON` / `cat <<ENDYAML` bash heredoc that raw-interpolated
# the package.json-derived project name and version (and the target path /
# build/run/test commands) directly between quotes:
#
#     "name": "$project_name",
#     "version": "$project_version",
#
# A package.json whose name or version contained a double quote produced
# malformed JSON / YAML: the heredoc cannot escape the embedded quote, so the
# emitted document failed to parse. Only the `description` field was already
# protected (via json.dumps). The path field had the same exposure.
#
# The fix wraps each string field through json.dumps (env-passed via
# os.environ to avoid a second interpolation layer), so any embedded quote,
# backslash, or apostrophe is escaped and the document always parses.
#
# These tests feed a package.json with quotes/apostrophes in name+version
# and assert the emitted JSON and YAML both parse and round-trip verbatim.
#===============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
TOTAL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$SCRIPT_DIR/autonomy/loki"

WORK_DIR=$(mktemp -d /tmp/loki-test-onboard-XXXXXX)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

export NO_COLOR=1
export LOKI_NO_TELEMETRY=1

log_test() { TOTAL=$((TOTAL+1)); echo -e "${BOLD}[$TOTAL] $1${NC}"; }
log_pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}PASS${NC}: $1"; }
log_fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}FAIL${NC}: $1"; }

# A package.json with double quotes in name+version and an apostrophe + quote
# in the description. These are the values that flow into the output document.
TARGET="$WORK_DIR/proj"
mkdir -p "$TARGET"
cat > "$TARGET/package.json" <<'PKG'
{
  "name": "my\"quoted\" app",
  "version": "1.0.0-\"beta\"",
  "description": "O'Brien said \"hello\""
}
PKG

EXPECT_NAME='my"quoted" app'
EXPECT_VERSION='1.0.0-"beta"'

#-------------------------------------------------------------------------------
# 1. JSON output must parse and round-trip name+version verbatim.
#-------------------------------------------------------------------------------
log_test "onboard --format json emits valid JSON with quoted name/version"
"$LOKI" onboard "$TARGET" --format json --stdout > "$WORK_DIR/out.json" 2>/dev/null
if EXPECT_NAME="$EXPECT_NAME" EXPECT_VERSION="$EXPECT_VERSION" python3 - "$WORK_DIR/out.json" <<'PY'
import json, os, sys
doc = json.load(open(sys.argv[1]))
proj = doc["project"]
assert proj["name"] == os.environ["EXPECT_NAME"], "name mismatch: " + repr(proj["name"])
assert proj["version"] == os.environ["EXPECT_VERSION"], "version mismatch: " + repr(proj["version"])
PY
then
    log_pass "JSON parses and name+version round-trip verbatim"
else
    log_fail "JSON malformed or values not round-tripped"
fi

#-------------------------------------------------------------------------------
# 2. YAML output must parse and round-trip name+version verbatim.
#    (Skipped only if PyYAML is unavailable; never counted as a pass/fail then.)
#-------------------------------------------------------------------------------
if python3 -c "import yaml" 2>/dev/null; then
    log_test "onboard --format yaml emits valid YAML with quoted name/version"
    "$LOKI" onboard "$TARGET" --format yaml --stdout > "$WORK_DIR/out.yaml" 2>/dev/null
    if EXPECT_NAME="$EXPECT_NAME" EXPECT_VERSION="$EXPECT_VERSION" python3 - "$WORK_DIR/out.yaml" <<'PY'
import yaml, os, sys
doc = yaml.safe_load(open(sys.argv[1]))
proj = doc["project"]
assert proj["name"] == os.environ["EXPECT_NAME"], "name mismatch: " + repr(proj["name"])
assert proj["version"] == os.environ["EXPECT_VERSION"], "version mismatch: " + repr(proj["version"])
PY
    then
        log_pass "YAML parses and name+version round-trip verbatim"
    else
        log_fail "YAML malformed or values not round-tripped"
    fi
else
    echo -e "${BOLD}[skip] PyYAML not installed; YAML round-trip check skipped${NC}"
fi

#-------------------------------------------------------------------------------
# Summary
#-------------------------------------------------------------------------------
echo ""
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total${NC}"
[ "$FAIL" -eq 0 ]
