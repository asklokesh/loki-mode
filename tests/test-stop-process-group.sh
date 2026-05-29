#!/usr/bin/env bash
# v7.7.34 regression test: Stop must kill the AGENT, not just the orchestrator.
# Root cause of the recurring "dashboard says stopped but it keeps running" bug:
# the claude/codex/aider agent is a child of the orchestrator; killing only the
# orchestrator pid orphans the agent (reparents to init, keeps editing files).
# Fix: launch the orchestrator as a session/process-group leader and kill the
# whole GROUP (kill -- -PGID), plus a cwd+sentinel agent sweep backstop.
#
# Covers: (A) group-kill reaps a SIGTERM-ignoring child; (B) the dashboard
# endpoint kills orchestrator+agent via the recorded pgid; (C) the sentinel
# agent sweep is project-scoped (spares interactive sessions + other projects);
# (D) suicide guards (pgid empty/0/1/own group); (E) static wiring checks.
set -u
PY=$(command -v python3.12 || command -v python3)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# session-leader launcher available? (setsid binary, else perl, else python3)
SESS=""
if command -v setsid >/dev/null 2>&1; then SESS="setsid"
elif command -v perl >/dev/null 2>&1; then SESS="perl"
elif command -v python3 >/dev/null 2>&1; then SESS="python"; fi

launch_session_leader() { # runs "$@" as a new session leader, backgrounded; echoes nothing
    case "$SESS" in
        setsid) setsid "$@" >/dev/null 2>&1 & ;;
        perl)   perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or exit 127;' "$@" >/dev/null 2>&1 & ;;
        python) python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" >/dev/null 2>&1 & ;;
        *)      "$@" >/dev/null 2>&1 & ;;
    esac
}

# --- static wiring -----------------------------------------------------------
grep -q '_loki_new_session_exec' "$REPO_ROOT/autonomy/loki" \
  && ok "loki launches the runner as a session leader (_loki_new_session_exec)" \
  || bad "loki missing session-leader launch"
grep -q 'loki.pgid' "$REPO_ROOT/autonomy/run.sh" \
  && ok "run.sh records the orchestrator pgid (.loki/loki.pgid)" \
  || bad "run.sh does not record pgid"
grep -q 'kill -TERM -- -"\$_spgid"' "$REPO_ROOT/autonomy/loki" \
  && ok "loki stop group-kills via kill -- -PGID" || bad "loki stop missing group-kill"
grep -q '_killpg_project' "$REPO_ROOT/dashboard/server.py" \
  && ok "server.py defines _killpg_project (group-kill)" || bad "server.py missing _killpg_project"
grep -q 'LOKI-AUTONOMY-AGENT' "$REPO_ROOT/dashboard/server.py" \
  && ok "server.py reaper matches the agent sentinel" || bad "server.py reaper missing sentinel"
grep -q 'LOKI-AUTONOMY-AGENT' "$REPO_ROOT/providers/claude.sh" \
  && ok "claude.sh injects the [LOKI-AUTONOMY-AGENT] sentinel" || bad "sentinel missing from claude.sh"
# both stop endpoints call group-kill
[ "$(grep -c '_killpg_project, _p' "$REPO_ROOT/dashboard/server.py")" -ge 2 ] \
  && ok "both stop endpoints invoke group-kill" || bad "group-kill not wired into both endpoints"

bash -n "$REPO_ROOT/autonomy/loki" && ok "autonomy/loki passes bash -n" || bad "loki syntax error"
bash -n "$REPO_ROOT/autonomy/run.sh" && ok "autonomy/run.sh passes bash -n" || bad "run.sh syntax error"
$PY -c "import ast; ast.parse(open('$REPO_ROOT/dashboard/server.py').read())" \
  && ok "dashboard/server.py parses" || bad "server.py syntax error"

# --- A: group-kill reaps a SIGTERM-ignoring child ----------------------------
WORK=$(mktemp -d "${TMPDIR:-/tmp}/loki-pgtest-XXXXXX")
cat > "$WORK/orch.sh" <<'EOF'
#!/usr/bin/env bash
# child ignores SIGTERM (worst case), stays in leader's group
( trap "" TERM; exec sleep 300 ) &
echo $! > "$1/child.pid"
sleep 300
EOF
chmod +x "$WORK/orch.sh"
launch_session_leader bash "$WORK/orch.sh" "$WORK"
# Poll (not a fixed sleep) for the session leader + child to appear; perl/setsid
# + bash startup can exceed 1s under load, which previously raced the discovery.
LEADER=""
_t=0
while [ "$_t" -lt 80 ]; do   # up to ~8s
    LEADER=$(pgrep -f "$WORK/orch.sh" | head -1)
    [ -n "$LEADER" ] && [ -f "$WORK/child.pid" ] && break
    sleep 0.1; _t=$((_t+1))
