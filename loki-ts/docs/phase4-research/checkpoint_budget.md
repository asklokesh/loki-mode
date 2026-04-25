# Checkpoint & Budget System Specification

**Source Repository**: `/Users/lokesh/git/loki-mode`
**Baseline**: bash autonomy/run.sh (create_checkpoint line 6899, check_budget_limit line 7853)
**Target**: TypeScript migration for checkpoint.ts + budget.ts byte-identical state files
**Document Date**: 2026-04-25

---

## 1. Checkpoint File Format on Disk

### Directory Structure

Checkpoints live in `.loki/state/checkpoints/` (autonomy/run.sh:6904, line 6925).

```
.loki/state/checkpoints/
  index.jsonl                    # Append-only index of all checkpoints
  cp-{iteration}-{epoch}/        # Checkpoint directory per snapshot
    metadata.json                # Checkpoint metadata
    state/
      orchestrator.json          # Core orchestration state
    queue/
      pending.json               # Task queue entries pending
      completed.json             # Completed task entries
      in-progress.json           # In-progress task entries
      current-task.json          # Current task descriptor
```

### metadata.json Schema

Created at autonomy/run.sh:6961-6962 (Python json.dump).

```json
{
  "id": "cp-{iteration}-{epoch}",
  "timestamp": "2026-03-07T14:59:21Z",
  "iteration": 1,
  "task_id": "iteration-1",
  "task_description": "iteration-1 complete",
  "git_sha": "7dc2470498baea636556c39f0a764493b97147fe",
  "git_branch": "main",
  "provider": "claude",
  "phase": "BOOTSTRAP"
}
```

Field types and constraints:
- `id` (string): checkpoint identifier, format `cp-{iteration}-{epoch}` where epoch is seconds since Unix epoch
- `timestamp` (ISO 8601 string): UTC creation time at millisecond precision (format: `%Y-%m-%dT%H:%M:%SZ`)
- `iteration` (integer): current iteration count (ITERATION_COUNT env var)
- `task_id` (string): task identifier for audit trail, max 200 chars
- `task_description` (string): human-readable description, truncated to 200 chars (autonomy/run.sh:6945)
- `git_sha` (string): git HEAD commit hash (git rev-parse HEAD) or "no-git" if not in git repo
- `git_branch` (string): current git branch name (git branch --show-current) or "unknown"
- `provider` (string): AI provider name (PROVIDER_NAME env var), defaults to "claude"
- `phase` (string): current orchestrator phase (read from .loki/state/orchestrator.json currentPhase field)

### index.jsonl Schema

Append-only line-delimited JSON file (autonomy/run.sh:6943, 6963-6967).

Each line is a JSON object:
```json
{
  "id": "cp-1-1772895561",
  "ts": "2026-03-07T14:59:21Z",
  "iter": 1,
  "task": "iteration-1 complete",
  "sha": "7dc2470498baea636556c39f0a764493b97147fe"
}
```

- `id`: checkpoint identifier (same as directory name)
- `ts`: timestamp from metadata
- `iter`: iteration number
- `task`: truncated task description (<=60 chars for display)
- `sha`: full git SHA (for traceability)

Index is rebuilt atomically on retention (autonomy/run.sh:6984-6993): writes to `.tmp.$$` file then moves atomically with `mv -f`.

### Copied State Files

The following .loki state files are copied into the checkpoint directory (autonomy/run.sh:6931):
- `.loki/state/orchestrator.json` → `cp_dir/state/orchestrator.json`
- `.loki/autonomy-state.json` → `cp_dir/autonomy-state.json`
- `.loki/queue/pending.json` → `cp_dir/queue/pending.json`
- `.loki/queue/completed.json` → `cp_dir/queue/completed.json`
- `.loki/queue/in-progress.json` → `cp_dir/queue/in-progress.json`
- `.loki/queue/current-task.json` → `cp_dir/queue/current-task.json`

These are shallow copies (not symlinks). Directory structure is created with `mkdir -p` before copying (autonomy/run.sh:6933-6935).

---

## 2. Naming Convention for Checkpoint IDs

Format: `cp-{iteration}-{epoch}` (autonomy/run.sh:6924)

Example: `cp-1-1772895561`, `cp-5-1772896576`

Parsing logic:
- Prefix: `cp-` (constant)
- Field 1: iteration number (ITERATION_COUNT at checkpoint creation time)
- Field 2: Unix epoch timestamp in seconds (date +%s)

Sorting: The epoch suffix (field 3 after splitting by `-`) provides chronological ordering. Checkpoints are sorted by this field with `sort -t'-' -k3 -n` (autonomy/run.sh:6978).

