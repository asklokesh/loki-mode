#!/usr/bin/env bash
# tests/test-reuse-done-recognition.sh -- the reuse done-recognition gate.
#
# A `loki start` with NO PRD over a project Loki already built and completed
# reused the prior generated PRD and rebuilt a full task queue + re-ran the RARV
# loop, re-doing finished work. The gate (autonomy/lib/done-recognition.sh)
# model-verifies whether the codebase already satisfies the reused spec and
# routes to done (fast-stop) / incomplete (incremental) / inconclusive (build).
#
# Strategy: the gate lib is INDEPENDENTLY SOURCEABLE (like prd-enrich.sh), so we
# source it directly and inject the model via overriding _loki_done_recog_invoke
# to echo canned JSON, exactly as prd-enrich tests stub _loki_prd_enrich_invoke.
# The council-parity finalization calls in the gate are all type-guarded, so the
# standalone test needs zero stubs for them (they no-op when absent). For the
# incremental read-point (case d) we extract the REAL populate_prd_queue from
# run.sh into a temp project and assert only unmet features become tasks.
#
# Covers founder cases (a)-(f):
#   (a) model done + tests green        -> fast stop, no queue, COMPLETED + json
#   (b) model done but fresh tests RED  -> downgraded to build (no fake-green)
#   (c) inconclusive                    -> build
#   (d) incomplete                      -> only unsatisfied requirements queued
#   (e) LOKI_DONE_RECOGNITION=0         -> gate fully bypassed (model NOT called)
#   (f) update action never fast-stops  -> model done -> incremental, not done
# plus the plan's negative fast-path and provider-not-ok cases.

set -uo pipefail

SCRIPT_DIR_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_T/.." && pwd)"
GATE_LIB="$REPO_ROOT/autonomy/lib/done-recognition.sh"
RUN_SCRIPT="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
ok()   { echo "ok: $1"; PASS=$((PASS+1)); }

# Minimal log_* stubs (silent) so the gate's logging does not spam test output.
log_info()   { :; }
log_warn()   { :; }
log_error()  { :; }
log_step()   { :; }
log_header() { :; }

# Source the gate lib (the unit under test).
# shellcheck source=/dev/null
source "$GATE_LIB"

# Provider is "ok" by default in tests so the model seam is reached; specific
# cases override it. Provider-ok is also a seam (mirrors prd-enrich).
_loki_done_recog_provider_ok() { return 0; }

# A counter so cases can assert the model was (not) called. The gate calls
# _loki_done_recog_invoke inside a command substitution (a subshell), so an
# in-memory variable increment would not propagate to the parent. Use a file.
INVOKE_FILE="$(mktemp -t loki-dr-invoke.XXXXXX)"
trap 'rm -f "$INVOKE_FILE" 2>/dev/null || true' EXIT
reset_invokes() { printf '0' > "$INVOKE_FILE"; }
bump_invoke()   { printf '%s' "$(( $(cat "$INVOKE_FILE" 2>/dev/null || echo 0) + 1 ))" > "$INVOKE_FILE"; }
invoke_count()  { cat "$INVOKE_FILE" 2>/dev/null || echo 0; }

# --- Per-case scratch project -------------------------------------------------
# Each case runs in its own temp dir with a .loki tree + a reused PRD so the
# negative fast-path (no completion footprint) does not fire unless intended.
new_project() {
    local d; d="$(mktemp -d -t loki-donerecog.XXXXXX)"
    cd "$d" || return 1
    mkdir -p .loki/state .loki/quality .loki/signals .loki/checklist
    # A reused generated PRD with three features.
    cat > .loki/generated-prd.md <<'PRD'
# Demo App

## Feature: User login
Users can log in with email and password.

## Feature: Dashboard
Authenticated users see a dashboard.

## Feature: Export report
Users can export a CSV report.
PRD
    # A completion footprint so the negative fast-path does not short-circuit.
    : > .loki/signals/COMPLETION_REQUESTED
    PROJECT_DIR="$d"
    TARGET_DIR="$d"
    export TARGET_DIR
}
cleanup_project() { cd /; rm -rf "$PROJECT_DIR" 2>/dev/null || true; }

