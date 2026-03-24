# Agent 01 - CLI Functional Testing Bug Fixes

File modified: `autonomy/loki`
Total changes: 166 insertions, 39 deletions

## Known Bugs Fixed

### BUG-CLI-003 | PID recycling guard for `cmd_web_stop`
- **Location**: `cmd_web_stop()` PID file kill block
- **Fix**: Before killing a PID from the PID file, verify the process command matches `python`, `uvicorn`, or `Purple` via `ps -p PID -o comm=`. If the PID has been recycled by the OS to a non-Purple-Lab process, skip the kill and warn the user.

### BUG-CLI-012 | Shell injection via unquoted Python file paths
- **Location**: Multiple `python3 -c` calls throughout the CLI
- **Fix**: Replaced all `open('$variable')` patterns in `python3 -c` calls with environment-variable-based parameter passing (`_VAR="$value" python3 -c "import os; open(os.environ['_VAR'])"`). Fixed 14 instances across:
  - `cmd_status` context window (lines ~1741-1742)
  - Healing report (friction map, failure modes)
  - Trigger schedule count
  - Failover chain providers
  - Vector index stats (numpy)
  - Context show (5 token metrics)
  - Budget cost display (2 metrics)
  - OTEL config endpoint
  - Project description JSON output

### BUG-CLI-005 | `cmd_web_status` wrong port and log paths
- **Location**: `cmd_web_status()`
- **Fix**: Port lookup now checks `$PURPLE_LAB_STATE_DIR/port` (home-based) first before CWD-based fallback. Log path resolves against home-based state dir first, falling back to CWD-based path.

### BUG-CLI-006 | `loki logs` truncates to 50 lines silently
- **Location**: `cmd_logs()`
- **Fix**: Added full argument parsing with `--tail/-n`, `--follow/-f`, `--all/-a`, and `--help`. The 50-line default is now documented in a hint line shown with output. Added `--follow` for live streaming.

### BUG-CLI-007 | `loki init` skips directory creation on failure
- **Location**: `cmd_init()` project directory creation
- **Fix**: Added `if ! mkdir -p` guards for both the project directory and `.loki` directory creation. Script now exits with an error message if directory creation fails.

### BUG-CLI-008 | `loki export` overwrites without confirmation
- **Location**: `_export_json()`, `_export_markdown()`, `_export_csv()`, `_export_timeline()`
- **Fix**: Added `_export_check_overwrite()` helper that checks if the output file exists and prompts `Overwrite? [y/N]` before writing. Called in all four export format functions.

### BUG-CLI-009 | `loki share` generates non-unique IDs
- **Location**: `cmd_share()` gist description
- **Fix**: Changed gist description timestamp from `%Y-%m-%d` (day granularity) to `%Y-%m-%dT%H:%M:%S` (second granularity) to avoid collisions when sharing multiple times per day.

### BUG-CLI-010 | `loki config set` accepts any key without validation
- **Location**: `cmd_config_set()` wildcard case
- **Fix**: Changed from a warning that stores the value anyway to a hard error that lists valid keys and returns 1. Unknown keys are now rejected.

### BUG-CLI-011 | `config_get` error handling
- **Location**: `cmd_config_get()`
- **Fix**: Wrapped the Python heredoc in a subshell capture with `|| { error; return 1; }` pattern to gracefully handle python3 failures without leaking state. Removed unnecessary `unset` of inline env vars.

### BUG-CLI-008 (Medium) | `LOKI_DIR` not exported for Python heredocs
- **Location**: Line 129
- **Fix**: Added `export LOKI_DIR` immediately after assignment. This ensures all Python heredocs using `os.environ.get("LOKI_DIR", ".loki")` receive the correct value.

### BUG-PAR-002 | `worktree list` branch pattern never matches
- **Location**: `cmd_worktree()` list subcommand
- **Fix**: Branch matching pattern changed from `loki-parallel-*` to match both `parallel-*` and `loki-parallel-*`. The actual branches created by `run.sh` use `parallel-<stream>` prefix (line 2130 of run.sh), not `loki-parallel-`.

### BUG-PAR-010 | `worktree clean` doesn't kill running sessions
- **Location**: `cmd_worktree()` clean subcommand
- **Fix**: Before removing a worktree via `git worktree remove`, check for `.loki/loki.pid` in the worktree directory. If a session is running, send SIGTERM, wait 1 second, then SIGKILL if needed.

## New Bugs Found and Fixed

### NEW-CLI-001 | Division by zero in context percentage calculation
- **Location**: `cmd_status()` and `_context_show()`
- **Fix**: Added `if [ "$ctx_total" -gt 0 ]` / `if [ "$total_tokens" -gt 0 ]` guards before the `$((used * 100 / total))` arithmetic. If total is zero, percentage defaults to 0.

### NEW-CLI-002 | Missing `loki web logs` subcommand
- **Location**: `cmd_web()` case dispatch
- **Fix**: Added `logs)` case to `cmd_web()` that displays Purple Lab server logs using `tail -n`. Defaults to 100 lines. Also checks home-based state dir and CWD-based fallback for log file location. Updated `cmd_web_help()` to list the `logs` subcommand.

## Bugs Investigated But Not Fixed (Already Correct)

### BUG-CLI-001 / BUG-CLI-002 | `--port` / `--prd` unbound variable
- **Status**: Already fixed in current code. `cmd_web_start()` initializes `port="${PURPLE_LAB_DEFAULT_PORT}"` and `prd_file=""` before the argument parsing loop. The `--port` and `--prd` handlers properly check `${2:-}` before accessing `$2`.

### BUG-CLI-004 | `--no-open` flag ignored
- **Status**: Already working correctly. The `open_browser` variable is set to `false` by `--no-open` and checked with `if [ "$open_browser" = true ]` before any browser-open calls.

### BUG-CLI-009 (Medium) | Empty array with `set -u` in `list_running_sessions`
- **Status**: Already fixed. Uses `${sessions[@]+"${sessions[@]}"}` pattern throughout, which is the correct `set -u`-safe array expansion.

### BUG-CMD-001 | `cmd_web` wildcard duplicates arguments
- **Status**: Analyzed and found to be working correctly. The `*)` case properly shifts the subcommand-as-flag, then passes it along with remaining args to `cmd_web_start`.

## Bugs Found But Not Fixed (Out of Scope or Extensive)

### Missing `$2` guards in `shift 2` patterns
- **Location**: Multiple argument parsers (e.g., `cmd_state query`, trigger config parsing)
- **Issue**: Under `set -u`, if a flag like `--agent` is the last argument without a value, `$2` is unset, causing a crash. The pattern `shift 2 ;;` should be guarded with `${2:-}` checks.
- **Impact**: Low -- only triggers on malformed user input.
- **Scope**: 20+ occurrences across the file; would require systematic refactoring.

### Remaining shell-expanded heredocs with `$variable` in `open()` calls
- **Location**: Lines 3745, 8002, 9332, 10228, 10262, 12604, 16844, etc.
- **Issue**: Double-quoted heredocs (`<< HEREDOC`) interpolate shell variables into Python `open()` calls. While the variables are internally-constructed paths (not user input), specially-crafted directory names with quotes could theoretically cause injection.
- **Impact**: Very low -- would require the user to be working in a directory with Python metacharacters in its path.
- **Scope**: 15+ occurrences; fixing all requires converting to single-quoted heredocs with env var passing.
