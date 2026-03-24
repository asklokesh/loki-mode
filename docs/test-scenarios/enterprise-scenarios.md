# Enterprise Scenarios - Agent 13

50 enterprise-grade scenarios covering team workflows, git integration, CI/CD,
security/compliance, and production deployment. Each scenario references actual
codebase paths and infrastructure definitions verified during authoring.

---

## 1. Team Workflow Scenarios

### TW-01: Team Lead Assigns Project via Dashboard API

```
GIVEN the dashboard is running with LOKI_ENTERPRISE_AUTH=true
  AND a team lead has a token with role "admin" (scopes: ["*"])
  AND a developer has a token with role "operator" (scopes: ["control","read","write"])
WHEN the team lead POST /api/projects with a PRD and assigns the developer
THEN the project is created (HTTP 201)
  AND the developer can view it via GET /api/projects (scope "read")
  AND the developer can start a build via POST /api/control/start (scope "control")
  AND the project appears in the developer dashboard within 5 seconds
```
Source: `dashboard/server.py:781`, `dashboard/auth.py:42-47`

### TW-02: Multiple Developers Iterating via Concurrent Sessions

```
GIVEN two developers (Dev-A, Dev-B) each have operator tokens
  AND both have cloned the same repository
WHEN Dev-A runs "loki start --session dev-a ./feature-a.md"
  AND Dev-B runs "loki start --session dev-b ./feature-b.md"
THEN both sessions appear in GET /api/status under "sessions" list
  AND each session has a unique PID under .loki/sessions/<id>/loki.pid
  AND Dev-A pause/stop only affects session "dev-a"
  AND Dev-B pause/stop only affects session "dev-b"
```
Source: `dashboard/server.py:638-683` (concurrent session discovery)

### TW-03: Code Review Within Loki Quality Gates

```
GIVEN a PR is opened on a repository with loki-ci-example.yml workflow
  AND the PR changes 5 files across 2 modules
WHEN GitHub Actions triggers "Loki CI Quality Gate" job
THEN "loki ci --pr --fail-on critical,high --format markdown" executes
  AND critical/high severity issues block the PR merge
  AND a markdown report is posted as a PR comment
  AND the CI exits non-zero if any blocking issue is found
```
Source: `.github/workflows/loki-ci-example.yml:41-44`

### TW-04: Handoff Between Human and AI Coding

```
GIVEN a loki autonomous session is running (iteration 5 of 20)
  AND the human developer notices a design issue
WHEN the developer creates .loki/PAUSE signal file
THEN the session pauses after the current RARV iteration completes
  AND status shows "paused" via GET /api/status
WHEN the developer modifies code manually and removes .loki/PAUSE
THEN the session resumes from the next iteration
  AND the modified files are picked up in the next build_prompt() call
```
Source: `autonomy/run.sh:7897` (check_human_intervention)

### TW-05: Project Template Sharing Across Team

```
GIVEN the team uses loki templates (13 types: saas, cli, discord-bot, etc.)
  AND the team lead wants to standardize on a custom template
WHEN the lead creates a PRD template at templates/custom-team.md
  AND commits it to the shared repository
THEN all team members can run "loki start --template custom-team ./my-prd.md"
  AND the template is listed via "loki template list"
  AND the template variables are interpolated correctly
```
Source: `templates/` directory (13 templates)

### TW-06: Team-Wide Quality Gate Configuration

```
GIVEN the team configures quality gates via .loki/config/quality-gates.json
  AND the config sets: { "coverage_threshold": 85, "max_critical": 0 }
WHEN any team member runs "loki audit test"
THEN coverage below 85% fails the gate (exit 1)
  AND zero critical issues are tolerated
  AND the 3-reviewer parallel system is invoked for code changes
  AND anti-sycophancy checks activate on unanimous approval
```
Source: `skills/quality-gates.md`, `autonomy/run.sh:4935` (run_code_review)

### TW-07: Shared Provider API Key Management via K8s Secrets

```
GIVEN the team deploys Autonomi via Helm chart
  AND API keys are stored in an existing Kubernetes Secret "team-api-keys"
WHEN the Helm chart is installed with:
     secrets.existingSecret=team-api-keys
THEN the controlplane and worker deployments mount "team-api-keys" as envFrom
  AND no Secret resource is created by the chart (template is skipped)
  AND all pods receive ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY
```
Source: `deploy/helm/autonomi/templates/secret.yaml:1`, `deploy/helm/autonomi/values.yaml:172`

