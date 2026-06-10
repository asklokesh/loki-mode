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
# Held-out Spec Eval Selection (v7.28.0)
#===============================================================================
# Anti-reward-hacking: deterministically reserve ~25% of checklist items as
# "held-out". Held-out item IDs are excluded from the prompt feed the build loop
# sees (checklist_summary and council_checklist_gate), so a cooperative build
# agent is not steered toward those specific acceptance checks. The completion
# council evaluates them at the ship gate (council_heldout_gate in
# completion-council.sh). Scope of the guarantee: this protects the prompt feed,
# not a sandbox. .loki/checklist/held-out.json is plain on-disk JSON, so a
# non-cooperative agent with filesystem tools can read the reservation directly.
#
# Selection is idempotent and reproducible: count = clamp(round(0.25*N), 1, 5)
# for N>=4 items; ordering by sha256 of each item's "id" (stable, not random).
# Written once to .loki/checklist/held-out.json; never overwritten if present.
checklist_select_heldout() {
    local heldout_file="${CHECKLIST_DIR:-".loki/checklist"}/held-out.json"

    if [ ! -f "$CHECKLIST_FILE" ]; then
        return 0
    fi

    # The Python below handles all four cases and prints a single status token so
    # bash can log honestly and emit the right trust event:
    #   FRESH n           - no prior reservation, selected n (file written)
    #   IDEMPOTENT        - prior reservation fully valid vs current ids (no-op,
    #                       file untouched: preserves the idempotency case 1 tests)
    #   RESELECTED n      - prior reservation fully stale (zero ids survive); the
    #                       checklist regenerated, so we deterministically re-select
    #                       n items from the CURRENT checklist and overwrite
    #   PARTIAL kept=k dropped=d - some prior ids survived; we keep only survivors
    #   DUP_SKIP          - current checklist ids are not unique; the id-based
    #                       mechanism is unsound, so we reserve nothing (MEDIUM-2)
    #   NOOP              - n<4 with no prior file, or other no-write outcome
    # Honest caveat: re-selection or partial-survival after a regen can reserve
    # items the build loop already saw in earlier prompts (the hidden-from-loop
    # guarantee is best-effort once the checklist ids change mid-run).
    local status_token
    status_token=$(_CHECKLIST_FILE="$CHECKLIST_FILE" _HELDOUT_FILE="$heldout_file" python3 -c "
import json, os, sys, hashlib, tempfile

cl_path = os.environ['_CHECKLIST_FILE']
out_path = os.environ['_HELDOUT_FILE']
try:
    with open(cl_path) as f:
        data = json.load(f)
except Exception:
    print('NOOP')
    sys.exit(0)

# Collect all item ids in document order.
ids = []
for cat in data.get('categories', []):
    for item in cat.get('items', []):
        iid = item.get('id', '')
        if iid:
            ids.append(iid)

n = len(ids)
id_set = set(ids)

# MEDIUM-2: duplicate ids make the id-based hide/select mechanism unsound. Skip
# selection entirely (no reservation written) so a held-out id can never map to
# more than one item. Do NOT touch an existing reservation file here (a stale
# valid file left over from before a dup-introducing regen is handled by the
# council gate's STALE path; over-removing would be over-engineering).
if len(id_set) != n:
    print('DUP_SKIP')
    sys.exit(0)

def select_count(num_ids):
    c = round(0.25 * num_ids)
    if c < 1:
        c = 1
    if c > 5:
        c = 5
    return c

def fresh_selection():
    # Deterministic order: sort ids by sha256(id), take the first <count>.
    count = select_count(n)
    ranked = sorted(ids, key=lambda i: hashlib.sha256(i.encode('utf-8')).hexdigest())
    return sorted(ranked[:count])

def atomic_write(payload):
    d = os.path.dirname(out_path) or '.'
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
    with os.fdopen(fd, 'w') as f:
        json.dump(payload, f, indent=2)
        f.write('\n')
    os.replace(tmp, out_path)

prior = None
if os.path.exists(out_path):
    try:
        with open(out_path) as f:
            prior = json.load(f)
    except Exception:
        prior = None

if prior is not None:
    prior_ids = [i for i in prior.get('held_out', []) if i]
    # A prior reservation of [] (e.g. an earlier n<4 run) is a valid no-op state;
    # keep it idempotent rather than re-selecting now that n may have grown.
    if not prior_ids:
        print('IDEMPOTENT')
        sys.exit(0)
    survivors = [i for i in prior_ids if i in id_set]
    if len(survivors) == len(prior_ids):
        # Fully valid against the current checklist: idempotent no-op.
        print('IDEMPOTENT')
        sys.exit(0)
    if not survivors:
        # Fully stale: the checklist regenerated and orphaned the reservation.
        # Deterministically re-select from the CURRENT checklist.
        if n < 4:
            atomic_write({'held_out': [], 'total_items': n,
                          'note': 'n<4: no held-out reserved (re-selected after stale reservation)'})
            print('RESELECTED 0')
            sys.exit(0)
        held = fresh_selection()
        atomic_write({'held_out': held, 'total_items': n})
        print('RESELECTED %d' % len(held))
        sys.exit(0)
    # Partial survival: keep only the surviving ids (do not silently shrink).
    dropped = len(prior_ids) - len(survivors)
    payload = {'held_out': sorted(survivors), 'total_items': n}
    atomic_write(payload)
    print('PARTIAL kept=%d dropped=%d' % (len(survivors), dropped))
    sys.exit(0)

# No prior reservation: first selection.
if n < 4:
    # N>=4 gate: smaller checklists get no held-out (nothing to hide reliably).
    atomic_write({'held_out': [], 'total_items': n, 'note': 'n<4: no held-out reserved'})
    print('NOOP')
    sys.exit(0)

held = fresh_selection()
atomic_write({'held_out': held, 'total_items': n})
print('FRESH %d' % len(held))
" 2>/dev/null || echo "NOOP")

    # Honest logging + trust event on any stale repair (type-guarded).
    local tok rest
    read -r tok rest <<< "$status_token"
    case "$tok" in
        RESELECTED)
            log_warn "[checklist] held-out reservation stale (checklist regenerated); re-selected ${rest:-0} items"
            if type record_trust_event_bash &>/dev/null; then
                record_trust_event_bash "heldout_stale" \
                    "detail=reselected" \
                    "reselected=${rest:-0}" \
                    >/dev/null 2>&1 || true
            fi
            ;;
        PARTIAL)
            log_warn "[checklist] held-out reservation partially stale (checklist regenerated); $rest"
            if type record_trust_event_bash &>/dev/null; then
                record_trust_event_bash "heldout_stale" \
                    "detail=partial" \
                    "$rest" \
                    >/dev/null 2>&1 || true
            fi
            ;;
        DUP_SKIP)
            log_warn "[checklist] checklist ids are not unique; held-out selection skipped (id-based reservation is unsound with duplicate ids)"
            ;;
    esac

    return 0
}

