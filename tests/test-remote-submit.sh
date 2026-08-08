#!/usr/bin/env bash
# `loki start --remote <url>` submits to a deployed cluster instead of building
# locally.
#
# The four properties that actually matter, and why each is a test rather than
# a code comment:
#
#   1. THE TOKEN NEVER REACHES ARGV. `curl -H "Authorization: Bearer $tok"`
#      puts the credential in the process list, where any local user reads it
#      with `ps`. The token is fed to curl on stdin via `--config -` instead.
#      The test stubs curl, dumps "$@", and asserts the token is absent.
#
#   2. PLAINTEXT TO A REMOTE HOST IS REFUSED. A bearer token over http:// to
#      anything but loopback is a credential leak. The load-bearing case is
#      http://localhost.evil.com: a prefix/glob check ("http://localhost*")
#      accepts it, so that one input separates a real host check from a
#      passing-but-wrong one.
#
#   3. AN UNREACHABLE SERVER FAILS LOUDLY AND DOES NOT RUN LOCALLY. This is
#      asserted NEGATIVELY -- the run script is stubbed and must never be
#      invoked. Asserting only "exit non-zero" would stay green if it silently
#      fell back to a local build that happened to fail, which is exactly the
#      nasty surprise (local spend the user did not ask for) being prevented.
#
#   4. A FAILING REMOTE JOB EXITS NON-ZERO, so CI can gate on it, and the
#      Evidence Receipt lands at .loki/proofs/<id>/proof.json -- the same path
#      the local path uses, so `loki proof` works unchanged.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: loki start --remote submits to a cluster without leaking the token"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "  SKIPPED: jq not installed (not a pass)"; exit 0; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

# Extract just the remote helpers so we exercise the REAL code without booting
# the whole CLI. Any drift in these functions is picked up here.
HELPERS="$TMPROOT/helpers.sh"
{
  echo 'RED=""; NC=""; YELLOW=""; GREEN=""'
  echo 'require_jq() { command -v jq >/dev/null 2>&1; }'
  # Extract EVERY loki_remote_* function by pattern, not by a hand-kept list.
  # A list drifts silently the moment someone adds a function -- which is
  # exactly what happened when loki_remote_verify_receipt was added here: the
  # harness picked up the call site but not the definition and failed with
  # "command not found" at runtime.
  sed -n '/^loki_remote_[a-z_]*() {/,/^}/p' "$SRC"
} > "$HELPERS"
bash -n "$HELPERS" || { echo "  FAIL: extracted helpers do not parse"; exit 1; }

# Guard against the NEXT drift: every loki_remote_* called in the extracted
# copy must also be DEFINED in it. Fails by name, not as "command not found"
# three assertions later.
_undefined=""
for _fn in $(grep -oE '\bloki_remote_[a-z_]+' "$HELPERS" | sort -u); do
  grep -q "^${_fn}() {" "$HELPERS" || _undefined="$_undefined $_fn"
done
if [ -n "$_undefined" ]; then
  echo "  FAIL: harness extracted a call but not the definition of:$_undefined"
  exit 1
fi

TOKEN="s3cr3t-bearer-token-do-not-leak"

