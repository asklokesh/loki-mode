#!/usr/bin/env bash
#===============================================================================
# PRD Checklist Module (v5.44.0)
#
# Manages PRD requirement tracking and automated verification. Creates a
# structured checklist from PRD analysis, verifies items on a configurable
# interval, and provides status summaries for prompt injection and council.
#
# Functions:
#   checklist_init(prd_path)    - Initialize checklist during DISCOVERY phase
#   checklist_should_verify()   - Check if verification should run this iteration
#   checklist_verify()          - Run verification checks via checklist-verify.py
#   checklist_summary()         - One-line summary for prompt injection
#   checklist_as_evidence()     - Formatted output for council evidence file
#
# Environment Variables:
#   LOKI_CHECKLIST_INTERVAL     - Verify every N iterations (default: 5)
#   LOKI_CHECKLIST_TIMEOUT      - Timeout per check in seconds (default: 30)
#   LOKI_CHECKLIST_ENABLED      - Enable/disable checklist (default: true)
#
# Data:
#   .loki/checklist/checklist.json          - Full checklist with verification
#   .loki/checklist/verification-results.json - Summary of last verification
#
# Usage:
#   source autonomy/prd-checklist.sh
#   checklist_init "$prd_path"
#   if checklist_should_verify; then checklist_verify; fi
#   checklist_summary
#
#===============================================================================

# Configuration
CHECKLIST_ENABLED=${LOKI_CHECKLIST_ENABLED:-true}
CHECKLIST_INTERVAL=${LOKI_CHECKLIST_INTERVAL:-5}
# Guard against zero/negative interval (division by zero in modulo)
if [ "$CHECKLIST_INTERVAL" -le 0 ] 2>/dev/null; then
    CHECKLIST_INTERVAL=5
fi
CHECKLIST_TIMEOUT=${LOKI_CHECKLIST_TIMEOUT:-30}
# Guard against zero/negative timeout
if [ "$CHECKLIST_TIMEOUT" -le 0 ] 2>/dev/null; then
    CHECKLIST_TIMEOUT=30
fi

# Internal state
CHECKLIST_DIR=""
CHECKLIST_FILE=""
CHECKLIST_RESULTS_FILE=""
CHECKLIST_LAST_VERIFY_ITERATION=0

#===============================================================================
# Initialization
#===============================================================================

checklist_init() {
    local prd_path="${1:-}"

    if [ "$CHECKLIST_ENABLED" != "true" ]; then
        return 0
    fi

    CHECKLIST_DIR=".loki/checklist"
    CHECKLIST_FILE="${CHECKLIST_DIR}/checklist.json"
    CHECKLIST_RESULTS_FILE="${CHECKLIST_DIR}/verification-results.json"

    mkdir -p "$CHECKLIST_DIR"

    if [ -n "$prd_path" ] && [ -f "$prd_path" ]; then
        log_info "PRD checklist initialized for: $prd_path"
    fi

    return 0
}

#===============================================================================
# Interval Control
#===============================================================================

checklist_should_verify() {
    # Returns 0 (true) if verification should run this iteration
    if [ "$CHECKLIST_ENABLED" != "true" ]; then
        return 1
    fi

    if [ ! -f "$CHECKLIST_FILE" ]; then
        return 1
    fi

    # Check iteration interval
    local current_iteration="${ITERATION_COUNT:-0}"
    if [ "$current_iteration" -eq 0 ]; then
        return 1
    fi

    if [ $((current_iteration % CHECKLIST_INTERVAL)) -ne 0 ]; then
        return 1
    fi

    # Don't verify same iteration twice
    if [ "$current_iteration" -eq "$CHECKLIST_LAST_VERIFY_ITERATION" ]; then
        return 1
    fi

    return 0
}

#===============================================================================
# Verification
#===============================================================================

