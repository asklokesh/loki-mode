#!/usr/bin/env bash
# One command: cluster -> install -> health -> teardown.
#
# WHY THIS EXISTS. An evaluator at an enterprise has `npx loki-mode tour`, which
# gives a real result in seconds with no install. The Kubernetes path had no
# equivalent: read a chart, guess at values, find secrets, hope. The gap between
# "we ship a Helm chart" and "you can see it work" was an afternoon of reading.
#
# WHAT IT PROVES, and deliberately no more:
#   the chart installs into a real cluster, the control plane comes up, and it
#   answers on its readiness path.
# It does NOT prove a build runs end to end -- that needs a provider API key and
# real spend, which an unattended smoke test must not assume. Claiming a working
# build from a health check would be exactly the overclaim the Evidence Receipt
# exists to prevent.
#
# EVERY STEP REPORTS WHICH STEP FAILED. A bare non-zero exit costs an
# investigation; the supervisor-127 bug earlier in this project cost two before
# anyone printed the child's own output.

set -uo pipefail

CLUSTER="${SMOKE_CLUSTER:-loki-smoke}"
NS="${SMOKE_NAMESPACE:-loki-smoke}"
RELEASE="${SMOKE_RELEASE:-smoke}"
KEEP="${SMOKE_KEEP:-0}"          # 1 to leave the cluster up for debugging
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$REPO_ROOT/deploy/helm/autonomi"

step() { printf '\n== %s\n' "$1"; }
die()  { printf '\nFAILED AT: %s\n' "$1" >&2; _dump; _teardown; exit 1; }

_dump() {
    # Print what a human would need to diagnose this, before tearing anything
    # down. Teardown destroys the evidence, so it happens after.
    printf '\n-- diagnostics --\n' >&2
    kubectl get pods -n "$NS" 2>/dev/null >&2 || true
    kubectl describe pods -n "$NS" 2>/dev/null | grep -A5 -iE "events:|warning" | head -30 >&2 || true
    kubectl logs -n "$NS" -l app.kubernetes.io/component=controlplane --tail=40 2>/dev/null >&2 || true
}

_teardown() {
    if [ "$KEEP" = "1" ]; then
        printf '\nSMOKE_KEEP=1: leaving cluster %s up. Remove with: kind delete cluster --name %s\n' "$CLUSTER" "$CLUSTER"
        return 0
    fi
    kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
}

for bin in kind kubectl helm docker; do
    command -v "$bin" >/dev/null 2>&1 || { echo "missing required tool: $bin" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { echo "docker daemon is not running (kind needs it)" >&2; exit 2; }

step "create cluster ${CLUSTER}"
# FIRST RUN IS SLOW AND THAT IS NOT A HANG. kind pulls a ~1GB node image the
# first time (measured: this step sat for >10 minutes on a cold cache with no
# output, because kind prints nothing while pulling). Pre-pull it to make the
# smoke test predictable in CI or a demo:
#   docker pull kindest/node:v1.31.0
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    echo "reusing existing cluster"
else
    kind create cluster --name "$CLUSTER" --wait 120s >/dev/null 2>&1 || die "kind create cluster"
fi
kubectl cluster-info --context "kind-${CLUSTER}" >/dev/null 2>&1 || die "cluster not reachable after create"

step "load the image into the cluster"
# kind nodes cannot pull from the host daemon, so the image is side-loaded. If
# it is absent locally we fall back to letting the kubelet pull it, and say so
# rather than failing on a missing local build.
IMAGE="${SMOKE_IMAGE:-asklokesh/loki-mode:latest}"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    kind load docker-image "$IMAGE" --name "$CLUSTER" >/dev/null 2>&1 || die "kind load docker-image"
    echo "loaded ${IMAGE} from the local daemon"
else
    echo "note: ${IMAGE} not present locally; the kubelet will pull it"
fi

step "install the chart"
kubectl create namespace "$NS" --context "kind-${CLUSTER}" >/dev/null 2>&1 || true
# A dummy provider secret: the chart requires one to exist, and this smoke test
# deliberately never makes a paid call, so the value is irrelevant.
kubectl create secret generic loki-provider -n "$NS" \
    --from-literal=ANTHROPIC_API_KEY=smoke-test-not-a-real-key \
    --context "kind-${CLUSTER}" >/dev/null 2>&1 || true

helm install "$RELEASE" "$CHART" \
    --namespace "$NS" \
    --kube-context "kind-${CLUSTER}" \
    --set image.repository="${IMAGE%:*}" \
    --set image.tag="${IMAGE##*:}" \
    --set worker.replicas=0 \
    --wait --timeout 5m >/dev/null 2>&1 || die "helm install"
echo "installed"

step "helm test (does it actually serve?)"
helm test "$RELEASE" --namespace "$NS" --kube-context "kind-${CLUSTER}" --timeout 3m >/dev/null 2>&1 \
    || die "helm test: control plane did not answer on its readiness path"
echo "control plane answered"

step "teardown"
_teardown

printf '\nSMOKE PASSED: chart installs, control plane serves, teardown clean.\n'
printf 'NOT proven by this run: an end-to-end build (needs a real provider key and spend).\n'
