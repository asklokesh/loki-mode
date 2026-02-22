# Loki Mode v5.51.0 -- Enterprise Architecture

## Overview

Loki Mode's enterprise layer is a non-breaking extension to the core autonomous execution engine. Every enterprise feature is gated behind environment variables and activates only when explicitly configured. When no enterprise env vars are set, the system operates with zero overhead -- no imports, no background threads, no disk I/O.

## High-Level Architecture

```
+----------------------------------------------------------------------+
|                        Client Layer                                   |
|  CLI (loki)  |  Dashboard UI  |  VS Code Extension  |  MCP Client    |
+------+-------+-------+--------+---------+-----------+-------+--------+
       |               |                  |                   |
       v               v                  v                   v
+----------------------------------------------------------------------+
|                     Control Plane API                                 |
|  /api/projects  /api/runs  /api/tasks  /api/keys  /api/audit         |
|  /api/tenants   /api/status            /api/v2/*                     |
+------+---+---+---+---+---+---+---+---+---+---+---+---+---+-----------+
       |   |   |   |   |   |   |   |   |   |   |   |   |
       v   v   v   v   v   v   v   v   v   v   v   v   v
+----------------------------------------------------------------------+
|                     Enterprise Services                               |
|                                                                      |
|  +------------------+  +------------------+  +------------------+    |
|  | OTEL Bridge      |  | Policy Engine    |  | Audit Trail      |    |
|  | (otel.js)        |  | (engine.js)      |  | (log.js)         |    |
|  | Spans, Metrics   |  | YAML/JSON rules  |  | Hash-chained     |    |
|  | OTLP/HTTP export |  | 4 enf. points    |  | JSONL, syslog    |    |
|  +--------+---------+  +--------+---------+  +--------+---------+    |
|           |                      |                      |            |
|  +--------v---------+  +--------v---------+  +--------v---------+   |
|  | Span Helpers      |  | Cost Controller  |  | Compliance       |   |
|  | (spans.js)        |  | (cost.js)        |  | (compliance.js)  |   |
|  | RARV, agents,     |  | Token budgets,   |  | SOC 2, ISO 27001 |   |
|  | quality gates     |  | alerts           |  | GDPR reports     |   |
|  +-------------------+  +--------+---------+  +--------+---------+   |
|                                  |                      |            |
|  +------------------+  +--------v---------+  +--------v---------+   |
|  | Metric Defs       |  | Approval Gates   |  | Data Residency   |   |
|  | (metrics.js)      |  | (approval.js)    |  | (residency.js)   |   |
|  | Counters, gauges, |  | Webhook, timeout |  | Provider/region  |   |
|  | histograms        |  | auto-approve     |  | Air-gapped mode  |   |
|  +-------------------+  +------------------+  +------------------+   |
|                                                                      |
+------+---+---+---+---+---+---+---+---+---+---+---+---+--------------+
       |   |   |   |   |   |   |   |   |   |   |   |
       v   v   v   v   v   v   v   v   v   v   v   v
+----------------------------------------------------------------------+
|                     Integration Layer                                 |
|                                                                      |
|  +------------------+  +------------------+  +------------------+    |
|  | Jira Sync        |  | Linear Sync      |  | GitHub Reporter  |    |
|  | (jira/)          |  | (linear/)        |  | (github/)        |    |
|  | Epic import,     |  | GraphQL API,     |  | PR comments,     |    |
|  | RARV sync,       |  | status mapping,  |  | status checks,   |    |
|  | sub-tasks        |  | webhook handler  |  | issue reporting  |    |
|  +------------------+  +------------------+  +------------------+    |
|                                                                      |
+------+---+---+---+---+---+---+---+---+---+---+---+---+--------------+
       |   |   |   |   |   |   |   |   |   |   |   |
       v   v   v   v   v   v   v   v   v   v   v   v
+----------------------------------------------------------------------+
|                     Event Bus (Cross-Process)                         |
|                                                                      |
|  .loki/events/pending/    .loki/events/archive/                      |
|  File-based pub/sub       Processed event replay                     |
|  Python | TypeScript | Bash implementations                         |
|                                                                      |
+----------------------------------------------------------------------+
```