Validation for restore: checkpoint IDs must match regex `^[a-zA-Z0-9_-]+$` to prevent path traversal (autonomy/run.sh:7006).

---

## 3. Atomic-Write Semantics

### Checkpoint Creation

No explicit locking mechanism. Atomicity is achieved via:
1. Create temporary directories with `mkdir -p` (autonomy/run.sh:6927)
2. Copy files with `cp` (autonomy/run.sh:6935)
3. Write metadata.json directly (autonomy/run.sh:6961, Python json.dump to opened file handle)
4. Append to index.jsonl (autonomy/run.sh:6963, Python `f.write(...) + "\n"`)

Each checkpoint directory is self-contained. If the Python write of metadata.json fails, the checkpoint directory is left in an incomplete state but does not corrupt the index (index entry is only appended after metadata succeeds).

### Index Rebuild (Retention)

On retention, the index is rebuilt atomically (autonomy/run.sh:6984-6993):
1. Write new index to temporary file: `.loki/state/checkpoints/index.jsonl.tmp.$PID`
2. Iterate through remaining checkpoint metadata.json files (sorted by epoch)
3. Python json.load and echo to temp file
4. Atomically move temp file over original with `mv -f` (autonomy/run.sh:6993)

If the rebuild fails partway, the move operation is not reached, leaving the original index intact. The temporary file cleanup uses `mv -f`, which is atomic on POSIX filesystems.

### Retention Policy

Maximum 50 checkpoints per session (autonomy/run.sh:6974). When count exceeds 50, oldest checkpoints are deleted:
1. Find all `cp-*` directories in checkpoint_dir (maxdepth 1)
2. Sort by basename, extracting epoch (field 3 after split by `-`)
3. Delete oldest N to reduce count to 50
4. Rebuild index atomically

No explicit locking between the deletion and rebuild, relying on single-threaded bash execution (autonomy/run.sh line 6970-6994).

---

## 4. When Checkpoints Are Created

### Create Conditions

Checkpoints only create if there are uncommitted changes (autonomy/run.sh:6910-6913):
```bash
if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
    log_info "No uncommitted changes to checkpoint"
    return 0
fi
```

If no changes, function returns early without creating a checkpoint.

### Creation Triggers

Called from three locations in run_autonomous() (autonomy/run.sh:10846, 11054, 11930):

1. **Iteration Success** (autonomy/run.sh:10846):
   ```bash
   create_checkpoint "iteration-${ITERATION_COUNT} complete" "iteration-${ITERATION_COUNT}"
   ```
   Fired after iteration exits with code 0 and quality gates pass.

2. **Iteration Failure** (autonomy/run.sh:11054):
   ```bash
   create_checkpoint "iteration-${ITERATION_COUNT} failed (exit=$exit_code)" \
                      "iteration-${ITERATION_COUNT}-fail"
   ```
   Fired when iteration exits with non-zero code (after retry exhaustion).

3. **Session End** (autonomy/run.sh:11930):
   ```bash
   create_checkpoint "session end (iterations=$ITERATION_COUNT)" "session-end"
   ```
   Fired before stop_loki_session() completes (end of run_autonomous).

4. **Pre-Rollback** (autonomy/run.sh:7025):
   ```bash
   create_checkpoint "pre-rollback snapshot" "rollback"
   ```
   Fired when rollback_to_checkpoint() is invoked, before restoring old state.

Checkpoints are NOT created on phase transitions, only on iteration completion or session end. No checkpoint is created during iteration execution itself.

---

## 5. Restore Path (Read Semantics)

### Restore Function

`rollback_to_checkpoint(checkpoint_id)` (autonomy/run.sh:6999-7052)

Arguments: checkpoint_id (string, validated against `^[a-zA-Z0-9_-]+$`)

Logic:
1. Construct path: `.loki/state/checkpoints/${checkpoint_id}`
2. Validate directory exists, else return error
3. Read metadata from `${cp_dir}/metadata.json` (autonomy/run.sh:7020, Python json.load)
4. Extract git_sha field for audit logging
5. Create pre-rollback snapshot (autonomy/run.sh:7025)
6. Restore state files from checkpoint (autonomy/run.sh:7028-7034):
   - `${cp_dir}/state/orchestrator.json` → `.loki/state/orchestrator.json`
   - `${cp_dir}/queue/pending.json` → `.loki/queue/pending.json`
   - `${cp_dir}/queue/completed.json` → `.loki/queue/completed.json`
   - `${cp_dir}/queue/in-progress.json` → `.loki/queue/in-progress.json`
   - `${cp_dir}/queue/current-task.json` → `.loki/queue/current-task.json`
