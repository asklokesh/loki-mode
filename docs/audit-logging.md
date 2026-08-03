# Audit Logging

Compliance-ready audit trails for Loki Mode operations.

## Overview

Audit logging captures all significant events for compliance requirements (SOC2, HIPAA), security monitoring, debugging, and usage analytics. Audit logging is **enabled by default** as of v5.37.0.

## Configuration

### Enable/Disable Audit Logging

Audit logging is on by default. To disable:

```bash
export LOKI_AUDIT_DISABLED=true
```

The legacy variable `LOKI_ENTERPRISE_AUDIT=true` still works and will force audit logging on regardless of `LOKI_AUDIT_DISABLED`.

### Configuration File

```yaml
# .loki/config.yaml
enterprise:
  audit:
    enabled: true              # Audit logging enabled (default)
    level: info                # Minimum level: debug, info, warning, error
    retention_days: 90         # Days to keep logs
    max_file_size: 100         # MB per file before rotation
    compress: true             # Compress rotated files
    integrity_check: true      # Enable SHA-256 chain hashing (v5.38.0)
    syslog_enabled: false      # Forward to external syslog
    exclude_events:            # Events to exclude
      - api.request
    include_metadata:          # Additional metadata fields
      - environment
      - deployment_id
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_AUDIT_DISABLED` | `false` | Set to `true` to disable audit logging |
| `LOKI_ENTERPRISE_AUDIT` | `false` | Force audit on (legacy, audit is now on by default) |
| `LOKI_AUDIT_MAX_SIZE_MB` | `10` | Rotate the log once it exceeds this size |
| `LOKI_AUDIT_MAX_FILES` | `10` | Number of rotated log files to keep |
| `LOKI_AUDIT_SYSLOG_HOST` | - | Syslog server hostname for forwarding |
| `LOKI_AUDIT_SYSLOG_PORT` | `514` | Syslog server port |
| `LOKI_AUDIT_SYSLOG_PROTO` | `udp` | Syslog protocol: `udp` or `tcp` |
| `LOKI_AUDIT_NO_INTEGRITY` | `false` | Disable SHA-256 chain hashing |

## Logged Events

### Session Events

| Event | Description |
|-------|-------------|
| `session.start` | Session started with PRD |
| `session.stop` | Session stopped (manual or automatic) |
| `session.pause` | Session paused |
| `session.resume` | Session resumed |
| `session.complete` | Session completed successfully |
| `session.fail` | Session failed with error |

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
| `auth.token.use` | Token used for authentication |
| `auth.token.revoke` | Token revoked |
| `auth.fail` | Authentication failed |
| `auth.oidc.success` | OIDC authentication succeeded |
| `auth.oidc.fail` | OIDC authentication failed |

### Task Events

| Event | Description |
|-------|-------------|
| `task.create` | Task created in queue |
| `task.start` | Task started by agent |
| `task.complete` | Task completed successfully |
| `task.fail` | Task failed with error |

### Agent Events

| Event | Description |
|-------|-------------|
| `agent.spawn` | Agent spawned |
| `agent.action` | Agent performed action |
| `agent.complete` | Agent completed work |
| `agent.fail` | Agent encountered error |

## Log Format

### JSONL Format

Audit logs use JSON Lines format (one JSON object per line):

```json
{
  "timestamp": "2026-02-15T14:30:00.000Z",
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
    "version": "5.42.2"
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | ISO 8601 | Event timestamp in UTC |
| `event` | string | Event type (e.g., `session.start`) |
| `level` | string | Log level: debug, info, warning, error |
| `actor` | string | Who performed the action (user, token:name, agent:type) |
| `resource` | string | Resource affected (optional) |
| `details` | object | Event-specific details |
| `metadata` | object | System metadata (hostname, PID, version) |
| `chain_hash` | string | SHA-256 chain hash for integrity (v5.38.0) |

## Log Location

```bash
# Audit log directory
~/.loki/dashboard/audit/

# Daily rotation
audit-2026-02-15.jsonl
audit-2026-02-14.jsonl
audit-2026-02-13.jsonl

# Compressed archives (after rotation)
audit-2026-02-12.jsonl.gz
audit-2026-02-11.jsonl.gz
```

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

Events by Actor:
  user:         10
  token:ci-bot: 35
  agent:dev:    13
```

### Tail Recent Entries

```bash
# Last 20 entries
loki enterprise audit tail

# Follow new entries in real-time
loki enterprise audit tail --follow

# Filter by event type
loki enterprise audit tail --event session.start

# Filter by level
loki enterprise audit tail --level error
```

### Search and export logs

`loki enterprise audit` has exactly two subcommands: `summary` and `tail`.
There is no `search` and no `export` (an earlier version of this page
documented both, with filter flags that do not exist). The log is newline
-delimited JSON on disk, so query and export it with ordinary tools:

