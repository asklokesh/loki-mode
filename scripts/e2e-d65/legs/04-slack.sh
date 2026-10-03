# shellcheck shell=bash
# Leg 4, Slack: serve --port 0 with FAKE secrets; signed url_verification returns the challenge; a bad signature is 401; nothing outbound.
leg_04_slack() {
    local log="$T/logs/leg4-serve.log" proxy_log="$T/logs/leg4-proxy.log" pport url spid body ts sig code resp n
    local secret="e2e-fake-signing-secret"
    # An outbound trap: any proxied connection (for example slack.com) is recorded; zero connections is the pass condition.
    : > "$proxy_log"
    python3 -c '
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(8)
print(s.getsockname()[1], flush=True)
log = open(sys.argv[1], "a")
while True:
    c, _ = s.accept()
    log.write("connection\n"); log.flush(); c.close()
' "$proxy_log" > "$T/logs/leg4-proxy.port" 2>/dev/null &
    record_pid $!
    n=0; while [ ! -s "$T/logs/leg4-proxy.port" ] && [ "$n" -lt 30 ]; do sleep 0.1; n=$((n + 1)); done
    pport="$(head -1 "$T/logs/leg4-proxy.port")"
    cd "$T/work" || return
    local port=0 attempt
    for attempt in 1 2; do
        cenv LOKI_SLACK_INBOUND=1 SLACK_BOT_TOKEN=xoxb-e2e-fake SLACK_SIGNING_SECRET="$secret" \
            HTTPS_PROXY="http://127.0.0.1:${pport:-9}" HTTP_PROXY="http://127.0.0.1:${pport:-9}" \
            "${E2E_SLACK_LOKI:-$LOKI}" slack serve --port "$port" > "$log" 2>&1 &
        spid=$!; record_pid "$spid"
        url="$(wait_for_line "$log" 'listening on http' 20 "$spid" | sed -n 's/.*listening on \(http[^ ]*\).*/\1/p')"
        # --port 0 is rejected as invalid: record the bug, then retry on a free port so the other assertions still run
        if [ -z "$url" ] && [ "$attempt" = 1 ] && grep -q 'invalid --port' "$log"; then
            fail "loki slack serve rejects --port 0 ('invalid --port'); every sibling server accepts 0 for any free port"
            port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
            continue
        fi
        break
    done
    if [ -z "$url" ]; then
        fail "slack serve did not start: $(head -2 "$log" | tr '\n' ' ') (--port 0 rejected, or 'slack' missing from the bin/loki Bun allowlist: C5/C6)"; return
    fi
    note "slack url=$url"
    body='{"type":"url_verification","challenge":"e2e-challenge-123"}'
    ts="$(date +%s)"
    sig="v0=$(printf 'v0:%s:%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$secret" | sed 's/^.* //')"
    resp="$(curl -s --noproxy '*' -m 10 -X POST -H "x-slack-request-timestamp: $ts" -H "x-slack-signature: $sig" -H 'content-type: application/json' -d "$body" -w '\n%{http_code}' "$url")"
    code="$(printf '%s' "$resp" | tail -1)"
    if [ "$code" = 200 ] && [ "$(printf '%s' "$resp" | head -1)" = "e2e-challenge-123" ]; then note "signed url_verification returned the challenge"
    else fail "signed url_verification: status $code body '$(printf '%s' "$resp" | head -1 | head -c 80)', expected 200 and the challenge"; fi
    code="$(curl -s --noproxy '*' -m 10 -o /dev/null -X POST -H "x-slack-request-timestamp: $ts" -H "x-slack-signature: v0=deadbeef" -H 'content-type: application/json' -d "$body" -w '%{http_code}' "$url")"
    if [ "$code" = 401 ]; then note "bad signature returned 401"; else fail "bad signature returned $code, expected 401"; fi
    if [ -s "$proxy_log" ]; then fail "outbound connection attempted via the proxy trap ($(wc -l < "$proxy_log" | tr -d ' ') connections)"; else note "no outbound connections"; fi
    pass "challenge echoed, bad signature 401, nothing outbound"
}
