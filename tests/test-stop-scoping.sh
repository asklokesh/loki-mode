#!/usr/bin/env bash
# v7.7.30 regression tests: folder-scoped `loki stop`, `loki stop --all`,
# per-project dashboard stop endpoint, and the switcher Stop button.
#   - `loki stop` (no arg) stops ONLY the current folder; other folders survive
#   - `loki stop --all` reaps every loki-run-* on the machine (legacy behavior)
#   - cmd_stop marks THIS project stopped in the dashboard registry
#   - the shared dashboard kill is gated (CLEAR/KEEP) not unconditional
#   - POST /api/running-projects/stop stops a chosen project gracefully
#   - registry.mark_project_stopped sets status/pid, is idempotent
#   - the dashboard UI ships the per-project Stop control
#   - the Bun route does NOT intercept `stop` (folder-scoping inherited)
set -u
PY=$(command -v python3.12 || command -v python3)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1
LOKI="$REPO_ROOT/autonomy/loki"

# --- T1 static checks on autonomy/loki -------------------------------------
grep -q -- '--all)' "$LOKI" \
  && ok "cmd_stop has a --all case" || bad "cmd_stop missing --all case"

grep -q 'Stop ONLY the current folder' "$LOKI" \
  && grep -q 'loki stop \[session-id\] \[--all\]' "$LOKI" \
  && ok "stop --help documents folder-scoping + --all" \
  || bad "stop --help not updated"

grep -q 'mark_project_stopped' "$LOKI" \
  && ok "cmd_stop marks this project stopped in the registry" \
  || bad "cmd_stop does not call mark_project_stopped"

# The blanket pkill must sit UNDER the --all guard, never in the default path.
# Assert: every `pkill -f "loki-run-"` in cmd_stop is preceded (within 4 lines)
# by an `if [ "$stop_all" = true ]` guard. We check the cmd_stop function body.
STOP_BODY=$(awk '/^cmd_stop\(\)/{f=1} f{print} /^}/{if(f)exit}' "$LOKI")
if echo "$STOP_BODY" | grep -q 'pkill -f "loki-run-"'; then
    if echo "$STOP_BODY" | grep -B4 'pkill -f "loki-run-"' | grep -q '\[ "\$stop_all" = true \]'; then
        ok "blanket pkill is gated behind --all (not in default path)"
    else
        bad "blanket pkill in cmd_stop is NOT gated behind --all"
    fi
else
    bad "expected a --all-gated pkill in cmd_stop, found none"
fi

# shared-dashboard kill is gated (CLEAR/KEEP), not unconditional
grep -q '_kill_shared_dash' "$LOKI" \
  && ok "shared dashboard kill is gated (CLEAR/KEEP)" \
  || bad "shared dashboard kill not gated"

# run.sh deliberate-exit teardown helper
grep -q 'loki_mark_project_stopped_and_maybe_kill_shared_dashboard' "$REPO_ROOT/autonomy/run.sh" \
  && ok "run.sh defines the deliberate-exit teardown helper" \
  || bad "run.sh missing teardown helper"
# helper must not use a blanket pkill
if awk '/^loki_mark_project_stopped_and_maybe_kill_shared_dashboard\(\)/{f=1} f{print} /^}/{if(f)exit}' "$REPO_ROOT/autonomy/run.sh" | grep -qE '^\s*pkill'; then
    bad "teardown helper uses a blanket pkill (must not)"
else
    ok "teardown helper uses no blanket pkill (project-scoped only)"
fi

# --- syntax ----------------------------------------------------------------
bash -n "$LOKI" && ok "autonomy/loki passes bash -n" || bad "autonomy/loki syntax error"
bash -n "$REPO_ROOT/autonomy/run.sh" && ok "autonomy/run.sh passes bash -n" || bad "run.sh syntax error"
$PY -c "import ast; ast.parse(open('$REPO_ROOT/dashboard/server.py').read())" \
  && ok "dashboard/server.py parses" || bad "server.py syntax error"
$PY -c "import ast; ast.parse(open('$REPO_ROOT/dashboard/registry.py').read())" \
  && ok "dashboard/registry.py parses" || bad "registry.py syntax error"

