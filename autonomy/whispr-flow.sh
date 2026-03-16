#!/usr/bin/env bash
# Whispr Flow - Voice-Driven Development Flow Controller for Loki Mode (v1.0.0)
#
# Bridges the gap between voice-driven "vibe coding" (Wispr Flow style) and
# Loki Mode's autonomous execution engine. While BMAD handles pre-development
# artifact pipelines, Whispr Flow enables continuous voice-driven interaction
# DURING autonomous execution.
#
# Capabilities:
#   - Voice-to-directive injection (speak commands into autonomous runs)
#   - Context-aware command routing (voice -> task queue / phase / priority)
#   - Real-time TTS narration of execution progress
#   - Flow session management (persistent voice interaction state)
#   - Integration with existing voice.sh transcription backends
#
# Usage:
#   ./autonomy/whispr-flow.sh start [--narrate] [--listen-interval SECS]
#   ./autonomy/whispr-flow.sh stop
#   ./autonomy/whispr-flow.sh status
#   ./autonomy/whispr-flow.sh inject "focus on authentication"
#   ./autonomy/whispr-flow.sh narrate "Phase transition: DEVELOPMENT -> QA"
#   ./autonomy/whispr-flow.sh parse "skip deployment phase"
#
# Requires: voice.sh (transcription backend), .loki/ directory

set -euo pipefail

LOKI_DIR="${LOKI_DIR:-.loki}"
WHISPR_DIR="${LOKI_DIR}/whispr"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOICE_SCRIPT="${SCRIPT_DIR}/voice.sh"

# Colors (only if terminal supports them)
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' NC=''
fi

log() { echo -e "${CYAN}[whispr-flow]${NC} $*"; }
log_success() { echo -e "${GREEN}[whispr-flow]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[whispr-flow]${NC} $*"; }
log_error() { echo -e "${RED}[whispr-flow]${NC} $*" >&2; }

# -------------------------------------------------------------------
# Session Management
# -------------------------------------------------------------------

ensure_whispr_dir() {
    mkdir -p "$WHISPR_DIR"
}

# Create or update session file
init_session() {
    ensure_whispr_dir
    local narrate="${1:-false}"
    local listen_interval="${2:-30}"

    cat > "$WHISPR_DIR/session.json" <<EOF
{
    "status": "active",
    "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "narrate": $narrate,
    "listenInterval": $listen_interval,
    "commandCount": 0,
    "lastActivity": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "pid": $$
}
EOF
    log_success "Session initialized (narrate=$narrate, interval=${listen_interval}s)"
}

