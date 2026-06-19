# Autonomi Loki Mode - Helm Chart

Production Kubernetes deployment for the Autonomi Loki Mode multi-agent autonomous development system.

## Prerequisites

- Kubernetes 1.26+ (1.31+ required for the worker exit-code contract; see "Pod-loss resilience" below)
- Helm 3.12+
- Container image `asklokesh/loki-mode` available (Docker Hub or private registry)

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
