# Metrics Guide

Prometheus and OpenMetrics monitoring for Loki Mode (v5.38.0).

## Overview

Loki Mode exposes a `/metrics` endpoint that returns production-ready metrics in Prometheus/OpenMetrics text format. This enables integration with:

- Prometheus
- Grafana
- Datadog
- New Relic
- Elastic APM
- Any OpenMetrics-compatible monitoring system

## Quick Start

The `/metrics` endpoint is served by the dashboard and needs no enabling flag.
Start the dashboard and scrape it.

```bash
# Start the dashboard (serves /metrics)
loki dashboard start

# View metrics
curl http://localhost:57374/metrics

# Or use CLI
loki metrics
```

## Metrics Endpoint

```
GET http://localhost:57374/metrics
Content-Type: text/plain; version=0.0.4
```

Returns metrics in OpenMetrics text format. No authentication required by default (configure reverse proxy auth for production).

## Available Metrics

### Session Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `loki_session_status` | gauge | Current session status: 0=stopped, 1=running, 2=paused |
| `loki_iteration_current` | gauge | Current iteration number |
| `loki_iteration_max` | gauge | Maximum configured iterations (from LOKI_MAX_ITERATIONS) |
| `loki_uptime_seconds` | gauge | Seconds since session started |

### Task Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `loki_tasks_total` | gauge | `status` | Number of tasks by status: pending, in_progress, completed, failed |

### Agent Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `loki_agents_active` | gauge | Number of currently active agents |
| `loki_agents_total` | gauge | Total number of registered agents |

### Cost Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `loki_cost_usd` | gauge | Estimated total session cost in USD |

### Event Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `loki_events_total` | counter | Total number of events recorded in events.jsonl |

### Evidence Receipt Metrics

The verification surface, exposed so an operator can alert on it. Two failures
make the receipt guarantee worthless in production and neither was observable
before these existed: builds silently stopping producing receipts, and the
`unknown` share climbing.

| Metric | Type | Description |
|--------|------|-------------|
| `loki_receipts_total` | gauge | Evidence Receipts on disk for the active project |
| `loki_receipts_by_verdict{verdict=...}` | gauge | Receipts bucketed on the recorded honesty headline: `verified`, `with_gaps`, `not_verified`, `unknown` |
| `loki_receipts_with_provenance{kind=...}` | gauge | Receipts carrying a checkable provenance record: `attestation` (Ed25519 JWT) or `gpg` |

`unknown` IS ITS OWN SERIES and must stay that way. The summary refuses to
count a receipt as verified when it cannot prove it was -- schema v1.0 receipts
carry no honesty block -- so folding that bucket into `verified` is dishonest
and folding it into `not_verified` is alarming and also wrong.

These read the same files as `GET /api/proofs/summary`, so the metric and the
API cannot disagree; a test asserts it. An empty project reports `0`, not an
error, so a fresh install does not look like a broken exporter.

Example alerts:

```
# receipts stopped being produced
increase(loki_receipts_total[6h]) == 0

# the unverifiable share is growing
loki_receipts_by_verdict{verdict="unknown"} / loki_receipts_total > 0.2
```

## Data Sources

Metrics are derived from `.loki/` flat files:

| File | Metrics |
|------|---------|
| `dashboard-state.json` | session_status, iteration_current, iteration_max, tasks_total, agents_active |
| `loki.pid` | session_status (PID alive check fallback), uptime_seconds |
| `state/agents.json` | agents_total |
| `metrics/efficiency/*.json` | cost_usd |
| `events.jsonl` | events_total (line count) |

## CLI Usage

```bash
# Fetch all metrics
loki metrics

# Filter specific metric
loki metrics | grep loki_cost_usd

# Watch metrics in real-time
watch -n 5 loki metrics

# Custom dashboard host/port
loki metrics --host 192.168.1.100 --port 8080
```

## Prometheus Configuration

### Basic Scrape Config

Add to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'loki-mode'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:57374']
        labels:
          environment: 'production'
          project: 'my-app'
```

### With TLS/HTTPS

```yaml
scrape_configs:
  - job_name: 'loki-mode'
    scheme: https
    tls_config:
      insecure_skip_verify: true  # For self-signed certs
    static_configs:
      - targets: ['localhost:57374']
```

### With Authentication (via reverse proxy)

```yaml
scrape_configs:
  - job_name: 'loki-mode'
    scheme: https
    bearer_token: 'loki_xxx...'
    static_configs:
      - targets: ['dashboard.example.com:443']
```

### Service Discovery (Kubernetes)

```yaml
scrape_configs:
  - job_name: 'loki-mode'
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
            - loki
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        action: keep
        regex: loki-mode
      - source_labels: [__meta_kubernetes_pod_ip]
        target_label: __address__
        replacement: $1:57374