# Check if a session is active
is_session_active() {
    if [[ -f "$WHISPR_DIR/session.json" ]]; then
        local status
        status=$(python3 -c "
import json
try:
    with open('$WHISPR_DIR/session.json') as f:
        print(json.load(f).get('status', 'inactive'))
except:
    print('inactive')
" 2>/dev/null)
        [[ "$status" == "active" ]]
    else
        return 1
    fi
}

# End the session
end_session() {
    if [[ -f "$WHISPR_DIR/session.json" ]]; then
        python3 -c "
import json
try:
    with open('$WHISPR_DIR/session.json', 'r') as f:
        data = json.load(f)
    data['status'] = 'stopped'
    data['stoppedAt'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
    with open('$WHISPR_DIR/session.json', 'w') as f:
        json.dump(data, f, indent=2)
except Exception as e:
    print(f'Warning: {e}')
" 2>/dev/null
        log_success "Session ended"
    else
        log_warn "No active session found"
    fi
}

# -------------------------------------------------------------------
# Command Parsing - Voice Input to Loki Actions
# -------------------------------------------------------------------

# Parse natural language voice input into structured Loki commands
# Returns JSON: {"action": "...", "target": "...", "params": {...}}
parse_voice_command() {
    local input="$1"

    python3 <<PYEOF
import json
import re
import sys

text = """$input""".strip().lower()

result = {"action": "unknown", "target": "", "params": {}, "raw": text}

# Phase control commands
phase_patterns = {
    r'\b(skip|bypass)\b.*\b(deploy|deployment)\b': {"action": "skip_phase", "target": "DEPLOYMENT"},
    r'\b(skip|bypass)\b.*\b(qa|test|testing)\b': {"action": "skip_phase", "target": "QA"},
    r'\b(skip|bypass)\b.*\b(growth)\b': {"action": "skip_phase", "target": "GROWTH"},
    r'\b(move|advance|go)\b.*\b(to|into)\b.*\b(development|dev)\b': {"action": "advance_phase", "target": "DEVELOPMENT"},
    r'\b(move|advance|go)\b.*\b(to|into)\b.*\b(qa|testing)\b': {"action": "advance_phase", "target": "QA"},
    r'\b(move|advance|go)\b.*\b(to|into)\b.*\b(deploy|deployment)\b': {"action": "advance_phase", "target": "DEPLOYMENT"},
}

# Execution control
control_patterns = {
    r'\b(pause|wait|hold)\b': {"action": "pause"},
    r'\b(resume|continue|unpause|go)\b': {"action": "resume"},
    r'\b(stop|abort|cancel|quit|end)\b': {"action": "stop"},
    r'\b(restart|reset)\b': {"action": "restart"},
}

# Focus/priority commands
focus_patterns = {
    r'\b(focus|prioritize|work)\b.*\bon\b\s+(.+)': "focus",
    r'\b(deprioritize|lower|defer)\b\s+(.+)': "deprioritize",
}

# Status/info commands
info_patterns = {
    r'\b(status|progress|where|how)\b': {"action": "status"},
    r'\b(show|list|what)\b.*\b(tasks?|queue|pending)\b': {"action": "list_tasks"},
    r'\b(show|list|what)\b.*\b(errors?|failures?|bugs?)\b': {"action": "list_errors"},
    r'\b(show|list)\b.*\b(phase|stage)\b': {"action": "show_phase"},
}

# Review commands
review_patterns = {
    r'\b(review|check|inspect)\b.*\b(code|changes?|diff)\b': {"action": "review_code"},
    r'\b(approve|lgtm|looks good)\b': {"action": "approve"},
    r'\b(reject|deny|nope)\b': {"action": "reject"},
}

# Task injection
inject_patterns = {
    r'\b(add|create|new)\b.*\b(task|ticket|story)\b[:\s]+(.+)': "add_task",
    r'\b(fix|handle|address)\b\s+(.+)': "inject_fix",
    r'\b(implement|build|create|add)\b\s+(.+)': "inject_implement",
}

matched = False

# Try phase patterns
for pattern, value in phase_patterns.items():
    if re.search(pattern, text):
        result.update(value)
        matched = True
        break

# Try control patterns
if not matched:
    for pattern, value in control_patterns.items():
        if re.search(pattern, text):
            result.update(value)
            matched = True
            break

# Try focus patterns
if not matched:
    for pattern, action in focus_patterns.items():
        m = re.search(pattern, text)
        if m:
            target = m.group(m.lastindex).strip()
            result["action"] = action
            result["target"] = target
            matched = True
            break

# Try info patterns
if not matched:
    for pattern, value in info_patterns.items():
        if re.search(pattern, text):
            result.update(value)
            matched = True
            break

# Try review patterns
if not matched:
    for pattern, value in review_patterns.items():
        if re.search(pattern, text):
            result.update(value)
            matched = True
            break

# Try inject patterns
if not matched:
    for pattern, action in inject_patterns.items():
        m = re.search(pattern, text)
        if m:
            target = m.group(m.lastindex).strip()
            result["action"] = action
            result["target"] = target
            matched = True
            break

# Fallback: treat as a general directive
if not matched:
    result["action"] = "directive"
    result["target"] = text

print(json.dumps(result, indent=2))
PYEOF
}

# -------------------------------------------------------------------
# Command Execution - Route Parsed Commands to Loki Actions
# -------------------------------------------------------------------

execute_command() {
    local parsed_json="$1"

    local action target
    action=$(echo "$parsed_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('action','unknown'))")
    target=$(echo "$parsed_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('target',''))")

    case "$action" in
        pause)
            touch "$LOKI_DIR/PAUSE"
            log_success "Paused autonomous execution"
            narrate_if_enabled "Execution paused. Say resume to continue."
            ;;
        resume)
            rm -f "$LOKI_DIR/PAUSE"
            log_success "Resumed autonomous execution"
            narrate_if_enabled "Execution resumed."
            ;;
        stop)
            touch "$LOKI_DIR/STOP"
            log_success "Stopping autonomous execution"
            narrate_if_enabled "Execution stopping."
            ;;
        restart)
            rm -f "$LOKI_DIR/PAUSE" "$LOKI_DIR/STOP"
            log_success "Cleared pause/stop signals"
            narrate_if_enabled "Signals cleared. Execution will continue."
            ;;
        status)
            show_execution_status
            ;;
        list_tasks)
            show_pending_tasks
            ;;
        list_errors)
            show_recent_errors
            ;;
        show_phase)
            show_current_phase
            ;;
        focus)
            inject_focus_directive "$target"
            ;;
        deprioritize)
            inject_deprioritize "$target"
            ;;
        skip_phase)
            log_warn "Phase skip requested: $target"
            inject_directive "WHISPR FLOW DIRECTIVE: Skip the $target phase. Advance to the next phase after current tasks complete."
            narrate_if_enabled "Skipping $target phase as requested."
            ;;
        advance_phase)
            inject_directive "WHISPR FLOW DIRECTIVE: Advance to $target phase. Complete current task and transition."
            narrate_if_enabled "Advancing to $target phase."
            ;;
        review_code)
            inject_directive "WHISPR FLOW DIRECTIVE: Run code review on all uncommitted changes now."
            narrate_if_enabled "Triggering code review."
            ;;
        approve)
            inject_directive "WHISPR FLOW DIRECTIVE: Current review approved. Proceed with merge and next task."
            narrate_if_enabled "Approved. Moving forward."
            ;;
        reject)
            inject_directive "WHISPR FLOW DIRECTIVE: Current changes rejected. Revert last change and try alternative approach."
            narrate_if_enabled "Rejected. Reverting and retrying."
            ;;
        add_task)
            add_task_to_queue "$target"
            ;;
        inject_fix)
            inject_directive "WHISPR FLOW DIRECTIVE: Fix the following issue: $target"
            narrate_if_enabled "Fix directive injected for: $target"
            ;;
        inject_implement)
            inject_directive "WHISPR FLOW DIRECTIVE: Implement the following: $target"
            narrate_if_enabled "Implementation directive injected: $target"
            ;;
        directive)
            inject_directive "WHISPR FLOW DIRECTIVE: $target"
            narrate_if_enabled "Directive injected."
            ;;
        unknown)
            log_warn "Could not parse command. Injecting as raw directive."
            local raw
            raw=$(echo "$parsed_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('raw',''))")
            inject_directive "WHISPR FLOW (unparsed voice input): $raw"
            ;;
    esac

    # Log to command history
    log_command "$parsed_json"
}

