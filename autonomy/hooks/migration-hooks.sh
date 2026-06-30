#!/usr/bin/env bash
#===============================================================================
# Migration Hooks Engine
#
# Deterministic shell-level enforcement for migration pipelines.
# These hooks run WHETHER THE AGENT COOPERATES OR NOT.
# They are NOT LLM calls. They are shell scripts with binary pass/fail.
#
# Lifecycle points:
#   pre_file_edit    - Before agent modifies any source file (can BLOCK)
#   post_file_edit   - After agent modifies a source file (runs tests)
#   post_step        - After agent declares a migration step complete
#   pre_phase_gate   - Before transitioning between phases
#   on_agent_stop    - When agent tries to declare migration complete
#
# Configuration:
#   .loki/migration-hooks.yaml (project-level, optional)
#   Defaults applied when no config exists.
#
# Environment:
#   LOKI_MIGRATION_ID     - Current migration identifier
#   LOKI_MIGRATION_DIR    - Path to migration artifacts directory
#   LOKI_CODEBASE_PATH    - Path to target codebase
#   LOKI_CURRENT_PHASE    - Current migration phase
#   LOKI_CURRENT_STEP     - Current step ID (during migrate phase)
#   LOKI_TEST_COMMAND      - Test command to run (auto-detected or configured)
#   LOKI_FEATURES_PATH    - Path to features.json
#   LOKI_AGENT_ID         - ID of the current agent
#   LOKI_FILE_PATH        - Path of file being modified (for file hooks)
#===============================================================================

set -euo pipefail

# shellcheck disable=SC2034
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load project-specific hook config if it exists
load_migration_hook_config() {
    local codebase_path="${1:-.}"
    local config_file="${codebase_path}/.loki/migration-hooks.yaml"

    # Defaults (used by other functions in this file; SC2034 disabled for globals-via-function pattern)
    # shellcheck disable=SC2034
    HOOK_POST_FILE_EDIT_ENABLED=true
    # shellcheck disable=SC2034
    HOOK_POST_STEP_ENABLED=true
    # shellcheck disable=SC2034
    HOOK_PRE_PHASE_GATE_ENABLED=true
    # shellcheck disable=SC2034
    HOOK_ON_AGENT_STOP_ENABLED=true
    # shellcheck disable=SC2034
    HOOK_POST_FILE_EDIT_ACTION="run_tests"
    # shellcheck disable=SC2034
    HOOK_POST_FILE_EDIT_ON_FAILURE="block_and_rollback"
    # shellcheck disable=SC2034
    HOOK_POST_STEP_ON_FAILURE="reject_completion"
    # shellcheck disable=SC2034
    HOOK_ON_AGENT_STOP_ON_FAILURE="force_continue"

    if [[ -f "$config_file" ]] && command -v python3 &>/dev/null; then
        # Parse YAML config safely using read/declare instead of eval
        while IFS='=' read -r key val; do
            case "$key" in
                HOOK_*) printf -v "$key" '%s' "$val" ;;
            esac
        done < <(python3 -c "
import sys
try:
    import yaml
    with open('${config_file}') as f:
        cfg = yaml.safe_load(f) or {}
    hooks = cfg.get('hooks', {})
    for key, val in hooks.items():
        if isinstance(val, dict):
            for k, v in val.items():
                safe_key = 'HOOK_' + key.upper() + '_' + k.upper()
                safe_val = str(v).replace(chr(10), ' ').replace(chr(13), '')
                print(f'{safe_key}={safe_val}')
        elif isinstance(val, bool):
            safe_key = 'HOOK_' + key.upper() + '_ENABLED'
            print(f'{safe_key}={\"true\" if val else \"false\"}')
except Exception as e:
    print(f'# Hook config parse warning: {e}', file=sys.stderr)
" 2>/dev/null || true)
    fi
}

