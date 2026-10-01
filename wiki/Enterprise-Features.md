# Enterprise Features

Comprehensive guide to Loki Mode's enterprise capabilities.

---

## Overview

All enterprise features are **opt-in** and disabled by default. This ensures:
- Zero configuration for individual developers
- No overhead for startups
- Full control for enterprises when needed

---

## Token-Based Authentication

Secure API access with scoped, expiring tokens.

### Enable Authentication

```bash
export LOKI_ENTERPRISE_AUTH=true
```

### Generate Tokens

```bash
# Basic token
loki enterprise token generate my-token

# With scopes and expiration
loki enterprise token generate ci-bot --scopes "read,write" --expires 30
```

**Output:**
```
Token generated successfully!

Name:    ci-bot
ID:      tok-abc123
Token:   loki_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Scopes:  read, write
Expires: 2026-03-02

IMPORTANT: Save this token - it won't be shown again!
```

### Manage Tokens

```bash
# List active tokens
loki enterprise token list

# List all tokens (including revoked)
loki enterprise token list --all

# Revoke a token
loki enterprise token revoke ci-bot
```

### Use Tokens with API

```bash
curl -H "Authorization: Bearer loki_xxx..." \
     http://localhost:57374/api/status
```

### Token Storage

Tokens are stored in `~/.loki/dashboard/tokens.json` with:
- SHA256 hashed token values
- 0600 file permissions
- Constant-time comparison (timing attack protection)

### RBAC Roles (v5.37.1)

Tokens can be assigned roles that map to permission scopes:

| Role | Scopes | Description |
|------|--------|-------------|
| `admin` | `*` (all) | Full access to all endpoints |
| `operator` | `control`, `read`, `write` | Start/stop sessions, manage tasks |
| `viewer` | `read` | Read-only dashboard access |
| `auditor` | `read`, `audit` | Read access plus audit log viewing |

**Scope Hierarchy:**
- `*` includes all scopes
- `control` includes `write` and `read`
- `write` includes `read`

```bash
# Generate a read-only token (the CLI takes scopes; role names resolve to
# scopes only through the dashboard API)
loki enterprise token generate ci-bot --scopes read

# Generate token with custom scopes
loki enterprise token generate admin-bot --scopes "*" --expires 90
```

---

## Audit Logging

Compliance-ready audit trails for all operations.

### Configuration

Audit logging is **enabled by default** since v5.37.0. To disable:

```bash
export LOKI_AUDIT_DISABLED=true
```

### View Audit Logs

```bash
# Summary
loki enterprise audit summary

# Recent entries
loki enterprise audit tail
```

### Audit Log Format

Logs are stored in JSONL format at `~/.loki/dashboard/audit/`:

```json
{
  "timestamp": "2026-02-02T12:00:00Z",
  "action": "session.start",
  "user": "token:ci-bot",
  "resource": "session:sess-123",
  "details": {
    "prd": "my-app.md",
    "provider": "claude"
  },
  "ip": "192.168.1.100"
}
```

### Tracked Actions

| Action | Description |
|--------|-------------|
| `session.start` | Session started |
| `session.stop` | Session stopped |
| `session.pause` | Session paused |
| `token.generate` | Token created |
| `token.revoke` | Token revoked |
| `config.change` | Configuration changed |
| `project.register` | Project registered |
| `task.create` | Task created |
| `task.update` | Task modified |

### API Access

```bash
# Get audit entries
curl -H "Authorization: Bearer $TOKEN" \
     "http://localhost:57374/api/enterprise/audit?limit=100"

# Get summary
curl -H "Authorization: Bearer $TOKEN" \
     "http://localhost:57374/api/enterprise/audit/summary"
```

### Log Rotation

Logs are automatically rotated:
- Daily rotation
- 30-day retention (configurable)
- Compressed archives

---

## TLS/HTTPS (v5.37.0)

Encrypt dashboard API and WebSocket connections.

### Enable TLS

```bash
export LOKI_TLS_CERT=/path/to/cert.pem
export LOKI_TLS_KEY=/path/to/key.pem
loki dashboard start
```

Or via CLI flags:
```bash
loki dashboard start --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

### Self-Signed Certificate (Development)

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/CN=localhost"
export LOKI_TLS_CERT=cert.pem
export LOKI_TLS_KEY=key.pem
```

---

## OIDC/SSO Authentication (v5.37.0)

Enterprise identity provider integration (experimental).

### Enable OIDC

```bash
# Google Workspace
export LOKI_OIDC_ISSUER=https://accounts.google.com
export LOKI_OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com

# Azure AD
export LOKI_OIDC_ISSUER=https://login.microsoftonline.com/{tenant}/v2.0
export LOKI_OIDC_CLIENT_ID=your-application-id

# Okta
export LOKI_OIDC_ISSUER=https://your-org.okta.com
export LOKI_OIDC_CLIENT_ID=your-client-id
```

