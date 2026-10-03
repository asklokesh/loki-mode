# Module 2 Lab: Configure Enterprise Features

> **Control Plane migration:** the classic dashboard UI and port 57374 are removed in Loki Mode 10.8; the UI is the Control Plane (`loki dashboard`, default port 47821). Examples below that use port 57374 or `/api/*` describe the legacy API server. See [control-plane-migration.md](../../control-plane-migration.md) for the `/v1/*` mapping and what is not yet available.

## Objective

Enable and verify enterprise features: audit logging, OTEL observability, token authentication, and dashboard TLS.

## Prerequisites

- Loki Mode installed (`npm install -g loki-mode`)
- `loki doctor` passing
- `jq` installed for JSON inspection

## Step 1: Verify Audit Logging Is Active

Audit logging is enabled by default. Verify its status:

```bash
loki enterprise status
```

The output should show audit logging as enabled.

Start a session briefly to generate audit entries:

```bash
# Create a minimal project directory
mkdir -p /tmp/enterprise-lab && cd /tmp/enterprise-lab
git init

# Check audit status
loki enterprise audit status
```

**Note:** Viewing actual audit log entries requires a running session that has performed agent actions. The audit log records actions taken during `loki start`.

## Step 2: Explore Audit Configuration

Review the available audit environment variables:

```bash
# These are the key audit variables:
# LOKI_AUDIT_DISABLED=true     -- Disable audit logging
# LOKI_AUDIT_SYSLOG_HOST       -- Enable syslog forwarding
# LOKI_AUDIT_SYSLOG_PORT       -- Syslog port (default: 514)
# LOKI_AUDIT_SYSLOG_PROTO      -- Syslog protocol: udp or tcp
```

To temporarily disable audit logging (not recommended for production):

```bash
LOKI_AUDIT_DISABLED=true loki enterprise status
```

## Step 3: Check OTEL Readiness

OTEL is lazy-loaded. Verify the conditional loading behavior:

```bash
# Without OTEL endpoint -- should report no OTEL
loki enterprise status

# To enable OTEL (requires a running OTLP collector):
# export LOKI_OTEL_ENDPOINT=http://localhost:4318
# loki start ./prd.md
```

**Note:** Actually sending OTEL data requires a running OTLP-compatible collector (such as the OpenTelemetry Collector, Jaeger, or Grafana Tempo) on the specified endpoint.

## Step 4: Generate an API Token

Enable enterprise authentication and generate a token:

```bash
# Enable token auth
export LOKI_ENTERPRISE_AUTH=true

# Generate a token
loki enterprise token generate lab-test-token

# Generate with expiration
loki enterprise token generate lab-expires --expires 7
```

**Note:** Token authentication requires the dashboard API server to be running (`loki dashboard start` or `loki serve`). Without a running server, token generation creates the token but there is no API to authenticate against.

## Step 5: Start and Inspect the Dashboard

```bash
# Start the dashboard server
loki dashboard start

# Check if it is running
loki dashboard status

# Get the URL
loki dashboard url

# Open in browser (macOS/Linux)
loki dashboard open
```

The dashboard should be accessible at `http://localhost:57374`.

## Step 6: Inspect Metrics

While the dashboard is running:

```bash
# View Prometheus-format metrics
loki metrics
```

This outputs metrics in OpenMetrics format suitable for Prometheus scraping.

## Step 7: Review SIEM Integration Options

Read the SIEM integration documentation:

```bash
# The full guide is at docs/siem-integration.md in the Loki Mode installation
# Key platforms supported:
# - Splunk
# - IBM QRadar
# - Elastic SIEM
# - Datadog Security Monitoring
```

To configure syslog forwarding (requires an actual syslog server):

```bash
export LOKI_AUDIT_SYSLOG_HOST=your-syslog-server.example.com
export LOKI_AUDIT_SYSLOG_PORT=514
export LOKI_AUDIT_SYSLOG_PROTO=tcp
```

## Verification Checklist

- [ ] `loki enterprise status` shows audit logging enabled
- [ ] You understand the difference between `LOKI_AUDIT_DISABLED` and `LOKI_ENTERPRISE_AUDIT`
- [ ] You know which environment variable activates OTEL (`LOKI_OTEL_ENDPOINT`)
- [ ] You can generate an enterprise token with `loki enterprise token generate`
- [ ] `loki dashboard status` correctly reports whether the dashboard is running
- [ ] `loki metrics` outputs Prometheus-format metrics

## Cleanup

```bash
loki dashboard stop
cd ~
rm -rf /tmp/enterprise-lab
unset LOKI_ENTERPRISE_AUTH
```