# Auto-detect test command for the codebase
detect_test_command() {
    local codebase_path="${1:-.}"

    if [[ -n "${LOKI_TEST_COMMAND:-}" ]]; then
        echo "$LOKI_TEST_COMMAND"
        return
    fi

    # Detection priority
    if [[ -f "${codebase_path}/package.json" ]] && grep -q '"test"' "${codebase_path}/package.json" 2>/dev/null; then
        echo "cd '${codebase_path}' && npm test"
    elif [[ -f "${codebase_path}/pom.xml" ]]; then
        echo "cd '${codebase_path}' && mvn test -q"
    elif [[ -f "${codebase_path}/build.gradle" || -f "${codebase_path}/build.gradle.kts" ]]; then
        echo "cd '${codebase_path}' && ./gradlew test --quiet"
    elif [[ -f "${codebase_path}/Cargo.toml" ]]; then
        echo "cd '${codebase_path}' && cargo test --quiet"
    elif [[ -f "${codebase_path}/setup.py" || -f "${codebase_path}/pyproject.toml" ]]; then
        echo "cd '${codebase_path}' && python -m pytest -q"
    elif [[ -f "${codebase_path}/go.mod" ]]; then
        echo "cd '${codebase_path}' && go test ./..."
    elif [[ -d "${codebase_path}/tests" ]]; then
        echo "cd '${codebase_path}' && python -m pytest tests/ -q"
    else
        # No framework detected and LOKI_TEST_COMMAND unset.
        # In healing mode the gates MUST fail closed: "no tests" can never be
        # treated as "tests passed", or the behavioral-preservation guarantee
        # is silently defeated. Emit a sentinel the healing consumers detect and
        # turn into a hard BLOCK (see is_no_test_cmd). The bare token also fails
        # if eval'd directly (command-not-found, exit 127) so the default is
        # fail-closed even if a string check is ever missed.
        # Outside healing mode, preserve the prior fail-open behavior: the
        # non-healing consumers (post_file_edit, post_step, pre_phase_gate) run
        # this via `eval` and a bare token there would exit 127 -> taken block
        # -> destructive (e.g. reverting a user edit in a repo with no tests).
        if [[ "${LOKI_HEAL_MODE:-false}" == "true" ]]; then
            echo "__LOKI_NO_TEST_CMD__"
        else
            echo "echo 'No test command detected. Set LOKI_TEST_COMMAND.'"
        fi
    fi
}

# Returns 0 (true) when detect_test_command yielded the no-test-command
# sentinel, i.e. no framework was detected and LOKI_TEST_COMMAND is unset.
# Used by the healing gates to distinguish "no tests available" (block) from
# "tests ran and passed" (allow) and "tests ran and failed" (block).
is_no_test_cmd() {
    [[ "${1:-}" == "__LOKI_NO_TEST_CMD__" ]]
}

# Resolve the directory used to store pre-edit snapshots for the migration
# (non-healing) hooks. Prefers LOKI_MIGRATION_DIR; falls back to a per-codebase
# .loki/migration dir so the snapshot/revert pair works even when no migration
# dir was exported. Echoes the resolved directory.
_migration_snapshot_dir() {
    local codebase_path="${LOKI_CODEBASE_PATH:-.}"
    local migration_dir="${LOKI_MIGRATION_DIR:-}"
    if [[ -n "$migration_dir" ]]; then
        printf '%s' "$migration_dir"
    else
        printf '%s' "${codebase_path}/.loki/migration"
    fi
}

# Hook: pre_file_edit - runs BEFORE ANY agent modifies a source file.
# Captures a pre-edit snapshot so post_file_edit can revert ONLY the edit on
# test failure (instead of a blanket `git checkout` that nukes unrelated
# uncommitted changes and silently no-ops for untracked files). Mirrors the
# pairing contract of hook_pre_healing_modify / hook_post_healing_modify.
hook_pre_file_edit() {
    local file_path="${1:-}"
    [[ "${HOOK_POST_FILE_EDIT_ENABLED:-true}" != "true" ]] && return 0
    [[ -z "$file_path" ]] && return 0
    local snap_base
    snap_base=$(_migration_snapshot_dir)
    # Enforce the pairing contract: if the snapshot cannot be captured, BLOCK the
    # edit. Proceeding would leave post_file_edit's block_and_rollback path with
    # no snapshot to restore -- a test failure would then leave the broken edit
    # in place (silent revert failure). Fail loud/closed here instead.
    if ! _heal_snapshot_save "$snap_base" "$file_path"; then
        echo "HOOK_BLOCKED: could not capture a pre-edit snapshot for ${file_path}; refusing to edit without a revert path. Check that ${snap_base}/snapshots is writable."
        return 1
    fi
    return 0
}

