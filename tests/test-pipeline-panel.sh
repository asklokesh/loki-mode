#!/usr/bin/env bash
# The build pipeline is visible while it runs.
#
# THE GAP. dashboard/api_phases.py is 262 lines that parse real phase_change
# events into measured segments, with freshness/sampling metadata and an
# explicit refusal to invent unmeasured boundaries. Measured before the fix:
# `grep -n "api_phases" dashboard/server.py` returned NOTHING (no importer) and
# `grep -ac "api/phases" dashboard/static/index.html` returned 0 (no consumer).
# A complete pipeline-timeline module was dead code. Users saw a build finish or
# not; they could not see which phase it was in or where it was stuck.
#
# THE LOAD-BEARING ASSERTIONS are 3 and 4. An unmeasured duration must render
# "not measured", never 0 -- a fabricated zero reads as "this phase was
# instant", which is a claim. And RUNNING must be visually distinct from ENDED,
# because collapsing them shows a stalled build as a healthy one.
#
# THE VACUITY GUARD. tests/test-receipts-panel.sh, which this follows, drives
# the real loader through a regex extraction that ends in `2>/dev/null`. When
# extraction fails the output is EMPTY, and every negative assertion ("does not
# contain a fabricated 0") passes on nothing. _render here fails loudly on an
# empty result so that hole is not inherited.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/dashboard-ui/scripts/build-standalone.js"
SHIPPED="$REPO_ROOT/dashboard/static/index.html"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the build pipeline is visible while it runs"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "  SKIPPED: node not installed (not a pass)"; exit 0; }

# --- 1. THE GAP: the endpoint has a consumer --------------------------------
if grep -q "'/api/phases'" "$SRC"; then
    ok "the phase-timeline endpoint is consumed"
else
    bad "/api/phases still has no consumer -- the pipeline remains invisible"
fi
if grep -q "api_phases" "$REPO_ROOT/dashboard/server.py"; then
    ok "api_phases.py is imported by the server (no longer dead code)"
else
    bad "api_phases.py still has no importer in server.py"
fi

# --- 2. Drive the REAL loader against a stubbed fetch -----------------------
# Extracts window.loadPhases from source and calls it. Hand-writing a copy of
# the render logic here would make every assertion below vacuous: mutating the
# source to fabricate a 0 would leave the test green because it exercised its
# own correct copy.
# THE VACUITY GUARD lives at the CALL SITE, not inside _render: a `bad` called
# inside $( ) runs in a subshell, so the counter increment is discarded and the
# message is captured into the caller's variable instead of printed. Callers use
# `_x="$(_render ...)" || _x=""` and then _nonempty.
_nonempty() {
    if [ -z "$2" ]; then
        bad "$1 rendered NOTHING (extraction/exec failed) -- its assertions would be vacuous"
        return 1
    fi
    return 0
}

_render() {
    _out="$(node -e "
const fs=require('fs');
const src=fs.readFileSync('$SRC','utf8');
const m=src.match(/window\.loadPhases = function \(\) \{[\s\S]*?\n    \};/);
if(!m){console.error('EXTRACT_FAILED');process.exit(2);}
const payload=$1;
const el={'pipeline-panel':{style:{}},'pipeline-list':{innerHTML:''},'pipeline-note':{textContent:''}};
global.document={getElementById:(id)=>el[id],createElement:()=>({set textContent(v){this.innerHTML=String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');},innerHTML:''})};
global.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve(payload)});
global.window=global;
new Function('global', m[0]).call(global, global);
global.loadPhases();
setTimeout(()=>{process.stdout.write(el['pipeline-list'].innerHTML
  + '@@NOTE@@' + el['pipeline-note'].textContent
  + '@@DISPLAY@@' + (el['pipeline-panel'].style.display||''));},50);
")"
    [ -n "$_out" ] || return 1   # caller reports it via _nonempty
    printf '%s' "$_out"
}

# A run with three measured states in one payload: an ENDED segment with a real
# 300s duration, an ongoing RUNNING segment, and a leading phase whose start was
# never emitted.
_MIXED='{"segments":[
  {"phase":"BUILDING","start":1000,"end":1300,"ongoing":false,"iteration":1},
  {"phase":"TESTING","start":1300,"end":null,"ongoing":true,"iteration":2}],
 "leading_phase":{"phase":"BOOTSTRAP","start":null,"end":1000,"iteration":1},
 "freshness_s":5,"sampled":true,"checked_at":1400,"reason":null}'

