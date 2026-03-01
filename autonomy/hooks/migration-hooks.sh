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

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load project-specific hook config if it exists
load_migration_hook_config() {
    local codebase_path="${1:-.}"
    local config_file="${codebase_path}/.loki/migration-hooks.yaml"

    # Defaults
    HOOK_POST_FILE_EDIT_ENABLED=true
    HOOK_POST_STEP_ENABLED=true
    HOOK_PRE_PHASE_GATE_ENABLED=true
    HOOK_ON_AGENT_STOP_ENABLED=true
    HOOK_POST_FILE_EDIT_ACTION="run_tests"
    HOOK_POST_FILE_EDIT_ON_FAILURE="block_and_rollback"
    HOOK_POST_STEP_ON_FAILURE="reject_completion"
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