## Component Deep-Dive

### 1. OTEL Observability Bridge

**Source:** `src/observability/otel.js` (core), `src/observability/index.js` (public API)

The observability layer implements OpenTelemetry (OTEL) trace and metric export using the OTLP/HTTP+JSON protocol. It uses only Node.js built-in `http`/`https` modules -- no OTEL SDK dependency required.

**Activation:** Set `LOKI_OTEL_ENDPOINT` to enable. When unset, the public API at `src/observability/index.js` returns no-op functions with zero overhead.

**Trace Spans:**

The span system (`src/observability/spans.js`) provides typed constructors that build W3C Trace Context-compatible span hierarchies:

| Span Type | Function | Attributes |
|-----------|----------|------------|
| Project | `startProjectSpan(projectId)` | `loki.project.id` |
| Task | `startTaskSpan(parent, taskId)` | `loki.task.id` |
| RARV Phase | `startRARVSpan(parent, phase)` | `loki.rarv.phase` (REASON/ACT/REFLECT/VERIFY) |
| Quality Gate | `startQualityGateSpan(parent, name, result)` | `loki.quality_gate.name`, `.result`, `.passed` |
| Agent | `startAgentSpan(parent, type, action)` | `loki.agent.type`, `.action` (spawn/work/complete/fail) |
| Council | `startCouncilSpan(parent, reviewer, verdict)` | `loki.council.reviewer`, `.verdict`, `.approved` |

**Metrics:**

Defined in `src/observability/metrics.js`, all metrics follow Prometheus naming conventions:

| Metric | Type | Description |
|--------|------|-------------|
| `loki_task_duration_seconds` | Histogram | Task execution duration |
| `loki_quality_gate_pass_total` | Counter | Quality gate passes by gate name |
| `loki_quality_gate_fail_total` | Counter | Quality gate failures by gate name |
| `loki_agent_active` | Gauge | Currently active agents |
| `loki_tokens_consumed_total` | Counter | Token consumption by model and agent type |
| `loki_council_approval_rate` | Gauge | Council approval rate (0.0-1.0) |

**Export:**

The `OTLPExporter` class batches spans (flush at 100 or every 5 seconds) and sends them via OTLP/HTTP+JSON to the configured endpoint. SSRF protection validates only `http:` and `https:` URL schemes. Export errors are logged to stderr but never thrown -- observability must never break the application.

### 2. Policy Engine

**Source:** `src/policies/engine.js` (core), `src/policies/index.js` (public API), `src/policies/types.js` (validators)

The policy engine provides governance-as-code through declarative policy files. Policies are loaded from `.loki/policies.json` or `.loki/policies.yaml` and evaluated synchronously at enforcement points.

**Enforcement Points:**

| Point | Purpose | Context Fields |
|-------|---------|----------------|
| `pre_execution` | Before agent actions | `file_path`, `project_dir`, `active_agents` |
| `pre_deployment` | Before deployment | `passed_gates` (array of gate names) |
| `resource` | Token/provider constraints | `provider`, `tokens_consumed` |
| `data` | Secret/PII scanning | `content` (string to scan) |

**Decision Types:**

```
Decision.ALLOW            -- Action is permitted
Decision.DENY             -- Action is blocked (exit code non-zero)
Decision.REQUIRE_APPROVAL -- Action requires human approval before proceeding
```

**Built-in Rule Evaluators:**

- `file_path must start with project_dir` -- Uses `path.resolve()` to prevent traversal attacks. Ensures prefix ends with `path.sep` to block sibling-directory bypass.
- `active_agents <= N` -- Limits concurrent agent count.

**Data Scanning:**

