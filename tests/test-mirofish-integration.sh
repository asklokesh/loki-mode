#!/usr/bin/env bash
# Test: MiroFish Integration Tests
# Tests mirofish-adapter.py CLI modes, PRD extraction, report normalization,
# task generation, fixture validation, loki CLI flag integration, and
# graceful degradation.
#
# Note: Not using -e to allow collecting all test results

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ADAPTER_PATH="$PROJECT_ROOT/autonomy/mirofish-adapter.py"
PYTHON3="${PYTHON3:-python3}"
FIXTURES_DIR="$SCRIPT_DIR/fixtures/mirofish"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
# shellcheck disable=SC2034
YELLOW='\033[0;33m'
NC='\033[0m'
# shellcheck disable=SC2034
BOLD='\033[1m'

# Test counters
PASS=0
FAIL=0
TOTAL=0

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); }

# Temp directory for test output
_TEST_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/loki-mirofish-test-XXXXXX")
TMPDIR="$_TEST_TMPDIR"
trap 'rm -rf "$_TEST_TMPDIR"' EXIT

echo "========================================"
echo "MiroFish Integration Tests"
echo "========================================"
echo "Adapter:    $ADAPTER_PATH"
echo "Fixtures:   $FIXTURES_DIR"
echo "Python:     $($PYTHON3 --version 2>&1)"
echo "Temp:       $TMPDIR"
echo ""

# Verify prerequisites
if [ ! -f "$ADAPTER_PATH" ]; then
    echo -e "${RED}Error: mirofish-adapter.py not found at $ADAPTER_PATH${NC}"
    exit 1
fi
if [ ! -d "$FIXTURES_DIR" ]; then
    echo -e "${RED}Error: fixtures directory not found at $FIXTURES_DIR${NC}"
    exit 1
fi

# ============================================================
# Category 1: Syntax Validation
# ============================================================
echo "--- Category 1: Syntax Validation ---"

# 1.1 Python syntax check
output=$($PYTHON3 -c "import py_compile; py_compile.compile('$ADAPTER_PATH', doraise=True)" 2>&1) && \
    log_pass "1.1 adapter syntax: py_compile passes" || \
    log_fail "1.1 adapter syntax: py_compile fails" "$output"

# 1.2 Shebang and encoding
if head -1 "$ADAPTER_PATH" | grep -q "python3"; then
    log_pass "1.2 shebang contains python3"
else
    log_fail "1.2 shebang contains python3" "first line: $(head -1 "$ADAPTER_PATH")"
fi

# 1.3 No non-stdlib imports
non_stdlib=$(grep -E "^(import|from)" "$ADAPTER_PATH" | grep -vE "^(import (argparse|json|os|re|sys|time|tempfile|hashlib|signal|subprocess|urllib)|from (pathlib|typing|datetime|urllib))" | grep -v "^$" || true)
if [ -z "$non_stdlib" ]; then
    log_pass "1.3 no non-stdlib imports detected"
else
    log_fail "1.3 no non-stdlib imports" "found: $non_stdlib"
fi

# 1.4 No MiroFish code imported (AGPL boundary)
if grep -qE "from mirofish|import mirofish" "$ADAPTER_PATH"; then
    log_fail "1.4 AGPL boundary: no mirofish imports" "found mirofish import in adapter"
else
    log_pass "1.4 AGPL boundary: no mirofish code imported"
fi

# 1.5 Skills file exists
if [ -f "$PROJECT_ROOT/skills/mirofish-integration.md" ]; then
    log_pass "1.5 skills/mirofish-integration.md exists"
else
    log_fail "1.5 skills/mirofish-integration.md exists" "file not found"
fi

echo ""

# ============================================================
# Category 2: CLI Mode Tests
# ============================================================
echo "--- Category 2: CLI Mode Tests ---"

# 2.1 --help exits 0
if $PYTHON3 "$ADAPTER_PATH" --help >/dev/null 2>&1; then
    log_pass "2.1 --help exits 0"
