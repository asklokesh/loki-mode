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

# ===========================================================================
# Case 11: route-level wiring assertion (static, no live run). The held-out
#          ship gate is only enforced if council_heldout_gate is actually called
#          from BOTH completion routes in run.sh and from the council evaluate
#          path. These greps fail loudly if any wiring is silently removed.
#          Pattern "! council_heldout_gate" matches only real call sites and
#          excludes comments and the "council_heldout_gate() {" definition.
# ===========================================================================
echo "Case 11: route-level wiring assertions (run.sh + completion-council.sh)"
if [ -f "$RUN_SH" ]; then
    # (a) completion-promise route: a single elif line must gate completion on
    #     both the per-iteration completion claim AND council_heldout_gate.
    #     v7.28 DROP-FIX: check_completion_promise is now evaluated exactly ONCE
    #     per iteration into _completion_claimed (it consumes the signal), and the
    #     held-out arm tests that variable instead of re-calling the consuming
    #     helper. Match the new variable-based wiring so this stays load-bearing.
    if grep -Eq '_completion_claimed.*! council_heldout_gate' "$RUN_SH"; then
        ok "case11 promise route wires council_heldout_gate into _completion_claimed chain"
    else
        bad "case11 promise route wiring" "no _completion_claimed line also calls ! council_heldout_gate in run.sh"
    fi

    # (b) force-review route: the COUNCIL_REVIEW_REQUESTED signal block must call
    #     council_heldout_gate. Slice from the signal handling to the end of the
    #     elif chain (council_vote) and assert the gate appears inside it.
    fr_block="$(awk '/COUNCIL_REVIEW_REQUESTED/{f=1} f{print} f&&/elif type council_vote/{exit}' "$RUN_SH" 2>/dev/null || true)"
    if printf '%s' "$fr_block" | grep -q '! council_heldout_gate'; then
        ok "case11 force-review route wires council_heldout_gate after COUNCIL_REVIEW_REQUESTED"
    else
        bad "case11 force-review route wiring" "council_heldout_gate not called in the COUNCIL_REVIEW_REQUESTED block"
    fi

    # (c) at least 2 real call sites in run.sh (promise + force-review).
    run_calls="$(grep -c '! council_heldout_gate' "$RUN_SH" 2>/dev/null || echo 0)"
    if [ "${run_calls:-0}" -ge 2 ]; then
        ok "case11 run.sh has >=2 council_heldout_gate call sites (got $run_calls)"
    else
        bad "case11 run.sh call-site count" "expected >=2, got $run_calls"
    fi
else
    bad "case11 run.sh present for wiring assertions" "RUN_SH not found at $RUN_SH"
fi

# (d) the council evaluate path (completion-council.sh) must also call the gate.
council_calls="$(grep -c '! council_heldout_gate' "$COUNCIL_SH" 2>/dev/null || echo 0)"
if [ "${council_calls:-0}" -ge 1 ]; then
    ok "case11 completion-council.sh calls council_heldout_gate in council_evaluate (got $council_calls)"
else
    bad "case11 completion-council.sh call site" "expected >=1, got $council_calls"
fi

# ===========================================================================
# Case 12: STALE reservation. Select held-out, then regenerate the checklist
#          with brand-new ids (orphaning the reservation). Re-running selection
#          must RE-SELECT from the current checklist (file rewritten with valid
#          ids), and the gate must then evaluate the new set.
# ===========================================================================
echo "Case 12: stale reservation -> re-select + gate evaluates new set"
d="$TMP_ROOT/case12"; make_checklist "$d" 8
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
)
old_sel=$(python3 -c "import json;print(','.join(json.load(open('$d/.loki/checklist/held-out.json'))['held_out']))" 2>/dev/null)
# Regenerate checklist + results with brand-new ids (new-1..new-8), all FAILING,
# orphaning the OLD reservation entirely.
_D="$d" python3 -c "
import json, os
d = os.environ['_D']
items = [{'id':'new-%d'%i,'title':'New %d'%i,'description':'d','priority':'critical','status':'failing','verification':[]} for i in range(1,9)]
cl = {'categories':[{'name':'Core','items':items}], 'summary':{'total':8,'verified':0,'failing':8,'pending':0}}
json.dump(cl, open(os.path.join(d,'.loki/checklist/checklist.json'),'w'), indent=2)
res = {'categories':[{'name':'Core','items':[{'id':it['id'],'title':it['title'],'priority':it['priority'],'status':it['status']} for it in items]}], 'summary':cl['summary']}
json.dump(res, open(os.path.join(d,'.loki/checklist/verification-results.json'),'w'), indent=2)
"
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout   # must re-select (stale)
)
new_sel=$(python3 -c "import json;print(','.join(json.load(open('$d/.loki/checklist/held-out.json'))['held_out']))" 2>/dev/null)
# All new ids start with 'new-'; the file must have been rewritten with valid ids.
all_new=$(python3 -c "import json; ids=json.load(open('$d/.loki/checklist/held-out.json'))['held_out']; print('yes' if ids and all(i.startswith('new-') for i in ids) else 'no')" 2>/dev/null)
[ "$all_new" = "yes" ] && ok "case12 stale reservation re-selected with current (valid) ids" \
    || bad "case12 re-select" "old=[$old_sel] new=[$new_sel] all_new=$all_new"
