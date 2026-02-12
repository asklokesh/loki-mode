# Loki Mode - OpenClaw Integration

Run Loki Mode autonomous SDLC sessions from any OpenClaw channel (Slack, Discord, Teams, web).

## Installation

1. Install Loki Mode CLI:
   ```bash
   npm install -g loki-mode
   # or
   brew install asklokesh/tap/loki-mode
   ```

2. Copy skill to OpenClaw workspace:
   ```bash
   cp -r integrations/openclaw/ ~/.openclaw/workspace/skills/loki-mode/
   ```

3. Configure API keys in the OpenClaw environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY).

## Usage

From any connected channel, the agent will invoke Loki Mode when:
- You ask it to "build" or "implement" something from a PRD
- You say "loki mode" with a project reference
- You provide requirements for autonomous development

## Architecture

```
Channel (Slack/Discord/Web)
    |
    v
OpenClaw Gateway --> Agent routes to loki-mode skill
    |
    v
loki start --bg --yes <prd>  (background process)
    |
    v
Poll loop: loki status --json (every 30s)
    |
    v
Progress messages back to channel
```

## Helper Scripts

Two helper scripts are provided in `scripts/` for structured status polling and formatting:

- `poll-status.sh [workdir]` -- Calls `loki status --json` and enriches the output with budget and council data from `.loki/` flat files. Returns a single JSON object.
- `format-progress.sh` -- Reads the JSON output from `poll-status.sh` via stdin and produces a human-readable multi-line progress message suitable for channel posting.

Example pipeline:
```bash
./scripts/poll-status.sh /path/to/project | ./scripts/format-progress.sh
```

## Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| LOKI_PROVIDER | AI provider (claude/codex/gemini) | claude |
| LOKI_BUDGET_LIMIT | Cost limit in USD | unlimited |
| LOKI_MAX_PARALLEL_AGENTS | Max concurrent agents | 10 |
| LOKI_COMPLEXITY | Force complexity tier (simple/standard/complex) | auto |
| LOKI_DASHBOARD_PORT | Dashboard HTTP port | 57374 |

## Phase 2: Bridge Daemon (Foundation)

The bridge daemon watches Loki's `.loki/` flat-file events in real time and translates them into OpenClaw gateway messages. This replaces the polling-based approach (Phase 1) with event-driven communication.

### What exists now

| Component | Path | Status |
|-----------|------|--------|
| Event schema mapping | `bridge/schema_map.py` | Implemented -- maps 15 Loki event types to OpenClaw `sessions_send` messages |
| File watcher | `bridge/watcher.py` | Implemented -- polls `events/pending/` and `dashboard-state.json` |
| CLI entry point | `bridge/__main__.py` | Implemented -- prints mapped events as JSON to stdout |

### Running the bridge (stdout mode)

```bash
# From the project root where .loki/ exists
python -m integrations.openclaw.bridge --loki-dir .loki

# With custom poll interval
python -m integrations.openclaw.bridge --loki-dir .loki --poll-interval 0.5

# The --gateway flag is accepted but not yet functional
python -m integrations.openclaw.bridge --loki-dir .loki --gateway ws://127.0.0.1:18789
```

Events are printed to stdout as JSON, one per line:
```json
{"method": "sessions_send", "params": {"message": "Loki Mode started. Provider: claude. PRD: my-app.md", "source": "loki-bridge", "event_type": "session.start", "timestamp": "2026-02-12T00:00:00Z", "loki_event_id": "a1b2c3d4"}}
```

### What is NOT yet implemented

- **WebSocket gateway client** -- the `--gateway` flag is parsed but the actual WebSocket connection to OpenClaw is not built yet. Events go to stdout only.
- **Reconnection logic** -- automatic reconnect on gateway disconnect.
- **Event filtering** -- ability to select which event types to forward.
- **Authentication** -- token-based auth for the OpenClaw gateway.
- **Backpressure** -- buffering when the gateway is slow or unavailable.
- **Async I/O** -- the watcher uses synchronous polling; a future version may use asyncio or inotify/kqueue for lower latency.
- **Two-way communication** -- sending OpenClaw commands back to Loki (pause, stop, etc.).

### Event schema mapping

The bridge normalizes two Loki event formats into a canonical dot-notation key:

1. **Individual JSON files** (`events/pending/*.json` from `events/emit.sh`): `type` + `payload.action` -> `"session.start"`
2. **JSONL entries** (`events.jsonl` from `emit_event_json`): underscore-compound `type` -> `"session_start"` -> `"session.start"`

Currently mapped event types: `session.start`, `session.stop`, `session.end`, `phase.change`, `iteration.start`, `iteration.complete`, `task.complete`, `error.failed`, `council.vote`, `council.verdict`, `budget.exceeded`, `budget.warning`, `code_review.start`, `code_review.complete`, `watchdog.alert`.

---

## Status JSON Schema

The enriched JSON from `poll-status.sh` contains:

| Field | Type | Description |
|-------|------|-------------|
| status | string | inactive, running, paused, stopped, completed, unknown |
| phase | string/null | BOOTSTRAP, DISCOVERY, ARCHITECTURE, DEVELOPMENT, QA, DEPLOYMENT |
| iteration | number | Current iteration count |
| tasks_completed | number | Tasks finished successfully |
| tasks_total | number | Total tasks discovered |
| tasks_failed | number | Tasks that errored |
| tasks_pending | number | Tasks not yet started |
| elapsed_minutes | number | Minutes since session start |
| provider | string | Active AI provider |
| version | string | Loki Mode version |
| pid | number/null | Session process ID |
| dashboard_url | string/null | Dashboard URL if running |
| budget_used | number/null | USD spent so far |
| budget_limit | number/null | USD budget cap |
| council_verdict | string/null | Completion council decision |