### TW-08: Team Metrics Dashboard Usage

```
GIVEN the dashboard is running with Prometheus scrape annotations
  AND the production values enable:
     podAnnotations:
       prometheus.io/scrape: "true"
       prometheus.io/port: "57374"
       prometheus.io/path: "/metrics"
WHEN Prometheus scrapes /metrics on port 57374
THEN response includes RARV iteration counts, task completion rates, and API latency
  AND Grafana dashboards can visualize team velocity
```
Source: `deploy/helm/autonomi/values-production.yaml:16-19`

### TW-09: Onboarding New Team Member to Existing Project

```
GIVEN an admin has a running Autonomi deployment
  AND a new developer needs read-only access
WHEN the admin calls POST /api/enterprise/tokens with:
     { "name": "new-dev", "role": "viewer" }
THEN a token is generated with scopes: ["read"]
  AND the new developer can GET /api/status, GET /api/projects
  AND POST /api/control/pause returns HTTP 403 (insufficient permissions)
  AND POST /api/projects returns HTTP 403 (requires "control" scope)
```
Source: `dashboard/auth.py:42-47`, `dashboard/server.py:1719`

### TW-10: Team Lead Monitoring Multiple Active Builds

```
GIVEN the team lead has admin access to the dashboard
  AND three sessions are running across two worktrees
WHEN the lead calls GET /api/status
THEN the response includes sessions: [{session_id, pid, started_at, worktree}]
  AND active_sessions count equals 3
  AND each session shows its current RARV phase and iteration number
WHEN the lead calls POST /api/control/stop with session_id="session-2"
THEN only session-2 is stopped; sessions 1 and 3 continue
```
Source: `dashboard/server.py:638-683`

### TW-11: Role-Based Access Enforcement (Admin/Operator/Viewer/Auditor)

```
GIVEN four tokens exist with roles: admin, operator, viewer, auditor
WHEN the viewer token calls POST /api/control/pause
THEN HTTP 403 is returned (viewer has only "read" scope)
WHEN the operator token calls POST /api/control/pause
THEN HTTP 200 is returned (operator has "control" scope)
WHEN the auditor token calls GET /api/enterprise/audit
THEN HTTP 200 is returned (auditor has "audit" scope)
WHEN the auditor token calls POST /api/enterprise/tokens
THEN HTTP 403 is returned (auditor lacks "admin" scope)
WHEN the admin token calls POST /api/enterprise/tokens
THEN HTTP 200 is returned (admin has "*" scope, which grants all)
```
Source: `dashboard/auth.py:42-57` (ROLES and _SCOPE_HIERARCHY)

### TW-12: Team Notification Preferences via Slack/Teams

```
GIVEN the deployment has LOKI_SLACK_BOT_TOKEN configured
  AND LOKI_TEAMS_WEBHOOK_URL is also configured
WHEN a build completes successfully
THEN a Slack notification is sent via the bot token
  AND a Teams notification is sent via the webhook URL
WHEN a team member calls PUT /api/notifications/triggers with custom thresholds
THEN future notifications respect the updated trigger configuration
```
Source: `deploy/docker-compose/docker-compose.yml:34-38`, `dashboard/server.py:3387`

---

## 2. Git Integration Scenarios

### GI-01: Branch Creation from Loki Parallel Workflows

```
GIVEN a PRD specifies 3 parallel work streams
  AND the repository has a clean main branch
WHEN "loki start --parallel" is invoked
THEN 3 git worktrees are created under .claude/worktrees/
  AND each worktree has a branch named loki/stream-<n>
  AND branches do not conflict with each other
  AND "git worktree list" shows all 3 worktrees
```
Source: `skills/parallel-workflows.md`

### GI-02: Meaningful AI Commit Messages

```
GIVEN a loki session has completed a RARV iteration
  AND the iteration modified 4 files
WHEN the autonomous system commits changes
THEN the commit message follows the format: "<type>: <description>"
  AND the type is one of: feat, fix, refactor, test, docs, chore
  AND the message does not contain emojis (hard rule from CLAUDE.md)
  AND the commit is signed with the configured user identity
```
Source: `CLAUDE.md` (Git Commit Workflow section)

### GI-03: PR Creation with Description via GitHub Integration

