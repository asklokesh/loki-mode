# Loki Mode Edge Case Test Scenarios

Agent 12 - Scenario Writing: Edge Cases, Error Paths, Concurrent Usage
Version: v6.71.1 | Date: 2026-03-24

---

## Table of Contents

1. [Error Path Scenarios (EP-001 to EP-015)](#error-path-scenarios)
2. [Concurrent Usage Scenarios (CU-001 to CU-010)](#concurrent-usage-scenarios)
3. [Edge Case Scenarios (EC-001 to EC-015)](#edge-case-scenarios)
4. [Boundary Scenarios (BD-001 to BD-010)](#boundary-scenarios)

---

## Error Path Scenarios

### EP-001: Empty PRD File Input

**Given** a user has an empty file at `./empty.md` (0 bytes)
**When** they run `loki start ./empty.md`
**Then** the system should:
- Detect the PRD has 0 words in `detect_complexity()` (run.sh:1268)
- Classify complexity as "simple" (words < 200, features < 5, sections < 3)
- Enter codebase analysis mode since the PRD has no content
- Log a warning that the PRD file is empty and switch to analysis mode

**Expected behavior:** Graceful degradation to codebase analysis mode. No crash.

**Current risk:** `wc -w < "$prd_path"` returns 0, `grep -c` returns 0 -- both handle empty files correctly. The system proceeds but generates a trivial "simple" classification, which may be incorrect if the project itself is complex.

**Suggested improvement:** Add an explicit empty-file check before complexity detection.

---

### EP-002: Malformed JSON PRD Input

**Given** a user provides a PRD file `bad.json` containing `{invalid json`
**When** they run `loki start bad.json`
**Then** the system should:
- Attempt JSON parsing in `detect_complexity()` (run.sh:1276)
- The `jq` command fails silently (`2>/dev/null || echo "0"`)
- Fall back to `grep -c` which counts 0 features
- Classify as "simple" complexity

**Expected behavior:** No crash. Falls through to standard complexity classification.

**Current risk:** If `jq` is not installed, the fallback grep-based counting works but produces inaccurate results for malformed JSON. The PRD content is still passed to the AI provider as-is, which will likely fail at interpretation.

---

### EP-003: Network Failure Mid-Build

**Given** an autonomous session is running at iteration 15 of 1000
**When** the network connection drops (DNS resolution fails, API timeout)
**Then** the system should:
- The provider CLI (claude/codex/gemini) exits with a non-zero exit code
- `run_autonomous()` captures the exit code in `$exit_code` (run.sh:9406)
- Rate limit detection runs via `is_rate_limited()` (checks for common rate limit strings)
- If failover is enabled (`LOKI_FAILOVER=true`), attempt `attempt_provider_failover()`
- Otherwise, apply exponential backoff via `calculate_wait()` (run.sh:6721)
- State is saved with `save_state $retry "running" $exit_code`
- Next iteration retries

**Expected behavior:** Retry with exponential backoff (capped at MAX_WAIT=3600s). Session survives.

**Current risk:** The backoff caps at 1 hour. A prolonged network outage lasting multiple hours will burn through all MAX_RETRIES (default 50) entries, each waiting up to 1 hour. After 50 retries, the session terminates. No automatic resume after connectivity returns.

---

### EP-004: API Key Expired During Autonomous Run

**Given** an autonomous session is running with a valid API key
**When** the API key expires or is revoked mid-session
**Then** the system should:
- The provider CLI returns an authentication error (exit code non-zero)
- The error output is captured in `$iter_output` and `$agent_log`
- `is_rate_limited()` scans for rate-limit patterns but may not detect auth errors
- If failover is enabled, the system checks `check_provider_health()` which validates `$key_var` is set (but not that it is valid)
- The system retries with exponential backoff

**Expected behavior:** Session retries until MAX_RETRIES is exhausted.

**Bug found (BUG-EP-004):** `check_provider_health()` (run.sh:6864) only checks if the API key environment variable is non-empty (`[ -n "${ANTHROPIC_API_KEY:-}" ]`). It does not validate that the key is actually functional. Failover logic may skip to a healthy-looking but equally broken provider if all keys are from the same account. The system should distinguish auth errors from rate limits and surface them differently.

---

### EP-005: Disk Full During Code Generation

**Given** the filesystem has less than 1MB free space
**When** the AI provider attempts to write generated code to disk
**Then** the system should:
- The provider CLI writes to `$iter_output` (a temp file in .loki/logs/)
- `mktemp` fails when disk is full, causing the provider output to be lost
- `save_state()` writes to `.loki/autonomy-state.json.tmp.$$` which also fails
- `create_checkpoint()` fails to write checkpoint metadata
- The entire iteration is lost with no recovery

**Expected behavior:** Session should detect disk space issues and pause gracefully.

**Current risk:** No disk space checks exist. `set -e` is active in run.sh, but errors in subshells (piped commands, background processes) may not propagate. The temp file approach for `save_state()` (BUG-XC-004 fix) will fail silently when `cat > "$state_tmp"` fails, then `mv` will fail, leaving the system in an inconsistent state.

**Suggested improvement:** Add a pre-iteration disk space check. If free space is below a threshold (e.g., 100MB), pause the session.

---

### EP-006: Provider CLI Not Installed

**Given** a user specifies `--provider codex` but `codex` is not in PATH
**When** they run `loki start --provider codex ./prd.md`
**Then** the system should:
- `load_provider()` (loader.sh:25) sources `codex.sh`
- `validate_provider_config()` checks required variables
- The `provider_detect()` function (called by `check_provider_installed()`) fails
- run.sh's `check_prerequisites()` function validates the API key for the provider
- If codex CLI is missing: `command -v codex &>/dev/null` returns 1 (but this check is in health checking, not in the startup path for non-failover mode)

**Expected behavior:** Clear error message indicating the CLI is not installed, with installation instructions.

**Current risk:** The check at run.sh:1173 (`command -v cline &>/dev/null`) is only for cline/aider. For codex, the check is whether the API key is set. If OPENAI_API_KEY is set but codex CLI is missing, the session will start and fail on the first provider invocation. The error from the shell will be `codex: command not found` which is captured in the log but not surfaced cleanly.

---

### EP-007: Invalid Template Selection

**Given** a user runs `loki init -t nonexistent-template`
**When** the init command processes the template flag
**Then** the system should:
- Check the `templates/` directory for a matching template
- If not found, display available templates
- Exit with a clear error message

**Expected behavior:** List available templates and exit with error code 1.

---

### EP-008: Corrupted session.json State File

**Given** a previous session crash left a partially-written `.loki/session.json` containing `{"status": "runn`
**When** a user runs `loki status` or `loki start`
**Then** the system should:
- `load_state()` (run.sh:7956) calls `python3 -c "import json; print(json.load(...))"` which raises JSONDecodeError
- The `2>/dev/null || echo "unknown"` fallback returns "unknown"
- RETRY_COUNT defaults to 0, ITERATION_COUNT defaults to 0
- The session starts fresh

**Expected behavior:** Graceful recovery. Starts a new session with a warning.

**Bug found (BUG-EP-008):** `_safe_json_read()` in dashboard/server.py (line 79) retries once with a 0.1s sleep on JSONDecodeError, then returns `default`. But the CLI's `load_state()` in run.sh does NOT use `_safe_json_read()` -- it uses raw `python3 -c "import json; ..."` with a fallback. This means the CLI recovery path is less robust. A corrupted file causes a fresh start, which loses all progress (iteration count, retry count). The system should attempt to reconstruct state from checkpoints if session.json is corrupted.

---

### EP-009: WebSocket Disconnect During Build

**Given** a user has the dashboard open with an active WebSocket connection
**When** the network blips and the WebSocket disconnects
**Then** the system should:
- The `websocket_endpoint()` (server.py:1378) catches `WebSocketDisconnect`
- `manager.disconnect(websocket)` removes the connection from `active_connections`
- The autonomous build continues unaffected (it does not depend on WebSocket)
- When the client reconnects, it gets a fresh "connected" message
- The background `_push_loki_state_loop()` skips broadcasting when no clients are connected

**Expected behavior:** Build continues. Client reconnects and gets current state.

**Current risk:** The client must handle reconnection logic. If the client does not implement reconnection with backoff, the user sees a stale dashboard. The server sends pings every 30s and closes idle connections after 2 missed pongs (60s total). This is working correctly.

---

### EP-010: Concurrent Chat Messages During Build

**Given** an autonomous build is running
**When** a user submits a chat message via the dashboard while the AI provider is processing
**Then** the system should:
- The chat message is written to `.loki/HUMAN_INPUT.md` (via dashboard control API)
- `check_human_intervention()` (run.sh:~9292) detects the file at the start of the next iteration
- The `LOKI_HUMAN_INPUT` variable is set with the content
- `build_prompt()` injects it as `HUMAN_DIRECTIVE (PRIORITY)` in the prompt
- After consumption, the parent shell clears `LOKI_HUMAN_INPUT` (run.sh:9327)

**Expected behavior:** Message is queued and injected in the next iteration's prompt.

**Current risk:** If the user sends multiple messages before the next iteration starts, only the last one will be processed (each write to HUMAN_INPUT.md overwrites the previous). Earlier messages are lost.

---

### EP-011: Rate Limit Hit With No Fallback Provider

**Given** `LOKI_FAILOVER=false` (default) and the primary provider hits a rate limit
**When** the rate limit error is detected via `is_rate_limited()`
**Then** the system should:
- Detect rate limit patterns in the output
- Apply exponential backoff via `calculate_wait()` (base 60s, up to 3600s max)
- Retry after the backoff period
- Continue until MAX_RETRIES is exhausted

**Expected behavior:** Exponential backoff with jitter, eventual recovery.

**Current risk:** With base wait of 60s and exponential growth, after ~6 retries the backoff hits the 3600s (1 hour) cap. The system waits an hour between each attempt. If the rate limit lasts 24 hours, the session burns through ~24 retries at 1 hour each. This is correct but slow recovery.

---

### EP-012: Memory System Corruption Recovery

**Given** the `.loki/memory/index.json` file is corrupted (invalid JSON)
**When** the next memory operation attempts to load the index
**Then** the system should:
- `MemoryStorage._load_json()` (storage.py:276) catches `json.JSONDecodeError` and returns `None`
- The caller receives None and must handle it
- `_ensure_index()` only runs on initialization (when index does not exist)
- Subsequent memory operations that depend on the index silently fail

**Expected behavior:** Memory operations degrade gracefully. Build continues.

**Bug found (BUG-EP-012):** When `_load_json()` returns None for a corrupted index.json, the index is NOT automatically recreated. `_ensure_index()` checks `if not index_path.exists()` which returns False (the file exists, just corrupted). The system should detect corruption and recreate the index from individual episode/pattern files. Currently, all memory operations silently fail until a human manually deletes the corrupted file.

---

### EP-013: Git Conflicts During Parallel Worktree Merge

**Given** parallel mode is enabled with multiple worktrees working on different features
**When** two worktrees modify the same file and auto-merge is attempted
**Then** the system should:
- The auto-merge process detects the conflict
- Mark the conflicting merge as failed
- Log the conflicting files
- Continue the main session without the conflicted changes

**Expected behavior:** Merge failure is logged. Non-conflicting changes are merged. Conflicting changes require manual resolution.

---

### EP-014: Browser Closed During Long Build

**Given** a user starts a build via the web dashboard and closes the browser tab
**When** the build is at iteration 50 of 1000
**Then** the system should:
- The WebSocket connection drops (handled by EP-009 above)
- The autonomous build continues in the background (it runs as a shell process)
- The dashboard server continues running
- When the user reopens the browser, the dashboard reconnects and shows current state

**Expected behavior:** Build is completely unaffected. Dashboard reconnects on reopen.

---

### EP-015: kill -9 During Checkpoint Save

**Given** the system is mid-write in `create_checkpoint()` (run.sh:6283)
**When** `kill -9` is sent to the Loki process
**Then** the system should:
- The process terminates immediately (SIGKILL cannot be caught)
- The `trap cleanup INT TERM` handler does NOT run (SIGKILL bypasses traps)
- Partial files may exist: `.loki/state/checkpoints/cp-*/metadata.json` may be incomplete
- The temp file for `save_state()` (`.loki/autonomy-state.json.tmp.$$`) is orphaned
- The `.loki/loki.pid` file is stale (points to dead process)

**Expected behavior on next start:**
- `load_state()` reads the last good `autonomy-state.json` (the temp file is never renamed)
- The stale PID file is detected by `kill -0 "$dpid"` returning false
- Checkpoint index may be inconsistent with actual checkpoint directories

**Bug found (BUG-EP-015):** Orphaned temp files `.loki/autonomy-state.json.tmp.*` accumulate on repeated kill -9. No cleanup code removes these. The `_cleanup_stale_locks()` in storage.py only handles `.lock` files, not `.tmp` files.

**Suggested improvement:** On startup, clean up `*.tmp.*` files in `.loki/` that are older than 5 minutes.

---

## Concurrent Usage Scenarios

### CU-001: Two Users Same Project Simultaneously

**Given** User A and User B both run `loki start` in the same project directory
**When** both processes attempt to write to `.loki/autonomy-state.json` and `.loki/loki.pid`
**Then** the system should:
- The second invocation should detect an existing `loki.pid` and warn
- If the PID in `loki.pid` is alive, refuse to start (or require `--force`)
- If the PID is stale, overwrite and proceed

**Expected behavior:** Only one active session per project directory.

**Current risk:** The PID file check exists, but there is a TOCTOU race between reading the PID file and starting the new session. Two processes starting within milliseconds could both pass the check and run concurrently, causing interleaved writes to shared state files.

---

### CU-002: Multiple Builds Running At Once (Different Projects)

**Given** User runs `loki start` in `/project-a/` and `/project-b/` simultaneously
**When** both builds are running
**Then** the system should:
- Each project has its own `.loki/` directory
- Dashboard server instances may conflict on port 57374 (the default)
- The second build should either use a different port or detect the conflict

**Expected behavior:** Both builds run independently. Port conflict is handled.

**Bug found (BUG-CU-002):** The dashboard port is hardcoded as default `57374` (LOKI_DASHBOARD_PORT). If two projects both start dashboards, the second `uvicorn` instance fails to bind the port. The error is logged but the build proceeds without a dashboard. There is no automatic port increment or discovery of an alternative port.

---

### CU-003: Dashboard + CLI Controlling Same Session

**Given** a build is running via `loki start`
**When** the user simultaneously:
- Sends a "pause" command via the dashboard web UI
- Runs `loki pause` in the terminal
**Then** the system should:
- Both commands write `.loki/PAUSE` (creating it if it does not exist)
- `check_human_intervention()` detects the PAUSE file on the next iteration
- The system enters pause mode once
- No conflict arises since PAUSE is a boolean flag (file exists or not)

**Expected behavior:** Session pauses once. No double-pause issues.

---

### CU-004: Pause From CLI While Chat Active in Web

**Given** a user has typed a chat message in the web dashboard
**When** another terminal runs `loki pause`
**Then** the system should:
- The PAUSE file is created
- On the next iteration, the system pauses
- The chat message (if not yet submitted) remains in the browser's input field
- If the chat message was submitted (written to HUMAN_INPUT.md), it will be consumed when the session resumes

**Expected behavior:** Pause takes priority. Chat message is preserved for after resume.

---

### CU-005: Export While Build in Progress

**Given** an autonomous build is running at iteration 42
**When** the user runs `loki export json` in another terminal
**Then** the system should:
- `cmd_export()` reads from `.loki/` state files
- It reads `state/orchestrator.json`, `queue/*.json`, etc.
- These files may be mid-write by the running build
- The export uses Python's `json.load()` which may fail on partial files

**Expected behavior:** Export succeeds with the latest complete state snapshot.

**Bug found (BUG-CU-005):** The export function `_export_json()` (loki:5034) reads multiple state files without any locking. If the build process is mid-write (between temp file creation and atomic rename), the export may read an incomplete file. While atomic rename prevents partial reads, there is no guarantee of a consistent snapshot across multiple files. The export may capture `queue/pending.json` from iteration 42 and `state/orchestrator.json` from iteration 41.

---

### CU-006: Template Creation During Template Listing

**Given** User A runs `loki init -t` to list templates
**When** User B simultaneously saves a new template to the `templates/` directory
**Then** the system should:
- The listing reads the directory contents at a point in time
- The new template may or may not appear depending on timing
- No crash or corruption occurs

**Expected behavior:** Listing shows a consistent snapshot. New template appears on next listing.

---

### CU-007: Memory Consolidation During Retrieval

**Given** the memory consolidation pipeline is running (`run_memory_consolidation()`)
**When** simultaneously, `retrieve_memory_context()` attempts to read memory
**Then** the system should:
- `MemoryStorage` uses `fcntl.flock()` for file-level locking (storage.py:198)
- Retrieval acquires a shared lock (exclusive=False)
- Consolidation acquires an exclusive lock for writes
- Retrieval blocks until consolidation releases the lock for the specific file

**Expected behavior:** Correct results. Retrieval may be delayed but not corrupted.

**Current risk:** Lock granularity is per-file. Consolidation may write a new pattern file while retrieval is iterating over pattern IDs from the index. The index read happens before the lock on individual files. A pattern referenced in the index may not yet exist (or may have just been deleted during merge). This results in a None return from `_load_json()`, which the consolidation pipeline handles gracefully.

---

### CU-008: WebSocket Reconnect With Stale Token

**Given** a user's auth token has expired
**When** the WebSocket client attempts to reconnect with the expired token
**Then** the system should:
- `websocket_endpoint()` (server.py:1386) validates the token
- `auth.validate_token(ws_token)` returns None for expired tokens
- The server accepts the WebSocket, then immediately closes with code 1008 (Policy Violation)
- The client must obtain a new token before reconnecting

**Expected behavior:** Clean rejection with 1008 close code. No data leakage.

---

### CU-009: Provider Switch Mid-Build

**Given** a build is running with `--provider claude`
**When** the user modifies the LOKI_PROVIDER environment variable and signals a config reload
**Then** the system should:
- The running process has already loaded provider config
- Environment variable changes do NOT affect the running process
- The provider can only be changed by stopping and restarting the session

**Expected behavior:** Provider change requires session restart. No mid-build switching.

**Current risk:** There is no documented way to switch providers mid-build. If a user force-writes to `.loki/state/failover.json` to change the `currentProvider`, the failover code may pick it up, but this is an undocumented and untested code path.

---

### CU-010: Config Change During Active Session

**Given** a build is running
**When** the user runs `loki config set maxTier sonnet` in another terminal
**Then** the system should:
- The config command writes to `.loki/config.json`
- The running build re-reads config at certain checkpoints (e.g., each iteration)
- If the running build does NOT re-read config, the change takes effect on next session

**Expected behavior:** Config changes may not apply until the next iteration or session restart.

**Current risk:** Most config values are read once at startup and cached in shell variables (e.g., MAX_ITERATIONS, BUDGET_LIMIT). Changing them mid-session via `loki config set` has no effect on the running process. Only file-based signals (PAUSE, STOP, HUMAN_INPUT.md) are checked per-iteration.

---

## Edge Case Scenarios

### EC-001: Unicode in Project Name/Path

**Given** a project directory is at `/home/user/projects/cafe-app` (contains accented e)
**When** the user runs `loki start ./prd.md` from that directory
**Then** the system should:
- Bash handles UTF-8 paths correctly on modern systems
- Python's `Path()` and `open()` handle UTF-8 paths
- The `.loki/` directory is created inside the Unicode-named directory
- JSON serialization of paths uses UTF-8 encoding

**Expected behavior:** Full functionality. No encoding errors.

**Current risk:** The `save_state()` function (run.sh:7947) uses `printf '%s' "${PRD_PATH:-}" | sed 's/\\/\\\\/g; s/"/\\"/g'` for JSON escaping. This does not escape Unicode characters that may break JSON (e.g., null bytes). Normal Unicode characters like accented letters are valid JSON and work correctly.

---

### EC-002: Very Long PRD (100K+ Characters)

**Given** a PRD file is 100,000+ characters (approximately 150 pages)
**When** `loki start very-long-prd.md` is run
**Then** the system should:
- `detect_complexity()` reads the full file for `wc -w` and `grep -c` (run.sh:1268)
- The PRD content is injected into the prompt via `build_prompt()`
- The prompt may exceed the provider's context window

**Expected behavior:** Provider handles context overflow with truncation or error.

**Bug found (BUG-EC-002):** `build_prompt()` does not truncate the PRD content before injection. The full PRD path is referenced, and the AI provider reads the entire file. For a 100K+ character PRD with a 200K context window, the PRD alone could consume half the context, leaving insufficient room for codebase context, memory, and instructions. There is no PRD size limit or truncation logic.

---

### EC-003: Project With 1000+ Files

**Given** a large monorepo with 5000+ source files
**When** `detect_complexity()` runs
**Then** the system should:
- `find` command (run.sh:1240) counts all source files matching the pattern
- With 5000+ files, the find command may take several seconds
- The system classifies as "complex" since file_count > 50
- All 8 SDLC phases are activated

**Expected behavior:** Correct "complex" classification. Possible delay on first run.

---

### EC-004: Binary Files in Project (Images, Fonts)

**Given** a project contains .png, .woff2, and .mp4 files
**When** the AI provider attempts to read the project structure
**Then** the system should:
- `detect_complexity()` only counts source code files by extension
- Binary files are excluded from the file count
- The AI provider's file reading may attempt to read binary files
- Git diff operations may show binary file changes

**Expected behavior:** Binary files are safely ignored in complexity detection. The AI provider handles binary files according to its own capabilities.

---

### EC-005: Symlinks in Project Directory

**Given** a project has symlinks pointing to files outside the project directory
**When** `detect_complexity()` runs `find` to count files
**Then** the system should:
- `find "$target_dir" -type f` follows symlinks by default on some systems
- Symlinks pointing outside the project may inflate the file count
- Circular symlinks could cause `find` to loop indefinitely

**Expected behavior:** Symlinks should be handled safely without infinite loops.

**Suggested improvement:** Add `-not -type l` or `find -P` (do not follow symlinks) to the find command in `detect_complexity()` to avoid counting symlinked files and prevent circular reference issues.

---

### EC-006: .git Directory Handling

**Given** a project has a large `.git/` directory (multiple GB)
**When** operations scan the project directory
**Then** the system should:
- `detect_complexity()` excludes `*/.git/*` in its find command (run.sh:1245)
- Checkpoint operations use git commands, not direct .git/ access
- Export operations skip .git/ contents

**Expected behavior:** .git/ is correctly excluded from all scanning operations.

---

### EC-007: Empty Project Directory

**Given** a user runs `loki start` in a completely empty directory (no files, no .git)
**When** the system initializes
**Then** the system should:
- `detect_complexity()` returns file_count=0
- No PRD is provided, so codebase analysis mode activates
- git commands fail since there is no git repository
- `git rev-parse HEAD` returns error, caught by `2>/dev/null || echo "no-git"`
- The `.loki/` directory is created

**Expected behavior:** System starts in analysis mode. Git-dependent features degrade gracefully.

---

### EC-008: PRD With Code Blocks That Look Like Commands

**Given** a PRD contains markdown code blocks with shell commands:
```markdown
## Setup
Run: `rm -rf / --no-preserve-root`
```
**When** the AI provider interprets the PRD
**Then** the system should:
- The PRD content is passed as text to the AI provider
- The AI provider may interpret code blocks as instructions
- The `LOKI_BLOCKED_COMMANDS` env var (run.sh:44) should block dangerous commands

**Expected behavior:** Blocked commands are enforced. The AI provider does not execute dangerous commands from PRD content.

**Current risk:** The `LOKI_BLOCKED_COMMANDS` mechanism's enforcement point is unclear. It is documented as an environment variable but its actual enforcement depends on the AI provider's own safety mechanisms. Loki does not pre-scan PRD content for dangerous commands.

---

### EC-009: Session That Runs For 24+ Hours

**Given** an autonomous session is running in perpetual mode
**When** the session exceeds 24 hours of continuous operation
**Then** the system should:
- Log files accumulate in `.loki/logs/` (one per day: autonomy-YYYYMMDD.log)
- Agent log is trimmed at 1MB (run.sh:9347)
- Memory consolidation runs periodically
- Checkpoints are created every iteration (capped at 50 via retention)
- Token economics tracking accumulates

**Expected behavior:** Stable long-running operation. Log rotation prevents disk exhaustion.

**Current risk:** The agent log trimming (tail -c 500000) runs only when the file exceeds 1MB. For a 24+ hour session with verbose output, the daily log file (`autonomy-YYYYMMDD.log`) is NOT trimmed and can grow indefinitely. Only `agent.log` has size management.

---

### EC-010: 100+ Iterations Before Completion

**Given** LOKI_MAX_ITERATIONS=1000 and the build is at iteration 150
**When** the build continues running
**Then** the system should:
- Completion Council checks every `LOKI_COUNCIL_CHECK_INTERVAL` iterations (default 5)
- Stagnation detector triggers after `LOKI_COUNCIL_STAGNATION_LIMIT` iterations without git changes (default 5)
- Memory consolidation runs periodically
- Checkpoint count is capped at 50 (older ones pruned)

**Expected behavior:** System operates normally at high iteration counts.

**Current risk:** The `calculate_wait()` function (run.sh:6721) uses `2 ** exp` where exp is capped at 30 (BUG-RUN-004 fix). At iteration 100+ with many retries, the backoff works correctly. However, iteration count and retry count are independent counters. The iteration count tracks successful + failed iterations, while retry count tracks consecutive failures.

---

### EC-011: Nested PRD References

**Given** a PRD at `./prd.md` contains `See requirements in ./sub-prd.md` and `./sub-prd.md` references `./sub-sub-prd.md`
**When** the AI provider processes the PRD
**Then** the system should:
- Loki passes only the top-level PRD path to the AI provider
- The AI provider may or may not follow references to other files
- Loki does not pre-resolve or inline nested references

**Expected behavior:** The AI provider decides whether to read referenced files. Loki does not recursively resolve PRD references.

---

### EC-012: Template With Missing Required Fields

**Given** a template file is missing required sections (e.g., no "## Requirements" heading)
**When** `loki init -t broken-template` is used
**Then** the system should:
- The template content is loaded from `templates/`
- Missing fields result in empty sections in the generated PRD
- The generated PRD may be classified as "simple" due to low word/section counts

**Expected behavior:** Template generates a PRD with empty sections for missing fields. No crash.

---

### EC-013: Provider Returns Empty Response

**Given** the AI provider executes successfully (exit code 0) but returns no output
**When** the iteration completes
**Then** the system should:
- `$iter_output` is empty (0 bytes)
- `check_completion_promise()` finds no completion text -> returns 1
- `is_rate_limited()` finds no rate limit patterns -> returns false
- The iteration is counted as successful but produces no changes
- Stagnation detector may trigger if no git changes occur for consecutive iterations

**Expected behavior:** Silent iteration with no changes. Stagnation detection eventually triggers.

**Bug found (BUG-EC-013):** There is no explicit check for empty provider output. An empty response is treated as a successful iteration that did nothing. If the provider consistently returns empty responses (e.g., due to a broken prompt or API issue), the system will waste iterations until stagnation detection kicks in (default 5 consecutive iterations with no git changes). The system should detect empty provider output and treat it as an error.

---

### EC-014: Quality Gate Timeout

**Given** a quality gate (e.g., test coverage check) hangs indefinitely
**When** `enforce_test_coverage()` runs `npx vitest run` which never completes
**Then** the system should:
- The test runner process runs as a child of the main shell
- There is no explicit timeout on quality gate execution
- The entire iteration blocks until the test runner exits

**Expected behavior:** Quality gates should have a timeout (e.g., 5 minutes).

**Bug found (BUG-EC-014):** Quality gate functions like `enforce_test_coverage()` (run.sh:5516) and `run_code_review()` do not have explicit timeouts. A hung test runner or unresponsive AI reviewer will block the iteration indefinitely. The `timeout` command should wrap quality gate subprocess invocations.

---

### EC-015: Checkpoint Restore To Different Version

**Given** a checkpoint was created at version 6.70.0 of Loki
**When** the user upgrades to 6.71.1 and runs `loki checkpoint restore cp-15-1711234567`
**Then** the system should:
- `rollback_to_checkpoint()` (run.sh:6383) restores state files from the checkpoint
- The checkpoint contains `state/orchestrator.json` from v6.70.0
- The new version may expect different fields in the state files
- The git SHA from the checkpoint may reference a commit that no longer exists

**Expected behavior:** State files are restored. Missing fields use defaults. Stale git SHAs are logged as warnings.

**Current risk:** No version compatibility check exists in `rollback_to_checkpoint()`. If the state file schema changed between versions, the restored state may cause errors.

---

## Boundary Scenarios

### BD-001: Max File Size Limits

**Given** a project contains a single source file that is 50MB
**When** the AI provider attempts to read it
**Then** the system should:
- `detect_complexity()` counts it as one file regardless of size
- The AI provider's file reading depends on its own context window limits
- Git operations (diff, commit) handle large files but may be slow

**Expected behavior:** Large files are handled by the provider's own limits. Loki does not impose file size limits.

---

### BD-002: Max Project Count (Cross-Project Registry)

**Given** 1000+ projects are registered in the cross-project registry
**When** `GET /api/registry/projects` is called
**Then** the system should:
- The registry API returns all projects
- No pagination is implemented for the registry endpoint
- Large responses may cause client-side rendering issues

**Expected behavior:** All projects are returned. May be slow with many projects.

**Suggested improvement:** Add pagination support to the registry API.

---

### BD-003: Max Concurrent WebSocket Sessions

**Given** LOKI_MAX_WS_CONNECTIONS is set to 100 (default)
**When** the 101st WebSocket client attempts to connect
**Then** the system should:
- `ConnectionManager.connect()` (server.py:292) checks `len(self.active_connections) >= MAX_CONNECTIONS`
- Returns False, accepts the WebSocket, then immediately closes with code 1013
- Logs a warning about the connection limit

**Expected behavior:** Clean rejection with appropriate close code and message.

---

### BD-004: Token Budget Exactly At Limit

**Given** LOKI_BUDGET_LIMIT="10.00" and current estimated cost is $9.99
**When** the next iteration costs $0.02 (bringing total to $10.01)
**Then** the system should:
- `check_budget_limit()` (run.sh:7204) runs before each iteration
- At $9.99, the check passes (9.99 < 10.00)
- The iteration runs (costing $0.02)
- At the NEXT iteration, the check finds $10.01 >= $10.00
- The system creates `.loki/PAUSE` and `.loki/signals/BUDGET_EXCEEDED`
- The budget overshoot is $0.01 (one iteration's worth)

**Expected behavior:** Budget is enforced post-iteration, so overshoot by one iteration's cost is expected.

**Current risk:** The budget check happens BEFORE the iteration, using the accumulated cost from previous iterations. The current iteration's cost is not pre-calculated. This means the actual spend can exceed the budget by up to one iteration's cost. For expensive operations (e.g., an Opus planning phase), this overshoot could be significant ($5-25).

---

### BD-005: Iteration Count At Max

**Given** LOKI_MAX_ITERATIONS=1000 and ITERATION_COUNT is at 999
**When** the next iteration begins
**Then** the system should:
- `ITERATION_COUNT` increments to 1000 (run.sh:9284)
- `check_max_iterations()` (run.sh:7399) checks `$ITERATION_COUNT -ge $MAX_ITERATIONS`
- 1000 >= 1000 is true
- `save_state $retry "max_iterations_reached" 0` is called
- The session exits with return code 0

**Expected behavior:** Session stops cleanly at exactly MAX_ITERATIONS.

---

### BD-006: WebSocket Message Size Limit

**Given** the dashboard sends a very large state update (e.g., 10MB of task data)
**When** `manager.broadcast()` sends the message to all WebSocket clients
**Then** the system should:
- FastAPI/Starlette WebSocket has no default message size limit for sending
- The client (browser) has a default incoming message size limit (varies by browser)
- Very large messages may cause client disconnection
- The `send_json()` call may raise an exception caught by the `except Exception` block

**Expected behavior:** Large messages may cause client disconnection, handled by the broadcast cleanup logic.

---

### BD-007: API Response Payload Size

**Given** a project has 10,000+ tasks in the database
**When** `GET /api/projects/{id}/tasks` is called without pagination
**Then** the system should:
- All tasks are loaded from SQLAlchemy
- All tasks are serialized to JSON
- The response may be several MB

**Expected behavior:** Response succeeds but may be slow. No OOM expected for typical task counts.

**Suggested improvement:** Add pagination with `limit` and `offset` query parameters to task listing endpoints.

---

### BD-008: Template Name Length Limit

**Given** a user creates a template with a 500-character name
**When** `loki init -t <very-long-name>` is used
**Then** the system should:
- The template name is used as a filename in `templates/`
- Most filesystems limit filenames to 255 bytes
- A 500-character name would fail at file creation

**Expected behavior:** Error message about invalid template name.

**Current risk:** No template name length validation exists. The filesystem error propagates as an unhandled exception.

---

### BD-009: Log File Rotation At Boundary

**Given** an autonomous session runs across midnight (UTC)
**When** the log filename changes from `autonomy-20260324.log` to `autonomy-20260325.log`
**Then** the system should:
- `log_file=".loki/logs/autonomy-$(date +%Y%m%d).log"` is evaluated each iteration
- The new iteration writes to the new day's log file
- The old log file remains intact
- No data is lost at the boundary

**Expected behavior:** Smooth log rotation at midnight. Both files are preserved.

---

### BD-010: Memory Episode Count At Consolidation Threshold

**Given** 1000 episodes have accumulated (the `limit=1000` in consolidation.py:145)
**When** `consolidate(since_hours=24)` runs
**Then** the system should:
- Load up to 1000 episode IDs
- Load each episode from disk (1000 file reads)
- Cluster episodes by task type or embedding similarity
- Create patterns from clusters

**Expected behavior:** Consolidation completes successfully but may take several minutes.

**Current risk:** Loading 1000 episodes requires 1000 file reads with per-file locking. This could take 10+ seconds on spinning disks or network filesystems. The consolidation runs synchronously in the shell pipeline, blocking the next iteration until complete. For very active projects that generate many episodes, the 1000 limit prevents unbounded memory usage but the consolidation time could delay the next iteration.

---

## Appendix: Bug Summary

| Bug ID | Severity | Location | Description |
|--------|----------|----------|-------------|
| BUG-EP-004 | Medium | run.sh:6864 | `check_provider_health()` validates key exists, not that it works |
| BUG-EP-008 | Low | run.sh:7956 | CLI `load_state()` does not attempt checkpoint-based recovery on corruption |
| BUG-EP-012 | Medium | storage.py:170 | Corrupted index.json is not auto-recreated; silently breaks all memory |
| BUG-EP-015 | Low | run.sh:7939 | Orphaned `.tmp.*` files accumulate on kill -9; no startup cleanup |
| BUG-CU-002 | Medium | run.sh (dashboard) | No automatic port increment when default dashboard port is in use |
| BUG-CU-005 | Low | loki:5034 | Export reads multiple state files without cross-file consistency |
| BUG-EC-002 | Medium | run.sh (build_prompt) | No PRD size limit or truncation before context injection |
| BUG-EC-013 | Medium | run.sh (iteration) | Empty provider output treated as success; wastes iterations |
| BUG-EC-014 | High | run.sh:5516 | Quality gate subprocesses have no timeout; can hang indefinitely |