checklist_verify() {
    if [ "$CHECKLIST_ENABLED" != "true" ]; then
        return 0
    fi

    if [ ! -f "$CHECKLIST_FILE" ]; then
        return 0
    fi

    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local verify_script="${script_dir}/checklist-verify.py"

    if [ ! -f "$verify_script" ]; then
        log_warn "checklist-verify.py not found at $verify_script"
        return 0
    fi

    log_step "Running PRD checklist verification..."

    python3 "$verify_script" \
        --checklist "$CHECKLIST_FILE" \
        --timeout "$CHECKLIST_TIMEOUT" 2>/dev/null || true

    CHECKLIST_LAST_VERIFY_ITERATION="${ITERATION_COUNT:-0}"

    # Log result if available
    if [ -f "$CHECKLIST_RESULTS_FILE" ]; then
        local summary
        summary=$(checklist_summary 2>/dev/null || true)
        if [ -n "$summary" ]; then
            log_info "Checklist: $summary"
        fi
    fi

    return 0
}

#===============================================================================
# Summary (for prompt injection)
#===============================================================================

checklist_summary() {
    # Returns one-line summary string
    if [ ! -f "$CHECKLIST_RESULTS_FILE" ]; then
        echo ""
        return 0
    fi

    _CHECKLIST_RESULTS="$CHECKLIST_RESULTS_FILE" \
    _CHECKLIST_WAIVERS="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json" \
    python3 -c "
import json, sys, os
try:
    fpath = os.environ.get('_CHECKLIST_RESULTS', '')
    data = json.load(open(fpath))
    s = data.get('summary', {})
    total = s.get('total', 0)
    verified = s.get('verified', 0)
    failing = s.get('failing', 0)
    pending = s.get('pending', 0)

    # Load waivers
    waived_ids = set()
    waivers_path = os.environ.get('_CHECKLIST_WAIVERS', '')
    if waivers_path and os.path.exists(waivers_path):
        try:
            with open(waivers_path) as wf:
                wdata = json.load(wf)
            for w in wdata.get('waivers', []):
                if w.get('active', True):
                    waived_ids.add(w['item_id'])
        except Exception:
            pass

    # Count waived items and adjust failing list
    waived_count = 0
    if total == 0:
        print('')
    else:
        failing_items = []
        for cat in data.get('categories', []):
            for item in cat.get('items', []):
                item_id = item.get('id', '')
                if item_id in waived_ids:
                    waived_count += 1
                    continue
                if item.get('status') == 'failing' and item.get('priority') in ('critical', 'major'):
                    failing_items.append(item.get('title', item.get('id', '?')))
        detail = ''
        if failing_items:
            detail = ' FAILING: ' + ', '.join(failing_items[:5])
        waived_str = f', {waived_count} waived' if waived_count > 0 else ''
        adjusted_failing = max(0, failing - waived_count)
        print(f'{verified}/{total} verified, {adjusted_failing} failing{waived_str}, {pending} pending.{detail}')
except Exception:
    print('', file=sys.stderr)
" 2>/dev/null || echo ""
}

#===============================================================================
# Council Evidence (for completion-council.sh)
#===============================================================================

