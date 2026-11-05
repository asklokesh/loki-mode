#!/usr/bin/env bash
# autonomy/trigger-server.py: one trigger registry, per-source health and auto-pause, red CI
# repair briefs, trusted review responses. No tests/min file covered this server before (the
# old tests/test_trigger*.py files were deleted in v11.102.0). A stub `loki` on PATH records
# each launch, so no model runs. Python loads the module with importlib (hyphenated filename)
# and calls dispatch_event directly; the last section drives the real HTTP server.
#
# Planted defects used to prove each assertion can fail (revert after each):
#   ci-brief          restore `args = ["start"]` in handle_workflow_run_event
#   ci-branch-gate    delete the `branch != default` check
#   ci-dedup          drop workflow_run from Dispatcher.seen_intake
#   autopause         change `>=` to `>` in TriggerHealth.record
#   reset             skip the consecutive_failures reset on exit 0
#   detached-outcome  do not call on_exit in _reap_child
#   jobs-source       drop the AUTOPAUSE_EXEMPT check
#   review            remove the TRUSTED_ASSOCIATIONS check; make _remove_review_clone a no-op
#   cli               make --resume leave paused true
#   http-e2e          route workflow_run to handle_issues_event in TRIGGERS

. "$(dirname "$0")/lib.sh"
need python3
need git
need curl

SRV="$ROOT/autonomy/trigger-server.py"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# Fixture: bare origin with main and feature-x, a clone, and a stub loki.
mkdir -p "$T/bin" "$T/seed"
git init -q -b main "$T/seed"
printf 'one\n' > "$T/seed/a.txt"
git -C "$T/seed" add a.txt && git -C "$T/seed" commit -q -m init
git -C "$T/seed" checkout -q -b feature-x
printf 'two\n' > "$T/seed/b.txt"
git -C "$T/seed" add b.txt && git -C "$T/seed" commit -q -m feat
git clone -q --bare "$T/seed" "$T/origin.git"
git clone -q "$T/origin.git" "$T/repo"
FX_SHA="$(git -C "$T/origin.git" rev-parse feature-x)"
MAIN_SHA="$(git -C "$T/origin.git" rev-parse main)"
cat > "$T/bin/loki" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s|%s\n' "$PWD" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" "$*" >> "$STUB_DIR/calls.log"
sleep "${STUB_SLEEP:-0}"
exit "$(cat "$STUB_DIR/rc" 2>/dev/null || echo 0)"
EOF
chmod +x "$T/bin/loki"
export STUB_DIR="$T" PATH="$T/bin:$PATH"
echo 0 > "$T/rc"