else
    log_fail "2.1 --help exits 0" "exit code $?"
fi

# 2.2 --validate with valid PRD exits 0
output=$($PYTHON3 "$ADAPTER_PATH" "$FIXTURES_DIR/sample-prd.md" --validate 2>&1)
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
    log_pass "2.2 --validate with valid PRD exits 0"
else
    log_fail "2.2 --validate with valid PRD exits 0" "exit=$exit_code, output: $(echo "$output" | head -3)"
fi

# 2.3 --validate with empty file exits 1
echo "" > "$TMPDIR/empty.md"
output=$($PYTHON3 "$ADAPTER_PATH" "$TMPDIR/empty.md" --validate 2>&1)
exit_code=$?
if [ "$exit_code" -ne 0 ]; then
    log_pass "2.3 --validate with empty file exits non-zero (exit=$exit_code)"
else
    log_fail "2.3 --validate with empty file exits non-zero" "expected non-zero, got 0"
fi

# 2.4 --validate with missing file exits non-zero
output=$($PYTHON3 "$ADAPTER_PATH" "/nonexistent/prd.md" --validate 2>&1)
exit_code=$?
if [ "$exit_code" -ne 0 ]; then
    log_pass "2.4 --validate with missing file exits non-zero (exit=$exit_code)"
else
    log_fail "2.4 --validate with missing file exits non-zero" "expected non-zero, got 0"
fi

# 2.5 --json outputs valid JSON
json_output=$($PYTHON3 "$ADAPTER_PATH" "$FIXTURES_DIR/sample-prd.md" --json 2>/dev/null)
exit_code=$?
if [ "$exit_code" -eq 0 ] && echo "$json_output" | $PYTHON3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    log_pass "2.5 --json outputs valid JSON"
else
    log_fail "2.5 --json outputs valid JSON" "exit=$exit_code or invalid JSON"
fi

