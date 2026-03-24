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
        echo "echo 'No test command detected. Set LOKI_TEST_COMMAND.'"
    fi
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
                # Revert the file change
                git -C "$codebase_path" checkout -- "$file_path" 2>/dev/null || true
                echo "HOOK_BLOCKED: Tests failed after editing ${file_path}. Change reverted."
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

    # Check if file has friction points
    if [[ -f "$heal_dir/friction-map.json" ]]; then
        local blocked
        blocked=$(python3 -c "
import json, sys
file_path = sys.argv[1]
strict = sys.argv[2] == 'true'
with open(sys.argv[3]) as f:
    data = json.load(f)
for friction in data.get('frictions', []):
    loc = friction.get('location', '')
    if file_path in loc:
        cls = friction.get('classification', 'unknown')
        safe = friction.get('safe_to_remove', False)
        if cls in ('business_rule', 'unknown') and not safe:
            print(f'BLOCKED: Friction {friction.get(\"id\", \"?\")} in {loc} classified as {cls}')
            sys.exit(0)
        if strict and cls != 'true_bug':
            print(f'BLOCKED (strict): Friction {friction.get(\"id\", \"?\")} in {loc} - strict mode requires explicit approval')
            sys.exit(0)
print('OK')
" "$file_path" "$strict" "$heal_dir/friction-map.json" 2>/dev/null || echo "OK")

        if [[ "$blocked" == BLOCKED* ]]; then
            echo "HOOK_BLOCKED: $blocked"
            echo "To proceed: Update friction-map.json to classify this friction or set safe_to_remove=true"
            return 1
        fi
    fi

    return 0
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
    local test_result_file
    test_result_file=$(mktemp)

    if ! eval "$test_cmd" > "$test_result_file" 2>&1; then
        local test_output
        test_output=$(cat "$test_result_file")
        rm -f "$test_result_file"

        # Revert the change - characterization tests must pass
        git -C "$codebase_path" checkout -- "$file_path" 2>/dev/null || true
        echo "HOOK_BLOCKED: Characterization tests failed after healing modification to ${file_path}. Change reverted."
        echo "Test output: ${test_output}"

        # Record failure in failure-modes.json
        if [[ -f "$heal_dir/failure-modes.json" ]]; then
            python3 -c "
import json, sys
from datetime import datetime
with open(sys.argv[1]) as f:
    data = json.load(f)
data.get('modes', []).append({
    'mode_id': 'heal-fail-' + datetime.now().strftime('%Y%m%dT%H%M%S'),
    'trigger': 'healing_modification',
    'file': sys.argv[2],
    'behavior': 'Characterization tests failed after modification',
    'recovery': 'Change automatically reverted',
    'is_intentional': False
})
with open(sys.argv[1], 'w') as f:
    json.dump(data, f, indent=2)
" "$heal_dir/failure-modes.json" "$file_path" 2>/dev/null || true
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
            if ! eval "$test_cmd" >/dev/null 2>&1; then
                echo "GATE_BLOCKED: Characterization tests do not pass"
                return 1
            fi
            ;;
        stabilize:isolate)
            local test_cmd
            test_cmd=$(detect_test_command "$codebase_path")
            if ! eval "$test_cmd" >/dev/null 2>&1; then
                echo "GATE_BLOCKED: Tests do not pass after stabilization"
                return 1
            fi
            ;;
        isolate:modernize)
            local test_cmd
            test_cmd=$(detect_test_command "$codebase_path")
            if ! eval "$test_cmd" >/dev/null 2>&1; then
                echo "GATE_BLOCKED: Tests do not pass after isolation"
                return 1
            fi
            ;;
        modernize:validate)
            local test_cmd
            test_cmd=$(detect_test_command "$codebase_path")
            if ! eval "$test_cmd" >/dev/null 2>&1; then
                echo "GATE_BLOCKED: Tests do not pass after modernization"
                return 1
            fi
            ;;
    esac

    return 0
}