# --- Python driver: in-process dispatch_event scenarios ---
cat > "$T/driver.py" <<'PYEOF'
import importlib.util, json, os, pathlib, sys, time
spec = importlib.util.spec_from_file_location("trigger_server", os.environ["SRV"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
T = pathlib.Path(os.environ["STUB_DIR"])
calls = T / "calls.log"
health = pathlib.Path(".loki/triggers/health.json")

def reset(rc=0, pause_after=None):
    calls.write_text("")
    (T / "rc").write_text("%d\n" % rc)
    health.unlink() if health.exists() else None
    os.environ.pop("LOKI_TRIGGER_PAUSE_AFTER", None)
    if pause_after is not None:
        os.environ["LOKI_TRIGGER_PAUSE_AFTER"] = str(pause_after)

def run_calls():
    out = []
    for l in calls.read_text().splitlines():
        parts = l.split("|", 2)
        if len(parts) == 3 and parts[2].startswith(("start ", "verify-pr ")):
            out.append(l)
    return out

def hj():
    return json.loads(health.read_text()) if health.exists() else {}

def check(desc, cond):
    print(("ok " if cond else "bad ") + desc)

def ci(sha, branch="main", name="CI", default="main", run_id=123):
    repo = {"full_name": "acme/calc"}
    if default:
        repo["default_branch"] = default
    return {"action": "completed", "repository": repo,
            "workflow_run": {"id": run_id, "name": name, "conclusion": "failure", "head_branch": branch,
                             "head_sha": sha, "html_url": "https://github.com/acme/calc/actions/runs/%d" % run_id}}

S1, S2, S3 = "a" * 40, "b" * 40, "c" * 40

# ci-brief
reset()
summary, status = mod.dispatch_event("workflow_run", ci(S1))
rc = run_calls()
check("ci-brief: one start call", len(rc) == 1)
line = rc[0] if rc else ""
check("ci-brief: start --brief ... --pr shape", "|start --brief CI is red" in line and line.endswith(" --pr"))
check("ci-brief: names workflow, run id, log command and sha7",
      "workflow 'CI'" in line and "gh run view 123 --repo acme/calc --log-failed" in line and "aaaaaaa" in line)

# ci-branch-gate
reset()
for br, df in (("feature-x", "main"), ("loki/fix-1", "loki/fix-1"), ("main", "")):
    s, st = mod.dispatch_event("workflow_run", ci(S1, branch=br, default=df))
    check("ci-branch-gate: %s/%s skipped" % (br, df or "none"), st.startswith("skipped (") and (
        "failure on branch" in st if df else "no default_branch" in st))
check("ci-branch-gate: no loki call", len(run_calls()) == 0)

# ci-dedup
d = mod.Dispatcher(workers=1, dry_run=True)
check("ci-dedup: first sighting is new", d.seen_intake("workflow_run", ci(S1)) is False)
check("ci-dedup: same sha, other workflow is a duplicate", d.seen_intake("workflow_run", ci(S1, name="Lint")) is True)
check("ci-dedup: other sha is new", d.seen_intake("workflow_run", ci(S2)) is False)
green = ci(S3); green["workflow_run"]["conclusion"] = "success"
d.seen_intake("workflow_run", green)
check("ci-dedup: a green run does not mask a later red one", d.seen_intake("workflow_run", ci(S3)) is False)

# autopause
reset(rc=1, pause_after=2)
mod.dispatch_event("workflow_run", ci(S1))
mod.dispatch_event("workflow_run", ci(S2))
check("autopause: two start calls", len(run_calls()) == 2)
check("autopause: ci paused with 2 consecutive failures",
      hj().get("ci", {}).get("paused") is True and hj()["ci"]["consecutive_failures"] == 2)
s, st = mod.dispatch_event("workflow_run", ci(S3))
check("autopause: third event reports paused", st == "paused")
check("autopause: no third start call", len(run_calls()) == 2)
ev = pathlib.Path(".loki/triggers/events.log")
check("autopause: events.log has an auto-paused line", ev.exists() and "auto-paused" in ev.read_text())

# reset on success
reset(rc=1, pause_after=5)
mod.dispatch_event("workflow_run", ci(S1))
(T / "rc").write_text("0\n")
mod.dispatch_event("workflow_run", ci(S2))
e = hj().get("ci", {})
check("reset: exit 0 clears consecutive failures", e.get("consecutive_failures") == 0)
check("reset: passed 1 of 2 runs, one duration kept", e.get("passed") == 1 and e.get("runs") == 2 and len(e.get("durations_s", [])) == 1)

# cancelled runs are ignored, 0 disables pausing
reset(rc=143, pause_after=1)
mod.dispatch_event("workflow_run", ci(S1))
check("cancel: exit 143 is not counted", hj().get("ci", {}).get("runs", 0) == 0)
reset(rc=1, pause_after=0)
for i in range(4):
    mod.dispatch_event("workflow_run", ci(chr(97 + i) * 40))
check("pause-after 0: counts but never pauses", hj()["ci"]["runs"] == 4 and hj()["ci"]["paused"] is False)

# detached outcome: past the wait window the reaper records the real exit code
reset(rc=1, pause_after=5)
os.environ["STUB_SLEEP"] = "1"
old_wait = mod.DISPATCH_WAIT_SECONDS
mod.DISPATCH_WAIT_SECONDS = 0.3
s, st = mod.dispatch_event("workflow_run", ci(S1))
mod.DISPATCH_WAIT_SECONDS = old_wait
os.environ.pop("STUB_SLEEP")
check("detached-outcome: dispatch reports fired", st == "fired")
for _ in range(50):
    if hj().get("ci", {}).get("runs") == 1:
        break
    time.sleep(0.1)
check("detached-outcome: reaper recorded 1 run, 1 failure",
      hj().get("ci", {}).get("runs") == 1 and hj()["ci"]["consecutive_failures"] == 1)

# jobs-source
reset(rc=1, pause_after=2)
job = {"spec": "fix the login redirect bug", "job_id": "j1", "source": "slack"}
mod.dispatch_event(mod.JOB_EVENT, dict(job))
check("jobs-source: slack job recorded under slack", hj().get("slack", {}).get("runs") == 1)
reset(rc=1, pause_after=2)
for i in range(4):
    mod.dispatch_event(mod.JOB_EVENT, dict(job, source="jobs", job_id="j%d" % i))
check("jobs-source: direct jobs never auto-pause",
      hj()["jobs"]["runs"] == 4 and hj()["jobs"]["paused"] is False)
reset(rc=1, pause_after=2)
mod.dispatch_event(mod.JOB_EVENT, dict(job, source="evil"))
check("jobs-source: unknown source falls back to jobs", "evil" not in hj() and hj().get("jobs", {}).get("runs") == 1)
mod.HEALTH.set_paused("slack", True)
s, st = mod.dispatch_event(mod.JOB_EVENT, dict(job))
check("jobs-source: a paused source fails the job with a terminal status", st == mod.JOB_STATUS_FAILED)

# review
def review(**kw):
    p = {"action": "submitted", "repository": {"full_name": "acme/calc"},
         "review": {"state": "changes_requested", "author_association": "MEMBER", "body": "please fix",
                    "user": {"login": "rev", "type": "User"}},
         "pull_request": {"number": 5, "state": "open",
                          "head": {"ref": "feature-x", "sha": os.environ["FX_SHA"],
                                   "repo": {"full_name": "acme/calc"}}}}
    for k, v in kw.items():
        cur = p
        parts = k.split("__")
        for part in parts[:-1]:
            cur = cur[part]
        cur[parts[-1]] = v
    return p

reset(rc=0)
s, st = mod.dispatch_event("pull_request_review", review())
rc = run_calls()
check("review: fired", st == "fired")
check("review: one verify-pr respond call", len(rc) == 1 and rc[0].endswith("|verify-pr respond acme/calc#5"))
cwd_part, branch_part = (rc[0].split("|")[0], rc[0].split("|")[1]) if rc else ("", "")
check("review: ran in a clone under .loki/triggers/review on feature-x",
      "/.loki/triggers/review/pr-5-" in cwd_part and branch_part == "feature-x")
check("review: clone removed afterwards", not os.path.exists(cwd_part))
for desc, kw in (("author NONE", {"review__author_association": "NONE"}),
                 ("state approved", {"review__state": "approved"}),
                 ("fork head", {"pull_request__head__repo": {"full_name": "evil/calc"}}),
                 ("moved head sha", {"pull_request__head__sha": "d" * 40}),
                 ("bot reviewer", {"review__user": {"login": "x[bot]", "type": "Bot"}}),
                 ("closed PR", {"pull_request__state": "closed"}),
                 ("bad ref", {"pull_request__head__ref": "../x"})):
    reset(rc=0)
    s, st = mod.dispatch_event("pull_request_review", review(**kw))
    check("review: %s is not run" % desc, st.startswith(("skipped", "rejected")) and len(run_calls()) == 0)
reset(rc=1, pause_after=1)
mod.dispatch_event("pull_request_review", review())
check("review: a failed respond run pauses the review source", hj().get("review", {}).get("paused") is True)
PYEOF

out="$(cd "$T/repo" && SRV="$SRV" FX_SHA="$FX_SHA" python3 -I "$T/driver.py" 2>&1)"
rcode=$?
printf '%s\n' "$out" | while IFS= read -r l; do
    case "$l" in
        "ok "*) printf '  PASS: %s\n' "${l#ok }" ;;
        "bad "*) printf '  FAIL: %s\n' "${l#bad }" ;;
        ERROR:root:*|INFO:root:*|WARNING:root:*) ;;
        *) printf '  note: %s\n' "$l" ;;
    esac