```
GIVEN the loki-enterprise.yml workflow is triggered by an issue labeled "loki-mode"
  AND the issue contains a feature request
WHEN Loki Mode completes execution
THEN the report job posts results back to the issue
  AND a PR is created with a description summarizing the changes
  AND the PR references the original issue number
```
Source: `.github/workflows/loki-enterprise.yml:165-226`

### GI-04: Merge Conflict Detection During Parallel Streams

```
GIVEN two parallel worktrees (stream-1, stream-2) both modify src/index.ts
WHEN the auto-merge phase runs after both streams complete
THEN a merge conflict is detected
  AND the system attempts 3-way merge resolution
  AND if resolution fails, the conflict is flagged for human review
  AND the human receives a notification via the configured channel
```
Source: `skills/parallel-workflows.md`

### GI-05: Git Hooks Interaction with Loki CI

```
GIVEN the repository has a pre-commit hook running ESLint
  AND Loki Mode generates code with a lint warning
WHEN Loki Mode attempts to commit
THEN the pre-commit hook runs and may fail
  AND Loki Mode detects the hook failure (non-zero exit)
  AND Loki Mode fixes the lint issue in the next RARV iteration
  AND a NEW commit is created (never --amend on hook failure)
```
Source: `CLAUDE.md` (Git Operations section)

### GI-06: Monorepo Support with Multiple Package Detection

```
GIVEN a monorepo with packages/frontend and packages/backend
  AND the PRD requests changes to both packages
WHEN "loki start ./prd.md" runs detect_complexity()
THEN the complexity is detected as "complex" (multi-package)
  AND the system creates separate task queue entries per package
  AND quality gates run independently per package
  AND the final commit includes changes from all packages
```
Source: `autonomy/run.sh:1182` (detect_complexity)

### GI-07: Submodule Handling During Autonomous Execution

```
GIVEN the repository has git submodules defined in .gitmodules
WHEN Loki Mode clones/initializes the workspace
THEN submodules are initialized with "git submodule update --init"
  AND the submodule code is available for analysis
  AND Loki Mode does NOT modify submodule contents
  AND commits do not accidentally include submodule pointer changes
```

### GI-08: Large File (LFS) Awareness

```
GIVEN the repository uses Git LFS for *.bin and *.model files
  AND the PRD generates a new ML model file
WHEN Loki Mode creates the file
THEN LFS tracking is respected (file matches .gitattributes patterns)
  AND "git lfs ls-files" shows the new file
  AND the commit does not store the binary in the git object store
```

### GI-09: Branch Protection Rules Interaction

```
GIVEN the main branch has protection rules:
     - Require PR reviews (1 reviewer)
     - Require status checks to pass
WHEN Loki Mode completes and attempts to push to main
THEN the push is rejected (branch protection blocks direct push)
  AND Loki Mode creates a PR from the working branch instead
  AND the CI status checks run on the PR
```

### GI-10: Fork Safety in Enterprise Workflow

```
GIVEN the loki-enterprise.yml workflow is triggered by a PR review
  AND the PR originates from a forked repository
WHEN the "Verify actor trust for fork PRs" step runs
THEN the workflow exits with error code 1
  AND the message "Skipping execution: pull_request_review from a fork repository is not trusted" is logged
  AND no Loki Mode execution occurs (prevents untrusted code execution)
```
Source: `.github/workflows/loki-enterprise.yml:107-120`

---

## 3. CI/CD Scenarios

### CI-01: GitHub Actions Triggered by Loki Push

```
GIVEN the repository has the release.yml workflow
  AND a version bump is committed to the VERSION file on main
WHEN the push triggers the Release workflow
THEN a git tag "v<VERSION>" is created
  AND a GitHub Release is created with 5 artifacts:
     - loki-mode-<ver>.zip (Claude.ai upload)
     - loki-mode-<ver>.skill (skill file)
     - loki-mode-api-<ver>.zip (API package)
     - loki-mode-claude-code-<ver>.zip (full package)
     - loki-mode-claude-code-<ver>.tar.gz (full package)
  AND downstream jobs trigger: npm, Docker, VSCode, Homebrew, Slack
```
Source: `.github/workflows/release.yml:1-148`

### CI-02: Test Results Across Multiple Runtimes