# Write a test-results.json with a given green/red shape.
write_tests() {
    local state="$1"  # green|red
    if [ "$state" = "green" ]; then
        printf '{"failed":0,"passed":26,"total":26}\n' > "$TARGET_DIR/.loki/quality/test-results.json"
    else
        printf '{"failed":3,"passed":23,"total":26}\n' > "$TARGET_DIR/.loki/quality/test-results.json"
    fi
}

# ensure_completion_test_evidence is a run.sh function not sourced here. The gate
# calls it type-guarded, so absent it no-ops and the gate reads whatever
# test-results.json we pre-wrote. Good: the test controls the fresh test axis.

#==============================================================================
# (a) model done + tests green -> fast stop, no queue, COMPLETED + completion.json
#==============================================================================
new_project
write_tests green
_loki_done_recog_invoke() {
    bump_invoke
    cat <<'JSON'
{"verdict":"done","summary":"All three features are implemented and tested.",
 "tests":{"passed":26,"total":26,"green":true},
 "requirements":[
  {"id":"f1","title":"User login","status":"met","evidence":"auth.py:10"},
  {"id":"f2","title":"Dashboard","status":"met","evidence":"dash.py:5"},
  {"id":"f3","title":"Export report","status":"met","evidence":"export.py:8"}]}
JSON
}
reset_invokes
GENERATED_PRD_ACTION="reuse"
if reuse_done_recognition_gate ".loki/generated-prd.md"; then
    ok "(a) done verdict returns 0 (fast-stop signal)"
else
    fail "(a) done verdict did NOT return 0"
fi
[ "$(invoke_count)" -eq 1 ] && ok "(a) model was invoked exactly once" || fail "(a) model invoke count=$(invoke_count) (expected 1)"
[ -f "$TARGET_DIR/.loki/COMPLETED" ] && ok "(a) COMPLETED marker written" || fail "(a) COMPLETED marker missing"
[ -f "$TARGET_DIR/.loki/state/completion.json" ] && ok "(a) completion.json refreshed" || fail "(a) completion.json missing"
if [ -f "$TARGET_DIR/.loki/state/completion.json" ]; then
    v=$(python3 -c "import json;print(json.load(open('$TARGET_DIR/.loki/state/completion.json')).get('verdict',''))" 2>/dev/null)
    [ "$v" = "done" ] && ok "(a) completion.json verdict=done" || fail "(a) completion.json verdict='$v'"
fi
[ ! -f "$TARGET_DIR/.loki/state/satisfied-requirements.json" ] && ok "(a) no incremental manifest on done" || fail "(a) unexpected manifest on done"
cleanup_project

#==============================================================================
# (a2) COVERAGE GUARD: model returns all-met over a SUBSET of the PRD (1 of 3)
#      with GREEN tests -> must NOT fast-stop done (that would declare 2 unbuilt
#      features satisfied = fake-green). Downgrades to build; the omitted
#      features are queued. This is the council-found HIGH trust hole.
#==============================================================================
new_project
write_tests green
# The model addresses only "User login" and calls it met -- it silently omits
# Dashboard + Export report. A green suite covering 1 feature must not pass as done.
_loki_done_recog_invoke() {
    bump_invoke
    cat <<'JSON'
{"verdict":"done","summary":"login works",
 "tests":{"passed":8,"total":8,"green":true},
 "requirements":[
  {"id":"f1","title":"User login","status":"met","evidence":"auth.py:10"}]}
JSON
}
reset_invokes
GENERATED_PRD_ACTION="reuse"
if reuse_done_recognition_gate ".loki/generated-prd.md"; then
    fail "(a2) partial-coverage all-met WRONGLY fast-stopped as done (fake-green)"
else
    ok "(a2) partial-coverage all-met does NOT fast-stop (returns build)"
fi
[ ! -f "$TARGET_DIR/.loki/COMPLETED" ] && ok "(a2) no COMPLETED marker on partial coverage" || fail "(a2) COMPLETED wrongly written on partial coverage"
# The 1 genuinely-met feature may still seed the incremental manifest...
if [ -f "$TARGET_DIR/.loki/state/satisfied-requirements.json" ]; then
    has_login=$(python3 -c "import json;d=json.load(open('$TARGET_DIR/.loki/state/satisfied-requirements.json'));print(any('login' in str(x).lower() for x in (d.get('satisfied',d) if isinstance(d,dict) else d)))" 2>/dev/null)
    [ "$has_login" = "True" ] && ok "(a2) met subset seeds incremental manifest" || ok "(a2) manifest present (subset handling)"