done
# the loop above ran in a subshell, so count from the captured text
_min_pass=$((_min_pass + $(printf '%s\n' "$out" | grep -c '^ok ')))
_min_fail=$((_min_fail + $(printf '%s\n' "$out" | grep -c '^bad ')))
[ "$rcode" -eq 0 ] && ok "driver exited 0" || bad "driver exited $rcode"

# --- CLI: loki trigger status / resume ---
cd "$T/repo" || exit 2
# state from the last driver scenario leaves review paused; make ci paused explicitly
python3 -I - <<'EOF'
import json, pathlib
p = pathlib.Path(".loki/triggers/health.json")
d = json.loads(p.read_text())
d["ci"] = {"runs": 3, "passed": 0, "consecutive_failures": 3, "paused": True, "paused_at": "2026-11-04T00:00:00Z", "durations_s": []}
p.write_text(json.dumps(d))
EOF
st_out="$(bash "$ROOT/autonomy/loki" trigger status 2>&1)"
has "cli: status prints the ci line" "$st_out" "ci: runs 3"
has "cli: status shows PAUSED" "$st_out" "PAUSED"
bash "$ROOT/autonomy/loki" trigger resume ci >/dev/null 2>&1
rc_resume=$?
[ "$rc_resume" -eq 0 ] && ok "cli: resume ci exits 0" || bad "cli: resume ci exits $rc_resume"
state="$(python3 -I -c 'import json;e=json.load(open(".loki/triggers/health.json"))["ci"];print(e["paused"],e["consecutive_failures"])')"
[ "$state" = "False 0" ] && ok "cli: resume clears paused and the failure count" || bad "cli: resume left '$state'"
nosuch="$(bash "$ROOT/autonomy/loki" trigger resume nosuch 2>&1)"; rc_no=$?
[ "$rc_no" -ne 0 ] && ok "cli: unknown source exits non-zero" || bad "cli: unknown source exited 0"
has "cli: unknown source names the known ones" "$nosuch" "known: "
bash "$ROOT/autonomy/loki" trigger resume >/dev/null 2>&1 && bad "cli: resume without a source must fail" || ok "cli: resume without a source fails"
bash "$ROOT/autonomy/loki" trigger pause ci >/dev/null 2>&1 && bad "cli: no manual pause subcommand (auto-pause only)" || ok "cli: no manual pause subcommand (auto-pause only)"