```bash
AUDIT=~/.loki/dashboard/audit/audit.jsonl

# Search by event type
jq -c 'select(.event == "auth.fail")' "$AUDIT"

# Search by date range
jq -c 'select(.timestamp >= "2026-02-01" and .timestamp <= "2026-02-15")' "$AUDIT"

# Search by actor
jq -c 'select(.actor == "ci-bot")' "$AUDIT"

# Export a filtered slice
jq -s 'map(select(.event == "task.fail"))' "$AUDIT" > errors.json
```

The built-in views:

```bash
loki enterprise audit summary   # aggregate counts
loki enterprise audit tail      # most recent entries
```

## API Endpoints

### Get Audit Entries

```bash
# Recent entries
curl "http://localhost:57374/api/audit?limit=50"

# With filters
curl "http://localhost:57374/api/audit?event=session.start&limit=100"

# Date range
curl "http://localhost:57374/api/audit?start=2026-02-01&end=2026-02-15"
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `start` | ISO date | Start timestamp |
| `end` | ISO date | End timestamp |
| `event` | string | Filter by event type |
| `level` | string | Filter by level (debug, info, warning, error) |
| `actor` | string | Filter by actor |
| `limit` | number | Max results (default: 100) |
| `offset` | number | Pagination offset |

### Get Summary

```bash
curl http://localhost:57374/api/audit/summary
```

Response:

```json
{
  "period": "24h",
  "total_events": 62,
  "by_type": {
    "session.start": 5,
    "session.complete": 4,
    "api.request": 42
  },
  "by_level": {
    "info": 58,
    "warning": 3,
    "error": 1
  }
}
```

## Log Integrity (v5.38.0)

Audit entries are chain-hashed with SHA-256 for tamper detection.

### How It Works

Each audit entry includes a `chain_hash` field:

1. First entry hashes against a genesis hash (`0` * 64)
2. Each subsequent entry hashes: `SHA256(previous_hash + current_entry_json)`
3. Any modification to a past entry invalidates all subsequent hashes

### Verification

There is no `loki audit verify` subcommand (`loki audit` has `log`, `count`,
and `scan`). Verify the chain through the Python API:

```bash
# Python verification
from dashboard.audit import verify_log_integrity

result = verify_log_integrity("~/.loki/dashboard/audit/audit-2026-02-15.jsonl")
print(f"Valid: {result['valid']}")
print(f"Entries checked: {result['entries_checked']}")
if not result['valid']:
    print(f"First tampered line: {result['first_tampered_line']}")
```

### Disabling Chain Hashing

```bash
export LOKI_AUDIT_NO_INTEGRITY=true
```

## SIEM Integration (v5.38.0)

### Syslog Forwarding

Forward audit events to external syslog servers for SIEM integration:

```bash
export LOKI_AUDIT_SYSLOG_HOST=syslog.example.com
export LOKI_AUDIT_SYSLOG_PORT=514
export LOKI_AUDIT_SYSLOG_PROTO=udp
```

Details:
- Uses Python stdlib `logging.handlers.SysLogHandler`
- Facility: `LOG_LOCAL0`
- Security actions forwarded at `WARNING` level
- Fire-and-forget: syslog failures do not block audit writes
- Supports both UDP and TCP protocols

### Splunk

```bash
# Configure Splunk Universal Forwarder
/opt/splunkforwarder/bin/splunk add monitor ~/.loki/dashboard/audit/ \
  -sourcetype loki:audit \
  -index security

# Or use HTTP Event Collector
curl -H "Authorization: Splunk YOUR-HEC-TOKEN" \
     -d "$(cat ~/.loki/dashboard/audit/audit-2026-02-15.jsonl)" \
     https://splunk.example.com:8088/services/collector/raw
