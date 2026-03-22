# Loki Mode Bug Audit - v6.61.0
Generated: 2026-03-22 by 20 parallel bug-hunting agents (16 initial + 4 final)

## Summary

| Severity | Count |
|----------|-------|
| Critical | 5 |
| High | 55 |
| Medium | 119 |
| Low | 36 |
| **Total** | **215** |

*235 raw bugs reported across 20 agents; 13 duplicates removed (see below). Agents 17-20 added 50 raw bugs (44 net new after 6 overlaps with existing bugs).*

---

## Duplicates Removed

The following bugs were reported by multiple agents with the same root cause. The canonical ID is listed first; removed duplicates follow in parentheses.

| Canonical Bug | Removed Duplicate(s) | Root Cause |
|---------------|----------------------|------------|
| BUG-RUN-003 | BUG-ST-003 | `ITERATION_COUNT` never persisted across restarts (`run.sh:573` / `run.sh:7771`) |
| BUG-RUN-009 | BUG-ST-005 | Gate escalation PAUSE writes to wrong path (`run.sh:9228`) |
| BUG-RUN-005 | BUG-ADP-004 | OpenSpec queue has no deduplication (`run.sh:8467`) |
| BUG-CLI-001 | BUG-CMD-011 | `cmd_web_start --port` crashes with unbound variable (`loki:3149`) |
| BUG-PL-001 + BUG-PL-002 | BUG-DS-001 | `stop_session` dead code after return and `session.reset()` never called (`server.py:1539-1542`) |
| BUG-DASH-008 | BUG-XC-001 | `_safe_read_text` leaks file handles (`server.py:94`) |
| BUG-ST-008 | BUG-XC-002 | Non-atomic `session.json` truncation risk (`run.sh:9609`) |
| BUG-PL-001 + BUG-PL-002 | BUG-WS-005 | `stop_session` dead code + missing reset (`server.py:1543`) |
| BUG-XC-009 | BUG-WS-003 | Log line trimming invalidates push indices (`server.py:1224`) |
| BUG-PL-012 | BUG-WS-010 | `cancel_chat` unhandled `TimeoutExpired` (`server.py:2923`) |
| BUG-CMD-002 | BUG-GH-001 | `ci --test-suggest` never exports changed files (`loki:16839`) |
| BUG-CMD-003 | BUG-GH-002 | `ci github` format missing export (`loki:17042`) |
| BUG-CLI-011 | BUG-PKG-009 | `config_get` exports env vars on failure (`loki:5322`) |

---

## Critical Bugs

### DASH -- Dashboard API

**BUG-DASH-001** | `dashboard/server.py:1642` | Token creation endpoint has no authentication
The `/api/tokens` POST endpoint creates new API tokens without requiring any authentication. Any network-reachable client can mint tokens with arbitrary scopes, granting themselves full API access. In a deployed dashboard scenario, an attacker on the same network can create admin-level tokens and control all sessions, projects, and state.

### PL -- Purple Lab Sessions

**BUG-PL-001** | `dashboard/server.py:1539` | Dead code after `stop_session` return
The `stop_session` endpoint returns early, leaving all code after line 1539 unreachable. Cleanup logic -- including process termination, resource release, and status updates -- never executes. Users who stop sessions via the dashboard will accumulate orphaned processes and stale state files across sessions.

**BUG-PL-002** | `dashboard/server.py:1459` | `session.reset()` never called on stop
When a session is stopped, the session object's `reset()` method is never invoked. Internal state (running flags, PID references, output buffers) remains from the previous run. If the session is restarted, it inherits stale state, causing phantom process tracking, incorrect status reporting, and potential data from the old session leaking into the new one.

---

*Note: BUG-DS-001 (`server.py:1542`, dead code after `stop_session`) was reported by Agent 12 and overlaps with BUG-PL-001 and BUG-PL-002 above. Counted once under PL.*

---

## High Severity Bugs

### CLI -- CLI Commands

**BUG-CLI-001** | `autonomy/loki:3149` | `cmd_web_start --port` crashes with unbound variable
When `--port` is passed to `loki web start`, the variable is referenced before assignment under `set -u`, causing an immediate crash. Users who try to run the dashboard on a custom port get an unhelpful "unbound variable" error instead of the dashboard starting.

*Note: BUG-CMD-011 (`loki:3149`) is a duplicate of this bug, reported by Agent 14.*

**BUG-CLI-002** | `autonomy/loki:3153` | `cmd_web_start --prd` crashes with unbound variable
Same class of bug as CLI-001 but for the `--prd` flag. The PRD path variable is used before being set when `--prd` is the first flag parsed. Users cannot attach a PRD to the web dashboard at launch.

**BUG-CLI-003** | `autonomy/loki:3376` | `cmd_web_stop` kills dashboard unconditionally
The stop command sends SIGKILL to the dashboard PID without checking whether the process belongs to the current user or is actually a dashboard process. If the PID has been recycled by the OS, an unrelated process is killed. Users running `loki web stop` after a long idle period risk killing random processes.

**BUG-CLI-012** | `autonomy/loki:3359` | Shell injection via unquoted Python file path
A file path is interpolated directly into a Python command string without escaping. A PRD file whose path contains single quotes or backticks can execute arbitrary shell commands. Any user working in a directory with special characters in the path triggers this.

### RUN -- run.sh Orchestration

**BUG-RUN-001** | `autonomy/run.sh:7210` | Completion promise checks stale daily log
The completion promise detection greps a log file path constructed from the session start date, not the current date. If an autonomous run crosses midnight, the check reads yesterday's log and never finds the promise text, causing the run to continue indefinitely past its intended stop point.

**BUG-RUN-002** | `autonomy/run.sh:6847` | Rate limit detection greps stale daily log
Same date-path bug as RUN-001 but for rate limit detection. After midnight, the system stops detecting rate limits, potentially hammering the API with retries instead of backing off, wasting budget and hitting hard limits.

**BUG-RUN-003** | `autonomy/run.sh:573` | `ITERATION_COUNT` never persisted across restarts
The iteration counter is a shell variable that is never written to the state file by `save_state()`. When a run is interrupted and resumed, iteration counting restarts from zero. This breaks RARV tier mapping (wrong model selection), budget tracking (undercount), and completion council thresholds.

*Note: BUG-ST-003 (`run.sh:7771`) is a duplicate of this bug, reported by Agent 8.*

**BUG-RUN-010** | `autonomy/run.sh:8715` | Retry counter increments on success, not just failure
The provider retry counter is incremented unconditionally after every invocation, including successful ones. After enough successful iterations, the counter hits the retry limit and triggers failover to a degraded provider despite no actual failures. Long-running sessions gradually degrade for no reason.

### PROV -- Provider System

**BUG-PROV-001** | `autonomy/run.sh:9062` | Gemini ignores `tier_param` for model selection
The Gemini invocation path constructs a model parameter but never passes it to the `gemini` CLI. Regardless of RARV tier (Opus/Sonnet/Haiku mapping), Gemini always uses its default model. Users expecting tier-aware model selection with Gemini get the same model for planning and implementation.

**BUG-PROV-002** | `providers/codex.sh:54` | Generic `LOKI_MODEL_*` injects invalid Codex models
When `LOKI_MODEL_PLANNING` or similar env vars are set to Claude model names (e.g., `claude-sonnet-4-20250514`), the Codex provider passes them verbatim to the Codex CLI, which rejects them. Users who set global model overrides break Codex runs with cryptic API errors.

**BUG-PROV-003** | `autonomy/run.sh:6697` | Claude health check requires `ANTHROPIC_API_KEY`, breaks OAuth
The provider health check for Claude tests the API key environment variable directly. Users authenticating via OAuth (no API key) fail the health check and get routed to failover providers even though Claude would work fine.

**BUG-PROV-004** | `autonomy/run.sh:649` | Provider config loaded twice, pollutes environment
The provider config file is sourced both during argument parsing and during initialization. Environment variables set in the first load (model names, flags) are overwritten by the second, but side effects from the first load (exported vars, modified PATH) persist. This causes subtle model selection bugs and flag conflicts.

### MEM -- Memory System

**BUG-MEM-001** | `memory/engine.py:292` | Episode ID date parsing produces garbage paths
The episode ID parser extracts a date substring using fixed offsets that don't account for variable-length prefixes. IDs with unexpected formats produce paths like `2026/0-/22` instead of `2026/03/22`, causing episodes to be written to nonexistent directories or wrong date buckets. Memory retrieval then fails to find them.

**BUG-MEM-002** | `memory/storage.py:490` | `save_pattern` potential deadlock via nested locks
`save_pattern` acquires the pattern lock, then calls a method that acquires the index lock. Another code path acquires these locks in reverse order. Under concurrent memory writes (parallel agents storing patterns), this ABBA lock ordering can deadlock the memory system permanently.

**BUG-MEM-003** | `memory/engine.py:1197` | `_vector_search` discards embedding, runs empty keyword search
The vector search method computes an embedding for the query but then falls through to a keyword search path with an empty query string, returning irrelevant or no results. Users invoking `loki memory vectors search` get useless output despite having a properly indexed vector store.

### DASH -- Dashboard API

**BUG-DASH-002** | `dashboard/server.py:1369` | WebSocket rate-limit calls `close()` on unaccepted connection
When a WebSocket connection exceeds the rate limit, the handler calls `websocket.close()` before having called `websocket.accept()`. This raises a Starlette runtime error that crashes the WebSocket handler and logs a traceback, rather than cleanly rejecting the connection.

