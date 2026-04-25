# Phase 4 Research: Dashboard Schema Contract

## Executive Summary

The Loki Mode dashboard (`dashboard/server.py` and supporting modules) reads `.loki/` files across 15+ distinct paths with strict schema dependencies. This document catalogues every file the dashboard reads, its expected schema fields, and data types. Any field removal, reordering, or type change in Phase 4's TypeScript port will break the dashboard.

**Critical Constraint:** The dashboard's TS port must maintain byte-for-byte JSON schema compatibility with the current Python writer or dashboards will fail to display status, tasks, memory summaries, and session state.

---

## File Catalog: Paths, Readers, Schemas

| File Path | Reader (file:line) | Fields Expected | Types | Risk Level |
|-----------|-------------------|-----------------|-------|-----------|
| `.loki/dashboard-state.json` | server.py:764, server.py:361 | `phase`, `iteration`, `complexity`, `mode`, `provider`, `version`, `agents`, `tasks` | str, int, str, str, str, str, list[dict], dict | CRITICAL |
| `.loki/dashboard-state.json` → `agents[]` | server.py:790-802 | `pid` (per agent) | int\|null | CRITICAL |
| `.loki/dashboard-state.json` → `tasks` | server.py:804-808 | `pending` (list), `inProgress` (list) | list[dict], list[dict] | CRITICAL |
| `.loki/dashboard-state.json` → `tasks.inProgress[0]` | server.py:808 | `payload.action` | str | CRITICAL |
| `.loki/loki.pid` | server.py:565, 765, 817 | (file content: integer PID as text) | int | CRITICAL |
| `.loki/session.json` | server.py:410, 450, 578, 826-864 | `status`, `updatedAt`, `startedAt`, `provider` | str, str, str, str | HIGH |
| `.loki/state/orchestrator.json` | server.py:487-495, 870-883 | `currentPhase`, `iteration`, `complexity`, `metrics` | str, int, str, dict | CRITICAL |
| `.loki/state/orchestrator.json` → `metrics` | server.py:877-880 | `tasksCompleted`, `tasksFailed` | int, int | MEDIUM |
| `.loki/state/provider` | server.py:943-948 | (file content: provider name as text) | str | MEDIUM |
| `.loki/queue/pending.json` | server.py:500-508, 887-895 | `tasks` (if dict) OR root is list | list\|dict | HIGH |
| `.loki/queue/in-progress.json` | server.py:510-524, 898-912 | `tasks` (if dict) OR root is list; first item has `title`, `payload.action`, `id` | list\|dict | HIGH |
| `.loki/queue/current-task.json` | server.py:527-538, 915-926 | `title`, `payload.action`, `id` | str, str, str | MEDIUM |
| `.loki/PAUSE` | server.py:766, 935 | (file existence marker; no content schema) | boolean (presence) | LOW |
| `.loki/STOP` | server.py:3208 | (file existence marker) | boolean (presence) | LOW |
| `.loki/sessions/<id>/loki.pid` | server.py:972-990 | (file content: integer PID) | int | MEDIUM |
| `.loki/logs/run-<id>.log` | server.py:980, 1002 | (text file for logging; read if exists) | str | LOW |
| `.loki/memory/token_economics.json` | server.py:2268, 2326 | `discoveryTokens`, `readTokens`, `savingsPercent` | int, int, float | MEDIUM |
| `.loki/memory/episodic/*.json` | server.py:2360-2370, 2389-2403 | `timestamp`, `id` | str, str | MEDIUM |
| `.loki/memory/semantic/patterns.json` | server.py:2307-2313 | (list) OR `patterns` key | list\|dict | MEDIUM |
| `.loki/memory/semantic/anti-patterns.json` | server.py:2315-2319 | (list) OR `patterns` key | list\|dict | MEDIUM |
| `.loki/memory/skills/*.json` | server.py:2322-2324 | (any JSON in directory) | dict | LOW |
| `.loki/memory/index.json` | server.py:2522-2525 | (parsed as JSON, no specific field access) | dict | MEDIUM |
| `.loki/memory/timeline.json` | server.py:2534-2537 | (parsed as JSON, no specific field access) | dict | MEDIUM |
| `.loki/learning/signals/*.json` | server.py:2656-2677 | `timestamp`, `type` (if filtering) | str, str | LOW |
| `.loki/metrics/aggregation.json` | server.py:2730-2733, 2802-2805 | (parsed as JSON, content-dependent) | dict | LOW |
| `.loki/events.jsonl` | server.py:2887-2909, 3046-3073 | (JSONL: each line is parsed independently) | dict (per line) | MEDIUM |
| `.loki/pricing.json` | server.py:3289, 3512 | (parsed as JSON) | dict | MEDIUM |
| `.loki/state/provider` | server.py:3525-3528 | (text file content) | str | MEDIUM |
| `.loki/context/tracking.json` | server.py:3373, 3666 | (parsed as JSON) | dict | LOW |
| `.loki/metrics/budget.json` | server.py:3325, 3431 | (parsed as JSON) | dict | LOW |
| `.loki/metrics/efficiency/*.json` | server.py:3324-3340 | (parsed as JSON) | dict | MEDIUM |
| `.loki/signals/*.json` | server.py:3432, 3650 | (parsed as JSON) | dict | LOW |
| `.loki/notifications/active.json` | server.py:3705-3714, 3783-3789 | (parsed as JSON) | dict | LOW |
| `.loki/notifications/triggers.json` | server.py:3739-3745 | (parsed as JSON) | dict | LOW |
| `.loki/council/state.json` | server.py:3558-3561, 3570-3574 | (parsed as JSON) | dict | LOW |
| `.loki/council/votes/*` | server.py:3580 | (parsed as JSON per file) | dict | LOW |
| `.loki/council/convergence.log` | server.py:3619-3622 | (text file, split by lines) | str | LOW |
| `.loki/council/report.md` | server.py:3641-3643 | (text file, read as-is) | str | LOW |
| `.loki/state/checkpoints/index.jsonl` | server.py:3849-3877 | (JSONL: each line has `id`, `metadata_file` reference) | dict | MEDIUM |
| `.loki/state/checkpoints/<id>/metadata.json` | server.py:3877, 3908-3914 | (parsed as JSON) | dict | LOW |
| `.loki/state/agents.json` | server.py:4011-4015, 4078-4083, 4524 | (parsed as JSON, typically dict or list) | dict\|list | MEDIUM |
| `VERSION` (outside `.loki/`) | server.py:750-751, 476-479 | (text file: version string) | str | LOW |

