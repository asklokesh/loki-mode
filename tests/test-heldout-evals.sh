#!/usr/bin/env bash
# tests/test-heldout-evals.sh -- Held-out spec evals (v7.28.0)
#
# Anti-reward-hacking: a deterministic subset of PRD-checklist acceptance checks
# is reserved as "held-out" at checklist-generation time and is NEVER shown to
# the build loop. The completion council evaluates the held-out items only at the
# ship gate (council_heldout_gate).
#
# This suite exercises the REAL functions:
#   autonomy/prd-checklist.sh:
#     checklist_select_heldout()  - deterministic, idempotent selection
#     checklist_heldout_ids()     - read selected ids
#     checklist_summary()         - build-loop-facing summary EXCLUDES held-out
#   autonomy/completion-council.sh:
#     council_heldout_gate()      - blocks completion on a failing held-out item
#     council_checklist_gate()    - does NOT block on a failing held-out item
#
# Contract:
#   - N>=4 items -> count = clamp(round(0.25*N), 1, 5) held-out, chosen by
#     sha256(id) order (stable, reproducible). N<4 -> zero held-out.
#   - held-out items excluded from checklist_summary (the build prompt feed) and
#     from council_checklist_gate.
#   - council_heldout_gate: failing held-out item -> rc 1 (block); all
#     verified/pending -> rc 0; LOKI_HELDOUT_GATE=0 -> rc 0, no read/write.
#
# Skips gracefully (exit 0) if python3 is unavailable.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKLIST_SH="$REPO_ROOT/autonomy/prd-checklist.sh"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed; the held-out logic parses JSON via python3. (Not a fail.)"
    exit 0
fi
if [ ! -f "$CHECKLIST_SH" ]; then echo "SKIP: $CHECKLIST_SH not found. (Not a fail.)"; exit 0; fi
if [ ! -f "$COUNCIL_SH" ]; then echo "SKIP: $COUNCIL_SH not found. (Not a fail.)"; exit 0; fi

# Stub the log_* helpers (defined in run.sh) so both libraries source cleanly.
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_success() { :; }
log_debug()   { :; }
log_step()    { :; }

# shellcheck source=/dev/null
source "$CHECKLIST_SH"
# shellcheck source=/dev/null
source "$COUNCIL_SH"

# Bring the REAL trust-event helpers into scope by extracting their function
# bodies from run.sh (sourcing all of run.sh would execute top-level code). With
# SCRIPT_DIR pointed at autonomy/, record_trust_event_bash writes to the real
# trust-events.jsonl via autonomy/lib/trust_metrics.py -- so case 7 exercises
# the actual emission path, not a stub.
SCRIPT_DIR="$REPO_ROOT/autonomy"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
if [ -f "$RUN_SH" ]; then
    _fn_run_id="$(awk '/^_loki_trust_run_id\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
    _fn_trust="$(awk '/^record_trust_event_bash\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
    [ -n "$_fn_run_id" ] && eval "$_fn_run_id" 2>/dev/null || true
    [ -n "$_fn_trust" ] && eval "$_fn_trust" 2>/dev/null || true
fi

if ! type checklist_select_heldout >/dev/null 2>&1; then
    echo "SKIP: checklist_select_heldout not defined. Implementation not landed."
    exit 0
fi
if ! type council_heldout_gate >/dev/null 2>&1; then
    echo "SKIP: council_heldout_gate not defined. Implementation not landed."
    exit 0
fi

TMP_ROOT="$(mktemp -d -t loki-heldout.XXXXXX)" || exit 2
trap 'rm -rf "$TMP_ROOT"' EXIT

# Write a checklist.json with N items (ids item-1..item-N) into <dir>/.loki/checklist.
# Usage: make_checklist <dir> <N> [status-of-each-comma-list]
# status list (optional) maps item index -> status; default all "pending".
make_checklist() {
    local dir="$1" n="$2" statuses="${3:-}"
    mkdir -p "$dir/.loki/checklist"
    _DIR="$dir" _N="$n" _STATUSES="$statuses" python3 -c "
import json, os
d = os.environ['_DIR']
n = int(os.environ['_N'])
statuses = os.environ.get('_STATUSES', '')
slist = statuses.split(',') if statuses else []
items = []
for i in range(1, n + 1):
    st = slist[i-1] if i-1 < len(slist) else 'pending'
    items.append({
        'id': 'item-%d' % i,
        'title': 'Item %d' % i,
        'description': 'desc %d' % i,
        'priority': 'critical',
        'status': st,
        'verification': [{'type': 'file_exists', 'path': 'item%d.txt' % i}],
    })
checklist = {'categories': [{'name': 'Core', 'items': items}],
             'summary': {'total': n,
                         'verified': sum(1 for it in items if it['status']=='verified'),
                         'failing': sum(1 for it in items if it['status']=='failing'),
                         'pending': sum(1 for it in items if it['status']=='pending')}}
with open(os.path.join(d, '.loki/checklist/checklist.json'), 'w') as f:
    json.dump(checklist, f, indent=2)
# verification-results.json mirrors the per-item statuses (what verify writes).
results = {'verified_at': '2026-06-09T00:00:00Z',
           'summary': checklist['summary'],
           'categories': [{'name': 'Core',
                           'items': [{'id': it['id'], 'title': it['title'],
                                      'priority': it['priority'], 'status': it['status']}
                                     for it in items]}]}
with open(os.path.join(d, '.loki/checklist/verification-results.json'), 'w') as f:
    json.dump(results, f, indent=2)
"
}

