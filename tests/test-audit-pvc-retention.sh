#!/usr/bin/env bash
# The audit trail must be able to outlive the release.
#
# THE FINDING. deploy/helm/autonomi/templates/pvc-audit.yaml had NO annotations
# block at all, so `helm uninstall` deleted the audit-logs PVC and the audit
# trail with it. For most volumes that is correct behaviour. For an AUDIT LOG in
# an enterprise it is a compliance problem, and the operator discovers it only
# after the data is gone -- there is no undo.
#
# The fix is OPT-IN, not a changed default. Flipping the default to "keep" would
# start leaving orphaned PVCs and their storage cost behind for every existing
# user who uninstalls, which is a surprise in the other direction. So the test
# asserts BOTH states: silent by default, retained when asked.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHART="$REPO_ROOT/deploy/helm/autonomi"
PASS=0; FAIL=0; SKIP=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
note() { echo "  [SKIP] $1"; SKIP=$((SKIP+1)); }

if ! command -v helm >/dev/null 2>&1; then
  note "helm not installed"; echo "Results: 0 passed, 0 failed, 1 skipped"; exit 0
fi

echo "T1 -- default behaviour is unchanged"
D=$(helm template t "$CHART" 2>/dev/null)
printf '%s' "$D" | grep -q "audit-logs" \
  && ok "audit PVC renders by default" \
  || bad "audit PVC missing from the default render"
if printf '%s' "$D" | grep -q "helm.sh/resource-policy: keep"; then
  bad "keep annotation present by default -- would orphan PVCs for every existing user"
else
  ok "no keep annotation by default (prior behaviour preserved)"
fi

echo
echo "T2 -- the retain flag actually retains"
R=$(helm template t "$CHART" --set persistence.auditLogs.retainOnUninstall=true 2>/dev/null)
printf '%s' "$R" | grep -q "helm.sh/resource-policy: keep" \
  && ok "retainOnUninstall=true emits helm.sh/resource-policy: keep" \
  || bad "retainOnUninstall=true did NOT emit the keep annotation -- the flag is inert"

# Non-vacuity: the annotation must be on the AUDIT pvc, not somewhere harmless.
# Extract the PVC document that CONTAINS the annotation and confirm it is the
# audit one. A fixed -B window is wrong here: the template carries a comment
# block, so the name line sits further above than any constant would guess.
_doc=$(printf '%s' "$R" | awk '/^---/{d=""} {d=d"\n"$0} /helm.sh\/resource-policy: keep/{print d}')
printf '%s' "$_doc" | grep -q "audit-logs" \
  && ok "the annotation is on the audit-logs PVC specifically" \
  || bad "keep annotation landed on the wrong resource"

echo
echo "T3 -- the chart still lints and the runbook documents the tradeoff"
helm lint "$CHART" >/dev/null 2>&1 && ok "helm lint passes" || bad "helm lint fails"
R2="$REPO_ROOT/deploy/helm/README.md"
grep -q "retainOnUninstall" "$R2" \
  && ok "runbook documents the flag" \
  || bad "flag exists but is undocumented -- an operator will not find it"
grep -qi "rollback" "$R2" \
  && ok "runbook covers rollback" \
  || bad "no rollback guidance"
grep -qi "will not start" "$R2" \
  && ok "runbook covers a pod that will not start" \
  || bad "no troubleshooting section"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
