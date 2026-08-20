#!/usr/bin/env bash
# v7.7.29 regression tests: dashboard <-> CLI <-> Docker integration fixes
# plus the multi-project switcher.
#   - standalone dashboard PID dir is the fixed ~/.loki/dashboard (cwd-stop)
#   - container-aware default bind host (Docker 0.0.0.0)
#   - cmd_api shares the PID dir, parses --host/--port, guards a busy port,
#     persists host/port/scheme
#   - TLS-aware /health readiness probe
#   - --api runs cmd_dashboard_start in a contained subshell
#   - status (human + json) and cleanup check BOTH pid locations
#   - /api/running-projects lists registry projects with live pid status
#   - /api/focus switches the active project (realpath-safe)
#   - auto-register on run.sh start populates the registry
#   - dashboard UI ships the project switcher
set -u
PY=$(command -v python3.12 || command -v python3)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1
LOKI="$REPO_ROOT/autonomy/loki"

# --- static checks on autonomy/loki ---------------------------------------
grep -q 'DASHBOARD_PID_DIR="\${HOME}/.loki/dashboard"' "$LOKI" \
  && ok "standalone dashboard PID dir is fixed ~/.loki/dashboard" \
  || bad "DASHBOARD_PID_DIR not the fixed ~/.loki path"

grep -q 'DASHBOARD_DEFAULT_HOST="0.0.0.0"' "$LOKI" && grep -q '/.dockerenv' "$LOKI" \
  && ok "default bind host is container-aware (0.0.0.0 in Docker)" \
  || bad "default host not container-aware"

grep -q 'local pid_file="$DASHBOARD_PID_FILE"' "$LOKI" \
  && ok "cmd_api shares the standalone DASHBOARD_PID_FILE" \
  || bad "cmd_api does not share DASHBOARD_PID_FILE"

grep -q 'Port \$port is already in use' "$LOKI" \
  && ok "cmd_api guards a busy port" || bad "cmd_api missing port guard"

grep -q 'url_scheme}://\${health_host}:\${port}/health' "$LOKI" \
  && ok "readiness probe uses scheme + /health (TLS/auth safe)" \
  || bad "readiness probe still hardcoded"

grep -q '( cmd_dashboard_start ) ||' "$LOKI" \
  && ! grep -qE '^\s*cmd_dashboard_start 2>/dev/null &' "$LOKI" \
  && ok "--api runs dashboard in a contained subshell" \
  || bad "--api still double-backgrounds"

grep -q 'for _dash_pidf in' "$LOKI" \
  && ok "cmd_cleanup checks both pid locations" || bad "cleanup misses a pid location"

grep -q '_dash_candidates' "$LOKI" \
  && ok "status --json checks both pid locations + side-files" \
  || bad "status --json single-location"

# Bun-route parity: status.ts must ALSO check both pid locations (the bash
# route does), else `loki status` on the default Bun runtime misses a
# standalone dashboard. (Council CONCERN fix.)
if grep -q '_dash_candidates' "$REPO_ROOT/loki-ts/src/commands/status.ts" \
   && grep -q 'dashCandidates' "$REPO_ROOT/loki-ts/src/commands/status.ts"; then
    ok "Bun status.ts mirrors dual pid-location + side-files (bash/Bun parity)"
else
    bad "Bun status.ts not updated for dual pid location (parity regression)"
fi

# auto-register hook present in run.sh
grep -q 'loki_register_running_project running' "$REPO_ROOT/autonomy/run.sh" \
  && ok "run.sh auto-registers the running project" \
  || bad "run.sh does not auto-register"

# dashboard UI switcher shipped
grep -q 'project-switcher' "$REPO_ROOT/dashboard/static/index.html" \
  && grep -q 'running-projects' "$REPO_ROOT/dashboard/static/index.html" \
  && ok "dashboard UI ships the project switcher" \
  || bad "project switcher missing from built dashboard"

# --- syntax ---------------------------------------------------------------
bash -n "$LOKI" && ok "autonomy/loki passes bash -n" || bad "autonomy/loki syntax error"
bash -n "$REPO_ROOT/autonomy/run.sh" && ok "autonomy/run.sh passes bash -n" || bad "run.sh syntax error"
$PY -c "import ast; ast.parse(open('$REPO_ROOT/dashboard/server.py').read())" \
  && ok "dashboard/server.py parses" || bad "server.py syntax error"

