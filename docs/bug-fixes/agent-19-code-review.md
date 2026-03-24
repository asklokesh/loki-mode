# Agent 19 Code Review Report

Date: 2026-03-24
Scope: Full codebase code quality review -- security, correctness, anti-patterns
Files Reviewed: ~50 key files across shell, Python, TypeScript

---

## CRITICAL Findings (Security / Data Corruption)

### C-01: `eval` on Python output in `run.sh` -- shell injection via malicious JSON config

**File:** `autonomy/run.sh` lines 485-525 (`_load_json_settings`)
**File:** `autonomy/run.sh` line 6785 (`read_failover_config`)

Both functions use `eval "$(python3 ...)"` to set shell variables from Python output. While the `_load_json_settings` function uses `shlex.quote()` for value escaping, and `read_failover_config` uses a single-quoted heredoc (`<< 'PYEOF'`), the fundamental pattern is fragile:

- **`_load_json_settings`**: If the Python script itself errors in an unexpected way that produces partial output, the `eval` can execute truncated shell commands. The `2>/dev/null || true` at line 525 suppresses any diagnostic. Additionally, the `shlex.quote()` escaping protects against values but not against key names -- if a settings.json key somehow injects into the mapping dictionary keys (unlikely but architecturally fragile).

- **`read_failover_config`** (line 6785): Reads JSON and prints shell variable assignments. The single-quoted heredoc prevents expansion during heredoc creation, and the Python constructs values directly from JSON. However, a malicious `failover.json` with crafted string values for `chain`, `currentProvider`, or `primaryProvider` fields that contain shell metacharacters could escape the quoting. The Python uses f-strings with `str()` and direct dict lookups -- the `chain` field is joined with commas from a list, but `currentProvider`/`primaryProvider` are raw string values printed inside double quotes. A value like `"; rm -rf /; echo "` would be eval'd.

**Severity:** CRITICAL
**Risk:** Arbitrary command execution if `.loki/state/failover.json` is tampered with or written by an untrusted process.
**Fix:** Replace `eval` with `declare` assignments or read values into variables using `read` from a pipe. Alternatively, validate all Python-produced assignments match `^[A-Z_]+=.*$` before eval.

### C-02: `eval "$LOKI_MONOREPO_TEST_CMD"` -- arbitrary command execution from env var

**File:** `autonomy/run.sh` line 5563

```bash
output=$(cd "${TARGET_DIR:-.}" && eval "$LOKI_MONOREPO_TEST_CMD" 2>&1) || test_passed=false
```

The `LOKI_MONOREPO_TEST_CMD` environment variable is eval'd directly. While this is documented as a user-configurable override, it executes with the full privileges of the running shell. If an attacker can set environment variables (e.g., via `.env` injection, CI variable pollution, or config file poisoning), this becomes an arbitrary code execution vector.

**Severity:** CRITICAL (in multi-tenant / CI environments)
**Risk:** Arbitrary command execution
**Mitigation:** This is by design for power users, but should be guarded with a warning log and possibly a `LOKI_ALLOW_EVAL=true` gate. Document the security implications in CLAUDE.md.

### C-03: Non-atomic `write_text()` in dashboard server for signal files

**File:** `dashboard/server.py` lines 2781, 2877, 3289, 3410-3411

Multiple control endpoints use `Path.write_text()` directly without atomic write patterns:

```python
pause_file.write_text(datetime.now(timezone.utc).isoformat())  # line 2781
stop_file.write_text(datetime.now(timezone.utc).isoformat())   # line 2877
(signal_dir / "COUNCIL_REVIEW_REQUESTED").write_text(...)      # line 3289
```

While line 3410-3411 does use temp+rename for `triggers.json`, the signal files above are written directly. If the process crashes or receives a signal mid-write, these files can be left in a partially-written state. For simple timestamp strings this is low risk, but `triggers.json` could be corrupted.

