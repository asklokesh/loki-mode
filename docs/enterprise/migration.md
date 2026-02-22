# Loki Mode v5.51.0 -- Migration Guide

## Upgrading from v5.50.0 to v5.51.0

### What Changed

v5.50.0 introduced the enterprise protocol layer (P0-1 through P0-9) as foundational infrastructure. v5.51.0 activates the P0.5 wiring that connects these components into a production-ready enterprise system, and adds new capabilities on top.

**Key difference:** In v5.50.0, enterprise features were implemented but required manual integration. In v5.51.0, setting an environment variable is sufficient to activate a feature end-to-end.

### Breaking Changes

**None.** All new features are opt-in via environment variables. Existing configurations continue to work without modification.

### New Features

#### Slack and Microsoft Teams Notifications

Real-time notifications for execution events, approval requests, and quality gate results.

| Feature | Env Var |
|---------|---------|
| Slack bot notifications | `LOKI_SLACK_BOT_TOKEN` |
| Slack webhook verification | `LOKI_SLACK_SIGNING_SECRET` |
| Teams webhook notifications | `LOKI_TEAMS_WEBHOOK_URL` |
| Teams webhook verification | `LOKI_TEAMS_WEBHOOK_SECRET` |

See `docs/enterprise/integration-cookbook.md` for setup guides.

#### Control Plane v2 API

New `/api/v2/` endpoints provide tenant-scoped resource management, run lifecycle control, and structured event timelines.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/tenants` | GET, POST | List and create tenants |
| `/api/v2/tenants/:id` | GET, DELETE | Get or delete a tenant |
| `/api/v2/runs` | GET | List runs (filterable by project, status) |
| `/api/v2/runs/:id` | GET | Get run details |
| `/api/v2/runs/:id/cancel` | POST | Cancel a running execution |
| `/api/v2/runs/:id/replay` | POST | Replay a previous run |
| `/api/v2/runs/:id/timeline` | GET | Get run event timeline |
| `/api/v2/keys` | GET, POST | List and create API keys |
| `/api/v2/keys/:id/rotate` | POST | Rotate an API key |
| `/api/v2/keys/:id` | DELETE | Revoke an API key |
| `/api/v2/audit` | GET | Query audit logs |
| `/api/v2/audit/verify` | GET | Verify audit chain integrity |

The v1 API (`/api/`) continues to work unchanged. The v2 API adds tenant isolation, pagination, and structured error responses.

#### Python and TypeScript SDKs

Official SDKs for programmatic access to the Control Plane API.

**Python SDK (`autonomi`):**
- Zero external dependencies (stdlib only)
- Synchronous client using `urllib`
- Type-safe dataclasses for all API resources

**TypeScript SDK (`@autonomi/sdk`):**
- Zero external dependencies (uses Node.js built-in `fetch`)
- Async/await API
- TypeScript interfaces for all resources

See `docs/enterprise/sdk-guide.md` for installation and usage.

### New Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_SLACK_BOT_TOKEN` | (unset) | Slack Bot User OAuth Token |
| `LOKI_SLACK_SIGNING_SECRET` | (unset) | Slack request signing secret |
| `LOKI_SLACK_CHANNEL` | (unset) | Default Slack channel |
| `LOKI_SLACK_WEBHOOK_URL` | (unset) | Slack Incoming Webhook URL |
| `LOKI_TEAMS_WEBHOOK_URL` | (unset) | Teams Incoming Webhook URL |
| `LOKI_TEAMS_WEBHOOK_SECRET` | (unset) | Teams webhook shared secret |
| `LOKI_OIDC_ISSUER` | (unset) | OIDC identity provider URL |
| `LOKI_OIDC_CLIENT_ID` | (unset) | OIDC client ID |
| `LOKI_OIDC_CLIENT_SECRET` | (unset) | OIDC client secret |
| `LOKI_OIDC_REDIRECT_URI` | (unset) | OIDC redirect URI |
| `LOKI_CORS_ORIGINS` | localhost | Allowed CORS origins |
| `LOKI_API_RATE_LIMIT` | 100 | API rate limit (requests/min) |

### Existing Environment Variables (Unchanged)