# --- functional: /api/running-projects + /api/focus ------------------------
RESULT=$($PY - <<'PYEOF' 2>&1 | tail -1
import sys, os, tempfile, shutil, subprocess, time
sys.path.insert(0, '.')
from dashboard import registry
a = tempfile.mkdtemp(prefix='lkmp-a-'); os.makedirs(os.path.join(a, '.loki'))
b = tempfile.mkdtemp(prefix='lkmp-b-'); os.makedirs(os.path.join(b, '.loki'))
proc = subprocess.Popen(['sleep', '60'])  # genuinely-alive pid
try:
    for path, pid in ((a, proc.pid), (b, 999999)):
        e = registry.register_project(path)
        reg = registry._load_registry()
        reg['projects'][e['id']].update(pid=pid, port=57374, status='running')
        registry._save_registry(reg)
    from dashboard import server
    from fastapi.testclient import TestClient
    c = TestClient(server.app)
    bp = {os.path.realpath(p['path']): p for p in c.get('/api/running-projects').json()['projects']}
    pa, pb = bp.get(os.path.realpath(a)), bp.get(os.path.realpath(b))
    fr = c.post('/api/focus', json={'project_dir': a})
    pa2 = {os.path.realpath(p['path']): p for p in c.get('/api/running-projects').json()['projects']}.get(os.path.realpath(a))
    ok = (pa and pa['running']) and (pb and not pb['running']) and fr.status_code == 200 and (pa2 and pa2['is_active'])
    print("MP_OK" if ok else f"MP_FAIL: alive={pa and pa['running']} dead={pb and pb['running']} focus={fr.status_code} active={pa2 and pa2['is_active']}")
finally:
    proc.terminate()
    registry.unregister_project(a); registry.unregister_project(b)
    shutil.rmtree(a, ignore_errors=True); shutil.rmtree(b, ignore_errors=True)
PYEOF
)
[ "$RESULT" = "MP_OK" ] && ok "/api/running-projects live status + /api/focus switch (realpath-safe)" || bad "multi-project endpoint: $RESULT"

# --- functional: cleanup is exact-registry and launch-token scoped ----------
CLEAN_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/loki-cleanup-owner-XXXXXX")
OWNED_PID=""; REUSED_PID=""; RACE_PID=""; UNRELATED_PID=""
FORGED_PID=""; FORGED_WRAPPER_PID=""; FORGED_MATCHED_PID=""; FRESH_WRAPPER_PID=""; LATE_SPAWN_PID=""
LIVE_PARENT_FORGED_PID=""; WRONG_LIVE_PARENT_PID=""
cleanup_owner_fixture() {
    local fixture_pid
    for fixture_pid in "$OWNED_PID" "$REUSED_PID" "$RACE_PID" "$UNRELATED_PID" \
                       "$FORGED_PID" "$FORGED_WRAPPER_PID" "$FORGED_MATCHED_PID" \
                       "$FRESH_WRAPPER_PID" "$LATE_SPAWN_PID" \
                       "$LIVE_PARENT_FORGED_PID" "$WRONG_LIVE_PARENT_PID"; do
        case "$fixture_pid" in ''|*[!0-9]*) continue ;; esac
        command kill "$fixture_pid" 2>/dev/null || true
        wait "$fixture_pid" 2>/dev/null || true
    done
    case "$CLEAN_ROOT" in
        "${TMPDIR:-/tmp}"/loki-cleanup-owner-*) rm -rf -- "$CLEAN_ROOT" ;;
    esac
}
trap cleanup_owner_fixture EXIT

mkdir -p "$CLEAN_ROOT/project/.loki/pids"

# Victims for the forgery cases are spawned FIRST and must age past the launch
# window before their entries are written, because the forgery under test is
# exactly "a live process that already existed when the entry was created".
/bin/bash -c 'exec -a loki-run-unrelated-205 sleep 120' & UNRELATED_PID=$!
sleep 120 & FORGED_PID=$!
sleep 120 & FORGED_WRAPPER_PID=$!
sleep 120 & FORGED_MATCHED_PID=$!
# Captured at spawn so the entry below can claim this victim's REAL launch time.
FORGED_MATCHED_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

DEAD_PID=4000000
while command kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID + 1)); done

# The refusal window in _cleanup_registry_entry_state is 10s; age well past it so
# no case sits on the boundary. This is the only sleep in the fixture and it is
# what makes the forgeries below forgeries.
sleep 25

