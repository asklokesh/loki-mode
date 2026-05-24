#!/usr/bin/env bash
# v7.7.10 F-3 fix unit test: entrypoint detection in _intelligent_usage_regen.
# Verifies the prompt includes literal port bindings from server.js / app.py
# so the haiku regen produces correct USAGE.md verify commands. Does NOT call
# claude (kept offline so it runs in local-ci).
set -u

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf "  PASS: %s\n" "$*"; }
bad() { FAIL=$((FAIL+1)); printf "  FAIL: %s\n" "$*"; }

# Inline the entrypoint-detection + scrub logic from autonomy/run.sh.
# Kept here so the test stays self-contained; mirrors production code.
_collect_entrypoints() {
    local target_dir="$1"
    local _ep_candidates=""
    if [ -f "$target_dir/package.json" ]; then
        local _pkg_main
        _pkg_main=$(python3 -c "import json,sys; d=json.load(open('$target_dir/package.json'));print(d.get('main') or '')" 2>/dev/null)
        [ -n "$_pkg_main" ] && _ep_candidates="$_ep_candidates $_pkg_main"
        local _pkg_scripts
        _pkg_scripts=$(python3 -c "import json,re,sys; d=json.load(open('$target_dir/package.json'));s=d.get('scripts',{});c=' '.join([s.get('start',''),s.get('dev','')]);[print(t) for t in re.findall(r'[\\w/.-]+\\.(?:js|mjs|cjs|ts|mts|cts|py)\\b',c)]" 2>/dev/null)
        [ -n "$_pkg_scripts" ] && _ep_candidates="$_ep_candidates $_pkg_scripts"
    fi
    for _ep in server.js server.ts server.mjs index.js index.ts app.js app.ts \
               main.py app.py server.py manage.py wsgi.py asgi.py \
               main.go cmd/server/main.go src/main.rs src/index.ts dist/server.js \
               build/server.js; do
        _ep_candidates="$_ep_candidates $_ep"
    done
    local _include_source="${LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE:-1}"
    local _entrypoints=""
    local _seen=""
    local _count=0
    for _ep in $_ep_candidates; do
        case " $_seen " in *" $_ep "*) continue ;; esac
        _seen="$_seen $_ep"
        if [ -f "$target_dir/$_ep" ]; then
            local _ep_body
            if [ "$_include_source" = "0" ]; then
                _ep_body="(entrypoint source omitted: LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE=0)"
            else
                _ep_body=$(head -80 "$target_dir/$_ep" 2>/dev/null \
                    | sed -E \
                        -e '/[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Tt][Oo][Kk][Ee][Nn]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][_-]?[Kk][Ee][Yy]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Bb][Ee][Aa][Rr][Ee][Rr]/ s/[:=].*$/= [REDACTED]/' \
                        -e 's/(sk-[A-Za-z0-9_-]{16,}|pk_[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|ghs_[A-Za-z0-9]{16,}|xox[bpoa]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{12,})/[REDACTED]/g')
            fi
            _entrypoints="${_entrypoints}=== Entrypoint: $_ep ===\n${_ep_body}\n\n"
            _count=$((_count + 1))
            [ "$_count" -ge 3 ] && break
        fi
    done
    printf '%s' "$_entrypoints"
}

# Fixture 1: Express, port 3001 (EC2Renter-style mismatch with default 3000)
FIX=/tmp/loki-f3-express
rm -rf "$FIX"; mkdir -p "$FIX"
cat > "$FIX/package.json" <<'PKG'
{"name":"x","main":"server.js","scripts":{"start":"node server.js"},"dependencies":{"express":"^4.18.0"}}
PKG
cat > "$FIX/server.js" <<'SRV'
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`server on ${PORT}`));
SRV
out=$(_collect_entrypoints "$FIX")
printf '%s' "$out" | grep -q "3001" && ok "Express port 3001 captured" || bad "Express port 3001 missing"
printf '%s' "$out" | grep -q "app.listen" && ok "Express listen() call captured" || bad "Express listen() missing"

# Fixture 2: Flask, port 5050
FIX2=/tmp/loki-f3-flask
rm -rf "$FIX2"; mkdir -p "$FIX2"
cat > "$FIX2/requirements.txt" <<'REQ'
flask>=3.0.0
REQ
cat > "$FIX2/app.py" <<'APP'
from flask import Flask
app = Flask(__name__)
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050)
APP
out=$(_collect_entrypoints "$FIX2")
printf '%s' "$out" | grep -q "5050" && ok "Flask port 5050 captured" || bad "Flask port 5050 missing"
printf '%s' "$out" | grep -q "app.run" && ok "Flask app.run() captured" || bad "Flask app.run() missing"