_out="$(_render "$_MIXED")" || _out=""
_nonempty "the mixed-state payload" "$_out"

# --- 3. An UNMEASURED duration is never a fabricated zero -------------------
# BOOTSTRAP's start was never emitted, so its duration is unmeasurable.
if printf '%s' "$_out" | grep -q 'not measured'; then
    ok "an unmeasured duration renders 'not measured'"
else
    bad "an unmeasured duration was not labelled: $_out"
fi
if printf '%s' "$_out" | grep -q '>0s<'; then
    bad "an unmeasured duration was fabricated as 0s: $_out"
else
    ok "an unmeasured duration is NOT rendered as 0"
fi

# --- 4. RUNNING, ENDED and FAILED are three distinct renderings -------------
# Collapsing running into ended shows a stalled build as a finished one.
if printf '%s' "$_out" | grep -q 'RUNNING'; then
    ok "an ongoing phase renders RUNNING"
else
    bad "an ongoing phase was not marked RUNNING: $_out"
fi
if printf '%s' "$_out" | grep -q 'ENDED'; then
    ok "a completed phase renders ENDED (distinct from RUNNING)"
else
    bad "a completed phase was not distinguished: $_out"
fi
# The leading phase RAN but has no start coordinate -- a third state again.
if printf '%s' "$_out" | grep -q 'start not recorded'; then
    ok "a phase known to have run with no recorded start is named as such"
else
    bad "the leading phase was collapsed into another state: $_out"
fi
_failed="$(_render '{"segments":[{"phase":"FAILED","start":1000,"end":1300,"ongoing":false,"iteration":9}],"leading_phase":null,"freshness_s":5,"sampled":true,"checked_at":1400}')" || _failed=""
_nonempty "the failed-phase payload" "$_failed"
if printf '%s' "$_failed" | grep -q 'FAILED'; then
    ok "a failed phase renders FAILED (distinct from ENDED and RUNNING)"
else
    bad "a failed phase was not surfaced as failed: $_failed"
fi
# FAILED must not ALSO read as a plain ENDED row -- three states, three renders.
if printf '%s' "$_failed" | grep -q 'ENDED'; then
    bad "a FAILED phase also rendered as ENDED -- the states are not distinct"
else
    ok "a FAILED phase does not also read as a clean ENDED"
fi

# --- 5. POSITIVE CONTROL: a real measured duration DOES render --------------
# Without this, "never render 0" could pass by rendering nothing at all.
if printf '%s' "$_out" | grep -q '5m 0s'; then
    ok "POSITIVE CONTROL: a measured 300s duration renders as 5m 0s"
else
    bad "a real measured duration did not render its value: $_out"
fi
# And a genuine ZERO-second phase (two events inside one second -- timestamps
# are second-granular) must still render as 0s. The guard is on the endpoints
# being absent, never on the duration being falsy.
_zero="$(_render '{"segments":[{"phase":"BUILDING","start":1000,"end":1000,"ongoing":false,"iteration":1}],"leading_phase":null,"freshness_s":5,"sampled":true,"checked_at":1400}')" || _zero=""
_nonempty "the measured-zero payload" "$_zero"
if printf '%s' "$_zero" | grep -q '0s' && ! printf '%s' "$_zero" | grep -q 'not measured'; then
    ok "POSITIVE CONTROL: a genuine measured zero still renders as 0s"
else
    bad "a real measured zero was hidden as unmeasured: $_zero"
fi

# --- 6. Stale / sampled data is LABELLED as such ----------------------------
if printf '%s' "$_out" | grep -q 'Sampled'; then
    ok "sampled data is labelled sampled, not presented as complete"
else
    bad "sampled data presented as a complete history: $_out"
fi
_stale="$(_render '{"segments":[{"phase":"BUILDING","start":1000,"end":1300,"ongoing":false,"iteration":1}],"leading_phase":null,"freshness_s":3600,"sampled":true,"checked_at":9999}')" || _stale=""
_nonempty "the stale payload" "$_stale"
if printf '%s' "$_stale" | grep -q 'STALE'; then
    ok "an hour-old phase log is labelled STALE"
else
    bad "stale data was presented as current: $_stale"
