# Autonomi Loki Mode - Helm Chart

Production Kubernetes deployment for the Autonomi Loki Mode multi-agent autonomous development system.

## Prerequisites

- Kubernetes 1.26+ (1.31+ required for the worker exit-code contract; see "Pod-loss resilience" below)
- Helm 3.12+
- Container image `asklokesh/loki-mode` available (Docker Hub or private registry)

To verify the image signature and SBOM before deploying, see
[docs/image-provenance.md](../../docs/image-provenance.md). Images from the first
release after v8.5.2 are signed and carry a CycloneDX SBOM; v8.5.2 and
earlier are not signed.

## Quickstart

```bash
# 1. Create namespace and secret first (recommended)
kubectl create namespace autonomi
kubectl create secret generic autonomi-secrets \
  --namespace autonomi \
  --from-literal=anthropic-api-key=sk-ant-...

# 2. Install the chart referencing the secret
helm install autonomi ./deploy/helm/autonomi \
  --namespace autonomi \
  --set secrets.existingSecret=autonomi-secrets
```

> **Note:** You can also pass keys inline with `--set secrets.anthropicApiKey=sk-ant-...`,
> but this exposes the key in your shell history and process list. Using a
> pre-created Kubernetes secret (above) is strongly recommended.

## Installation

### From local chart

```bash
helm install autonomi ./deploy/helm/autonomi \
  --namespace autonomi \
  --create-namespace \
  -f my-values.yaml
```

### Using an existing secret for API keys

Create the secret first:

```bash
kubectl create secret generic autonomi-api-keys \
  --namespace autonomi \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  --from-literal=OPENAI_API_KEY=sk-... \
  --from-literal=GOOGLE_API_KEY=AI...
```

Then reference it:

```bash
helm install autonomi ./deploy/helm/autonomi \
  --namespace autonomi \
  --set secrets.existingSecret=autonomi-api-keys
```

## Upgrade

```bash
helm upgrade autonomi ./deploy/helm/autonomi \
  --namespace autonomi \
  -f my-values.yaml
```

## Uninstall

```bash
helm uninstall autonomi --namespace autonomi
```

Note: PersistentVolumeClaims are not deleted automatically. Remove them manually if no longer needed:

```bash
kubectl delete pvc -l app.kubernetes.io/instance=autonomi -n autonomi
```

## Configuration

See `values.yaml` for the full list of configurable parameters.

### Key sections

| Section | Description |
|---------|-------------|
| `controlplane` | Dashboard/API Deployment (replicas, resources, probes). Serves traffic; HA applies here. |
| `worker` | RARV worker. A run-to-completion batch Job (one build per release): `backoffLimit`, `activeDeadlineSeconds`, `spec`, resources. Not a Deployment, no replicas, no autoscaling. |
| `persistence` | PVC settings for the worker `/workspace` durable volume (checkpoints + worker audit) and the control-plane audit volume |
| `ingress` | Ingress with TLS and cert-manager support |
| `config` | Non-secret environment variables (log level, provider, etc.) |
| `secrets` | API keys (or reference an existing secret) |
| `security` | Pod security context, RBAC, network policies |
| `observability` | ServiceMonitor for Prometheus |

> **Reserved:** `worker.mode` defaults to `"job"` (the only supported model). A
> `worker.mode: "deployment"` value is reserved for a future long-running
> queue-consumer worker and is **not yet functional**. Setting it does not change
> the worker workload kind (always a Job in this chart version); it only gates
> whether the optional `hpa-worker`, worker `Service`, and worker PDB render.
> Autoscaling, the worker Service, and the worker PDB do not apply to the Job.

## Triggering a build

The worker Job runs `loki start` once. What it builds is selected by
`worker.spec`:

| `worker.spec` value | Behavior |
|---------------------|----------|
| `""` (empty, default) | Codebase-analysis mode: analyze the repo already checked out on the mounted `/workspace` volume. |
| `"docs/prd.md"` (a path) | PRD/spec mode: a path, relative to `/workspace`, to a spec file that already exists on the mounted volume. |
| `"owner/repo#123"` | Issue mode: a GitHub issue reference. Requires a GitHub token in the secret. |