# A curl stub that records every argument it was given, plus stdin, and replays
# a canned response. This is how we see what WOULD have hit the process list.
make_curl_stub() {
  local bindir="$1" submit_body="$2" status_body="$3" exit_code="${4:-0}"
  mkdir -p "$bindir"
  cat > "$bindir/curl" <<STUB
#!/usr/bin/env bash
echo "\$@" >> "$bindir/argv.log"
# Drain stdin without blocking: if the caller passed no --config, stdin is the
# terminal and a bare \`cat\` would hang forever instead of failing the test.
if [ ! -t 0 ]; then cat >> "$bindir/stdin.log"; fi
if [ "$exit_code" != "0" ]; then exit $exit_code; fi
for a in "\$@"; do
  case "\$a" in
    */jobs) printf '%s' '$submit_body'; exit 0 ;;
    */receipt) printf '%s' '{"schema":"loki-proof/1","id":"job-1"}'; exit 0 ;;
    */jobs/*) printf '%s' '$status_body'; exit 0 ;;
  esac
done
exit 0
STUB
  chmod +x "$bindir/curl"
}

run_remote() {
  # $1 = bindir (stubs), $2 = url, $3 = workdir; rest = env assignments
  local bindir="$1" url="$2" workdir="$3"; shift 3
  ( cd "$workdir" \
    && export PATH="$bindir:$PATH" \
    && env "$@" bash -c \
       "source '$HELPERS'; loki_remote_submit '$url' 'build me a thing'" \
       >"$workdir/out.log" 2>&1 </dev/null )
}

# --- 1. THE TOKEN NEVER APPEARS IN ARGV --------------------------------------
BIN1="$TMPROOT/bin1"; WORK1="$TMPROOT/work1"; mkdir -p "$WORK1"
make_curl_stub "$BIN1" '{"id":"job-1","status":"queued"}' '{"id":"job-1","status":"passed"}'
run_remote "$BIN1" "https://loki.example.com" "$WORK1" \
  "LOKI_REMOTE_TOKEN=$TOKEN" "LOKI_REMOTE_POLL_SEC=0"
rc1=$?

if [ -f "$BIN1/argv.log" ] && ! grep -qF "$TOKEN" "$BIN1/argv.log"; then
  ok "token never appears in curl's argv (not readable via ps)"
else
  bad "TOKEN LEAKED INTO ARGV: $(grep -oF "$TOKEN" "$BIN1/argv.log" | head -1)"
fi

if grep -qF "$TOKEN" "$BIN1/stdin.log" 2>/dev/null; then
  ok "token is delivered to curl on stdin (--config -)"
else
  bad "token never reached curl at all -- the request would be unauthenticated"
fi

if grep -q -- "--config" "$BIN1/argv.log" 2>/dev/null; then
  ok "curl is invoked with --config (stdin-fed header)"
else
  bad "curl not using --config; header must be arriving some other way"
fi

# The token must not leak into the terminal either.
if ! grep -qF "$TOKEN" "$WORK1/out.log"; then
  ok "token never printed to the terminal"
else
  bad "token printed in output"
fi

if [ "$rc1" -eq 0 ]; then
  ok "a job reaching 'passed' exits 0"
else
  bad "passed remote job exited $rc1 (expected 0): $(tail -2 "$WORK1/out.log")"
fi

# --- 2. RECEIPT LANDS WHERE THE LOCAL PATH PUTS IT ---------------------------
if [ -f "$WORK1/.loki/proofs/job-1/proof.json" ]; then
  ok "Evidence Receipt written to .loki/proofs/<id>/proof.json (same as a local run)"
else
  bad "receipt not written to .loki/proofs/job-1/proof.json"
fi

if jq -e . "$WORK1/.loki/proofs/job-1/proof.json" >/dev/null 2>&1; then
  ok "written receipt is valid JSON"
else
  bad "written receipt is not valid JSON"
fi

# A non-JSON body (proxy error page) must NOT be written as a receipt.
BINX="$TMPROOT/binx"; WORKX="$TMPROOT/workx"; mkdir -p "$WORKX"
mkdir -p "$BINX"
cat > "$BINX/curl" <<'STUB'
#!/usr/bin/env bash
cat >/dev/null
for a in "$@"; do
  case "$a" in
    */receipt) printf '%s' '<html>502 Bad Gateway</html>'; exit 0 ;;
  esac
done
exit 0
STUB
chmod +x "$BINX/curl"
( cd "$WORKX" && export PATH="$BINX:$PATH" \
  && bash -c "source '$HELPERS'; loki_remote_fetch_receipt 'https://x' 'tok' 'job-9'" \
  >/dev/null 2>&1 )
if [ ! -f "$WORKX/.loki/proofs/job-9/proof.json" ]; then
  ok "a non-JSON body is not written as a receipt"
else
  bad "an HTML error page was written as proof.json"
fi

# --- 3. PLAINTEXT TO A REMOTE HOST IS REFUSED --------------------------------
for host in "http://loki.example.com" "http://localhost.evil.com" "http://127.0.0.1.evil.com"; do
  BIN2="$TMPROOT/bin2"; WORK2="$TMPROOT/work2"; mkdir -p "$WORK2"
  make_curl_stub "$BIN2" '{"id":"j","status":"queued"}' '{"id":"j","status":"passed"}'
  run_remote "$BIN2" "$host" "$WORK2" "LOKI_REMOTE_TOKEN=$TOKEN" "LOKI_REMOTE_POLL_SEC=0"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -qi "plaintext" "$WORK2/out.log"; then
    ok "plaintext http refused for $host"
  else
    bad "plaintext http ACCEPTED for $host (rc=$rc) -- bearer token would leak"
  fi
  rm -rf "$BIN2" "$WORK2"
done

# Loopback over http is fine: it never leaves the machine.
BIN3="$TMPROOT/bin3"; WORK3="$TMPROOT/work3"; mkdir -p "$WORK3"
make_curl_stub "$BIN3" '{"id":"job-1","status":"queued"}' '{"id":"job-1","status":"passed"}'
run_remote "$BIN3" "http://127.0.0.1:7373" "$WORK3" \
  "LOKI_REMOTE_TOKEN=$TOKEN" "LOKI_REMOTE_POLL_SEC=0"
if [ $? -eq 0 ]; then
  ok "http to loopback is allowed (never leaves the machine)"
