#!/usr/bin/env bash
# A rolling upgrade must not kill a build mid-flight.
#
# THE DEFECT. autonomy/queue-consumer.sh traps TERM and deliberately lets the
# CURRENT BUILD FINISH before exiting. Its own comment promises "no item is left
# half-processed by our own shutdown".
#
# Kubernetes' default terminationGracePeriodSeconds is 30. A build takes
# minutes. The chart set no grace period at all, so that guarantee was VOID in
# practice: on any rolling upgrade, node drain or scale-down the pod was
# SIGKILLed 30 seconds after TERM, mid-build. The user gets a half-written
# workspace and no receipt, and nothing reports an error -- the silent-failure
# shape this project exists to prevent.
#
# The engine being correct is not enough when the platform contradicts it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHART="$REPO_ROOT/deploy/helm/autonomi"
PASS=0; FAIL=0; SKIP=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
note() { echo "  [SKIP] $1"; SKIP=$((SKIP+1)); }

echo "T1 -- the consumer really does defer shutdown (the premise)"
# If this ever stops being true the grace period is pointless, so assert the
# premise rather than assuming it.
QC="$REPO_ROOT/autonomy/queue-consumer.sh"
if [ -f "$QC" ]; then
  grep -q "trap request_stop TERM INT" "$QC" \
    && ok "consumer traps TERM/INT" || bad "consumer no longer traps TERM"
  grep -qi "after the current item finishes" "$QC" \
    && ok "consumer finishes the current item before exiting" \
    || bad "consumer no longer defers shutdown -- grace period may be moot"
else
  note "queue-consumer.sh not found"
fi

if ! command -v helm >/dev/null 2>&1; then
  note "helm not installed"; echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"; exit 0
fi

echo
echo "T2 -- the chart gives the consumer time to honour it"
R=$(helm template t "$CHART" --set worker.mode=deployment 2>/dev/null)
g=$(printf '%s' "$R" | grep -E "^\s+terminationGracePeriodSeconds:" | head -1 | awk '{print $2}')
if [ -n "$g" ]; then
  ok "worker sets terminationGracePeriodSeconds ($g)"
else
  bad "no grace period -- k8s default 30s will SIGKILL a build in progress"
fi
# 30 is the k8s default and is far shorter than any real build. Anything at or
# below it means the value is present but useless.
if [ -n "$g" ] && [ "$g" -gt 300 ] 2>/dev/null; then
  ok "grace period ($g s) exceeds 5 minutes, long enough for a real build"
else
  bad "grace period ${g:-unset} is too short to finish a build"
fi

echo
echo "T3 -- operators can tune it"
o=$(helm template t "$CHART" --set worker.mode=deployment \
      --set worker.terminationGracePeriodSeconds=600 2>/dev/null \
      | grep -E "^\s+terminationGracePeriodSeconds:" | head -1 | awk '{print $2}')
[ "$o" = "600" ] && ok "override honoured (600)" \
                 || bad "override ignored, rendered '$o' -- the value is hardcoded"

echo
echo "T4 -- the chart still lints and validates"
helm lint "$CHART" >/dev/null 2>&1 && ok "helm lint passes" || bad "helm lint fails"
helm template t "$CHART" >/dev/null 2>&1 \
  && ok "defaults still render (values.schema.json accepts the new key)" \
  || bad "schema rejects the new key"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
