# SIEM Integration Guide

Integrate Loki Mode audit logs with Security Information and Event Management (SIEM) systems.

## Overview

Loki Mode supports integration with enterprise SIEM systems for:

- Centralized security monitoring
- Real-time threat detection
- Compliance reporting (SOC2, HIPAA, PCI-DSS)
- Incident response
- Forensic analysis

Supported SIEM platforms:
- Splunk
- IBM QRadar
- Micro Focus ArcSight
- Elastic SIEM
- Datadog Security Monitoring
- LogRhythm
- SumoLogic

## Syslog Forwarding (v5.38.0)

### Enable Syslog

```bash
export LOKI_AUDIT_SYSLOG_HOST=syslog.example.com
export LOKI_AUDIT_SYSLOG_PORT=514
export LOKI_AUDIT_SYSLOG_PROTO=udp

loki start ./prd.md
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_AUDIT_SYSLOG_HOST` | - | Syslog server hostname or IP |
| `LOKI_AUDIT_SYSLOG_PORT` | `514` | Syslog server port |
| `LOKI_AUDIT_SYSLOG_PROTO` | `udp` | Protocol: `udp` or `tcp` |
| `LOKI_SYSLOG_FACILITY` | `local0` | Syslog facility (local0-local7) |
| `LOKI_SYSLOG_SEVERITY` | `info` | Minimum severity to forward |

### Configuration File

```yaml
# .loki/config.yaml
enterprise:
  siem:
    enabled: true
    syslog:
      host: syslog.example.com
      port: 514
      protocol: udp
      facility: local0
      severity: info
      format: rfc5424  # RFC 5424 or RFC 3164
```

### Testing

```bash
# Test syslog connectivity
loki syslog test

# Send test event
loki syslog test --message "Test event from Loki Mode"

# Verify on syslog server
tail -f /var/log/loki-mode.log
```

## Event Export Module (CEF + Splunk HEC)

In addition to syslog forwarding, Loki Mode ships a programmatic exporter for
audit/security events at `src/observability/siem-export.js`. It provides two
well-specified, vendor-agnostic formats and an SSRF-safe HEC sender.

### Zero egress unless configured

The module follows the same gate as the OTEL bridge: nothing leaves the host
unless an endpoint env var is set. `createHECSenderFromEnv()` returns `null`
when `LOKI_SPLUNK_HEC_URL` is unset, so there is no code path to the network.
Endpoint URLs are validated to be `http:`/`https:` only (the same SSRF guard
the OTLP exporter uses), so a stray `file://` or `gopher://` endpoint is
rejected before any request is built.

### Auto-detected environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LOKI_SPLUNK_HEC_URL` | enables HEC | Splunk HEC collector URL. Presence enables the sender. |
| `LOKI_SPLUNK_HEC_TOKEN` | no | HEC auth token (sent as `Authorization: Splunk <token>`). |
| `LOKI_SPLUNK_HEC_INDEX` | no | Target Splunk index. |
| `LOKI_SPLUNK_HEC_SOURCETYPE` | no | Sourcetype (default `loki:audit`). |
| `LOKI_CEF_VENDOR` / `LOKI_CEF_PRODUCT` | no | Override CEF vendor/product header fields. |

### CEF (Common Event Format)

`toCEF(entry)` converts a Loki audit entry into a single-line CEF record.
Header pipes/backslashes and extension `=`/newlines are escaped per the CEF
spec, so events cannot break the record framing. Failed events
(`success: false`) are elevated to severity 8.

```
CEF:0|Autonomi|Loki Mode|7.49.0|revoke_token|revoke_token|8|rt=2026-02-15T14:30:00.000Z suser=alice src=10.0.0.4 cs1=token cs1Label=resourceType outcome=failure msg=expired credential loki.provider=claude loki.cost=4.25
```

Nested `details` are flattened under the `loki.` namespace. Standard CEF keys
are used where they exist (`rt`, `suser`, `src`, `outcome`, `msg`, `cs1..cs3`).

### Splunk HEC JSON

`toHEC(entry)` wraps an audit entry in a Splunk HEC envelope (epoch-seconds
`time`, `sourcetype`, optional `index`, and the raw `event`). `HECSender.send()`
POSTs it fire-and-forget; network errors are logged, never thrown, so
observability never breaks the run.

```bash
export LOKI_SPLUNK_HEC_URL=https://splunk.example.com:8088/services/collector
export LOKI_SPLUNK_HEC_TOKEN=your-hec-token
export LOKI_SPLUNK_HEC_INDEX=security
```

### GitHub Enterprise SAML SSO (docs-only follow-up)

