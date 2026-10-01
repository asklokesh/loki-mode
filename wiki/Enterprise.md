# Enterprise Features

Loki Mode includes an enterprise layer (since v5.51.0) for organizations that need observability, governance, audit logging, and integration with existing toolchains. All enterprise features are opt-in via environment variables -- when not configured, they add zero overhead.

## Documentation Index

### Architecture

**[Enterprise Architecture](../docs/enterprise/architecture.md)** -- System architecture overview including OTEL observability, policy engine, audit trail, integration layer, event bus, and the non-breaking design principles that ensure enterprise features never impact core functionality.

### Security

**[Enterprise Security](../docs/enterprise/security.md)** -- Authentication (token auth, OIDC/SSO), authorization (role-based scopes, enforced by `require_scope` on the dashboard API and active only when `LOKI_ENTERPRISE_AUTH` or OIDC is configured; with auth disabled every scope check returns allow, which is the default posture), API security (TLS, rate limiting, CORS), webhook security (HMAC-SHA256), hash-chained audit logging (detects corruption and truncation; NOT tamper-proof against an adversary with write access to the log -- see `docs/AUDIT-CHAIN-THREAT-MODEL.md`), syslog forwarding, data residency, and policy engine security.

### Performance

**[Performance Tuning](../docs/enterprise/performance.md)** -- Tuning guides for OTEL sampling and batching, policy engine caching, event bus throughput, audit log rotation, memory system token economics, and background process resource usage.

### Integrations

**[Integration Cookbook](../docs/enterprise/integration-cookbook.md)** -- Step-by-step setup guides for Slack, Microsoft Teams, Jira, Linear, and GitHub integrations. Each guide includes prerequisites, environment variables, configuration steps, verification commands, and troubleshooting tables.

### Migration

**[Migration Guide](../docs/enterprise/migration.md)** -- Upgrade guide from v5.50.0 to v5.51.0 covering new features, env var reference, API changes, database schema additions, and the step-by-step upgrade process.

### SDKs

**[SDK Guide](../docs/enterprise/sdk-guide.md)** -- Python and TypeScript SDK quickstart, client method reference, error handling patterns, and common usage patterns including pagination, filtering, webhook processing, and audit verification.

## Feature Overview

### Observability (OTEL)

OpenTelemetry instrumentation with zero-dependency OTLP/HTTP+JSON export. Provides distributed traces across the RARV cycle, quality gates, agent lifecycle, and completion council. Metrics include task duration histograms, quality gate counters, active agent gauges, and token consumption tracking.

**Activate:** `export LOKI_OTEL_ENDPOINT="http://your-collector:4318"`

### Policy Engine

Governance-as-code through declarative YAML or JSON policy files, evaluated by `src/policies/engine.js` with three decision types (ALLOW, DENY, REQUIRE_APPROVAL). The runner calls it at one point today, `pre_execution`, before each iteration (`check_policy` in `autonomy/run.sh`); REQUIRE_APPROVAL is logged but not yet blocking.

**Activate:** Create `.loki/policies.yaml` in your project directory.

### Audit Trail

Hash-chained logging with SHA-256. Every API call is recorded in JSONL format. Supports log rotation, syslog forwarding, and chain integrity verification.

The chain detects corruption and truncation. It is NOT tamper-proof: the hash is unkeyed and the genesis value is a constant (`dashboard/audit.py:58,194-200`), so anyone who can write the log can recompute a consistent chain over invented history. This is reproduced in `docs/AUDIT-CHAIN-THREAT-MODEL.md`. An intact chain is not evidence of integrity against a motivated writer; a broken one is good evidence of a problem.

`GET /api/compliance?type=soc2|iso27001|gdpr` summarizes the agent audit log in those report layouts. This is not a compliance certification or attestation; Loki Mode holds none.

**Activate:** Enabled by default. Configure syslog with `LOKI_AUDIT_SYSLOG_HOST`.

### Integrations

One-way status sync from Loki to Jira, Linear and GitHub (`src/integrations/sync-subscriber.js`; changes are not pulled back). Slack and Teams notifications for execution updates.

**Activate:** Set integration-specific env vars (see Integration Cookbook).

### Control Plane API

RESTful API for managing projects, runs, tasks, tenants, API keys, and audit logs. v2 API adds tenant isolation, structured event timelines, and key rotation with grace periods.

**Activate:** `loki dashboard` starts the API server on port 57374.

### SDKs

Official Python and TypeScript SDKs with zero external dependencies. Type-safe clients for all API endpoints with structured error handling.

**Install:** `pip install loki-mode-sdk` or `npm install loki-mode-sdk`

## Key Design Principles

1. **Zero overhead when disabled** -- No env var set means no imports, no threads, no I/O.
2. **Non-breaking** -- Enterprise features never change the behavior of the core RARV cycle.
3. **Fail-open for observability** -- OTEL errors are logged, never thrown.
4. **Fail-closed for security** -- Policy denials block execution.
5. **Zero external dependencies** -- All implementations use standard library only.
6. **Local-first data** -- All data stored locally unless explicitly configured otherwise.