```
GIVEN the test.yml workflow triggers on push to main or PR
WHEN the workflow runs
THEN Node.js tests execute on versions 18, 20, 22 (matrix strategy)
  AND Python tests execute on versions 3.10, 3.11, 3.12, 3.13
  AND shell tests run via tests/run-all-tests.sh
  AND Helm chart linting passes via "helm lint deploy/helm/autonomi"
  AND dashboard frontend build verification completes (output > 100KB)
  AND all jobs use fail-fast: false (all versions tested even if one fails)
```
Source: `.github/workflows/test.yml`

### CI-03: Docker Build and Multi-Tag Push

```
GIVEN the release workflow's publish-docker job runs
  AND DOCKERHUB_USERNAME and DOCKERHUB_TOKEN secrets are configured
WHEN the job builds the Docker image
THEN dashboard frontend is rebuilt first (npm ci && npm run build:all)
  AND dashboard/static/index.html existence is verified
  AND the image is pushed with three tags:
     - asklokesh/loki-mode:v<VERSION>
     - asklokesh/loki-mode:<VERSION>
     - asklokesh/loki-mode:latest
  AND Docker Hub description is updated from DOCKER_README.md
```
Source: `.github/workflows/release.yml:333-378`

### CI-04: Rollback on Failed Deployment

```
GIVEN a Helm-deployed production environment with values-production.yaml
  AND the current deployment is healthy (readiness probe passing)
WHEN a new version is deployed with "helm upgrade autonomi ./deploy/helm/autonomi"
  AND the new version fails readiness probes (3 consecutive failures)
THEN Kubernetes rolls back to the previous ReplicaSet
  AND the PodDisruptionBudget ensures minAvailable: 1 is maintained
  AND the failed deployment is visible in "helm history autonomi"
```
Source: `deploy/helm/autonomi/values-ha.yaml:61-63`, `deploy/helm/autonomi/templates/pdb.yaml`

### CI-05: Staging vs Production Environment Configuration

```
GIVEN two Helm value files: values.yaml (staging) and values-production.yaml
WHEN staging is deployed with default values
THEN controlplane.replicas=1, worker.replicas=1, autoscaling.enabled=false
  AND logLevel=INFO, maxWorkers=4, networkPolicy.enabled=false
WHEN production is deployed with values-production.yaml
THEN controlplane.replicas=2, worker.replicas=3, autoscaling.enabled=true
  AND logLevel=WARNING, maxWorkers=8, networkPolicy.enabled=true
  AND Prometheus scrape annotations are present on pods
```
Source: `deploy/helm/autonomi/values.yaml`, `deploy/helm/autonomi/values-production.yaml`

### CI-06: Environment Variable Management via ConfigMap

```
GIVEN the Helm chart creates a ConfigMap with config values
WHEN the ConfigMap is updated (e.g., LOKI_LOG_LEVEL changed from INFO to DEBUG)
THEN the deployment template detects the change via:
     checksum/config annotation (sha256 of configmap.yaml)
  AND a rolling restart is triggered automatically
  AND no manual pod deletion is needed
```
Source: `deploy/helm/autonomi/templates/deployment-controlplane.yaml:16`

### CI-07: Secret Management with External Secrets

```
GIVEN the team uses an external secret manager (Vault, AWS Secrets Manager)
  AND an ExternalSecret CRD syncs secrets to K8s Secret "team-api-keys"
WHEN the Helm chart is installed with:
     secrets.existingSecret=team-api-keys
THEN the chart does NOT create its own Secret
  AND both controlplane and worker reference "team-api-keys" via envFrom
  AND API keys are never stored in Helm values or version control
```
Source: `deploy/helm/autonomi/templates/secret.yaml:1` (conditional on existingSecret)

### CI-08: Build Caching in CI Pipeline

```
GIVEN the test.yml workflow has dashboard-build job
  AND it uses actions/setup-node with cache: npm
WHEN the job runs
THEN npm dependencies are cached via cache-dependency-path: dashboard-ui/package-lock.json
  AND subsequent runs skip "npm ci" download phase
  AND build verification checks output size > 100KB
```
Source: `.github/workflows/test.yml:116-117`

### CI-09: Multi-Channel Release Pipeline

```
GIVEN the release.yml workflow detects a new version
WHEN all release jobs execute
THEN the following channels are updated in parallel:
     - npm: publish with NODE_AUTH_TOKEN
     - Docker: build, push, update description
     - VSCode: compile, package .vsix, publish to marketplace
     - Homebrew: compute SHA256 of tarball, update formula via API
     - Python SDK: sync version, build wheel, publish to PyPI
     - TypeScript SDK: sync version, build, publish to npm
     - Slack: post release notification with changelog
  AND Homebrew update waits for npm and Docker (dependency chain)
```
Source: `.github/workflows/release.yml:238-496`