```bash
# Build from a PRD already present on the workspace volume
helm install build1 ./deploy/helm/autonomi \
  --namespace autonomi \
  --set secrets.existingSecret=autonomi-api-keys \
  --set worker.spec="docs/prd.md"

# Build from a GitHub issue
helm install build2 ./deploy/helm/autonomi \
  --namespace autonomi \
  --set secrets.existingSecret=autonomi-api-keys \
  --set worker.spec="owner/repo#123"
```

Each build is a separate release with its own Job and its own ReadWriteOnce
`/workspace` PVC. Run concurrent independent builds as separate releases;
per-Job dynamic claims are future work.

> **Important: the chart does NOT seed `/workspace`.** A fresh PVC is empty. For
> codebase-analysis or PRD modes, the operator must pre-seed the volume (place the
> repo checkout and/or the PRD file on it) before the Job runs. Issue mode is the
> only mode that needs no pre-seeded source, since `loki` resolves the issue from
> GitHub. An init-container that clones the repo is future work, not implemented
> here.

## Pod-loss resilience

The worker is a run-to-completion batch Job (`batch/v1`) with `restartPolicy:
Never`, `backoffLimit` (default 6), `activeDeadlineSeconds` (default 86400 = 24h),
and a `podFailurePolicy`. One build runs to completion. The run.sh durable-state
path is activated by `LOKI_DURABLE_STATE=1`, set in the worker env.

The exit-code contract (enforced cluster-side by `podFailurePolicy`):

- **Crash** (any other nonzero exit / SIGKILL): the Job starts a fresh pod, which
  re-mounts the durable `/workspace` PVC and **resumes from the last checkpoint**.
  Counts against `backoffLimit`.
- **Deterministic terminal failure** (failed gate / max iterations): run.sh exits
  `20`; `podFailurePolicy` **fails the Job immediately** without burning retries
  (no infinite re-run).
- **Pod eviction / node loss**: the `DisruptionTarget` pod condition is `Ignore`d,
  so disruption does **not** count against `backoffLimit`. The replacement pod
  resumes off the durable volume.

All per-build state lives under the single durable `/workspace` volume (the
container WORKDIR): `.loki` checkpoints, state, queue, signals, logs, the agent
feature branch, and the `refs/loki/cp/*` git refs. One ReadWriteOnce PVC at
`/workspace` therefore makes the whole build survive pod loss. There is no longer
a separate worker `/data/checkpoints` or `/data/audit` mount.

### Requirements and caveats (honest scope)

- **Kubernetes 1.31+** is required for the exit-code contract: `podFailurePolicy`
  is stable in 1.31+. On older clusters the Job still runs, but the platform
  cannot distinguish a terminal failure (exit 20) from a retryable crash, so a
  deterministic failure would burn the whole `backoffLimit`.
- **Empty PVC on fresh install:** the chart does not clone the repo or place the
  PRD. Pre-seed `/workspace`, or use an issue ref. See "Triggering a build".
- **A Job's `spec.template` is immutable.** Changing the image, resources,
  `worker.spec`, or env on an existing release makes `helm upgrade` fail with a
  "field is immutable" error. To change a build, ship a new release name or delete
  the completed Job first. There is no in-place upgrade of a running build.
- **Single build per release:** one Job plus one ReadWriteOnce `/workspace` PVC.
  Concurrent independent builds need separate releases; per-Job dynamic claims are
  future work.
- **Worker audit is plain JSONL** on the durable `/workspace` volume (it survives
  pod loss). It is **not** tamper-evident and is **not** shipped to a SIEM. The
  tamper-evident hash-chain is the separate control-plane/dashboard audit chain;
  full SIEM ingestion is roadmap.

## Production Deployment

```bash
helm install autonomi ./deploy/helm/autonomi \
  --namespace autonomi \
  --create-namespace \
  -f deploy/helm/autonomi/values-production.yaml \
  --set secrets.existingSecret=autonomi-api-keys
```

Production values include:
- 2 control plane replicas (the control plane is a Deployment and serves traffic)
- Larger resource limits
- Network policies enabled
- Audit logging at WARNING level

The worker is a run-to-completion Job, not a scaled service: each `helm install`
release runs exactly one build to completion. There are no worker replicas and no
worker autoscaling. To run more builds, run more Jobs via separate releases (see
"Triggering a build" below). The worker `resources` requests/limits are still
worth raising for production-sized builds.

## High Availability