else
  bad "http to loopback was refused: $(tail -2 "$WORK3/out.log")"
fi

# The explicit override works, so the refusal is a decision and not a wall.
BIN4="$TMPROOT/bin4"; WORK4="$TMPROOT/work4"; mkdir -p "$WORK4"
make_curl_stub "$BIN4" '{"id":"job-1","status":"queued"}' '{"id":"job-1","status":"passed"}'
run_remote "$BIN4" "http://loki.example.com" "$WORK4" \
  "LOKI_REMOTE_TOKEN=$TOKEN" "LOKI_REMOTE_POLL_SEC=0" "LOKI_REMOTE_INSECURE=1"
if [ $? -eq 0 ]; then
  ok "LOKI_REMOTE_INSECURE=1 overrides the plaintext refusal"
else
  bad "explicit insecure override did not work"
fi

# --- 4. UNREACHABLE SERVER: LOUD FAILURE, NO LOCAL FALLBACK ------------------
# The negative assertion is the point: stub the run script and prove it is
# NEVER invoked. Exit-code-only would pass even on a silent local fallback.
BIN5="$TMPROOT/bin5"; WORK5="$TMPROOT/work5"; mkdir -p "$WORK5" "$BIN5"
make_curl_stub "$BIN5" '' '' 7   # curl exits 7 == connection refused
cat > "$BIN5/run.sh" <<STUB
#!/usr/bin/env bash
echo "LOCAL_RUN_HAPPENED" >> "$BIN5/local.log"
STUB
chmod +x "$BIN5/run.sh"
run_remote "$BIN5" "https://unreachable.example.com" "$WORK5" \
  "LOKI_REMOTE_TOKEN=$TOKEN" "LOKI_REMOTE_POLL_SEC=0"
rc5=$?

if [ "$rc5" -ne 0 ]; then
  ok "unreachable server exits non-zero (rc=$rc5)"
else
  bad "unreachable server exited 0 -- CI could not gate on this"
fi

if [ ! -f "$BIN5/local.log" ]; then
  ok "no local build was started as a fallback"
else
  bad "SILENT LOCAL FALLBACK: a remote request ran a local build (local spend)"
fi

if grep -q "unreachable.example.com" "$WORK5/out.log"; then
  ok "failure message names the URL that could not be reached"
else
  bad "failure message does not name the URL: $(tail -2 "$WORK5/out.log")"
fi

# --- 5. A FAILING REMOTE JOB EXITS NON-ZERO ----------------------------------
BIN6="$TMPROOT/bin6"; WORK6="$TMPROOT/work6"; mkdir -p "$WORK6"
make_curl_stub "$BIN6" '{"id":"job-1","status":"queued"}' '{"id":"job-1","status":"error"}'
run_remote "$BIN6" "https://loki.example.com" "$WORK6" \
  "LOKI_REMOTE_TOKEN=$TOKEN" "LOKI_REMOTE_POLL_SEC=0"
if [ $? -ne 0 ]; then
  ok "a remote job in 'error' exits non-zero (CI can gate on it)"
else
  bad "a failed remote job exited 0 -- CI would treat a failure as success"
fi

# --- 5b. THE BUILD OUTCOME IS WHAT GATES, NOT "a build was launched" ---------
# THE BUG THIS PINS: the server used to report "fired" (the pod LAUNCHED a
# build) and the client exited 0 on it. A build that started and then failed
# therefore produced a GREEN CI pipeline. "launched" and "passed" must never
# share a value, and an outcome nobody observed must fail closed.
check_outcome() {
  local status="$1" want_rc="$2" label="$3"
  local bindir="$TMPROOT/bin-$status" workdir="$TMPROOT/work-$status"
  mkdir -p "$workdir"
  make_curl_stub "$bindir" '{"id":"job-1","status":"queued"}' \
    "{\"id\":\"job-1\",\"status\":\"$status\"}"
  run_remote "$bindir" "https://loki.example.com" "$workdir" \
    "LOKI_REMOTE_TOKEN=$TOKEN" "LOKI_REMOTE_POLL_SEC=0"
  local rc=$?
  if [ "$want_rc" = "zero" ] && [ "$rc" -eq 0 ]; then
    ok "$label"
  elif [ "$want_rc" = "nonzero" ] && [ "$rc" -ne 0 ]; then
    ok "$label"
  else
    bad "$label (rc=$rc): $(tail -2 "$workdir/out.log")"
  fi
}

check_outcome passed  zero    "a build that PASSED exits 0"
check_outcome failed  nonzero "a build that STARTED AND THEN FAILED exits non-zero"
check_outcome unknown nonzero "an UNKNOWN outcome exits non-zero (fails closed)"