# -------------------------------------------------------------------
# Directive Injection
# -------------------------------------------------------------------

inject_directive() {
    local directive="$1"
    ensure_whispr_dir

    # Write to whispr directive file (consumed by run.sh)
    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "[$timestamp] $directive" >> "$WHISPR_DIR/directives.log"

    # Write current directive for prompt injection
    echo "$directive" > "$WHISPR_DIR/current-directive.md"

    # Also write to HUMAN_INPUT.md if prompt injection is enabled
    if [[ "${LOKI_PROMPT_INJECTION:-false}" == "true" ]]; then
        echo "$directive" > "$LOKI_DIR/HUMAN_INPUT.md"
    fi

    log_success "Directive injected: $(echo "$directive" | head -c 80)..."
}

inject_focus_directive() {
    local target="$1"
    inject_directive "WHISPR FLOW DIRECTIVE: Focus on '$target'. Reprioritize the task queue to work on tasks related to '$target' first. Deprioritize unrelated tasks."
    narrate_if_enabled "Focusing on $target"
}

inject_deprioritize() {
    local target="$1"
    inject_directive "WHISPR FLOW DIRECTIVE: Deprioritize '$target'. Move tasks related to '$target' to the bottom of the queue. Focus on other pending tasks first."
    narrate_if_enabled "Deprioritizing $target"
}

# -------------------------------------------------------------------
# Task Queue Integration
# -------------------------------------------------------------------

