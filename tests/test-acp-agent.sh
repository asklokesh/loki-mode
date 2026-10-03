#!/usr/bin/env bash
# tests/test-acp-agent.sh -- ACP agent: handshake, streamed prompt, failure honesty.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$(mktemp -d "${TMPDIR:-/tmp}/acp-test.XXXXXX")" || exit 1
printf '#!/bin/sh\necho "ran: $2"\n[ "$2" = "boom" ] && exit 3\nexit 0\n' > "$D/fake"
chmod +x "$D/fake"
LOKI_ACP_LOKI="$D/fake" python3 - "$ROOT/autonomy/acp-agent.py" "$D" <<'PY'
import json, os, subprocess, sys
agent, d = sys.argv[1], sys.argv[2]
pass_n = fail_n = 0
def check(name, cond):
    global pass_n, fail_n
    if cond: pass_n += 1; print("PASS: " + name)
    else: fail_n += 1; print("FAIL: " + name)
def session(prompt):
    p = subprocess.Popen(["python3", agent], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    def call(obj):
        p.stdin.write(json.dumps(obj) + "\n"); p.stdin.flush()
    call({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}})
    init = json.loads(p.stdout.readline())
    call({"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": d}})
    sid = json.loads(p.stdout.readline())["result"]["sessionId"]
    call({"jsonrpc": "2.0", "id": 3, "method": "session/prompt",
          "params": {"sessionId": sid, "prompt": [{"type": "text", "text": prompt}]}})
    p.stdin.close()
    frames = [json.loads(l) for l in p.stdout.read().splitlines() if l.strip()]
    p.wait()
    text = "".join(f["params"]["update"]["content"]["text"] for f in frames if f.get("method") == "session/update")
    final = [f for f in frames if f.get("id") == 3][0]
    return init, text, final
init, text, final = session("hello")
check("initialize reports protocol version 1", init["result"]["protocolVersion"] == 1)
check("prompt output streamed", "ran: hello" in text)
check("prompt ends end_turn", final["result"]["stopReason"] == "end_turn")
check("success carries no NOT VERIFIED", "NOT VERIFIED" not in text)
_, text, _ = session("boom")
check("failure reported NOT VERIFIED", "code 3" in text and "NOT VERIFIED" in text)
print("passed=%d failed=%d" % (pass_n, fail_n))
sys.exit(1 if fail_n else 0)
PY
rc=$?
rm -rf "$D"
exit $rc
