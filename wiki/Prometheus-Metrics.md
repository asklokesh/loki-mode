# Prometheus Metrics

Prometheus/OpenMetrics monitoring endpoint for Loki Mode (v5.38.0).

---

## Overview

Loki Mode exposes a `/metrics` endpoint on the dashboard server that returns metrics in Prometheus/OpenMetrics text format. This enables integration with Prometheus, Grafana, Datadog, and other monitoring systems.

---

## Endpoint

```
GET http://localhost:57374/metrics
```

Returns `text/plain` content in OpenMetrics format. No authentication required by default (configure reverse proxy auth for production).

---

## Available Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `loki_session_status` | gauge | - | Current session status: 0=stopped, 1=running, 2=paused |
| `loki_iteration_current` | gauge | - | Current iteration number |
| `loki_iteration_max` | gauge | - | Maximum configured iterations (from LOKI_MAX_ITERATIONS) |
| `loki_tasks_total` | gauge | `status` | Number of tasks by status: pending, in_progress, completed, failed |
| `loki_agents_active` | gauge | - | Number of currently active agents |
| `loki_agents_total` | gauge | - | Total number of registered agents |
| `loki_cost_usd` | gauge | - | Estimated total session cost in USD |
| `loki_events_total` | counter | - | Total number of events recorded in events.jsonl |
| `loki_uptime_seconds` | gauge | - | Seconds since session started |

---

## Data Sources

Metrics are read from the following `.loki/` flat files:

| File | Metrics Derived |
|------|----------------|
| `dashboard-state.json` | session_status, iteration, tasks, agents |
| `loki.pid` | session_status (PID alive check fallback) |
| `state/agents.json` | agents_active, agents_total |
| `metrics/efficiency/*.json` | cost_usd |
| `events.jsonl` | events_total (line count) |

---

## CLI Usage

```bash
# Fetch all metrics
loki metrics

# Filter specific metric
loki metrics | grep loki_cost_usd

# Custom dashboard host/port
loki metrics --host 192.168.1.100 --port 8080
```

---

## Prometheus Configuration

### Basic Setup

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'loki-mode'
    scrape_interval: 15s
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

---

## Grafana Dashboard

### Recommended Panels

1. **Session Status** - Stat panel showing loki_session_status with value mappings (0=Stopped/red, 1=Running/green, 2=Paused/yellow)
2. **Iteration Progress** - Gauge panel: loki_iteration_current / loki_iteration_max
3. **Task Distribution** - Pie chart: loki_tasks_total by status label
4. **Agent Activity** - Time series: loki_agents_active over time
5. **Cost Tracking** - Stat panel: loki_cost_usd with USD formatting
6. **Event Rate** - Graph: rate(loki_events_total[5m])
7. **Uptime** - Stat panel: loki_uptime_seconds formatted as duration

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
```

---

## Datadog Integration

```yaml
# datadog.yaml - OpenMetrics check
instances:
  - prometheus_url: http://localhost:57374/metrics
    namespace: loki
    metrics:
      - loki_session_status
      - loki_iteration_current
      - loki_tasks_total
      - loki_agents_active
      - loki_cost_usd
      - loki_events_total
      - loki_uptime_seconds
```

---

## Alerting Examples

### Prometheus Alert Rules

```yaml
groups:
  - name: loki-mode
    rules:
      - alert: LokiSessionDown
        expr: loki_session_status == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Loki Mode session is not running"

      - alert: LokiBudgetWarning
        expr: loki_cost_usd > 4.00
        labels:
          severity: warning
        annotations:
          summary: "Loki Mode cost approaching budget limit"

      - alert: LokiStagnation
        expr: changes(loki_iteration_current[30m]) == 0 and loki_session_status == 1
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Loki Mode iteration not progressing"
```

---

## Troubleshooting

### Metrics Endpoint Returns Empty

```bash
# Check LOKI_DIR is set
echo $LOKI_DIR

# Verify dashboard-state.json exists
ls -la .loki/dashboard-state.json

# Check dashboard is running
loki dashboard status
```

### Metrics Show Zero Values

- Ensure a Loki session is running (`loki start`)
- Check that `.loki/dashboard-state.json` is being updated (should refresh every 2 seconds)
- Verify metrics files exist: `ls .loki/metrics/efficiency/`

### Connection Refused

```bash
# Check dashboard is running on expected port
curl http://localhost:57374/health

# Restart dashboard
loki dashboard stop && loki dashboard start
```

---

## See Also

- [[API Reference]] - Full API documentation
- [[Dashboard]] - Web dashboard
- [[Enterprise Features]] - Enterprise monitoring setup
- [[CLI Reference]] - `loki metrics` command
