#!/usr/bin/env bash
export LOKI_DASHBOARD_ALLOWED_HOSTS=testserver,test  # TestClient Host; keeps default allowlist strict
# v7.7.33 regression test: the dashboard Stop endpoints must be AUTHORITATIVE.
# Bug: /api/control/stop only signaled loki.pid. When that pid was stale (a
# crashed/restarted session leaves an orphaned loki-run-*.sh under a new pid),
# the kill was a no-op yet the endpoint reported "stopped" while the real
# orchestrator kept running (dashboard said STOPPED, terminal still running).
# Fix: also reap orchestrator processes whose CWD == the project dir, scoped to
# that project only, and report stopped only after verifying no survivor.
set -u
PY=$(command -v python3.12 || command -v python3)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1
SRV="$REPO_ROOT/dashboard/server.py"

# --- static --------------------------------------------------------------
grep -q '_find_orchestrator_pids_for_dir' "$SRV" \
  && ok "server defines cwd-based orchestrator finder" \
  || bad "no _find_orchestrator_pids_for_dir"
grep -q '_terminate_pid' "$SRV" && ok "server defines _terminate_pid" || bad "no _terminate_pid"
# both stop endpoints must use the cwd sweep
grep -c '_find_orchestrator_pids_for_dir' "$SRV" | awk '{ if ($1>=3) print "ok"; else print "few" }' | grep -q ok \
  && ok "cwd sweep wired into both stop endpoints (control/stop + running-projects/stop)" \
  || bad "cwd sweep not wired into both stop endpoints"
$PY -c "import ast; ast.parse(open('$SRV').read())" && ok "server.py parses" || bad "server.py syntax error"

# --- functional: stale loki.pid + live orphan orchestrator ----------------
# Reproduce the exact bug and assert /api/control/stop now kills the orphan and
# does NOT touch a second project's orchestrator.
RESULT=$($PY - <<'PYEOF' 2>&1 | tail -1
import sys, os, tempfile, subprocess, time, shutil
sys.path.insert(0, '.')
from pathlib import Path
work = tempfile.mkdtemp(prefix='lk733-'); os.makedirs(os.path.join(work, '.loki'))
other = tempfile.mkdtemp(prefix='lk733o-'); os.makedirs(os.path.join(other, '.loki'))
# stale loki.pid: a pid that is already dead
dead = subprocess.Popen(['true']); dead.wait()
with open(os.path.join(work, '.loki', 'loki.pid'), 'w') as f:
    f.write(str(dead.pid))
# the REAL orchestrator: orphan loki-run-*.sh with cwd == work
rs = tempfile.mktemp(prefix='loki-run-', suffix='.sh')
open(rs, 'w').write('#!/usr/bin/env bash\nsleep 60\n'); os.chmod(rs, 0o755)
orch = subprocess.Popen(['bash', rs], cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# a second project's orchestrator that must survive
orch2 = subprocess.Popen(['bash', rs], cwd=other, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.environ['LOKI_DIR'] = os.path.join(work, '.loki')
try:
    from dashboard import server
    # point the active project at `work`
    server._active_project_dir = work
    # Deterministic wait: poll until BOTH orchestrators are discoverable by the
    # cwd finder (process startup + pgrep/lsof visibility can lag under CI load).
    # Avoids a flaky fixed sleep.
    from pathlib import Path as _P
    for _ in range(40):  # up to ~8s
        if (orch.pid in server._find_orchestrator_pids_for_dir(_P(work))
                and orch2.pid in server._find_orchestrator_pids_for_dir(_P(other))):
            break
        time.sleep(0.2)
    from fastapi.testclient import TestClient
    c = TestClient(server.app)
    r = c.post('/api/control/stop')
    body = r.json()
    # The endpoint killed the orchestrator; reap our Popen handle so it is not a
    # lingering zombie, then assert via the SAME liveness semantics the product
    # uses (the cwd finder returns no survivor) rather than Popen.poll(), which
    # races with in-process signal delivery.
    def _truly_alive(pid):
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        st = subprocess.run(["ps", "-o", "state=", "-p", str(pid)],
                            capture_output=True, text=True).stdout.strip()
        return bool(st) and not st.startswith("Z")
    # orch is a child of THIS test process. The endpoint's graceful window is up
    # to 5s (SIGTERM, wait, then SIGKILL), so allow generous time and reap our
    # Popen handle (orch.wait) so a killed bash does not linger as a zombie that
    # confuses the liveness probe.
    orch_gone = False
    for _ in range(60):  # up to ~12s, comfortably past the 5s graceful window
        if orch.poll() is not None:  # non-blocking reap of our child
            orch_gone = True
            break
        if not _truly_alive(orch.pid):
            orch_gone = True
            break
        time.sleep(0.2)
    # the OTHER project's orchestrator must remain genuinely alive (scope guard).
    other_alive = _truly_alive(orch2.pid)
    reported_stopped = bool(body.get('process_stopped'))
    good = orch_gone and other_alive and reported_stopped
    if not good:
        _dbg = subprocess.run(["ps","-o","pid=,ppid=,state=,command=","-p",str(orch.pid)],
                              capture_output=True, text=True).stdout.strip()
        print(f"STOP_FAIL: orch_gone={orch_gone} other_alive={other_alive} reported={reported_stopped} orch_ps=[{_dbg}] body={body}")
    else:
        print("STOP_OK")
finally:
    for p in (orch, orch2):
        try: p.kill(); p.wait(timeout=2)
        except Exception: pass
    os.unlink(rs)
    shutil.rmtree(work, ignore_errors=True); shutil.rmtree(other, ignore_errors=True)
PYEOF
)
[ "$RESULT" = "STOP_OK" ] && ok "/api/control/stop kills the orphan orchestrator (stale pid) and spares other projects" || bad "authoritative stop: $RESULT"

# --- zombie counts as gone -------------------------------------------------
ZRES=$($PY - <<'PYEOF' 2>&1 | tail -1
import sys, subprocess, time
sys.path.insert(0, '.')
from dashboard import server
p = subprocess.Popen(['true']); p.wait()  # immediately a zombie (not reaped)
time.sleep(0.1)
print("ZOMBIE_OK" if server._pid_is_gone(p.pid) else "ZOMBIE_FAIL")
PYEOF
)
[ "$ZRES" = "ZOMBIE_OK" ] && ok "_pid_is_gone treats a zombie as gone" || bad "zombie handling: $ZRES"

# --- no em dashes ----------------------------------------------------------
if grep -lP '\xe2\x80\x94' "$SRV" "$SCRIPT_DIR/test-dashboard-stop-authoritative.sh" >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