# ===========================================================================
# Case 1: N>=4 deterministic + idempotent selection.
# ===========================================================================
echo "Case 1: N=8 -> 2 held-out (round(0.25*8)=2), deterministic + idempotent"
d="$TMP_ROOT/case1"; make_checklist "$d" 8
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"
    CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
)
HO_FILE="$d/.loki/checklist/held-out.json"
[ -f "$HO_FILE" ] && ok "case1 held-out.json written" || bad "case1 held-out.json written" "missing"
count=$(python3 -c "import json;print(len(json.load(open('$HO_FILE'))['held_out']))" 2>/dev/null)
[ "$count" = "2" ] && ok "case1 count=2 (clamp(round(0.25*8)))" || bad "case1 count=2" "got [$count]"
# Capture the selection, then re-run selection and confirm it is byte-identical
# (idempotent) and reproducible (same ids on a fresh dir with same input).
sel1=$(python3 -c "import json;print(','.join(json.load(open('$HO_FILE'))['held_out']))" 2>/dev/null)
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout   # second call must NOT change the file
)
sel1b=$(python3 -c "import json;print(','.join(json.load(open('$HO_FILE'))['held_out']))" 2>/dev/null)
[ "$sel1" = "$sel1b" ] && ok "case1 idempotent (second select unchanged)" || bad "case1 idempotent" "[$sel1] vs [$sel1b]"

d2="$TMP_ROOT/case1-repro"; make_checklist "$d2" 8
(
    cd "$d2" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
)
sel2=$(python3 -c "import json;print(','.join(json.load(open('$d2/.loki/checklist/held-out.json'))['held_out']))" 2>/dev/null)
[ "$sel1" = "$sel2" ] && ok "case1 reproducible across dirs (stable sha256 order)" || bad "case1 reproducible" "[$sel1] vs [$sel2]"

# ===========================================================================
# Case 2: N<4 -> no held-out reserved.
# ===========================================================================
echo "Case 2: N=3 -> zero held-out"
d="$TMP_ROOT/case2"; make_checklist "$d" 3
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
)
HO_FILE="$d/.loki/checklist/held-out.json"
count=$(python3 -c "import json;print(len(json.load(open('$HO_FILE'))['held_out']))" 2>/dev/null)
[ "$count" = "0" ] && ok "case2 N<4 -> 0 held-out" || bad "case2 N<4 -> 0 held-out" "got [$count]"

# ===========================================================================
# Case 3: clamp upper bound. N=40 -> round(0.25*40)=10, clamped to max 5.
# ===========================================================================
echo "Case 3: N=40 -> held-out clamped to max 5"
d="$TMP_ROOT/case3"; make_checklist "$d" 40
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
)
count=$(python3 -c "import json;print(len(json.load(open('$d/.loki/checklist/held-out.json'))['held_out']))" 2>/dev/null)
[ "$count" = "5" ] && ok "case3 count clamped to 5" || bad "case3 count clamped to 5" "got [$count]"

# ===========================================================================
# Case 4: clamp lower bound. N=4 -> round(0.25*4)=1.
# ===========================================================================
echo "Case 4: N=4 -> exactly 1 held-out (min)"
d="$TMP_ROOT/case4"; make_checklist "$d" 4
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
)
count=$(python3 -c "import json;print(len(json.load(open('$d/.loki/checklist/held-out.json'))['held_out']))" 2>/dev/null)
[ "$count" = "1" ] && ok "case4 count=1 (min)" || bad "case4 count=1" "got [$count]"

