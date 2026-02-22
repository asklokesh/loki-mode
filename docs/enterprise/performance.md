# Loki Mode v5.51.0 -- Enterprise Performance Tuning

## Overview

Enterprise features are designed for minimal overhead. When disabled (no env vars set), every enterprise subsystem returns no-op responses with zero I/O. This guide covers tuning for production environments where enterprise features are actively used.

## OTEL Observability

### Sampling Configuration

By default, all spans are exported. For high-throughput environments, control sampling at the collector level or reduce span creation in your instrumentation.

**Span Batching:**

The OTLP exporter batches spans and flushes them:
- Automatically every 5 seconds (`_flushIntervalMs = 5000`)
- When the batch reaches 100 spans

To adjust flush frequency, modify the exporter after initialization:

```javascript
const otel = require('./src/observability/otel');
otel.initialize();
const exporter = otel.getExporter();
// Exporter uses setInterval with 5000ms default
```

**Endpoint Tuning:**

```bash
# Point to your OTEL collector
export LOKI_OTEL_ENDPOINT="http://otel-collector:4318"

# Custom service name for multi-instance deployments
export LOKI_SERVICE_NAME="loki-mode-prod-01"
```

**Metric Cardinality Limits:**

Each metric has a built-in cardinality cap to prevent memory exhaustion:

| Setting | Default | Purpose |
|---------|---------|---------|
| `MAX_METRIC_CARDINALITY` | 1,000 | Max distinct label combinations per metric |
| `MAX_HISTOGRAM_SAMPLES` | 10,000 | Max raw samples per histogram series |

When limits are reached:
- Counters: New label sets are dropped (preserves monotonicity of existing counters)
- Gauges: Oldest label set is evicted (LRU)
- Histograms: New label sets are dropped; excess samples within a series are silently discarded

**Histogram Reset:**

Histogram sample arrays are reset after each `flushMetrics()` call to prevent unbounded memory growth. Bucket counts are recomputed from fresh data on the next flush.

### Reducing OTEL Overhead

1. **Disable when not needed:** Simply unset `LOKI_OTEL_ENDPOINT`. The no-op layer has zero overhead.
2. **Use a local collector:** Deploy the OTEL collector on the same host to minimize network latency.
3. **Filter at the collector:** Configure the collector to drop low-value spans rather than filtering in the application.

## Policy Engine

### Policy Cache

Policies are loaded from disk once at initialization and cached in memory. Subsequent evaluations use the cached policy object with no disk I/O.

**File Watching:**

When `watch: true` is passed to the engine, `fs.watchFile` polls the policy file every 1 second. This uses kernel-level polling (inotify on Linux, kqueue on macOS) and is lightweight, but can be disabled if policies only change at startup:

```javascript
const policy = require('./src/policies');
policy.init('/path/to/project', { watch: false });  // No file watcher
```

### Evaluation Overhead

All policy evaluations are synchronous and allocation-light:

| Enforcement Point | Typical Duration | Notes |
|-------------------|-----------------|-------|
| `pre_execution` | < 1ms | String comparison, regex match |
| `pre_deployment` | < 1ms | Array inclusion check |
| `resource` | < 1ms | Numeric comparison |
| `data` | 1-10ms | Depends on content size |

**Data scanning optimization:** Secret and PII patterns are compiled RegExp objects, not string patterns. They are created once at module load time and reused across evaluations.

**Skip patterns for data policies:** If your content is known to be safe (e.g., generated code), skip the `data` enforcement point entirely rather than scanning.

### No-Policy Fast Path

When no `.loki/policies.json` or `.loki/policies.yaml` file exists, all evaluations return `ALLOW` immediately with no disk access, no object allocation, and no evaluation logic.

## Event Bus

### File-Based Throughput

The event bus uses file-based pub/sub for cross-process communication. Performance characteristics:

| Operation | Typical Latency | Notes |
|-----------|----------------|-------|
| Emit event | 1-5ms | Single file write with `fcntl` lock |
| Poll pending | 5-20ms | Directory listing + JSON parse per file |
| Archive event | 1-5ms | File rename (same filesystem) |

**Tuning poll interval:**

```python
# Python
bus = EventBus()
bus.start_background_processing(poll_interval=1.0)  # Reduce CPU by polling less often
```

```typescript
// TypeScript
const bus = new EventBus();
bus.startProcessing(1000);  // 1 second interval
```

Default poll interval is 500ms. For lower CPU usage at the cost of event latency, increase to 1-2 seconds.

### Event Cleanup

Pending events accumulate in `.loki/events/pending/` if no subscriber is running. Clean up stale events:

```python
bus = EventBus()
bus.clear_pending()  # Remove all pending events
bus.clear_archive(older_than_days=7)  # Remove old archived events
```

### Watermark Deduplication

The event bus tracks the last 1,000 processed event IDs in `.loki/events/processed.json`. When the set exceeds 1,000 entries, it is pruned to the most recent 1,000.

For high-throughput scenarios (more than 1,000 events between process restarts), consider:
- Archiving events after processing (default behavior)
- Cleaning up archived events on a schedule

### Event Log Rotation

The events log file (`.loki/events.jsonl`) is automatically rotated when it exceeds 50MB:

```bash
# In events/emit.sh
MAX_SIZE=$((50 * 1024 * 1024))  # 50MB
# Keeps 1 backup (.jsonl.1)
```

## Audit Logging

### Log Rotation Configuration

```bash
# Maximum size per audit log file before rotation (default: 10MB)
export LOKI_AUDIT_MAX_SIZE_MB="10"

# Maximum number of rotated log files to retain (default: 10)
export LOKI_AUDIT_MAX_FILES="10"
```

With defaults, maximum disk usage for audit logs is approximately 100MB (10 files at 10MB each).

**Rotation behavior:**
- Date-based log files: `audit-YYYY-MM-DD.jsonl`
- When a file exceeds `MAX_SIZE_MB`, it is renamed with a timestamp suffix and a new file is created
- When file count exceeds `MAX_FILES`, the oldest files are deleted

### Chain Recovery Performance

On server restart, the audit system recovers the last hash from existing log files to continue the chain unbroken. This reads only the last line of the most recent log file using backward seeking, making it O(1) regardless of log size.

### Syslog Forwarding Overhead

Syslog forwarding is fire-and-forget:
- Uses Python `logging.handlers.SysLogHandler`
- Supports UDP (default, no connection overhead) or TCP
- Failures are silently swallowed -- never blocks the audit write path
- Security-relevant actions are logged at WARNING level for SIEM prioritization

### Disabling Integrity Hashing

For environments where tamper evidence is not required and write performance is critical:

```bash
export LOKI_AUDIT_NO_INTEGRITY="true"
```

This disables the SHA-256 hash chain computation (saves approximately 0.1ms per audit entry).

## Memory System

### Token Economics

The memory system tracks token usage for discovery vs. read operations. Tune the progressive disclosure layers to minimize token consumption:

| Layer | Purpose | Token Cost |
|-------|---------|------------|
| Index | Module routing rules | Low (~200 tokens) |
| Timeline | Recent session history | Medium (~1,000 tokens) |
| Full Details | Complete episodic memory | High (variable) |

**Optimization:** The system loads only the index layer by default and progressively loads deeper layers on demand. Avoid loading full details unless the task requires historical context.

### Vector Search Performance

When `sentence-transformers` is installed, the memory system uses vector embeddings for similarity search:

```bash
# Optional: Install for vector search
pip install sentence-transformers
```

Vector operations are the most expensive memory operations. For large memory stores:
- Limit search results with the `limit` parameter
- Use keyword-based retrieval first, then vector search as fallback
- Consider periodic consolidation to reduce episodic memory volume

## Dashboard

### Connection Pooling

The dashboard server (FastAPI/Uvicorn) uses default connection handling. For production:

```bash
# Increase worker count for multi-core systems
uvicorn dashboard.server:app --workers 4 --host 0.0.0.0 --port 57374
```

### Rate Limiting Configuration

Dashboard API rate limits protect against abuse:

```bash
# Default rate limits are built into the API layer
# Override via env vars if needed
export LOKI_API_RATE_LIMIT="100"  # requests per minute
```

### Static Asset Caching

The dashboard frontend (`dashboard/static/index.html`) is a single-page application built as an IIFE bundle. Configure your reverse proxy to cache static assets:

```nginx
location /static/ {
    expires 1d;
    add_header Cache-Control "public, immutable";
}
```

## Background Processes

### Enterprise Subscriber Resource Usage

When enterprise features are active, background processes consume resources:

| Process | CPU Impact | Memory Impact | I/O Impact |
|---------|-----------|---------------|------------|
| OTEL flush timer | Minimal (5s interval) | ~1MB for span buffer | Network: batch export |
| Policy file watcher | Minimal (1s poll) | ~100KB for cached policies | Disk: stat() call |
| Audit syslog forwarder | Minimal (per-event) | ~10KB | Network: UDP/TCP per event |
| Event bus poller | Low (500ms poll) | ~1MB for processed IDs | Disk: directory listing |

**Total overhead:** With all enterprise features active, expect approximately 2-5MB additional memory and negligible CPU impact.

### Cleanup

Enterprise processes are cleaned up on session termination:

```bash
# Kill dashboard server
lsof -ti:57374 | xargs kill -9 2>/dev/null || true

# Kill background enterprise processes
pkill -f "loki-run-" 2>/dev/null || true

# Clean temp files
rm -rf /tmp/loki-* /tmp/test-* 2>/dev/null || true
```

## Performance Monitoring Checklist

1. **Verify no-op behavior** -- When enterprise env vars are unset, confirm zero overhead by checking that no background threads are created and no disk I/O occurs.
2. **Monitor span export latency** -- Check stderr for `[loki-otel] export error` messages indicating collector connectivity issues.
3. **Watch metric cardinality** -- Check stderr for cardinality limit warnings (`cardinality limit reached`).
4. **Track audit log disk usage** -- Monitor `~/.loki/dashboard/audit/` and `.loki/audit/` directory sizes.
5. **Monitor event bus backlog** -- Count files in `.loki/events/pending/` to detect subscriber lag.
6. **Check policy evaluation time** -- In development, time `policy.evaluate()` calls to ensure they remain under 10ms.
