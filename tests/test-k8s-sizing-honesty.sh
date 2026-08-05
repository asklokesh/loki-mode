#!/usr/bin/env bash
# Sizing guidance must say which numbers were MEASURED and which were not.
#
# WHY. memory.limits is a HARD cap in Kubernetes: a build that exceeds it is
# OOMKilled by the kernel mid-run. To the user that looks like the agent
# silently stopping -- no error, no receipt, nothing to search for. It is the
# same silent-failure shape this project exists to prevent, arriving via the
# platform rather than the code.
#
# So a confident-but-wrong sizing number is worse than an admitted unknown: it
# sends an operator to production on a guess dressed as a recommendation. The
# control-plane figures here ARE measured (118 MB peak import, 99 MB serving);
# the worker figures are NOT, and the values file has to keep saying so.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
V="$REPO_ROOT/deploy/helm/autonomi/values.yaml"
A="$REPO_ROOT/benchmarks/results/k8s-sizing.json"
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "T1 -- the measured half cites its measurement"
grep -q "SIZING BASIS, measured" "$V" \
  && ok "controlplane sizing states it was measured" \
  || bad "no measurement basis recorded for controlplane sizing"
grep -qE "118 MB peak RSS" "$V" \
  && ok "the actual observed figure is in the file, not just a claim of rigour" \
  || bad "no observed number recorded"

echo
echo "T2 -- the unmeasured half admits it"
# This is the assertion that matters. If someone later 'tidies' this comment
# away, the worker limits silently become an implied recommendation.
grep -q "WORKER SIZING IS NOT MEASURED" "$V" \
  && ok "worker sizing is explicitly labelled unmeasured" \
  || bad "worker limits now read as a recommendation without being measured"
grep -qi "OOMKilled" "$V" \
  && ok "names the failure mode (OOMKill) an operator will actually hit" \
  || bad "does not warn about the hard memory cap"
grep -q "kubectl top pod" "$V" \
  && ok "gives the command to close the gap" \
  || bad "admits the unknown but offers no way to resolve it"

echo
echo "T3 -- the artifact keeps the same split"
if [ -f "$A" ]; then
  python3 -c "
import json,sys
d=json.load(open('$A'))
assert d.get('measured',{}).get('controlplane_serving_rss_mb'), 'no measured serving RSS'
assert d.get('not_measured',{}).get('worker'), 'worker not flagged unmeasured'
assert d.get('how_to_close_it'), 'no path to close the gap'
" 2>/dev/null \
    && ok "artifact records measured, not-measured, and how to close it" \
    || bad "artifact lost the measured/unmeasured split"
else
  bad "benchmarks/results/k8s-sizing.json missing"
fi

echo
echo "T4 -- the chart still renders"
if command -v helm >/dev/null 2>&1; then
  helm template t "$REPO_ROOT/deploy/helm/autonomi" >/dev/null 2>&1 \
    && ok "chart renders with the added comments" \
    || bad "chart broken by the values edit"
else
  ok "helm absent; skipping render check"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
