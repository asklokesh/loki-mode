# Enterprise Setup Guide

Quick setup guide for enabling Loki Mode enterprise features. All features are opt-in -- set the relevant environment variables to activate.

## Minimal Setup

The fastest way to get enterprise features running:

```bash
# 1. Start the dashboard (Control Plane API)
loki dashboard

# 2. Verify it is running
curl http://localhost:57374/api/status
```

That is all you need. Audit logging is enabled by default. The API serves on port 57374.

## Feature Activation Checklist

Check the features you need and set the corresponding environment variables.

### Observability (OTEL)

```bash
# Required: Point to your OTEL collector
export LOKI_OTEL_ENDPOINT="http://localhost:4318"

# Optional: Custom service name (default: loki-mode)
export LOKI_SERVICE_NAME="loki-mode-prod"
```

**What you get:** Distributed traces for the RARV cycle, quality gates, agent lifecycle, and council reviews. Prometheus-compatible metrics (task duration, gate results, token consumption).

**Verify:**
```bash
# Check OTEL is active
curl http://localhost:57374/api/status | python3 -c "import sys,json; print(json.load(sys.stdin))"
```

### Policy Engine

Create a `.loki/policies.yaml` file in your project:

```yaml
policies:
  pre_execution:
    - name: project-boundary
      rule: "file_path must start with project_dir"
      action: deny

  resource:
    - name: token-budget
      max_tokens: 1000000
      alerts: [50, 80, 95]
      on_exceed: require_approval

  data:
    - name: secret-scan
      type: secret_detection
      action: deny
```

No env var needed -- the engine auto-detects the policy file.

**Verify:**
```bash
# Check policies are loaded
node -e "
  const p = require('./src/policies');
  p.init('.');
  console.log('Policies loaded:', p.hasPolicies());
"
```

### Audit Logging

Enabled by default. Configure optional features:

```bash
# Syslog forwarding
export LOKI_AUDIT_SYSLOG_HOST="syslog.company.com"
export LOKI_AUDIT_SYSLOG_PORT="514"
export LOKI_AUDIT_SYSLOG_PROTO="udp"

# Log rotation (defaults shown)
export LOKI_AUDIT_MAX_SIZE_MB="10"
export LOKI_AUDIT_MAX_FILES="10"
```

**Verify:**
```bash
# Check audit is enabled
curl http://localhost:57374/api/audit?limit=5

# Verify chain integrity
curl http://localhost:57374/api/audit/verify
```

### Authentication

```bash
# Enable token auth
export LOKI_ENTERPRISE_AUTH=true

# Create an admin API key (first time only)
curl -X POST http://localhost:57374/api/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "admin", "role": "admin"}'
# Save the returned token
```

### TLS

```bash
export LOKI_TLS_CERT="/path/to/cert.pem"
export LOKI_TLS_KEY="/path/to/key.pem"
```

### Jira Integration

```bash
export LOKI_JIRA_URL="https://company.atlassian.net"
export LOKI_JIRA_EMAIL="user@company.com"
export LOKI_JIRA_TOKEN="your-api-token"
export LOKI_JIRA_PROJECT_KEY="PROJ"
```

**Verify:**
```bash
curl -u "$LOKI_JIRA_EMAIL:$LOKI_JIRA_TOKEN" \
  "$LOKI_JIRA_URL/rest/api/3/myself"
```

### Linear Integration

```bash
export LOKI_LINEAR_API_KEY="lin_api_your_key"
export LOKI_LINEAR_TEAM_ID="your-team-id"
```

**Verify:**
```bash
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LOKI_LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ viewer { id name } }"}'
```

### GitHub Integration

```bash
export LOKI_GITHUB_SYNC="true"
# GITHUB_TOKEN is typically set by GitHub Actions automatically
```

### Slack Notifications

```bash
export LOKI_SLACK_BOT_TOKEN="xoxb-your-bot-token"
export LOKI_SLACK_SIGNING_SECRET="your-signing-secret"
export LOKI_SLACK_CHANNEL="#loki-alerts"
```

