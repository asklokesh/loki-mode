#!/usr/bin/env bash
# v7.7.24 test: cross-project knowledge lift (the memory moat proof)
# Covers (1) the query_patterns token-overlap fix and (2) the lift bench.
set -u

PY=$(command -v python3.12 || command -v python3)
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Test 1: query_patterns retrieves on a natural-language goal (token overlap),
# which the old whole-string-substring code could not do.
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil
sys.path.insert(0, '.')
from memory.knowledge_graph import OrganizationKnowledgeGraph
tmp = tempfile.mkdtemp(prefix='loki-xproj-')
try:
    kg = OrganizationKnowledgeGraph(knowledge_dir=tmp)
    kg.save_patterns([{'name': 'idempotency-key-on-charge', 'category': 'reliability',
                       'description': 'retry-safe charge endpoints require an idempotency key'}])
    nl = kg.query_patterns('make the charge endpoint safe to retry')
    # exact-substring behavior preserved
    exact = kg.query_patterns('charge')
    print('NL_OK' if (len(nl) >= 1 and len(exact) >= 1) else f'NL_FAIL: nl={len(nl)} exact={len(exact)}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "NL_OK" ]; then ok "query_patterns retrieves on NL goal (token overlap) + keeps exact match"; else bad "query: $RESULT"; fi

# Test 2: lift bench reports POSITIVE lift sourced from siblings (exit 0).
$PY tools/bench_cross_project_lift.py >/dev/null 2>&1
LIFT_CODE=$?
if [ "$LIFT_CODE" = "0" ]; then ok "lift bench reports positive cross-project lift (exit 0)"; else bad "lift bench exit=$LIFT_CODE (no lift detected)"; fi

# Test 3: lift JSON has baseline < cross and net-new from siblings > 0.
# stderr must NOT be folded into stdout here: this pipes straight into
# json.loads, so a single warning line (a deprecation notice, a logging handler,
# anything the runner's python emits that a local one does not) prepends
# non-JSON text and the parse dies with
#   LIFT_PARSE_FAIL: Expecting value: line 1 column 1 (char 0)
# -- which is exactly what CI reported while Test 2, which discards output
# entirely, passed on the same runner. Reproduced verbatim by injecting one
# stderr line locally. Keep stderr separate; the exit code is checked by Test 2.
RESULT=$($PY tools/bench_cross_project_lift.py --json 2>/dev/null | $PY -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    ok = (d['cross_covered'] > d['baseline_covered']
          and d['net_new_from_siblings'] > 0
          and d['lift_absolute'] > 0
          and 'NOT task-success' in d['method'])
    print('LIFT_OK' if ok else f'LIFT_FAIL: {d}')
except Exception as e:
    print(f'LIFT_PARSE_FAIL: {e}')")
if [ "$RESULT" = "LIFT_OK" ]; then ok "lift JSON: cross>baseline, net-new>0, honest method label"; else bad "lift json: $RESULT"; fi

# Test 4 (honesty): the bench must label its method as coverage NOT
# task-success, so the moat proof never overclaims.
if grep -q "NOT a task-success\|NOT task-success\|NOT a task success" tools/bench_cross_project_lift.py \
   && grep -q "does NOT claim" tools/bench_cross_project_lift.py; then
    ok "bench docstring honestly scopes the claim (coverage, not task-success)"
else
    bad "bench docstring missing honest scope disclaimer"
fi

# Cleanup
bash -c 'for d in /tmp/loki-xproj-* /tmp/loki-xproj-lift-*; do rm -rf "$d" 2>/dev/null; done'

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