checklist_as_evidence() {
    # Writes formatted checklist evidence to stdout for council consumption
    local evidence_file="${1:-}"

    if [ ! -f "$CHECKLIST_RESULTS_FILE" ]; then
        return 0
    fi

    {
        echo ""
        echo "## PRD Checklist Verification"
        echo ""

        _CHECKLIST_RESULTS="$CHECKLIST_RESULTS_FILE" python3 -c "
import json, os
try:
    data = json.load(open(os.environ['_CHECKLIST_RESULTS']))
    s = data.get('summary', {})
    print(f\"Summary: {s.get('verified',0)}/{s.get('total',0)} verified, {s.get('failing',0)} failing\")
    print()
    for cat in data.get('categories', []):
        print(f\"### {cat.get('name', 'Unknown')}\")
        for item in cat.get('items', []):
            status_icon = {'verified': '[PASS]', 'failing': '[FAIL]', 'pending': '[----]'}.get(item.get('status','pending'), '[----]')
            priority = item.get('priority', 'minor').upper()
            print(f\"  {status_icon} [{priority}] {item.get('title', item.get('id', '?'))}\")
        print()
except Exception:
    print('Checklist data unavailable')
" 2>/dev/null || echo "Checklist data unavailable"
    } >> "${evidence_file:-/dev/stdout}"
}

#===============================================================================
# Waiver Support (Phase 4)
#===============================================================================

# Load waivers from .loki/checklist/waivers.json
# Returns waived item IDs (one per line) to stdout
checklist_waiver_load() {
    local waivers_file="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json"
    if [ ! -f "$waivers_file" ]; then
        return 0
    fi
    _WAIVERS_FILE="$waivers_file" python3 -c "
import json, sys, os
try:
    waivers_file = os.environ['_WAIVERS_FILE']
    with open(waivers_file) as f:
        waivers = json.load(f)
    for w in waivers.get('waivers', []):
        if w.get('active', True):
            print(w['item_id'])
except Exception:
    pass
" 2>/dev/null || true
}

# Add a waiver for a checklist item
# Usage: checklist_waiver_add <item_id> <reason> [waived_by]
checklist_waiver_add() {
    local item_id="${1:?item_id required}"
    local reason="${2:?reason required}"
    local waived_by="${3:-manual}"
    local waivers_file="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    _WAIVERS_FILE="$waivers_file" python3 -c "
import json, os, sys

waivers_file = os.environ['_WAIVERS_FILE']
item_id = sys.argv[1]
reason = sys.argv[2]
waived_by = sys.argv[3]
timestamp = sys.argv[4]

# Load existing or create new
waivers = {'waivers': []}
if os.path.exists(waivers_file):
    try:
        with open(waivers_file) as f:
            waivers = json.load(f)
    except (json.JSONDecodeError, IOError):
        pass

# Check for duplicate
for w in waivers.get('waivers', []):
    if w.get('item_id') == item_id and w.get('active', True):
        print(f'Waiver already exists for {item_id}')
        sys.exit(0)

# Add new waiver
waivers.setdefault('waivers', []).append({
    'item_id': item_id,
    'reason': reason,
    'waived_by': waived_by,
    'waived_at': timestamp,
    'active': True
})

# Atomic write
tmp = waivers_file + '.tmp'
with open(tmp, 'w') as f:
    json.dump(waivers, f, indent=2)
os.replace(tmp, waivers_file)
print(f'Waiver added for {item_id}')
" "$item_id" "$reason" "$waived_by" "$timestamp" 2>/dev/null
}

# Remove (deactivate) a waiver for a checklist item
# Usage: checklist_waiver_remove <item_id>
checklist_waiver_remove() {
    local item_id="${1:?item_id required}"
    local waivers_file="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json"

    if [ ! -f "$waivers_file" ]; then
        echo "No waivers file found"
        return 1
    fi

    _WAIVERS_FILE="$waivers_file" python3 -c "
import json, os, sys

waivers_file = os.environ['_WAIVERS_FILE']
item_id = sys.argv[1]

with open(waivers_file) as f:
    waivers = json.load(f)

found = False
for w in waivers.get('waivers', []):
    if w.get('item_id') == item_id and w.get('active', True):
        w['active'] = False
        found = True

if not found:
    print(f'No active waiver found for {item_id}')
    sys.exit(1)

tmp = waivers_file + '.tmp'
with open(tmp, 'w') as f:
    json.dump(waivers, f, indent=2)
os.replace(tmp, waivers_file)
print(f'Waiver removed for {item_id}')
" "$item_id" 2>/dev/null
}

# List all active waivers
checklist_waiver_list() {
    local waivers_file="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json"

    if [ ! -f "$waivers_file" ]; then
        echo "No waivers configured"
        return 0
    fi

    _WAIVERS_FILE="$waivers_file" python3 -c "
import json, os
waivers_file = os.environ['_WAIVERS_FILE']
with open(waivers_file) as f:
    waivers = json.load(f)
active = [w for w in waivers.get('waivers', []) if w.get('active', True)]
if not active:
    print('No active waivers')
else:
    for w in active:
        print(f\"  {w['item_id']}: {w.get('reason', 'no reason')} (by {w.get('waived_by', 'unknown')} at {w.get('waived_at', '?')})\")
" 2>/dev/null
}
