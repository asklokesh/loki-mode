# Agent 09: Full Build E2E Testing - Bug Fixes

## Pipeline Traced

Complete flow from prompt submission to preview:

1. `POST /api/session/quick-start` (web-app/server.py) -> validates, generates PRD
2. `start_session()` -> spawns `loki start` via Popen with merged stdout/stderr
3. `_read_process_output()` -> reads lines, broadcasts via WebSocket
4. `loki start` -> `cmd_start()` (autonomy/loki) -> `run_autonomous()` (autonomy/run.sh)
5. RARV loop: `build_prompt()` -> provider invocation -> quality gates -> iterate
6. File watcher detects changes -> broadcasts `file_changed` -> frontend refreshes
7. Chat iteration: `POST /api/sessions/{id}/chat` -> `loki quick` in project dir

## Known Bugs Fixed

### BUG-E2E-001: Quick-start empty/short prompt validation
- **File**: `web-app/server.py` (line ~2600)
- **Problem**: Quick-start accepted prompts of any length (even 1 char), leading to degenerate builds
- **Fix**: Added minimum 3-character validation after trim. Empty strings were already caught, but trivial strings like "a" could still trigger a full build pipeline.

### BUG-E2E-002: Build output loses ordering
- **File**: `web-app/server.py` (`_read_process_output`, WebSocket backfill)
- **Problem**: Log lines broadcast via WebSocket had no sequence number, making it impossible for the frontend to detect gaps or reorder after reconnection.
- **Root cause**: stdout/stderr were already merged at OS level via `stderr=subprocess.STDOUT` (so pipe ordering is correct), but WebSocket reconnection could cause the frontend to miss lines with no way to detect the gap.
- **Fix**: Added `seq` field (using `session.log_lines_total`) to every log broadcast and backfill message. Frontend can now detect missed lines and request backfill.

### BUG-E2E-003: Preview iframe doesn't reload when files change
- **File**: `web-app/src/components/ProjectWorkspace.tsx` (line ~573)
- **Problem**: File change events only triggered iframe reload when no dev server was running (`!devServer?.running`). When a dev server was running, even non-HMR servers (Express, Flask, static servers) never got a reload.
- **Fix**: Now reloads the iframe for all non-HMR frameworks. HMR-capable frameworks (react, vite, next, nuxt, svelte, remix) are excluded since they handle live reload natively.

### BUG-E2E-004: Chat iteration doesn't pass previous context to AI
- **Files**: `web-app/server.py` (ChatRequest model, chat handler), `web-app/src/api/client.ts`, `web-app/src/components/AIChatPanel.tsx`
- **Problem**: Each chat message was sent to the AI in isolation. The `loki quick` command had no awareness of what was previously discussed, making iterative development frustrating (user had to repeat context).
- **Fix**:
  1. Added `history` field to ChatRequest model (optional list of {role, content})
  2. Frontend now sends last 10 messages as conversation history
  3. Server injects history as "PREVIOUS CONVERSATION CONTEXT" prefix to the prompt
  4. Long assistant responses truncated to 500 chars to avoid token bloat

### BUG-RUN-001/002: Midnight crossing bugs (already fixed, verified)
- **File**: `autonomy/run.sh` (line ~9366)
- **Status**: Already fixed in previous commit. Uses per-iteration `iter_output` temp file instead of daily `log_file` for completion promise checks and rate limit detection.

## New Bugs Discovered and Fixed

### BUG-E2E-005: iter_output temp file leak on success path
- **File**: `autonomy/run.sh` (lines ~9852, ~9899)
- **Problem**: The per-iteration output file (`iter_output`) was cleaned up only on the error/retry path (line 9952) and completion paths (lines 9867, 9882). The normal success path (line 9899) did `continue` without cleanup, leaking a temp file per successful iteration.
- **Impact**: Long-running sessions in `.loki/logs/` would accumulate `iter-output-XXXXXX` files, one per iteration. A 100-iteration session would leak ~100 temp files.
- **Fix**: Added `rm -f "$iter_output"` before `continue` on both success paths (perpetual mode at line 9852 and normal success at line 9899).

### BUG-E2E-006: Provider validation missing on request models
- **File**: `web-app/server.py` (StartRequest, QuickStartRequest models)
- **Problem**: The `provider` field on StartRequest and QuickStartRequest accepted any string. An unknown provider like `"evil"` would be passed to `loki start --provider evil`, which would fail inside run.sh but waste resources spawning a process.
- **Fix**: Added `@field_validator("provider")` that validates against the known set: claude, codex, gemini, cline, aider.

### BUG-E2E-007: ChatRequest message not validated
- **File**: `web-app/server.py` (ChatRequest model)
- **Problem**: The `message` field had no validation. An empty string or a 10MB message could be sent, either causing a useless `loki quick ""` invocation or excessive memory usage.
- **Fix**: Added `@field_validator("message")` that rejects empty messages and enforces a 100KB limit.

## Verification

- Python syntax: `ast.parse()` passes for `web-app/server.py`
- Bash syntax: `bash -n autonomy/run.sh` passes
- TypeScript: No new errors introduced (pre-existing errors are all from missing node_modules)
- All fixes are backward compatible (new fields are optional, new validations reject previously-invalid input)