```bash
helm install autonomi ./deploy/helm/autonomi \
  --namespace autonomi \
  --create-namespace \
  -f deploy/helm/autonomi/values-production.yaml \
  -f deploy/helm/autonomi/values-ha.yaml \
  --set secrets.existingSecret=autonomi-api-keys
```

High availability applies to the control plane only. The control plane is a
Deployment that serves the dashboard/API, so HA values add:
- 3 control plane replicas with pod anti-affinity

The worker build is not made "highly available" by replicas: it is a single
run-to-completion Job whose durability comes from the crash-resume + exit-code
contract over a durable `/workspace` PVC (see "Pod-loss resilience" below), not
from running multiple copies. The worker PVC is ReadWriteOnce and backs one build
per release; ReadWriteMany shared checkpoints are not used by the Job model.

## Testing

```bash
helm test autonomi --namespace autonomi
```

This runs two test pods:
1. `test-connection` - verifies the `/health` endpoint responds
2. `test-health` - verifies `/api/status` returns valid JSON

## Architecture

```
+------------------+       +-------------------------+
|    Ingress       |------>|  Control Plane          |
|  (optional TLS)  |       |  Deployment (serves      |
+------------------+       |  traffic, HA-capable)   |
                           |  Dashboard API : 57374  |
                           +-------------------------+
                                    |
                                    | (durable audit volume)
                                    v
                           +-------------------------+
                           |  Audit Logs PVC         |
                           |  control-plane          |
                           |  hash-chain (tamper-     |
                           |  evident) JSONL          |
                           +-------------------------+


  Worker (one build per release):

  +---------------------------------------------------+
  |  RARV Worker -- batch/v1 Job (run-to-completion)  |
  |  command: loki start [worker.spec]                |
  |  restartPolicy: Never  backoffLimit: 6 (default)  |
  |  activeDeadlineSeconds: 86400 (24h, default)      |
  |                                                   |
  |  podFailurePolicy:                                |
  |    exit 20  -> FailJob now (terminal, no retry)   |
  |    eviction -> Ignore (resume, not a retry)       |
  |    other nonzero / SIGKILL -> retry + resume      |
  +---------------------------------------------------+
                        |
                        | mounts WORKDIR /workspace
                        v
  +---------------------------------------------------+
  |  /workspace PVC (ReadWriteOnce, durable)          |
  |  ALL per-build state: .loki checkpoints, state,   |
  |  queue, signals, logs (plain-JSONL worker audit), |
  |  feature branch, refs/loki/cp/* in .git           |
  |  Survives pod loss -> crash-resume from last cp.  |
  +---------------------------------------------------+
```

## Operator runbook

The sections above cover installing and configuring. This one covers the things
you need when something is wrong or when you are handing the deployment to
somebody else.

### Is this release actually healthy

`helm install` succeeding means Kubernetes accepted the manifests. It does not
mean the control plane came up or can answer a request. To check that:

```bash
helm test <release> -n <namespace>
```

The test pod probes the control-plane Service on the same readiness path the
kubelet uses, and retries for a minute so a slow cold start is not reported as
a failure. A failed test pod is deliberately **kept** so you can read its logs:

```bash
kubectl logs -n <namespace> <release>-autonomi-test-controlplane-health
```

### Rollback

```bash
helm history <release> -n <namespace>          # find the last good REVISION
helm rollback <release> <REVISION> -n <namespace>
```

Rollback reverts the manifests. It does **not** revert data on the PVCs, so a
migration that changed on-disk state is not undone by rolling back the chart.

### What the volumes hold, and what happens on uninstall

| Volume | Holds | Deleted on `helm uninstall`? |
| --- | --- | --- |
| `<release>-audit-logs` | the audit trail | **Yes, unless `persistence.auditLogs.retainOnUninstall=true`** |
| `<release>-checkpoints` | build checkpoints for resume | Yes |

The audit PVC default matches the chart's historical behaviour. If your
retention policy requires the audit trail to outlive the release, set:

```yaml
persistence:
  auditLogs:
    retainOnUninstall: true
```

With that set the PVC survives uninstall and you delete it deliberately:

```bash
kubectl delete pvc -n <namespace> <release>-autonomi-audit-logs
```

Back up before an uninstall you are unsure about:

```bash
kubectl exec -n <namespace> deploy/<release>-autonomi-controlplane -- \
  tar czf - /var/lib/loki/audit > audit-backup-$(date +%Y%m%d).tgz
```

