#!/usr/bin/env bash
# The air-gapped k8s story must be honest about which half is air-gapped.
#
# WHY THE SPLIT MATTERS MORE THAN THE FEATURE. Verification IS air-gapped and
# proven so (tests/test-airgap-verify.sh runs it with every proxy blackholed).
# Generation is NOT: every shipped provider calls a hosted API. An enterprise
# that reads "air-gapped" and discovers egress during a security review does not
# file a bug, they end the evaluation -- and the real, defensible half of the
# claim dies with the overclaim.
#
# The second thing this guards is subtler. The shipped NetworkPolicy declares
# policyTypes: [Ingress, Egress] but its egress rule is `- {}`, which restricts
# NOTHING. An operator who installs a NetworkPolicy reasonably assumes egress is
# controlled. It is not, and the docs now say so out loud rather than letting the
# manifest imply otherwise.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
R="$REPO_ROOT/deploy/helm/README.md"
CHART="$REPO_ROOT/deploy/helm/autonomi"
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "T1 -- the scope split is stated, not buried"
grep -qi "Verification is air-gapped" "$R" \
  && ok "says verification IS air-gapped" || bad "missing the true half"
grep -qi "Generation is not" "$R" \
  && ok "says generation is NOT" || bad "missing the limitation -- this is the overclaim risk"

echo
echo "T2 -- operators are sent to the egress inventory before writing rules"
grep -q "loki doctor --airgap" "$R" \
  && ok "points at doctor --airgap for the host inventory" \
  || bad "no way to discover what actually leaves the network"

echo
echo "T3 -- the allow-all egress default is disclosed"
# A NetworkPolicy that restricts nothing while appearing to restrict is worse
# than none, because it produces false confidence.
grep -q "restricts \*\*nothing\*\*" "$R" \
  && ok "discloses that the default egress rule restricts nothing" \
  || bad "the allow-all default is not disclosed"
grep -qi "DNS, or nothing resolves" "$R" \
  && ok "warns about the missing-DNS-rule mistake" \
  || bad "no DNS warning; the most common egress-policy error is undocumented"

echo
echo "T4 -- egress is configurable and the default is unchanged"
if command -v helm >/dev/null 2>&1; then
  D=$(helm template t "$CHART" --set security.networkPolicy.enabled=true 2>/dev/null)
  printf '%s' "$D" | grep -A1 "^  egress:" | grep -q -- "- {}" \
    && ok "default remains allow-all (no behaviour change for existing installs)" \
    || bad "default egress changed; existing installs could lose provider access"

  cat > /tmp/_eg_test.yaml <<'EOF'
security:
  networkPolicy:
    enabled: true
    egress:
      - to:
          - ipBlock: {cidr: 10.0.0.0/8}
        ports: [{port: 443, protocol: TCP}]
EOF
  O=$(helm template t "$CHART" -f /tmp/_eg_test.yaml 2>/dev/null)
  rm -f /tmp/_eg_test.yaml
  printf '%s' "$O" | grep -q "10.0.0.0/8" \
    && ok "a real egress rule list renders" \
    || bad "egress override ignored -- the knob is inert"
else
  ok "helm absent; render checks skipped"
fi

echo
echo "T5 -- private registry guidance exists and discourages :latest"
grep -q "imagePullSecrets" "$R" && ok "private registry documented" || bad "no private registry path"
grep -qi "rather than \`latest\`" "$R" \
  && ok "warns against pinning latest" \
  || bad "does not warn about :latest making rollback unreasonable"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