# Echo held-out item IDs (one per line) to stdout. Empty when none reserved.
checklist_heldout_ids() {
    local heldout_file="${CHECKLIST_DIR:-".loki/checklist"}/held-out.json"
    if [ ! -f "$heldout_file" ]; then
        return 0
    fi
    _HELDOUT_FILE="$heldout_file" python3 -c "
import json, os
try:
    with open(os.environ['_HELDOUT_FILE']) as f:
        data = json.load(f)
    for i in data.get('held_out', []):
        print(i)
except Exception:
    pass
" 2>/dev/null || true
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

    # Held-out selection happens BEFORE the first verification so that the very
    # first verification-results.json summary already excludes held-out items.
    checklist_select_heldout

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
    _CHECKLIST_HELDOUT="${CHECKLIST_DIR:-".loki/checklist"}/held-out.json" \
    python3 -c "
import json, sys, os
try:
    fpath = os.environ.get('_CHECKLIST_RESULTS', '')
    data = json.load(open(fpath))

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

    # Load held-out item ids (v7.28.0). Held-out items are NEVER surfaced to the
    # build loop: they are fully excluded from the counts and the failing list so
    # the build agent cannot tune to them. The council evaluates them separately.
    heldout_ids = set()
    heldout_path = os.environ.get('_CHECKLIST_HELDOUT', '')
    if heldout_path and os.path.exists(heldout_path):
        try:
            with open(heldout_path) as hf:
                hdata = json.load(hf)
            heldout_ids = set(hdata.get('held_out', []))
        except Exception:
            pass

    # Count all checklist items first so we can detect the pathological case
    # where hiding would empty the summary on a non-empty checklist (MEDIUM-2).
    all_items = 0
    for cat in data.get('categories', []):
        all_items += len(cat.get('items', []))

    def compute(apply_heldout):
        total = verified = pending = failing = waived_count = 0
        failing_items = []
        for cat in data.get('categories', []):
            for item in cat.get('items', []):
                item_id = item.get('id', '')
                if apply_heldout and item_id in heldout_ids:
                    continue
                if item_id in waived_ids:
                    waived_count += 1
                    continue
                total += 1
                status = item.get('status')
                if status == 'verified':
                    verified += 1
                elif status == 'failing':
                    failing += 1
                    if item.get('priority') in ('critical', 'major'):
                        failing_items.append(item.get('title', item.get('id', '?')))
                else:
                    pending += 1
        return total, verified, pending, failing, waived_count, failing_items

    # Recompute counts over the VISIBLE (non-held-out) items so 'total' never
    # leaks the existence of held-out items. Waived items are excluded too.
    total, verified, pending, failing, waived_count, failing_items = compute(True)

    # MEDIUM-2 guard: if hiding held-out items would empty the summary while the
    # checklist itself is non-empty, fall back to showing all items (do not hide)
    # and warn. Returning an empty summary on a non-empty checklist reads as 'no
    # checklist' to the prompt feed, which is a worse failure than a small leak.
    if total == 0 and all_items > 0:
        print('held-out hiding would empty a non-empty checklist summary; showing all items', file=sys.stderr)
        total, verified, pending, failing, waived_count, failing_items = compute(False)

    if total == 0:
        print('')
    else:
        detail = ''
        if failing_items:
            detail = ' FAILING: ' + ', '.join(failing_items[:5])
        waived_str = f', {waived_count} waived' if waived_count > 0 else ''
        print(f'{verified}/{total} verified, {failing} failing{waived_str}, {pending} pending.{detail}')
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