### CI-10: Pipeline Status via WebSocket Updates

```
GIVEN the dashboard WebSocket endpoint is available at /ws
  AND a CI pipeline is running a loki session
WHEN the WebSocket client connects
THEN real-time events are streamed including:
     - iteration_start / iteration_complete
     - task_queued / task_completed
     - quality_gate_passed / quality_gate_failed
     - build_progress (cost, ETA, phase data)
  AND the client receives JSON-formatted events
```
Source: `dashboard/server.py` (WebSocket endpoint)

---

## 4. Security and Compliance Scenarios

### SC-01: API Token Generation and Rotation

```
GIVEN enterprise auth is enabled (LOKI_ENTERPRISE_AUTH=true)
  AND an admin token exists
WHEN the admin calls POST /api/enterprise/tokens with:
     { "name": "ci-token", "role": "operator", "expires_days": 90 }
THEN a token "loki_<urlsafe_base64>" is generated
  AND the token hash is stored with a random 16-byte salt
  AND the raw token is returned only once (never stored in plaintext)
  AND after 90 days, the token validation returns None (expired)
WHEN the admin calls DELETE /api/enterprise/tokens/ci-token
THEN the token is permanently deleted from tokens.json
  AND subsequent requests with the token return HTTP 401
```
Source: `dashboard/auth.py:173-256`

### SC-02: Session Timeout via Token Expiration

```
GIVEN a token was created with expires_days=1
  AND 25 hours have elapsed since creation
WHEN a request is made with the expired token
THEN validate_token() checks expires_at against current UTC time
  AND returns None (token expired)
  AND the API responds with HTTP 401: "Invalid, expired, or revoked token"
```
Source: `dashboard/auth.py:376-379`

### SC-03: Audit Log for All AI Actions

```
GIVEN LOKI_AUDIT_ENABLED=true in the deployment
  AND audit logs are persisted to /data/audit/audit.log (via PVC)
WHEN any control action is performed (start, pause, stop, force-review)
THEN the action is logged with timestamp, actor (token name), and action details
  AND auditors can query via GET /api/enterprise/audit (requires "audit" scope)
  AND GET /api/enterprise/audit/summary provides aggregated statistics
```
Source: `dashboard/server.py:1816-1848`, `deploy/helm/autonomi/values.yaml:152-154`

### SC-04: Data Retention via Persistent Volume Claims

```
GIVEN the Helm chart creates PVCs for checkpoints and audit logs
  AND production values set: checkpoints=50Gi, auditLogs=100Gi
WHEN the deployment runs for 6 months
THEN checkpoint data is stored on the checkpoints PVC (/data/checkpoints)
  AND audit logs are stored on the audit-logs PVC (/data/audit)
  AND PVCs persist across pod restarts and upgrades
  AND cleanup policies are managed externally (not by the chart)
```
Source: `deploy/helm/autonomi/templates/pvc-checkpoints.yaml`, `deploy/helm/autonomi/templates/pvc-audit.yaml`

### SC-05: Sensitive Data Detection in Generated Code

```
GIVEN Loki Mode generates code that includes a hardcoded API key
WHEN the quality gate system runs static analysis
THEN the sensitive data detector flags the hardcoded secret
  AND the quality gate returns severity "critical"
  AND the build is blocked (critical issues block by default)
  AND the next RARV iteration is instructed to extract the key to environment variables
```
Source: `skills/quality-gates.md`

### SC-06: Network Isolation via NetworkPolicy

```
GIVEN the Helm chart is deployed with security.networkPolicy.enabled=true
WHEN the NetworkPolicies are applied
THEN the controlplane accepts ingress only on port 57374 (from any source in namespace)
  AND the controlplane allows all egress (needs to call LLM APIs)
  AND workers accept ingress ONLY from controlplane pods
  AND workers allow all egress (needs to call LLM APIs)
  AND inter-worker communication is blocked by default
```
Source: `deploy/helm/autonomi/templates/networkpolicy.yaml`

### SC-07: Rate Limiting Per Endpoint Category

