# Agent 08: Docker + Self-Healing Integration Testing

## Summary

Audited Dockerfile, Dockerfile.sandbox, docker-compose.yml, healing system (`cmd_heal()`),
migration hooks (`migration-hooks.sh`), and state management in `run.sh`. Fixed 6 bugs
(2 known, 4 newly discovered).

---

## Bugs Fixed

### BUG-DK-002: docker-compose loki service missing health check (FIXED)

**File:** `docker-compose.yml`

**Problem:** The `loki` service had no health check defined. The docker-compose health check
description in the bug list said "hits wrong endpoint" -- the actual issue was that the loki
service had zero health check configuration. Only the ChromaDB service had one.

**Fix:** Added a health check to the loki service that first tries the dashboard `/health`
endpoint (for when the dashboard is running), with a fallback to `loki version` (for when
only the CLI is active). Also updated the version comment from v6.38.0 to v6.71.1.

```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -sf http://localhost:57374/health >/dev/null 2>&1 || loki version >/dev/null 2>&1"]
  interval: 30s
  timeout: 10s
  start-period: 10s
  retries: 3
```

---

### BUG-HEAL-002: Healing phase gate doesn't validate phase transitions (FIXED)

**File:** `autonomy/hooks/migration-hooks.sh`

**Problem:** `hook_healing_phase_gate()` used a `case` statement with only valid transitions
listed. Any invalid transition (backwards, skipping phases, unknown phases) fell through
the case and returned 0 (success), silently allowing dangerous operations like jumping
from `archaeology` directly to `modernize`.

**Fix:** Added phase ordering validation before the case statement. The function now:
1. Validates both `from_phase` and `to_phase` are known phases
2. Rejects backward transitions (e.g., `modernize` -> `archaeology`)
3. Rejects phase skipping (e.g., `archaeology` -> `modernize` skipping `stabilize`/`isolate`)
4. Only allows forward transitions to the immediately next phase

---

### BUG-HEAL-003: cmd_heal() provider case missing default clause (NEW - FIXED)

**File:** `autonomy/loki`

**Problem:** The `case "$provider"` statement in `cmd_heal()` (around line 9298) had no
default `*)` clause. If an unknown provider was specified (e.g., `loki heal ./app --provider foo`),
the case silently fell through, `heal_exit` stayed 0, and the user received a false
"Healing phase complete" success message.

**Fix:** Added a `*)` default clause that prints an error with supported providers and
returns 1.

---

### BUG-HEAL-004: Migration hooks never sourced in healing flow (NEW - FIXED)

**File:** `autonomy/loki`

**Problem:** `autonomy/hooks/migration-hooks.sh` was never sourced by either `autonomy/loki`
or `autonomy/run.sh`. This meant all healing hooks (`hook_pre_healing_modify()`,
`hook_post_healing_modify()`, `hook_healing_phase_gate()`) were dead code -- they existed
but were never called during actual healing operations. The only consumer was the test file
`tests/test-migration-v2.sh`.

**Fix:** Added sourcing of `migration-hooks.sh` in `cmd_heal()` with:
1. Source the hooks file using `BASH_SOURCE[0]` relative path resolution
2. Call `load_migration_hook_config()` to load project-specific hook configuration
3. Export healing environment variables (`LOKI_HEAL_MODE`, `LOKI_HEAL_PHASE`, etc.)
4. Invoke `hook_healing_phase_gate()` when `--resume` is used with a different phase

---

### BUG-ST-013: save_state() doesn't ensure .loki directory exists (NEW - FIXED)

**File:** `autonomy/run.sh`

**Problem:** `save_state()` writes to `.loki/autonomy-state.json` but doesn't ensure the
`.loki` directory exists. While normally created by `initialize_workspace()`, signal handlers
could call `save_state()` before initialization completes, causing a silent failure.

**Fix:** Added defensive `mkdir -p .loki 2>/dev/null || true` at the start of `save_state()`.

---

### BUG-ST-014: Non-atomic current-task.json writes (NEW - FIXED)

**File:** `autonomy/run.sh`

**Problem:** `current-task.json` was written with direct `echo ... > file` (lines 3631, 3815),
outside the flock-protected section. This could cause partial reads if the dashboard or
another process reads the file mid-write. Other state files (e.g., `autonomy-state.json`,
`session.json`) already used atomic temp-file + mv patterns.

**Fix:** Both writes now use `echo ... > tmpfile && mv -f tmpfile target` atomic pattern,
consistent with BUG-XC-004 and BUG-ST-008 patterns elsewhere in the codebase.

---

## Bugs Verified as Already Fixed

### BUG-DK-001: Dockerfile COPY dashboard/ missing pip install

Both `Dockerfile` (line 89-90) and `Dockerfile.sandbox` (line 180-181) already include
`pip3 install --no-cache-dir --break-system-packages -r dashboard/requirements.txt`.
No fix needed.

### BUG-DK-003: Sandbox Dockerfile doesn't install bash 5

Verified: Debian bookworm-slim (used by Dockerfile.sandbox) ships bash 5.2.15.
Ubuntu 24.04 (used by Dockerfile) ships bash 5.2.21. Both support associative arrays
and parallel mode. No fix needed.

### BUG-HEAL-001: cmd_heal() doesn't create .loki/healing/ directory before writing

Verified: `cmd_heal()` creates the directory at line 9201 with
`mkdir -p "$heal_dir"/{behavioral-baseline,characterization-tests}` before any writes.
The `--status`, `--report`, and `--friction-map` subcommands only read (never write)
and properly check for directory/file existence. No fix needed.

---

## Additional Findings (Not Fixed -- Low Priority)

### Non-atomic writes in initialization

Several state files during `initialize_workspace()` use direct `cat > file` patterns
(e.g., `orchestrator.json` at line 2955, `budget.json` at line 2980). These are safe because
initialization runs once before any concurrent access, but could be hardened for robustness.

### Phase skip via --phase flag without --resume

Users can run `loki heal ./app --phase modernize` and skip prior phases. This is by design
(expert override), but could be surprising. A warning message when starting at a non-archaeology
phase without prior healing data could improve UX.

---

## Files Modified

| File | Changes |
|------|---------|
| `docker-compose.yml` | Added loki service health check, updated version comment |
| `autonomy/hooks/migration-hooks.sh` | Added phase transition ordering validation |
| `autonomy/loki` | Added default provider clause, sourced hooks, added phase gate check on resume |
| `autonomy/run.sh` | Defensive mkdir in save_state(), atomic current-task.json writes |

## Validation

- All 3 modified shell scripts pass `bash -n` syntax validation
- `docker-compose.yml` passes YAML validation with correct structure
- Health check uses fallback pattern (curl || loki version) for resilience
- Phase gate validation tested against all 5 phases with forward, backward, and skip scenarios
