# Audit Logging

Audit logging for compliance, security monitoring, and troubleshooting.

---

## Overview

Audit logging is **enabled by default**. The dashboard records significant
actions (token, project and task operations, API access) to daily JSONL files
for security monitoring and troubleshooting.

---

## Disabling Audit Logging

Audit logging is on by default. To disable it:

```bash
export LOKI_AUDIT_DISABLED=true
```

The legacy variable `LOKI_ENTERPRISE_AUDIT=true` still works and will force audit
logging on regardless of `LOKI_AUDIT_DISABLED`.

---

## Log Format

Audit logs use JSON Lines format. Each entry is written by `log_event()` in
`dashboard/audit.py`:

```json
{
  "timestamp": "2026-02-02T12:00:00.000000+00:00",
  "action": "create",
  "resource_type": "token",
  "resource_id": "tok_abc123",
  "user_id": null,
  "token_id": null,
  "ip_address": "127.0.0.1",
  "user_agent": "curl/8.0",
  "success": true,
  "error": null,
  "details": {},
  "chain_hash": "..."
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

```bash
loki enterprise audit summary   # Totals and recent failures, last 7 days
loki enterprise audit tail      # Last 20 entries of the newest log file
```

---

## API Endpoints

```bash
# Query entries (requires the "audit" token scope)
curl "http://localhost:57374/api/enterprise/audit?limit=50"

# Summary
curl "http://localhost:57374/api/enterprise/audit/summary?days=7"
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `start_date` | YYYY-MM-DD | Start date |
| `end_date` | YYYY-MM-DD | End date |
| `action` | string | Filter by action |
| `resource_type` | string | Filter by resource type |
| `resource_id` | string | Filter by resource ID |
| `limit` | number | Max results (1-1000, default 100) |
| `offset` | number | Pagination offset |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_AUDIT_DISABLED` | `false` | Set to `true` to disable audit logging |
| `LOKI_ENTERPRISE_AUDIT` | `false` | Force audit on (legacy, audit is now on by default) |
| `LOKI_AUDIT_MAX_SIZE_MB` | `10` | Rotate a log file after this size |
| `LOKI_AUDIT_MAX_FILES` | `10` | Rotated files to keep |
| `LOKI_AUDIT_SYSLOG_HOST` | - | Syslog server hostname for audit forwarding |
| `LOKI_AUDIT_SYSLOG_PORT` | `514` | Syslog server port |
| `LOKI_AUDIT_SYSLOG_PROTO` | `udp` | Syslog protocol: `udp` or `tcp` |
| `LOKI_AUDIT_NO_INTEGRITY` | `false` | Disable SHA-256 chain hashing on audit entries |

---

## SIEM Integration

### Forwarding to External Systems

Point a log shipper at the JSONL files, or use the built-in syslog forwarding
below.

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

## Log Integrity (v5.38.0)

Audit entries are chain-hashed with SHA-256. The chain detects accidental
corruption and naive edits; it is not tamper-proof, because anyone who can
write the file can recompute the chain. See docs/AUDIT-CHAIN-THREAT-MODEL.md.

### How It Works

Each audit entry includes a `chain_hash` field:
1. First entry hashes against a genesis hash (`0` * 64)
2. Each subsequent entry hashes: `SHA256(previous_hash + current_entry_json)`
3. Editing a past entry without recomputing the chain invalidates all subsequent hashes

### Verification

```python
from dashboard.audit import verify_log_integrity

result = verify_log_integrity("/path/to/audit.jsonl")
print(f"Valid: {result['valid']}")
print(f"Entries checked: {result['entries_checked']}")
if not result['valid']:
    print(f"First tampered line: {result['first_tampered_line']}")
```

### Disabling Chain Hashing

```bash
export LOKI_AUDIT_NO_INTEGRITY=true
```

---

## Syslog Forwarding (v5.37.1)

Forward audit events to external syslog servers for SIEM integration.

### Enable Syslog

```bash
export LOKI_AUDIT_SYSLOG_HOST=syslog.example.com
export LOKI_AUDIT_SYSLOG_PORT=514
export LOKI_AUDIT_SYSLOG_PROTO=udp
```

### Details

- Uses Python stdlib `logging.handlers.SysLogHandler`
- Facility: `LOG_LOCAL0`
- Security actions forwarded at `WARNING` level
- Fire-and-forget: syslog failures do not block audit writes
- Supports both UDP and TCP protocols

### Example syslog-ng Configuration

```
source s_loki {
    network(port(514) transport("udp"));
};

destination d_loki_audit {
    file("/var/log/loki-mode-audit.log");
};

filter f_loki {
    facility(local0);
};

log {
    source(s_loki);
    filter(f_loki);
    destination(d_loki_audit);
};
```

---

## Agent Action Audit (v5.38.0)

In addition to the dashboard audit log, agent actions are tracked in a separate JSONL file.

### Location

`.loki/logs/agent-audit.jsonl`

### Tracked Actions

| Action | Description |
|--------|-------------|
| `cli_invoke` | CLI command executed by agent |
| `git_commit` | Git commit performed by agent |
| `session_start` | Agent session started |
| `session_stop` | Agent session stopped |

### Entry Format

```json
{
  "timestamp": "2026-02-12T18:30:00Z",
  "action": "git_commit",
  "agent": "development",
  "details": {"message": "Add auth module", "files_changed": 3}
}
```

### CLI Commands

```bash
loki audit log      # View recent entries
loki audit count    # Count total entries
loki audit help     # Show help
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
- [[Network Security]] - Network egress control