Ingesting GitHub Enterprise SAML/SSO sign-in events is a documented follow-up,
not a shipped code path. Those events live in the GitHub audit log API and
require an org-scoped admin token plus an outbound polling client, which is out
of scope for the local audit path. Recommended approach today: pull the GitHub
Enterprise audit log via its native streaming to your SIEM (Splunk/Datadog/
Azure Event Hubs) and correlate on `actor`/`user_id` with Loki Mode events.

## Splunk Integration

### Method 1: Splunk Universal Forwarder

```bash
# Install Splunk Universal Forwarder
wget -O splunkforwarder.tgz 'https://download.splunk.com/...'
tar -xzf splunkforwarder.tgz
cd splunkforwarder

# Configure to monitor audit logs
./bin/splunk add monitor ~/.loki/dashboard/audit/ \
  -sourcetype loki:audit \
  -index security \
  -hostname $(hostname)

# Start forwarder
./bin/splunk start
```

### Method 2: HTTP Event Collector (HEC)

```bash
# Enable HEC in Splunk Web:
# Settings > Data Inputs > HTTP Event Collector > New Token

# Configure Loki Mode
export LOKI_SPLUNK_HEC_URL=https://splunk.example.com:8088/services/collector
export LOKI_SPLUNK_HEC_TOKEN=your-hec-token

# Or via config file
cat > .loki/config.yaml <<EOF
enterprise:
  siem:
    splunk:
      hec_url: https://splunk.example.com:8088/services/collector
      hec_token: your-hec-token
      index: security
      sourcetype: loki:audit
EOF
```

### Splunk Searches

```spl
# Recent audit events
index=security sourcetype=loki:audit
| stats count by event level

# Failed authentication attempts
index=security sourcetype=loki:audit event="auth.fail"
| table timestamp actor details.reason

# High-cost sessions
index=security sourcetype=loki:audit event="session.complete"
| eval cost=tonumber('details.cost')
| where cost > 4.0
| table timestamp cost details.provider

# Agent errors
index=security sourcetype=loki:audit level=error
| stats count by event agent
```

## IBM QRadar Integration

### Syslog Setup

```bash
# Configure QRadar log source
# 1. QRadar Console > Admin > Log Sources > Add Log Source
# 2. Log Source Type: Syslog
# 3. Protocol: UDP/TCP
# 4. Port: 514

# Configure Loki Mode
export LOKI_AUDIT_SYSLOG_HOST=qradar.example.com
export LOKI_AUDIT_SYSLOG_PORT=514
export LOKI_AUDIT_SYSLOG_PROTO=tcp
```

### QRadar Rules

Create custom rules in QRadar:

```
Rule: Loki Mode Authentication Failure
Event: loki:audit AND event="auth.fail"
Action: Alert, Create Offense
Severity: High

Rule: Loki Mode High Cost Session
Event: loki:audit AND event="session.complete" AND cost > 4.0
Action: Alert
Severity: Medium

Rule: Loki Mode Session Failure
Event: loki:audit AND event="session.fail"
Action: Alert, Create Offense
Severity: Medium
```

## Elastic SIEM Integration

### Filebeat Setup

```yaml
# /etc/filebeat/inputs.d/loki-audit.yml
filebeat.inputs:
  - type: log
    enabled: true
    paths:
      - /home/user/.loki/dashboard/audit/*.jsonl
    json.keys_under_root: true
    json.add_error_key: true
    fields:
      log_type: audit
      application: loki-mode
      environment: production
    tags: ["loki", "audit", "security"]

# Elasticsearch output
output.elasticsearch:
  hosts: ["https://elasticsearch.example.com:9200"]
  index: "loki-audit-%{+yyyy.MM.dd}"
  username: "filebeat"
  password: "${ELASTICSEARCH_PASSWORD}"

# Kibana dashboards
setup.kibana:
  host: "https://kibana.example.com:5601"
```

### Elastic Detection Rules

Create detection rules in Kibana Security:

```
Rule: Failed Authentication Attempts
Query: event.dataset:"loki-audit" AND event:"auth.fail"
Risk Score: 50
Severity: Medium
Actions: Slack notification, Create case

Rule: Repeated Session Failures
Query: event.dataset:"loki-audit" AND event:"session.fail"
Threshold: 3 occurrences in 15 minutes
Risk Score: 75
Severity: High
Actions: PagerDuty alert, Create case

Rule: Unusual Agent Activity
Query: event.dataset:"loki-audit" AND agent.count > 50
Risk Score: 60
Severity: Medium
```

## ArcSight Integration

### SmartConnector Setup

```bash
# Install ArcSight SmartConnector for Syslog

# Configure connector.properties
agents[0].mode=syslogudp
agents[0].port=514
agents[0].parser=loki-audit

# Custom parser for Loki JSON format
# Create loki-audit.parser.properties:
parser.name=loki-audit
parser.type=json
parser.fields.timestamp=timestamp
parser.fields.event=event
parser.fields.level=level
parser.fields.actor=actor
```