done
MY_PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
if [ -n "$LEADER" ]; then
    PGID=$(ps -o pgid= -p "$LEADER" 2>/dev/null | tr -d ' ')
    CHILD=$(cat "$WORK/child.pid" 2>/dev/null)
    cpg=$(ps -o pgid= -p "$CHILD" 2>/dev/null | tr -d ' ')
    [ "$cpg" = "$PGID" ] && ok "agent child shares the orchestrator process group" \
      || bad "child pgid ($cpg) != leader pgid ($PGID)"
    # SUICIDE GUARD: never group-kill our own (the test runner's) group. If the
    # leader did not detach into its own session (e.g. setsid unavailable), skip
    # the destructive group-kill rather than terminating the test harness.
    if [ -z "$PGID" ] || [ "$PGID" = "$MY_PGID" ]; then
        bad "leader did not get its own process group (PGID=$PGID == test PGID); cannot safely group-kill"
        kill "$LEADER" "$CHILD" 2>/dev/null || true
    else
        kill -TERM -- -"$PGID" 2>/dev/null
        # poll for death (group SIGTERM; child ignores TERM so escalate)
        _t=0; while [ "$_t" -lt 20 ] && { kill -0 "$LEADER" 2>/dev/null || kill -0 "$CHILD" 2>/dev/null; }; do sleep 0.1; _t=$((_t+1)); done
        kill -KILL -- -"$PGID" 2>/dev/null
        _t=0; while [ "$_t" -lt 30 ] && { kill -0 "$LEADER" 2>/dev/null || kill -0 "$CHILD" 2>/dev/null; }; do sleep 0.1; _t=$((_t+1)); done
        if kill -0 "$LEADER" 2>/dev/null || kill -0 "$CHILD" 2>/dev/null; then
            bad "group-kill left survivors (leader or TERM-ignoring child)"
        else
            ok "group-kill reaps the orchestrator AND the SIGTERM-ignoring agent child"
        fi
    fi
else
    bad "could not launch session-leader orchestrator (SESS=$SESS)"
fi
rm -rf "$WORK"; pkill -f "loki-pgtest" 2>/dev/null || true

# --- B+C: dashboard endpoint group-kill + sentinel sweep, project-scoped -----
# Run the Python E2E via a temp FILE executed directly (no `$(... | tail)`
# command-substitution + pipe), because that subshell+pipeline wrapper creates
# process-group churn under load that can race-kill the deliberately-isolated
# other-project fake. The product is correct (verified: the python logic run
# directly never touches the other project); only the bash wrapper was flaky.
_EP_PY=$(mktemp "${TMPDIR:-/tmp}/loki-pgtest-ep-XXXXXX.py")
_EP_OUT=$(mktemp "${TMPDIR:-/tmp}/loki-pgtest-ep-XXXXXX.out")
cat > "$_EP_PY" <<'PYEOF'
import sys, os, tempfile, subprocess, time, shutil, signal
sys.path.insert(0, '.')
from pathlib import Path
from dashboard import server
def alive(p):
    try:
        os.kill(p,0); st=subprocess.run(['ps','-o','state=','-p',str(p)],capture_output=True,text=True).stdout.strip()
        return bool(st) and not st.startswith('Z')
    except OSError: return False