```

### Datadog

```yaml
# datadog.yaml
logs:
  - type: file
    path: /home/user/.loki/dashboard/audit/*.jsonl
    source: loki-mode
    service: loki-mode
    tags:
      - env:production
      - team:devops
```

### Elastic SIEM

```bash
# Filebeat configuration
cat > /etc/filebeat/inputs.d/loki-audit.yml <<EOF
- type: log
  enabled: true
  paths:
    - /home/user/.loki/dashboard/audit/*.jsonl
  json.keys_under_root: true
  fields:
    log_type: audit
    application: loki-mode
  tags: ["loki", "audit"]
EOF

# Restart Filebeat
systemctl restart filebeat
```

## Agent Action Audit (v5.38.0)

In addition to dashboard audit logs, agent actions are tracked separately.

### Location

`.loki/logs/agent-audit.jsonl`

### Tracked Actions

| Action | Description |
|--------|-------------|
| `cli_invoke` | CLI command executed by agent |
| `git_commit` | Git commit performed by agent |
| `file_write` | File write operation |
| `file_delete` | File delete operation |
| `session_start` | Agent session started |
| `session_stop` | Agent session stopped |

### Entry Format

```json
{
  "timestamp": "2026-02-15T14:30:00Z",
  "action": "git_commit",
  "agent": "development",
  "branch": "loki/session-20260215-143022-12345",
  "details": {
    "message": "Add authentication module",
    "files_changed": 3,
    "insertions": 150,
    "deletions": 20
  }
}
```

### CLI Commands

Note that `loki audit` reads the agent-action audit trail, which is a separate
store from the enterprise audit log covered above.

```bash
# View recent agent actions (optional positional line count, default 50)
loki audit log
loki audit log 200

# Count total agent actions
loki audit count

# Run a quality scan
loki audit scan --preset default
```

`loki audit log` takes a line count, not filter flags; an earlier version of
this page showed `--action git_commit`, which is not implemented. Filter with
`grep` or `jq` over `.loki/audit.jsonl` instead.

## Compliance

### SOC2

Audit logging supports SOC2 requirements:

- **CC6.1** - Logical access security (auth events)
- **CC7.2** - System monitoring (session and task events)
- **CC7.3** - Incident response (error events)

Configuration:

```yaml
enterprise:
  audit:
    enabled: true
    retention_days: 365  # 1 year minimum for SOC2
    integrity_check: true
    syslog_enabled: true
```

### HIPAA

For healthcare applications:

- Enable all authentication events
- Set retention to minimum 6 years
- Enable log encryption
- Forward to SIEM for monitoring

Configuration:

```yaml
enterprise:
  audit:
    enabled: true
    retention_days: 2190  # 6 years
    encrypt: true
    integrity_check: true
    syslog_enabled: true
```

### GDPR

For European deployments:

- Log access to personal data
- Provide data export capability
- Support right to deletion
- Enable audit trail for data access

Configuration:

```yaml
enterprise:
  audit:
    enabled: true
    retention_days: 365
    gdpr_compliance: true
    log_data_access: true
```

## Troubleshooting

### Logs Not Being Created

```bash
# Check if audit logging is enabled
loki enterprise status

# Verify directory exists and is writable
ls -la ~/.loki/dashboard/audit/
mkdir -p ~/.loki/dashboard/audit/
chmod 700 ~/.loki/dashboard/audit/

# Check disk space
df -h ~/.loki/

# Test log write
echo '{"test": "entry"}' >> ~/.loki/dashboard/audit/test.jsonl
```

### Missing Events

```bash
# Check audit status and recent events
loki enterprise audit summary

# Confirm audit is not disabled (it is ON by default)
echo "${LOKI_AUDIT_DISABLED:-unset}"
```

There is no minimum-severity filter and no per-event exclude list. Audit
logging is all-or-nothing: on by default, off with `LOKI_AUDIT_DISABLED=true`.
`LOKI_AUDIT_LEVEL` and `LOKI_AUDIT_EXCLUDE_EVENTS` appeared in an earlier
version of this page and were never implemented.

### Disk Space Issues

```bash
# Check current usage
du -sh ~/.loki/dashboard/audit/

# Find large log files
find ~/.loki/dashboard/audit/ -type f -size +100M

# Manually clean old logs
find ~/.loki/dashboard/audit/ -name "*.jsonl" -mtime +30 -delete

# Bound disk use via rotation (there is no built-in compression option)
export LOKI_AUDIT_MAX_SIZE_MB=5
export LOKI_AUDIT_MAX_FILES=4
```

### Syslog Not Forwarding

```bash
# Test syslog connectivity
nc -zv syslog.example.com 514

# Check syslog configuration
echo $LOKI_AUDIT_SYSLOG_HOST
echo $LOKI_AUDIT_SYSLOG_PORT

# View syslog errors in audit log
loki enterprise audit tail --event syslog.error

# Test manual syslog send
logger -n syslog.example.com -P 514 "Test from Loki Mode"
```

## Best Practices

### Security

1. Enable audit logging in production (enabled by default)
2. Set appropriate retention period for compliance
3. Enable integrity checking (SHA-256 chain hashing)
4. Forward logs to external SIEM
5. Restrict access to audit logs (file permissions 600)
6. Encrypt audit logs at rest
7. Monitor for suspicious patterns

### Performance

1. Use async logging to avoid blocking
2. Rotate logs daily
3. Compress rotated logs
4. Set reasonable retention period
5. Exclude high-volume low-value events (e.g., api.request)

### Compliance

1. Document audit logging configuration
2. Test log integrity verification regularly
3. Perform quarterly audit log reviews
4. Export logs for long-term archival
5. Integrate with compliance monitoring tools

## See Also

- [Authentication Guide](authentication.md) - Token and OIDC setup
- [Authorization Guide](authorization.md) - RBAC permissions
- [Enterprise Features](../wiki/Enterprise-Features.md) - Complete enterprise guide
- [Network Security](network-security.md) - Security controls
