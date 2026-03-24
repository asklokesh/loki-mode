# Agent 12 Bug Fixes - Discovered During Scenario Writing

Date: 2026-03-24 | Version: v6.71.1

---

## Bugs Fixed (5 fixes across 3 files)

### 1. BUG-EP-012: Corrupted memory index/timeline not auto-recovered

**File:** `memory/storage.py` (lines 170-192)
**Severity:** Medium
**Symptom:** If `.loki/memory/index.json` or `timeline.json` becomes corrupted (invalid JSON from a crash or disk error), all memory operations silently fail permanently. The `_ensure_index()` method only recreates the file when it does not exist, not when it exists but contains invalid JSON.

**Fix:** Added JSON validity checks in `_ensure_index()` and `_ensure_timeline()`. When the file exists but is corrupted (JSONDecodeError), it is now logged and recreated from scratch. This restores memory system functionality without requiring manual file deletion.

**Before:**
```python
def _ensure_index(self) -> None:
    index_path = self.base_path / "index.json"
    if not index_path.exists():
        # ... create initial index
```

**After:**
```python
def _ensure_index(self) -> None:
    index_path = self.base_path / "index.json"
    needs_init = not index_path.exists()
    if not needs_init:
        try:
            text = index_path.read_text(encoding="utf-8", errors="replace")
            json.loads(text)
        except (json.JSONDecodeError, OSError):
            logging.getLogger(__name__).warning(
                "Corrupted index.json detected, recreating from scratch"
            )
            needs_init = True
    if needs_init:
        # ... create initial index
```

---

### 2. BUG-EP-015: Orphaned temp files accumulate after kill -9

**Files:** `memory/storage.py`, `autonomy/run.sh`
**Severity:** Low
**Symptom:** When a process is killed with SIGKILL during an atomic write (temp file + rename), the temp file is left behind because the rename never completes. These `.tmp_*.json` files in the memory directory and `.tmp.*` files in `.loki/` accumulate indefinitely.

**Fix (memory/storage.py):** Added `_cleanup_stale_tmp_files()` method that runs on MemoryStorage initialization. Removes `.tmp_*.json` files older than 5 minutes.

**Fix (autonomy/run.sh):** Added cleanup in `load_state()` that runs `find .loki/ -name "*.tmp.*" -mmin +5 -delete` on session startup. This catches orphaned temp files from previous kill -9 events.

---

### 3. BUG-EC-013: Empty provider output silently treated as success

**File:** `autonomy/run.sh` (after provider invocation, ~line 9691)
**Severity:** Medium
**Symptom:** When a provider returns exit code 0 but produces zero output (0 bytes in iter_output), the system treats it as a successful iteration. This wastes iterations -- the system continues to the next iteration without detecting that nothing happened. If the provider consistently returns empty output (broken prompt, API issue), the stagnation detector does not kick in for 5+ iterations.

**Fix:** Added a post-invocation check: if `$iter_output` exists, is empty (0 bytes), and exit_code is 0, the exit_code is overridden to 1 with a warning log message. This ensures the iteration is treated as a failure, triggering appropriate retry/backoff logic.

```bash
# BUG-EC-013: Detect empty provider output (0 bytes = no work done)
if [ -f "$iter_output" ] && [ ! -s "$iter_output" ] && [ $exit_code -eq 0 ]; then
    log_warn "Provider returned empty output (0 bytes) despite exit code 0 -- treating as error"
    exit_code=1
fi
```

---

### 4. BUG-EC-014: Quality gate subprocesses have no timeout

**File:** `autonomy/run.sh` (enforce_test_coverage, ~line 5529)
**Severity:** High
**Symptom:** Test runner invocations (vitest, jest, mocha) inside quality gates have no timeout. A hanging test runner (e.g., waiting for user input, network timeout, infinite loop in tests) blocks the entire autonomous iteration indefinitely. The system becomes unresponsive.

**Fix:** Wrapped all test runner invocations with the `timeout` command, defaulting to 300 seconds (5 minutes), configurable via `LOKI_GATE_TIMEOUT` environment variable. When the timeout fires, the test runner is killed and the gate reports failure, allowing the system to continue.

```bash
local gate_timeout="${LOKI_GATE_TIMEOUT:-300}"  # 5 minutes default
output=$(cd "${TARGET_DIR:-.}" && timeout "$gate_timeout" npx vitest run --reporter=json 2>&1) || test_passed=false
```

---

## Bugs Identified But Not Fixed (4 bugs, require design decisions)

### BUG-EP-004: check_provider_health() validates key exists, not validity
- **Location:** run.sh:6864
- **Reason not fixed:** Validating key validity requires an API call to each provider, which has cost/rate-limit implications. Requires design decision on whether to add a lightweight health check endpoint call.

### BUG-CU-002: No automatic dashboard port increment
- **Location:** run.sh dashboard startup
- **Reason not fixed:** Changing port allocation logic requires coordination between the dashboard server, the CLI status display, and the web frontend (which connects to a hardcoded port). Needs design discussion on port discovery mechanism.

### BUG-CU-005: Export reads state files without cross-file consistency
- **Location:** loki:5034
- **Reason not fixed:** True cross-file consistency requires either a snapshot mechanism or a single monolithic state file. The current multi-file approach is by design for performance. Low impact since export is typically used after pausing.

### BUG-EC-002: No PRD size limit or truncation before context injection
- **Location:** run.sh build_prompt
- **Reason not fixed:** The PRD is passed as a file path reference, not inline content. Truncation would lose requirements. The AI provider handles context window overflow. However, a warning for very large PRDs (> 50KB) would be useful.

---

## Test Impact

The fixes touch three files:
1. `memory/storage.py` - Memory system initialization (covered by `tests/test-memory-engine.sh`, `tests/test-unified-memory.sh`)
2. `autonomy/run.sh` - Core orchestration loop (covered by `tests/test-state-recovery.sh`, `tests/test-v6-features.sh`)

All fixes are backward-compatible:
- Memory corruption recovery only triggers on actual corruption (no behavioral change for healthy systems)
- Temp file cleanup only removes files older than 5 minutes (safe with concurrent processes)
- Empty output detection is a strict subset (only overrides exit_code when output is literally 0 bytes AND exit was 0)
- Quality gate timeout defaults to 5 minutes (longer than any reasonable test suite; configurable via env var)