# Hook: post_file_edit - runs after ANY agent modifies a source file
hook_post_file_edit() {
    local file_path="${1:-}"
    local codebase_path="${LOKI_CODEBASE_PATH:-.}"
    local migration_dir="${LOKI_MIGRATION_DIR:-}"

    [[ "$HOOK_POST_FILE_EDIT_ENABLED" != "true" ]] && return 0

    # Log the edit
    if [[ -n "$migration_dir" ]]; then
        local log_entry
        log_entry="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"file_edit\",\"file\":\"${file_path}\",\"agent\":\"${LOKI_AGENT_ID:-unknown}\"}"
        echo "$log_entry" >> "${migration_dir}/activity.jsonl" 2>/dev/null || true
    fi

    # Run tests
    local test_cmd
    test_cmd=$(detect_test_command "$codebase_path")
    local test_result_file
    test_result_file=$(mktemp)

    if ! eval "$test_cmd" > "$test_result_file" 2>&1; then
        local test_output
        test_output=$(cat "$test_result_file")
        rm -f "$test_result_file"

        case "${HOOK_POST_FILE_EDIT_ON_FAILURE}" in
            block_and_rollback)
                # Revert ONLY the edit using the pre-edit snapshot captured by
                # hook_pre_file_edit. Do NOT use `git checkout -- "$file_path"`:
                # that discards ALL uncommitted changes to the file (not just
                # this edit) and silently no-ops for an untracked file while
                # still claiming the change was reverted. Report what happened.
                local snap_base revert_msg
                snap_base=$(_migration_snapshot_dir)
                revert_msg=$(_heal_snapshot_restore "$snap_base" "$file_path") || true
                echo "HOOK_BLOCKED: Tests failed after editing ${file_path}. ${revert_msg}"
                echo "Test output: ${test_output}"
                return 1
                ;;
            warn)
                echo "HOOK_WARNING: Tests failed after editing ${file_path}."
                return 0
                ;;
            *)
                return 1
                ;;
        esac
    fi

    rm -f "$test_result_file"
    return 0
}

# Hook: post_step - runs after agent declares a migration step complete
hook_post_step() {
    local step_id="${1:-}"
    local codebase_path="${LOKI_CODEBASE_PATH:-.}"

    [[ "$HOOK_POST_STEP_ENABLED" != "true" ]] && return 0

    # Run full test suite
    local test_cmd
    test_cmd=$(detect_test_command "$codebase_path")

    if ! eval "$test_cmd" >/dev/null 2>&1; then
        case "${HOOK_POST_STEP_ON_FAILURE}" in
            reject_completion)
                echo "HOOK_REJECTED: Step ${step_id} completion rejected. Tests do not pass."
                return 1
                ;;
            *)
                return 1
                ;;
        esac
    fi

    return 0
}