---

## Highest-Risk Fields (CRITICAL Priority)

These fields are read **directly from root keys** with no fallback and used in every status request:

### 1. `.loki/dashboard-state.json` - Root Level
- `phase` (string): Current execution phase
- `iteration` (integer): Iteration counter
- `complexity` (string): Complexity level ("standard", etc.)
- `mode` (string): Execution mode ("autonomous", etc.)
- `provider` (string): AI provider name
- `version` (string): Version identifier
- `agents` (list): Array of agent objects with `pid` field
- `tasks` (dict): Object with `pending` and `inProgress` keys

**Why Critical:** Status endpoint (line 737) reads these **every request**. Removing or mistyping any key will return `null` or default values, breaking the dashboard UI.

### 2. `.loki/dashboard-state.json` → `tasks.inProgress[0].payload.action`
- Used at server.py:435, 808, 920
- Displayed as "current_task" in StatusResponse
- **Type Chain:** `tasks` → dict → `inProgress` → list → [0] → dict → `payload` → dict → `action` → string

**Risk:** If any intermediate key is missing or renamed, the current task display breaks.

### 3. `.loki/state/orchestrator.json` - For Skill Sessions
- `currentPhase` (string): Phase name (fallback when dashboard-state.json absent)
- `iteration` (integer): Iteration counter
- `complexity` (string): Complexity level
- `metrics.tasksCompleted` (integer): Task completion count
- `metrics.tasksFailed` (integer): Task failure count

**Why Critical:** Lines 870-883 read this when no dashboard-state.json exists (skill-invoked sessions). Any missing key silently falls back to previous value, risking stale display.

### 4. `.loki/loki.pid` and `.loki/sessions/<id>/loki.pid`
- **Format:** Single integer on one line (e.g., "12345")
- Used to validate process is alive via `os.kill(pid, 0)` (line 569, 977)
- **Type Strictness:** Must parse as integer or socket connection check fails silently

---

## Schema Violations That Will Break Dashboard

1. **Field Reordering:** JSON field order is irrelevant for parsing but matters for stability. Python's `dict.get()` is order-agnostic; TS port must also be.

2. **Field Removal without Default:**
   - Remove `phase` from dashboard-state.json → UI shows empty phase
   - Remove `agents` array → running_agents count becomes 0
   - Remove `tasks.pending` → pending_tasks becomes 0

3. **Type Mismatches:**
   - `agents` must be list, not dict (line 381: `isinstance(agents_list, list)`)
   - `iteration` must be int, not string (line 429: arithmetic operations assume int)
   - `pid` must parse as int (line 569: `int(pid_str)`)

4. **Nested Structure Changes:**
   - Change `tasks.inProgress` to `tasks.in_progress` (line 806: exact key match)
   - Change `payload.action` to `action` (line 808: nested access via `.get("payload", {}).get("action", "")`)
   - Remove `metrics` dict from orchestrator.json (line 877: defensive check but breaks if dict structure changes)

5. **File Format Changes:**
   - `.loki/events.jsonl` must remain JSONL (one JSON object per line), not a single JSON array (line 2909: `json.loads(raw_line)`)
   - `.loki/state/checkpoints/index.jsonl` must be JSONL, each with `id` field (line 3855-3858)