# --- HTTP end to end: signed workflow_run reaches the stub loki; /status has triggers ---
rm -rf "$T/repo/.loki"; : > "$T/calls.log"; echo 0 > "$T/rc"
PORT="$(python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
SECRET="test-secret-$$"; export SECRET
python3 "$SRV" --port "$PORT" --secret "$SECRET" > "$T/server.log" 2>&1 &
SRV_PID=$!
trap 'kill "$SRV_PID" 2>/dev/null; _min_cleanup' EXIT
up=0
for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { up=1; break; }
    curl -s -o /dev/null "http://127.0.0.1:$PORT/status" 2>/dev/null && { up=1; break; }
    sleep 0.1
done
[ "$up" -eq 1 ] && ok "http: server is up" || bad "http: server did not start"
body="$(python3 -I -c '
import json
print(json.dumps({"action":"completed","repository":{"full_name":"acme/calc","default_branch":"main"},
 "workflow_run":{"id":777,"name":"CI","conclusion":"failure","head_branch":"main","head_sha":"e"*40,
 "html_url":"https://github.com/acme/calc/actions/runs/777"}}))')"
sig="sha256=$(printf '%s' "$body" | python3 -I -c 'import hmac,hashlib,sys,os;print(hmac.new(os.environ["SECRET"].encode(),sys.stdin.buffer.read(),hashlib.sha256).hexdigest())')"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/webhook" \
    -H "X-GitHub-Event: workflow_run" -H "X-GitHub-Delivery: d-$$-1" -H "X-Hub-Signature-256: $sig" \
    -H 'Content-Type: application/json' --data-binary "$body")"
[ "$code" = "202" ] && ok "http: signed workflow_run accepted (202)" || bad "http: workflow_run returned $code"
seen=0
for _ in $(seq 1 50); do
    grep -q '|start --brief CI is red .* --pr$' "$T/calls.log" && { seen=1; break; }
    sleep 0.1
done
[ "$seen" -eq 1 ] && ok "http: stub loki got start --brief ... --pr" || bad "http: no start call reached the stub"
status_json="$(curl -s "http://127.0.0.1:$PORT/status")"
has "http: /status has triggers" "$status_json" '"triggers"'
case "$status_json" in *enabled_events*) bad "http: /status still has enabled_events" ;; *) ok "http: /status has no enabled_events" ;; esac
kill "$SRV_PID" 2>/dev/null
trap _min_cleanup EXIT

finish
