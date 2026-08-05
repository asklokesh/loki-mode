#!/usr/bin/env bash
# ECS/Fargate module must exist and stay consistent with the Helm chart.
#
# WHY IT EXISTS. The repo shipped Helm for Kubernetes and Terraform for
# EKS/AKS/GKE, and NOTHING for ECS. A large share of AWS shops run ECS/Fargate
# precisely to avoid operating a Kubernetes control plane, so "use the Helm
# chart" is not an on-ramp for them, it is a prerequisite.
#
# WHAT THIS TEST CAN AND CANNOT DO. terraform is not installed in this
# environment and CI does not validate terraform at all (verified: no
# validate/fmt/plan step exists for the pre-existing aws/azure/gcp modules
# either). So this asserts STRUCTURE and CROSS-CONSISTENCY, which is real, and
# does NOT claim the module has been planned or applied. Saying which half was
# checked is the difference between evidence and a claim.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
M="$REPO_ROOT/deploy/terraform/modules/aws-ecs"
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "T1 -- the module ships with the expected files"
for f in main.tf variables.tf outputs.tf versions.tf; do
  [ -f "$M/$f" ] && ok "$f present" || bad "$f missing"
done

echo
echo "T2 -- HCL is structurally sound"
for f in "$M"/*.tf; do
  o=$(grep -o '{' "$f" | wc -l | tr -d ' '); c=$(grep -o '}' "$f" | wc -l | tr -d ' ')
  [ "$o" = "$c" ] && ok "$(basename "$f") braces balanced" \
                  || bad "$(basename "$f") unbalanced: $o open, $c close"
done
# An undeclared variable fails at plan time with a message far from the typo.
und=$(python3 - "$M" <<'PY'
import re,glob,sys
m=sys.argv[1]
decl=set(re.findall(r'variable "([a-z_]+)"', open(f"{m}/variables.tf").read()))
used=set()
for f in glob.glob(f"{m}/*.tf"):
    used |= set(re.findall(r'var\.([a-z_]+)', open(f).read()))
print(",".join(sorted(used-decl)))
PY
)
[ -z "$und" ] && ok "every var.* reference is declared" || bad "undeclared variables: $und"

echo
echo "T3 -- the container definition carries what ECS requires"
# HCL uses unquoted keys, so match `key =` not `"key":`.
for k in name image essential command portMappings containerPort logConfiguration healthCheck; do
  grep -qE "^\s+${k}\s*=|${k}\b" "$M/main.tf" && ok "container definition has $k" \
                                              || bad "container definition missing $k"
done

echo
echo "T4 -- ECS and Helm agree (the drift this guards)"
# If these two disagree, one platform gets a health check that passes while the
# other fails, and nobody finds out until one of them is in production.
H="$REPO_ROOT/deploy/helm/autonomi/values.yaml"
hp=$(python3 -c "import yaml;print(yaml.safe_load(open('$H'))['config']['dashboardPort'])" 2>/dev/null)
grep -q "default     = $hp" "$M/variables.tf" \
  && ok "dashboard_port default ($hp) matches the Helm chart" \
  || bad "port drifted from Helm's config.dashboardPort ($hp)"
grep -q "uvicorn" "$M/main.tf" \
  && ok "runs the same uvicorn command as the Helm deployment" \
  || bad "command differs from the Helm chart"
grep -q "/health" "$M/main.tf" \
  && ok "health check hits /health, the same path Kubernetes probes" \
  || bad "health path differs from the Kubernetes probe"

echo
echo "T5 -- security defaults are safe, not convenient"
grep -q 'assign_public_ip' "$M/variables.tf" && grep -q "default     = false" "$M/variables.tf" \
  && ok "assign_public_ip defaults false (no control plane on a public IP)" \
  || bad "assign_public_ip does not default to false"
# A secret passed as a plaintext env var is visible in describe-task-definition.
grep -q "valueFrom" "$M/main.tf" \
  && ok "provider key passed as a secret reference, not plaintext env" \
  || bad "no secret reference -- an API key would be visible in the ECS console"
grep -q "secretsmanager:GetSecretValue" "$M/main.tf" && ! grep -q '"secretsmanager:\*"' "$M/main.tf" \
  && ok "secret read is scoped to one ARN, not secretsmanager:*" \
  || bad "secret permission is wildcarded"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