# The client must not treat the old launch-only status as a pass.
check_outcome fired nonzero "the legacy 'fired' (launched, not passed) does not exit 0"

# The poll loop must RECOGNISE each terminal status, not merely time out on it.
# Without this, a loop that never breaks still "fails" (empty status -> non-zero)
# and check_outcome above would pass for entirely the wrong reason.
_poll_case="$(sed -n '/^loki_remote_submit()/,/^}/p' "$SRC" \
              | sed -n '/case "\$status" in/,/esac/p' | head -5)"
_missing=""
for _s in passed failed unknown; do
  printf '%s' "$_poll_case" | grep -q "$_s" || _missing="$_missing $_s"
done
if [ -z "$_missing" ]; then
  ok "poll loop breaks on every terminal status (passed/failed/unknown)"
else
  bad "poll loop does not recognise:$_missing -- it would spin until max-polls"
fi

# --- 6. NO TOKEN CONFIGURED: refuse rather than submit unauthenticated -------
BIN7="$TMPROOT/bin7"; WORK7="$TMPROOT/work7"; mkdir -p "$WORK7"
make_curl_stub "$BIN7" '{"id":"j","status":"queued"}' '{"id":"j","status":"passed"}'
( cd "$WORK7" && export PATH="$BIN7:$PATH" \
  && env -u LOKI_REMOTE_TOKEN -u LOKI_REMOTE_TOKEN_FILE bash -c \
     "source '$HELPERS'; loki_remote_submit 'https://loki.example.com' 'spec'" \
  >"$WORK7/out.log" 2>&1 )
if [ $? -ne 0 ] && [ ! -f "$BIN7/argv.log" ]; then
  ok "no token configured: refuses without contacting the server"
else
  bad "submitted without a token"
fi

# A token FILE works, and is stripped of its trailing newline (k8s mounts).
BIN8="$TMPROOT/bin8"; WORK8="$TMPROOT/work8"; mkdir -p "$WORK8"
printf '%s\n' "$TOKEN" > "$TMPROOT/token.txt"
make_curl_stub "$BIN8" '{"id":"job-1","status":"queued"}' '{"id":"job-1","status":"passed"}'
( cd "$WORK8" && export PATH="$BIN8:$PATH" \
  && env -u LOKI_REMOTE_TOKEN "LOKI_REMOTE_TOKEN_FILE=$TMPROOT/token.txt" \
     "LOKI_REMOTE_POLL_SEC=0" bash -c \
     "source '$HELPERS'; loki_remote_submit 'https://loki.example.com' 'spec'" \
  >"$WORK8/out.log" 2>&1 )
if grep -qF "Bearer $TOKEN\"" "$BIN8/stdin.log" 2>/dev/null; then
  ok "token file is read and its trailing newline stripped"
else
  bad "token file not read cleanly: $(head -1 "$BIN8/stdin.log" 2>/dev/null)"
fi

# --- 7. HOST PARSING IS EXACT, NOT A PREFIX ----------------------------------
host_of() { bash -c "source '$HELPERS'; loki_remote_host '$1'"; }
_host_ok=0
[ "$(host_of 'https://loki.example.com/jobs')" = "loki.example.com" ] || _host_ok=1
[ "$(host_of 'http://127.0.0.1:7373')" = "127.0.0.1" ] || _host_ok=1
[ "$(host_of 'http://localhost.evil.com')" = "localhost.evil.com" ] || _host_ok=1
[ "$(host_of 'http://user:pw@localhost:80/x')" = "localhost" ] || _host_ok=1
if [ "$_host_ok" -eq 0 ]; then
  ok "host is parsed exactly (scheme, userinfo, port and path stripped)"
else
  bad "host parsing is wrong -- the plaintext check cannot be trusted"
fi

# --- 8. --remote is a real CLI flag, not just an env var ---------------------
if grep -q -- '--remote)' "$SRC" && grep -q 'LOKI_REMOTE_URL' "$SRC"; then
  ok "--remote flag and LOKI_REMOTE_URL env var are both wired"
else
  bad "--remote flag or LOKI_REMOTE_URL not wired into cmd_start"
fi

# The branch must run BEFORE the provider gates: a remote submit exists
# precisely because this machine has no provider doing the work.
_argloop_end="$(grep -n 'Explicit-provider pre-flight' "$SRC" | head -1 | cut -d: -f1)"
_remote_branch="$(grep -n 'loki_remote_submit "\$remote_url"' "$SRC" | head -1 | cut -d: -f1)"
if [ -n "$_argloop_end" ] && [ -n "$_remote_branch" ] && [ "$_remote_branch" -lt "$_argloop_end" ]; then
  ok "remote branch runs before the provider pre-flight (no local provider needed)"
else
  bad "remote submit is gated behind the provider pre-flight"
fi

echo ""
echo "  PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