```
GIVEN the dashboard has two rate limiters:
     - _control_limiter: max_calls=10, window_seconds=60
     - _read_limiter: max_calls=60, window_seconds=60
WHEN a client sends 11 control requests (POST /api/control/pause) within 60 seconds
THEN the 11th request is rejected with HTTP 429 (Too Many Requests)
WHEN a client sends 61 read requests (GET /api/status) within 60 seconds
THEN the 61st request is rejected with HTTP 429
  AND the rate limit resets after the 60-second window
```
Source: `dashboard/server.py:101-141`

### SC-08: Input Sanitization for PRD Content

```
GIVEN the loki-enterprise.yml workflow receives PRD content from user input
WHEN the workflow processes the input
THEN PRD content is written via environment variable (not shell interpolation):
     printf '%s' "$PRD_CONTENT" > "$PRD_FILE"
  AND this prevents shell injection attacks in the PRD content
  AND the temp file is cleaned up after execution
```
Source: `.github/workflows/loki-enterprise.yml:133-135`

### SC-09: CORS Configuration for Dashboard

```
GIVEN the dashboard defaults CORS to localhost only:
     "http://localhost:57374,http://127.0.0.1:57374"
WHEN LOKI_DASHBOARD_CORS is set to "https://internal.company.com"
THEN only requests from https://internal.company.com are allowed
  AND requests from other origins receive no CORS headers
WHEN LOKI_DASHBOARD_CORS is set to "*"
THEN a warning is logged: "all origins are allowed"
  AND all origins are accepted (insecure, not recommended for production)
```
Source: `dashboard/server.py:445-461`

### SC-10: Container Security Hardening

```
GIVEN the Dockerfile.sandbox is used for production deployment
WHEN the container starts
THEN it runs as non-root user (UID 1000)
  AND SUID/SGID binaries have been stripped
  AND shell history is disabled (HISTFILE=/dev/null)
  AND the health check verifies: loki CLI, workspace writable, node available
  AND operators are advised to use:
     --security-opt=no-new-privileges:true
     --cap-drop=ALL --cap-add=CHOWN,SETUID,SETGID,DAC_OVERRIDE
     --cpus=2 --memory=4g --pids-limit=256
```
Source: `Dockerfile.sandbox:141-268`

---

## 5. Production Deployment Scenarios

### PD-01: Self-Hosted K8s Deployment via Helm

```
GIVEN a Kubernetes cluster with Helm 3 installed
WHEN the operator runs:
     helm install autonomi ./deploy/helm/autonomi \
       -f deploy/helm/autonomi/values-production.yaml \
       --set secrets.existingSecret=my-api-keys
THEN the following resources are created:
     - ServiceAccount (automountServiceAccountToken: false at SA level)
     - ConfigMap with runtime configuration
     - Controlplane Deployment (2 replicas, 500m-2 CPU, 1-2Gi memory)
     - Worker Deployment (3 replicas with HPA, 1-4 CPU, 2-4Gi memory)
     - HPA for workers (minReplicas: 3, maxReplicas: 10)
     - Services (ClusterIP for controlplane, headless for workers)
     - PVCs for checkpoints (50Gi) and audit logs (100Gi)
     - NetworkPolicy (restricts worker ingress to controlplane only)
     - RBAC Role+RoleBinding (pods, logs, configmaps, events)
```
Source: `deploy/helm/autonomi/` (full chart)

### PD-02: Helm Chart Value Override Chain

```
GIVEN three value files exist: values.yaml, values-production.yaml, values-ha.yaml
WHEN the operator deploys HA production:
     helm install autonomi ./deploy/helm/autonomi \
       -f values-production.yaml \
       -f values-ha.yaml
THEN values-ha.yaml overrides production settings:
     controlplane.replicas: 3 (was 2)
     worker.replicas: 5 (was 3)
     worker.autoscaling.maxReplicas: 20 (was 10)
     PDB enabled with minAvailable: 1
  AND anti-affinity ensures controlplane pods spread across nodes
```
Source: `deploy/helm/autonomi/values-ha.yaml`

### PD-03: Horizontal Scaling via HPA

```
GIVEN the worker HPA is enabled with:
     minReplicas: 3, maxReplicas: 10
     targetCPUUtilizationPercentage: 70
     targetMemoryUtilizationPercentage: 80
WHEN worker CPU utilization exceeds 70%
THEN the HPA scales up worker replicas (up to 10)
  AND new workers join the RARV execution pool
WHEN CPU utilization drops below 70%
THEN the HPA scales down (minimum 3 replicas maintained)
  AND the scale-down is gradual (default stabilization window)
```
Source: `deploy/helm/autonomi/templates/hpa-worker.yaml`