### ArcSight CEF Format

```bash
# Enable CEF output format
export LOKI_SYSLOG_FORMAT=cef

# CEF message example:
# CEF:0|Autonomi|Loki Mode|5.42.2|session.start|Session Started|3|
# rt=2026-02-15T14:30:00Z suser=user cs1=claude cs1Label=Provider
```

## OTEL Vendor Templates (Datadog, Honeycomb)

Loki Mode already emits OpenTelemetry traces/metrics when `LOKI_OTEL_ENDPOINT`
is set (see `src/observability/otel.js`). Ready-to-use vendor templates live in
`src/observability/siem-export.js` (`OTEL_TEMPLATES`) and produce the exact set
of env vars to ship to a vendor. They are recipes, not egress: copy the output
into your shell.

### Datadog

Datadog ingests OTLP/HTTP via the Datadog Agent's OTLP receiver (default
`:4318`) or, agentless, via the OpenTelemetry Collector contrib exporter.

```bash
# Local Datadog Agent OTLP receiver (recommended)
export LOKI_OTEL_ENDPOINT=http://localhost:4318
export LOKI_SERVICE_NAME=loki-mode

# Agentless intake (set API key + site)
export LOKI_OTEL_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_HEADERS="dd-api-key=YOUR_DD_API_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production,dd.site=datadoghq.com"
```

`site` examples: `datadoghq.com`, `datadoghq.eu`, `us5.datadoghq.com`.

### Honeycomb

Honeycomb ingests OTLP/HTTP directly. Auth is the `x-honeycomb-team` header.

```bash
export LOKI_OTEL_ENDPOINT=https://api.honeycomb.io   # or https://api.eu1.honeycomb.io
export LOKI_SERVICE_NAME=loki-mode
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=YOUR_API_KEY,x-honeycomb-dataset=loki"
```

Note: `OTEL_EXPORTER_OTLP_HEADERS` is honored when the real `@opentelemetry`
SDK is installed (otel.js prefers it and falls back to the built-in JSON
exporter). For Datadog the local-agent path holds the API key, so the header is
optional there.

## Datadog Security Monitoring

### Log Collection

```yaml
# /etc/datadog-agent/conf.d/loki_mode.d/conf.yaml
logs:
  - type: file
    path: /home/user/.loki/dashboard/audit/*.jsonl
    service: loki-mode
    source: loki-audit
    tags:
      - env:production
      - team:security
      - compliance:soc2

# Process JSON logs
logs_config:
  processing_rules:
    - type: multi_line
      name: log_start_with_timestamp
      pattern: ^\{
```

### Security Signals

Create security signals in Datadog:

```
Signal: Multiple Failed Auth Attempts
Query: source:loki-audit event:auth.fail
Threshold: > 5 in 5 minutes
Severity: High
Notifications: Slack #security, PagerDuty

Signal: High Cost Session Alert
Query: source:loki-audit event:session.complete @cost:>4.5
Severity: Medium
Notifications: Email team@example.com

Signal: Unusual Agent Spawning
Query: source:loki-audit event:agent.spawn
Threshold: > 20 in 1 minute
Severity: High
Notifications: PagerDuty, Slack #incidents
```

## Log Format Standards

### RFC 5424 (Syslog Protocol)

```
<134>1 2026-02-15T14:30:00.000Z dev-machine loki-mode 12345 - - {"event":"session.start","level":"info","actor":"user"}
```

### CEF (Common Event Format)

```
CEF:0|Autonomi|Loki Mode|5.42.2|session.start|Session Started|3|rt=2026-02-15T14:30:00Z suser=user cs1=claude cs1Label=Provider
```

### LEEF (Log Event Extended Format)

```
LEEF:1.0|Autonomi|Loki Mode|5.42.2|session.start|devTime=2026-02-15T14:30:00Z usrName=user provider=claude
```

## Event Correlation

### Use Cases

1. **Failed Auth + Session Start** - Potential brute force
2. **Multiple Session Failures** - System instability
3. **High Cost + Many Agents** - Resource abuse
4. **Rapid Token Creation** - Possible token theft
5. **Off-hours Activity** - Unauthorized access

### Correlation Rules

```yaml
# .loki/config.yaml
enterprise:
  siem:
    correlation_rules:
      - name: "Brute Force Detection"
        events:
          - auth.fail
        threshold: 5
        window: 300  # seconds
        action: alert
        severity: high

      - name: "Session Instability"
        events:
          - session.fail
        threshold: 3
        window: 600
        action: alert
        severity: medium
```

## Compliance Reporting

### SOC2 Reports

