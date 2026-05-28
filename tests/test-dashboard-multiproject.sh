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

# --- no em dashes in changed files ----------------------------------------
if grep -lP '\xe2\x80\x94' "$LOKI" "$REPO_ROOT/autonomy/run.sh" "$REPO_ROOT/dashboard/server.py" tests/test-dashboard-multiproject.sh >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