add_task_to_queue() {
    local description="$1"
    ensure_whispr_dir

    python3 <<PYEOF
import json
import os
from datetime import datetime

queue_file = "$LOKI_DIR/queue/pending.json"
tasks = []
if os.path.exists(queue_file):
    try:
        with open(queue_file) as f:
            tasks = json.load(f)
    except:
        tasks = []

new_task = {
    "id": f"whispr-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
    "description": """$description""",
    "priority": "high",
    "source": "whispr-flow",
    "createdAt": datetime.utcnow().isoformat() + "Z",
    "status": "pending"
}

tasks.insert(0, new_task)  # High priority = front of queue

os.makedirs(os.path.dirname(queue_file), exist_ok=True)
with open(queue_file, "w") as f:
    json.dump(tasks, f, indent=2)

print(f"Task added: {new_task['id']}")
PYEOF

    log_success "Task added to queue: $description"
    narrate_if_enabled "New task added: $description"
}

# -------------------------------------------------------------------
# Status & Information
# -------------------------------------------------------------------

show_execution_status() {
    local status_msg=""

    # Read orchestrator state
    if [[ -f "$LOKI_DIR/state/orchestrator.json" ]]; then
        status_msg=$(python3 -c "
import json
try:
    with open('$LOKI_DIR/state/orchestrator.json') as f:
        data = json.load(f)
    phase = data.get('currentPhase', 'unknown')
    completed = data.get('tasksCompleted', 0)
    failed = data.get('tasksFailed', 0)
    iteration = data.get('iteration', 0)
    print(f'Phase: {phase} | Completed: {completed} | Failed: {failed} | Iteration: {iteration}')
except:
    print('Status unavailable')
" 2>/dev/null)
    else
        status_msg="No orchestrator state found (not running?)"
    fi

    echo -e "${BOLD}Execution Status:${NC} $status_msg"

    # Check for pause/stop signals
    if [[ -f "$LOKI_DIR/PAUSE" ]]; then
        echo -e "${YELLOW}  PAUSED${NC}"
    fi
    if [[ -f "$LOKI_DIR/STOP" ]]; then
        echo -e "${RED}  STOPPING${NC}"
    fi

    narrate_if_enabled "$status_msg"
}

show_current_phase() {
    if [[ -f "$LOKI_DIR/state/orchestrator.json" ]]; then
        local phase
        phase=$(python3 -c "
import json
try:
    with open('$LOKI_DIR/state/orchestrator.json') as f:
        print(json.load(f).get('currentPhase', 'unknown'))
except:
    print('unknown')
" 2>/dev/null)
        echo -e "${BOLD}Current Phase:${NC} $phase"
        narrate_if_enabled "Current phase is $phase"
    else
        echo "Phase information unavailable"
    fi
}

show_pending_tasks() {
    if [[ -f "$LOKI_DIR/queue/pending.json" ]]; then
        python3 -c "
import json
try:
    with open('$LOKI_DIR/queue/pending.json') as f:
        tasks = json.load(f)
    pending = [t for t in tasks if t.get('status') == 'pending']
    if pending:
        print(f'Pending tasks ({len(pending)}):')
        for i, t in enumerate(pending[:10], 1):
            desc = t.get('description', 'No description')[:80]
            src = t.get('source', 'unknown')
            print(f'  {i}. [{src}] {desc}')
        if len(pending) > 10:
            print(f'  ... and {len(pending) - 10} more')
    else:
        print('No pending tasks')
except:
    print('Could not read task queue')
" 2>/dev/null
    else
        echo "No task queue found"
    fi
}

show_recent_errors() {
    if [[ -f "$LOKI_DIR/queue/dead-letter.json" ]]; then
        python3 -c "
import json
try:
    with open('$LOKI_DIR/queue/dead-letter.json') as f:
        errors = json.load(f)
    if errors:
        print(f'Recent errors ({len(errors)}):')
        for e in errors[-5:]:
            desc = e.get('description', 'Unknown')[:80]
            reason = e.get('failureReason', 'Unknown')[:60]
            print(f'  - {desc}')
            print(f'    Reason: {reason}')
    else:
        print('No errors in dead-letter queue')
except:
    print('Could not read dead-letter queue')
" 2>/dev/null
    else
        echo "No dead-letter queue found"
    fi
}

# -------------------------------------------------------------------
# Narration (TTS Feedback)
# -------------------------------------------------------------------

narrate_if_enabled() {
    local message="$1"

    # Check if narration is enabled
    if [[ -f "$WHISPR_DIR/session.json" ]]; then
        local narrate
        narrate=$(python3 -c "
import json
try:
    with open('$WHISPR_DIR/session.json') as f:
        print(json.load(f).get('narrate', False))
except:
    print('False')
" 2>/dev/null)
        if [[ "$narrate" == "True" ]] || [[ "${WHISPR_NARRATE:-false}" == "true" ]]; then
            if [[ -f "$VOICE_SCRIPT" ]]; then
                "$VOICE_SCRIPT" speak "$message" 2>/dev/null &
            fi
        fi
    elif [[ "${WHISPR_NARRATE:-false}" == "true" ]]; then
        if [[ -f "$VOICE_SCRIPT" ]]; then
            "$VOICE_SCRIPT" speak "$message" 2>/dev/null &
        fi
    fi
}

# Narrate execution events (called by run.sh hooks)
narrate_event() {
    local event_type="$1"
    local details="${2:-}"

    case "$event_type" in
        phase_transition)
            narrate_if_enabled "Phase transition: $details"
            ;;
        task_complete)
            narrate_if_enabled "Task completed: $details"
            ;;
        task_failed)
            narrate_if_enabled "Task failed: $details. Check errors."
            ;;
        review_start)
            narrate_if_enabled "Code review starting."
            ;;
        review_complete)
            narrate_if_enabled "Code review complete: $details"
            ;;
        build_success)
            narrate_if_enabled "Build successful."
            ;;
        build_failure)
            narrate_if_enabled "Build failed: $details"
            ;;
        tests_pass)
            narrate_if_enabled "All tests passing."
            ;;
        tests_fail)
            narrate_if_enabled "Tests failing: $details"
            ;;
        completion)
            narrate_if_enabled "Project complete. All phases finished."
            ;;
        budget_warning)
            narrate_if_enabled "Budget warning: $details"
            ;;
    esac

    # Log event
    if [[ -d "$WHISPR_DIR" ]]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$event_type] $details" >> "$WHISPR_DIR/events.log"
    fi
}