```

## Grafana Integration

### Add Prometheus Data Source

1. Navigate to Configuration > Data Sources
2. Click "Add data source"
3. Select "Prometheus"
4. URL: `http://prometheus-server:9090`
5. Save & Test

### Create Dashboard

Import the Loki Mode dashboard template or create custom panels:

#### Panel 1: Session Status

- **Type:** Stat
- **Query:** `loki_session_status`
- **Value Mappings:**
  - 0 = Stopped (Red)
  - 1 = Running (Green)
  - 2 = Paused (Yellow)

#### Panel 2: Iteration Progress

- **Type:** Gauge
- **Query:** `loki_iteration_current / loki_iteration_max * 100`
- **Unit:** Percent (0-100)
- **Thresholds:** 0-50 (yellow), 50-100 (green)

#### Panel 3: Task Distribution

- **Type:** Pie chart
- **Query:** `loki_tasks_total`
- **Legend:** `{{status}}`

#### Panel 4: Agent Activity

- **Type:** Time series
- **Query:** `loki_agents_active`
- **Legend:** Active Agents

#### Panel 5: Cost Tracking

- **Type:** Stat
- **Query:** `loki_cost_usd`
- **Unit:** Currency (USD)
- **Decimals:** 2

#### Panel 6: Event Rate

- **Type:** Graph
- **Query:** `rate(loki_events_total[5m])`
- **Legend:** Events per second

#### Panel 7: Uptime

- **Type:** Stat
- **Query:** `loki_uptime_seconds`
- **Unit:** Duration (seconds)

### Example PromQL Queries

```promql
# Session is running
loki_session_status == 1

# Iteration progress percentage
loki_iteration_current / loki_iteration_max * 100

# Total pending + in-progress tasks
loki_tasks_total{status="pending"} + loki_tasks_total{status="in_progress"}

# Cost per hour
rate(loki_cost_usd[1h]) * 3600

# Event rate (events per minute)
rate(loki_events_total[5m]) * 60

# Task completion rate
rate(loki_tasks_total{status="completed"}[10m])

# Failed task ratio
loki_tasks_total{status="failed"} / sum(loki_tasks_total)
```

## Datadog Integration

### Configure OpenMetrics Check

Create `/etc/datadog-agent/conf.d/openmetrics.d/loki_mode.yaml`:

```yaml
instances:
  - prometheus_url: http://localhost:57374/metrics
    namespace: loki
    metrics:
      - loki_session_status
      - loki_iteration_current
      - loki_iteration_max
      - loki_tasks_total
      - loki_agents_active
      - loki_agents_total
      - loki_cost_usd
      - loki_events_total
      - loki_uptime_seconds
    tags:
      - environment:production
      - service:loki-mode
```

Restart Datadog Agent:

```bash
sudo systemctl restart datadog-agent
```

### Datadog Dashboards

View metrics in Datadog:
- Navigate to Dashboards > New Dashboard
- Add widgets with queries like `loki.session_status`, `loki.cost_usd`
- Set up monitors for cost thresholds and session failures

## Alerting

### Prometheus Alert Rules

Create `loki_alerts.yml`:

```yaml
groups:
  - name: loki-mode
    interval: 30s
    rules:
      - alert: LokiSessionDown
        expr: loki_session_status == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Loki Mode session is not running"
          description: "Session has been stopped for more than 5 minutes"

      - alert: LokiBudgetWarning
        expr: loki_cost_usd > 4.00
        labels:
          severity: warning
        annotations:
          summary: "Loki Mode cost approaching budget limit"
          description: "Current cost: ${{ $value }}"

      - alert: LokiBudgetCritical
        expr: loki_cost_usd > 4.50
        labels:
          severity: critical
        annotations:
          summary: "Loki Mode cost exceeds budget"
          description: "Current cost: ${{ $value }}, budget: $5.00"

      - alert: LokiStagnation
        expr: changes(loki_iteration_current[30m]) == 0 and loki_session_status == 1
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Loki Mode iteration not progressing"
          description: "No iteration progress in 30 minutes"

      - alert: LokiHighFailureRate
        expr: loki_tasks_total{status="failed"} / sum(loki_tasks_total) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High task failure rate"
          description: "{{ $value | humanizePercentage }} of tasks are failing"

      - alert: LokiTooManyAgents
        expr: loki_agents_active > 50
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Too many active agents"
          description: "{{ $value }} agents active, may indicate runaway spawning"
```

### Grafana Alerts

Configure alerts in Grafana panels:

1. Edit panel
2. Navigate to Alert tab
3. Create alert rule:
   - **Condition:** `WHEN last() OF query(A, 5m, now) IS ABOVE 4.5`
   - **Evaluate:** Every 1m for 5m
   - **Send to:** Slack, PagerDuty, Email

## Environment Variables

There are none. `/metrics` is an unconditional route on the dashboard app
(`dashboard/server.py:9637`), served at the dashboard's own port and path. An
earlier version of this page listed `LOKI_METRICS_ENABLED`,
`LOKI_METRICS_PORT`, and `LOKI_METRICS_PATH`; none of the three is read by any
code, so the endpoint cannot be turned off, moved, or re-pathed by environment.

To change the port, change the dashboard port. To restrict access, put the
dashboard behind a reverse proxy: unlike the `/api/*` routes, `/metrics` has no
auth scope dependency, so anything that can reach the port can read it.

## Best Practices

### Production Deployment

1. Secure endpoint with reverse proxy authentication
3. Set up Prometheus scraping with appropriate interval (15-30s)
4. Create Grafana dashboards for visualization
5. Configure alerts for budget, stagnation, and failures
6. Monitor metrics retention and storage

### Performance

- Metrics endpoint is lightweight (reads flat files, no DB queries)
- Scrape interval of 15-30 seconds recommended
- Metrics are cached for 2 seconds to avoid excessive file reads
- No impact on Loki Mode execution performance

### Monitoring

- Track `loki_cost_usd` to prevent budget overruns
- Alert on `loki_session_status == 0` for unexpected stops
- Monitor `loki_tasks_total{status="failed"}` for quality issues
- Watch `loki_agents_active` for agent spawning issues
- Track `loki_iteration_current` for progress

## Troubleshooting

### Metrics Endpoint Returns Empty

```bash
# Check LOKI_METRICS_ENABLED is set
echo $LOKI_METRICS_ENABLED

# Verify LOKI_DIR is set (required for dashboard)
echo $LOKI_DIR

# Check dashboard-state.json exists and is updating
ls -la .loki/dashboard-state.json
watch -n 2 cat .loki/dashboard-state.json

# Check dashboard is running
loki dashboard status
curl http://localhost:57374/health
```

### Metrics Show Zero Values

```bash
# Ensure a Loki session is running
loki status

# Check dashboard-state.json is being updated (every 2 seconds)
stat .loki/dashboard-state.json

# Verify metrics files exist
ls -la .loki/metrics/efficiency/

# Check events.jsonl exists
ls -la .loki/events.jsonl
```

### Connection Refused

```bash
# Verify dashboard is running on expected port
curl http://localhost:57374/health

# Check if another process is using port 57374
lsof -ti:57374

# Restart dashboard
loki dashboard stop
loki dashboard start
```

### Prometheus Cannot Scrape

```bash
# Test endpoint manually
curl http://localhost:57374/metrics

# Check Prometheus targets page
open http://prometheus-server:9090/targets

# Verify network connectivity from Prometheus to Loki dashboard
# (firewall, security groups, etc.)

# Check Prometheus logs
kubectl logs -f prometheus-server-xyz
```

## Examples

### Cost Budget Monitoring

```bash
# Set up budget alert
cat > /tmp/budget_check.sh <<'EOF'
#!/bin/bash
COST=$(curl -s http://localhost:57374/metrics | grep loki_cost_usd | awk '{print $2}')
if (( $(echo "$COST > 4.5" | bc -l) )); then
  echo "CRITICAL: Cost $COST exceeds budget!"
  loki stop
fi
EOF

# Run every 5 minutes
crontab -e
# Add: */5 * * * * /tmp/budget_check.sh
```

### Custom Metrics Export

```python
import requests
import json

def get_loki_metrics():
    response = requests.get("http://localhost:57374/metrics")
    metrics = {}
    for line in response.text.splitlines():
        if line.startswith("loki_"):
            parts = line.split()
            metric_name = parts[0]
            metric_value = float(parts[1]) if len(parts) > 1 else 0
            metrics[metric_name] = metric_value
    return metrics

metrics = get_loki_metrics()
print(json.dumps(metrics, indent=2))
```

### Slack Notification on High Cost

```bash
# Add to Prometheus Alertmanager config
cat >> /etc/alertmanager/alertmanager.yml <<EOF
receivers:
  - name: slack
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
        channel: '#loki-alerts'
        text: 'Loki Mode cost: ${{ .Annotations.description }}'
EOF
```

## See Also

- [Audit Logging](audit-logging.md) - Track agent actions
- [Dashboard Guide](dashboard-guide.md) - Web dashboard
- [Enterprise Features](../wiki/Enterprise-Features.md) - Complete enterprise guide
- [Prometheus Metrics](../wiki/Prometheus-Metrics.md) - Detailed wiki documentation