**BUG-DASH-003** | `dashboard/server.py:291` | WebSocket connection limit rejection still enters receive loop
When the connection limit is reached, a rejection message is sent but execution falls through into the main receive loop instead of returning. The "rejected" connection continues operating, defeating the connection limit entirely. Under load, the dashboard accumulates unbounded WebSocket connections.

**BUG-DASH-004** | `dashboard/server.py:785` | `create_project` doesn't validate `tenant_id`
The project creation endpoint accepts an arbitrary `tenant_id` string without validation. A user can create projects under another tenant's namespace, leading to data leakage and permission confusion in multi-tenant deployments.

### PAR -- Parallel Workflows

**BUG-PAR-001** | `autonomy/run.sh:2100` | Testing/docs worktrees fail (can't checkout main twice)
The parallel workflow system tries to create worktrees for testing and docs streams by checking out the `main` branch. Since the main worktree already has `main` checked out, `git worktree add` fails. Users who enable parallel mode with testing or docs streams get immediate failures for those streams.

**BUG-PAR-002** | `autonomy/loki:10577` | `worktree list` branch pattern never matches actual branches
The branch listing regex uses a pattern that doesn't match the actual branch naming convention used by the parallel system. `loki worktree list` always shows zero worktrees even when several are active.

**BUG-PAR-003** | `autonomy/run.sh:2359` | Auto-merge double-prefixes branch name
The merge function prepends `loki-` to branch names that already start with `loki-`, producing `loki-loki-feature-x`. The subsequent `git merge` fails because the double-prefixed branch doesn't exist, leaving completed features unmerged.

### QG -- Completion Council / Quality Gates

**BUG-QG-001** | `autonomy/completion-council.sh:85` | `COUNCIL_TOTAL_DONE_SIGNALS` not reset between sessions
The done-signal counter accumulates across sessions without being reset. A session that ended normally leaves a high count; the next session inherits it and may immediately vote to stop before any work is done.

**BUG-QG-002** | `autonomy/completion-council.sh:757` | `tail -5` drops VOTE line from AI output
The council extracts the vote from AI output using `tail -5`, but verbose AI responses push the VOTE line above the 5-line window. The vote is not found, defaulting to CONTINUE regardless of the AI's actual assessment. This prevents the council from ever reaching consensus to stop.

**BUG-QG-003** | `autonomy/completion-council.sh:1270` vs `autonomy/run.sh:9493` | Two inconsistent voting systems
The completion council in `completion-council.sh` uses a 3-voter majority system, while `run.sh` has an independent voting implementation with different thresholds and logic. Depending on which code path is hit, the same evidence produces different stop/continue decisions, making completion detection nondeterministic.

**BUG-QG-004** | `autonomy/completion-council.sh:126` | Convergence detection ignores committed changes
The convergence detector checks only uncommitted `git diff` output. If an iteration commits its changes (as intended), the diff is empty and convergence is falsely detected. The system stops prematurely after any iteration that successfully commits.

**BUG-QG-007** | `autonomy/run.sh:9233` | Gate escalation silently drops failures at count 3-4
When a quality gate fails 3 or 4 times, the escalation switch/case has no handler for those counts (only 1-2 and 5+). Failures at count 3-4 fall through without logging, pausing, or escalating. The gate failure is silently ignored and the run continues with broken code.

### ST -- State Management

**BUG-ST-001** | `state/manager.py:1149` | `refresh_cache` potential ABBA deadlock
`refresh_cache` acquires the cache lock then calls file I/O that may trigger the file lock. Other paths acquire the file lock first then the cache lock. Under concurrent dashboard API calls, this produces a classic ABBA deadlock that freezes the state manager.

**BUG-ST-002** | `state/manager.py:790` | `update_state` non-atomic read-modify-write
The state update reads the JSON file, modifies it in memory, and writes it back without holding a lock across the entire operation. Two concurrent updates (e.g., dashboard API + autonomous runner) can cause one update to silently overwrite the other, losing state changes.

### EVT -- Event Bus / Notifications

**BUG-EVT-001** | `autonomy/run.sh:984` | `emit_event_pending` omits `source` field
Events emitted by the pending-event helper lack the required `source` field. Downstream consumers (notification checker, dashboard) that filter or route by source silently drop these events. Pending-state events are effectively invisible to the notification system.

**BUG-EVT-002** | `notification-checker.py:273` | Stagnation check never fires (wrong string match)
The stagnation detection compares event types using a string that doesn't match the actual event type enum value. The condition is always false, so stagnation notifications are never triggered. Users are never alerted when their autonomous run is stuck in a loop.

**BUG-EVT-003** | Multiple files | `events.jsonl` and `events/pending/` are disconnected channels
The shell emitter writes to `events.jsonl` while the Python bus writes to `events/pending/` directory. Neither system reads the other's output. Events are split across two stores with no unification, so consumers see an incomplete event stream depending on which store they read.

### MCP -- MCP Server

**BUG-MCP-001** | `mcp/server.py:853` | `loki_state_get` reads wrong fallback path
When the primary state file is not found, the fallback path is constructed incorrectly (missing a directory component). The MCP tool returns an empty/error state instead of the actual fallback state file. MCP clients querying state during initialization get no data.

**BUG-MCP-002** | `mcp/server.py:1453` | `mem_search` imports nonexistent `sqlite_storage` module
The memory search tool has a fallback import of `sqlite_storage` which was never implemented. When the primary search fails, the fallback raises `ModuleNotFoundError` instead of gracefully degrading. Memory search via MCP is broken whenever the primary path encounters an error.

**BUG-MCP-003** | `mcp/server.py:1365` | Code search relevance formula wrong for L2 distance
The relevance score is computed as `1 - distance`, which works for cosine distance (0-1 range) but not L2 distance (0-infinity). With the L2 metric used by ChromaDB, scores can go arbitrarily negative, making ranking meaningless and causing the "most relevant" results to actually be the worst matches.

### ADP -- Adapters

**BUG-ADP-001** | `adapters/bmad-adapter.py:601` | Write-back regex destroys YAML indentation
When the BMAD adapter writes modified content back to YAML files, the regex replacement doesn't preserve the original indentation. Multi-line YAML values lose their block scalar formatting, producing invalid YAML that fails to parse on the next read. Users' BMAD configuration files are corrupted after a single adapter run.

**BUG-ADP-002** | `adapters/bmad-adapter.py:1000` | Relative output dir resolves against project path, not CWD
When `--output` is given a relative path, it's resolved relative to the detected project root rather than the user's current working directory. Output files land in unexpected locations, and users may not realize their generated artifacts exist.

**BUG-ADP-012** | `adapters/openspec-adapter.py:141` | Duplicate headings silently dropped
When the OpenSpec adapter encounters duplicate markdown headings in a PRD, it keeps only the first occurrence. Sections with repeated heading names (e.g., multiple "Requirements" under different parents) lose content silently, producing an incomplete specification.

### DS -- Purple Lab Dev Server

**BUG-DS-002** | `dashboard/server.py:971` | Auto-fix restart double-wraps portless command
When the auto-fix system restarts a dev server command that doesn't include a port, it wraps the command in a port-injection wrapper. On the second restart, the already-wrapped command is wrapped again, producing a malformed command string that fails to execute. The auto-fix loop then retries indefinitely.

**BUG-DS-003** | `dashboard/server.py:505` | Overly broad port regex matches non-port numbers
The port detection regex matches any 4-5 digit number in process output, not just port announcements. Version numbers (e.g., "v5.2.1" matching "5210"), PIDs, and other numeric output are misidentified as ports. The dev server proxy points to wrong ports, and health checks target the wrong endpoints.

**BUG-DS-004** | `dashboard/server.py:743` | `pip install` into server's own Python environment
When a project needs Python dependencies, the dev server runs `pip install` without a virtualenv, installing packages into the dashboard server's own Python environment. This can break the dashboard itself by introducing conflicting dependencies.

**BUG-DS-005** | `dashboard/server.py:597` | Docker Compose `IP:host:container` port parsing crash
The port parser expects `host:container` format but Docker Compose can output `IP:host:container` (e.g., `0.0.0.0:3000:3000`). The parser crashes on the three-part format, preventing Docker-based dev servers from being detected and proxied.

### PL -- Purple Lab Sessions

**BUG-PL-003** | `dashboard/server.py:1234` | Reader task sets `running=False` without lock
The output reader background task modifies the session's `running` flag directly without acquiring the session lock. If a status check reads the flag concurrently, it can see a torn state -- the session appears stopped while cleanup is still in progress, causing race conditions in the UI.

**BUG-PL-004** | `dashboard/server.py:2736` | Chat/fix/auto-fix missing secrets injection
The chat, fix, and auto-fix endpoints launch subprocesses but don't inject the user's configured secrets (API keys, tokens) into the subprocess environment. These operations fail with authentication errors against external services that the main session handles fine.

**BUG-PL-005** | `dashboard/server.py:1628` | Pause state never tracked
When a session is paused via the API, no internal state is updated to reflect the paused status. `get_status` continues to report "running", the UI shows no indication of pause, and a subsequent "resume" call has no effect because the system doesn't know it was paused.

**BUG-PL-006** | `dashboard/server.py:2257` | `delete_session` can delete active session's directory
The delete endpoint removes the session's project directory without checking whether the session is still running. If a user deletes a session that is actively executing, the running process loses its working directory, causing cascading I/O errors and data loss.

**BUG-PL-007** | `dashboard/server.py:2740` | Chat PIDs tracked but never untracked
Subprocess PIDs from chat/fix operations are appended to a tracking list but never removed when the process exits. Over time, the list grows unboundedly. Cleanup routines iterate the entire list sending signals to long-dead PIDs, and the growing list degrades performance.

### XC -- Cross-Cutting Concerns

**BUG-XC-003** | `autonomy/run.sh:3454` | Queue file read-modify-write race condition
The task queue file is read, parsed, modified, and rewritten without any locking. When the autonomous runner and a user CLI command modify the queue simultaneously, one write overwrites the other. Tasks can be duplicated or silently lost.

**BUG-XC-005** | `memory/engine.py:362` | Lock not spanning read-modify-write in `store_pattern`
The `store_pattern` method reads the pattern file, modifies it, and writes it back, but the lock is only held during the write phase. A concurrent call can read the same pre-modification state, and both writes proceed, with the second overwriting the first's changes.

**BUG-XC-010** | `autonomy/run.sh:1690` | Cross-filesystem `mv` not atomic; no queue locking
The queue system uses `mv` to atomically swap queue files, but `mv` across filesystem boundaries (e.g., `/tmp` to project dir) falls back to copy+delete, which is not atomic. Combined with no file locking, concurrent queue operations can corrupt the queue.

### DK -- Docker / Sandbox

**BUG-DK-001** | `autonomy/app-runner.sh:434` | `setsid` PID tracking orphans app process
The app runner uses `setsid` to start the app in a new session but records the `setsid` wrapper's PID, not the actual app process PID. When the runner tries to stop the app, it kills the wrapper (already exited) while the app process continues running as an orphan, holding ports and consuming resources.

**BUG-DK-002** | `autonomy/sandbox.sh:1156` | macOS `realpath --relative-to` fails
The sandbox script uses `realpath --relative-to`, a GNU coreutils option not available on macOS's BSD `realpath`. The command fails silently or errors out, causing mount path calculations to be wrong. Sandbox containers on macOS get incorrect volume mounts, breaking file access.

**BUG-DK-003** | `autonomy/sandbox.sh:1037` | Readonly mount starts with empty state
The sandbox mounts the state directory as readonly, but at first launch the state directory doesn't exist yet. The mount creates an empty directory, and the sandboxed process cannot write initial state (readonly). The sandbox starts with no state and cannot create any, making it non-functional on first run.

### CMD -- CLI Subcommands

**BUG-CMD-001** | `autonomy/loki:3108` | `cmd_web` wildcard duplicates arguments
The `cmd_web` dispatcher passes `"$@"` to sub-handlers that also receive `"$@"` from the parent, causing arguments to appear twice. Flags like `--port 8080` become `--port 8080 --port 8080`, and the second occurrence may be parsed as a positional argument, causing unexpected behavior.

**BUG-CMD-002** | `autonomy/loki:16839` | `cmd_ci --test-suggest` always empty
The CI test suggestion feature constructs a grep pattern from changed files but the pattern is never populated correctly. The grep matches nothing, and the suggestion output is always empty. Users relying on `loki ci --test-suggest` for CI optimization get no suggestions.

---

## Medium Severity Bugs

### CLI -- CLI Commands

**BUG-CLI-004** | `autonomy/loki:5062` | `_export_csv` crashes on dict format queue
The CSV export function assumes the queue is a list of strings, but the queue format was changed to a list of dictionaries. Calling `loki export --csv` on a project with the new queue format raises a TypeError.

**BUG-CLI-005** | `autonomy/loki:698` | `--mirofish` flag double-shifts, eats next flag
The `--mirofish` option parser calls `shift` twice (once in the case handler, once at the loop bottom), consuming the next argument. If `--mirofish` is followed by another flag (e.g., `--verbose`), that flag is silently swallowed.

**BUG-CLI-006** | `autonomy/loki:10777` | `cmd_state query` shell injection via Python interpolation
The state query subcommand interpolates user input directly into a Python code string passed to `python3 -c`. A query containing single quotes or Python escape sequences can execute arbitrary code.

**BUG-CLI-007** | `autonomy/loki:1597` | `cmd_status` silently ignores unknown flags
Unknown flags passed to `loki status` are silently ignored rather than producing an error. Users who mistype flags (e.g., `--verbse`) get default output with no indication their flag was not recognized.

**BUG-CLI-008** | `autonomy/loki:4927` | `LOKI_DIR` not exported for Python heredocs
The `LOKI_DIR` variable is used in inline Python scripts but is not exported to the subprocess environment. The Python code reads an empty string, causing file operations to target the wrong directory.

**BUG-CLI-009** | `autonomy/loki:1189` | Empty array with `set -u` in `list_running_sessions`
Under `set -u` (nounset), referencing an empty bash array causes an "unbound variable" error. When no sessions are running, `list_running_sessions` crashes instead of returning an empty list.

**BUG-CLI-013** | `autonomy/loki:2787` | `cmd_dashboard_start` useless PID wait loop
The dashboard start command enters a loop waiting for the PID file to appear, but the dashboard process writes the PID file before the loop starts. The loop always succeeds on the first iteration, adding unnecessary complexity and a sleep delay.

### RUN -- run.sh Orchestration

**BUG-RUN-004** | `autonomy/run.sh:6553` | Exponential backoff integer overflow at retry >= 34
The backoff calculation uses `2^retry` via bash arithmetic. At retry count 34+, this overflows a 64-bit integer, producing negative sleep values. The `sleep` command either errors or sleeps for zero seconds, causing a tight retry loop that hammers the API.

**BUG-RUN-005** | `autonomy/run.sh:8467` | OpenSpec queue has no deduplication
When the OpenSpec adapter queues tasks, it doesn't check for existing identical tasks. Running the adapter multiple times (e.g., on retry) creates duplicate queue entries. The autonomous runner then executes the same task multiple times, wasting iterations and budget.

*Note: BUG-ADP-004 is a duplicate of this bug.*

**BUG-RUN-006** | `autonomy/run.sh:7259` | `load_handoff_context` defined twice (dead code)
The function `load_handoff_context` is defined at two different locations in run.sh. The second definition silently overwrites the first. One implementation is dead code, but it's unclear which version was intended, creating a maintenance hazard.

**BUG-RUN-007** | `autonomy/run.sh:9357` | Countdown timer overshoots due to fixed interval
The countdown timer sleeps for a fixed interval between checks, but the check itself takes variable time. The total wait can significantly overshoot the target duration, causing late timeouts and delayed responses to completion signals.

**BUG-RUN-008** | `autonomy/run.sh:6640` | Failover state heredoc shell injection
The failover state is written via a heredoc that interpolates variables without escaping. Provider names or error messages containing shell metacharacters can break the heredoc or inject content into the state file.

**BUG-RUN-009** | `autonomy/run.sh:9228` | Gate escalation PAUSE writes to wrong path
When a quality gate escalates to PAUSE, the pause signal file is written to `$LOKI_DIR/PAUSE` instead of the expected `$PROJECT_DIR/.loki/PAUSE`. The human intervention checker looks in the project directory, never finds the signal, and the pause is ignored.

*Note: BUG-ST-005 is a duplicate of this bug.*

**BUG-RUN-011** | `autonomy/run.sh:9073` | Gemini pipe buffering causes missed rate limits
The Gemini provider's output is piped through `tee` for logging, but pipe buffering delays output delivery. Rate limit messages from Gemini sit in the buffer while the rate limit detector reads an empty or incomplete log, failing to trigger backoff.

### PROV -- Provider System

**BUG-PROV-005** | `autonomy/run.sh:6745` | Failover chain iteration skips providers
The failover loop increments the provider index at the top and bottom of the loop, skipping every other provider in the chain. If the chain is `[claude, codex, gemini]`, failover from claude skips codex and tries gemini directly.

**BUG-PROV-006** | `providers/gemini.sh:54` | `PROVIDER_MODEL` frozen at load time
The Gemini provider sets `PROVIDER_MODEL` when the config file is sourced, not when the model is actually needed. RARV tier changes during a run don't affect the model -- Gemini uses whatever model was configured at startup for all iterations.

**BUG-PROV-007** | `providers/loader.sh:174` | `auto_detect_provider` skips Cline and Aider
The auto-detection function checks for `claude`, `codex`, and `gemini` CLIs but doesn't check for `cline` or `aider`. Users with only Cline or Aider installed get "no provider found" instead of auto-detection.

**BUG-PROV-008** | `autonomy/run.sh:6775` | Failover updates `PROVIDER_NAME` but not `LOKI_PROVIDER`
After failover, the internal `PROVIDER_NAME` variable is updated but the `LOKI_PROVIDER` env var (used by subprocesses and MCP) retains the old provider name. Child processes and the MCP server report the wrong provider, and provider-specific behavior in subprocesses uses the wrong config.

**BUG-PROV-009** | `providers/cline.sh:96` | Cline model flag word-splitting
The Cline model parameter is not quoted, causing word-splitting if the model name contains spaces or special characters. While current model names don't have spaces, any future model with a space in its identifier will break Cline invocation.

**BUG-PROV-010** | `providers/gemini.sh:110` | Gemini buffers all output, loses streaming
The Gemini invocation uses a pipe chain that buffers all output until the process completes. Users see no incremental output during long Gemini operations, and the dashboard shows no progress until the entire response arrives.

**BUG-PROV-011** | `autonomy/run.sh:2224` | Parallel dispatch includes Cline despite `PROVIDER_HAS_PARALLEL=false`
The parallel workflow dispatcher doesn't check the provider's parallel capability flag before dispatching to Cline. Cline receives parallel tasks it can't handle, causing failures that are retried repeatedly.

### MEM -- Memory System

**BUG-MEM-004** | `memory/consolidation.py:310` | `cluster_by_similarity` uses `list.index()` on duplicates
The clustering function uses `list.index()` to find element positions, but `index()` always returns the first occurrence. When similarity scores contain duplicates, items are assigned to the wrong cluster, producing incorrect consolidation groupings.

**BUG-MEM-005** | `memory/consolidation.py:213` | Anti-pattern dedup misses current-run duplicates
The anti-pattern deduplication checks only previously stored patterns, not patterns discovered in the current consolidation run. If the same anti-pattern is extracted from multiple episodes in one batch, duplicates are stored.

**BUG-MEM-006** | `memory/layers/index_layer.py:120` | Non-atomic `index.json` write
The index layer writes `index.json` directly (open, write, close) without using a temp file and rename. A crash or concurrent read during write produces a truncated or empty index file, breaking subsequent memory lookups.

**BUG-MEM-007** | `memory/layers/timeline_layer.py:71` | Non-atomic `timeline.json` write
Same class of bug as MEM-006 but for the timeline layer. A crash during write corrupts the timeline index.

**BUG-MEM-008** | `autonomy/loki:11416` | Memory search glob doesn't recurse into date subdirs
The memory search command uses a non-recursive glob pattern that only searches the top-level memory directory. Episodes stored in date-based subdirectories (e.g., `episodic/2026/03/22/`) are never found by search.

**BUG-MEM-009** | `memory/storage.py:1097` | `apply_decay` float comparison causes unnecessary rewrites
The decay function compares floats with `!=` instead of using a tolerance. Floating-point rounding means the decayed value almost always differs from the stored value, causing every pattern file to be rewritten on every decay cycle even when the change is negligible.

**BUG-MEM-010** | `memory/retrieval.py:1085` | Progressive retrieval loads unbounded data, boosts discarded items
The progressive retrieval system loads all candidate items before applying the limit. For large memory stores, this loads megabytes of data that's immediately discarded. Additionally, relevance boost scores are applied to items that are then filtered out, wasting computation.

**BUG-MEM-011** | `memory/schemas.py:35` | `_to_utc_isoformat` edge case with custom `tzinfo`
The UTC conversion function calls `.utctimetuple()` which is deprecated and incorrect for timezone-aware datetimes with non-UTC tzinfo. Timestamps with non-UTC timezones are silently converted incorrectly, producing wrong dates in episode metadata.

### DASH -- Dashboard API

**BUG-DASH-005** | `dashboard/server.py:1228` | `update_task` doesn't clear `completed_at` on reopen
When a task is moved from DONE back to TODO or IN_PROGRESS, the `completed_at` timestamp is not cleared. The task appears completed in timeline views and reports even though it's actively being worked on.

**BUG-DASH-006** | `dashboard/server.py:1286` | Task state machine missing DONE transitions
The task state machine doesn't define transitions out of the DONE state. Tasks that are marked done cannot be reopened through the normal state transition API, requiring direct state manipulation.

**BUG-DASH-007** | `dashboard/server.py:2698` | `pause_session` polling loop is dead code
The pause endpoint contains a polling loop that waits for the session to acknowledge the pause, but the session never writes an acknowledgment (see BUG-PL-005). The loop always times out, and the code after it is dead.

**BUG-DASH-008** | `dashboard/server.py:94` | `_safe_read_text` leaks file handles
The safe file reading utility opens files but doesn't close them in the error path. When files are unreadable (permissions, encoding), the file handle leaks. Under sustained dashboard operation with many file reads, this exhausts the file descriptor limit.

*Note: BUG-XC-001 is a duplicate of this bug.*

**BUG-DASH-009** | `dashboard/server.py:173` | `ProjectUpdate.status` allows arbitrary strings
The project update model accepts any string for the status field without validation. Invalid statuses like "foobar" are stored and returned by the API, confusing clients that expect a known set of status values.

**BUG-DASH-010** | `dashboard/server.py:1747` | Audit log offset allows negative values
The audit log pagination endpoint accepts negative offset values. A negative offset causes unexpected query behavior, potentially returning results from the end of the log or raising database errors.

**BUG-DASH-011** | `dashboard/server.py:2352` | Learning signals offset allows negative values
Same class of bug as DASH-010 but for the learning signals endpoint.

### PAR -- Parallel Workflows

**BUG-PAR-004** | `autonomy/run.sh:2585` | Trap in background subshell ignores SIGINT
Background subshells set up a trap for SIGINT that does nothing (empty handler). When the user presses Ctrl+C, the background workers ignore it while the parent exits. Workers continue running as orphans until they finish or are manually killed.

**BUG-PAR-005** | `autonomy/run.sh:2156` | Worktree removal safety check lacks path separator
The safety check verifies the worktree path starts with the project directory, but without requiring a path separator. A project at `/home/user/app` would match a worktree at `/home/user/app-backup`, allowing deletion of directories outside the project's worktree area.

**BUG-PAR-006** | `autonomy/run.sh:2241` | `git add -A` in auto-commit can stage secrets
The parallel workflow auto-commit uses `git add -A`, which stages all files including `.env`, credentials, and other secrets. If a `.gitignore` is incomplete, secrets are committed to feature branches.

**BUG-PAR-007** | `autonomy/run.sh:2604` | Empty worktree map produces invalid JSON
When no worktrees are active, the status JSON generator produces `{}` with a trailing comma from the loop, resulting in invalid JSON. Consumers that parse this JSON (dashboard, MCP) crash.

**BUG-PAR-008** | `autonomy/run.sh:2244` | Non-atomic signal file write creates TOCTOU race
Signal files (DONE, FAILED) are written with `echo > file` which is not atomic. A reader can see a partially-written or empty signal file between creation and content write, misinterpreting the signal state.

**BUG-PAR-009** | `autonomy/run.sh:2290` | `merge_worktree` doesn't verify target branch
The merge function doesn't verify it's on the correct target branch before merging. If the user or another process has checked out a different branch, the merge applies worktree changes to the wrong branch.

**BUG-PAR-010** | `autonomy/loki:10656` | `worktree clean` doesn't kill running sessions
The worktree cleanup command removes worktree directories but doesn't stop any sessions that are actively running in them. Those sessions continue with a deleted working directory, producing cascading errors.

**BUG-PAR-011** | `autonomy/run.sh:2437` | `merge_feature` subshell can't update parent arrays
The merge function runs in a subshell (piped context), so any updates to parent-scope arrays (merged branches, failed merges) are lost when the subshell exits. The parent has no record of which merges succeeded or failed.

### QG -- Completion Council / Quality Gates

**BUG-QG-005** | `autonomy/completion-council.sh:61` | `COUNCIL_ERROR_BUDGET` is dead code
The error budget variable is defined and decremented but never checked against any threshold. Gate failures always follow the same path regardless of the remaining error budget.

**BUG-QG-006** | `autonomy/completion-council.sh:335` | Anti-sycophancy skipped for council size < 3
The anti-sycophancy check (devil's advocate injection) is skipped when the council has fewer than 3 members. Since the default council size is 3, any configuration that reduces it (budget constraints, provider failures) disables the sycophancy protection entirely.

**BUG-QG-008** | `autonomy/run.sh:9262` | Failed iterations bypass convergence tracking
When an iteration fails (provider error, timeout), the convergence tracker doesn't record the failure. The convergence window only contains successful iterations, making the system unable to detect "stuck" states where every iteration fails.

**BUG-QG-009** | `autonomy/completion-council.sh:811` | Devil's advocate sees prior verdicts (not blind)
The devil's advocate reviewer receives the other reviewers' verdicts in its prompt context, defeating the purpose of independent adversarial review. The advocate tends to agree with the majority rather than providing genuine pushback.

**BUG-QG-010** | `autonomy/run.sh:5847` | Code review anti-sycophancy is a no-op
The code review anti-sycophancy function is called but its result is never used in the review decision logic. The review always proceeds with the original verdicts regardless of the anti-sycophancy check's findings.

**BUG-QG-011** | `autonomy/completion-council.sh:988` | Inverted convergence logic forces CONTINUE on active work
The convergence condition is inverted: when changes are detected (active work), it signals convergence (should stop), and when no changes are detected (actual convergence), it signals divergence (should continue). This is backwards -- the system fights to continue when idle and stop when productive.

### ST -- State Management

**BUG-ST-004** | `autonomy/loki:1694` | `cmd_status` uses wrong queue format
The status command parses the queue file as newline-delimited text, but the queue format was changed to JSON objects. The status display shows raw JSON strings instead of formatted task information.

**BUG-ST-006** | `state/manager.py:102` | `concurrent_with` treats identical vectors as concurrent
The vector clock comparison treats two identical vector clocks as concurrent (neither dominates the other), when they should be treated as equal. This triggers unnecessary conflict resolution for operations that are actually sequential, adding overhead and potential merge errors.

**BUG-ST-007** | `state/manager.py:1782` | Singleton `get_state_manager` has race condition
The singleton pattern uses a check-then-set without locking. Two threads calling `get_state_manager()` simultaneously can each create a separate instance, defeating the singleton pattern and causing split-brain state management.

**BUG-ST-008** | `autonomy/run.sh:9609` | Non-atomic `session.json` truncation risk
The session file is written by redirecting (`>`) which truncates the file before writing. A crash between truncation and write completion produces an empty session file. The next read finds an empty file and treats it as a missing/corrupt session.

*Note: BUG-XC-002 is a duplicate of this bug.*

**BUG-ST-009** | `autonomy/run.sh:6244` | Checkpoint doesn't backup `autonomy-state.json`
The checkpoint system backs up queue files, session state, and logs but omits the `autonomy-state.json` file. Restoring a checkpoint leaves the autonomy state from the current (broken) state, making checkpoint restoration incomplete.

**BUG-ST-010** | `state/manager.py:1606` | Version history cleanup counts orphan temp files
The version history pruning counts temp files (created by failed atomic writes) as valid versions. If many writes fail, the temp file count inflates the version count, causing premature pruning of actual version history.

### EVT -- Event Bus / Notifications

**BUG-EVT-004** | Multiple files | Three emitters produce incompatible schemas
The shell emitter (`emit.sh`), Python bus (`bus.py`), and TypeScript bus (`bus.ts`) each produce events with different field names and structures. Consumers must handle all three variants or silently drop events from the other emitters.

**BUG-EVT-005** | `events/bus.py:241` | `ValueError` from invalid enums not caught
When an event with an invalid type string is processed, the enum conversion raises `ValueError` which propagates up uncaught. One malformed event crashes the entire event bus, stopping all event processing.

**BUG-EVT-006** | `events/bus.ts:91` | Busy-wait spin lock blocks Node.js event loop
The TypeScript event bus implements file locking with a busy-wait loop (`while (!acquired) { tryLock(); }`). This blocks the Node.js event loop, freezing the entire dashboard UI until the lock is acquired. Under contention, the UI becomes unresponsive.

**BUG-EVT-007** | `events/bus.ts:100` | Lock failure falls through to unsafe write
When the file lock cannot be acquired after retries, the error is caught but execution continues to the write operation without the lock. This produces a silent data race where concurrent writes corrupt the event log.

**BUG-EVT-008** | `events/bus.py` and `events/bus.ts` | Incompatible locking mechanisms
The Python bus uses `fcntl.flock()` (POSIX advisory locks) while the TypeScript bus uses a lockfile approach. These two mechanisms don't interoperate -- a Python lock doesn't block a TypeScript write and vice versa. Concurrent Python and TypeScript event writes corrupt the event store.

**BUG-EVT-009** | `autonomy/notification-checker.py:135` | Notification ID collisions within same second
Notification IDs are generated from a timestamp with second granularity. Multiple notifications triggered in the same second get the same ID. Later notifications overwrite earlier ones, and deduplication logic drops all but the first.

**BUG-EVT-010** | `autonomy/notification-checker.py:214` | Reads entire `events.jsonl` into memory
The notification checker reads the complete event log file into memory on each check. For long-running sessions, this file can grow to 50+ MB. Each check cycle allocates and frees this memory, causing GC pressure and latency spikes.

### MCP -- MCP Server

**BUG-MCP-004** | `mcp/server.py:1060` | `loki_start_project` bypasses path security
The start project tool passes user-supplied paths to the shell without validation or sanitization. A path containing shell metacharacters or `../` traversal can execute arbitrary commands or start projects outside the intended directory.

**BUG-MCP-005** | `mcp/server.py:796` | Truthiness check rejects falsy valid values
The parameter validation uses Python truthiness (`if not value`) to check for missing parameters. This rejects valid values like `0`, `False`, and empty string `""` when they are legitimate inputs, causing tools to fail on valid configurations.

**BUG-MCP-006** | `mcp/server.py:1192` | Checkpoint restore contaminates orchestrator state
The checkpoint restore tool loads checkpoint data into the MCP server's process memory but doesn't reset the current orchestrator state first. The restored state merges with (rather than replaces) the current state, producing a hybrid that doesn't match any valid checkpoint.

**BUG-MCP-007** | `mcp/server.py:1030` | PRD content silently discarded, never persisted
The start project tool accepts PRD content in the request but only persists the PRD path. The actual content is discarded. If the PRD is passed inline (not as a file), the orchestrator starts with no PRD.

**BUG-MCP-008** | `mcp/server.py:1392` | `limit=0` to ChromaDB on empty collection
When the code search tool queries an empty ChromaDB collection, it passes `limit=0`, which ChromaDB interprets as "no limit". On a non-empty collection that was recently emptied (race condition), this returns all documents instead of none, causing unexpected memory usage.

**BUG-MCP-009** | `mcp/server.py:574` | No validation of parameter ranges
Numeric parameters (limit, offset, timeout) accept any value including negative numbers and extremely large values. Negative limits cause database errors; extremely large limits cause memory exhaustion.

**BUG-MCP-010** | `mcp/server.py:1313` | Learning signal missing query context
The learning signal tool stores signals without the query that triggered them. During retrieval, there's no way to associate a signal with its original context, making the learning data less useful for future decisions.

### ADP -- Adapters

**BUG-ADP-003** | `adapters/mirofish-adapter.py:1436` | `--timeout` accepted but never used
The MiroFish adapter accepts a `--timeout` flag and stores its value, but the timeout is never passed to any operation. Long-running operations (ontology generation, market analysis) run indefinitely regardless of the specified timeout.

**BUG-ADP-005** | `autonomy/run.sh:8366` | BMAD queue reports wrong count
The BMAD adapter's queue marker records the number of tasks queued, but the count is set before the Python write completes. If the write fails partway through, the marker reports more tasks than were actually queued, causing the orchestrator to expect tasks that don't exist.

**BUG-ADP-006** | `adapters/mirofish-adapter.py:182` | `generate_ontology` bypasses size limit
The ontology generation function doesn't enforce the configured maximum ontology size. Generated ontologies can grow unboundedly, consuming excessive tokens when injected into prompts.

**BUG-ADP-007** | `adapters/mirofish-adapter.py:1040` | `os.fork()` crashes on Windows
The MiroFish adapter uses `os.fork()` for background processing, which is not available on Windows. Any attempt to use the adapter on Windows raises `AttributeError`, with no fallback to `subprocess` or threading.

**BUG-ADP-008** | `adapters/mirofish-adapter.py:1322` | `--resume` re-runs entire pipeline
The resume flag is parsed but the adapter doesn't check for previously completed stages. Resuming after a failure re-executes all stages from the beginning, including expensive API calls that already succeeded.

**BUG-ADP-009** | `adapters/openspec-adapter.py:447` | Complexity boundaries off by one
The complexity scoring uses `>` instead of `>=` for boundary checks. A score of exactly 5.0 (the boundary between "simple" and "standard") is classified as "simple", and exactly 8.0 as "standard" instead of "complex". Edge cases get less thorough treatment than intended.

**BUG-ADP-011** | `adapters/bmad-adapter.py:169` | Path check fragile on Windows
The BMAD adapter uses forward-slash path checking (`/` in path strings) which fails on Windows where paths use backslashes. The adapter cannot locate BMAD configuration files on Windows.

### DS -- Purple Lab Dev Server

**BUG-DS-006** | `dashboard/server.py:565` | Synchronous `time.sleep` blocks async event loop
The dev server startup uses `time.sleep()` inside an async function, blocking the entire event loop. During the sleep (up to 5 seconds), no other requests are processed -- the dashboard UI freezes and WebSocket connections time out.

**BUG-DS-007** | `dashboard/server.py:655` | FastAPI detection misses imports after 1024 bytes
The framework detection reads only the first 1024 bytes of the main Python file to check for FastAPI imports. Files with long docstrings or many imports at the top push the FastAPI import beyond the detection window, falling back to generic Python handling.

**BUG-DS-008** | `dashboard/server.py:624` | Framework detection picks Vite over Next.js
When both Vite and Next.js are present (common in Next.js projects that use Vite for testing), the detection picks Vite because it's checked first. The wrong dev server command is used, and the project fails to start properly.

**BUG-DS-009** | `dashboard/server.py:822` | Health check timeout logic stuck on "starting"
The health check has a timeout but the state machine doesn't transition from "starting" to "failed" when the timeout expires. The session remains in "starting" state indefinitely, blocking the UI and preventing retry.

**BUG-DS-010** | `dashboard/server.py:3188` | Preview-info crashes on unreadable files
The preview info endpoint reads project files without error handling for permission denied or binary files. An unreadable file causes an unhandled exception that returns a 500 error for the entire preview.

**BUG-DS-011** | `dashboard/server.py:2244` | Session history `rglob` hangs on large `node_modules`
The session history endpoint uses `pathlib.rglob` to scan the project directory, which descends into `node_modules`, `.git`, and other large directories. For typical Node.js projects, this takes minutes and appears to hang.

**BUG-DS-013** | `dashboard/server.py:875` | Dev server port frozen after timeout fallback
When the dev server port detection times out, a fallback port is assigned. If the actual port is detected later, the stored port is not updated. The proxy continues using the fallback port, and the dev server preview shows nothing or the wrong app.

### PL -- Purple Lab Sessions

**BUG-PL-008** | `dashboard/server.py:3623` | Auth bypass on `/ws` and `/proxy` paths
The authentication middleware excludes WebSocket and proxy paths from auth checks. Any unauthenticated client can connect to WebSocket endpoints and access proxied dev server content, bypassing the API token system.

**BUG-PL-009** | `dashboard/server.py:1368` | Project dir name collision (second-granularity)
Project directories are named using timestamps with second granularity. Two sessions started within the same second get the same directory name. The second session overwrites the first's project files.

**BUG-PL-010** | `dashboard/server.py:1596` | `get_status` mutates `running` without lock
The status getter directly modifies the `running` flag based on process state checks, without holding a lock. Concurrent status checks and state transitions can produce inconsistent results.

**BUG-PL-011** | `dashboard/server.py:2203` | Session history breaks after first non-empty dir
The session history iteration uses `break` after finding the first non-empty directory, skipping all subsequent session directories. Only the most recent session's history is returned.

**BUG-PL-012** | `dashboard/server.py:2901` | `cancel_chat` unhandled `TimeoutExpired`
The chat cancellation sends SIGTERM then waits with a timeout, but `TimeoutExpired` is not caught. If the chat process doesn't exit within the timeout, the exception propagates, returning a 500 error instead of escalating to SIGKILL.

**BUG-PL-013** | `dashboard/server.py:1277` | `crypto` ImportError crashes session start
The session start imports `crypto` for session token generation. If the `crypto` module is not installed, the ImportError crashes the entire session start flow instead of falling back to a simpler token generation method.

### XC -- Cross-Cutting Concerns

**BUG-XC-004** | `autonomy/run.sh:7776` | Non-atomic `save_state` via heredoc
The state save uses a heredoc redirect (`cat <<EOF > file`), which truncates the target before writing. A crash during the write produces an empty or partial state file, losing all session state.

**BUG-XC-006** | `dashboard/server.py:216` | Non-atomic PID tracking concurrent access
The PID tracking file is read and written without locking. Concurrent dashboard instances can overwrite each other's PID entries, causing orphaned processes and incorrect shutdown behavior.

**BUG-XC-007** | `autonomy/run.sh:9586` | Signal handler re-entrancy causing premature exit
The SIGINT/SIGTERM handler calls cleanup functions that themselves can trigger signals (killing subprocesses that send SIGCHLD). The re-entrant signal handler can partially execute cleanup and then exit before completing, leaving resources un-freed.

**BUG-XC-008** | `autonomy/run.sh:2854` | Non-atomic queue initialization
The queue file is created and populated in separate operations. A reader between creation and population sees an empty queue, potentially making incorrect scheduling decisions.

**BUG-XC-009** | `dashboard/server.py:1222` | Log truncation invalidates reader indices
The log file is truncated periodically but log readers maintain byte offsets from before truncation. After truncation, readers skip to invalid positions, missing new log entries or reading garbage data.

**BUG-XC-011** | `autonomy/run.sh:179` | Temp script file leak on abnormal exit
Temporary script files created during execution are not cleaned up if the process exits abnormally (SIGKILL, OOM). Over many interrupted runs, `/tmp` accumulates stale script files.

**BUG-XC-012** | `dashboard/control.py:55` | `atomic_write_json` locks temp file not target
The atomic write utility acquires a file lock on the temporary file instead of the target file. Two concurrent writers each create their own temp file, lock it (no contention), and then both rename to the target. The last rename wins, silently dropping the other's changes.

### DK -- Docker / Sandbox

**BUG-DK-004** | `autonomy/sandbox.sh:1325` | Dev server port not published to host
When a dev server starts inside the sandbox container, its port is not included in the Docker `-p` publish list. The dev server is accessible only inside the container; the host's browser cannot reach the preview URL.

**BUG-DK-005** | `docker-compose.yml:13` | Enterprise image hardcoded to `v5.52.0`
The docker-compose file pins the enterprise image to `v5.52.0` instead of using the current version or `latest`. Users following the Docker deployment docs run an outdated version with known bugs and missing features.

**BUG-DK-006** | `autonomy/sandbox.sh:623` | API key corruption via shell expansion
API keys containing shell metacharacters (`$`, backticks, `!`) are interpolated without quoting into Docker environment flags. Shell expansion modifies the key value, causing authentication failures inside the container.

**BUG-DK-007** | `autonomy/app-runner.sh:247` | Hardcoded container name conflicts in parallel
The app runner uses a fixed container name for the dev server. Running two projects simultaneously causes a container name conflict, and the second project's dev server fails to start.

**BUG-DK-008** | `docker-compose.yml:34` | ChromaDB is hard dependency
The docker-compose file makes ChromaDB a required service (`depends_on`). Users who don't need code search must still run ChromaDB, consuming memory and requiring the ChromaDB image to be pulled.

**BUG-DK-009** | `autonomy/sandbox.sh:359` | Unescaped JSON in worktree state
The worktree state is written to a file using `echo` with unescaped JSON. Branch names or paths containing quotes break the JSON structure, causing subsequent reads to fail with parse errors.

**BUG-DK-010** | `autonomy/sandbox.sh:673` | Desktop sandbox uses wrong `run.sh` path
The desktop sandbox variant references `run.sh` at a hardcoded path that doesn't match the actual installation path. The sandbox starts but the orchestrator fails to launch, producing a confusing "file not found" error.

### CMD -- CLI Subcommands

**BUG-CMD-003** | `autonomy/loki:17042` | `cmd_ci github` format missing export
The CI GitHub output format sets variables locally but doesn't export them. The values are not available to subsequent steps in a GitHub Actions workflow, making the CI integration output useless.

**BUG-CMD-004** | `autonomy/loki:4806` | `cmd_watch` pipe subshell PID not propagated
The watch command pipes output through a formatter, which runs the main process in a subshell. The PID stored for cleanup is the formatter's PID, not the watcher's. Stopping the watch kills the formatter but leaves the watcher running.

**BUG-CMD-005** | `autonomy/loki:5287` | `cmd_config_set` stores all values as strings
The config set command stores all values as strings in JSON, including numbers and booleans. Config values like `parallel_streams: "3"` (string) cause type errors in code that expects `parallel_streams: 3` (number).

**BUG-CMD-006** | `autonomy/loki:13967` | `cmd_telemetry` Python code injection
The telemetry command interpolates user-supplied filter strings into Python code executed via `python3 -c`. A malicious filter string can execute arbitrary Python code.

**BUG-CMD-007** | `autonomy/loki:3378` | `cmd_web_stop` hardcodes dashboard port
The web stop command checks and kills processes on a hardcoded port rather than reading the configured or running port. If the dashboard was started on a custom port, `loki web stop` kills whatever process is on the default port (potentially another service) and leaves the actual dashboard running.

**BUG-CMD-008** | `autonomy/loki:14165` | `cmd_remote` orphans dashboard process
The remote command starts a dashboard process but doesn't store its PID in the standard PID file location. `loki web stop` doesn't know about this process, and it persists until manually killed.

---

## Low Severity Bugs

### CLI -- CLI Commands

**BUG-CLI-010** | `autonomy/loki:4930` | `_export_json` hardcodes version "6.0.0"
The JSON export function writes a hardcoded version string `"6.0.0"` instead of reading the current version. Exported JSON files report the wrong version, causing confusion when comparing exports across versions.

**BUG-CLI-011** | `autonomy/loki:5322` | `cmd_config_get` leaks env vars on failure
When config get fails (key not found), the error handler prints the full environment variable list for debugging. This can expose sensitive values like API keys in terminal output.

### RUN -- run.sh Orchestration

**BUG-RUN-012** | `autonomy/run.sh:8366` | BMAD queue marker set even when Python write fails
The BMAD integration sets a marker file indicating tasks were queued before verifying the Python script that writes the queue completed successfully. If the Python script fails, the marker exists but the queue is empty or partial.

### PROV -- Provider System

**BUG-PROV-012** | `providers/codex.sh:54` | `resolve_model_for_tier` returns effort levels vs model names
The Codex provider's tier resolver returns reasoning effort levels ("high", "medium", "low") instead of model names. The effort level is then passed as a model name parameter, which Codex rejects. This only affects explicit tier overrides, as the default path uses the correct model.

**BUG-PROV-013** | `autonomy/run.sh:9073` | Gemini `PIPESTATUS` not captured for primary invocation
The Gemini invocation exit code is taken from `$?` (last command in pipe) rather than `${PIPESTATUS[0]}` (the Gemini process). If the log tee succeeds but Gemini fails, the exit code shows success, masking provider failures.

### MEM -- Memory System

**BUG-MEM-012** | `memory/token_economics.py:513` | Redundant filesystem scan on first `get_summary` call
The token economics summary method scans the entire memory directory tree on its first call even when the data is already in memory. For large memory stores, this adds several seconds of latency to the first dashboard load.

**BUG-MEM-013** | `memory/vector_index.py:293` | Missing `encoding="utf-8"` on JSON sidecar write
The vector index writes JSON sidecar files without specifying encoding. On systems with non-UTF-8 default locale, non-ASCII content in episode metadata causes encoding errors or mojibake in the sidecar files.

**BUG-MEM-014** | `memory/consolidation.py:412` | `AttributeError` on dict-typed actions in `_episode_to_text`
The episode-to-text converter expects action objects with `.description` attributes, but some episodes store actions as plain dicts. Accessing `.description` on a dict raises `AttributeError`, causing consolidation to skip the entire episode.

### DASH -- Dashboard API

**BUG-DASH-012** | `dashboard/server.py:1433` | WebSocket idle timeout doesn't call disconnect
When a WebSocket connection times out due to inactivity, the connection is closed but the disconnect handler is not called. The connection remains in the active connections set, inflating connection counts and receiving broadcast messages that go nowhere.

**BUG-DASH-013** | `dashboard/server.py:1017` | GET `/api/tasks` ignores `project_id` parameter
The tasks listing endpoint accepts a `project_id` query parameter but doesn't filter by it. All tasks across all projects are returned regardless of the project filter, requiring client-side filtering.

### PAR -- Parallel Workflows

**BUG-PAR-012** | `autonomy/run.sh:2516` | Worktree count off-by-one (includes main)
The worktree count includes the main working tree, overstating the parallel stream count by 1. The system thinks it has reached max parallelism one stream early, unnecessarily limiting throughput.

**BUG-PAR-013** | `autonomy/run.sh:2276` | `python3` required for JSON parse with no fallback
The worktree status function uses `python3 -c` to parse JSON. If Python 3 is not installed (Docker minimal images, embedded systems), the function crashes instead of falling back to `jq` or basic text parsing.

**BUG-PAR-014** | `autonomy/run.sh:2188` | Max-sessions rejection orphans worktree
When the max parallel sessions limit is reached, new worktrees are created (directory exists) but the session is not started. The worktree directory persists with no running session, and `worktree list` shows it as active when it's actually idle.

### QG -- Completion Council / Quality Gates

**BUG-QG-012** | `autonomy/completion-council.sh:1341` | Council can approve at iteration 0 with `min=0`
When the minimum iterations config is 0 (or unset), the council can vote to complete before any work iteration has run. A noisy initial state file could trigger false completion detection at startup.

### ST -- State Management

**BUG-ST-011** | `state/manager.py:1234` | `optimistic_update` mutates cached state in-place
The optimistic update modifies the cached state dict directly instead of working on a copy. If the update fails and needs to rollback, the cache already contains the failed state. Subsequent reads return uncommitted data until the next cache refresh.

**BUG-ST-012** | `autonomy/run.sh:6194` | Checkpoint pruning sort broken on full paths
The checkpoint pruning sorts by full path string instead of extracting and sorting by the timestamp component. Checkpoints with lexicographically earlier paths (different project names) are pruned before chronologically older ones.

**BUG-ST-013** | `state/manager.py:1396` | `_merge_values` crashes on unhashable list types
The value merge function attempts to deduplicate lists by converting to a set, which fails if list elements are dicts or other unhashable types. Merging state that contains lists of objects raises `TypeError`.

### EVT -- Event Bus / Notifications

**BUG-EVT-011** | `events/bus.py:283` | Subscribe generator loses events in timing gap
The event subscription generator checks for new events by file position. Events written between the position check and the next read cycle are missed. Under high event throughput, subscribers can lose events.

**BUG-EVT-012** | `events/bus.py:144` | Set pruning nondeterministic, evicts recent IDs
The deduplication ID set is pruned by converting to a list and truncating. Since set iteration order is arbitrary in Python, recent IDs may be evicted while old ones are kept, allowing recent duplicate events to pass through.

**BUG-EVT-013** | `events/emit.sh:15` | Missing `set -e` allows malformed events
The shell emitter doesn't use `set -e`, so failures in JSON construction (missing `jq`, malformed inputs) don't stop execution. Malformed JSON is written to the event log, causing parse errors in all consumers.

**BUG-EVT-014** | `autonomy/notification-checker.py:252` | Only first quality gate failure reported
The notification checker breaks after finding the first quality gate failure event. Subsequent failures in the same check cycle are not reported. Users only see one failure notification even when multiple gates fail simultaneously.

### MCP -- MCP Server

**BUG-MCP-011** | `mcp/server.py:1456` | All exceptions swallowed in SQLite fallback
The SQLite fallback path catches all exceptions with a bare `except:` and returns an empty result. Bugs in the fallback code (typos, logic errors) are silently hidden, making debugging impossible.

**BUG-MCP-012** | `mcp/server.py:719` | Task ID collision after deletion
Task IDs are assigned by incrementing a counter that's never adjusted after deletion. Deleted task IDs are not recycled, but the counter can wrap or be reset on server restart, producing collisions with non-deleted tasks.

**BUG-MCP-013** | `mcp/server.py:647` | Internal fields leaked in API response
The task and project API responses include internal fields (`_lock`, `_dirty`, internal timestamps) that should be filtered before serialization. Clients see implementation details that may change without notice.

### ADP -- Adapters

**BUG-ADP-010** | `autonomy/loki:798` | MiroFish receives normalized PRD silently
When MiroFish adapter is invoked, the PRD text is normalized (whitespace collapsed, special chars stripped) before being passed to the adapter. The adapter receives modified content without any indication, potentially losing meaningful formatting.

**BUG-ADP-013** | `adapters/mirofish-adapter.py:174` | Predictable MD5 multipart boundary
The multipart boundary for file uploads is generated using MD5 of a predictable timestamp. This is not a security boundary (it's an HTTP separator), but could cause boundary collisions if two uploads happen in the same second.

### DS -- Purple Lab Dev Server

**BUG-DS-012** | `dashboard/server.py:327` | Command validator allows `&` character
The command injection validator blocks most shell metacharacters but allows `&`. A command containing `& malicious_command` would execute the malicious command in the background. Partially mitigated by other sandboxing, but the validator is incomplete.

### DK -- Docker / Sandbox

**BUG-DK-011** | `autonomy/app-runner.sh:148` | Port range parsing fails
The port range parser expects `start-end` format but doesn't handle single ports or comma-separated lists. Users specifying ports like `3000` (no range) or `3000,3001` get a parse error instead of the expected behavior.

**BUG-DK-012** | `autonomy/sandbox.sh:1679` | Mode detection mismatch on stop
The sandbox stop command re-detects the sandbox mode (Docker vs desktop) instead of reading the stored mode. If conditions have changed since start (Docker daemon stopped), the wrong stop procedure runs, leaving the sandbox partially cleaned up.

### CMD -- CLI Subcommands

**BUG-CMD-009** | `autonomy/loki:14765` | `cmd_metrics --share` uses variable before assignment
The metrics share subcommand references a variable before it's assigned in the `--share` code path. Under `set -u`, this crashes with "unbound variable" instead of generating the share link.

**BUG-CMD-010** | `autonomy/loki:18776` | `cmd_share` calls `loki` by name not `$0`
The share command invokes `loki` by its bare name instead of using `$0`. If the CLI was invoked via a different path or symlink, the recursive call may find a different version or fail with "command not found".

**BUG-CMD-012** | `autonomy/loki:10626` | `cmd_worktree merge` Python injection via interpolation
The worktree merge subcommand interpolates a branch name into a Python string without escaping. A branch name containing single quotes can inject arbitrary Python code.

---

## Agent 17: Templates + Init (12 bugs)

### TPL -- Templates and Initialization

**BUG-TPL-001** [high] | `autonomy/loki:6952` | `local -A` incompatible with macOS bash 3.2
Uses bash 4+ associative array syntax that crashes on macOS default bash 3.2, making template listing unusable on stock macOS.

**BUG-TPL-002** [high] | `autonomy/loki:7128` | Template resolution bypasses validation, arbitrary file injection
Template path resolution does not validate that the resolved path is within the templates directory, allowing `../../` traversal to inject arbitrary files as templates.

**BUG-TPL-003** [medium] | `autonomy/loki:6904` | `.loki/` guard checks CWD not target directory
The init guard that prevents re-initialization checks the current working directory for `.loki/` instead of the target project directory. Running `loki init /other/path` from inside an existing project is incorrectly blocked.

**BUG-TPL-004** [medium] | `autonomy/loki:7305` | README.md omitted from creation summary
The post-init summary lists created files but omits README.md, making users think it was not generated.

**BUG-TPL-005** [medium] | `templates/` | `rest-api` near-duplicate of `rest-api-auth`
Two templates with nearly identical content; only difference is an auth middleware section. Maintenance burden with no clear selection guidance.

**BUG-TPL-006** [medium] | `templates/` | `saas-app` near-duplicate of `saas-starter`
Same duplication issue as TPL-005 but for SaaS templates.

**BUG-TPL-007** [medium] | `templates/` | 9 templates missing critical sections for autonomous execution
Nine templates lack the structured sections (acceptance criteria, test plan, deployment target) that the autonomous runner expects, causing incomplete task decomposition.

**BUG-TPL-008** [medium] | `templates/README.md` | Documents only 13 of 22 templates
The templates README is stale -- 9 templates added since the last update are undocumented.

**BUG-TPL-009** [low] | `autonomy/loki:7064` | JSON output has commas on separate lines
The `--json` template list output places commas on their own lines, producing non-standard JSON formatting.

**BUG-TPL-010** [low] | `autonomy/loki:7280` | `echo` adds trailing newline, not byte-identical to template
Template file creation via `echo` appends a trailing newline that the source template lacks, causing checksum mismatches.

**BUG-TPL-011** [low] | `examples/` | Stale duplicates of 4 templates
The `examples/` directory contains copies of 4 templates that have since diverged from the originals in `templates/`.

**BUG-TPL-012** [medium] | `autonomy/loki:7083` | Category boundaries mismatch README
The category groupings in the template list command do not match the categories documented in `templates/README.md`.

---

## Agent 18: WebSocket + Terminal (12 bugs, 3 are duplicates)

### WS -- WebSocket and Terminal

**BUG-WS-001** [critical] | `dashboard/server.py:4041` | Pexpect auto-install leaves module unbound, NameError on PTY spawn
The auto-install of pexpect assigns to a local variable inside a try block; the module-level name remains unbound. Every subsequent PTY spawn raises `NameError`, making the terminal feature completely broken after the install path is hit.

**BUG-WS-002** [high] | `dashboard/server.py:4117` | Multi-tab terminal readers race on same PTY fd
Opening multiple terminal tabs for the same session creates concurrent readers on the same PTY file descriptor. Read calls interleave output arbitrarily, so each tab gets partial, garbled output.

**BUG-WS-004** [high] | `dashboard/server.py:2914` | Blocking `wait()` freezes event loop up to 8s
A synchronous `process.wait(timeout=8)` call inside an async handler blocks the entire asyncio event loop, freezing all WebSocket connections and API requests for up to 8 seconds.

**BUG-WS-006** [medium] | `dashboard/server.py:1529` | `_terminal_ws_clients` never cleaned on PTY close
When a PTY session closes, its WebSocket client set is not removed from `_terminal_ws_clients`. The dict grows unboundedly, and broadcast attempts to closed sockets produce noisy error logs.

**BUG-WS-007** [medium] | `dashboard/server.py:3950` | WS close codes lost when rejecting before accept
WebSocket connections rejected before `accept()` cannot send close codes per the ASGI spec. Clients see a generic disconnect instead of a meaningful rejection reason.

**BUG-WS-008** [medium] | `dashboard/server.py:3585` | Proxy drops binary frames client-to-upstream
The WebSocket proxy handler only relays text frames from client to upstream. Binary frames (file uploads, protobuf messages) are silently dropped.

**BUG-WS-009** [medium] | `dashboard/server.py:3869` | Blocking file I/O per client in async push loop
The log push loop reads files synchronously for each connected client inside an async function, blocking the event loop proportionally to the number of clients.

**BUG-WS-011** [medium] | `dashboard/server.py:3975` | Keepalive counter reset by any message, not just pongs
The keepalive missed-pong counter resets on any incoming message, not only pong frames. A client that sends data but never responds to pings is never detected as dead.

**BUG-WS-012** [low] | `dashboard/server.py:190` | `time.sleep(2)` blocks thread pool worker
A 2-second synchronous sleep in the startup path ties up a thread pool worker, reducing available concurrency during dashboard initialization.

*Note: BUG-WS-003 (log trimming, dupe of XC-009), BUG-WS-005 (dead code, dupe of PL-001/PL-002), and BUG-WS-010 (TimeoutExpired, dupe of PL-012) are listed in the Duplicates Removed table.*

---

## Agent 19: GitHub + CI (13 bugs, 2 are duplicates)

### GH -- GitHub and CI Integration

**BUG-GH-003** [high] | `autonomy/loki:16778` | Security scan flags secret REMOVAL as critical
The security scan diffs grep for secret-like patterns but does not distinguish additions from deletions. Removing a leaked secret triggers a critical finding, blocking the CI pipeline on a fix.

**BUG-GH-004** [medium] | `autonomy/loki:16864` | `.replace()` chaining produces `.test.test.tsx`
The test file suggestion applies `.replace('.ts', '.test.ts')` then `.replace('.tsx', '.test.tsx')`, but the first replacement already changed `.tsx` to `.test.tsx`, so the second produces `.test.test.tsx`.

**BUG-GH-005** [medium] | `autonomy/loki:17134` | `--github-comment` re-runs entire pipeline
The `--github-comment` flag posts CI results to a PR but also re-triggers the full CI pipeline instead of using cached results.

**BUG-GH-006** [medium] | `.github/workflows/release.yml:408` | VSCode build uses `build` not `build:all`
The release workflow runs `npm run build` for the VSCode extension instead of `build:all`, omitting the dashboard IIFE bundle from the published extension.

**BUG-GH-007** [medium] | `.github/workflows/release.yml:437` | Homebrew SHA256 may hash error page
The Homebrew tap update computes SHA256 of the downloaded tarball URL, but if the download fails (404, rate limit), it hashes the error page HTML instead, producing a valid but wrong checksum.

**BUG-GH-008** [medium] | `.github/workflows/test.yml:89` | Shell tests `continue-on-error` hides failures
Shell test steps use `continue-on-error: true`, so failing tests do not fail the CI job. Regressions pass CI silently.

**BUG-GH-009** [medium] | `autonomy/run.sh:1927` | Hardcoded `--label "loki-mode"` fails silently
GitHub issue creation uses a hardcoded label that may not exist in the target repo. `gh` exits non-zero, and the error is swallowed.

**BUG-GH-010** [medium] | `autonomy/issue-parser.sh:260` | Exit code check fragile
The issue parser checks `$?` after a pipeline, capturing only the last command's exit code. Parser failures in earlier pipeline stages are masked.

**BUG-GH-011** [low] | `autonomy/loki:3539` | Missing space in `gh status` output
A string concatenation omits a space between the status icon and the text label, producing "Xfailing" instead of "X failing".

**BUG-GH-012** [low] | `.github/workflows/release.yml:200` | Double-escaping in Slack notification
The Slack notification payload double-escapes special characters, displaying literal `\n` and `\"` in the Slack message instead of newlines and quotes.

**BUG-GH-013** [low] | `.github/workflows/integrity-audit.yml:138` | YAML indentation leaks into issue markdown
The GitHub issue body is constructed from an indented YAML block scalar, and the leading spaces are preserved in the rendered markdown, producing code-block-style formatting for regular text.

*Note: BUG-GH-001 (dupe of CMD-002) and BUG-GH-002 (dupe of CMD-003) are listed in the Duplicates Removed table.*

---

## Agent 20: npm Package + Installation (13 bugs, 1 is duplicate)

### PKG -- npm Package and Installation

**BUG-PKG-001** [high] | `autonomy/run.sh:502` | Config loader misses 7 of 13 settable keys
The config file parser only recognizes 6 of the 13 keys that `loki config set` can write. The remaining 7 keys are silently ignored at load time, so user-configured values have no effect.

**BUG-PKG-002** [high] | `package.json:65` | `state/` missing from npm tarball
The `files` field in `package.json` does not include `state/`. After `npm install -g`, the state manager cannot find its schema files, causing crashes on first use.

**BUG-PKG-013** [high] | `autonomy/loki:5203` | `config set` is cwd-relative only, no global option
`loki config set` always writes to `.loki/config.json` in the current directory. There is no way to set global defaults that apply across all projects.

**BUG-PKG-003** [medium] | `autonomy/loki:5474` | `config edit` hardcodes local path after global init
After `loki init --global`, the `config edit` command still opens the local `.loki/config.json` instead of the global config path.

**BUG-PKG-004** [medium] | `docs/INSTALLATION.md:57` | Docs say Node 16+, `package.json` requires 18+
The installation docs list Node 16 as the minimum, but `package.json` specifies `engines.node >= 18`. Users on Node 16 install successfully but hit runtime errors.

**BUG-PKG-005** [medium] | `Dockerfile:85` | `integrations/` in Dockerfile but not in `files` field
The Dockerfile copies `integrations/` but the directory is not in `package.json` `files`. Docker builds from the npm tarball fail; only builds from the git repo work.

**BUG-PKG-006** [medium] | `Dockerfile:92` | Missing `chmod +x` for 3+ scripts
Three shell scripts copied into the Docker image lack execute permission. Container startup fails with "permission denied" for those scripts.

**BUG-PKG-007** [medium] | `Dockerfile:95` | Only Claude skill symlink; Codex/Gemini missing
The Dockerfile creates a `SKILL.md` symlink only for Claude. Codex and Gemini skill symlinks are not created, so those providers cannot discover their skill files inside the container.

**BUG-PKG-008** [medium] | `loki-mode.js:13` | `shell:true` breaks paths with spaces
The Node.js wrapper uses `child_process.spawn` with `shell: true` and unquoted path interpolation. Installation paths containing spaces (e.g., `Program Files`) break the spawn command.

**BUG-PKG-010** [low] | `postinstall.js:98` | Volatile Homebrew symlinks
The postinstall script creates symlinks into Homebrew prefix paths that change on `brew upgrade`. After a Homebrew update, the symlinks break silently.

**BUG-PKG-011** [medium] | `Dockerfile` | `state/` missing from Docker images
Same root cause as PKG-002 but in the Docker context -- the Dockerfile does not copy `state/`, so containerized runs lack the state manager schemas.

**BUG-PKG-012** [low] | `Dockerfile` | `completions/` missing from Docker images
Shell completions are not copied into the Docker image. Users inside the container have no tab completion.

*Note: BUG-PKG-009 (dupe of CLI-011) is listed in the Duplicates Removed table.*

---

## Appendix: Bug Distribution by Component

| Component | Critical | High | Medium | Low | Total |
|-----------|----------|------|--------|-----|-------|
| CLI Commands (CLI) | 0 | 4 | 6 | 2 | 12 |
| run.sh Orchestration (RUN) | 0 | 4 | 7 | 1 | 12 |
| Provider System (PROV) | 0 | 4 | 7 | 2 | 13 |
| Memory System (MEM) | 0 | 3 | 8 | 3 | 14 |
| Dashboard API (DASH) | 1 | 3 | 7 | 2 | 13 |
| Parallel Workflows (PAR) | 0 | 3 | 8 | 3 | 14 |
| Completion Council (QG) | 0 | 5 | 6 | 1 | 12 |
| State Management (ST) | 0 | 2 | 6 | 3 | 11 |
| Event Bus (EVT) | 0 | 3 | 7 | 4 | 14 |
| MCP Server (MCP) | 0 | 3 | 7 | 3 | 13 |
| Adapters (ADP) | 0 | 3 | 7 | 2 | 12 |
| Dev Server (DS) | 0 | 3 | 7 | 1 | 11 |
| Purple Lab Sessions (PL) | 2 | 5 | 6 | 0 | 13 |
| Cross-Cutting (XC) | 0 | 2 | 7 | 0 | 9 |
| Docker/Sandbox (DK) | 0 | 3 | 6 | 2 | 11 |
| CLI Subcommands (CMD) | 0 | 2 | 4 | 4 | 10 |
| Templates/Init (TPL) | 0 | 2 | 7 | 3 | 12 |
| WebSocket/Terminal (WS) | 1 | 2 | 5 | 1 | 9 |
| GitHub/CI (GH) | 0 | 1 | 7 | 3 | 11 |
| npm Package/Install (PKG) | 0 | 3 | 6 | 2 | 11 |
| **Total** | **4** | **57** | **121** | **38** | **220** |

*Note: The appendix total (220) exceeds the deduplicated total (215) because some bugs are listed under their primary component AND cross-referenced from another component's agent report. The canonical count of unique bugs is 215.*

---

*End of Bug Audit Report -- v6.61.0 (20 agents, 215 unique bugs)*