# The gate must now evaluate the re-selected (all-failing) set -> BLOCK rc 1.
heldout_rc=0
(
    cd "$d" || exit 1
    export COUNCIL_STATE_DIR="$d/.loki/council"; mkdir -p "$COUNCIL_STATE_DIR"
    export TARGET_DIR="$d"; export ITERATION_COUNT=9
    council_heldout_gate
) || heldout_rc=$?
[ "$heldout_rc" -eq 1 ] && ok "case12 gate evaluates re-selected set (BLOCK on failing held-out)" \
    || bad "case12 gate after re-select" "got rc=$heldout_rc"

# ===========================================================================
# Case 13: PARTIAL mismatch. Select held-out, then regenerate the checklist so
#          ONLY SOME reserved ids survive. Re-running selection must keep only
#          the survivors (no silent shrink without trace) and drop the rest.
# ===========================================================================
echo "Case 13: partial mismatch -> survivors kept, dropped recorded"
d="$TMP_ROOT/case13"; make_checklist "$d" 8
(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
)
# held-out for N=8 is item-X,item-Y. Keep the FIRST reserved id, rename every
# other item so exactly one reserved id survives.
keep_id=$(python3 -c "import json;print(json.load(open('$d/.loki/checklist/held-out.json'))['held_out'][0])" 2>/dev/null)
_D="$d" _KEEP="$keep_id" python3 -c "
import json, os
d = os.environ['_D']; keep = os.environ['_KEEP']
for fn in ('checklist.json','verification-results.json'):
    p = os.path.join(d,'.loki/checklist',fn)
    data = json.load(open(p))
    k = 0
    for cat in data.get('categories', []):
        for it in cat.get('items', []):
            if it.get('id') != keep:
                k += 1
                it['id'] = 'renamed-%d' % k   # orphan all but the kept id
    json.dump(data, open(p,'w'), indent=2)
"
(
    cd "$d" || exit 1
    # Un-stub log_warn locally so the dropped-count trace is captured for assert.
    log_warn() { printf '%s\n' "$*"; }
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout   # must keep only the survivor
) > "$d/select.log" 2>&1
survivors=$(python3 -c "import json;print(','.join(json.load(open('$d/.loki/checklist/held-out.json'))['held_out']))" 2>/dev/null)
[ "$survivors" = "$keep_id" ] && ok "case13 partial mismatch keeps only surviving id ($keep_id)" \
    || bad "case13 survivors" "got [$survivors] want [$keep_id]"
# The dropped count must be traced (warning logged by checklist_select_heldout).
if grep -q "partially stale" "$d/select.log" 2>/dev/null && grep -q "dropped=" "$d/select.log" 2>/dev/null; then
    ok "case13 dropped count is logged (no silent shrink)"
else
    bad "case13 dropped-count logged" "no 'partially stale ... dropped=' trace in select.log: $(cat "$d/select.log" 2>/dev/null)"
fi

# ===========================================================================
# Case 14: duplicate ids. The id-based mechanism is unsound with dup ids, so
#          selection must reserve NOTHING (no held-out.json written) and warn.
#          Separately, checklist_summary must never be empty on a non-empty
#          checklist (MEDIUM-2 guard).
# ===========================================================================
echo "Case 14: duplicate ids -> no reservation written, warning logged"
d="$TMP_ROOT/case14"
mkdir -p "$d/.loki/checklist"
_D="$d" python3 -c "
import json, os
d = os.environ['_D']
# Two items share id 'dup-1' -> not unique.
items = [{'id':'dup-1','title':'A','priority':'critical','status':'pending'},
         {'id':'dup-1','title':'B','priority':'critical','status':'pending'},
         {'id':'uniq-3','title':'C','priority':'critical','status':'pending'},
         {'id':'uniq-4','title':'D','priority':'critical','status':'verified'}]