# Fixture 3: Go net/http on port 8080
FIX3=/tmp/loki-f3-go
rm -rf "$FIX3"; mkdir -p "$FIX3"
cat > "$FIX3/go.mod" <<'GMD'
module example.com/x
go 1.22
GMD
cat > "$FIX3/main.go" <<'GO'
package main
import "net/http"
func main() {
  http.ListenAndServe(":8080", nil)
}
GO
out=$(_collect_entrypoints "$FIX3")
printf '%s' "$out" | grep -q ":8080" && ok "Go port 8080 captured" || bad "Go port 8080 missing"

# Fixture 4: package.json main missing, but server.js convention exists
FIX4=/tmp/loki-f3-no-main
rm -rf "$FIX4"; mkdir -p "$FIX4"
cat > "$FIX4/package.json" <<'PKG'
{"name":"x","scripts":{"start":"node index.js"}}
PKG
cat > "$FIX4/index.js" <<'IDX'
const http = require('http');
http.createServer().listen(4242);
IDX
out=$(_collect_entrypoints "$FIX4")
printf '%s' "$out" | grep -q "4242" && ok "package.json scripts.start fallback to index.js captured port 4242" || bad "scripts.start fallback missed"

# Fixture 5: server.js with hardcoded API_KEY and stripe sk- token.
# Verify scrubbing redacts secrets but PRESERVES the listen() port.
FIX5=/tmp/loki-f3-secrets
rm -rf "$FIX5"; mkdir -p "$FIX5"
cat > "$FIX5/package.json" <<'PKG'
{"name":"x","main":"server.js","scripts":{"start":"node server.js"}}
PKG
cat > "$FIX5/server.js" <<'SRV'
const express = require('express');
const app = express();
const API_KEY = "abc123-supersecret-must-not-leak";
const STRIPE_TOKEN = "sk-livethisismadeupbutshouldscrub1234567890ABCDEF";
const password = "hunter2";
const PORT = 7777;
app.listen(PORT, () => console.log(`server on ${PORT}`));
SRV
out=$(_collect_entrypoints "$FIX5")
printf '%s' "$out" | grep -q "7777" && ok "Secrets fixture: port 7777 still captured after scrub" || bad "Secrets fixture: port 7777 lost after scrub"
printf '%s' "$out" | grep -q "abc123-supersecret" && bad "Secrets fixture: API_KEY literal NOT scrubbed" || ok "Secrets fixture: API_KEY value scrubbed"
printf '%s' "$out" | grep -q "sk-livethisismadeup" && bad "Secrets fixture: stripe sk- token NOT scrubbed" || ok "Secrets fixture: stripe sk- token scrubbed"
printf '%s' "$out" | grep -q "hunter2" && bad "Secrets fixture: password value NOT scrubbed" || ok "Secrets fixture: password value scrubbed"
printf '%s' "$out" | grep -q "\[REDACTED\]" && ok "Secrets fixture: [REDACTED] marker present" || bad "Secrets fixture: no [REDACTED] markers"

# Fixture 6: env-var opt-out emits placeholder instead of source
FIX6=/tmp/loki-f3-optout
rm -rf "$FIX6"; mkdir -p "$FIX6"
cat > "$FIX6/package.json" <<'PKG'
{"name":"x","main":"server.js","scripts":{"start":"node server.js"}}
PKG
cat > "$FIX6/server.js" <<'SRV'
const PORT = 9999;
require('http').createServer().listen(PORT);
SRV
LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE=0 out=$(LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE=0 _collect_entrypoints "$FIX6")
printf '%s' "$out" | grep -q "LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE=0" && ok "Opt-out: source omitted with placeholder" || bad "Opt-out: source still leaks despite env=0"
printf '%s' "$out" | grep -q "9999" && bad "Opt-out: port should NOT be in output" || ok "Opt-out: port 9999 absent (as expected)"

rm -rf "$FIX" "$FIX2" "$FIX3" "$FIX4" "$FIX5" "$FIX6"

echo
echo "F-3 entrypoint detection + scrub: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
