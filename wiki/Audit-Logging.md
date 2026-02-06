# Audit Logging

Compliance and audit logging for enterprise environments.

---

## Overview

Audit logging captures all significant events for:

- Compliance requirements (SOC2, HIPAA, etc.)
- Security monitoring
- Debugging and troubleshooting
- Usage analytics

---

## Enabling Audit Logging

### Environment Variable

```bash
export LOKI_ENTERPRISE_AUDIT=true
```

### Configuration File

```yaml
# .loki/config.yaml
enterprise:
  audit:
    enabled: true
    level: info
    retention_days: 90
```

---

## Logged Events

### Session Events

| Event | Description |
|-------|-------------|
| `session.start` | Session started |
| `session.stop` | Session stopped |
| `session.pause` | Session paused |
| `session.resume` | Session resumed |
| `session.complete` | Session completed successfully |
| `session.fail` | Session failed |

### API Events

| Event | Description |
|-------|-------------|
| `api.request` | API request received |
| `api.response` | API response sent |
| `api.error` | API error occurred |

### Authentication Events

| Event | Description |
|-------|-------------|
| `auth.token.create` | Token created |
| `auth.token.use` | Token used |
| `auth.token.revoke` | Token revoked |
| `auth.fail` | Authentication failed |

### Task Events

| Event | Description |
|-------|-------------|
| `task.create` | Task created |
| `task.start` | Task started |
| `task.complete` | Task completed |
| `task.fail` | Task failed |

---

## Log Format

Audit logs use JSON Lines format:

```json
{
  "timestamp": "2026-02-02T12:00:00.000Z",
  "event": "session.start",
  "level": "info",
  "actor": "user",
  "details": {
    "prd": "./prd.md",
    "provider": "claude",
    "parallel": false
  },
  "metadata": {
    "hostname": "dev-machine",
    "pid": 12345,
    "version": "5.23.0"
  }
}
```

---

## Log Location

```bash
# View audit log directory
ls ~/.loki/dashboard/audit/

# Files are rotated daily
audit-2026-02-01.jsonl
audit-2026-02-02.jsonl
```

---

## CLI Commands

### View Summary

```bash
loki enterprise audit summary
```

Output:
```
Audit Log Summary (Last 24 Hours)

Events by Type:
  session.start:    5
  session.complete: 4
  session.fail:     1
  api.request:     42
  auth.token.use:  15

Events by Level:
  info:    58
  warning:  3
  error:    1
```

### Tail Recent Entries

```bash
# Last 20 entries
loki enterprise audit tail

# Follow new entries
loki enterprise audit tail --follow

# Filter by event type
loki enterprise audit tail --event session.start
```

### Search Logs

```bash
# Search by event
loki enterprise audit search --event auth.fail

# Search by date range
loki enterprise audit search --from 2026-02-01 --to 2026-02-02

# Search by actor
loki enterprise audit search --actor ci-bot
```

### Export Logs

```bash
# Export to file
loki enterprise audit export --output audit-export.json

# Export with filters
loki enterprise audit export --from 2026-01-01 --level error
```

---

## API Endpoints

### Get Audit Entries

```bash
curl "http://localhost:9898/audit?limit=50"
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `start` | ISO date | Start timestamp |
| `end` | ISO date | End timestamp |
| `event` | string | Filter by event type |
| `level` | string | Filter by level |
| `actor` | string | Filter by actor |
| `limit` | number | Max results |
| `offset` | number | Pagination offset |

### Get Summary

```bash
curl http://localhost:9898/audit/summary
```

---

## Configuration

### Full Options

```yaml
# .loki/config.yaml
enterprise:
  audit:
    enabled: true
    level: info          # Minimum level: debug, info, warning, error
    retention_days: 90   # Days to keep logs
    max_file_size: 100   # MB per file before rotation
    compress: true       # Compress rotated files
    exclude_events:      # Events to exclude
      - api.request
    include_metadata:    # Additional metadata
      - environment
      - deployment_id
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_ENTERPRISE_AUDIT` | `false` | Enable audit logging |
| `LOKI_AUDIT_LEVEL` | `info` | Minimum log level |
| `LOKI_AUDIT_RETENTION` | `90` | Retention in days |

---

## Log Levels

| Level | Description | Examples |
|-------|-------------|----------|
| `debug` | Detailed debugging | Internal state changes |
| `info` | Normal operations | Session start/stop |
| `warning` | Potential issues | Rate limiting, retries |
| `error` | Errors | Auth failures, task failures |

---

## SIEM Integration

### Forwarding to External Systems

Export logs for ingestion by SIEM systems:

```bash
# Export in SIEM-compatible format
loki enterprise audit export --format syslog > /var/log/loki-audit.log

# Stream to syslog
loki enterprise audit tail --format syslog | logger -t loki-mode
```

### Splunk

```bash
# Configure Splunk forwarder to monitor
/opt/splunk/bin/splunk add monitor ~/.loki/dashboard/audit/
```

### Datadog

```yaml
# datadog.yaml
logs:
  - type: file
    path: /home/user/.loki/dashboard/audit/*.jsonl
    source: loki-mode
    service: loki-mode
```

### CloudWatch

```bash
# Install CloudWatch agent
aws logs create-log-group --log-group-name loki-mode-audit

# Configure agent to push logs
```

---

## Compliance

### SOC2

Audit logging supports SOC2 requirements:

- **CC6.1** - Logical access security
- **CC7.2** - System monitoring
- **CC7.3** - Incident response

### HIPAA

For healthcare applications:

- Enable all authentication events
- Set retention to minimum 6 years
- Enable log encryption

```yaml
enterprise:
  audit:
    enabled: true
    retention_days: 2190  # 6 years
    encrypt: true
```

---

## Troubleshooting

### Logs Not Being Created

```bash
# Check if enabled
loki enterprise status

# Verify directory permissions
ls -la ~/.loki/dashboard/audit/

# Check disk space
df -h ~/.loki/
```

### Missing Events

```bash
# Check minimum level
loki enterprise audit summary

# Lower level to capture more
export LOKI_AUDIT_LEVEL=debug
```

### Disk Space Issues

```bash
# Check current usage
du -sh ~/.loki/dashboard/audit/

# Manually clean old logs
find ~/.loki/dashboard/audit/ -name "*.jsonl" -mtime +30 -delete
```

---

## See Also

- [[Enterprise Features]] - All enterprise features
- [[Security]] - Security best practices
- [[API Reference]] - Audit API endpoints