OIDC works alongside token auth -- both methods can be active simultaneously. OIDC-authenticated users receive full access scopes.

### OIDC Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_OIDC_ISSUER` | - | OIDC issuer URL |
| `LOKI_OIDC_CLIENT_ID` | - | OIDC client/application ID |
| `LOKI_OIDC_AUDIENCE` | *(client_id)* | Expected JWT audience claim |

---

## Branch Protection (v5.38.0)

Auto-create feature branches for agent sessions to prevent direct commits to main.

### Enable Branch Protection

```bash
export LOKI_BRANCH_PROTECTION=true
```

When enabled:
1. Agent sessions create a feature branch: `loki/session-<timestamp>-<pid>`
2. All agent work happens on the feature branch
3. On session end, a PR is created via `gh pr create` (if GitHub CLI is available)
4. Manual review and merge to main

### Agent Action Audit Trail

All agent actions are logged to `.loki/logs/agent-audit.jsonl`:

```json
{
  "timestamp": "2026-02-12T18:30:00Z",
  "action": "git_commit",
  "agent": "development",
  "details": {"message": "Add authentication module", "files_changed": 3}
}
```

View with CLI:
```bash
loki audit log
loki audit count
```

---

## Prometheus Monitoring (v5.38.0)

OpenMetrics-compatible endpoint for monitoring with Prometheus, Grafana, or Datadog.

### Endpoint

```bash
curl http://localhost:57374/metrics
```

### Available Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `loki_session_status` | gauge | 0=stopped, 1=running, 2=paused |
| `loki_iteration_current` | gauge | Current iteration number |
| `loki_iteration_max` | gauge | Max configured iterations |
| `loki_tasks_total{status}` | gauge | Tasks by status |
| `loki_agents_active` | gauge | Active agent count |
| `loki_agents_total` | gauge | Total agents registered |
| `loki_cost_usd` | gauge | Estimated cost in USD |
| `loki_events_total` | counter | Total events recorded |
| `loki_uptime_seconds` | gauge | Session uptime |

### Prometheus Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'loki-mode'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:57374']
```

### Grafana Dashboard

Import metrics into Grafana for visualization:
1. Add Prometheus as a data source
2. Create a new dashboard
3. Add panels for key metrics (session status, cost, tasks)

### CLI

```bash
loki metrics
loki metrics | grep loki_cost_usd
```

---

## Docker Sandbox

Isolated execution environment for security-sensitive deployments.

### Enable Sandbox

```bash
# Via environment
export LOKI_SANDBOX_MODE=true
loki start ./prd.md

# Via CLI flag
loki start ./prd.md --sandbox
```

### Sandbox Commands

```bash
# Start sandbox container
loki sandbox start

# Check status
loki sandbox status

# View logs
loki sandbox logs --follow

# Interactive shell
loki sandbox shell

# Stop sandbox
loki sandbox stop

# Rebuild image
loki sandbox build
```

### Security Features

| Feature | Description |
|---------|-------------|
| **Seccomp Profiles** | System call filtering |
| **Resource Limits** | CPU/memory constraints |
| **Network Isolation** | Restricted network access |
| **Read-only Filesystem** | Immutable base system |
| **Non-root User** | Runs as `appuser` |

### Dockerfile

```dockerfile
FROM python:3.11-slim

# Create non-root user
RUN useradd -m -s /bin/bash appuser

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY --chown=appuser:appuser . /app
WORKDIR /app

# Switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:57374/health')"

EXPOSE 57374
CMD ["python", "-m", "dashboard.server"]
```

---

## Project Registry

Multi-project orchestration and cross-project learning.

### Register Projects

```bash
# Register a project
loki projects register ~/projects/my-app

# Auto-discover projects
loki projects discover

# List registered projects
loki projects list
```

### Project Health

```bash
# Check all projects
loki projects health

# Sync project data
loki projects sync
```

### Cross-Project Tasks

Query tasks across all registered projects:

```bash
curl "http://localhost:57374/api/registry/tasks?status=in_progress"
```

### Shared Learnings

Access learnings from all projects:

```bash
# CLI
loki memory list
loki memory search "authentication"

# API
curl "http://localhost:57374/api/registry/learnings"
```

---

## Staged Autonomy

Approval gates for sensitive operations.

### Enable Staged Autonomy

```bash
export LOKI_STAGED_AUTONOMY=true
```

### Autonomy Modes

| Mode | Description |
|------|-------------|
| `perpetual` | Full autonomy (default) |
| `checkpoint` | Approval at phase boundaries |
| `supervised` | Approval for each operation |

```bash
export LOKI_AUTONOMY_MODE=checkpoint
```

### Manual Approval

When staged autonomy is enabled:

1. Loki pauses before execution
2. Review proposed changes
3. Approve or reject

```bash
# Check pending approvals
loki status

# Approve and continue
loki resume