# ===========================================================================
# Case 5: the build-prompt feed (checklist_summary) EXCLUDES held-out items.
#         total must drop by the held-out count, and a held-out item id must not
#         leak. Build N=8 (2 held-out) and assert summary total == 6.
# ===========================================================================
echo "Case 5: checklist_summary excludes held-out (build-loop feed is hidden)"
d="$TMP_ROOT/case5"; make_checklist "$d" 8
summary=$(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"
    CHECKLIST_FILE=".loki/checklist/checklist.json"
    CHECKLIST_RESULTS_FILE=".loki/checklist/verification-results.json"
    checklist_select_heldout
    checklist_summary
)
# summary form: "<verified>/<total> verified, ..."
total_in_summary=$(printf '%s' "$summary" | grep -oE '[0-9]+/[0-9]+ verified' | grep -oE '/[0-9]+' | tr -d '/' | head -1)
[ "$total_in_summary" = "6" ] && ok "case5 summary total=6 (8 - 2 held-out)" || bad "case5 summary total=6" "got [$total_in_summary] from [$summary]"

# ===========================================================================
# Case 6: a FAILING held-out item -> council_heldout_gate BLOCKS (rc 1), and
#         council_checklist_gate PASSES (does not block on the same held-out
#         failing item). Proves the hidden check is enforced only at the ship
#         gate, never inside the build loop.
# ===========================================================================
echo "Case 6: failing held-out item -> heldout_gate BLOCK, checklist_gate PASS"
d="$TMP_ROOT/case6"; make_checklist "$d" 8
# First select held-out, then mark the FIRST held-out id as failing in results.
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
)
ho_id=$(python3 -c "import json;print(json.load(open('$d/.loki/checklist/held-out.json'))['held_out'][0])" 2>/dev/null)
# Flip that id to failing in verification-results.json.
_D="$d" _ID="$ho_id" python3 -c "
import json, os
p = os.path.join(os.environ['_D'], '.loki/checklist/verification-results.json')
r = json.load(open(p))
for cat in r['categories']:
    for it in cat['items']:
        if it['id'] == os.environ['_ID']:
            it['status'] = 'failing'
json.dump(r, open(p, 'w'), indent=2)
"
heldout_rc=0
(
    cd "$d" || exit 1
    export COUNCIL_STATE_DIR="$d/.loki/council"; mkdir -p "$COUNCIL_STATE_DIR"
    export TARGET_DIR="$d"; export ITERATION_COUNT=9
    council_heldout_gate
) || heldout_rc=$?
[ "$heldout_rc" -eq 1 ] && ok "case6 heldout_gate BLOCK (rc 1) on failing held-out" || bad "case6 heldout_gate BLOCK" "got rc=$heldout_rc"
[ -f "$d/.loki/council/heldout-block.json" ] && ok "case6 heldout-block.json written" || bad "case6 heldout-block.json" "missing"

checklist_rc=0
(
    cd "$d" || exit 1
    export COUNCIL_STATE_DIR="$d/.loki/council"
    export ITERATION_COUNT=9
    council_checklist_gate
) || checklist_rc=$?
[ "$checklist_rc" -eq 0 ] && ok "case6 checklist_gate PASS (held-out failing item does NOT block build loop)" \
    || bad "case6 checklist_gate PASS" "got rc=$checklist_rc (held-out leaked into visible gate)"

# ===========================================================================
# Case 7: all held-out items verified -> council_heldout_gate PASSES (rc 0) and
#         emits a heldout_eval trust-event with the pass count.
# ===========================================================================
echo "Case 7: all held-out verified -> heldout_gate PASS + heldout_eval trust-event"
d="$TMP_ROOT/case7"; make_checklist "$d" 8 "verified,verified,verified,verified,verified,verified,verified,verified"
heldout_rc=0
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
    export COUNCIL_STATE_DIR="$d/.loki/council"; mkdir -p "$COUNCIL_STATE_DIR"
    export TARGET_DIR="$d"; export ITERATION_COUNT=9
    export LOKI_DIR="$d/.loki"
    council_heldout_gate
) || heldout_rc=$?
[ "$heldout_rc" -eq 0 ] && ok "case7 heldout_gate PASS (all verified)" || bad "case7 heldout_gate PASS" "got rc=$heldout_rc"
TE="$d/.loki/metrics/trust-events.jsonl"
if [ -f "$TE" ] && grep -q '"type": "heldout_eval"' "$TE" 2>/dev/null; then
    ok "case7 heldout_eval trust-event emitted"
else
    # record_trust_event_bash requires SCRIPT_DIR/lib/trust_metrics.py; if the
    # helper is not available in this harness, do not hard-fail (best-effort).
    if type record_trust_event_bash >/dev/null 2>&1; then
        bad "case7 heldout_eval trust-event" "no heldout_eval line in $TE"
    else
        ok "case7 heldout_eval trust-event skipped (record_trust_event_bash unavailable in harness)"
    fi