cl = {'categories':[{'name':'Core','items':items}], 'summary':{'total':4,'verified':1,'failing':0,'pending':3}}
json.dump(cl, open(os.path.join(d,'.loki/checklist/checklist.json'),'w'), indent=2)
json.dump(cl, open(os.path.join(d,'.loki/checklist/verification-results.json'),'w'), indent=2)
"
(
    cd "$d" || exit 1
    log_warn() { printf '%s\n' "$*"; }   # capture the dup-skip warning
    CHECKLIST_DIR=".loki/checklist"; CHECKLIST_FILE=".loki/checklist/checklist.json"
    checklist_select_heldout
) > "$d/dup.log" 2>&1
if [ ! -f "$d/.loki/checklist/held-out.json" ]; then
    ok "case14 duplicate ids -> no held-out.json written"
else
    bad "case14 dup-skip" "held-out.json was written despite duplicate ids"
fi
if grep -q "not unique" "$d/dup.log" 2>/dev/null; then
    ok "case14 duplicate-id warning logged"
else
    bad "case14 dup warning logged" "no 'not unique' warning in dup.log: $(cat "$d/dup.log" 2>/dev/null)"
fi
# Summary must be non-empty on this non-empty checklist (no held-out hiding here).
summary=$(
    cd "$d" || exit 1
    CHECKLIST_DIR=".loki/checklist"
    CHECKLIST_RESULTS_FILE=".loki/checklist/verification-results.json"
    checklist_summary
)
[ -n "$summary" ] && ok "case14 checklist_summary non-empty on non-empty checklist" \
    || bad "case14 summary non-empty" "summary was empty"

# ===========================================================================
# Case 15: zero-match gate. A reservation lists ids but NONE match the current
#          items (orphaned by regen). The gate must NOT record a heldout_eval
#          trust-event with verdict=PASS (it must record STALE instead) and must
#          return 0 (pass-through, so selection-side repair fixes it next round).
# ===========================================================================
echo "Case 15: zero-match gate -> no PASS trust-event (STALE, pass-through)"
d="$TMP_ROOT/case15"; make_checklist "$d" 8 "failing,failing,failing,failing,failing,failing,failing,failing"
# Write a held-out.json whose ids do NOT exist in the checklist (orphaned).
_D="$d" python3 -c "
import json, os
d = os.environ['_D']
json.dump({'held_out':['ghost-1','ghost-2'],'total_items':8},
          open(os.path.join(d,'.loki/checklist/held-out.json'),'w'), indent=2)
"
heldout_rc=0
(
    cd "$d" || exit 1
    export COUNCIL_STATE_DIR="$d/.loki/council"; mkdir -p "$COUNCIL_STATE_DIR"
    export TARGET_DIR="$d"; export ITERATION_COUNT=9
    export LOKI_DIR="$d/.loki"
    council_heldout_gate   # call DIRECTLY (no preceding select) to observe STALE
) || heldout_rc=$?
[ "$heldout_rc" -eq 0 ] && ok "case15 zero-match gate returns 0 (pass-through, not a forever-block)" \
    || bad "case15 zero-match rc" "got rc=$heldout_rc"
TE15="$d/.loki/metrics/trust-events.jsonl"
if [ -f "$TE15" ]; then
    if grep -q '"type": "heldout_eval"' "$TE15" 2>/dev/null && grep -q '"verdict": "PASS"' "$TE15" 2>/dev/null; then
        bad "case15 no PASS trust-event on zero-match" "found a heldout_eval verdict=PASS for an orphaned reservation"
    elif grep -q '"verdict": "STALE"' "$TE15" 2>/dev/null; then
        ok "case15 zero-match recorded as STALE (not silent PASS)"
    else
        ok "case15 no heldout_eval PASS event on zero-match"
    fi
else
    # No trust file (helper unavailable in harness): the rc=0 + no-PASS invariant
    # still holds; the STALE path simply could not emit. Not a fail.
    if type record_trust_event_bash >/dev/null 2>&1; then
        bad "case15 trust-event file" "record_trust_event_bash available but no trust-events.jsonl"
    else
        ok "case15 STALE trust-event skipped (record_trust_event_bash unavailable in harness)"
    fi
fi

# ---------------------------------------------------------------------------
echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