**Severity:** MEDIUM
**Risk:** Partial file writes under system pressure
**Fix:** Use `atomic_write_json` (already available via `from .control import atomic_write_json`) or at minimum write to temp + rename for JSON files.

### C-04: `_save_registry` writes JSON without atomic rename

**File:** `dashboard/registry.py` line 40-44

```python
def _save_registry(registry: dict) -> None:
    with open(REGISTRY_FILE, "w") as f:
        json.dump(registry, f, indent=2, default=str)
```

This writes directly to the registry file. A crash during write corrupts `~/.loki/dashboard/projects.json`. Unlike `memory/storage.py` and `dashboard/control.py` which use temp+rename, the registry uses a simple overwrite.

**Severity:** MEDIUM
**Risk:** Registry corruption on crash
**Fix:** Use temp file + `os.rename()` pattern consistent with rest of codebase.

---

## HIGH Findings (Correctness / Reliability)

### H-01: `_sanitize_text_field` strips tab and newline from text fields

**File:** `dashboard/server.py` lines 148-158

```python
cleaned = "".join(
    ch for ch in value if unicodedata.category(ch)[0] != "C" or ch in (" ",)
)
```

This strips all control characters except space. This means tab (`\t`) and newline (`\n`) are stripped. For short fields like `name` this is fine, but the function is called on project names and task titles. If descriptions ever use this sanitizer, legitimate multi-line descriptions would be silently flattened.

**Severity:** LOW
**Status:** Acceptable for current usage (name/title fields only). Worth noting if sanitization scope expands.

### H-02: Duplicate `TASK_STRATEGIES` definition

**File:** `memory/engine.py` lines 34-65
**File:** `memory/retrieval.py` lines 121-150

The `TASK_STRATEGIES` dictionary is defined identically in both files. If one is updated without the other, retrieval behavior diverges silently. The engine.py copy appears unused -- `retrieval.py` is the authoritative consumer.

**Severity:** MEDIUM
**Risk:** Behavioral divergence if one copy is modified
**Fix:** Remove the `TASK_STRATEGIES` from `engine.py` and import from `retrieval.py` if needed, or create a shared `constants.py`.

### H-03: `_file_lock` reentrant path yields `None` without lock

**File:** `memory/storage.py` lines 198-243

When reentrant lock detection triggers (thread already holds lock on same path), the context manager yields without holding the lock file. The caller proceeds to read/write files assuming the lock is held. This is safe for the single-thread case but could allow interleaving if another process acquires the lock between the check and the yield.

```python
if lock_key in self._held_locks.paths:
    yield  # No lock held -- other processes can interleave
    return
```

**Severity:** LOW (single-process design mitigates this)
**Status:** Acceptable given that MemoryStorage is designed for single-process use with reentrant calls. Worth documenting the limitation.

### H-04: Bare `except Exception: pass` suppresses errors silently (40+ locations)

**Files:** `state/manager.py`, `memory/storage.py`, `events/bus.py`, `dashboard/server.py`, `learning/emitter.py`, `dashboard/telemetry.py`