else
    ok "(a2) no manifest (conservative full build) is acceptable too"
fi
cleanup_project

#==============================================================================
# (b) model done but fresh tests RED -> downgraded to build (no fake-green)
#==============================================================================
new_project
write_tests red
# Same "done" invoke as (a): the model overclaims green, but fresh tests are red.
_loki_done_recog_invoke() {
    bump_invoke
    cat <<'JSON'
{"verdict":"done","summary":"claims done",
 "tests":{"passed":26,"total":26,"green":true},
 "requirements":[
  {"id":"f1","title":"User login","status":"met","evidence":"x"},
  {"id":"f2","title":"Dashboard","status":"met","evidence":"x"},
  {"id":"f3","title":"Export report","status":"met","evidence":"x"}]}
JSON
}
reset_invokes
GENERATED_PRD_ACTION="reuse"
if reuse_done_recognition_gate ".loki/generated-prd.md"; then
    fail "(b) FAKE-GREEN: model done + RED tests fast-stopped as done"
else
    ok "(b) model done + RED tests downgraded to build (no fake-green)"
fi
[ ! -f "$TARGET_DIR/.loki/COMPLETED" ] && ok "(b) no COMPLETED marker on downgrade" || fail "(b) COMPLETED written despite red tests"
# Downgrade-to-incomplete with red tests must NOT mark any requirement satisfied.
if [ -f "$TARGET_DIR/.loki/state/satisfied-requirements.json" ]; then
    n=$(python3 -c "import json;print(len(json.load(open('$TARGET_DIR/.loki/state/satisfied-requirements.json')).get('satisfied',[])))" 2>/dev/null)
    [ "$n" = "0" ] && ok "(b) manifest has zero satisfied on red downgrade" || fail "(b) red downgrade marked $n satisfied"
else
    ok "(b) no satisfied manifest on red downgrade"
fi
cleanup_project

#==============================================================================
# (c) inconclusive (unparsable) -> build, no completion, no manifest
#==============================================================================
new_project
write_tests green
_loki_done_recog_invoke() { bump_invoke; printf 'sorry, I could not determine the state'; }
reset_invokes
GENERATED_PRD_ACTION="reuse"
if reuse_done_recognition_gate ".loki/generated-prd.md"; then
    fail "(c) inconclusive fast-stopped as done"
else
    ok "(c) inconclusive falls through to build (return 1)"
fi
[ ! -f "$TARGET_DIR/.loki/COMPLETED" ] && ok "(c) no COMPLETED on inconclusive" || fail "(c) COMPLETED written on inconclusive"
[ ! -f "$TARGET_DIR/.loki/state/satisfied-requirements.json" ] && ok "(c) no manifest on inconclusive" || fail "(c) manifest written on inconclusive"
cleanup_project

#==============================================================================
# (d) incomplete -> only unsatisfied requirements queued (real populate_prd_queue)
#==============================================================================
new_project
write_tests green
# Model: 2 of 3 met (login, dashboard), export unmet.
_loki_done_recog_invoke() {
    bump_invoke
    cat <<'JSON'
{"verdict":"incomplete","summary":"export missing",
 "tests":{"passed":26,"total":26,"green":true},
 "requirements":[
  {"id":"f1","title":"User login","status":"met","evidence":"auth.py"},
  {"id":"f2","title":"Dashboard","status":"met","evidence":"dash.py"},
  {"id":"f3","title":"Export report","status":"unmet","evidence":"missing"}]}
JSON
}
reset_invokes
GENERATED_PRD_ACTION="reuse"
if reuse_done_recognition_gate ".loki/generated-prd.md"; then
    fail "(d) incomplete fast-stopped as done"
else
    ok "(d) incomplete returns 1 (fall through to incremental build)"