# Hook: pre_phase_gate - mechanical verification before phase transition
hook_pre_phase_gate() {
    local from_phase="${1:-}"
    local to_phase="${2:-}"
    local migration_dir="${LOKI_MIGRATION_DIR:-}"

    [[ "$HOOK_PRE_PHASE_GATE_ENABLED" != "true" ]] && return 0

    case "${from_phase}:${to_phase}" in
        understand:guardrail)
            # Require: docs directory exists, features.json exists with >0 features
            [[ ! -d "${migration_dir}/docs" ]] && echo "GATE_BLOCKED: No docs/ directory" && return 1
            local feat_count
            feat_count=$(python3 -c "
import json, sys
try:
    with open('${migration_dir}/features.json') as f:
        data = json.load(f)
    features = data.get('features', data) if isinstance(data, dict) else data
    print(len(features) if isinstance(features, list) else 0)
except: print(0)
" 2>/dev/null || echo 0)
            [[ "$feat_count" -eq 0 ]] && echo "GATE_BLOCKED: features.json has 0 features" && return 1
            ;;
        guardrail:migrate)
            # Require: ALL characterization tests pass
            local test_cmd
            test_cmd=$(detect_test_command "${LOKI_CODEBASE_PATH:-.}")
            if ! eval "$test_cmd" >/dev/null 2>&1; then
                echo "GATE_BLOCKED: Characterization tests do not pass"
                return 1
            fi
            ;;
        migrate:verify)
            # Require: all steps completed in migration plan
            local pending
            pending=$(python3 -c "
import json
try:
    with open('${migration_dir}/migration-plan.json') as f:
        plan = json.load(f)
    steps = plan.get('steps', [])
    print(len([s for s in steps if s.get('status') != 'completed']))
except: print(-1)
" 2>/dev/null || echo -1)
            [[ "$pending" -ne 0 ]] && echo "GATE_BLOCKED: ${pending} steps still pending (or plan missing)" && return 1
            ;;
    esac

    return 0
}