Built-in patterns detect:
- Secrets: API keys, tokens, passwords, AWS keys, private keys, GitHub PATs, OpenAI keys, Slack tokens
- PII: Email addresses, SSNs, phone numbers, credit card numbers

**Performance:** All evaluations are synchronous with no I/O. File I/O occurs only on init and reload (optional `fs.watchFile` with 1-second polling). Target: less than 10ms per evaluation.

**Example Policy File (`.loki/policies.yaml`):**

```yaml
policies:
  pre_execution:
    - name: project-boundary
      rule: "file_path must start with project_dir"
      action: deny
    - name: agent-limit
      rule: "active_agents <= 5"
      action: require_approval

  resource:
    - name: token-budget
      max_tokens: 1000000
      alerts: [50, 80, 95]
      on_exceed: require_approval
      providers: [claude, codex]

  data:
    - name: secret-scan
      type: secret_detection
      action: deny
```

### 3. Audit Trail

The audit system operates at two levels:

**JavaScript Audit (Agent-Level):** `src/audit/log.js`

The `AuditLog` class writes hash-chained JSONL entries to `.loki/audit/audit.jsonl`. Each entry includes:

```json
{
  "seq": 0,
  "timestamp": "2026-02-21T10:00:00.000Z",
  "who": "agent-1",
  "what": "file_write",
  "where": "src/app.js",
  "why": "implement feature",
  "metadata": {},
  "previousHash": "GENESIS",
  "hash": "sha256:..."
}
```

Key methods:
- `AuditLog.record({ who, what, where, why, metadata })` -- Write an audit entry
- `AuditLog.verifyChain()` -- Verify hash chain integrity, returns `{ valid, entries, brokenAt, error }`
- `AuditLog.readEntries(filter)` -- Query entries with `who`, `what`, `since`, `until` filters

The public API at `src/audit/index.js` adds compliance reporting (`generateReport('soc2'|'iso27001'|'gdpr')`) and data residency checks (`checkProvider(provider, region)`).

**Python Audit (Dashboard-Level):** `dashboard/audit.py`

The dashboard audit module writes hash-chained JSONL to `~/.loki/dashboard/audit/audit-YYYY-MM-DD.jsonl`. Features:

- Enabled by default (disable with `LOKI_AUDIT_DISABLED=true`)
- Log rotation: `LOKI_AUDIT_MAX_SIZE_MB` (default 10) and `LOKI_AUDIT_MAX_FILES` (default 10)
- Syslog forwarding: `LOKI_AUDIT_SYSLOG_HOST`, `LOKI_AUDIT_SYSLOG_PORT`, `LOKI_AUDIT_SYSLOG_PROTO`
- Chain recovery: On server restart, recovers `_last_hash` from the last log entry
- Integrity verification: `verify_log_integrity(log_file)` recomputes the chain from genesis

### 4. Integration Layer

**Base Class:** `src/integrations/adapter.js`

All integrations extend `IntegrationAdapter`, which provides:
- Retry logic with exponential backoff (`maxRetries`, `baseDelay`, `maxDelay`)
- Event emission for sync lifecycle (`retry`, `success`, `failure`)
- Abstract methods: `importProject()`, `syncStatus()`, `postComment()`, `createSubtasks()`, `getWebhookHandler()`

**Jira Integration:** `src/integrations/jira/`

- `api-client.js` -- Jira Cloud REST API v3 client with Basic Auth, rate limiting, 10MB response cap
- `sync-manager.js` -- Bidirectional sync: epic-to-PRD import, RARV-to-Jira status mapping, quality report posting
- `epic-converter.js` -- Converts Jira epics with children to PRD format
- `webhook-handler.js` -- Handles inbound Jira webhooks

**Linear Integration:** `src/integrations/linear/`

- `client.js` -- Linear GraphQL API client with rate limit tracking, auto-retry
- `sync.js` -- Bidirectional sync using the reusable adapter pattern
- `config.js` -- Config loader from `.loki/config.yaml` with minimal YAML parser