---

## Writers vs. Readers

### Files Read by Dashboard (These Must Be Preserved)
1. `dashboard-state.json` - **Written by:** run.sh / autonomy layer (every 2 seconds)
2. `session.json` - **Written by:** Skill agents (on session start/update)
3. `orchestrator.json` - **Written by:** Orchestrator (phase transitions)
4. `queue/pending.json`, `queue/in-progress.json` - **Written by:** Queue manager
5. `loki.pid`, `sessions/<id>/loki.pid` - **Written by:** Session startup
6. Memory files (`episodic/*.json`, `patterns.json`, etc.) - **Written by:** Memory subsystem
7. `state/provider` - **Written by:** Configuration / session init
8. Event files (`events.jsonl`) - **Written by:** Event logging system

### Files NOT Found in run.sh (Flag as Potential Risk)
- `.loki/council/` files - **Unknown writer**. If not written by autonomy layer, may be orphaned.
- `.loki/notifications/` files - **Unknown writer**. May be legacy or from MCP.
- `.loki/learning/signals/` - **Unclear ownership**. Likely from memory or signals module.
- `.loki/metrics/efficiency/` - **Unclear ownership**. May be aggregated by separate process.

**Recommendation:** Search `grep -r "council\|notifications\|signals\|efficiency" /Users/lokesh/git/loki-mode --include="*.py" --include="*.ts"` to confirm writers before porting.

---

## Activity Logger Contract

**File:** `dashboard/activity.logger.py`
- **Reads:** `~/.loki/activity.jsonl` (if exists)
- **Schema per Entry:**
  ```json
  {
    "timestamp": "ISO-8601",
    "entity_type": "task|agent|phase|checkpoint",
    "entity_id": "string",
    "action": "created|status_changed|completed|failed|blocked",
    "old_value": "string|null",
    "new_value": "string|null",
    "session_id": "string|null"
  }
  ```
- **Type Constraint:** `entity_type` and `action` are validated against hardcoded sets (line 23-24)
- **Risk:** If any line contains invalid `entity_type` or `action`, logger warns but continues; dashboard may ignore malformed entries

---

## Known Edge Cases & Defensive Code

### 1. Queue File Flexibility (Lines 504, 514, 891, 902)
Dashboard handles both formats:
```python
# Format 1: {"tasks": [...]}
_pt = _pd.get("tasks", _pd) if isinstance(_pd, dict) else _pd
# Format 2: [...]  (direct list)
if isinstance(_pt, list): ...
```
**Implication:** Queue files can be dict-wrapped or direct array. TS port must match this flexibility.

### 2. Task Payload Fallback Chain (Line 1369)
```python
"title": task.get("title", payload.get("action", task.get("type", "Task")))
```
Tries `title` → `payload.action` → `type` → "Task" as final default.
**Implication:** At least one of these keys must exist or fallback is "Task".

### 3. Agent PID Validation (Line 793-802)
```python
if agent_pid:
    os.kill(int(agent_pid), 0)
    running_agents += 1
else:
    running_agents += 1  # Legacy: no PID field, assume running
```
**Implication:** `agent.pid` can be null/missing; dashboard counts such agents as "running" (backward compatibility).

### 4. Skill Session Freshness Check (Lines 452-471)
Dashboard ignores session.json if older than 5 minutes (to avoid displaying stale skill-agent state).
**Implication:** `updatedAt` or `startedAt` timestamp must be kept current or session appears "stopped".

---

## TS Port Preservation Checklist

- [ ] **dashboard-state.json:** Preserve all 8 root keys (`phase`, `iteration`, `complexity`, `mode`, `provider`, `version`, `agents`, `tasks`)
- [ ] **agents array:** Each must have optional `pid` field (can be null)
- [ ] **tasks object:** Must have `pending` and `inProgress` arrays
- [ ] **inProgress items:** First item must support `.get("payload", {}).get("action", "")`
- [ ] **orchestrator.json:** Preserve `currentPhase`, `iteration`, `complexity`, `metrics` structure
- [ ] **PID files:** Write as single integer on one line (no JSON wrapper)
- [ ] **Queue files:** Support both `{"tasks": [...]}` and `[...]` formats
- [ ] **Memory files:** JSONL for events.jsonl and checkpoints/index.jsonl
- [ ] **session.json:** Include `status`, `updatedAt`, `startedAt` fields
- [ ] **Run.sh equivalence:** Identify and implement same writers for all critical files or hook existing writers

---

## References

- Dashboard Status Endpoint: `/Users/lokesh/git/loki-mode/dashboard/server.py:737`
- Dashboard State Loop: `/Users/lokesh/git/loki-mode/dashboard/server.py:343`
- Activity Logger: `/Users/lokesh/git/loki-mode/dashboard/activity_logger.py:30`
- State Manager Enum: `/Users/lokesh/git/loki-mode/state/manager.py:48`