7. Log rollback event

### MCP Tool Interface

`loki_checkpoint_restore(checkpoint_id)` (mcp/server.py:1329-1376)

List checkpoints when `checkpoint_id` is empty:
- Scans `.loki/state/checkpoints/` for `.json` files (mcp/server.py:1346-1352)
- Returns array of checkpoint objects with injected `id` field

Restore specific checkpoint:
- Loads target checkpoint JSON from filesystem
- Strips `id` field (injected at list time)
- Writes remaining fields to `.loki/state/orchestrator.json` (mcp/server.py:1363-1367)

Note: MCP implementation scans for `.json` files directly, not directories. This may diverge from bash format (which uses directories with metadata.json inside). Phase 4 TS implementation must reconcile.

### Restore Semantics

Restore does NOT:
- Revert git history
- Delete uncommitted changes
- Restore .loki/metrics/ or .loki/context/

Restore DOES:
- Overwrite .loki/state/orchestrator.json
- Overwrite .loki/queue/* files
- Create audit checkpoint before the restore

Callers must manually handle git state (e.g., git reset --hard if needed).

---

## 6. Budget Schema (.loki/metrics/budget.json)

### Creation

Written at session init (autonomy/run.sh:3105-3111) and on each budget check (autonomy/run.sh:7913-7921, 7931-7938).

### Schema (Not Exceeded)

```json
{
  "limit": 10,
  "budget_limit": 10,
  "budget_used": 0.4,
  "exceeded": false
}
```

Fields:
- `limit` (number): USD budget limit from BUDGET_LIMIT env var
- `budget_limit` (number): alias for `limit` (for compatibility)
- `budget_used` (number): calculated cost in USD
- `exceeded` (boolean): false if within budget
- `created_at` (ISO 8601 string, optional): initial write only (autonomy/run.sh:3110)

### Schema (Exceeded)

```json
{
  "limit": 10,
  "budget_limit": 10,
  "budget_used": 15.5,
  "exceeded": true,
  "exceeded_at": "2026-03-07T15:02:30Z"
}
```

When exceeded:
- `exceeded` (boolean): true
- `exceeded_at` (ISO 8601 string): timestamp when limit was first detected

### Cost Calculation

Cost is computed from per-iteration efficiency files in `.loki/metrics/efficiency/` (autonomy/run.sh:7866-7892).

Pricing per-provider (hard-coded, autonomy/run.sh:7870-7876):
- opus: input $5.00/1M, output $25.00/1M
- sonnet: input $3.00/1M, output $15.00/1M
- haiku: input $1.00/1M, output $5.00/1M
- gpt-5.3-codex: input $1.50/1M, output $12.00/1M
- gemini-3-pro: input $1.25/1M, output $10.00/1M
- gemini-3-flash: input $0.10/1M, output $0.40/1M

For each iteration JSON in efficiency/iteration-*.json:
- If `cost_usd` field exists, use it directly
- Else: calculate `(input_tokens / 1_000_000) * input_price + (output_tokens / 1_000_000) * output_price`
- Sum all iterations
- Round to 4 decimal places (autonomy/run.sh:7891: `round(total, 4)`)

### Budget Comparison

Check triggers when `current_cost >= BUDGET_LIMIT` (autonomy/run.sh:7902):
```bash
exceeded=$(python3 -c "
import sys
try:
    cost = float(sys.argv[1])
    limit = float(sys.argv[2])
    print(1 if cost >= limit else 0)
except (ValueError, IndexError):
    print(0)
" "$current_cost" "$BUDGET_LIMIT" 2>/dev/null || echo "0")
```

Greater-than-or-equal comparison (not strictly greater).

### Writers

Two writers:
1. Session init (autonomy/run.sh:3105): creates with budget_used=0, created_at timestamp
2. Budget check loop (autonomy/run.sh:7913 or 7931): updates with current cost, exceeded flag

Both use heredoc write with `cat >` (not append). Format hardcoded with no JSON encoder in shell, so floating-point precision depends on bash float handling.

---

## 7. Rate Limit Detection (is_rate_limited)

### Detection Logic

Function: `is_rate_limited(log_file)` (autonomy/run.sh:7668-7688)

Scans log file for patterns (case-insensitive grep):
```bash
grep -qiE '(429|rate.?limit|too many requests|quota exceeded|request limit|retry.?after)'
```

Also checks for Claude-specific format:
```bash
grep -qE 'resets [0-9]+[ap]m'
```

Returns 0 (true) if any pattern found, 1 (false) otherwise.

### Wait Time Calculation

Function: `detect_rate_limit(log_file)` (autonomy/run.sh:7775-7812)

Hierarchy of wait time detection:

1. **Provider-specific reset time** (autonomy/run.sh:7790-7798):
   - Claude: `parse_claude_reset_time()` extracts "resets Xam/pm" format
   - Others: no known format, skip to next

2. **Retry-After header** (autonomy/run.sh:7801-7803):
   - `parse_retry_after()` extracts numeric seconds from "Retry-After: N" header
   - Returns 0 if not found

3. **Calculated backoff** (autonomy/run.sh:7805-7808):
   - `calculate_rate_limit_backoff()` uses PROVIDER_RATE_LIMIT_RPM
   - Default RPM: 50 (autonomy/run.sh:7756)
   - Wait formula: `(120 * 60) / rpm`, clamped to 60-300 seconds (autonomy/run.sh:7762-7768)

If is_rate_limited returns false, detect_rate_limit returns 0 immediately (autonomy/run.sh:7781-7783).

---

## 8. Circuit-Breaker Behavior

### Budget Exceeded Response

When check_budget_limit() detects exceeded (autonomy/run.sh:7907-7926):

1. **Write PAUSE signal** (autonomy/run.sh:7909):
   ```bash
   touch ".loki/PAUSE"
   ```

2. **Write BUDGET_EXCEEDED signal** (autonomy/run.sh:7910-7911):
   ```bash
   mkdir -p ".loki/signals"
   echo "{\"type\":\"BUDGET_EXCEEDED\",...}" > ".loki/signals/BUDGET_EXCEEDED"
   ```
   
   Signal format:
   ```json
   {
     "type": "BUDGET_EXCEEDED",
     "limit": 10,
     "current": 15.5,
     "timestamp": "2026-03-07T15:02:30Z"
   }
   ```

3. **Update budget.json** (autonomy/run.sh:7913-7921)
4. **Emit event** (autonomy/run.sh:7922-7925):
   ```bash
   emit_event_json "budget_exceeded" \
       "limit=${BUDGET_LIMIT}" \
       "current=${current_cost}" \
       "iteration=$ITERATION_COUNT"
   ```

5. **Return 0** (true, budget exceeded)

### Check Loop Integration

check_budget_limit() is called before each iteration (autonomy/run.sh:10323):

```bash
if check_budget_limit; then
    log_warn "Session paused due to budget limit. Remove .loki/PAUSE to resume."
    save_state $retry "budget_exceeded" 0
    continue  # Will hit PAUSE check on next iteration
fi
```

Returns 0 if exceeded (stop loop), 1 if within budget (continue).

### Human Intervention

PAUSE file is checked at iteration start (autonomy/run.sh:11127-11162):

If PAUSE exists:
1. Check for budget-exceeded condition in perpetual mode
2. Call handle_pause() to wait for human input
3. Clear PAUSE and PAUSED.md files
4. Resume or stop based on user response

Budget pause is special-cased (autonomy/run.sh:11131-11143): not auto-cleared in perpetual mode, requires explicit removal of .loki/signals/BUDGET_EXCEEDED and .loki/PAUSE.

---

## 9. Thresholds and Configuration

### Budget Limit

Source: `BUDGET_LIMIT` environment variable (autonomy/run.sh:7854)

- No default value; if unset, budget check is skipped (returns 1, no limit)
- Must be numeric, validated with Python (autonomy/run.sh:7857)
- Validation regex in init (autonomy/run.sh:3101): `^[0-9]+(\.[0-9]+)?$`

### Rate Limit RPM

Source: `PROVIDER_RATE_LIMIT_RPM` environment variable (autonomy/run.sh:7756)

- Default: 50 RPM (requests per minute)
- Used only for calculated backoff when no provider-specific reset is found
- Not configurable via .loki/ files, only env var

### Notification Trigger Thresholds

From STATE-MACHINES.md section 11.2 (autonomy/run.sh notification-checker.py, not in main run.sh):

- `budget-80pct`: fires when budget.used / budget.limit >= 0.8
- `context-90pct`: fires when context_window_pct >= 0.9

Stored in `.loki/notifications/triggers.json` and `.loki/notifications/active.json`.

---

## 10. Cross-References with Architecture Docs

### STATE-MACHINES.md Section 13: Checkpoint System

Reference: `/Users/lokesh/git/loki-mode/docs/architecture/STATE-MACHINES.md:1650-1685`

Diagram shows:
- Checkpoint creation fires after task completion
- Snapshots .loki/state.json, .loki/queue/, .loki/council/, .loki/context/
- Stores to .loki/checkpoints/checkpoint-TAG/
- Includes metadata (timestamp, iteration, description, git_ref)

**Note**: STATE-MACHINES.md diagram is outdated. It shows `.loki/state.json` copied, but actual code copies `.loki/state/orchestrator.json` + autonomy-state.json (autonomy/run.sh:6931). No council/ or context/ copies in current implementation.

### STATE-MACHINES.md Section 11: Autonomy Utilities

References: `/Users/lokesh/git/loki-mode/docs/architecture/STATE-MACHINES.md:1445-1590`

#### 11.1 Context Window Tracking
- Tracks token usage per iteration in `.loki/context/tracking.json`
- Calculates cost using provider-specific pricing
- Evaluates context_window_pct for notifications

#### 11.2 Notification Triggers
- 6 trigger types including `budget-80pct` and `context-90pct`
- Stored in `.loki/notifications/triggers.json`
- Fired when conditions met, with dedup prevention

#### 11.3 Budget Limit
- check_budget_limit() reads from env LOKI_BUDGET_LIMIT or dashboard-state.json
- Returns 1 if exceeded, 0 if within budget
- Creates PAUSE file on exceed

**Note**: STATE-MACHINES.md line 1567 references wrong function line (7418 vs actual 7853).

---

## 11. Known Issues & Future Considerations

### BUG-ST-009 (autonomy/run.sh:6930)
autonomy-state.json is flagged as needing inclusion in checkpoint backup. Current code does copy it (autonomy/run.sh:6931), so bug may be outdated.

### BUG-ST-012 (autonomy/run.sh:6976)
Sort by basename epoch suffix to avoid issues with full path dashes. Code correctly splits by `-` and sorts field 3 with `-n` (numeric).

### MCP vs Bash Divergence
MCP server (mcp/server.py:1346) scans for `.json` files in checkpoints directory, but bash creates subdirectories `cp-*/metadata.json`. MCP implementation may not match bash output format. Reconciliation needed for TS migration.

### No Explicit Locking
Checkpoint creation and budget checks use no file locks or mutexes. In single-threaded execution (bash), this is safe. In Bun/TS, ensure no concurrent access to .loki/metrics/budget.json or .loki/state/checkpoints/.

### No Budget Persistence Across Sessions
budget.json is overwritten on each check, not appended. Historical cost tracking must reconstruct from efficiency/ files.

---

## 12. TypeScript Migration Targets

For byte-identical state files in checkpoint.ts + budget.ts:

### Checkpoint Format
- Directory structure: `cp-{iteration}-{epoch}/` with metadata.json + copied state files
- metadata.json: JSON object with 9 fields (id, timestamp, iteration, task_id, task_description, git_sha, git_branch, provider, phase)
- index.jsonl: append-only line-delimited JSON, 5-field summary per line
- Retention: max 50 checkpoints, prune oldest by epoch when exceeded
- Atomic index rebuild: write to `.tmp.$$`, move atomically

### Budget Format
- File: `.loki/metrics/budget.json`
- Schema: 4-5 fields (limit, budget_limit, budget_used, exceeded, [exceeded_at])
- Cost calculation: sum of efficiency/*.json files, with hard-coded pricing tiers
- Comparison: >= operator for exceeded check
- Writers: session init + budget check loop (not append, overwrite)

### Rate Limit Format
- No persistent state file (runs log-based detection)
- Patterns: grep-based on provider error logs
- Wait time: provider-specific > Retry-After > calculated backoff
- No circuit-breaker file, only dynamically calculated

---

## Source Code References

All file:line citations in this document refer to `/Users/lokesh/git/loki-mode/autonomy/run.sh` unless otherwise noted:

- create_checkpoint: line 6899-6997
- rollback_to_checkpoint: line 6999-7052
- list_checkpoints: line 7053-7076
- is_rate_limited: line 7668-7688
- detect_rate_limit: line 7775-7812
- check_budget_limit: line 7853-7942
- Session init budget write: line 3105-3111
- Per-iteration efficiency write: line 3921-3936
- Budget check in main loop: line 10323-10326
- Checkpoint creation (success): line 10846
- Checkpoint creation (failure): line 11054
- Checkpoint creation (session end): line 11930

MCP references:
- loki_checkpoint_restore: mcp/server.py:1329-1376

Architecture references:
- STATE-MACHINES.md section 11: line 1445-1590
- STATE-MACHINES.md section 13: line 1650-1685