**GitHub Integration:** `src/integrations/github/`

- `reporter.js` -- Posts quality reports to PRs, execution summaries to issues, creates status checks
- `action-handler.js` -- GitHub Actions handler with fork trust controls, expression injection prevention

### 5. Event Bus

**Source:** `events/bus.py` (Python), `events/bus.ts` (TypeScript), `events/emit.sh` (Bash)

The event bus enables cross-process, cross-language communication through file-based pub/sub:

```
.loki/events/pending/    -- New events waiting for processing
.loki/events/archive/    -- Processed events (for replay and debugging)
.loki/events/processed.json -- Watermark of processed event IDs
```

**Event Types:** `state`, `memory`, `task`, `metric`, `error`, `session`, `command`, `user`

**Event Sources:** `cli`, `api`, `vscode`, `mcp`, `skill`, `hook`, `dashboard`, `memory`, `runner`

**Event Format:**

```json
{
  "id": "a1b2c3d4",
  "type": "task",
  "source": "runner",
  "timestamp": "2026-02-21T10:00:00.000Z",
  "payload": { "action": "complete", "task_id": "task-001" },
  "version": "1.0"
}
```

**Design Properties:**
- Cross-language compatibility (Python, TypeScript, Bash all read/write the same format)
- Persistence (events survive process crashes)
- Replay capability (archived events can be re-processed for debugging)
- No external dependencies (file I/O only, file locking via `fcntl`/`fs`)
- Deduplication (processed event IDs tracked, last 1000 retained)
- Auto-rotation (events.jsonl rotated at 50MB)

### 6. Enterprise Process Manager

**Source:** `autonomy/run.sh`

The main orchestrator (`run.sh`) manages background enterprise processes during execution. Enterprise subscribers (OTEL, policies, audit, integrations) are launched as background processes when their respective env vars are set, and cleaned up on session termination.

Process lifecycle:
1. Check env vars for enterprise features
2. Start background subscribers (OTEL flush timer, policy file watcher, audit syslog forwarder)
3. Execute RARV cycle with enforcement point checks
4. Flush pending data on shutdown
5. Kill background processes on exit (trap handler)

### 7. Non-Breaking Design Principles

All enterprise features follow these design rules:

1. **Env var gating:** Every feature is activated by an environment variable. No env var set = zero overhead.
2. **No-op fallbacks:** When disabled, public APIs return instant success or no-op objects.
3. **Fail-open for observability:** OTEL export errors are logged but never thrown.
4. **Fail-closed for security:** Policy denials block execution. Audit write failures are surfaced.
5. **Zero external dependencies:** All implementations use Node.js/Python standard library only.
6. **Backward compatibility:** Legacy env vars (e.g., `LOKI_ENTERPRISE_AUDIT`) continue to work.

## File Reference

| Component | Primary Files |
|-----------|--------------|
| OTEL Bridge | `src/observability/otel.js`, `src/observability/index.js` |
| Span Helpers | `src/observability/spans.js` |
| Metric Definitions | `src/observability/metrics.js` |
| Policy Engine | `src/policies/engine.js`, `src/policies/index.js` |
| Policy Types | `src/policies/types.js` |
| Cost Controller | `src/policies/cost.js` |
| Approval Gates | `src/policies/approval.js` |
| Audit Log (JS) | `src/audit/log.js`, `src/audit/index.js` |
| Audit Log (Python) | `dashboard/audit.py` |
| Compliance Reports | `src/audit/compliance.js` |
| Data Residency | `src/audit/residency.js` |
| Integration Adapter | `src/integrations/adapter.js` |
| Jira Integration | `src/integrations/jira/` |
| Linear Integration | `src/integrations/linear/` |
| GitHub Integration | `src/integrations/github/` |
| Event Bus (Python) | `events/bus.py` |
| Event Bus (TypeScript) | `events/bus.ts` |
| Event Bus (Bash) | `events/emit.sh` |
| Process Manager | `autonomy/run.sh` |