# -------------------------------------------------------------------
# Command History
# -------------------------------------------------------------------

log_command() {
    local parsed_json="$1"
    ensure_whispr_dir

    python3 <<PYEOF
import json
import os
from datetime import datetime

history_file = "$WHISPR_DIR/command-history.json"
history = []
if os.path.exists(history_file):
    try:
        with open(history_file) as f:
            history = json.load(f)
    except:
        history = []

entry = json.loads('''$parsed_json''')
entry["timestamp"] = datetime.utcnow().isoformat() + "Z"
history.append(entry)

# Keep last 100 commands
history = history[-100:]

with open(history_file, "w") as f:
    json.dump(history, f, indent=2)

# Update session command count
session_file = "$WHISPR_DIR/session.json"
if os.path.exists(session_file):
    try:
        with open(session_file) as f:
            session = json.load(f)
        session["commandCount"] = session.get("commandCount", 0) + 1
        session["lastActivity"] = datetime.utcnow().isoformat() + "Z"
        with open(session_file, "w") as f:
            json.dump(session, f, indent=2)
    except:
        pass
PYEOF
}

# -------------------------------------------------------------------
# Continuous Listening Loop
# -------------------------------------------------------------------

listen_loop() {
    local interval="${1:-30}"

    if [[ ! -f "$VOICE_SCRIPT" ]]; then
        log_error "Voice module not found at $VOICE_SCRIPT"
        log "Install voice.sh for continuous listening support"
        exit 1
    fi

    log "Starting continuous listening (interval: ${interval}s)"
    log "Speak commands to control Loki Mode execution"
    log "Say 'stop listening' to exit the loop"

    while true; do
        if [[ -f "$LOKI_DIR/STOP" ]]; then
            log "STOP signal detected, ending listen loop"
            break
        fi

        local text
        text=$("$VOICE_SCRIPT" listen 2>/dev/null) || true

        if [[ -n "$text" ]]; then
            # Check for exit commands
            local text_lower
            text_lower=$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')
            if [[ "$text_lower" == *"stop listening"* ]] || [[ "$text_lower" == *"exit whispr"* ]]; then
                log "Exiting listen loop"
                break
            fi

            log "Heard: $text"
            local parsed
            parsed=$(parse_voice_command "$text")
            execute_command "$parsed"
        fi

        sleep "$interval"
    done
}