# Hook: on_agent_stop - prevents premature victory declaration
hook_on_agent_stop() {
    local features_path="${LOKI_FEATURES_PATH:-}"

    [[ "$HOOK_ON_AGENT_STOP_ENABLED" != "true" ]] && return 0
    if [[ -z "$features_path" ]]; then
        echo "HOOK_BLOCKED: LOKI_FEATURES_PATH not set. Cannot verify features."
        return 1
    fi
    [[ ! -f "$features_path" ]] && return 0

    local failing
    failing=$(python3 -c "
import json
try:
    with open('${features_path}') as f:
        data = json.load(f)
    features = data.get('features', data) if isinstance(data, dict) else data
    if isinstance(features, list):
        print(len([f for f in features if not f.get('passes', False)]))
    else: print(0)
except: print(0)
" 2>/dev/null || echo 0)

    if [[ "$failing" -gt 0 ]]; then
        echo "HOOK_BLOCKED: ${failing} features still failing. Cannot declare migration complete."
        return 1
    fi

    return 0
}

#===============================================================================
# Healing-Specific Hooks (v6.67.0)
# Inspired by Amazon AGI Lab's legacy system healing approach.
# These hooks enforce behavioral preservation during healing operations.
#===============================================================================

# Hook: pre_healing_modify - runs BEFORE agent modifies any file in healing mode
# Checks friction map to prevent removal of undocumented business rules
hook_pre_healing_modify() {
    local file_path="${1:-}"
    local codebase_path="${LOKI_CODEBASE_PATH:-.}"
    local heal_dir="${codebase_path}/.loki/healing"
    local strict="${LOKI_HEAL_STRICT:-false}"

    # Only enforce in healing mode
    [[ "${LOKI_HEAL_MODE:-false}" != "true" ]] && return 0
    [[ -z "$file_path" ]] && return 0

    # Fail CLOSED if the friction map is absent. Without it the friction safety
    # gate below cannot run, so deleting (or never producing) friction-map.json
    # would otherwise BYPASS protection and let unclassified institutional
    # knowledge be destroyed -- and _heal_snapshot_save would still run, masking
    # the gap. The map is produced by the archaeology phase (the phase gate
    # blocks archaeology -> stabilize until friction-map.json has >=1 entry), so
    # any modify in stabilize/isolate/modernize legitimately has one. Block
    # before any friction check or snapshot proceeds.
    if [[ ! -f "$heal_dir/friction-map.json" ]]; then
        echo "HOOK_BLOCKED: friction-map.json missing at ${heal_dir}/friction-map.json. Run the archaeology phase first (loki heal <path> --phase archaeology) to catalog friction before modifying files in healing mode."
        return 1
    fi

    # Check if file has friction points
    if [[ -f "$heal_dir/friction-map.json" ]]; then
        local blocked
        blocked=$(python3 -c "
import json, os, sys
file_path = sys.argv[1]
strict = sys.argv[2] == 'true'
with open(sys.argv[3]) as f:
    data = json.load(f)

# Path-aware match (not raw substring 'in', which over-matched app.py against
# myapp.py and under-matched src/foo.py against a foo.py:10 location). Friction
# locations are formatted 'path:line' (or just 'path'); strip a trailing
# ':<line>' then compare by basename and normalized path so the same file is
# matched regardless of how it was referenced.
def norm(p):
    # Drop a trailing ':<line>' (and optional ':<col>') suffix from a location.
    parts = p.rsplit(':', 1)
    while len(parts) == 2 and parts[1].isdigit():
        p = parts[0]
        parts = p.rsplit(':', 1)
    return p

def matches(target, loc):
    loc = norm(loc)
    if not target or not loc:
        return False
    # Exact normalized-path match, or same basename. Basename equality is the
    # path-aware replacement for substring containment.
    if os.path.normpath(target) == os.path.normpath(loc):
        return True
    return os.path.basename(target) == os.path.basename(loc)

for friction in data.get('frictions', []):
    loc = friction.get('location', '')
    if matches(file_path, loc):
        cls = friction.get('classification', 'unknown')
        safe = friction.get('safe_to_remove', False)
        if cls in ('business_rule', 'unknown') and not safe:
            print(f'BLOCKED: Friction {friction.get(\"id\", \"?\")} in {loc} classified as {cls}')
            sys.exit(0)
        if strict and cls != 'true_bug':
            print(f'BLOCKED (strict): Friction {friction.get(\"id\", \"?\")} in {loc} - strict mode requires explicit approval')
            sys.exit(0)
print('OK')
" "$file_path" "$strict" "$heal_dir/friction-map.json" 2>/dev/null || echo "BLOCKED: friction-map check failed (corrupt/unreadable friction-map.json or python3 unavailable) -- failing closed")

        if [[ "$blocked" == BLOCKED* ]]; then
            echo "HOOK_BLOCKED: $blocked"
            echo "To proceed: Update friction-map.json to classify this friction or set safe_to_remove=true"
            return 1
        fi
    fi

    # Capture a pre-edit snapshot so post_healing_modify can revert ONLY the
    # healing edit on test failure (not unrelated uncommitted changes, and not
    # via git checkout which discards everything). Keyed by file path.
    #
    # Enforce the pairing contract: if the snapshot cannot be captured, BLOCK the
    # edit. Proceeding would leave the edit with no revert path -- a later test
    # failure would then leave the broken edit in place while honestly reporting
    # "no snapshot" (silent revert failure). Fail loud/closed here instead.
    if ! _heal_snapshot_save "$heal_dir" "$file_path"; then
        echo "HOOK_BLOCKED: could not capture a pre-edit snapshot for ${file_path}; refusing to modify it without a revert path. Check that ${heal_dir}/snapshots is writable."
        return 1
    fi

    return 0
}

# Snapshot path helper: maps a target file path to its snapshot blob location.
# Uses a flat directory with the path's basename plus a hash of the full path
# to avoid collisions between same-named files in different directories.
_heal_snapshot_path() {
    local heal_dir="$1"
    local file_path="$2"
    local key
    key=$(printf '%s' "$file_path" | cksum | awk '{print $1"-"$2}')
    printf '%s/snapshots/%s.%s' "$heal_dir" "$(basename "$file_path")" "$key"
}

# Save a pre-edit snapshot of file_path. If the file does not exist yet (the
# healing edit will CREATE it), write a sentinel marker instead so the revert
# path knows to remove the file rather than restore content.
#
# Pairing contract (ENFORCED, fail-closed): hook_pre_healing_modify (which calls
# this) MUST run for a file before hook_post_healing_modify reverts it, AND that
# pre call MUST leave behind a revertable snapshot. The snapshot is refreshed on
# every pre call, so a post without a matching fresh pre could restore a stale
# blob. On the success path the snapshot is intentionally left in place; the
# next pre overwrites it.
#
# Returns 0 ONLY when a revertable snapshot demonstrably exists on disk after
# this call: exactly one of {content snapshot, ".absent" marker}. Returns 1 on
# ANY failure (cannot create the snapshot dir, cp/sentinel write failed, the
# wrong marker survived, or both/neither markers exist). A 1 return MUST block
# the edit at the caller -- otherwise the edit proceeds with no revert path and a
# later test failure leaves the broken edit in place (the silent-revert-failure
# this guard exists to prevent). NEVER return 0 on a failure path.
_heal_snapshot_save() {
    local heal_dir="$1"
    local file_path="$2"
    # Empty file_path: nothing to snapshot. Callers treat empty file_path as a
    # no-op (return 0 before reaching here in the hooks); not a contract breach.
    [[ -z "$file_path" ]] && return 0
    local snap_dir="$heal_dir/snapshots"
    if ! mkdir -p "$snap_dir" 2>/dev/null || [[ ! -d "$snap_dir" ]]; then
        return 1
    fi
    local snap
    snap=$(_heal_snapshot_path "$heal_dir" "$file_path")
    if [[ -f "$file_path" ]]; then
        # Capture content, then drop any stale absent-marker so EXACTLY the
        # content snapshot survives. Fail closed if either step fails.
        if ! cp "$file_path" "$snap" 2>/dev/null; then
            return 1
        fi
        if ! rm -f "$snap.absent" 2>/dev/null; then
            return 1
        fi
        # Verify exactly the content snapshot exists and the absent-marker is
        # gone. A lingering marker is a contract violation (restore checks the
        # content snapshot first, but the inconsistency must not be tolerated).
        if [[ ! -f "$snap" || -f "$snap.absent" ]]; then
            return 1
        fi
    else
        # File does not exist pre-edit: record an "absent" marker, drop any
        # stale content snapshot. CRITICAL: if the stale content snapshot is not
        # removed, restore checks the content snapshot FIRST and would restore
        # content for a file that should have been REMOVED. Fail closed if the
        # stale snapshot cannot be cleared or the marker cannot be written.
        if ! rm -f "$snap" 2>/dev/null; then
            return 1
        fi
        if ! : > "$snap.absent" 2>/dev/null; then
            return 1
        fi
        # Verify exactly the absent-marker exists and no content snapshot does.
        if [[ ! -f "$snap.absent" || -f "$snap" ]]; then
            return 1
        fi
    fi
    return 0
}

# Restore file_path from its pre-edit snapshot, reverting ONLY the healing edit.
# Echoes an accurate human-readable message describing what actually happened
# (content restored / healing-added file removed / could not revert). Returns 0
# when the revert succeeded as reported, 1 when it could not be performed.
_heal_snapshot_restore() {
    local heal_dir="$1"
    local file_path="$2"
    if [[ -z "$file_path" ]]; then
        echo "No file path given; nothing reverted."
        return 1
    fi
    local snap
    snap=$(_heal_snapshot_path "$heal_dir" "$file_path")

    if [[ -f "$snap" ]]; then
        # Pre-edit content snapshot exists: restore exactly that content, which
        # preserves any unrelated uncommitted changes present before the edit.
        if cp "$snap" "$file_path" 2>/dev/null; then
            echo "Edit reverted to pre-edit snapshot."
            return 0
        fi
        echo "Could not restore pre-edit snapshot for ${file_path}; file left as-is."
        return 1
    fi

    if [[ -f "$snap.absent" ]]; then
        # File did not exist pre-edit: the edit created it. Remove only that
        # file, not unrelated state.
        if [[ ! -e "$file_path" ]]; then
            echo "Added file ${file_path} no longer present; nothing to remove."
            return 0
        fi
        if rm -f "$file_path" 2>/dev/null; then
            echo "Added file ${file_path} removed."
            return 0
        fi
        echo "Could not remove added file ${file_path}; file left as-is."
        return 1
    fi

    # No snapshot was captured (pre_healing_modify did not run for this file).
    # Be honest: do not claim a revert that did not happen, and do NOT fall back
    # to a destructive git checkout.
    echo "No pre-edit snapshot found for ${file_path}; could not revert (left as-is)."
    return 1
}

# Hook: post_healing_modify - runs AFTER agent modifies a file in healing mode
# Verifies characterization tests still pass after modification
hook_post_healing_modify() {
    local file_path="${1:-}"
    local codebase_path="${LOKI_CODEBASE_PATH:-.}"
    local heal_dir="${codebase_path}/.loki/healing"

    [[ "${LOKI_HEAL_MODE:-false}" != "true" ]] && return 0

    # Log the modification
    if [[ -d "$heal_dir" ]]; then
        local log_entry
        log_entry="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"healing_modify\",\"file\":\"${file_path}\",\"agent\":\"${LOKI_AGENT_ID:-unknown}\",\"phase\":\"${LOKI_HEAL_PHASE:-unknown}\"}"
        echo "$log_entry" >> "$heal_dir/activity.jsonl" 2>/dev/null || true
    fi

    # Run characterization tests
    local test_cmd
    test_cmd=$(detect_test_command "$codebase_path")

    # No test command available in healing mode -> fail closed. "No tests" can
    # never count as "characterization tests passed". Do not git-revert here:
    # there is no test-driven baseline to restore against, and the actionable
    # fix is to provide a test command.
    if is_no_test_cmd "$test_cmd"; then
        echo "HOOK_BLOCKED: no test command available; set LOKI_TEST_COMMAND"
        echo "Characterization tests cannot run for healing modification to ${file_path}; refusing to treat absence of tests as success."
        return 1
    fi

    local test_result_file
    test_result_file=$(mktemp)

    if ! eval "$test_cmd" > "$test_result_file" 2>&1; then
        local test_output
        test_output=$(cat "$test_result_file")
        rm -f "$test_result_file"

        # Revert ONLY the healing edit using the pre-edit snapshot captured by
        # hook_pre_healing_modify. Do NOT use `git checkout -- "$file_path"`:
        # that discards ALL uncommitted changes to the file (not just the
        # healing edit) and silently no-ops for an untracked file while still
        # claiming the change was reverted. Report exactly what happened.
        local revert_msg
        # _heal_snapshot_restore returns nonzero when it could not revert; we
        # surface the outcome via its message (recorded below) rather than a
        # code, and must not let a nonzero return abort under set -e.
        revert_msg=$(_heal_snapshot_restore "$heal_dir" "$file_path") || true
        echo "HOOK_BLOCKED: Characterization tests failed after healing modification to ${file_path}. ${revert_msg}"
        echo "Test output: ${test_output}"

        # Record failure in failure-modes.json
        if [[ -f "$heal_dir/failure-modes.json" ]]; then
            python3 -c "
import json, sys
from datetime import datetime
with open(sys.argv[1]) as f:
    data = json.load(f)
# setdefault (not get): get('modes', []) appended to a THROWAWAY list when
# the key was missing, so the failure mode was silently lost on a fresh
# failure-modes.json. setdefault binds the list into data before appending.
data.setdefault('modes', []).append({
    'mode_id': 'heal-fail-' + datetime.now().strftime('%Y%m%dT%H%M%S'),
    'trigger': 'healing_modification',
    'file': sys.argv[2],
    'behavior': 'Characterization tests failed after modification',
    'recovery': sys.argv[3],
    'is_intentional': False
})
with open(sys.argv[1], 'w') as f:
    json.dump(data, f, indent=2)
" "$heal_dir/failure-modes.json" "$file_path" "$revert_msg" 2>/dev/null || true
        fi

        return 1
    fi

    rm -f "$test_result_file"
    return 0
}

# Hook: healing_phase_gate - mechanical verification before healing phase transition
hook_healing_phase_gate() {
    local from_phase="${1:-}"
    local to_phase="${2:-}"
    local codebase_path="${LOKI_CODEBASE_PATH:-.}"
    local heal_dir="${codebase_path}/.loki/healing"

    [[ "${LOKI_HEAL_MODE:-false}" != "true" ]] && return 0

    # BUG-HEAL-002: Validate phase transition ordering
    # Valid healing phases in order: archaeology -> stabilize -> isolate -> modernize -> validate
    # Only forward transitions to the immediately next phase are allowed.
    local valid_phases="archaeology stabilize isolate modernize validate"
    local from_idx=-1
    local to_idx=-1
    local idx=0
    for p in $valid_phases; do
        [[ "$p" == "$from_phase" ]] && from_idx=$idx
        [[ "$p" == "$to_phase" ]] && to_idx=$idx
        idx=$((idx + 1))
    done

    if [[ "$from_idx" -eq -1 ]]; then
        echo "GATE_BLOCKED: Unknown source phase: ${from_phase}" && return 1
    fi
    if [[ "$to_idx" -eq -1 ]]; then
        echo "GATE_BLOCKED: Unknown target phase: ${to_phase}" && return 1
    fi
    if [[ "$to_idx" -le "$from_idx" ]]; then
        echo "GATE_BLOCKED: Cannot transition backwards from ${from_phase} to ${to_phase}" && return 1
    fi
    if [[ "$to_idx" -gt $((from_idx + 1)) ]]; then
        echo "GATE_BLOCKED: Cannot skip phases -- must transition from ${from_phase} to the next sequential phase" && return 1
    fi

    case "${from_phase}:${to_phase}" in
        archaeology:stabilize)
            # Require: friction map has entries, characterization tests pass
            local friction_count
            friction_count=$(HEAL_DIR="$heal_dir" python3 -c "
import json, os
try:
    with open(os.path.join(os.environ['HEAL_DIR'], 'friction-map.json')) as f:
        print(len(json.load(f).get('frictions', [])))
except: print(0)
" 2>/dev/null || echo 0)
            [[ "$friction_count" -eq 0 ]] && echo "GATE_BLOCKED: friction-map.json has 0 entries. Run archaeology first." && return 1

            [[ ! -f "$heal_dir/institutional-knowledge.md" ]] && echo "GATE_BLOCKED: institutional-knowledge.md not found" && return 1

            local test_cmd
            test_cmd=$(detect_test_command "$codebase_path")
            if is_no_test_cmd "$test_cmd"; then
                echo "GATE_BLOCKED: no test command available; set LOKI_TEST_COMMAND"
                return 1
            fi
            if ! eval "$test_cmd" >/dev/null 2>&1; then
                echo "GATE_BLOCKED: Characterization tests do not pass"
                return 1
            fi
            ;;
        stabilize:isolate)
            local test_cmd
            test_cmd=$(detect_test_command "$codebase_path")
            if is_no_test_cmd "$test_cmd"; then
                echo "GATE_BLOCKED: no test command available; set LOKI_TEST_COMMAND"
                return 1
            fi
            if ! eval "$test_cmd" >/dev/null 2>&1; then
                echo "GATE_BLOCKED: Tests do not pass after stabilization"
                return 1
            fi
            ;;
        isolate:modernize)
            local test_cmd
            test_cmd=$(detect_test_command "$codebase_path")
            if is_no_test_cmd "$test_cmd"; then
                echo "GATE_BLOCKED: no test command available; set LOKI_TEST_COMMAND"
                return 1
            fi
            if ! eval "$test_cmd" >/dev/null 2>&1; then
                echo "GATE_BLOCKED: Tests do not pass after isolation"
                return 1
            fi
            ;;
        modernize:validate)
            local test_cmd
            test_cmd=$(detect_test_command "$codebase_path")
            if is_no_test_cmd "$test_cmd"; then
                echo "GATE_BLOCKED: no test command available; set LOKI_TEST_COMMAND"
                return 1
            fi
            if ! eval "$test_cmd" >/dev/null 2>&1; then
                echo "GATE_BLOCKED: Tests do not pass after modernization"
                return 1
            fi
            ;;
    esac

    return 0
}