Found 40+ instances of bare `except Exception: pass` or `except Exception:` with minimal handling. Most are in cleanup/notification paths where swallowing errors is intentional (don't let logging failures break core logic). However, several are in data paths:

- `state/manager.py:586` -- subscriber notification errors silently swallowed
- `events/bus.py:408` -- event persistence errors silently swallowed
- `dashboard/server.py:3862` -- log parsing errors silently swallowed
- `memory/storage.py:270,550,663` -- various I/O operations

**Severity:** MEDIUM (cumulative debugging difficulty)
**Risk:** Silent data loss, difficult-to-diagnose issues
**Fix:** Add at minimum `logger.debug()` calls for the data-path exceptions. The notification/cleanup paths are acceptable as-is.

### H-05: WebSocket `receive_text()` timeout logic may close valid connections

**File:** `dashboard/server.py` lines 1430-1462

The WebSocket handler pings after 30s of silence and closes after 2 consecutive missed pongs:

```python
data = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
```

A client that sends only binary frames or is temporarily network-delayed for >60s gets disconnected. The 60s total timeout (2 x 30s) is reasonable but aggressive for mobile clients on poor networks. Consider making the timeout configurable via environment variable.

**Severity:** LOW

### H-06: `_safe_json_read` blocks event loop with `time.sleep(0.1)`

**File:** `dashboard/server.py` line 87

```python
time.sleep(0.1)  # sync sleep in async context
```

This is called from `_safe_json_read` which is a synchronous function used by the background WebSocket push loop. Since the push loop is an async coroutine, any synchronous call that blocks will stall the event loop. The 0.1s block is short but could compound under load.

**Severity:** LOW
**Fix:** Use `asyncio.sleep(0.1)` in the async context or move file reads to a thread pool via `asyncio.to_thread()`.

---

## MODERATE Findings (Code Quality / Anti-Patterns)

### M-01: `_version` fallback to hardcoded "5.58.1"

**File:** `dashboard/server.py` lines 58-61

```python
try:
    from . import __version__ as _version
except ImportError:
    _version = "5.58.1"
```

The fallback version is stale (current is 6.71.1). This means if the `__init__.py` import fails, the API reports a very old version, misleading monitoring and debugging.

**Severity:** LOW
**Fix:** Update fallback to "0.0.0-unknown" or read from VERSION file as fallback.

### M-02: Unquoted variable in `task_count` increment inside subshell

**File:** `autonomy/run.sh` line 1715

```bash
task_count=$((task_count + 1))
```

This is inside a subshell `( ... ) 200>"$lockfile"`, so the increment to `task_count` is lost when the subshell exits. The variable in the parent shell retains its original value. The `log_info "Imported $task_count issues"` at line 1723 will always report 0.

**Severity:** MEDIUM
**Risk:** Misleading log output -- always reports 0 imported issues regardless of actual count
**Fix:** Track count outside the subshell using a temp file counter, or restructure to avoid the subshell.

### M-03: Schema import fallback assigns `Any` to class variables

**File:** `memory/storage.py` lines 23-29

```python
try:
    from .schemas import EpisodeTrace, SemanticPattern, ProceduralSkill
except ImportError:
    EpisodeTrace = Any
    SemanticPattern = Any
    ProceduralSkill = Any
```

When schemas import fails, `Any` (from `typing`) is assigned. This means `isinstance()` checks against these types will behave unexpectedly -- `isinstance(x, Any)` always raises `TypeError` in Python 3.10+. Any code paths that check types against these fallbacks will crash.

**Severity:** LOW (import failures are rare in practice)
**Fix:** Use `object` instead of `Any` as fallback for class assignments, or remove the try/except entirely since schemas should always be available.

### M-04: `_RateLimiter` key eviction races with concurrent access

**File:** `dashboard/server.py` lines 104-137

The rate limiter is a plain dict with no thread/coroutine safety. In an async FastAPI server, concurrent coroutines could interleave during the eviction/pruning operations:

```python
empty_keys = [k for k, v in self._calls.items() if not v]
for k in empty_keys:
    del self._calls[k]
```

With asyncio, this is actually safe since coroutines don't preempt each other within a single event loop turn. But if the server ever adds threading (e.g., for background tasks), this becomes a race condition.

**Severity:** LOW (safe under current asyncio model)
**Status:** Acceptable for now. Document the single-threaded assumption.

### M-05: `check_budget_limit` bare `except: pass` in inline Python

**File:** `autonomy/run.sh` line 7241

```python
    except: pass
```

This is inside an inline Python script. Bare `except:` (without `Exception`) catches `SystemExit`, `KeyboardInterrupt`, and `GeneratorExit`, suppressing them all. This can mask fundamental errors during cost calculation.

**Severity:** LOW
**Fix:** Change to `except Exception: pass`.

### M-06: Double trap registration in `run.sh`

**File:** `autonomy/run.sh` lines 186 and 199

```bash
trap 'rm -f "$TEMP_SCRIPT"' EXIT     # line 186, before exec
trap 'rm -f "${BASH_SOURCE[0]}" 2>/dev/null' EXIT  # line 199, after exec
```

The first trap is set before `exec`, meaning it runs in the pre-exec shell (which never reaches exit because of `exec`). The second trap correctly runs in the exec'd copy. The first trap is a no-op (the comment says "Set trap BEFORE exec" but exec replaces the process). This is benign but misleading.

**Severity:** INFORMATIONAL
**Status:** The code works correctly. The comment at line 185 is inaccurate -- the trap doesn't survive `exec`. The actual cleanup happens at line 199.

---

## Cross-Cutting Observations

### Security Posture: GOOD

- Path traversal protection in MCP server is thorough (symlink chain walking, allowed-directory enforcement)
- Memory storage validates namespace with regex to prevent path traversal
- OIDC implementation has clear security warnings about signature verification
- Token hashing uses per-token salts with SHA-256
- Token files enforce 0600 permissions
- CORS defaults to localhost-only
- Control endpoints have rate limiting
- WebSocket auth requires tokens when enterprise mode is enabled
- Dashboard checklist waiver endpoint validates `item_id` against path traversal characters
- SQLAlchemy ORM usage prevents SQL injection

### Error Handling: MODERATE

- Core data paths (atomic writes, file locking) have proper error handling
- Many log/metrics/events paths silently swallow exceptions (acceptable for non-critical observability)
- Inline Python in shell scripts uses bare `except: pass` instead of `except Exception:`
- Dashboard server has comprehensive `try/except` around file reads with fallback values

### Concurrency: GOOD

- File locking via `fcntl.flock()` is used consistently in memory system and state manager
- Atomic writes via temp+rename used in critical data paths
- Lock file cleanup for stale locks from crashed processes
- `_held_locks` thread-local prevents deadlocks from reentrant lock acquisition

### React/TypeScript: GOOD

- No `dangerouslySetInnerHTML` usage in source code (only in compiled bundle)
- Error boundaries in place for major components
- `useEffect` cleanup functions properly implemented (e.g., `cancelled` flag in auth hook)
- WebSocket subscription cleanup via returned unsubscribe functions
- API client properly handles errors and provides typed responses
- No direct DOM manipulation or innerHTML usage
- Auth tokens stored in localStorage with proper Bearer header usage

---

## Priority Fix Recommendations

1. **C-01 (CRITICAL):** Validate eval'd Python output matches expected format before eval in `read_failover_config`. Add `shlex.quote()` for the provider string values printed by the Python inline.
2. **M-02 (MEDIUM):** Fix `task_count` subshell variable loss in `import_github_issues`. This causes incorrect log output.
3. **H-02 (MEDIUM):** Deduplicate `TASK_STRATEGIES` -- single source of truth.
4. **C-03 (MEDIUM):** Use atomic writes for trigger/signal JSON files.
5. **C-04 (MEDIUM):** Add atomic write to `_save_registry`.
6. **M-01 (LOW):** Update stale fallback version string.
7. **M-05 (LOW):** Change bare `except:` to `except Exception:` in inline Python.

---

## Feedback Loops Completed

- Loop 1: Re-read each finding to verify it represents a real issue, not a false positive from partial context. Confirmed C-01 eval pattern is real (not safely guarded for all value types). Confirmed M-02 subshell variable loss is a genuine bash behavior issue.
- Loop 2: Validated syntax of all referenced code patterns. No misquotations in report.
- Loop 3: Prioritized by actual exploitability and impact. C-02 is marked critical but noted as by-design. C-01 is the highest-priority actionable fix.
