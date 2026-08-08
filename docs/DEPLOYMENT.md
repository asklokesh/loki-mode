# Deploying Loki Mode as a build service

You deployed it. Now what starts a build?

That is the question this document answers, because it is the one a fresh
deployment does not answer for you. The pods are running, `/health` returns
200, and nothing is happening. Three things can start a build, and you have to
set up at least one of them deliberately.

- [The shape of a deployment](#the-shape-of-a-deployment)
- [Path 1: a GitHub webhook](#path-1-a-github-webhook)
- [Path 2: manual enqueue](#path-2-manual-enqueue)
- [Path 3: the API endpoint](#path-3-the-api-endpoint)
- [Triggers that do not exist yet](#triggers-that-do-not-exist-yet)
- [Kubernetes (Helm)](#kubernetes-helm)
- [Single node (Docker Compose)](#single-node-docker-compose)
- [Things that will bite you](#things-that-will-bite-you)

---

## The shape of a deployment

Two processes and a queue.

```
GitHub  --webhook-->  receiver  --enqueue-->  Redis  --pop-->  worker  --> loki start
                   (trigger-server.py)               (queue-consumer.sh)
```

The **receiver** (`autonomy/trigger-server.py`) validates an HMAC signature and
pushes an item onto a queue. It never runs a build, and it holds no provider
credential. If someone compromises the receiver, they cannot spend your
provider budget.

The **worker** (`autonomy/queue-consumer.sh`) pulls one item at a time and runs
`loki start <spec>`. This is where builds happen, where the money is spent, and
where your source code gets checked out. Worker replica count is the scaling
knob.

Separating them is what lets a webhook storm cost you a full queue instead of a
hundred concurrent builds.

---

## Path 1: a GitHub webhook

This is the default path and the one most deployments want.

### 1. Get a secret into the deployment

The receiver requires a webhook secret. Without one it starts (so `/health`
stays up for your probes) and rejects **every** webhook with 503. It never
silently accepts unauthenticated builds. Generate one:

```bash
openssl rand -hex 32
```

Helm:

```bash
helm upgrade --install loki helm/loki-mode \
  --set secrets.githubWebhookSecret='<that value>' \
  --set secrets.anthropicApiKey='<your key>'
```

Better, for anything real: set `secrets.create=false` and
`secrets.existingSecret=<name>` and manage the Secret with sealed-secrets,
External Secrets Operator or a Vault injector. Values passed with `--set` land
in Helm release history and often in a git-tracked values file.

Compose: put both in `.env` next to `docker-compose.yml`.

```
GITHUB_WEBHOOK_SECRET=<that value>
ANTHROPIC_API_KEY=<your key>
```

### 2. Expose the receiver to GitHub

GitHub has to reach `POST /webhook` from the internet. The chart ships an
Ingress, off by default:

```bash
helm upgrade --install loki helm/loki-mode \
  --set receiver.ingress.enabled=true \
  --set receiver.ingress.host=loki.example.com \
  --set receiver.ingress.className=nginx
```

Terminate TLS there. On Compose the receiver binds to `127.0.0.1:7373`
deliberately: put a reverse proxy in front rather than publishing an
unencrypted webhook endpoint on every interface the host has.

### 3. Create the webhook

In the repository: **Settings -> Webhooks -> Add webhook**.

| Field | Value |
|---|---|
| Payload URL | `https://loki.example.com/webhook` |
| Content type | `application/json` |
| Secret | the value from step 1 |
| SSL verification | Enable |
| Events | **Let me select individual events** |

Now the part that decides what your deployment costs. Tick:

- **Issues** -- an issue being opened starts a build.
- **Workflow runs** -- a failed CI run starts a repair build.

Leave **Pull requests** unticked unless you have decided you want it. See
below.

### 4. What actually fires

Only these three combinations do anything. Every other event and action is
logged and ignored.

| Event | Action | What runs |
|---|---|---|
| `issues` | `opened` | `loki start owner/repo#N --pr --detach` |
| `pull_request` | `synchronize` | `loki start owner/repo#N --detach` |
| `workflow_run` | `completed` with `conclusion=failure` | `loki start --detach` |

Note what is **not** there. Labelling an issue does nothing. Commenting on an
issue does nothing. Opening a pull request does nothing -- for PRs it is
`synchronize`, meaning new commits pushed to an existing PR.

### Why the PR trigger is off by default

`pull_request`/`synchronize` fires on **every push to every open PR**. On a
repository with a handful of active PRs and a normal rebase-and-force-push
habit, that is dozens of builds a day that nobody asked for. It is the easiest
way to surprise a team with a bill.

Turn it on when you have decided you want it:

```bash
helm upgrade --install loki helm/loki-mode --set triggers.pullRequest=true
```

**Read this carefully, because the value alone does not enforce anything.** The
receiver dispatches on whatever GitHub delivers; it does not consult an
allowlist before acting. `triggers.pullRequest` renders a ConfigMap that
records your intent and gives you something to diff when someone asks why a
build started. What actually keeps PR builds from firing is **not subscribing
the webhook to Pull request events** in step 3.

If you tick "Pull requests" in GitHub, PR builds will run no matter what
`triggers.pullRequest` says.

### 5. Confirm it works

GitHub records every delivery. **Settings -> Webhooks -> your webhook ->
Recent Deliveries** shows request and response for each one.

| Response | Meaning |
|---|---|
| `202` `{"status":"queued"}` | Accepted and enqueued. This is success. |
| `401 invalid signature` | Secret mismatch between GitHub and the deployment. |
| `503 webhook secret not configured` | The receiver has no secret. Step 1. |
| `503 server busy, retry later` | Dispatch queue full; load shed on purpose. |
| `200 {"status":"duplicate"}` | Redelivery of a delivery ID already seen. |
| `200 skipped (action=...)` | Delivered fine, but not an action that fires. |

Then watch the worker:

```bash
kubectl logs -l app.kubernetes.io/component=worker -f     # Kubernetes
docker compose --profile service logs -f worker           # Compose
```

You are looking for `[queue-consumer] starting build: spec=owner/repo#N`.

---

## Path 2: manual enqueue

The queue is a plain Redis list. Pushing to it starts a build, with no GitHub
involved. This is the fastest way to prove a deployment works end to end, and
it is how you re-drive a build that failed.

Kubernetes:

```bash
kubectl exec -it deploy/loki-redis-master -- \
  redis-cli RPUSH loki-builds 'owner/repo#123'
```

Compose:

```bash
docker compose --profile service exec redis \
  redis-cli RPUSH loki-builds 'owner/repo#123'
```

A work item is anything `loki start` accepts: a GitHub issue ref
(`owner/repo#123`), a path to a PRD, a one-line brief, or a JSON object
`{"spec": "..."}`. An item beginning with `-` is rejected rather than being
parsed as a flag.

Check queue depth, which is also your "are the workers keeping up" metric:

```bash
redis-cli LLEN loki-builds
```

---

## Path 3: the API endpoint

`POST /jobs` with a bearer token, for submitting a build from your own tooling
without involving GitHub at all.

Set `secrets.apiToken` (Helm) or `LOKI_API_TOKEN` (Compose). If it is unset the
receiver still starts, and rejects every `/jobs` request with 503 -- the same
fail-closed rule the webhook path follows.

```bash
curl -X POST https://loki.example.com/jobs \
  -H "Authorization: Bearer $LOKI_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"spec": "owner/repo#123"}'
# -> 202 {"id": "...", "status": "queued"}

curl -H "Authorization: Bearer $LOKI_API_TOKEN" \
  https://loki.example.com/jobs/<id>
```

It is a **separate credential from the webhook HMAC** on purpose. The HMAC
authenticates GitHub; the bearer token authenticates a human operator. Holding
one must never grant the other, so they rotate on different schedules and a
leaked API token does not let the holder forge GitHub webhooks.

The token can also be read from a mounted file via `LOKI_API_TOKEN_FILE`, which
is the better option if you inject secrets as files rather than env vars.

---

## Triggers that do not exist yet

Documented so you do not go looking for them:

- **Issue labelled** (add a `loki` label to start a build). Not implemented.
  The `issues` handler acts on `opened` only.
- **Issue comment commands** (`/loki build`). Not implemented. The receiver has
  no `issue_comment` handler; GitHub will deliver the event and get back
  `unsupported event: issue_comment`.

Both are reasonable and neither exists in this release. Path 2 covers the same
ground manually today.

---

## Kubernetes (Helm)

No `helm dependency build` step: the chart has no subchart dependencies. Redis
is a plain Deployment on `redis:7-alpine`, the same image `docker-compose.yml`
uses.

The default image tag is the chart's `appVersion`, which tracks `VERSION` and so
names a tag that exists only once the release pipeline has published it. If you
install from a source tree whose `VERSION` is ahead of Docker Hub, pods fail on
`ImagePullBackOff` -- add `--set image.tag=<a published version>`.

```bash
helm upgrade --install loki helm/loki-mode \
  --namespace loki --create-namespace \
  --set secrets.githubWebhookSecret='<hmac>' \
  --set secrets.anthropicApiKey='<key>' \
  --set worker.replicaCount=3
```

Preview before applying:

```bash
helm template loki helm/loki-mode | less
```

### The values that matter

| Value | Default | Why you would change it |
|---|---|---|
| `worker.replicaCount` | `2` | The scaling knob. One build per replica. |
| `worker.terminationGracePeriodSeconds` | `7200` | Must exceed your p99 build time. |
| `triggers.pullRequest` | `false` | Cost. See above -- and subscribe accordingly. |
| `queue.backend` | `redis` | `file` gives at-least-once, needs an RWX volume. |
| `networkPolicy.enabled` | `false` | Turn on if your CNI enforces policy. |
| `secrets.existingSecret` | `""` | Use a real secret manager. |

### Verify your install

Rendering valid YAML is not evidence that a pod starts. Run these after every
install.

Everything in this section was executed against a real cluster (kind v0.31.0,
Kubernetes v1.35.0) on the `asklokesh/loki-mode:9.17.2` image, except the two
items explicitly marked UNVERIFIED.

**1. Everything reached Ready.** `--wait` already fails the install if not, but
check what is running:

```bash
kubectl get pods -n loki-verify
# loki-loki-mode-receiver-...  1/1  Running
# loki-loki-mode-receiver-...  1/1  Running
# loki-loki-mode-redis-...     1/1  Running
# loki-loki-mode-worker-...    1/1  Running
```

**2. The receiver is actually serving.** This is what `helm test` is for:

```bash
helm test loki -n loki-verify --logs
# Phase: Succeeded
# GET http://loki-loki-mode-receiver:80/health -> 200 {"status": "ok", "service": "loki-trigger-server"}
# PASS: receiver is serving
```

The test asserts on the response body, not just the status code, so a proxy or
a wrong backend answering 200 still fails it.

**3. The receiver picked up its secret.** `secret_configured: true` is the
difference between a working webhook and one that 503s every delivery:

```bash
kubectl port-forward -n loki-verify svc/loki-loki-mode-receiver 18080:80 &
curl -s http://127.0.0.1:18080/status
# {"status": "running", "dry_run": false, "port": 7373,
#  "enabled_events": [...], "secret_configured": true}
```

**4. The worker can reach the queue.** A worker that cannot reach Redis sits in
its poll loop forever and looks perfectly healthy:

```bash
W=$(kubectl get pod -n loki-verify -l app.kubernetes.io/component=worker \
      --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n loki-verify "$W" -- sh -c 'redis-cli -u "$LOKI_QUEUE_URL" ping'
# PONG
```

**5. A queued item actually gets picked up.** The end-to-end check:

```bash
R=$(kubectl get pod -n loki-verify -l app.kubernetes.io/component=redis -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n loki-verify "$R" -- redis-cli RPUSH loki-builds 'smoke-test-spec'
sleep 10
kubectl exec -n loki-verify "$R" -- redis-cli LLEN loki-builds   # 0 == claimed
kubectl logs -n loki-verify "$W"
# [queue-consumer] starting build: spec=smoke-test-spec
```

`starting build:` is the line that matters. With a placeholder API key the
build then fails, which is expected -- you are verifying that the item was
dequeued and `loki start` was invoked, not that the build succeeded.

Watch for one thing here: if the build exits 2, the consumer treats that as a
fatal configuration error and exits, and the pod restarts. `kubectl logs
--previous` shows what the previous container did.

**6. Confirm the hardening actually applied.** Cluster policy can override what
you set:

```bash
kubectl exec -n loki-verify "$W" -- id
# uid=1000(loki) gid=1000(loki)

kubectl get deploy -n loki-verify loki-loki-mode-worker \
  -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}'
# 7200
```

**7. NetworkPolicy enforcement -- test it, do not assume it.**

```bash
kubectl exec -n loki-verify "$W" -- curl -s --max-time 5 http://169.254.169.254/
```

**A timeout here does not prove the policy works.** On a laptop cluster there
is no metadata service to reach, so the request times out either way. Run the
control before believing it:

```bash
kubectl delete networkpolicy -n loki-verify loki-loki-mode-worker
kubectl exec -n loki-verify "$W" -- curl -s --max-time 5 http://169.254.169.254/
# Same timeout with the policy deleted => the policy was never what blocked it.
helm upgrade loki helm/loki-mode -n loki-verify --reuse-values   # restore
```

That control was run on kind, whose default CNI (kindnet) does **not** enforce
NetworkPolicy: the result was identical with and without the policy. The object
applied cleanly and rendered the correct `except` for 169.254.169.254, and
nothing enforced it. This is the silent no-op described above, observed rather
than assumed.

**UNVERIFIED:** that the metadata endpoint is genuinely blocked on a
policy-enforcing CNI (Calico, Cilium). That needs a cluster with one, plus a
real metadata service. Run the delete-and-retry control there: on an enforcing
CNI the two results differ.

**UNVERIFIED:** the GitHub webhook path end to end. Delivery from GitHub to
`/webhook` with a real HMAC signature was not exercised, since it needs a
publicly reachable Ingress. The receiver's HMAC validation itself is covered by
the repository's test suite.

### Worker scaling is a tenancy decision

Each worker pod runs exactly one build at a time onto an `emptyDir` that is
created with the pod and destroyed with it. That is deliberate: one submitter's
checkout is never readable by the next build.

Adding replicas adds parallel builds without breaking that. But **any worker
can claim any queue item**, so all your submitters share one trust boundary. If
they are not mutually trusting, replicas are not enough -- run a separate
release per tenant, each with its own `queue.key` and namespace.

This is the same reasoning behind one-user-per-runner guidance for self-hosted
CI runners. A shared build service without it leaks source between tenants.

### Egress and the metadata endpoint

`networkPolicy.enabled=true` applies default-deny egress to the worker, with an
explicit exclusion for `169.254.169.254`.

That address needs naming specifically because it is **link-local**: it is not
in any pod CIDR, service CIDR or VPC subnet, so a policy written in terms of
subnets never touches it. Reaching it from inside a build returns the node's
instance credentials, which turns an ordinary build into access to your cloud
account.

```bash
helm upgrade --install loki helm/loki-mode \
  --set networkPolicy.enabled=true \
  --set 'networkPolicy.allowedEgressCIDRs={0.0.0.0/0}'
```

Every allow rule carves out `169.254.0.0/16`, so even the wide-open CIDR above
cannot reopen it by accident.

**Verify rather than assume.** A NetworkPolicy is enforced by your CNI. On a
cluster whose CNI has no policy support, the API server accepts the object and
nothing enforces it -- no error, no warning. `kubectl get networkpolicy`
showing your policy is not evidence it works:

```bash
kubectl exec -it deploy/loki-worker -- \
  curl -s --max-time 5 http://169.254.169.254/ && echo "NOT BLOCKED" || echo "blocked"
```

It also stops at the cluster edge. Filtering traffic once it has left the
cluster is a NAT gateway, firewall or proxy you run.

---

## Single node (Docker Compose)

```bash
cp .env.example .env
# set GITHUB_WEBHOOK_SECRET and ANTHROPIC_API_KEY

docker compose --profile service up -d
docker compose --profile service ps
```

The `service` profile is what separates the build service from the one-shot
path. Without it, `docker compose run loki start prd.md` still does exactly
what it always did -- one build, right now, in the current directory.

Scale workers:

```bash
docker compose --profile service up -d --scale worker=4
```

Same tenancy caveat as Kubernetes: each worker gets its own named volume, and
any worker can claim any item. Scale within one trust boundary.

---

## Things that will bite you

**The grace period is a whole build, not a cleanup window.** On SIGTERM the
consumer lets the current build **run to completion** before exiting. At the
Kubernetes default of 30s (Docker's is 10s), every rolling update, node drain,
autoscaler scale-in and spot reclaim SIGKILLs a build mid-flight. The chart
sets `7200` and Compose sets `2h`. Set yours above your p99 build time.

**The Redis queue is at-most-once.** The shipped consumer pops an item and then
runs it. There is no visibility timeout and no dead-letter requeue, so if a
worker dies mid-build, that build is gone from the queue and **nothing retries
it** -- no error, no alert, just a build that never finishes. This is why the
grace period is measured in hours. If you need real at-least-once delivery, use
`queue.backend=file` (a crashed build leaves its item in `processing/` for a
human to re-drive) or bring a broker that has it and override `queue.command`
with your own consumer. SQS, Pub/Sub, RabbitMQ and Kafka are documented as
bring-your-own; they are not implemented here.

**No credentials in the image.** Every credential is injected at pod start from
a Secret or `.env`. A credential baked into a shared image is readable by every
job that image ever runs, including builds from submitters who should never
have had it, and rotating it means rebuilding and redeploying everything that
consumes it.

**A 200 response does not mean a build started.** `200 skipped (action=...)`
means the webhook was delivered and authenticated perfectly, and then did
nothing because it was not one of the three firing combinations. Only `202
queued` means a build is coming. Check worker logs, not just the delivery
response.

**Nothing here rate-limits spend.** The receiver's bounded queue caps
*in-flight dispatches*, not builds per day. Watch queue depth (`LLEN
loki-builds`) and worker logs, and turn `triggers.pullRequest` on only
deliberately.

---

## Reference

| Env var | Where | Meaning |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | receiver | HMAC-SHA256 webhook secret. Required. |
| `LOKI_API_TOKEN` | receiver | Bearer token for `POST /jobs` (not yet live). |
| `ANTHROPIC_API_KEY` | worker | Provider credential. Worker only. |
| `GITHUB_TOKEN` | worker | Used by builds for push / PR creation. |
| `LOKI_QUEUE_BACKEND` | both | `redis` or `file`. |
| `LOKI_QUEUE_KEY` | both | Redis list key. Default `loki-builds`. |
| `LOKI_QUEUE_URL` | both | Redis connection URL. |
| `LOKI_QUEUE_DIR` | worker | File-backend root. `file` backend only. |
| `LOKI_QUEUE_ONESHOT` | worker | `1` processes one item and exits (KEDA). |
| `LOKI_QUEUE_POLL_SEC` | worker | File-backend empty-poll sleep. |
| `LOKI_QUEUE_BLOCK_SEC` | worker | Redis `BLPOP` block timeout. |

| Receiver route | Purpose |
|---|---|
| `GET /health` | Liveness and readiness. Does not touch the queue. |
| `GET /status` | Port, dry-run state, whether a secret is configured. |
| `POST /webhook` | The GitHub webhook endpoint. |

Source: `autonomy/trigger-server.py`, `autonomy/queue-consumer.sh`,
`helm/loki-mode/values.yaml`.
