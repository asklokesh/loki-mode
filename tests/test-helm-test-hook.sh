#!/usr/bin/env bash
# The chart must ship a `helm test` hook that proves the release SERVES.
#
# WHY. `helm install` succeeding means Kubernetes accepted the manifests. It does
# NOT mean the control plane came up, bound its port, or can answer a request.
# Without a test hook an operator has no first-class way to answer "is this
# release healthy" and hand-rolls kubectl checks, so the first real verification
# usually happens during an incident.
#
# Same distinction the Evidence Receipt draws between "code was written" and "it
# does what was asked". Applied to a chart: applied is not working.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHART="$REPO_ROOT/deploy/helm/autonomi"
PASS=0; FAIL=0; SKIP=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
note() { echo "  [SKIP] $1"; SKIP=$((SKIP+1)); }

if ! command -v helm >/dev/null 2>&1; then
    note "helm not installed"
    echo "Results: 0 passed, 0 failed, 1 skipped"; exit 0
fi

echo "T1 -- a test hook ships and renders"
OUT=$(helm template t "$CHART" 2>/dev/null)
printf '%s' "$OUT" | grep -q "helm.sh/hook: test" \
  && ok "chart renders a helm.sh/hook: test resource" \
  || bad "no test hook -- 'helm test <release>' has nothing to run"

echo
echo "T2 -- the probe URL is DERIVED from values, not hardcoded"
# If the hook hardcoded /health and 57374, an operator who changes either value
# would get a test that probes the wrong endpoint and reports a false red (or
# worse, a false green against a stale path). Deriving it means the test and the
# kubelet probe can never disagree.
printf '%s' "$OUT" | grep -q 'URL="http://t-autonomi-controlplane:57374/health"' \
  && ok "default render targets the controlplane service on the readiness path" \
  || bad "default URL is not the expected service/path"

ALT=$(helm template t "$CHART" --set service.port=9999 \
        --set controlplane.probes.readiness.path=/ready 2>/dev/null)
printf '%s' "$ALT" | grep -q 'URL="http://t-autonomi-controlplane:9999/ready"' \
  && ok "URL follows service.port and probes.readiness.path overrides" \
  || bad "URL did not follow values overrides -- it is hardcoded and will drift"

echo
echo "T3 -- the hook is self-diagnosing and does not destroy its evidence"
# A failed test that deletes itself takes the logs with it, which is the whole
# reason to run a test. And an exit code with no cause costs an investigation --
# the same lesson as the supervisor 127 bug earlier.
printf '%s' "$OUT" | grep -q "hook-delete-policy: before-hook-creation,hook-succeeded" \
  && ok "a FAILED test pod is retained for its logs" \
  || bad "delete policy would remove a failed pod, destroying the diagnosis"
printf '%s' "$OUT" | grep -q "last body:" \
  && ok "failure path prints the response body, not just an exit code" \
  || bad "failure gives no cause"

# Retry, because a still-starting pod is not the same failure as a broken one.
printf '%s' "$OUT" | grep -qF 'lt 12 ' \
  && ok "retries rather than single-shot (slow start is not a false red)" \
  || bad "single-shot probe will report a false red on a slow start"

echo
echo "T4 -- the chart still lints with the hook present"
helm lint "$CHART" >/dev/null 2>&1 \
  && ok "helm lint passes" \
  || bad "helm lint fails with the test hook added"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
