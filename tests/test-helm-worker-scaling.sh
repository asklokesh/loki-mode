#!/usr/bin/env bash
# The worker scaling knob works, and the tenancy invariant it depends on holds.
#
# WHY THIS EXISTS. values.yaml calls worker.replicaCount "THE scaling knob" and
# states that raising parallelism means adding replicas, not raising concurrency
# inside a pod. Both were documented and neither was asserted, so a template
# refactor could silently pin replicas to a constant and every render would
# still lint clean.
#
# TEST 3 IS THE LOAD-BEARING ONE and it is about isolation, not performance.
# The reference consumer pulls ONE item and runs it to completion, so a worker
# serves one build at a time. If concurrency ever rises above 1, a second
# submitter's build starts on a filesystem the first one wrote -- source,
# credentials in a .env, and build output all cross the boundary. That is why
# self-hosted-runner guidance is one user per runner. A perf tweak that raises
# in-pod concurrency would look harmless and would break tenancy.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHART="$REPO_ROOT/helm/loki-mode"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: worker scaling knob and the tenancy invariant"

[ -d "$CHART" ] || { echo "  FAIL: $CHART missing"; exit 1; }
command -v helm >/dev/null 2>&1 || { echo "  SKIPPED: helm not installed (not a pass)"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "  SKIPPED: python3 not installed (not a pass)"; exit 0; }
# PyYAML is NOT stdlib. Without it every parse below raises, the 2>/dev/null
# swallows the traceback, and each assertion compares against an empty string --
# reporting "the scaling knob is not wired" about a chart that is perfectly
# fine. That is a false accusation from a missing dependency, the same class of
# defect this session shipped fixes for, and it is exactly how this test failed
# in CI while passing locally. Skip loudly instead.
python3 -c 'import yaml' >/dev/null 2>&1 \
  || { echo "  SKIPPED: python3 has no PyYAML, cannot parse rendered manifests (not a pass)"; exit 0; }

# Fail LOUDLY if the chart cannot render at all. Without this the empty-string
# comparisons below would blame the scaling knob for a chart-wide failure.
if ! helm template "$CHART" >/dev/null 2>&1; then
    bad "helm template failed for $CHART -- every assertion below would be vacuous"
    echo ""
    echo "  Passed: $PASS   Failed: $FAIL"
    exit 1
fi

# Reads one field out of the rendered worker Deployment. Parses YAML rather than
# grepping: a grep for `replicas:` would also match the receiver and redis, and
# would have reported a false pass while the worker stayed pinned.
_worker_field() {
    helm template "$CHART" "${@:2}" 2>/dev/null | python3 -c "
import yaml, sys
want = sys.argv[1]
for d in yaml.safe_load_all(sys.stdin):
    if not d or d.get('kind') != 'Deployment':
        continue
    if 'worker' not in d.get('metadata', {}).get('name', ''):
        continue
    if want == 'replicas':
        print(d['spec'].get('replicas', ''))
    elif want == 'concurrency':
        for c in d['spec']['template']['spec'].get('containers', []):
            for e in (c.get('env') or []):
                if 'CONCURRENCY' in (e.get('name') or '').upper():
                    print(e.get('value', ''))
    sys.exit(0)
" "$1" 2>/dev/null
}

# --- 1. The knob actually moves ---------------------------------------------
_d="$(_worker_field replicas)"
if [ "$_d" = "2" ]; then
    ok "default worker replicaCount is 2 (availability across a node drain)"
else
    bad "default worker replicas is '$_d', expected 2"
fi

_s="$(_worker_field replicas --set worker.replicaCount=5)"
if [ "$_s" = "5" ]; then
    ok "worker.replicaCount=5 renders 5 replicas (the knob is wired)"
else
    bad "worker.replicaCount=5 rendered '$_s' -- the scaling knob is not wired"
fi

# A single replica must be reachable: it is the correct setting for a
# single-tenant install, and pinning a floor of 2 would silently override it.
_one="$(_worker_field replicas --set worker.replicaCount=1)"
if [ "$_one" = "1" ]; then
    ok "worker.replicaCount=1 renders 1 (no hidden floor)"
else
    bad "worker.replicaCount=1 rendered '$_one'"
fi

# --- 2. Scaling the worker does NOT scale the receiver ----------------------
# They are independent Deployments. A chart that tied them together would make
# every added build slot also add an HTTP listener, which is not the intent.
_recv="$(helm template "$CHART" --set worker.replicaCount=9 2>/dev/null | python3 -c "
import yaml, sys
for d in yaml.safe_load_all(sys.stdin):
    if d and d.get('kind') == 'Deployment' and 'receiver' in d['metadata']['name']:
        print(d['spec'].get('replicas', '')); break
" 2>/dev/null)"
if [ "$_recv" = "2" ]; then
    ok "scaling workers leaves the receiver at its own replicaCount"
else
    bad "receiver replicas moved to '$_recv' when only workers were scaled"
fi

# --- 3. THE TENANCY INVARIANT: one build per pod ---------------------------
# Asserted on the RENDERED env, not on values.yaml, because a template that
# ignores the value would still leave values.yaml reading 1.
_c="$(_worker_field concurrency)"
if [ -z "$_c" ] || [ "$_c" = "1" ]; then
    ok "worker concurrency renders 1 (one build per pod, one tenant per worker)"
else
    bad "worker concurrency is '$_c'. Above 1, a second submitter's build starts on a filesystem the first one wrote -- source and credentials cross the tenant boundary."
fi

# --- 4. values.yaml still WARNS that replicas alone are not isolation -------
# The chart cannot enforce cross-tenant isolation, so the honest statement has
# to survive in the docs. Matched on the property, not exact prose.
if grep -q "not mutually trusting" "$CHART/values.yaml" 2>/dev/null \
   && grep -qE "separate release per tenant" "$CHART/values.yaml" 2>/dev/null; then
    ok "values.yaml still says replicas alone do not isolate untrusting tenants"
else
    bad "the cross-tenant warning is gone from values.yaml -- an operator would read replicaCount as an isolation control"
fi

# --- 5. It still lints at a scaled size ------------------------------------
if helm lint "$CHART" --set worker.replicaCount=25 >/dev/null 2>&1; then
    ok "the chart lints at 25 workers"
else
    bad "the chart fails lint when scaled"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