```bash
# Generate SOC2 audit report
loki enterprise audit export \
  --from 2026-01-01 \
  --to 2026-12-31 \
  --format soc2 \
  --output soc2-audit-report.pdf

# Trust Services Criteria coverage
loki compliance report --framework soc2
```

### HIPAA Reports

```bash
# PHI access audit trail
loki enterprise audit search \
  --event data.access \
  --tag phi \
  --from 2026-01-01 \
  --format hipaa

# Administrative safeguards report
loki compliance report --framework hipaa --section administrative
```

### PCI-DSS Reports

```bash
# User access report (Requirement 8)
loki enterprise audit search \
  --event auth.token.create \
  --event auth.token.revoke \
  --format pci

# Audit log review (Requirement 10)
loki compliance report --framework pci --requirement 10
```

## Alerting

### Critical Events

Configure immediate alerts for:

- `auth.fail` (3+ in 5 minutes)
- `session.fail` (any occurrence)
- `cost_exceeded` (budget threshold)
- `token.revoke.all` (mass revocation)
- `config.change` (production changes)

### Alert Channels

```yaml
enterprise:
  siem:
    alerts:
      - event: auth.fail
        threshold: 3
        window: 300
        channels:
          - slack: "#security-alerts"
          - pagerduty: "P1234567"
          - email: "security@example.com"

      - event: session.fail
        threshold: 1
        channels:
          - slack: "#loki-alerts"
          - email: "devops@example.com"
```

## Best Practices

### Configuration

1. Use TCP for syslog (more reliable than UDP)
2. Enable TLS for encrypted log forwarding
3. Set appropriate log levels (info for production)
4. Configure log buffering for high-volume environments
5. Test failover scenarios

### Security

1. Encrypt logs in transit (TLS/SSL)
2. Encrypt logs at rest
3. Restrict SIEM access to security team
4. Use service accounts with minimal permissions
5. Rotate SIEM credentials regularly

### Performance

1. Use log aggregation to reduce SIEM load
2. Filter low-value events before forwarding
3. Compress logs during transmission
4. Monitor SIEM ingestion rates
5. Set up log retention policies

### Monitoring

1. Monitor syslog connectivity
2. Track log forwarding failures
3. Alert on SIEM ingestion delays
4. Review SIEM dashboards weekly
5. Test incident response procedures quarterly

## Troubleshooting

### Logs Not Appearing in SIEM

```bash
# Check syslog connectivity
nc -zv syslog.example.com 514

# Test syslog send
logger -n syslog.example.com -P 514 "Test from Loki Mode"

# Verify syslog configuration
echo $LOKI_AUDIT_SYSLOG_HOST
loki syslog test

# Check for forwarding errors
loki enterprise audit tail --event syslog.error
```

### Format Issues

```bash
# Check log format
tail -f ~/.loki/dashboard/audit/audit-2026-02-15.jsonl | jq

# Verify SIEM parser configuration
# Check SIEM logs for parsing errors

# Test with manual syslog send
cat ~/.loki/dashboard/audit/audit-2026-02-15.jsonl | \
  head -1 | \
  logger -n syslog.example.com -P 514
```

### Performance Issues

```bash
# Check log volume
find ~/.loki/dashboard/audit/ -type f -exec wc -l {} + | awk '{sum+=$1} END {print sum " total events"}'

# Monitor syslog queue
ss -tunap | grep :514

# Reduce log volume
export LOKI_AUDIT_LEVEL=warning
export LOKI_AUDIT_EXCLUDE_EVENTS=api.request,api.response
```

## Examples

### Splunk Dashboard

```xml
<dashboard>
  <label>Loki Mode Security Dashboard</label>
  <row>
    <panel>
      <title>Failed Authentications</title>
      <chart>
        <search>
          <query>index=security sourcetype=loki:audit event="auth.fail" | timechart count</query>
        </search>
      </chart>
    </panel>
  </row>
  <row>
    <panel>
      <title>Session Costs</title>
      <chart>
        <search>
          <query>index=security sourcetype=loki:audit event="session.complete" | eval cost=tonumber('details.cost') | timechart avg(cost)</query>
        </search>
      </chart>
    </panel>
  </row>
</dashboard>
```

### Elastic Query DSL

```json
{
  "query": {
    "bool": {
      "must": [
        {"match": {"event": "auth.fail"}},
        {"range": {"timestamp": {"gte": "now-1h"}}}
      ]
    }
  },
  "aggs": {
    "by_actor": {
      "terms": {"field": "actor.keyword"}
    }
  }
}
```

## See Also

- [Audit Logging](audit-logging.md) - Audit logging configuration
- [Authentication Guide](authentication.md) - Authentication events
- [Enterprise Features](../wiki/Enterprise-Features.md) - Complete enterprise guide
- [Network Security](network-security.md) - Security controls
