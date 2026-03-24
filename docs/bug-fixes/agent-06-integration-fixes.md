# Agent 06: Purple Lab + CLI Integration Fixes

## Summary

Investigated and fixed 5 integration bugs between Purple Lab (web-app/server.py) and the loki CLI (autonomy/loki, autonomy/run.sh). All bugs were at the boundary where the web server dispatches to the CLI or reads CLI-produced state files.

## Bugs Fixed

### BUG-INT-001: Quick-start API doesn't pass provider selection to CLI

**File:** `web-app/server.py` (start_session endpoint, line ~2537)

**Root cause:** When `req.mode == "quick"`, the command built was `loki quick <description>` without passing the provider. The `--provider` flag was only included in the `else` branch (full `loki start` mode). Since `loki quick` does not accept a `--provider` flag, the fix passes the provider via the `LOKI_PROVIDER` environment variable, which `run.sh` reads at line 665.

**Fix:** After constructing `build_env`, inject `LOKI_PROVIDER` from `req.provider` for all modes (both quick and start). This ensures the correct AI provider is used regardless of invocation mode.

---

### BUG-INT-002: Session state file format mismatch between web and CLI

**Files:** `web-app/server.py` (3 locations), `autonomy/run.sh`

**Root cause:** The web server read session state from `.loki/state/session.json`, but the CLI never writes that file. The CLI writes:
- `.loki/dashboard-state.json` (via `write_dashboard_state()` in run.sh) -- contains phase, iteration, complexity, tasks, tokens, agents
- `.loki/state/orchestrator.json` -- contains currentPhase
- `.loki/autonomy-state.json` -- contains retryCount, iterationCount, status

The web server was reading from a nonexistent file, so status fields (phase, iteration, complexity, cost, pending tasks) were always default values.

**Fix:** Changed 3 locations in server.py to read from `dashboard-state.json` (primary) with `state/orchestrator.json` fallback:
1. `get_status()` endpoint (GET /api/session/status)
2. `_push_state_to_client()` WebSocket push loop
3. `_infer_session_status()` for session history

Field mapping updated to match `dashboard-state.json` structure:
- `tasks.pending` instead of `pending_tasks` (nested object)
- `tasks.inProgress` for current task detection
- `tokens.cost_usd` for cost (same structure, just different file)

---

### BUG-INT-003: WebSocket connection drops during long builds (no reconnect)

**Files:** `web-app/src/api/client.ts`, `web-app/server.py`

**Root cause:** The server sends keepalive pings every 60 seconds of client silence (line 5400). If 2 consecutive pings receive no pong response, the server disconnects the WebSocket (line 5396-5398). The client's `PurpleLabWebSocket` class parsed incoming messages and emitted events but never handled the `ping` message type -- it just passed it through to listeners (which nobody listened for). During long builds, the client sends no messages, so the server disconnects after ~120 seconds.

The client already had reconnect logic (3-second delay after disconnect), but reconnection during a build causes loss of the log backfill window and a brief UI disruption.

**Fix:** Added ping/pong handling in the client's `onmessage` handler. When the client receives a `{type: "ping"}` message, it immediately responds with `{type: "pong"}` via `this.send()`, preventing the server from closing the connection.

---

### BUG-INT-004: File watcher ignores changes based on absolute path

**File:** `web-app/server.py` (FileChangeHandler._should_ignore)

**Root cause:** The `_should_ignore` method decomposed the FULL absolute path into parts and checked each part against `_WATCH_IGNORE_DIRS` (which includes "build", "dist", "cache", ".git", etc.). If the project was stored at a path containing any of these directory names (e.g., `/home/user/build/my-project/src/app.js`), ALL file events would be silently ignored.

The check should only examine path components RELATIVE to the project directory, since only directories within the project should be filtered.

**Fix:** Changed `_should_ignore` to compute `os.path.relpath(path, self.project_dir)` before decomposing into parts. This ensures only project-internal directory names are checked against the ignore list.

---

### BUG-INT-005 (NEW): Chat endpoint hardcodes provider as "claude"

**File:** `web-app/server.py` (chat_session endpoint, line ~3957)

**Root cause:** In the chat endpoint's "max" mode, the command was hardcoded as `[loki, "start", "--provider", "claude", str(prd_path)]`. Users who selected a different provider (codex, gemini) would have their chat commands always routed to Claude. Similarly, "quick" and "standard" modes did not pass any provider information.

Additionally, 3 other `loki quick` invocations (monitor auto-fix, Docker service fix, fix endpoint) also had no provider passthrough.

**Fix:**
1. Chat endpoint now reads the provider from `session.provider` and `.loki/state/provider` file
2. Max mode passes the detected provider to `--provider` flag
3. Quick/standard modes pass provider via `LOKI_PROVIDER` env var
4. Fix endpoint (`/api/sessions/{id}/fix`) passes provider via env
5. Monitor auto-fix (`_auto_fix` method) reads provider from session state
6. Docker service auto-fix reads provider from session state

## Files Modified

| File | Changes |
|------|---------|
| `web-app/server.py` | BUG-INT-001 through BUG-INT-005: provider passthrough, state file path correction, file watcher relative path |
| `web-app/src/api/client.ts` | BUG-INT-003: WebSocket ping/pong handler |

## Verification

- Python syntax validated: `python3 -c "import ast; ast.parse(open('web-app/server.py').read())"`
- TypeScript changes verified (no new errors beyond pre-existing Vite import.meta issues)
- All fixes are backward-compatible (fallback to "claude" provider, fallback to orchestrator.json)

## Edge Cases Considered

1. **Concurrent sessions**: Each chat task creates its own subprocess with its own env, so provider isolation is maintained
2. **Missing provider file**: Falls back to `session.provider` then to `"claude"` default
3. **Project directory in ignored path**: Fixed by relative path computation; `os.path.relpath` handles cross-drive paths on Windows via ValueError catch
4. **WebSocket reconnection during build**: Client now responds to pings, preventing premature disconnection; if disconnection still occurs, the 3-second reconnect timer handles recovery
5. **State file corruption**: All JSON reads wrapped in try/except with fallback defaults