# Reject and stop
loki stop
```

---

## Path & Command Restrictions

### Allowed Paths (sandbox mount allowlist)

Restrict which host directories the Docker sandbox will bind-mount writable:

```bash
export LOKI_ALLOWED_PATHS="/app/src,/app/tests"
```

**SANDBOX-SCOPED.** Enforced by the Docker sandbox at mount time only:
`autonomy/sandbox.sh:1222` refuses to bind-mount a workspace outside the
allowlist, and `:1315` refuses a custom `--mount` whose host path is outside
it. It does **not** restrict writes the AI provider agent makes inside the
workspace, because `autonomy/run.sh` never observes those commands. Requires
`LOKI_SANDBOX_MODE=true` (default `false`); with sandbox mode off this
variable enforces nothing.

### Blocked Commands (operator CLI only)

Block dangerous commands typed into `loki sandbox run`:

```bash
export LOKI_BLOCKED_COMMANDS="rm -rf /,dd if=,mkfs,shutdown"
```

**SANDBOX-SCOPED.** Checked only against the operator-supplied argv of
`loki sandbox run <cmd>` (`autonomy/sandbox.sh:1517`). It does **not** filter
commands the AI agent issues; those are governed by the provider CLI own
permission model. Requires `LOKI_SANDBOX_MODE=true` (default `false`).

Real containment for agent activity is the Docker sandbox itself
(`autonomy/sandbox.sh`): cap-drop, seccomp, and read-only mounts, plus
optional `LOKI_SANDBOX_NETWORK=none` for full network isolation. Network
defaults to `bridge`.

**Default Blocked:**
- `rm -rf /`
- `dd if=`
- `mkfs`
- `:(){ :|:& };:` (fork bomb)

---

## Enterprise Deployment

### Docker Compose

```yaml
version: '3.8'
services:
  loki-mode:
    image: asklokesh/loki-mode:latest
    ports:
      - "57374:57374"
      - "57374:57374"
    environment:
      - LOKI_ENTERPRISE_AUTH=true
      - LOKI_ENTERPRISE_AUDIT=true
      - LOKI_DASHBOARD_HOST=0.0.0.0
      - LOKI_TLS_CERT=/certs/cert.pem
      - LOKI_TLS_KEY=/certs/key.pem
      - LOKI_BRANCH_PROTECTION=true
    volumes:
      - loki-data:/home/appuser/.loki
      - ./projects:/projects:ro
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:57374/health')"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  loki-data:
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki-mode
spec:
  replicas: 1
  selector:
    matchLabels:
      app: loki-mode
  template:
    metadata:
      labels:
        app: loki-mode
    spec:
      containers:
      - name: loki-mode
        image: asklokesh/loki-mode:latest
        ports:
        - containerPort: 57374
        - containerPort: 57374
        env:
        - name: LOKI_ENTERPRISE_AUTH
          value: "true"
        - name: LOKI_ENTERPRISE_AUDIT
          value: "true"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 57374
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 57374
          initialDelaySeconds: 5
          periodSeconds: 10
```

---

## Best Practices

### Security Checklist

- [ ] Enable `LOKI_ENTERPRISE_AUTH` for API access
- [ ] Enable `LOKI_ENTERPRISE_AUDIT` for compliance
- [ ] Use `LOKI_SANDBOX_MODE` for untrusted code
- [ ] Enable `LOKI_SANDBOX_MODE` first: SANDBOX-SCOPED, so `LOKI_ALLOWED_PATHS`
      and `LOKI_BLOCKED_COMMANDS` enforce nothing without it
- [ ] Set `LOKI_ALLOWED_PATHS` to restrict which host paths the sandbox mounts
      writable (does NOT restrict agent writes inside the workspace)
- [ ] Configure `LOKI_BLOCKED_COMMANDS` for `loki sandbox run` argv (does NOT
      filter agent-issued commands)
- [ ] Set `LOKI_SANDBOX_NETWORK=none` if the run needs no network (default `bridge`)
- [ ] Use `LOKI_STAGED_AUTONOMY` for sensitive ops
- [ ] Rotate tokens regularly
- [ ] Review audit logs periodically
- [ ] Enable `LOKI_TLS_CERT` and `LOKI_TLS_KEY` for HTTPS
- [ ] Configure `LOKI_OIDC_ISSUER` for SSO integration
- [ ] Enable `LOKI_BRANCH_PROTECTION` for feature branch workflow
- [ ] Set up `/metrics` endpoint monitoring
- [ ] Configure syslog forwarding for SIEM integration

### Token Management

- Generate separate tokens for each integration
- Use minimal scopes (principle of least privilege)
- Set expiration dates
- Revoke unused tokens immediately
- Never commit tokens to version control

### Audit Compliance

- Enable audit logging before production use
- Configure log retention per compliance requirements
- Set up log forwarding to SIEM
- Regular audit log review