These variables from v5.50.0 continue to work identically:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_OTEL_ENDPOINT` | (unset) | OTLP/HTTP endpoint for traces and metrics |
| `LOKI_SERVICE_NAME` | `loki-mode` | Service name for OTEL resource |
| `LOKI_ENTERPRISE_AUTH` | (unset) | Enable token authentication |
| `LOKI_ENTERPRISE_AUDIT` | (unset) | Force-enable audit logging |
| `LOKI_AUDIT_DISABLED` | `false` | Disable audit logging |
| `LOKI_AUDIT_NO_INTEGRITY` | `false` | Disable hash chain integrity |
| `LOKI_AUDIT_MAX_SIZE_MB` | `10` | Audit log rotation size |
| `LOKI_AUDIT_MAX_FILES` | `10` | Max rotated audit files |
| `LOKI_AUDIT_SYSLOG_HOST` | (unset) | Syslog forwarding host |
| `LOKI_AUDIT_SYSLOG_PORT` | `514` | Syslog forwarding port |
| `LOKI_AUDIT_SYSLOG_PROTO` | `udp` | Syslog protocol |
| `LOKI_TLS_CERT` | (unset) | TLS certificate path |
| `LOKI_TLS_KEY` | (unset) | TLS key path |
| `LOKI_JIRA_URL` | (unset) | Jira Cloud base URL |
| `LOKI_JIRA_EMAIL` | (unset) | Jira user email |
| `LOKI_JIRA_TOKEN` | (unset) | Jira API token |
| `LOKI_JIRA_PROJECT_KEY` | (unset) | Default Jira project key |
| `LOKI_LINEAR_API_KEY` | (unset) | Linear API key |
| `LOKI_LINEAR_TEAM_ID` | (unset) | Linear team ID |
| `LOKI_LINEAR_WEBHOOK_SECRET` | (unset) | Linear webhook secret |
| `LOKI_GITHUB_SYNC` | (unset) | Enable GitHub sync |

### API Changes

#### v2 API Additions

The v2 API is a superset of v1 with additional capabilities:

| v1 Endpoint | v2 Endpoint | Changes |
|-------------|-------------|---------|
| `/api/projects` | `/api/v2/projects` | Adds `tenant_id` filter |
| `/api/tasks` | `/api/v2/tasks` | Adds pagination (`limit`, `offset`) |
| `/api/status` | `/api/v2/status` | Adds enterprise feature status |
| (new) | `/api/v2/tenants` | Tenant management |
| (new) | `/api/v2/runs` | Run lifecycle management |
| (new) | `/api/v2/runs/:id/timeline` | Structured event timeline |
| (new) | `/api/v2/keys` | API key management |
| (new) | `/api/v2/keys/:id/rotate` | Key rotation with grace period |
| (new) | `/api/v2/audit` | Audit log queries |
| (new) | `/api/v2/audit/verify` | Chain integrity verification |

#### v1 API Compatibility

All v1 endpoints continue to work without changes. No deprecation is planned for v1 in this release.

### Database Schema Changes

v5.51.0 introduces new models for the Control Plane:

#### Tenant Model

```
Tenant
  id: integer (primary key)
  name: string (unique)
  slug: string (unique, auto-generated)
  description: string (optional)
  created_at: datetime
```

#### Run Model

```
Run
  id: integer (primary key)
  project_id: integer (foreign key -> Project)
  status: string (pending | running | completed | failed | cancelled)
  trigger: string (manual | webhook | schedule)
  config: json (optional)
  started_at: datetime (optional)
  ended_at: datetime (optional)
```

#### RunEvent Model

```
RunEvent
  id: integer (primary key)
  run_id: integer (foreign key -> Run)
  event_type: string (phase_change | quality_gate | agent_action | error)
  phase: string (optional, REASON | ACT | REFLECT | VERIFY)
  details: json (optional)
  timestamp: datetime
```

### Step-by-Step Upgrade Process

#### 1. Update Loki Mode

```bash
# npm
npm update -g loki-mode

# Homebrew
brew update && brew upgrade loki-mode

# Docker
docker pull asklokesh/loki-mode:5.51.0

# Git
cd ~/git/loki-mode && git pull origin main
```

#### 2. Verify Version

```bash
loki version
# Expected: v5.51.0
```

#### 3. Review New Environment Variables

Check if any new features are relevant to your deployment. All new features are opt-in:

```bash
# No env vars needed for basic operation
# Set these only if you want the features:

# Slack notifications
export LOKI_SLACK_BOT_TOKEN="xoxb-..."
export LOKI_SLACK_SIGNING_SECRET="..."

# Teams notifications
export LOKI_TEAMS_WEBHOOK_URL="https://..."

# OIDC authentication
export LOKI_OIDC_ISSUER="https://..."
```

#### 4. Install SDKs (Optional)

```bash
# Python SDK
pip install autonomi

# TypeScript SDK
npm install @autonomi/sdk
```

#### 5. Test Enterprise Features

```bash
# Start dashboard
loki dashboard

# Test API
curl http://localhost:57374/api/status

# Test audit
curl http://localhost:57374/api/audit?limit=5

# Verify audit chain
curl http://localhost:57374/api/audit/verify
```

#### 6. Update CI/CD Pipelines (if applicable)

If you use the GitHub Action, update the version:

```yaml
- uses: asklokesh/loki-mode@v5.51.0
```

### Rollback

If issues arise, rolling back to v5.50.0 is safe:

```bash
# npm
npm install -g loki-mode@5.50.0

# Homebrew
brew install loki-mode@5.50.0

# Docker
docker pull asklokesh/loki-mode:5.50.0
```

No data migration is needed. The v5.51.0 database schema additions are backward-compatible -- v5.50.0 ignores the new tables/columns.