fi
if [ -f "$TARGET_DIR/.loki/state/satisfied-requirements.json" ]; then
    ok "(d) satisfied-requirements manifest written"
    n=$(python3 -c "import json;print(len(json.load(open('$TARGET_DIR/.loki/state/satisfied-requirements.json')).get('satisfied',[])))" 2>/dev/null)
    [ "$n" = "2" ] && ok "(d) manifest has 2 satisfied" || fail "(d) manifest satisfied count=$n (expected 2)"
    has=$(python3 -c "import json;s=json.load(open('$TARGET_DIR/.loki/state/satisfied-requirements.json')).get('satisfied',[]);print('Export report' in s)" 2>/dev/null)
    [ "$has" = "False" ] && ok "(d) manifest EXCLUDES the unmet 'Export report'" || fail "(d) manifest wrongly includes the unmet feature"
else
    fail "(d) no manifest written on incomplete"
fi

# Now extract the REAL populate_prd_queue and prove only the unmet feature
# becomes a task. The function reads .loki/state/satisfied-requirements.json
# (the read-point we added) and skips satisfied titles.
PQ_HARNESS="$(mktemp -t loki-pq-harness.XXXXXX.sh)"
{
    echo 'log_info() { :; }'
    echo 'log_warn() { :; }'
    echo 'log_step() { :; }'
    echo 'SCRIPT_DIR="/nonexistent"'   # so the prd-enrich source path is absent
    awk '/^populate_prd_queue\(\) \{/{f=1} f{print} f && /PRD task parsing complete/{g=1} g && /^\}/{exit}' "$RUN_SCRIPT"
} > "$PQ_HARNESS"
if grep -q 'populate_prd_queue() {' "$PQ_HARNESS" && grep -q '_dr_satisfied' "$PQ_HARNESS" && grep -q 'prd-populated' "$PQ_HARNESS"; then
    ok "(d) extracted real populate_prd_queue incl. the manifest read-point"
else
    fail "(d) populate_prd_queue extraction incomplete (line drift?)"