# A genuine entry is written on the line after the spawn (see register_pid in
# autonomy/run.sh), so spawn and register each of these as a pair.
#
# A REAL orphan is spawned by a shell that then dies, so the kernel reparents it
# to init. Spawning the victim from this still-live test shell while claiming a
# dead ppid is not an orphan at all, it is the forgery shape: recorded parent dead,
# real parent a live unrelated shell. Use a genuine orphan so this positive case
# proves cleanup still reaps what it owns rather than passing on a dishonest fixture.
spawn_orphan() {
    local pidfile="$CLEAN_ROOT/$1.pid" child waited=0
    # Redirect the child's stdio: a backgrounded process inherits this function's
    # command-substitution pipe as stdout, and $( ) blocks until that pipe closes,
    # which would hang the fixture for the sleep's full duration.
    /bin/bash -c 'sleep 120 >/dev/null 2>&1 </dev/null & echo $! >"'"$pidfile"'"'
    child=$(cat "$pidfile")
    # Poll the child's OWN parentage rather than the spawner's liveness: reparenting
    # to init is the observable that matters, and a reaped spawner pid can be reused.
    while [ "$(ps -o ppid= -p "$child" 2>/dev/null | tr -d ' ')" != "1" ]; do
        waited=$((waited + 1))
        [ "$waited" -gt 50 ] && break
        sleep 0.1
    done
    printf '%s\n' "$child"
}
OWNED_PID=$(spawn_orphan owned)
printf '{"pid":%s,"label":"owned-cleanup-fixture","started":"%s","ppid":%s,"extra":""}\n' \
    "$OWNED_PID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DEAD_PID" \
    >"$CLEAN_ROOT/project/.loki/pids/${OWNED_PID}.json"
RACE_PID=$(spawn_orphan race)
printf '{"pid":%s,"label":"reuse-race-fixture","started":"%s","ppid":%s,"extra":""}\n' \
    "$RACE_PID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DEAD_PID" \
    >"$CLEAN_ROOT/project/.loki/pids/${RACE_PID}.json"

# A wrapper entry that is otherwise perfectly well-formed: spawned and registered
# as a pair, so every launch-token check passes and ONLY the "kind" routing rule
# refuses it. cmd_cleanup must never reap wrappers; run.sh's cleanup_orphan_pids
# owns them behind its parent-dead AND idle AND no-live-child predicate.
FRESH_WRAPPER_PID=$(spawn_orphan fresh-wrapper)
printf '{"pid":%s,"label":"loki-wrapper","started":"%s","ppid":%s,"kind":"wrapper","extra":""}\n' \
    "$FRESH_WRAPPER_PID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DEAD_PID" \
    >"$CLEAN_ROOT/project/.loki/pids/${FRESH_WRAPPER_PID}.json"