**Verify:**
```bash
curl -H "Authorization: Bearer $LOKI_SLACK_BOT_TOKEN" \
  https://slack.com/api/auth.test
```

### Microsoft Teams Notifications

```bash
export LOKI_TEAMS_WEBHOOK_URL="https://your-tenant.webhook.office.com/..."
```

**Verify:**
```bash
curl -X POST "$LOKI_TEAMS_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"text": "Loki Mode test"}'
```

## Environment Variable Reference

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_OTEL_ENDPOINT` | -- | OTLP/HTTP endpoint |
| `LOKI_SERVICE_NAME` | `loki-mode` | OTEL service name |
| `LOKI_ENTERPRISE_AUTH` | -- | Enable token auth |
| `LOKI_TLS_CERT` | -- | TLS certificate path |
| `LOKI_TLS_KEY` | -- | TLS key path |
| `LOKI_CORS_ORIGINS` | localhost | Allowed CORS origins |
| `LOKI_API_RATE_LIMIT` | 100 | Requests per minute |

### Audit

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_AUDIT_DISABLED` | `false` | Disable audit logging |
| `LOKI_ENTERPRISE_AUDIT` | -- | Force-enable audit |
| `LOKI_AUDIT_NO_INTEGRITY` | `false` | Disable hash chain |
| `LOKI_AUDIT_MAX_SIZE_MB` | `10` | Log rotation size |
| `LOKI_AUDIT_MAX_FILES` | `10` | Max rotated files |
| `LOKI_AUDIT_SYSLOG_HOST` | -- | Syslog host |
| `LOKI_AUDIT_SYSLOG_PORT` | `514` | Syslog port |
| `LOKI_AUDIT_SYSLOG_PROTO` | `udp` | Syslog protocol |

### OIDC

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_OIDC_ISSUER` | -- | OIDC issuer URL |
| `LOKI_OIDC_CLIENT_ID` | -- | OIDC client ID |
| `LOKI_OIDC_CLIENT_SECRET` | -- | OIDC client secret |
| `LOKI_OIDC_REDIRECT_URI` | -- | OIDC redirect URI |

### Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_JIRA_URL` | -- | Jira base URL |
| `LOKI_JIRA_EMAIL` | -- | Jira user email |
| `LOKI_JIRA_TOKEN` | -- | Jira API token |
| `LOKI_JIRA_PROJECT_KEY` | -- | Default project key |
| `LOKI_LINEAR_API_KEY` | -- | Linear API key |
| `LOKI_LINEAR_TEAM_ID` | -- | Linear team ID |
| `LOKI_LINEAR_WEBHOOK_SECRET` | -- | Linear webhook secret |
| `LOKI_GITHUB_SYNC` | -- | Enable GitHub sync |
| `LOKI_SLACK_BOT_TOKEN` | -- | Slack bot token |
| `LOKI_SLACK_SIGNING_SECRET` | -- | Slack signing secret |
| `LOKI_SLACK_CHANNEL` | -- | Default Slack channel |
| `LOKI_SLACK_WEBHOOK_URL` | -- | Slack webhook URL |
| `LOKI_TEAMS_WEBHOOK_URL` | -- | Teams webhook URL |
| `LOKI_TEAMS_WEBHOOK_SECRET` | -- | Teams webhook secret |

## SDKs

Install the official SDKs for programmatic access:

```bash
# Python (zero dependencies, Python 3.9+)
pip install autonomi

# TypeScript (zero dependencies, Node.js 18+)
npm install @autonomi/sdk
```

See [SDK Guide](../docs/enterprise/sdk-guide.md) for usage examples.

## Next Steps

- [Architecture Overview](../docs/enterprise/architecture.md) -- Understand how components connect
- [Security Documentation](../docs/enterprise/security.md) -- Configure auth, TLS, and audit
- [Integration Cookbook](../docs/enterprise/integration-cookbook.md) -- Connect to Jira, Linear, Slack, Teams
- [Performance Tuning](../docs/enterprise/performance.md) -- Optimize for production workloads
- [Migration Guide](../docs/enterprise/migration.md) -- Upgrade from previous versions
