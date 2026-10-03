# Module 2: Enterprise Features

> **Control Plane migration:** the classic dashboard UI and port 57374 are removed in Loki Mode 10.8; the UI is the Control Plane (`loki dashboard`, default port 47821). Examples below that use port 57374 or `/api/*` describe the legacy API server. See [control-plane-migration.md](../../control-plane-migration.md) for the `/v1/*` mapping and what is not yet available.

## Overview

Loki Mode includes enterprise features for audit logging, observability, authentication, and SIEM integration. These features are controlled via environment variables and can be enabled incrementally.

## Audit Logging

Audit logging records all agent actions for compliance and forensic analysis. As of v5.38.0, audit logging is **enabled by default**. It can be disabled with `LOKI_AUDIT_DISABLED=true`.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_AUDIT_DISABLED` | `false` | Set to `true` to disable audit logging |
| `LOKI_ENTERPRISE_AUDIT` | `false` | Legacy variable to force audit on (superseded by default-on behavior) |
| `LOKI_AUDIT_LOG` | `true` | Enable/disable audit log file writing |

### CLI Commands

The `loki audit` command provides access to the audit log:

```bash
loki audit            # Show recent audit entries
loki audit help       # Show audit subcommands
```

The `loki enterprise` command manages enterprise features:

```bash
loki enterprise status    # Show enterprise feature status
loki enterprise help      # Show available enterprise commands
```

### Audit Log Contents

Audit entries record:
- Timestamp of each agent action
- Agent identity and type
- Action taken (file read, file write, command execution, etc.)
- Target resource (file path, endpoint, etc.)
- Outcome (success/failure)

## SIEM Integration (v5.38.0)

Loki Mode can forward audit logs to enterprise SIEM systems via syslog. Supported platforms include Splunk, IBM QRadar, Elastic SIEM, Datadog Security Monitoring, and others. Full configuration details are in `docs/siem-integration.md`.

### Syslog Forwarding

Enable syslog forwarding by setting these environment variables:

```bash
export LOKI_AUDIT_SYSLOG_HOST=syslog.example.com
export LOKI_AUDIT_SYSLOG_PORT=514
export LOKI_AUDIT_SYSLOG_PROTO=udp

loki start ./prd.md
```

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_AUDIT_SYSLOG_HOST` | (none) | Syslog server hostname or IP |
| `LOKI_AUDIT_SYSLOG_PORT` | `514` | Syslog server port |
| `LOKI_AUDIT_SYSLOG_PROTO` | `udp` | Protocol: `udp` or `tcp` |
| `LOKI_SYSLOG_FACILITY` | `local0` | Syslog facility (local0-local7) |

## OpenTelemetry (OTEL) Observability

Loki Mode supports OpenTelemetry for distributed tracing and metrics. OTEL is **lazy-loaded** -- it only initializes when `LOKI_OTEL_ENDPOINT` is set.

### Enabling OTEL

```bash
export LOKI_OTEL_ENDPOINT=http://localhost:4318
loki start ./prd.md
```

When OTEL is not configured, Loki Mode uses no-op stubs that add zero overhead. When enabled, it exports traces and metrics to the configured OTLP endpoint.

The OTEL implementation is in `src/observability/otel.js` with a conditional loader in `src/observability/index.js`. A bridge process (`src/observability/otel-bridge.js`) can forward events from the file-based event bus to OTEL.

### Prometheus Metrics

The `loki metrics` command exposes Prometheus/OpenMetrics formatted metrics from the dashboard:

```bash
loki metrics          # Display all metrics
loki metrics --help   # Show options
```

These metrics can be scraped by Prometheus or any OpenMetrics-compatible collector.

## Token Authentication (Enterprise)

Loki Mode supports token-based API authentication for the dashboard API server. This is opt-in and requires `LOKI_ENTERPRISE_AUTH=true`.

### Enabling Authentication

```bash
export LOKI_ENTERPRISE_AUTH=true
loki start ./prd.md
```

### Managing Tokens

```bash
# Generate a new API token
loki enterprise token generate my-token-name

# Generate with specific options
loki enterprise token generate my-token --scopes '*' --expires 30
```

When authentication is enabled, all dashboard API requests must include a valid token.

## OIDC Integration

For organizations using SSO, Loki Mode supports OIDC (OpenID Connect) authentication:

| Variable | Description |
|----------|-------------|
| `LOKI_OIDC_ISSUER` | OIDC issuer URL (e.g., `https://accounts.google.com`) |
| `LOKI_OIDC_CLIENT_ID` | OIDC client/application ID |
| `LOKI_OIDC_AUDIENCE` | Expected JWT audience (defaults to client_id) |

These variables are documented in the `autonomy/run.sh` header. OIDC validation requires a running dashboard API server.

## Dashboard

The Loki Mode dashboard provides a web-based UI for monitoring sessions, viewing task queues, inspecting memory, and observing agent activity.

```bash
loki dashboard start    # Start the dashboard server
loki dashboard stop     # Stop the dashboard server
loki dashboard status   # Check if dashboard is running
loki dashboard open     # Open dashboard in browser
loki dashboard url      # Print the dashboard URL
```

The dashboard runs on port 57374 by default (`LOKI_DASHBOARD_PORT`). TLS can be enabled with:

```bash
export LOKI_TLS_CERT=/path/to/cert.pem
export LOKI_TLS_KEY=/path/to/key.pem
```

## Security Controls

Loki Mode provides several security controls for enterprise environments:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_SANDBOX_MODE` | `false` | Run in Docker sandbox for isolation |
| `LOKI_ALLOWED_PATHS` | (all) | SANDBOX-SCOPED: host paths the sandbox may mount writable. Does NOT restrict agent writes. |
| `LOKI_BLOCKED_COMMANDS` | `rm -rf /,dd if=,mkfs,...` | SANDBOX-SCOPED: blocked `loki sandbox run` argv. Does NOT filter agent-issued commands. |
| `LOKI_MAX_PARALLEL_AGENTS` | `10` | Limit concurrent agent spawning |
| `LOKI_STAGED_AUTONOMY` | `false` | Require approval before execution |
| `LOKI_PROMPT_INJECTION` | `false` | Allow prompt injection via `HUMAN_INPUT.md` (disabled by default for security) |

### Docker Sandbox

Run Loki Mode in an isolated Docker container:

```bash
loki sandbox start     # Start sandbox container
loki sandbox stop      # Stop sandbox container
loki sandbox status    # Check sandbox status
loki sandbox shell     # Open shell in sandbox
loki sandbox logs      # View sandbox logs
```

Or via the start command:

```bash
loki start --sandbox ./prd.md
```

## Notifications

Loki Mode supports notifications to external services:

```bash
loki notify test       # Send a test notification
loki notify slack      # Send to Slack
loki notify discord    # Send to Discord
loki notify webhook    # Send to a webhook URL
loki notify status     # Check notification configuration
```

## Summary

Enterprise features in Loki Mode are designed to be opt-in and incrementally adoptable. Audit logging is on by default. OTEL, SIEM integration, token authentication, and OIDC are activated through environment variables. The dashboard provides a web UI for monitoring, and Docker sandbox mode provides execution isolation.