# -------------------------------------------------------------------
# Status Display
# -------------------------------------------------------------------

show_status() {
    echo -e "${BOLD}=== Whispr Flow Status ===${NC}"
    echo ""

    # Session status
    if is_session_active; then
        echo -e "Session: ${GREEN}ACTIVE${NC}"
        python3 -c "
import json
try:
    with open('$WHISPR_DIR/session.json') as f:
        s = json.load(f)
    print(f'  Started: {s.get(\"startedAt\", \"unknown\")}')
    print(f'  Commands: {s.get(\"commandCount\", 0)}')
    print(f'  Narration: {\"enabled\" if s.get(\"narrate\") else \"disabled\"}')
    print(f'  Last activity: {s.get(\"lastActivity\", \"unknown\")}')
except:
    print('  (could not read session details)')
" 2>/dev/null
    else
        echo -e "Session: ${YELLOW}INACTIVE${NC}"
    fi
    echo ""

    # Voice backend
    echo "Voice Backend:"
    if [[ -f "$VOICE_SCRIPT" ]]; then
        "$VOICE_SCRIPT" status 2>/dev/null | head -20
    else
        echo -e "  ${RED}voice.sh not found${NC}"
    fi
    echo ""

    # Directive state
    echo "Directives:"
    if [[ -f "$WHISPR_DIR/current-directive.md" ]]; then
        echo -e "  Current: ${CYAN}$(head -c 100 "$WHISPR_DIR/current-directive.md")${NC}"
    else
        echo "  No active directive"
    fi
    if [[ -f "$WHISPR_DIR/directives.log" ]]; then
        local count
        count=$(wc -l < "$WHISPR_DIR/directives.log" 2>/dev/null || echo 0)
        echo "  Total directives: $count"
    fi
    echo ""

    # Command history
    echo "Command History:"
    if [[ -f "$WHISPR_DIR/command-history.json" ]]; then
        python3 -c "
import json
try:
    with open('$WHISPR_DIR/command-history.json') as f:
        history = json.load(f)
    recent = history[-5:]
    for h in recent:
        action = h.get('action', 'unknown')
        target = h.get('target', '')
        ts = h.get('timestamp', '')[:19]
        suffix = f' -> {target}' if target else ''
        print(f'  [{ts}] {action}{suffix}')
except:
    print('  No history')
" 2>/dev/null
    else
        echo "  No commands yet"
    fi
}

# -------------------------------------------------------------------
# Context Generation for run.sh Prompt Injection
# -------------------------------------------------------------------

# Generate context block for injection into build_prompt()
generate_context() {
    if [[ ! -d "$WHISPR_DIR" ]]; then
        return
    fi

    python3 <<PYEOF
import json
import os

whispr_dir = "$WHISPR_DIR"
parts = []

# Current directive
directive_file = os.path.join(whispr_dir, "current-directive.md")
if os.path.exists(directive_file):
    with open(directive_file) as f:
        directive = f.read().strip()
    if directive:
        parts.append(f"ACTIVE DIRECTIVE: {directive[:2000]}")

# Recent command history (last 5)
history_file = os.path.join(whispr_dir, "command-history.json")
if os.path.exists(history_file):
    try:
        with open(history_file) as f:
            history = json.load(f)
        recent = history[-5:]
        if recent:
            cmds = []
            for h in recent:
                action = h.get("action", "unknown")
                target = h.get("target", "")
                suffix = f" -> {target}" if target else ""
                cmds.append(f"{action}{suffix}")
            parts.append("RECENT VOICE COMMANDS: " + "; ".join(cmds))
    except:
        pass

# Session info
session_file = os.path.join(whispr_dir, "session.json")
if os.path.exists(session_file):
    try:
        with open(session_file) as f:
            session = json.load(f)
        if session.get("status") == "active":
            parts.append(f"WHISPR SESSION: active, {session.get('commandCount', 0)} commands processed")
    except:
        pass

if parts:
    context = "WHISPR_FLOW_CONTEXT: Voice-driven development flow is active. " + " | ".join(parts)
    # Limit total context size
    print(context[:4000])
PYEOF
}

# -------------------------------------------------------------------
# Cleanup - Clear consumed directives after prompt injection
# -------------------------------------------------------------------

