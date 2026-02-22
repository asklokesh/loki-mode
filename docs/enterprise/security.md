# Loki Mode v5.51.0 -- Enterprise Security

## Overview

Loki Mode's security model follows a defense-in-depth approach. All security features are opt-in via environment variables, with sensible defaults that prioritize safety. When enterprise auth is not configured, the system operates in local-only mode with no network exposure.

## Authentication

### Token Authentication

The primary authentication method uses bearer tokens prefixed with `loki_`.

**Configuration:**

```bash
# Enable token auth for the dashboard/control plane API
export LOKI_ENTERPRISE_AUTH=true
```

**Token Lifecycle:**

```bash
# Create a new API key
curl -X POST http://localhost:57374/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "ci-pipeline", "role": "operator"}'

# Rotate a key with 24-hour grace period
curl -X POST http://localhost:57374/api/keys/ci-pipeline/rotate \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"grace_period_hours": 24}'

# Revoke a key
curl -X DELETE http://localhost:57374/api/keys/ci-pipeline \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**SDK Usage:**

Python:
```python
from autonomi import AutonomiClient

client = AutonomiClient(
    base_url="http://localhost:57374",
    token="loki_your_token_here"
)
```

TypeScript:
```typescript
import { AutonomiClient } from '@autonomi/sdk';

const client = new AutonomiClient({
  baseUrl: 'http://localhost:57374',
  token: 'loki_your_token_here'
});
```

### OIDC / SSO Integration

For organizations using identity providers (Okta, Auth0, Azure AD), Loki Mode supports OIDC-based authentication.

**Configuration:**

```bash
export LOKI_OIDC_ISSUER="https://your-idp.okta.com/oauth2/default"
export LOKI_OIDC_CLIENT_ID="your-client-id"
export LOKI_OIDC_CLIENT_SECRET="your-client-secret"
export LOKI_OIDC_REDIRECT_URI="http://localhost:57374/auth/callback"
```

The system validates OIDC tokens against the issuer's JWKS endpoint and maps claims to Loki Mode roles.

## Authorization

### Role-Based Access Control

Four built-in roles provide scoped access:

| Role | Scope | Permissions |
|------|-------|-------------|
| `admin` | Full control | Create/delete tenants, manage API keys, configure policies, all operator/viewer/auditor permissions |
| `operator` | Execution | Start/cancel runs, create/update projects and tasks, read all resources |
| `viewer` | Read-only | Read projects, runs, tasks, status. No write or delete operations |
| `auditor` | Audit access | Read audit logs, verify chain integrity, generate compliance reports. No execution permissions |

**Scope Hierarchy:**

```
admin > operator > viewer
admin > auditor
```

Admin inherits all permissions. Operator inherits viewer permissions. Auditor is a separate branch with read-only access to audit data.

**API Key Scopes:**

API keys are created with a role assignment:

```bash
# Create a viewer key for monitoring dashboards
curl -X POST http://localhost:57374/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name": "grafana-reader", "role": "viewer"}'

# Create an operator key for CI pipelines
curl -X POST http://localhost:57374/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name": "github-actions", "role": "operator"}'
```

## API Security

### TLS Configuration

Enable HTTPS for the dashboard and API:

```bash
export LOKI_TLS_CERT="/path/to/cert.pem"
export LOKI_TLS_KEY="/path/to/key.pem"
```

When both variables are set, the dashboard server binds on HTTPS only. Self-signed certificates are supported for development.

### Rate Limiting

The API enforces rate limits per token/IP:

| Endpoint Group | Default Limit |
|----------------|---------------|
| Read operations | 100 req/min |
| Write operations | 30 req/min |
| Auth operations | 10 req/min |

Rate limit headers are included in every response:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1708520460
```

### CORS

CORS is configured via environment variables:

```bash
export LOKI_CORS_ORIGINS="https://dashboard.company.com,https://admin.company.com"
```

Default behavior: `localhost` origins are allowed for development. In production, explicitly set allowed origins.

## Webhook Security

### HMAC-SHA256 Verification

All outbound webhooks and inbound webhook handlers use HMAC-SHA256 for request authentication.

**Slack Webhooks:**

```bash
export LOKI_SLACK_SIGNING_SECRET="your-slack-signing-secret"
```

Inbound Slack requests are verified using the `X-Slack-Signature` and `X-Slack-Request-Timestamp` headers. The system:
1. Checks timestamp is within 5 minutes (replay attack prevention)
2. Computes `HMAC-SHA256(signing_secret, "v0:" + timestamp + ":" + body)`
3. Compares against the `X-Slack-Signature` header using constant-time comparison

**Microsoft Teams Webhooks:**

```bash
export LOKI_TEAMS_WEBHOOK_SECRET="your-shared-secret"
```

Inbound Teams requests are verified using the shared secret HMAC.

**Fail-Closed Behavior:**

If a webhook signature cannot be verified:
- The request is rejected with HTTP 401
- An audit entry is recorded with `success: false`
- The event is not processed

This is a deliberate fail-closed design. Invalid or missing signatures always result in rejection.

## Audit Logging

### Hash-Chained Tamper-Evident Logs

Audit logs use SHA-256 hash chains for tamper evidence. Each entry's hash depends on the previous entry's hash, creating an immutable chain from the genesis record.

**JavaScript Audit (Agent Actions):**

```
.loki/audit/audit.jsonl
```

Each entry:
```json
{
  "seq": 42,
  "timestamp": "2026-02-21T10:00:00.000Z",
  "who": "agent-1",
  "what": "file_write",
  "where": "src/app.js",
  "why": "implement feature",
  "previousHash": "abc123...",
  "hash": "def456..."
}
```