### PD-04: Health Check and Readiness Probes

```
GIVEN the controlplane deployment has readiness and liveness probes
WHEN the controlplane starts
THEN the readiness probe checks GET /health:57374 after 10s delay
  AND the readiness probe runs every 15s with 5s timeout, 3 failure threshold
  AND the liveness probe checks GET /health:57374 after 15s delay
  AND the liveness probe runs every 20s with 5s timeout, 5 failure threshold
WHEN the worker starts
THEN the worker liveness probe checks: pgrep -f "loki" (process alive)
  AND the worker readiness probe checks: test -f /tmp/loki-ready (ready file)
  AND Helm test pods verify connectivity via curl to /health and /api/status
```
Source: `deploy/helm/autonomi/templates/deployment-controlplane.yaml:49-64`, `deploy/helm/autonomi/templates/deployment-worker.yaml:49-68`

### PD-05: Log Aggregation via OTEL Collector

```
GIVEN the docker-compose deployment includes the observability profile
WHEN started with "docker compose --profile observability up -d"
THEN an OTEL collector (v0.96.0) receives OTLP traces on ports 4317 (gRPC) and 4318 (HTTP)
  AND traces are batched (timeout: 5s, batch_size: 1024)
  AND traces are forwarded to Jaeger (port 4317, insecure TLS)
  AND Jaeger UI is available at http://localhost:16686
  AND traces include RARV iteration spans, API request spans, and LLM call spans
```
Source: `deploy/docker-compose/docker-compose.yml:57-79`, `deploy/docker-compose/otel-config.yaml`

### PD-06: Prometheus Metrics Collection

```
GIVEN the production values include Prometheus scrape annotations
  AND the Helm chart supports ServiceMonitor (observability.serviceMonitor)
WHEN Prometheus is configured to scrape the namespace
THEN pods are discovered via annotations:
     prometheus.io/scrape: "true"
     prometheus.io/port: "57374"
     prometheus.io/path: "/metrics"
  AND metrics include request latency, active sessions, task completion counts
  AND ServiceMonitor can be enabled for prometheus-operator setups
```
Source: `deploy/helm/autonomi/values-production.yaml:16-19`, `deploy/helm/autonomi/values.yaml:186-191`

### PD-07: Backup and Disaster Recovery via PVCs

```
GIVEN the deployment uses PVCs for checkpoints and audit logs
  AND the HA values set checkpoints to 100Gi with ReadWriteMany access
WHEN a disaster recovery scenario requires data restoration
THEN checkpoints PVC (/data/checkpoints) contains all session state snapshots
  AND audit-logs PVC (/data/audit) contains the complete audit trail
  AND PVCs can be backed up using standard K8s backup tools (Velero, etc.)
  AND restoring PVCs and redeploying recovers the full system state
```
Source: `deploy/helm/autonomi/values-ha.yaml:44-52`

### PD-08: Zero-Downtime Upgrade Path

```
GIVEN a production deployment with PDB enabled (minAvailable: 1)
  AND controlplane has 3 replicas with pod anti-affinity
WHEN "helm upgrade autonomi" is executed with a new image tag
THEN the rolling update proceeds one pod at a time
  AND the PDB prevents more than (replicas - 1) pods from being unavailable
  AND the configmap/secret checksum annotations trigger rolling restarts
  AND if the new version fails probes, the rollout pauses automatically
  AND "helm rollback autonomi 1" restores the previous version
```
Source: `deploy/helm/autonomi/templates/pdb.yaml`, `deploy/helm/autonomi/values-ha.yaml:7-19`

---

## Appendix: Bug Cross-References

The following bugs were discovered during scenario authoring and are documented
in full in `docs/bug-fixes/agent-13-enterprise-fixes.md`:

| ID | Severity | Summary |
|----|----------|---------|
| BUG-E01 | Medium | Helm Chart appVersion "5.52.0" vs actual version 6.71.1 |
| BUG-E02 | Low | automountServiceAccountToken conflict between SA and Deployment |
| BUG-E03 | Low | Agent card reports "sso": false but OIDC/SSO is implemented |
| BUG-E04 | Low | Worker deployment missing audit-logs volume mount |
| BUG-E05 | Medium | Helm test test-health.yaml expects python3 in curl image |