# Isolates the UPPER launch bound: `started` is backdated only 5s, so the ctime
# anchor (10s window) still passes, but the pid is spawned AFTER that instant, so
# process_started_at > registered_at + 1. This is the pid-reuse-after-registration
# shape; the lower bound cannot see it because the process is NEWER, not older.
LATE_SPAWN_PID=$(spawn_orphan late-spawn)
printf '{"pid":%s,"label":"late-spawn-fixture","started":"%s","ppid":%s,"extra":""}\n' \
    "$LATE_SPAWN_PID" \
    "$(date -u -r "$(( $(date +%s) - 5 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -d '5 seconds ago' +%Y-%m-%dT%H:%M:%SZ)" \
    "$DEAD_PID" \
    >"$CLEAN_ROOT/project/.loki/pids/${LATE_SPAWN_PID}.json"

# Reused pid: entry long predates the live process now holding that pid.
REUSED_PID=$(spawn_orphan reused)
printf '{"pid":%s,"label":"reused-pid-fixture","started":"2000-01-01T00:00:00Z","ppid":%s,"extra":""}\n' \
    "$REUSED_PID" "$DEAD_PID" \
    >"$CLEAN_ROOT/project/.loki/pids/${REUSED_PID}.json"

# THE REGRESSION (loki-cleanup-process-ownership-205): a same-UID forged entry
# naming an unrelated live pid with a CURRENT started timestamp and a dead ppid.
# Before the bidirectional launch-token bound this was classified OWNED and the
# unrelated process was signalled TERM+KILL on the dead-parent path.
printf '{"pid":%s,"label":"forged-current-token","started":"%s","ppid":%s,"extra":""}\n' \
    "$FORGED_PID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DEAD_PID" \
    >"$CLEAN_ROOT/project/.loki/pids/${FORGED_PID}.json"

# Same forgery tagged as a wrapper: wrappers are reaped by run.sh's
# cleanup_orphan_pids behind its own predicate, never by cmd_cleanup, so the
# attacker-writable "kind" field must not buy a wider launch window here.
printf '{"pid":%s,"label":"loki-wrapper","started":"%s","ppid":%s,"kind":"wrapper","extra":""}\n' \
    "$FORGED_WRAPPER_PID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DEAD_PID" \
    >"$CLEAN_ROOT/project/.loki/pids/${FORGED_WRAPPER_PID}.json"

# Informed variant of the same forgery: `started` is backdated to the victim's
# ACTUAL launch time, so the process-start bound alone is satisfied. Only the
# st_ctime corroboration refuses this, since userspace can rewrite the entry's
# contents and its mtime but cannot backdate ctime.
printf '{"pid":%s,"label":"forged-matched-token","started":"%s","ppid":%s,"extra":""}\n' \
    "$FORGED_MATCHED_PID" "$FORGED_MATCHED_STARTED" "$DEAD_PID" \
    >"$CLEAN_ROOT/project/.loki/pids/${FORGED_MATCHED_PID}.json"
touch -t "$(date -u -r "$(( $(date +%s) - 25 ))" +%Y%m%d%H%M.%S 2>/dev/null \
    || date -u -d '25 seconds ago' +%Y%m%d%H%M.%S)" \
    "$CLEAN_ROOT/project/.loki/pids/${FORGED_MATCHED_PID}.json" 2>/dev/null || true

# THE REGRESSION (loki-cleanup-process-forgery-224): every launch-token check
# above is satisfied HONESTLY here, so this is not caught by any of them. The
# victim is spawned and registered as a genuine pair, so `started`, the ctime
# anchor, and both process-start bounds all pass; the entry is fresh, same-UID
# and correctly permissioned. The single lie is `ppid`: it names a dead pid the
# victim was never a child of, while the victim's REAL parent is this live test
# shell. That lie alone put the entry on cmd_cleanup's dead-parent path and got
# an unrelated live process TERM+KILLed. Refusal must come from binding the
# entry to the victim's actual parentage, not from any timing bound.
sleep 120 & LIVE_PARENT_FORGED_PID=$!
printf '{"pid":%s,"label":"forged-live-parent","started":"%s","ppid":%s,"extra":""}\n' \
    "$LIVE_PARENT_FORGED_PID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DEAD_PID" \
    >"$CLEAN_ROOT/project/.loki/pids/${LIVE_PARENT_FORGED_PID}.json"

# The same lie told the other way: the recorded ppid is ALIVE but is not the
# victim's parent. Without a liveness-aware comparison a check that only expects
# "reparented to 1" would accept this, so both branches are pinned.
sleep 120 & WRONG_LIVE_PARENT_PID=$!
printf '{"pid":%s,"label":"forged-wrong-live-parent","started":"%s","ppid":1,"extra":""}\n' \
    "$WRONG_LIVE_PARENT_PID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$CLEAN_ROOT/project/.loki/pids/${WRONG_LIVE_PARENT_PID}.json"

printf '{"pid":%s,"label":"dead-pid-fixture","started":"2000-01-01T00:00:00Z","ppid":1,"extra":""}\n' \
    "$DEAD_PID" >"$CLEAN_ROOT/project/.loki/pids/${DEAD_PID}.json"

SIGNAL_LOG="$CLEAN_ROOT/signals.log"
CLEAN_OUTPUT="$CLEAN_ROOT/cleanup.out"
LOKI_CLI="$LOKI" LOKI_FIXTURE_DIR="$CLEAN_ROOT/project/.loki" \
    LOKI_SIGNAL_LOG="$SIGNAL_LOG" LOKI_RACE_PID="$RACE_PID" bash -c '
kill() {
    case "${1:-}" in
        -0) command kill -0 "$2" ;;
        -9) printf "KILL %s\n" "$2" >>"$LOKI_SIGNAL_LOG" ;;
        *)
            printf "TERM %s\n" "$1" >>"$LOKI_SIGNAL_LOG"
            if [ "$1" = "$LOKI_RACE_PID" ]; then
                printf "{\"pid\":%s,\"label\":\"reuse-race-fixture\",\"started\":\"2000-01-01T00:00:00Z\",\"ppid\":1,\"extra\":\"\"}\n" \
                    "$1" >"$LOKI_FIXTURE_DIR/pids/${1}.json"
            fi
            ;;
    esac
}
pkill() {
    printf "NAME_SWEEP %s\n" "$*" >>"$LOKI_SIGNAL_LOG"
    return 0
}
sleep() { :; }
export -f kill pkill sleep
LOKI_DIR="$LOKI_FIXTURE_DIR" bash "$LOKI_CLI" cleanup
' >"$CLEAN_OUTPUT" 2>&1
CLEAN_RC=$?