**Python Audit (Dashboard API):**

```
~/.loki/dashboard/audit/audit-2026-02-21.jsonl
```

Each entry:
```json
{
  "timestamp": "2026-02-21T10:00:00.000Z",
  "action": "create",
  "resource_type": "project",
  "resource_id": "proj-1",
  "user_id": "admin",
  "success": true,
  "_integrity_hash": "abc123..."
}
```

### Chain Verification

JavaScript:
```javascript
const audit = require('./src/audit');
audit.init('/path/to/project');
const result = audit.verifyChain();
// { valid: true, entries: 1542, brokenAt: null, error: null }
```

Python:
```python
from dashboard.audit import verify_log_integrity
result = verify_log_integrity("/path/to/audit-2026-02-21.jsonl")
# {"valid": True, "entries_checked": 1542, "first_tampered_line": None}
```

API:
```bash
curl http://localhost:57374/api/audit/verify \
  -H "Authorization: Bearer $TOKEN"
```

### Syslog Forwarding

Forward audit events to a centralized syslog server for SIEM integration:

```bash
export LOKI_AUDIT_SYSLOG_HOST="syslog.company.com"
export LOKI_AUDIT_SYSLOG_PORT="514"          # default
export LOKI_AUDIT_SYSLOG_PROTO="udp"         # or "tcp"
```

Security-relevant actions (`delete`, `kill`, `stop`, `login`, `logout`, `create_token`, `revoke_token`) are logged at `WARNING` level. All other actions are logged at `INFO` level.

Syslog forwarding is fire-and-forget -- failures never block the main audit write path.

### Log Rotation

```bash
export LOKI_AUDIT_MAX_SIZE_MB="10"    # Rotate when file exceeds this size
export LOKI_AUDIT_MAX_FILES="10"      # Keep this many rotated files
```

Date-based log files (`audit-YYYY-MM-DD.jsonl`) are automatically rotated when they exceed the size limit. Old files are removed when the count exceeds the maximum.

## Data Residency

### Local Data Storage

All Loki Mode data is stored locally on the machine running the system:

| Data Type | Location |
|-----------|----------|
| Project state | `.loki/` (project directory) |
| Audit logs (agent) | `.loki/audit/` |
| Audit logs (dashboard) | `~/.loki/dashboard/audit/` |
| Event bus | `.loki/events/` |
| Memory system | `.loki/memory/` |
| Metrics | `.loki/metrics/` |
| Policy files | `.loki/policies.yaml` or `.loki/policies.json` |
| Configuration | `.loki/config.yaml` or `.loki/config.json` |

No data is transmitted to external services unless explicitly configured (OTEL endpoint, integration webhooks, syslog forwarding).

### Provider Restrictions

The data residency controller restricts which AI providers can be used based on region:

```javascript
const audit = require('./src/audit');
audit.init('/path/to/project');

// Check if a provider is allowed in a region
const allowed = audit.checkProvider('anthropic', 'us');  // true/false

// Check if air-gapped mode is enabled
const airGapped = audit.isAirGapped();
```

Configure via `.loki/config.yaml`:

```yaml
residency:
  allowed_providers:
    - anthropic
    - openai
  allowed_regions:
    - us
    - eu
  air_gapped: false
```

## Policy Engine Security

### Pre-Execution Policy Checks

The policy engine evaluates rules before any agent action executes:

```javascript
const policy = require('./src/policies');
policy.init('/path/to/project');

const result = policy.evaluate('pre_execution', {
  file_path: '/tmp/malicious.sh',
  project_dir: '/home/user/project',
  active_agents: 3,
});

if (!result.allowed) {
  // result.decision === 'DENY' or 'REQUIRE_APPROVAL'
  // result.reason describes the violation
  // result.violations array contains details
  process.exit(1);
}
```

### Path Traversal Protection

The `file_path must start with project_dir` rule uses `path.resolve()` to normalize paths before comparison, preventing traversal attacks like:

```
/project/../etc/passwd    -> resolves to /etc/passwd -> DENIED
/project-evil/secret      -> prefix check with path.sep -> DENIED
```

### Secret Detection

The data policy scanner detects secrets in content before it leaves the system:

- API keys and tokens
- AWS access keys
- Private keys (RSA, EC)
- GitHub personal access tokens
- OpenAI API keys
- Slack bot tokens

When a secret is detected, the policy engine returns `DENY` and the content is not transmitted.

### PII Scanning

Optional PII scanning detects:
- Email addresses
- Social Security Numbers
- Phone numbers
- Credit card numbers

## Security Best Practices

1. **Always enable audit logging in production** -- It is on by default; do not set `LOKI_AUDIT_DISABLED=true` in production.
2. **Use TLS for the dashboard** -- Set `LOKI_TLS_CERT` and `LOKI_TLS_KEY` when the dashboard is network-accessible.
3. **Rotate API keys regularly** -- Use the `/api/keys/{id}/rotate` endpoint with grace periods.
4. **Configure syslog forwarding** -- Forward audit events to your SIEM for centralized monitoring.
5. **Set token budgets** -- Use resource policies to prevent runaway token consumption.
6. **Enable data scanning** -- Configure `data` policies for `secret_detection` to catch accidental credential exposure.
7. **Restrict providers by region** -- Use the data residency controller to enforce compliance with data sovereignty requirements.
8. **Verify audit chain integrity** -- Periodically run `verifyChain()` or call `/api/audit/verify` to detect tampering.
