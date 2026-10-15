# Loki Mode Enterprise Security

> **Control Plane migration:** the classic dashboard UI and port 57374 are removed in Loki Mode 10.8; the UI is the Control Plane (`loki dashboard`, default port 47821). Examples below that use port 57374 or `/api/*` describe the legacy API server. See [control-plane-migration.md](../control-plane-migration.md) for the `/v1/*` mapping and what is not yet available.

## Overview

Loki Mode's security model follows a defense-in-depth approach. All security features are opt-in via environment variables, with sensible defaults that prioritize safety. When enterprise auth is not configured, the system operates in local-only mode with no network exposure.

## Authentication and Authorization

Token auth (`LOKI_ENTERPRISE_AUTH`), key rotation with a 24-hour grace period, OIDC/SSO claim mapping and the default viewer role are documented in [authentication.md](../authentication.md). Roles (`admin`, `operator`, `viewer`, `auditor`), scope hierarchy and API key scopes are in [authorization.md](../authorization.md).

## API Security

### TLS Configuration

Enable HTTPS for the dashboard and API:

```bash
export LOKI_TLS_CERT="/path/to/cert.pem"
export LOKI_TLS_KEY="/path/to/key.pem"
```

When both variables are set, the dashboard server binds on HTTPS only. Self-signed certificates are supported for development.

### Rate Limiting

The dashboard API applies in-process rate limits (`_RateLimiter` in
`dashboard/server.py`): 10 requests/min on control endpoints and 60
requests/min on rate-limited read endpoints. Exceeding them returns HTTP 429.
The limits are not configurable by environment variable, and no
`X-RateLimit-*` headers are sent.

### CORS

CORS is configured via environment variables:

```bash
export LOKI_DASHBOARD_CORS="https://dashboard.company.com,https://admin.company.com"
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

Hash-chained audit logs, chain verification, syslog forwarding (`LOKI_AUDIT_SYSLOG_*`) and rotation (`LOKI_AUDIT_MAX_SIZE_MB`, `LOKI_AUDIT_MAX_FILES`) are documented in [audit-logging.md](../audit-logging.md).

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

Beyond model inference (required unless you run a local-weights provider), anonymous telemetry (on by default for individual interactive installs, auto-off in CI, non-interactive and `LOKI_ENTERPRISE=true` / `LOKI_AIRGAP=true` contexts) and a daily update check, no data is transmitted to external services unless explicitly configured (OTEL endpoint, integration webhooks, syslog forwarding). `loki doctor --airgap` prints the egress inventory for the current configuration.

### Provider Restrictions

The data residency controller (`src/audit/residency.js`, configured in `.loki/residency.json`) answers whether a provider is allowed by a region or air-gapped policy. It is a library check: `loki start` does not consult it today, so setting `air_gapped: true` does not by itself stop a run from calling a hosted provider. Use `loki doctor --airgap` and network policy to enforce that.

```javascript
const audit = require('./src/audit');
audit.init('/path/to/project');

// Check if a provider is allowed in a region
const allowed = audit.checkProvider('anthropic', 'us');  // true/false

// Check if air-gapped mode is enabled
const airGapped = audit.isAirGapped();
```

Configure via `.loki/residency.json` (the file `residency.js` reads):

```json
{
  "allowed_providers": ["anthropic", "openai"],
  "allowed_regions": ["us", "eu"],
  "air_gapped": false
}
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