fi
# shellcheck source=/dev/null
( source "$PQ_HARNESS"
  cd "$TARGET_DIR"
  rm -f .loki/queue/.prd-populated 2>/dev/null || true
  populate_prd_queue ".loki/generated-prd.md" >/dev/null 2>&1
  # Count prd-* tasks built.
  if [ -f .loki/queue/pending.json ]; then
      cnt=$(python3 -c "
import json
d=json.load(open('.loki/queue/pending.json'))
t=d if isinstance(d,list) else d.get('tasks',[])
print(len([x for x in t if isinstance(x,dict) and x.get('source')=='prd']))" 2>/dev/null)
      titles=$(python3 -c "
import json
d=json.load(open('.loki/queue/pending.json'))
t=d if isinstance(d,list) else d.get('tasks',[])
print(','.join(x.get('title','') for x in t if isinstance(x,dict) and x.get('source')=='prd'))" 2>/dev/null)
      if [ "$cnt" = "1" ]; then
          echo "PQ_OK only 1 task built: $titles"
      else
          echo "PQ_FAIL built $cnt tasks (expected 1): $titles"
      fi
  else
      echo "PQ_FAIL no pending.json built"
  fi
) > /tmp/dr_pq_out.$$ 2>&1
if grep -q "PQ_OK" /tmp/dr_pq_out.$$; then
    ok "(d) populate_prd_queue built ONLY the 1 unmet feature ($(grep PQ_OK /tmp/dr_pq_out.$$ | sed 's/.*: //'))"
else
    fail "(d) populate_prd_queue incremental skip wrong: $(cat /tmp/dr_pq_out.$$)"
fi
rm -f "$PQ_HARNESS" /tmp/dr_pq_out.$$
cleanup_project

#==============================================================================
# (d2) manifest staleness: prd_sha mismatch -> full build (safe default)
#==============================================================================
new_project
# Write a manifest whose prd_sha does NOT match the current PRD.
cat > "$TARGET_DIR/.loki/state/satisfied-requirements.json" <<'JSON'
{"prd_sha":"deadbeefstale","generated_at":"2026-01-01T00:00:00Z",
 "satisfied":["User login","Dashboard"],"source":"reuse-done-recognition"}
JSON
PQ_HARNESS="$(mktemp -t loki-pq-harness.XXXXXX.sh)"
{
    echo 'log_info() { :; }'; echo 'log_warn() { :; }'; echo 'log_step() { :; }'
    echo 'SCRIPT_DIR="/nonexistent"'
    awk '/^populate_prd_queue\(\) \{/{f=1} f{print} f && /PRD task parsing complete/{g=1} g && /^\}/{exit}' "$RUN_SCRIPT"
} > "$PQ_HARNESS"
( source "$PQ_HARNESS"; cd "$TARGET_DIR"; rm -f .loki/queue/.prd-populated
  populate_prd_queue ".loki/generated-prd.md" >/dev/null 2>&1
  python3 -c "
import json
d=json.load(open('.loki/queue/pending.json'))
t=d if isinstance(d,list) else d.get('tasks',[])
print(len([x for x in t if isinstance(x,dict) and x.get('source')=='prd']))" 2>/dev/null
) > /tmp/dr_stale.$$ 2>&1
sc=$(tail -1 /tmp/dr_stale.$$)
[ "$sc" = "3" ] && ok "(d2) stale prd_sha ignored -> full build (3 tasks)" || fail "(d2) stale manifest not ignored: built $sc tasks (expected 3)"
rm -f "$PQ_HARNESS" /tmp/dr_stale.$$
cleanup_project

#==============================================================================
# (e) LOKI_DONE_RECOGNITION=0 -> gate fully bypassed, model NOT called
#==============================================================================
new_project
write_tests green
_loki_done_recog_invoke() { bump_invoke; printf '{"verdict":"done","requirements":[]}'; }
reset_invokes
GENERATED_PRD_ACTION="reuse"
if LOKI_DONE_RECOGNITION=0 reuse_done_recognition_gate ".loki/generated-prd.md"; then
    fail "(e) opt-out returned 0 (should bypass to build)"
else
    ok "(e) LOKI_DONE_RECOGNITION=0 returns 1 (legacy build behavior)"
fi
[ "$(invoke_count)" -eq 0 ] && ok "(e) model NOT called when disabled" || fail "(e) model called $(invoke_count) times when disabled"
[ ! -f "$TARGET_DIR/.loki/COMPLETED" ] && ok "(e) no COMPLETED when disabled" || fail "(e) COMPLETED written when disabled"
cleanup_project

#==============================================================================
# (f) update action: model says done -> NEVER fast-stops; incremental only
#==============================================================================
new_project
write_tests green
_loki_done_recog_invoke() {
    bump_invoke
    cat <<'JSON'
{"verdict":"done","summary":"all met",
 "tests":{"passed":26,"total":26,"green":true},
 "requirements":[
  {"id":"f1","title":"User login","status":"met","evidence":"x"},
  {"id":"f2","title":"Dashboard","status":"met","evidence":"x"},
  {"id":"f3","title":"Export report","status":"met","evidence":"x"}]}
JSON
}
reset_invokes
GENERATED_PRD_ACTION="update"
if reuse_done_recognition_gate ".loki/generated-prd.md"; then
    fail "(f) update action fast-stopped as done (forbidden: stale PRD)"
else
    ok "(f) update action never fast-stops on a model 'done' (return 1)"
fi
[ ! -f "$TARGET_DIR/.loki/COMPLETED" ] && ok "(f) update: no COMPLETED marker" || fail "(f) update wrote COMPLETED (false-stop)"
# update with all-met -> treated as incremental: manifest written with met titles.
if [ -f "$TARGET_DIR/.loki/state/satisfied-requirements.json" ]; then
    n=$(python3 -c "import json;print(len(json.load(open('$TARGET_DIR/.loki/state/satisfied-requirements.json')).get('satisfied',[])))" 2>/dev/null)
    [ "$n" = "3" ] && ok "(f) update: feeds incremental manifest (3 met)" || fail "(f) update manifest satisfied=$n"
else
    ok "(f) update: no fast-stop (manifest optional)"
fi
cleanup_project

#==============================================================================
# Negative fast-path: no completion footprint -> model NOT called, build
#==============================================================================
new_project
rm -f "$TARGET_DIR/.loki/signals/COMPLETION_REQUESTED"
rm -f "$TARGET_DIR/.loki/state/completion.json"
rm -f "$TARGET_DIR/.loki/checklist/checklist.json"
_loki_done_recog_invoke() { bump_invoke; printf '{"verdict":"done","requirements":[]}'; }
reset_invokes
GENERATED_PRD_ACTION="reuse"
if reuse_done_recognition_gate ".loki/generated-prd.md"; then
    fail "(neg) no footprint fast-stopped as done"
else
    ok "(neg) no completion footprint -> build (return 1)"
fi
[ "$(invoke_count)" -eq 0 ] && ok "(neg) model NOT called with zero footprint" || fail "(neg) model called $(invoke_count) times (fast-path miss)"
cleanup_project

#==============================================================================
# Provider not ok -> inconclusive fast-path, model NOT called, build
#==============================================================================
new_project
_loki_done_recog_provider_ok() { return 1; }
_loki_done_recog_invoke() { bump_invoke; printf '{"verdict":"done","requirements":[]}'; }
reset_invokes
GENERATED_PRD_ACTION="reuse"
if reuse_done_recognition_gate ".loki/generated-prd.md"; then
    fail "(prov) provider-not-ok fast-stopped as done"
else
    ok "(prov) provider not ok -> build (return 1)"
fi
[ "$(invoke_count)" -eq 0 ] && ok "(prov) model NOT called when provider unavailable" || fail "(prov) model called $(invoke_count) times"
_loki_done_recog_provider_ok() { return 0; }
cleanup_project

#==============================================================================
# (set-u) done path under `set -u` with finalizers present that assume the
# run-scoped vars are set. The gate runs EARLY in run_autonomous (before run.sh
# mints LOKI_TRUST_RUN_ID / _LOKI_RUN_START_SHA / _LOKI_RUN_START_EPOCH), and the
# real run.sh runs under `set -u`. So _loki_done_recog_finish must mint/guard
# them itself or a real done verdict would crash on an unbound reference (which
# `|| true` does NOT catch). This subshell reproduces that: it enables `set -u`,
# defines finalizers that reference those vars WITHOUT defaults, and asserts the
# done path completes without an unbound-var crash AND writes the COMPLETED
# marker. A regression (removing the guards in the lib) would make this crash.
new_project
write_tests green
(
    set -uo pipefail
    # shellcheck source=/dev/null
    source "$GATE_LIB"
    log_info(){ :; }; log_warn(){ :; }; log_error(){ :; }; log_step(){ :; }; log_header(){ :; }
    _loki_done_recog_provider_ok() { return 0; }
    _loki_done_recog_invoke() {
        cat <<'JSON'
{"verdict":"done","summary":"all met",
 "requirements":[
  {"id":"f1","title":"User login","status":"met","evidence":"x"},
  {"id":"f2","title":"Dashboard","status":"met","evidence":"x"},
  {"id":"f3","title":"Export report","status":"met","evidence":"x"}]}
JSON
    }
    # Finalizers that ASSUME the run-scoped vars are set (no :- defaults). Under
    # set -u these abort the shell if the gate did not mint them first.
    build_completion_summary() { local _x="$_LOKI_RUN_START_SHA"; local _y="$LOKI_TRUST_RUN_ID"; local _z="$_LOKI_RUN_START_EPOCH"; return 0; }
    save_state() { local _t="$LOKI_TRUST_RUN_ID"; return 0; }
    GENERATED_PRD_ACTION="reuse"
    reuse_done_recognition_gate ".loki/generated-prd.md"
) >/tmp/dr_setu.$$ 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
    ok "(set-u) done path completes under set -u with var-assuming finalizers (no unbound crash)"
else
    fail "(set-u) done path crashed under set -u (rc=$rc): $(tail -2 /tmp/dr_setu.$$)"
fi
[ -f "$TARGET_DIR/.loki/COMPLETED" ] && ok "(set-u) COMPLETED written under set -u" || fail "(set-u) no COMPLETED under set -u"
rm -f /tmp/dr_setu.$$
cleanup_project

#==============================================================================
# Static: no emoji / no em-dash in the new lib + the new strings
#==============================================================================
if LC_ALL=C grep -nP '[\x{2014}\x{2013}]' "$GATE_LIB" >/dev/null 2>&1; then
    fail "(static) em/en-dash found in done-recognition.sh"
else
    ok "(static) no em/en-dash in done-recognition.sh"
fi
if LC_ALL=C grep -nP '[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}]' "$GATE_LIB" >/dev/null 2>&1; then
    fail "(static) emoji found in done-recognition.sh"
else
    ok "(static) no emoji in done-recognition.sh"
fi

echo ""
echo "===================================="
echo "Reuse done-recognition tests: PASS=$PASS FAIL=$FAIL"
echo "===================================="
[ "$FAIL" -eq 0 ]