if [ "$CLEAN_RC" -eq 0 ] \
   && grep -qx "TERM $OWNED_PID" "$SIGNAL_LOG" \
   && grep -qx "KILL $OWNED_PID" "$SIGNAL_LOG" \
   && grep -qx "TERM $RACE_PID" "$SIGNAL_LOG" \
   && ! grep -qx "KILL $RACE_PID" "$SIGNAL_LOG" \
   && [ "$(wc -l <"$SIGNAL_LOG" | tr -d ' ')" -eq 3 ] \
   && ! grep -q 'NAME_SWEEP' "$SIGNAL_LOG"; then
    ok "cleanup signals only the exact launch-token-bound PID and never uses a name sweep"
else
    bad "cleanup exact PID signalling" "rc=$CLEAN_RC signals=$(tr '\n' ' ' <"$SIGNAL_LOG" 2>/dev/null)"
fi

if command kill -0 "$RACE_PID" 2>/dev/null \
   && [ -f "$CLEAN_ROOT/project/.loki/pids/${RACE_PID}.json" ] \
   && grep -q "Refusing.*PID=$RACE_PID.*changed before escalation" "$CLEAN_OUTPUT"; then
    ok "PID identity is revalidated before TERM-to-KILL escalation"
else
    bad "PID reuse during escalation did not fail closed"
fi

if command kill -0 "$UNRELATED_PID" 2>/dev/null \
   && ps -o command= -p "$UNRELATED_PID" | grep -q 'loki-run-unrelated-205'; then
    ok "unregistered unrelated loki-run process survives cleanup"
else
    bad "unregistered unrelated loki-run process was affected"
fi

if command kill -0 "$REUSED_PID" 2>/dev/null \
   && [ -f "$CLEAN_ROOT/project/.loki/pids/${REUSED_PID}.json" ] \
   && grep -q "Refusing.*PID=$REUSED_PID" "$CLEAN_OUTPUT"; then
    ok "reused PID with stale launch token fails closed and remains for inspection"
else
    bad "reused PID launch-token refusal failed"
fi

# Regression: the forged-current-token entry must be refused and its unrelated
# victim left completely unsignalled.
if command kill -0 "$FORGED_PID" 2>/dev/null \
   && ! grep -qx "TERM $FORGED_PID" "$SIGNAL_LOG" \
   && ! grep -qx "KILL $FORGED_PID" "$SIGNAL_LOG" \
   && grep -q "Refusing.*PID=$FORGED_PID" "$CLEAN_OUTPUT"; then
    ok "forged entry with a current launch token over an unrelated live PID is refused"
else
    bad "forged current-token entry was accepted" \
        "signals=$(tr '\n' ' ' <"$SIGNAL_LOG" 2>/dev/null)"
fi

if command kill -0 "$FORGED_WRAPPER_PID" 2>/dev/null \
   && ! grep -qx "TERM $FORGED_WRAPPER_PID" "$SIGNAL_LOG" \
   && ! grep -qx "KILL $FORGED_WRAPPER_PID" "$SIGNAL_LOG" \
   && grep -q "Refusing.*PID=$FORGED_WRAPPER_PID" "$CLEAN_OUTPUT"; then
    ok "kind:wrapper does not widen the launch window in cmd_cleanup"
else
    bad "forged wrapper-kind entry was accepted" \
        "signals=$(tr '\n' ' ' <"$SIGNAL_LOG" 2>/dev/null)"
fi

if command kill -0 "$FORGED_MATCHED_PID" 2>/dev/null \
   && ! grep -qx "TERM $FORGED_MATCHED_PID" "$SIGNAL_LOG" \
   && ! grep -qx "KILL $FORGED_MATCHED_PID" "$SIGNAL_LOG" \
   && grep -q "Refusing.*PID=$FORGED_MATCHED_PID" "$CLEAN_OUTPUT"; then
    ok "launch token backdated to the victim's real start is refused by the ctime anchor"