consume_directive() {
    if [[ -f "$WHISPR_DIR/current-directive.md" ]]; then
        # Archive the directive before clearing
        local directive
        directive=$(cat "$WHISPR_DIR/current-directive.md")
        if [[ -n "$directive" ]]; then
            echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [consumed] $directive" >> "$WHISPR_DIR/directives.log"
        fi
        rm -f "$WHISPR_DIR/current-directive.md"
    fi
}

# -------------------------------------------------------------------
# CLI Entry Point
# -------------------------------------------------------------------

main() {
    local command="${1:-help}"
    shift || true

    case "$command" in
        start)
            local narrate=false
            local interval=30

            while [[ $# -gt 0 ]]; do
                case "$1" in
                    --narrate) narrate=true; shift ;;
                    --listen-interval)
                        interval="${2:-30}"; shift 2 ;;
                    --listen-interval=*)
                        interval="${1#*=}"; shift ;;
                    *) shift ;;
                esac
            done

            init_session "$narrate" "$interval"
            listen_loop "$interval"
            ;;

        stop)
            end_session
            ;;

        status)
            show_status
            ;;

        inject)
            if [[ $# -eq 0 ]]; then
                log_error "Usage: whispr-flow.sh inject \"your command here\""
                exit 1
            fi
            local parsed
            parsed=$(parse_voice_command "$*")
            execute_command "$parsed"
            ;;

        parse)
            if [[ $# -eq 0 ]]; then
                log_error "Usage: whispr-flow.sh parse \"your voice input\""
                exit 1
            fi
            parse_voice_command "$*"
            ;;

        narrate)
            if [[ $# -lt 1 ]]; then
                log_error "Usage: whispr-flow.sh narrate EVENT_TYPE [details]"
                exit 1
            fi
            narrate_event "$@"
            ;;

        context)
            generate_context
            ;;

        consume)
            consume_directive
            ;;

        history)
            if [[ -f "$WHISPR_DIR/command-history.json" ]]; then
                python3 -c "
import json
with open('$WHISPR_DIR/command-history.json') as f:
    history = json.load(f)
for h in history:
    action = h.get('action', 'unknown')
    target = h.get('target', '')
    ts = h.get('timestamp', '')[:19]
    raw = h.get('raw', '')[:60]
    suffix = f' -> {target}' if target else ''
    print(f'[{ts}] {action}{suffix}  ({raw})')
" 2>/dev/null
            else
                echo "No command history"
            fi
            ;;

        help|--help|-h)
            echo -e "${BOLD}Whispr Flow - Voice-Driven Development Flow${NC}"
            echo ""
            echo "Usage: whispr-flow.sh <command> [options]"
            echo ""
            echo "Commands:"
            echo "  start [--narrate] [--listen-interval SECS]"
            echo "                         Start continuous voice-driven flow"
            echo "  stop                   Stop the Whispr Flow session"
            echo "  status                 Show session and voice backend status"
            echo "  inject \"command\"        Parse and execute a voice command"
            echo "  parse \"text\"            Parse voice input without executing"
            echo "  narrate EVENT [DETAIL]  Narrate an execution event via TTS"
            echo "  context                Generate context for prompt injection"
            echo "  consume                Clear consumed directives"
            echo "  history                Show command history"
            echo ""
            echo "Voice Commands (natural language):"
            echo "  \"pause\" / \"resume\" / \"stop\"  - Execution control"
            echo "  \"focus on auth\"                - Reprioritize tasks"
            echo "  \"skip deployment\"              - Skip phases"
            echo "  \"add task: fix login bug\"      - Inject new tasks"
            echo "  \"show status\"                  - Get progress info"
            echo "  \"review the code\"              - Trigger code review"
            echo ""
            echo "Environment:"
            echo "  WHISPR_NARRATE=true   Force-enable TTS narration"
            echo "  LOKI_PROMPT_INJECTION=true  Enable directive injection via HUMAN_INPUT.md"
            echo ""
            echo "Integration:"
            echo "  Whispr Flow generates .loki/whispr/ state files that run.sh"
            echo "  reads during prompt construction. Directives are injected"
            echo "  into the autonomous execution context each iteration."
            ;;

        *)
            log_error "Unknown command: $command"
            echo "Run 'whispr-flow.sh help' for usage"
            exit 1
            ;;
    esac
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
