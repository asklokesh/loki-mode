# Enterprise Features

Loki Mode v5.51.0 includes a comprehensive enterprise layer for organizations that need observability, governance, audit compliance, and integration with existing toolchains. All enterprise features are opt-in via environment variables -- when not configured, they add zero overhead.

## Documentation Index

### Architecture

**[Enterprise Architecture](../docs/enterprise/architecture.md)** -- System architecture overview including OTEL observability, policy engine, audit trail, integration layer, event bus, and the non-breaking design principles that ensure enterprise features never impact core functionality.

### Security

**[Enterprise Security](../docs/enterprise/security.md)** -- Authentication (token auth, OIDC/SSO), authorization (role-based scopes), API security (TLS, rate limiting, CORS), webhook security (HMAC-SHA256), hash-chained tamper-evident audit logging, syslog forwarding, data residency, and policy engine security.

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

Governance-as-code through declarative YAML or JSON policy files. Four enforcement points (pre-execution, pre-deployment, resource, data) with three decision types (ALLOW, DENY, REQUIRE_APPROVAL). Built-in rules for path boundary enforcement, agent concurrency limits, token budgets, secret detection, and PII scanning.

**Activate:** Create `.loki/policies.yaml` in your project directory.

### Audit Trail

Tamper-evident logging with SHA-256 hash chains. Every agent action and API call is recorded in JSONL format. Supports log rotation, syslog forwarding, and chain integrity verification. Compliance report generation for SOC 2 Type II, ISO 27001, and GDPR.

**Activate:** Enabled by default. Configure syslog with `LOKI_AUDIT_SYSLOG_HOST`.

### Integrations

Bidirectional sync with Jira (epic import, RARV status sync, sub-task creation), Linear (GraphQL API, project sync), and GitHub (PR quality reports, issue summaries, status checks). Slack and Teams notifications for real-time execution updates and approval requests.

**Activate:** Set integration-specific env vars (see Integration Cookbook).

### Control Plane API

RESTful API for managing projects, runs, tasks, tenants, API keys, and audit logs. v2 API adds tenant isolation, structured event timelines, and key rotation with grace periods.

**Activate:** `loki dashboard` starts the API server on port 57374.

### SDKs

Official Python and TypeScript SDKs with zero external dependencies. Type-safe clients for all API endpoints with structured error handling.

**Install:** `pip install autonomi` or `npm install @autonomi/sdk`

## Key Design Principles

1. **Zero overhead when disabled** -- No env var set means no imports, no threads, no I/O.
2. **Non-breaking** -- Enterprise features never change the behavior of the core RARV cycle.
3. **Fail-open for observability** -- OTEL errors are logged, never thrown.
4. **Fail-closed for security** -- Policy denials block execution.
5. **Zero external dependencies** -- All implementations use standard library only.
6. **Local-first data** -- All data stored locally unless explicitly configured otherwise.