else
    bad "backdated-to-match forgery was accepted" \
        "signals=$(tr '\n' ' ' <"$SIGNAL_LOG" 2>/dev/null)"
fi

if command kill -0 "$FRESH_WRAPPER_PID" 2>/dev/null \
   && ! grep -qx "TERM $FRESH_WRAPPER_PID" "$SIGNAL_LOG" \
   && ! grep -qx "KILL $FRESH_WRAPPER_PID" "$SIGNAL_LOG" \
   && grep -q "Refusing.*PID=$FRESH_WRAPPER_PID" "$CLEAN_OUTPUT"; then
    ok "a well-formed wrapper entry is left to run.sh, never reaped by cmd_cleanup"
else
    bad "cmd_cleanup reaped a wrapper entry it does not own" \
        "signals=$(tr '\n' ' ' <"$SIGNAL_LOG" 2>/dev/null)"
fi

if command kill -0 "$LATE_SPAWN_PID" 2>/dev/null \
   && ! grep -qx "TERM $LATE_SPAWN_PID" "$SIGNAL_LOG" \
   && ! grep -qx "KILL $LATE_SPAWN_PID" "$SIGNAL_LOG" \
   && grep -q "Refusing.*PID=$LATE_SPAWN_PID" "$CLEAN_OUTPUT"; then
    ok "a pid that came to life after its entry was written is refused (reuse shape)"
else
    bad "pid-reuse-after-registration was accepted" \
        "signals=$(tr '\n' ' ' <"$SIGNAL_LOG" 2>/dev/null)"
fi

if command kill -0 "$LIVE_PARENT_FORGED_PID" 2>/dev/null \
   && ! grep -qx "TERM $LIVE_PARENT_FORGED_PID" "$SIGNAL_LOG" \
   && ! grep -qx "KILL $LIVE_PARENT_FORGED_PID" "$SIGNAL_LOG" \
   && grep -q "Refusing.*PID=$LIVE_PARENT_FORGED_PID" "$CLEAN_OUTPUT"; then
    ok "an entry whose dead ppid is not the victim's real parent is refused"
else
    bad "forged parentage over an unrelated live process was accepted" \
        "signals=$(tr '\n' ' ' <"$SIGNAL_LOG" 2>/dev/null)"
fi

if command kill -0 "$WRONG_LIVE_PARENT_PID" 2>/dev/null \
   && ! grep -qx "TERM $WRONG_LIVE_PARENT_PID" "$SIGNAL_LOG" \
   && ! grep -qx "KILL $WRONG_LIVE_PARENT_PID" "$SIGNAL_LOG" \
   && grep -q "Refusing.*PID=$WRONG_LIVE_PARENT_PID" "$CLEAN_OUTPUT"; then
    ok "an entry whose live ppid is not the victim's real parent is refused"
else
    bad "forged live parentage was accepted" \
        "signals=$(tr '\n' ' ' <"$SIGNAL_LOG" 2>/dev/null)"
fi

# The positive control: a GENUINE orphan (spawner dead, reparented to init) is
# still reaped. Without this the parentage binding could pass every case above
# by refusing everything, which would silently disable cleanup altogether.
if grep -qx "TERM $OWNED_PID" "$SIGNAL_LOG" \
   && [ ! -e "$CLEAN_ROOT/project/.loki/pids/${OWNED_PID}.json" ]; then
    ok "a genuinely registered run-owned orphan is still reaped"
else
    bad "parentage binding broke genuine orphan cleanup" \
        "signals=$(tr '\n' ' ' <"$SIGNAL_LOG" 2>/dev/null)"
fi

if [ ! -e "$CLEAN_ROOT/project/.loki/pids/${OWNED_PID}.json" ] \
   && [ ! -e "$CLEAN_ROOT/project/.loki/pids/${DEAD_PID}.json" ] \
   && grep -q 'Results: 1 orphan(s) killed, 1 stale entries cleaned, 9 entry(s) refused' "$CLEAN_OUTPUT"; then
    ok "owned and stale registry entries are handled with honest counts"
else
    bad "cleanup registry result accounting is incorrect" "$(tail -3 "$CLEAN_OUTPUT" | tr '\n' ' ')"
fi

cleanup_owner_fixture
trap - EXIT

# --- no em dashes in changed files ----------------------------------------
if grep -lP '\xe2\x80\x94' "$LOKI" "$REPO_ROOT/autonomy/run.sh" "$REPO_ROOT/dashboard/server.py" tests/test-dashboard-multiproject.sh >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
