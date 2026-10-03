# shellcheck shell=bash
# Leg 5, Jira: `jira:ABC-1` against a local fake JIRA_BASE_URL gives a run whose issue.json has source=jira;
# with no credentials it exits fast naming the variable. Fake credentials only; the fake server PID is recorded.
leg_05_jira() {
    local repo="$T/work/leg5" nocred="$T/work/leg5-nocred" srv="$T/logs/leg5-server.py" port_file="$T/logs/leg5.port"
    local spid port rc run ij s0 el n
    cat > "$srv" <<'PY'
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/rest/api/3/issue/ABC-1"):
            body = json.dumps({"key": "ABC-1", "fields": {"summary": "Fix the sum bug", "labels": ["bug"],
                "reporter": {"displayName": "E2E"}, "created": "2026-10-03T00:00:00.000+0000",
                "description": {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [
                    {"type": "text", "text": "sum skips the first element; fix the failing test in sum.test.js"}]}]}}}).encode()
            self.send_response(200); self.send_header("content-type", "application/json")
        else:
            body = b"{}"; self.send_response(404)
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_address[1]))
s.serve_forever()
PY
    python3 "$srv" "$port_file" > "$T/logs/leg5-server.log" 2>&1 &
    spid=$!; record_pid "$spid"
    n=0; while [ ! -s "$port_file" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
    port="$(cat "$port_file" 2>/dev/null)"
    [ -n "$port" ] || { fail "fake Jira server did not start: $(head -c 200 "$T/logs/leg5-server.log")"; return; }
    note "fake jira http://127.0.0.1:$port pid=$spid"
    mk_repo "$repo"
    ( cd "$repo" && cenv JIRA_BASE_URL="http://127.0.0.1:$port" JIRA_EMAIL=e2e@example.invalid JIRA_API_TOKEN=e2e-fake-token \
        timeout -k 5 240 "$LOKI" quick "jira:ABC-1" ) < /dev/null > "$T/logs/leg5.log" 2>&1
    rc=$?
    run="$(newest_run "$repo")"
    note "loki quick jira:ABC-1 rc=$rc run=${run:-none}"
    ij="$repo/.loki/runs/${run:-none}/issue.json"
    if [ -z "$run" ] || [ ! -f "$ij" ]; then
        fail "no issue.json in a run for jira:ABC-1 (rc=$rc; $(tail -2 "$T/logs/leg5.log" | tr '\n' ' '))"
    elif ! grep -Eq '"source"[[:space:]]*:[[:space:]]*"jira"' "$ij"; then
        fail "issue.json lacks source=jira: $(head -c 200 "$ij" | tr '\n' ' ')"
    else
        note "issue.json has source=jira"
    fi
    # No credentials: must exit fast (not hang) and name the missing variable.
    mk_repo "$nocred"
    s0=$(date +%s)
    ( cd "$nocred" && cenv JIRA_BASE_URL="http://127.0.0.1:$port" timeout -k 2 30 "$LOKI" quick "jira:ABC-1" ) < /dev/null > "$T/logs/leg5-nocred.log" 2>&1
    rc=$?
    el=$(( $(date +%s) - s0 ))
    note "no-credentials rc=$rc in ${el}s"
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 124 ] || [ "$el" -gt 15 ]; then
        fail "no-credentials run must fail fast: rc=$rc in ${el}s"
    elif ! grep -Eq 'JIRA_EMAIL|JIRA_API_TOKEN' "$T/logs/leg5-nocred.log"; then
        fail "no-credentials output does not name JIRA_EMAIL or JIRA_API_TOKEN: $(tail -2 "$T/logs/leg5-nocred.log" | tr '\n' ' ')"
    else
        note "names the missing variable"
    fi
    kill "$spid" 2> /dev/null || true
    pass "issue.json source=jira; no credentials failed fast naming the variable"
}