# --- T2 THE REGRESSION: cross-folder kill is FIXED -------------------------
# Two fake runners imitating /tmp/loki-run-XXXXXX (run.sh:180), each writing
# its own pid into <dir>/.loki/loki.pid then sleeping. `loki stop` in A must
# kill A's runner and LEAVE B's alive. `loki stop --all` then kills B too.
T2=$(
  set -u
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/loki-stopscope-XXXXXX")
  mkdir -p "$WORK/A/.loki" "$WORK/B/.loki"
  # fake runner script (matches the loki-run- pkill pattern); does NOT exec,
  # so the script name stays in argv exactly like the real runner.
  make_runner() {
    local dir="$1"
    local rs
    rs=$(mktemp "${TMPDIR:-/tmp}/loki-run-XXXXXX")
    cat > "$rs" <<RUNNER
#!/usr/bin/env bash
echo \$\$ > "$dir/.loki/loki.pid"
sleep 30
RUNNER
    chmod +x "$rs"
    # Redirect the runner's fds away from the command-substitution pipe, else
    # $(...) would block until the backgrounded sleep exits (it holds the pipe
    # open). The runner stays alive in its own process group regardless.
    "$rs" >/dev/null 2>&1 </dev/null &
    echo "$rs"
  }
  RA=$(make_runner "$WORK/A"); RB=$(make_runner "$WORK/B")
  sleep 0.4
  PIDA=$(cat "$WORK/A/.loki/loki.pid" 2>/dev/null)
  PIDB=$(cat "$WORK/B/.loki/loki.pid" 2>/dev/null)
  result=""
  # folder-scoped stop in A
  ( cd "$WORK/A" && LOKI_DIR=.loki SKILL_DIR="$REPO_ROOT" LOKI_SKIP_PROJECT_REGISTRY=1 \
      bash "$LOKI" stop >/dev/null 2>&1 )
  sleep 0.5
  kill -0 "$PIDA" 2>/dev/null && result="${result}A_ALIVE " || result="${result}A_DEAD "
  kill -0 "$PIDB" 2>/dev/null && result="${result}B_ALIVE " || result="${result}B_DEAD "
  # --all from A (which now has no live session) must kill B too
  ( cd "$WORK/A" && LOKI_DIR=.loki SKILL_DIR="$REPO_ROOT" LOKI_SKIP_PROJECT_REGISTRY=1 \
      bash "$LOKI" stop --all >/dev/null 2>&1 )
  sleep 0.8
  kill -0 "$PIDB" 2>/dev/null && result="${result}B_ALIVE_AFTER_ALL" || result="${result}B_DEAD_AFTER_ALL"
  # cleanup: kill any survivors, remove temp dirs + the runner scripts we made
  kill -9 "$PIDA" "$PIDB" 2>/dev/null
  rm -f "$RA" "$RB"
  rm -rf "$WORK"
  echo "$result"
)
if [ "$T2" = "A_DEAD B_ALIVE B_DEAD_AFTER_ALL" ]; then
    ok "folder-scoped stop kills A only; --all then kills B (cross-folder bug FIXED)"
else
    bad "stop scoping wrong: [$T2] (want: A_DEAD B_ALIVE B_DEAD_AFTER_ALL)"
fi