# 2.6 --json includes project_name
has_name=$($PYTHON3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print('yes' if d.get('project_name') else 'no')
" <<< "$json_output" 2>/dev/null)
if [ "$has_name" = "yes" ]; then
    log_pass "2.6 --json includes project_name"
else
    log_fail "2.6 --json includes project_name" "project_name missing or empty"
fi

# 2.7 --status with no state file shows informative message
status_output=$($PYTHON3 "$ADAPTER_PATH" --status --output-dir "$TMPDIR/empty-loki" 2>&1)
if echo "$status_output" | grep -qi "no.*pipeline\|not.*found\|no.*state"; then
    log_pass "2.7 --status with no state file shows informative message"
else
    log_fail "2.7 --status with no state file" "output: $(echo "$status_output" | head -3)"
fi

# 2.8 --health with unreachable URL exits non-zero
output=$($PYTHON3 "$ADAPTER_PATH" --health --url "http://localhost:59999" 2>/dev/null)
exit_code=$?
if [ "$exit_code" -ne 0 ]; then
    log_pass "2.8 --health with unreachable URL exits non-zero (exit=$exit_code)"
else
    log_fail "2.8 --health with unreachable URL" "expected non-zero, got 0"
fi

echo ""

# ============================================================
# Category 3: PRD Extraction Tests
# ============================================================
echo "--- Category 3: PRD Extraction Tests ---"

# 3.1 Extracts project name from sample PRD
name_check=$($PYTHON3 -c "
import json, sys
d = json.loads(sys.stdin.read())
name = d.get('project_name', '')
# sample-prd.md has '# Developer Productivity Dashboard'
if 'Dashboard' in name or 'Developer' in name or 'Productivity' in name:
    print('yes')
else:
    print('no: ' + name)
" <<< "$json_output" 2>/dev/null)
if [ "$name_check" = "yes" ]; then
    log_pass "3.1 extracts project name from sample PRD"
else
    log_fail "3.1 extracts project name" "$name_check"
fi

# 3.2 Extracts simulation requirement (non-empty, >50 chars)
req_check=$($PYTHON3 -c "
import json, sys
d = json.loads(sys.stdin.read())
req = d.get('simulation_requirement', '')
if len(req) > 50:
    print('yes')
else:
    print('no: len=' + str(len(req)))
" <<< "$json_output" 2>/dev/null)
if [ "$req_check" = "yes" ]; then
    log_pass "3.2 extracts simulation requirement (>50 chars)"
else
    log_fail "3.2 extracts simulation requirement" "$req_check"
fi

# 3.3 Extracts target audience
aud_check=$($PYTHON3 -c "
import json, sys
d = json.loads(sys.stdin.read())
aud = d.get('target_audience', '')
if len(aud) > 10:
    print('yes')
else:
    print('no: len=' + str(len(aud)))
" <<< "$json_output" 2>/dev/null)
if [ "$aud_check" = "yes" ]; then
    log_pass "3.3 extracts target audience (>10 chars)"
else
    log_fail "3.3 extracts target audience" "$aud_check"
fi

# 3.4 Handles minimal PRD (fallback to full text)
minimal_json=$($PYTHON3 "$ADAPTER_PATH" "$FIXTURES_DIR/minimal-prd.md" --json 2>/dev/null)
min_check=$($PYTHON3 -c "
import json, sys
d = json.loads(sys.stdin.read())
req = d.get('simulation_requirement', '')
if len(req) > 10:
    print('yes')
else:
    print('no: len=' + str(len(req)))
" <<< "$minimal_json" 2>/dev/null)
if [ "$min_check" = "yes" ]; then
    log_pass "3.4 handles minimal PRD (fallback extraction)"
else
    log_fail "3.4 handles minimal PRD" "$min_check"
fi

# 3.5 Handles very large PRD (truncation)
$PYTHON3 -c "print('# Big PRD\n\n## Value Proposition\n' + 'x' * 50000)" > "$TMPDIR/large-prd.md"
output=$($PYTHON3 "$ADAPTER_PATH" "$TMPDIR/large-prd.md" --validate 2>&1)
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
    log_pass "3.5 handles very large PRD without error"
else
    log_fail "3.5 handles very large PRD" "exit=$exit_code"
fi

# 3.6 PRD summary is truncated to ~200 chars
summary_check=$($PYTHON3 -c "
import json, sys
d = json.loads(sys.stdin.read())
summary = d.get('prd_summary', '')
if len(summary) <= 250:
    print('yes')
else:
    print('no: len=' + str(len(summary)))
" <<< "$json_output" 2>/dev/null)
if [ "$summary_check" = "yes" ]; then
    log_pass "3.6 prd_summary truncated to <=250 chars"
else
    log_fail "3.6 prd_summary truncated" "$summary_check"
fi

echo ""

# ============================================================
# Category 4: Output File Structure Tests
# ============================================================
echo "--- Category 4: Output File Structure Tests ---"

# 4.1 Mock pipeline state has valid schema
schema_check=$($PYTHON3 -c "
import json
with open('$FIXTURES_DIR/mock-pipeline-state-partial.json') as f:
    d = json.load(f)
assert 'version' in d, 'missing version'
assert 'status' in d, 'missing status'
assert 'stages' in d, 'missing stages'
assert d['status'] in ('running', 'completed', 'failed', 'cancelled'), 'bad status: ' + d['status']
print('valid')
" 2>&1)
if [ "$schema_check" = "valid" ]; then
    log_pass "4.1 mock pipeline state has valid schema"
else
    log_fail "4.1 mock pipeline state schema" "$schema_check"
fi

# 4.2 Mock report has valid sections
report_check=$($PYTHON3 -c "
import json
with open('$FIXTURES_DIR/mock-report-response.json') as f:
    d = json.load(f)
assert d['success'] == True, 'success not True'
sections = d['data']['sections']
assert len(sections) > 0, 'no sections'
for s in sections:
    assert 'index' in s and 'title' in s and 'content' in s, 'bad section: ' + str(s.keys())
print('valid')
" 2>&1)
if [ "$report_check" = "valid" ]; then
    log_pass "4.2 mock report has valid sections"
else
    log_fail "4.2 mock report sections" "$report_check"
fi

# 4.3 Mock ontology response has valid structure
onto_check=$($PYTHON3 -c "
import json
with open('$FIXTURES_DIR/mock-ontology-response.json') as f:
    d = json.load(f)
assert d['data']['project_id'], 'missing project_id'
assert len(d['data']['ontology']['entity_types']) > 0, 'no entity_types'
print('valid')
" 2>&1)
if [ "$onto_check" = "valid" ]; then
    log_pass "4.3 mock ontology response has valid structure"
else
    log_fail "4.3 mock ontology structure" "$onto_check"
fi

# 4.4 normalize_report produces valid analysis
normalize_check=$($PYTHON3 -c "
import json, sys
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location('mirofish_adapter', '$ADAPTER_PATH')
mod = module_from_spec(spec)
spec.loader.exec_module(mod)
with open('$FIXTURES_DIR/mock-report-response.json') as f:
    report = json.load(f)
result = mod.normalize_report(report)
analysis = result.get('analysis', {})
assert analysis['overall_sentiment'] in ('positive', 'negative', 'mixed'), \
    'bad sentiment: ' + analysis.get('overall_sentiment', 'MISSING')
assert 0.0 <= analysis['sentiment_score'] <= 1.0, \
    'bad score: ' + str(analysis.get('sentiment_score'))
assert analysis['recommendation'] in ('proceed', 'review_concerns', 'reconsider'), \
    'bad recommendation: ' + analysis.get('recommendation', 'MISSING')
assert len(analysis.get('key_concerns', [])) > 0, 'no key concerns extracted'
print('valid')
" 2>&1)
if [ "$normalize_check" = "valid" ]; then
    log_pass "4.4 normalize_report produces valid analysis"
else
    log_fail "4.4 normalize_report" "$normalize_check"
fi

# 4.5 build_mirofish_tasks produces valid queue entries
tasks_check=$($PYTHON3 -c "
import json, sys
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location('mirofish_adapter', '$ADAPTER_PATH')
mod = module_from_spec(spec)
spec.loader.exec_module(mod)
with open('$FIXTURES_DIR/mock-report-response.json') as f:
    report = json.load(f)
tasks = mod.build_mirofish_tasks(report)
assert isinstance(tasks, list), 'not a list'
assert len(tasks) > 0, 'no tasks generated'
for t in tasks:
    assert t.get('source') == 'mirofish', 'wrong source: ' + str(t.get('source'))
    assert 'title' in t, 'missing title'
    assert 'priority' in t, 'missing priority'
print('valid: ' + str(len(tasks)) + ' tasks')
" 2>&1)
if echo "$tasks_check" | grep -q "^valid:"; then
    log_pass "4.5 build_mirofish_tasks produces valid queue entries ($tasks_check)"
else
    log_fail "4.5 build_mirofish_tasks" "$tasks_check"
fi

# 4.6 All fixture files are valid JSON
all_json_ok=true
for f in "$FIXTURES_DIR"/*.json; do
    if ! $PYTHON3 -c "import json; json.load(open('$f'))" 2>/dev/null; then
        log_fail "4.6 fixture JSON validity" "invalid JSON: $f"
        all_json_ok=false
        break
    fi
done
if [ "$all_json_ok" = true ]; then
    log_pass "4.6 all fixture JSON files are valid"
fi

echo ""

# ============================================================
# Category 5: CLI Flag Integration Tests
# ============================================================
echo "--- Category 5: CLI Flag Integration Tests ---"

# 5.1 --help shows mirofish flags
help_output=$("$PROJECT_ROOT/autonomy/loki" start --help 2>&1 || true)
if echo "$help_output" | grep -q "mirofish"; then
    log_pass "5.1 loki start --help shows mirofish flags"
else
    log_fail "5.1 loki start --help shows mirofish" "mirofish not mentioned in help output"
fi

# 5.2 --no-mirofish is a recognized flag (doesn't error as unknown)
output=$("$PROJECT_ROOT/autonomy/loki" start --no-mirofish 2>&1 || true)
if echo "$output" | grep -qi "unknown option\|unrecognized option"; then
    log_fail "5.2 --no-mirofish recognized flag" "flagged as unknown option"
else
    log_pass "5.2 --no-mirofish is a recognized flag"
fi

# 5.3 --mirofish-docker without image shows error
output=$("$PROJECT_ROOT/autonomy/loki" start --mirofish-docker 2>&1 || true)
if echo "$output" | grep -qi "requires"; then
    log_pass "5.3 --mirofish-docker without image shows requires error"
else
    log_fail "5.3 --mirofish-docker without image" "output: $(echo "$output" | head -3)"
fi

# 5.4 --mirofish-rounds without number shows error
output=$("$PROJECT_ROOT/autonomy/loki" start --mirofish-rounds 2>&1 || true)
if echo "$output" | grep -qi "requires"; then
    log_pass "5.4 --mirofish-rounds without number shows requires error"
else
    log_fail "5.4 --mirofish-rounds without number" "output: $(echo "$output" | head -3)"
fi

echo ""

# ============================================================
# Category 6: Graceful Degradation Tests
# ============================================================
echo "--- Category 6: Graceful Degradation Tests ---"

# 6.1 Adapter handles unreachable MiroFish gracefully (no Python traceback crash)
output=$($PYTHON3 "$ADAPTER_PATH" "$FIXTURES_DIR/sample-prd.md" \
    --output-dir "$TMPDIR/test-loki" --url "http://localhost:59999" 2>&1 || true)
exit_code=$?
# Should fail but not with an unhandled Python traceback
if echo "$output" | grep -q "Traceback (most recent call last)"; then
    log_fail "6.1 unreachable MiroFish handled gracefully" "got Python traceback"
else
    log_pass "6.1 unreachable MiroFish handled gracefully (no traceback)"
fi

# 6.2 check_container returns not_found for nonexistent container
docker_check=$($PYTHON3 -c "
import sys
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location('mirofish_adapter', '$ADAPTER_PATH')
mod = module_from_spec(spec)
spec.loader.exec_module(mod)
# Use a container name that definitely does not exist
original = mod.CONTAINER_NAME
mod.CONTAINER_NAME = 'loki-mirofish-nonexistent-test-xyz'
try:
    result = mod.check_container()
    assert result == 'not_found', 'Expected not_found, got ' + result
    print('handled')
finally:
    mod.CONTAINER_NAME = original
" 2>&1)
if [ "$docker_check" = "handled" ]; then
    log_pass "6.2 check_container returns not_found for nonexistent container"
else
    log_fail "6.2 check_container" "$docker_check"
fi

# 6.3 Status works when pipeline state is missing
output=$($PYTHON3 "$ADAPTER_PATH" --status --output-dir "$TMPDIR/nonexistent-dir" 2>&1)
exit_code=$?
if echo "$output" | grep -q "Traceback (most recent call last)"; then
    log_fail "6.3 status with missing state directory" "got Python traceback"
else
    log_pass "6.3 status with missing state directory handled (exit=$exit_code)"
fi

echo ""

# ============================================================
# Category 7: No Regression
# ============================================================
echo "--- Category 7: No Regression ---"

# 7.1 loki bash syntax still valid
output=$(bash -n "$PROJECT_ROOT/autonomy/loki" 2>&1) && \
    log_pass "7.1 loki bash syntax valid" || \
    log_fail "7.1 loki bash syntax" "$output"

# 7.2 run.sh bash syntax still valid
output=$(bash -n "$PROJECT_ROOT/autonomy/run.sh" 2>&1) && \
    log_pass "7.2 run.sh bash syntax valid" || \
    log_fail "7.2 run.sh bash syntax" "$output"

echo ""

# ============================================================
# Summary
# ============================================================
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (out of $TOTAL)"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