work=tempfile.mkdtemp(prefix='loki-pgtest-w-'); os.makedirs(os.path.join(work,'.loki'))
other=tempfile.mkdtemp(prefix='loki-pgtest-o-'); os.makedirs(os.path.join(other,'.loki'))
res=[]
procs=[]
def _wait(cond, timeout=8.0, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(step)
    return cond()
try:
    # session-leader orchestrator in `work` with a sentinel agent child that
    # IGNORES SIGTERM (worst case). The agent is an in-process perl that sets $0
    # to carry the [LOKI-AUTONOMY-AGENT] sentinel and then sleeps WITHOUT exec
    # (exec would discard the $0 rewrite). ps/pgrep see the rewritten $0.
    orch=tempfile.mktemp(prefix='loki-run-', suffix='.sh')
    agent_perl = (r'''$0="claude --dangerously-skip-permissions --append-system-prompt '''
                  r'''[LOKI-AUTONOMY-AGENT] autonomous agent"; $SIG{TERM}="IGNORE"; '''
                  r'''sleep 300;''')
    open(orch,'w').write(
      '#!/usr/bin/env bash\ncd "%s"\n'
      "perl -e '%s' &\n"
      'echo $! > "%s/.loki/agent.pid"\nsleep 300\n' % (work, agent_perl, work))
    os.chmod(orch,0o755)
    lp=subprocess.Popen(['perl','-e','use POSIX qw(setsid); setsid(); exec @ARGV','bash',orch],
                        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); procs.append(lp)
    # an INTERACTIVE claude in `work` (NO sentinel) -- must survive.
    # start_new_session=True isolates it into its OWN process group so the
    # test harness's own group churn cannot reach it (it must only ever be
    # spared by the PRODUCT logic, not killed by test-fixture side effects).
    inter=subprocess.Popen(['perl','-e','$0="claude --model opus"; sleep 300;'],cwd=work,
                           stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True); procs.append(inter)
    # a SECOND project's agent (sentinel, cwd=other) -- must survive. Also its
    # own session so only product cwd-scoping (not harness churn) can affect it.
    other_agent=subprocess.Popen(['perl','-e','$0="claude --append-system-prompt [LOKI-AUTONOMY-AGENT] other"; sleep 300;'],cwd=other,
                                 stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True); procs.append(other_agent)
    # poll for the orchestrator to appear and for agent.pid to be written
    leader_s = _wait(lambda: subprocess.run(['pgrep','-f',orch],capture_output=True,text=True).stdout.split())
    assert leader_s, "orchestrator did not start"
    leader=int(leader_s[0])
    agent_pid_file = os.path.join(work,'.loki','agent.pid')
    _wait(lambda: os.path.exists(agent_pid_file) and open(agent_pid_file).read().strip())
    pgid=subprocess.run(['ps','-o','pgid=','-p',str(leader)],capture_output=True,text=True).stdout.strip()
    agent=int(open(agent_pid_file).read().strip())
    # ensure both children are actually alive before we stop
    _wait(lambda: alive(agent) and alive(inter.pid) and alive(other_agent.pid))
    open(os.path.join(work,'.loki','loki.pgid'),'w').write(pgid)
    open(os.path.join(work,'.loki','loki.pid'),'w').write(str(leader))
    os.environ['LOKI_DIR']=os.path.join(work,'.loki')
    server._active_project_dir=work
    from fastapi.testclient import TestClient
    c=TestClient(server.app)
    body=c.post('/api/control/stop').json()
    # poll for the orchestrator + agent to die (group SIGTERM->5s->SIGKILL)
    _wait(lambda: not alive(leader) and not alive(agent), timeout=10.0)
    res.append(("orch dead", not alive(leader)))
    res.append(("agent dead (group)", not alive(agent)))
    res.append(("interactive claude survives", alive(inter.pid)))
    res.append(("other-project agent survives", alive(other_agent.pid)))
    res.append(("reported stopped", bool(body.get('process_stopped'))))
    okall = all(v for _,v in res)
    print("EP_OK" if okall else "EP_FAIL: " + ", ".join(f"{k}={v}" for k,v in res))
finally:
    for p in procs:
        try: p.kill(); p.wait(timeout=2)
        except Exception: pass
    try: os.killpg(int(pgid),9)
    except Exception: pass
    try: os.unlink(orch)
    except Exception: pass
    shutil.rmtree(work,ignore_errors=True); shutil.rmtree(other,ignore_errors=True)
PYEOF
"$PY" "$_EP_PY" > "$_EP_OUT" 2>/dev/null
RES=$(tail -1 "$_EP_OUT" 2>/dev/null)
rm -f "$_EP_PY" "$_EP_OUT"
[ "$RES" = "EP_OK" ] && ok "/api/control/stop kills orchestrator+agent via group, spares interactive + other project" || bad "endpoint group-kill: $RES"

# --- D: suicide guards (server _killpg_project refuses bad pgids) ------------
GRES=$($PY - <<'PYEOF' 2>&1 | tail -1
import sys, os
sys.path.insert(0, '.')
from dashboard import server
checks=[]
for bad_pgid in (None, 0, 1, -5, "x"):
    try: checks.append(server._killpg_project(bad_pgid) is False)
    except Exception: checks.append(False)
# own group must be refused
checks.append(server._killpg_project(os.getpgrp()) is False)
print("GUARD_OK" if all(checks) else f"GUARD_FAIL: {checks}")
PYEOF
)
[ "$GRES" = "GUARD_OK" ] && ok "_killpg_project refuses empty/0/1/negative/own-group pgids (no suicide)" || bad "kill guards: $GRES"

# --- no em dashes in changed files -------------------------------------------
if grep -lP '\xe2\x80\x94' "$REPO_ROOT/autonomy/loki" "$REPO_ROOT/autonomy/run.sh" \
     "$REPO_ROOT/dashboard/server.py" "$REPO_ROOT/providers/claude.sh" \
     "$SCRIPT_DIR/test-stop-process-group.sh" >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

pkill -f "loki-pgtest" 2>/dev/null || true
rm -rf "${TMPDIR:-/tmp}"/loki-pgtest-* 2>/dev/null || true
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