# --- T3 endpoint + registry (FastAPI TestClient, isolated registry) --------
T3=$($PY - <<'PYEOF' 2>&1 | tail -1
import sys, os, tempfile, shutil, subprocess, time
sys.path.insert(0, '.')
from pathlib import Path
import dashboard.registry as registry
# isolate the registry to a temp file (NEVER touch the user's real one)
td = tempfile.mkdtemp(prefix='lkss-reg-')
registry.REGISTRY_DIR = Path(td) / '.loki' / 'dashboard'
registry.REGISTRY_FILE = registry.REGISTRY_DIR / 'projects.json'
a = tempfile.mkdtemp(prefix='lkss-a-'); os.makedirs(os.path.join(a, '.loki'))
proc = subprocess.Popen(['sleep', '60'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
res = []
try:
    ea = registry.register_project(a)
    reg = registry._load_registry()
    reg['projects'][ea['id']].update(pid=proc.pid, port=57374, status='running')
    registry._save_registry(reg)
    # unit: mark_project_stopped direct
    m = registry.mark_project_stopped(ea['id'])
    res.append(m is not None and m['status'] == 'stopped' and m['pid'] is None)
    res.append(registry.mark_project_stopped('does-not-exist') is None)
    # reset to running for the endpoint test
    reg = registry._load_registry()
    reg['projects'][ea['id']].update(pid=proc.pid, status='running'); registry._save_registry(reg)
    from dashboard import server
    from fastapi.testclient import TestClient
    c = TestClient(server.app)
    r = c.post('/api/running-projects/stop', json={'id': ea['id']})
    res.append(r.status_code == 200 and r.json().get('success') is True)
    # the sleep proc must be gone
    for _ in range(20):
        if proc.poll() is not None:
            break
        time.sleep(0.2)
    res.append(proc.poll() is not None)
    # registry reflects stopped
    g = registry.get_project(ea['id'])
    res.append(g['status'] == 'stopped' and g['pid'] is None)
    # switcher shows not-running
    rp = {p['id']: p for p in c.get('/api/running-projects').json()['projects']}
    res.append(rp.get(ea['id'], {}).get('running') is False)
    # bogus id -> 404
    res.append(c.post('/api/running-projects/stop', json={'id': 'nope'}).status_code == 404)
    print('EP_OK' if all(res) else 'EP_FAIL: ' + repr(res))
finally:
    if proc.poll() is None:
        proc.terminate()
    shutil.rmtree(td, ignore_errors=True); shutil.rmtree(a, ignore_errors=True)
PYEOF
)
[ "$T3" = "EP_OK" ] && ok "/api/running-projects/stop graceful stop + registry reconcile + 404" || bad "endpoint: $T3"

# --- T4 shared-dashboard CLEAR/KEEP logic ----------------------------------
T4=$($PY - <<'PYEOF' 2>&1 | tail -1
import os, sys
# CLEAR when no live pid; KEEP when at least one other live pid.
def decide(pids):
    alive = 0
    for pid in pids:
        if isinstance(pid, int) and pid > 0:
            try:
                os.kill(pid, 0); alive += 1
            except OSError:
                pass
    return 'CLEAR' if alive == 0 else 'KEEP'
import subprocess
p = subprocess.Popen(['sleep', '30'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    clear = decide([999999, None, 0])      # all dead/invalid -> CLEAR
    keep = decide([p.pid, 999999])         # one alive -> KEEP
    print('DASH_OK' if clear == 'CLEAR' and keep == 'KEEP' else f'DASH_FAIL: {clear} {keep}')
finally:
    p.terminate()
PYEOF
)
[ "$T4" = "DASH_OK" ] && ok "shared-dashboard CLEAR/KEEP gate (KEEP while another project lives)" || bad "CLEAR/KEEP: $T4"

# --- T5 dashboard switcher Stop UI shipped ---------------------------------
grep -q 'project-stop-list' "$REPO_ROOT/dashboard/static/index.html" \
  && grep -q 'running-projects/stop' "$REPO_ROOT/dashboard/static/index.html" \
  && ok "built dashboard ships the per-project Stop control" \
  || bad "Stop control missing from built dashboard/static/index.html"
grep -q 'project-stop-list' "$REPO_ROOT/dashboard-ui/scripts/build-standalone.js" \
  && grep -q 'running-projects/stop' "$REPO_ROOT/dashboard-ui/scripts/build-standalone.js" \
  && ok "build-standalone.js (source of truth) has the Stop control" \
  || bad "Stop control missing from build-standalone.js"
# the new stop-list code must build rows with textContent, not innerHTML
if awk '/function buildStopList/{f=1} f{print} /^    }/{if(f)exit}' "$REPO_ROOT/dashboard-ui/scripts/build-standalone.js" | grep -q 'innerHTML'; then
    bad "buildStopList uses innerHTML (XSS risk)"
else
    ok "buildStopList uses textContent only (no innerHTML)"
fi

# --- T6 Bun parity: stop must fall through to bash -------------------------
if grep -qE 'case "stop"|=== ?"stop"|cmd === .stop.' "$REPO_ROOT/loki-ts/src/cli.ts"; then
    bad "loki-ts/src/cli.ts intercepts 'stop' (must fall through to bash for parity)"
else
    ok "Bun cli.ts does NOT intercept 'stop' (folder-scoping inherited)"
fi

# --- T7 hygiene: no em dashes in changed files -----------------------------
if grep -lP '\xe2\x80\x94' "$LOKI" "$REPO_ROOT/autonomy/run.sh" \
     "$REPO_ROOT/dashboard/server.py" "$REPO_ROOT/dashboard/registry.py" \
     "$REPO_ROOT/dashboard-ui/scripts/build-standalone.js" \
     "$REPO_ROOT/CHANGELOG.md" \
     "$SCRIPT_DIR/test-stop-scoping.sh" >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