fi

# ===========================================================================
# Case 8: opt-out. LOKI_HELDOUT_GATE=0 -> PASS (rc 0) even with a failing
#         held-out item, AND no heldout-block.json is written.
# ===========================================================================
echo "Case 8: LOKI_HELDOUT_GATE=0 (opt-out) -> PASS, no block file"
d="$TMP_ROOT/case8"; make_checklist "$d" 8 "failing,failing,failing,failing,failing,failing,failing,failing"
heldout_rc=0
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
    export COUNCIL_STATE_DIR="$d/.loki/council"; mkdir -p "$COUNCIL_STATE_DIR"
    export TARGET_DIR="$d"; export ITERATION_COUNT=9
    export LOKI_HELDOUT_GATE=0
    council_heldout_gate
) || heldout_rc=$?
[ "$heldout_rc" -eq 0 ] && ok "case8 rc=0 (knob off, no block)" || bad "case8 rc=0" "got rc=$heldout_rc"
[ ! -f "$d/.loki/council/heldout-block.json" ] && ok "case8 NO heldout-block.json (no read/write when off)" \
    || bad "case8 no block file when off" "file was written"

# ===========================================================================
# Case 9: no held-out reservation (N<4, no held-out.json) -> council_heldout_gate
#         PASSES (default-off when nothing reserved). Backwards compatible.
# ===========================================================================
echo "Case 9: no held-out.json -> heldout_gate PASS (default-off)"
d="$TMP_ROOT/case9"; make_checklist "$d" 3
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout    # N<4: writes held_out=[] (empty), still a file
)
heldout_rc=0
(
    cd "$d" || exit 1
    export COUNCIL_STATE_DIR="$d/.loki/council"; mkdir -p "$COUNCIL_STATE_DIR"
    export TARGET_DIR="$d"; export ITERATION_COUNT=9
    export LOKI_DIR="$d/.loki"
    council_heldout_gate
) || heldout_rc=$?
[ "$heldout_rc" -eq 0 ] && ok "case9 rc=0 (empty held-out set -> no gate)" || bad "case9 rc=0" "got rc=$heldout_rc"
# Empty held-out set must NOT pollute trust-events.jsonl with a no-op event.
TE9="$d/.loki/metrics/trust-events.jsonl"
if [ -f "$TE9" ] && grep -q '"type": "heldout_eval"' "$TE9" 2>/dev/null; then
    bad "case9 no heldout_eval event for empty set" "found a no-op event in $TE9"
else
    ok "case9 no heldout_eval trust-event for empty held-out set"
fi

# ===========================================================================
# Case 10: a failing held-out item whose TITLE contains ':' and '|' -> the
#          block report's failures JSON must carry the FULL title (colon/pipe-
#          safe parsing), not a truncated fragment.
# ===========================================================================
echo "Case 10: held-out title with ':' and '|' survives in block report"
d="$TMP_ROOT/case10"; make_checklist "$d" 8
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
)
ho_id=$(python3 -c "import json;print(json.load(open('$d/.loki/checklist/held-out.json'))['held_out'][0])" 2>/dev/null)
tricky_title='Auth: login | logout flow'
_D="$d" _ID="$ho_id" _TT="$tricky_title" python3 -c "
import json, os
p = os.path.join(os.environ['_D'], '.loki/checklist/verification-results.json')
r = json.load(open(p))
for cat in r['categories']:
    for it in cat['items']:
        if it['id'] == os.environ['_ID']:
            it['status'] = 'failing'
            it['title'] = os.environ['_TT']
json.dump(r, open(p, 'w'), indent=2)
"
heldout_rc=0
(
    cd "$d" || exit 1
    export COUNCIL_STATE_DIR="$d/.loki/council"; mkdir -p "$COUNCIL_STATE_DIR"
    export TARGET_DIR="$d"; export ITERATION_COUNT=9
    council_heldout_gate
) || heldout_rc=$?
[ "$heldout_rc" -eq 1 ] && ok "case10 heldout_gate BLOCK (rc 1)" || bad "case10 rc=1" "got rc=$heldout_rc"
got_title=$(python3 -c "import json;print(json.load(open('$d/.loki/council/heldout-block.json'))['failures'][0])" 2>/dev/null)
[ "$got_title" = "$tricky_title" ] && ok "case10 full title preserved in block report" \
    || bad "case10 title preserved" "got [$got_title] want [$tricky_title]"

# ---------------------------------------------------------------------------
echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