fi
# freshness_s === null must not read as "0s ago" (fresh).
_nofresh="$(_render '{"segments":[{"phase":"BUILDING","start":1000,"end":1300,"ongoing":false,"iteration":1}],"leading_phase":null,"freshness_s":null,"sampled":true,"checked_at":1400}')" || _nofresh=""
_nonempty "the unmeasured-freshness payload" "$_nofresh"
if printf '%s' "$_nofresh" | grep -q 'Age of this data: not measured'; then
    ok "an unmeasured data age says so rather than reading as fresh"
else
    bad "unmeasured freshness read as fresh: $_nofresh"
fi

# --- 6b. The panel markup is in the SAME page the loader fires on -----------
# THIS CAUGHT A REAL BUG. The markup first landed in page-insights while
# loadPhases() fires on 'overview'. Every other assertion still passed: IDs are
# global, all section pages are in the DOM, so the stubbed render worked and the
# bundle grep found the panel -- it just rendered on a page nobody was looking
# at. Presence in the file is not presence in the right place.
_page="$(awk '/id="page-[a-z-]+"/ {match($0, /id="page-[a-z-]+"/); pg=substr($0, RSTART+9, RLENGTH-10)} /id="pipeline-panel"/ {print pg; exit}' "$SRC")"
_sect="$(sed -n "s/.*if (sectionId === '\([a-z-]*\)') { loadPhases/\1/p;s/.*if (sectionId === '\([a-z-]*\)') {\$/\1/p" "$SRC" | head -1)"
if [ -n "$_page" ] && grep -q "sectionId === '$_page'" "$SRC" \
   && sed -n "/sectionId === '$_page'/,/^    }/p" "$SRC" | grep -q "loadPhases()"; then
    ok "the panel markup lives in page-$_page and loadPhases fires on that section"
else
    bad "the panel is in page-$_page but loadPhases does not fire for that section"
fi

# --- 6c. A phase name is ESCAPED before it reaches innerHTML ----------------
# Unlike loadReceipts' verdict (a controlled set), phase names pass through
# api_phases.py verbatim and _advance_current_phase accepts ANY string, so this
# is untrusted text on a dashboard that can be bound remotely.
_xss="$(_render '{"segments":[{"phase":"<img src=x onerror=alert(1)>","start":1000,"end":1300,"ongoing":false,"iteration":1}],"leading_phase":null,"freshness_s":5,"sampled":true,"checked_at":1400}')" || _xss=""
_nonempty "the hostile-phase-name payload" "$_xss"
if printf '%s' "$_xss" | grep -q '<img src=x'; then
    bad "a phase name reached innerHTML unescaped: $_xss"
else
    ok "a hostile phase name is escaped before it reaches innerHTML"
fi
# POSITIVE CONTROL: escaping must not blank the name entirely.
if printf '%s' "$_xss" | grep -q 'onerror'; then
    ok "POSITIVE CONTROL: the escaped name is still SHOWN (escaped, not dropped)"
else
    bad "escaping swallowed the phase name instead of escaping it: $_xss"
fi

# --- 6d. The VIEW's own age is stamped, and it refreshes --------------------
# A one-shot fetch of a LIVE pipeline freezes: "RUNNING 1m 40s" would sit there
# unchanged an hour later. That is a stalled build reading as healthy through
# the view's age rather than the data's.
if printf '%s' "$_out" | grep -q 'Measured as of'; then
    ok "the panel stamps when it was measured (a frozen row self-labels)"
else
    bad "no measurement time -- a frozen live view is indistinguishable from a fresh one: $_out"
fi
if grep -q "setInterval(function () {" "$SRC" && grep -q "_lokiPhasePoll" "$SRC"; then
    ok "the live pipeline refreshes rather than rendering once and freezing"
else
    bad "the pipeline is fetched once and never updates while a build runs"
fi

# --- 7. Degrades to SILENCE, never to a wrong surface -----------------------
# Matched on the PROPERTY (the panel's own style carries display:none) rather
# than an exact attribute string: adding a margin to the same style attribute
# broke a literal match against correct code.
if grep -q 'id="pipeline-panel"[^>]*display:none' "$SRC"; then
    ok "the panel is hidden until data arrives"
else
    bad "the panel renders before it has data"
fi
_body="$(sed -n '/window.loadPhases = function/,/^    };/p' "$SRC")"
if printf '%s' "$_body" | grep -q "catch"; then
    ok "a failing phases fetch is caught, not fatal to the page"
else
    bad "an error would break the Overview section"
fi
if printf '%s' "$_body" | grep -q "if (!rows.length) return"; then
    ok "no phase history shows nothing rather than an empty table"
else
    bad "an empty phase set renders a misleading empty surface"
fi
# An ABSENT endpoint (older server: non-ok response -> null) leaves the page
# unchanged: nothing rendered, panel never shown.
_absent="$(node -e "
const fs=require('fs');
const src=fs.readFileSync('$SRC','utf8');
const m=src.match(/window\.loadPhases = function \(\) \{[\s\S]*?\n    \};/);
if(!m){console.error('EXTRACT_FAILED');process.exit(2);}
const el={'pipeline-panel':{style:{display:'none'}},'pipeline-list':{innerHTML:'UNTOUCHED'},'pipeline-note':{textContent:''}};
global.document={getElementById:(id)=>el[id],createElement:()=>({set textContent(v){this.innerHTML=String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');},innerHTML:''})};
global.fetch=()=>Promise.resolve({ok:false,json:()=>Promise.resolve(null)});
global.window=global;
new Function('global', m[0]).call(global, global);
global.loadPhases();
setTimeout(()=>{process.stdout.write(el['pipeline-list'].innerHTML+'|'+el['pipeline-panel'].style.display);},50);
")"
if [ "$_absent" = "UNTOUCHED|none" ]; then
    ok "an absent endpoint leaves the page exactly as it was"
else
    bad "an absent endpoint changed the page: $_absent"
fi

# --- 8. The endpoint returns the MODULE's envelope, not a reshaped one ------
if command -v python3 >/dev/null 2>&1; then
    _env="$(cd "$REPO_ROOT" && python3 -c "
import ast, sys
src = open('dashboard/server.py').read()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == 'phase_timeline':
        body = [n for n in node.body if not isinstance(n, ast.Expr)]
        # Must RETURN the module call directly. A dict/comprehension in the
        # return is a reshape and forks the honesty contract.
        rets = [n for n in body if isinstance(n, ast.Return)]
        if len(rets) != 1:
            print('MULTI_RETURN'); sys.exit(0)
        v = rets[0].value
        if isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) \
                and v.func.attr == 'phase_history':
            print('VERBATIM')
        else:
            print('RESHAPED')
        sys.exit(0)
print('NO_HANDLER')
" 2>/dev/null)"
    if [ "$_env" = "VERBATIM" ]; then
        ok "the endpoint returns phase_history's envelope verbatim"
    else
        bad "the endpoint reshapes the module's envelope ($_env)"
    fi
    # And the module's honesty contract itself: unmeasured is None, never 0.
    _unk="$(cd "$REPO_ROOT" && python3 -c "
from dashboard.api_runs import UNKNOWN
print('NONE' if UNKNOWN is None else repr(UNKNOWN))" 2>/dev/null)"
    if [ "$_unk" = "NONE" ]; then
        ok "the module's UNKNOWN is None (the null checks in the panel match)"
    else
        bad "UNKNOWN is $_unk -- the panel's null checks do not match it"
    fi
else
    echo "  SKIPPED: python3 not installed (endpoint checks not run, not a pass)"
fi

# --- 9. It reached the SHIPPED bundle ---------------------------------------
# grep -a with a positive control: this file has very long lines, and grep
# otherwise treats it as binary and prints NOTHING, which reads as a clean zero.
if [ -f "$SHIPPED" ]; then
    _ctl="$(grep -ac "Inter" "$SHIPPED" 2>/dev/null || echo 0)"
    if [ "${_ctl:-0}" -lt 5 ]; then
        bad "control string missing -- cannot measure the shipped bundle"
    elif grep -aq "pipeline-panel" "$SHIPPED" && grep -aq "api/phases" "$SHIPPED"; then
        ok "the panel AND its endpoint are in the shipped bundle (control found $_ctl times)"
    else
        bad "the shipped bundle has no pipeline panel -- rebuild needed"
    fi
else
    bad "shipped bundle missing"
fi

# --- 10. Syntax -------------------------------------------------------------
node --check "$SRC" 2>/dev/null && ok "build-standalone.js parses" \
    || bad "build-standalone.js has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