### A pod will not start

Work outward from the pod, not from the chart:

```bash
kubectl get pods -n <namespace>                       # phase and restart count
kubectl describe pod -n <namespace> <pod>             # events: image pull, scheduling, probes
kubectl logs -n <namespace> <pod> --previous          # the crash before the restart
```

Three failures account for most cases:

- **`ImagePullBackOff`** - `image.repository`/`tag` wrong, or the registry needs
  `imagePullSecrets`.
- **`CreateContainerConfigError`** - a referenced Secret or ConfigMap does not
  exist yet. The chart does not create your provider secret; see Quickstart.
- **Readiness never passes** - the control plane is up but not answering on
  `controlplane.probes.readiness.path`. Port-forward and check by hand:
  `kubectl port-forward -n <ns> svc/<release>-autonomi-controlplane 57374:57374`
  then `curl localhost:57374/health`.

### No builds are being picked up

If the control plane is healthy but nothing progresses, check that a worker
exists at all:

```bash
kubectl get pods -n <namespace> -l app.kubernetes.io/component=worker
kubectl get scaledjob,scaledobject -n <namespace>     # if keda.enabled
```

`worker.mode` selects which worker resource renders (`job`, `deployment`, or
`serverless`). An invalid value is now rejected at install time by
`values.schema.json`, but a release installed before that schema existed may be
running with no worker at all and no error anywhere.

### Scaling

- `worker.mode=deployment` scales via the HPA (`worker.autoscaling`).
- `keda.enabled=true` scales on queue depth via KEDA; `keda.triggers` defines
  the source, and `maxReplicaCount` bounds it.
- `pdb` keeps a minimum available during voluntary disruptions such as node
  drains. It does not protect against a node failing outright.

## Air-gapped and restricted-egress installs

### What is actually air-gappable

Be precise here, because a security review will be:

- **Verification is air-gapped.** The deterministic checks make no network
  calls. Proven offline, not asserted: `tests/test-airgap-verify.sh` blackholes
  every proxy variable, strips the environment, and still gets a real verdict.
- **Generation is not.** Every provider we ship calls a hosted API. A fully
  offline build needs a model served inside your network.

Anyone claiming a fully air-gapped LLM agent without shipping weights is worth a
second question.

### Find out exactly what leaves the network

```bash
loki doctor --airgap
```

It lists every egress point, marks which are **required** versus optional, and
refuses to report air-gap ready while a required one remains. On a default
install that is one line: model inference to the provider API. The output also
names the remediation, which is to serve the model in-network:

```bash
loki provider set opencode
export LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder
loki doctor --airgap        # re-run; the required egress should be gone
```

Run this **before** writing NetworkPolicy rules. It is the host inventory those
rules have to cover, and guessing the list is how a policy blocks something the
engine needs.

### Pin egress in the chart

The shipped NetworkPolicy declares `policyTypes: [Ingress, Egress]` but its
egress rule is `- {}`, which restricts **nothing**. That default is deliberate:
the engine must reach a provider API, and a chart that blocked it out of the box
would leave every new install unable to build with no obvious cause. It does
mean an operator who installs the NetworkPolicy may reasonably assume egress is
controlled when it is not.

To actually control it:

```yaml
security:
  networkPolicy:
    enabled: true
    egress:
      - to:
          - namespaceSelector:
              matchLabels:
                kubernetes.io/metadata.name: kube-system
        ports:
          - port: 53
            protocol: UDP          # DNS, or nothing resolves
      - to:
          - ipBlock:
              cidr: 10.0.0.0/8     # your in-network model gateway
        ports:
          - port: 443
            protocol: TCP
```

Omitting the DNS rule is the most common mistake: pods then fail to resolve
anything and the symptom looks like the provider being down.

### Private registry

```yaml
image:
  repository: registry.internal.example.com/autonomi/loki-mode
  tag: "8.5.2"
imagePullSecrets:
  - name: internal-registry
```

Mirror the image before installing:

```bash
docker pull asklokesh/loki-mode:8.5.2
docker tag  asklokesh/loki-mode:8.5.2 registry.internal.example.com/autonomi/loki-mode:8.5.2
docker push registry.internal.example.com/autonomi/loki-mode:8.5.2
```

Pin a tag or digest rather than `latest`: during an incident "which build is
running" has to be answerable, and `latest` makes rollback unreasonable.
