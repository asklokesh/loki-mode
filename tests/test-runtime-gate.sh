#!/usr/bin/env bash
# shellcheck disable=SC2164  # cd in throwaway test subshells; failure is fatal anyway
# tests/test-runtime-gate.sh - tests for the runtime/boot smoke gate in
# `loki verify` (verify_gate_runtime, autonomy/verify.sh).
#
# The runtime gate promotes the build-loop's playwright/http smoke concept into
# loki verify as a deterministic runtime gate: detect a start command, boot the
# app bounded by a timeout, probe a health/root path, record the HTTP status
# (and optionally a screenshot) in evidence.json, tear down cleanly.
#
# Cases (each in its own mktemp repo):
#   A. a trivial node web app that boots and serves 200 on /
#        -> runtime gate = pass, http_status 200 recorded, reproducible=true.
#   B. a broken start command (npm start -> exit 1)
#        -> runtime gate = fail, a High runtime finding, verdict NOT VERIFIED.
#   C. a library repo with NO start command
#        -> runtime gate emits NO row, and the no-app path is BYTE-IDENTICAL to
#           a baseline run with the gate opted out (LOKI_RUNTIME_GATE=0). This is
#           the critical no-regression safety property.
#
# Self-skips cleanly when node / python3 / a timeout binary are absent.
#
# Exit-code semantics: 0 VERIFIED, 1 CONCERNS, 2 BLOCKED, 3 verifier error.

set -uo pipefail

# Isolate from host global/system git config (mirrors tests/test-verify.sh).
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SH="$SCRIPT_DIR/../autonomy/verify.sh"

# Source verify.sh so unit-style cases can call its helpers directly
# (e.g. _verify_runtime_detect). Safe: verify.sh only runs verify_main when
# executed as $0 (BASH_SOURCE guard at the bottom), so sourcing defines the
# functions without running a verification. The end-to-end cases still invoke
# verify.sh as a subprocess via run_verify(); this source only adds the helpers.
# shellcheck source=/dev/null
. "$VERIFY_SH"

PASS=0
FAIL=0
TMP_ROOT="$(mktemp -d -t loki-runtime-gate-tests.XXXXXX)"

cleanup() {
    rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

_ok()   { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_no()   { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
_skip() { printf '  SKIP: %s\n' "$1"; }

# Resolve a timeout binary the same way the gate does.
_timeout_bin() {
    if command -v timeout >/dev/null 2>&1; then echo "timeout"
    elif command -v gtimeout >/dev/null 2>&1; then echo "gtimeout"; fi
}

# Pick a free-ish, per-run port to avoid colliding with a server left over from
# a previous run (or the real dashboard). Derived from the PID so the two boot
# cases never share a port. Also proactively reclaim it if something is holding
# it, so the test is hermetic.
_free_port() {
    local base="$1"   # small offset so A and B differ
    local port=$(( 20000 + (RANDOM % 20000) + base ))
    if command -v lsof >/dev/null 2>&1; then
        local holders
        holders="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
        [ -n "$holders" ] && printf '%s\n' "$holders" | while IFS= read -r p; do
            [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
        done
    fi
    echo "$port"
}

# Init a repo with a main branch + a base commit, then a feature commit so the
# PR diff (merge-base(main,HEAD)..HEAD) is non-empty (verify short-circuits on an
# empty diff, which would skip ALL gates including runtime).
init_repo() {
    local repo="$1"
    mkdir -p "$repo"
    ( cd "$repo"
      git init -q
      git config user.email "test@loki.local"
      git config user.name "loki test"
      git config commit.gpgsign false
      echo "# project" > README.md
      git add README.md
      git commit -qm "base" --no-gpg-sign --no-verify
      git branch -m main
    )
}

# Commit the current working tree as the "feature" change on a feature branch so
# merge-base(main, HEAD)..HEAD is non-empty (verify short-circuits an empty diff,
# which would skip ALL gates -- including runtime).
commit_feature() {
    local repo="$1"
    ( cd "$repo"
      git checkout -q -b feature
      git add -A
      git commit -qm "feature" --no-gpg-sign --no-verify
    )
}

# Run verify.sh in a subshell cd'd into the repo. Captures RC + VERDICT.
# Extra args and env are passed through by the caller's environment.
run_verify() {
    local repo="$1"; shift
    ( cd "$repo" && bash "$VERIFY_SH" "$@" ) >/dev/null 2>&1
    RC=$?
    if [ -f "$repo/.loki/verify/evidence.json" ]; then
        VERDICT="$(python3 -c "import json; print(json.load(open('$repo/.loki/verify/evidence.json'))['verdict'])" 2>/dev/null || echo "PARSE_ERROR")"
    else
        VERDICT="NO_EVIDENCE"
    fi
}

# Extract a gate's status from evidence.json (empty if the gate row is absent).
gate_status() {
    local repo="$1" gate="$2"
    python3 - "$repo/.loki/verify/evidence.json" "$gate" <<'PYEOF' 2>/dev/null || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for g in d.get("deterministic_gates", []):
    if g.get("gate") == sys.argv[2]:
        print(g.get("status", ""))
        break
PYEOF
}

echo "=== test-runtime-gate.sh ==="
echo "VERIFY_SH: $VERIFY_SH"

# Pre-flight: syntax.
if bash -n "$VERIFY_SH" 2>/dev/null; then
    _ok "verify.sh passes bash -n"
else
    _no "verify.sh failed bash -n"
fi

# Environment gate: the boot cases need node + a timeout binary. Case C
# (byte-identity) needs neither and always runs.
TIMEOUT_BIN="$(_timeout_bin)"
HAVE_NODE=false
command -v node >/dev/null 2>&1 && HAVE_NODE=true
HAVE_PY=false
command -v python3 >/dev/null 2>&1 && HAVE_PY=true

if [ "$HAVE_PY" != "true" ]; then
    echo "python3 not available; cannot parse evidence.json -- skipping all cases."
    echo "=== summary: $PASS passed, $FAIL failed (python3 absent) ==="
    exit 0
fi

# ---------------------------------------------------------------------------
# Case A: trivial node web app that boots and serves 200 on /.
# ---------------------------------------------------------------------------
if [ "$HAVE_NODE" = "true" ] && [ -n "$TIMEOUT_BIN" ]; then
    REPO_A="$TMP_ROOT/case-a"
    init_repo "$REPO_A"
    # A zero-dependency node HTTP server that honors PORT (default 3000, which is
    # what the gate maps 'npm start' to) and answers 200 on every path.
    cat > "$REPO_A/server.js" <<'JS'
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><head><title>ok</title></head><body>hello from case A</body></html>');
}).listen(port, '127.0.0.1', () => {
  console.log('listening on ' + port);
});
JS
    cat > "$REPO_A/package.json" <<'JSON'
{
  "name": "case-a",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  }
}
JSON
    commit_feature "$REPO_A"

    # LOKI_APP_PORT pins the port so the health probe hits the right place even
    # if the default map ever changes; the gate boots 'npm start'. A per-run port
    # keeps the test hermetic against leftover servers.
    PORT_A="$(_free_port 1)"
    LOKI_APP_PORT="$PORT_A" run_verify "$REPO_A"
    STATUS_A="$(gate_status "$REPO_A" runtime)"

    if [ "$STATUS_A" = "pass" ]; then
        _ok "case A: runtime gate = pass on a booting node app"
    else
        _no "case A: runtime gate status was '$STATUS_A' (expected pass)"
    fi

    # HTTP status 200 + reproducible=true recorded in evidence.json.
    HTTP_A="$(python3 - "$REPO_A/.loki/verify/evidence.json" <<'PYEOF' 2>/dev/null || true
import json, sys
d = json.load(open(sys.argv[1]))
for g in d.get("deterministic_gates", []):
    if g.get("gate") == "runtime":
        s = g.get("summary", "")
        print("200" if "HTTP 200" in s else "no200")
        print("repro" if g.get("reproducible") is True else "norepro")
        break
PYEOF
)"
    if printf '%s' "$HTTP_A" | grep -q '200' && printf '%s' "$HTTP_A" | grep -q 'repro'; then
        _ok "case A: evidence records HTTP 200 + reproducible=true"
    else
        _no "case A: evidence missing HTTP 200 / reproducible=true (got: $(printf '%s' "$HTTP_A" | tr '\n' ' '))"
    fi

    # The structured runtime.json artifact is written and reproducible.
    if [ -f "$REPO_A/.loki/verify/runtime/runtime.json" ] \
       && python3 -c "import json;d=json.load(open('$REPO_A/.loki/verify/runtime/runtime.json'));assert d['reproducible'] is True;assert str(d['http_status'])=='200'" 2>/dev/null; then
        _ok "case A: runtime.json artifact records status 200 + reproducible=true"
    else
        _no "case A: runtime.json artifact missing or wrong"
    fi
else
    _skip "case A: needs node + a timeout binary (node=$HAVE_NODE timeout=${TIMEOUT_BIN:-none})"
fi

# ---------------------------------------------------------------------------
# Case B: a broken start command -> High finding, verdict NOT VERIFIED.
# ---------------------------------------------------------------------------
if [ "$HAVE_NODE" = "true" ] && [ -n "$TIMEOUT_BIN" ]; then
    REPO_B="$TMP_ROOT/case-b"
    init_repo "$REPO_B"
    # A server file with a real HTTP signal (createServer) so the gate DETECTS it
    # as a bootable HTTP app -- but the code throws at startup BEFORE it listens,
    # so the boot fails and the health probe never answers. This exercises the
    # "app detected but won't start" path (not the "no HTTP signal" path, which
    # correctly self-suppresses for CLIs). The createServer reference is what the
    # detector keys on; the throw above it guarantees the port never opens.
    cat > "$REPO_B/server.js" <<'JS'
const http = require('http');
throw new Error('boom: broken startup before listen');
// unreachable, but present so the detector sees a real HTTP server signal:
http.createServer((req, res) => res.end('ok')).listen(process.env.PORT || 3000);
JS
    cat > "$REPO_B/package.json" <<'JSON'
{
  "name": "case-b",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  }
}
JSON
    commit_feature "$REPO_B"

    # Short boot timeout so the failing app is declared dead fast. Per-run port.
    PORT_B="$(_free_port 2)"
    LOKI_APP_PORT="$PORT_B" LOKI_RUNTIME_BOOT_TIMEOUT=8 run_verify "$REPO_B"
    STATUS_B="$(gate_status "$REPO_B" runtime)"

    if [ "$STATUS_B" = "fail" ]; then
        _ok "case B: runtime gate = fail on a broken start command"
    else
        _no "case B: runtime gate status was '$STATUS_B' (expected fail)"
    fi

    # A High (or Critical) runtime finding is present.
    HAS_HIGH_B="$(python3 - "$REPO_B/.loki/verify/evidence.json" <<'PYEOF' 2>/dev/null || true
import json, sys
d = json.load(open(sys.argv[1]))
hit = any(
    f.get("category") == "runtime" and f.get("severity") in ("High", "Critical")
    for f in d.get("findings", [])
)
print("yes" if hit else "no")
PYEOF
)"
    if [ "$HAS_HIGH_B" = "yes" ]; then
        _ok "case B: a High/Critical runtime finding was emitted"
    else
        _no "case B: no High/Critical runtime finding (got '$HAS_HIGH_B')"
    fi

    # Verdict is NOT VERIFIED (a High finding blocks under default --block-on).
    if [ "$VERDICT" != "VERIFIED" ] && [ "$VERDICT" != "NO_EVIDENCE" ] && [ "$VERDICT" != "PARSE_ERROR" ]; then
        _ok "case B: verdict is NOT VERIFIED (got $VERDICT, rc=$RC)"
    else
        _no "case B: verdict should not be VERIFIED (got $VERDICT, rc=$RC)"
    fi
else
    _skip "case B: needs node + a timeout binary"
fi

# ---------------------------------------------------------------------------
# Case C: library repo with NO start command.
#   1. the runtime gate emits NO row (self-suppressed).
#   2. the no-app default path is BYTE-IDENTICAL to a baseline with the gate
#      opted out. This is the critical no-regression property.
# ---------------------------------------------------------------------------
REPO_C="$TMP_ROOT/case-c"
init_repo "$REPO_C"
# A pure library: source + a unit test, no package.json start/dev, no Procfile,
# no web entrypoint. Nothing bootable.
mkdir -p "$REPO_C/src" "$REPO_C/tests"
cat > "$REPO_C/src/util.js" <<'JS'
function add(a, b) { return a + b; }
module.exports = { add };
JS
cat > "$REPO_C/tests/placeholder.txt" <<'TXT'
library repo: no runnable server, no start/dev script.
TXT
commit_feature "$REPO_C"

# Baseline: run with the gate OPTED OUT (LOKI_RUNTIME_GATE=0) into a separate
# out dir. This is exactly the pre-change behavior (no runtime gate at all).
( cd "$REPO_C" && LOKI_RUNTIME_GATE=0 bash "$VERIFY_SH" --out .loki/verify-baseline ) >/dev/null 2>&1
# Candidate: run with the gate ON (default) into the normal out dir.
( cd "$REPO_C" && bash "$VERIFY_SH" --out .loki/verify-candidate ) >/dev/null 2>&1

# 1. No runtime row in the candidate evidence.
STATUS_C="$(python3 - "$REPO_C/.loki/verify-candidate/evidence.json" <<'PYEOF' 2>/dev/null || true
import json, sys
d = json.load(open(sys.argv[1]))
print("present" if any(g.get("gate") == "runtime" for g in d.get("deterministic_gates", [])) else "absent")
PYEOF
)"
if [ "$STATUS_C" = "absent" ]; then
    _ok "case C: no runtime gate row emitted for a library repo (self-suppressed)"
else
    _no "case C: runtime gate row was present for a library repo (expected absent)"
fi

# 2. Byte-identity: evidence.json and report.md must be identical between the
#    gate-on and gate-off runs. produced_by timestamps are the only expected
#    difference across two runs, so normalize them out before comparing (both
#    files get the same normalization, so a real gate-induced difference still
#    shows). We compare the whole document minus the two wall-clock timestamps.
normalize_evidence() {
    python3 - "$1" <<'PYEOF' 2>/dev/null || true
import json, sys
d = json.load(open(sys.argv[1]))
pb = d.get("produced_by", {})
pb["run_started_at"] = "NORMALIZED"
pb["run_completed_at"] = "NORMALIZED"
print(json.dumps(d, indent=2, sort_keys=True))
PYEOF
}

NORM_BASE="$(normalize_evidence "$REPO_C/.loki/verify-baseline/evidence.json")"
NORM_CAND="$(normalize_evidence "$REPO_C/.loki/verify-candidate/evidence.json")"
if [ -n "$NORM_BASE" ] && [ "$NORM_BASE" = "$NORM_CAND" ]; then
    _ok "case C: evidence.json byte-identical (gate-on == gate-off) modulo run timestamps"
else
    _no "case C: evidence.json differs between gate-on and gate-off (no-app regression!)"
    diff <(printf '%s' "$NORM_BASE") <(printf '%s' "$NORM_CAND") | head -30
fi

# report.md has no runtime line and matches modulo the timestamp-derived paths.
# The report references the out dir in its Evidence path, so compare the gate
# TABLE region only (the part that would change if a runtime row leaked in).
BASE_GATES="$(grep -E '^\| (build|tests|static_analysis|secret_scan|dependency_audit|runtime|spec_drift) ' "$REPO_C/.loki/verify-baseline/report.md" 2>/dev/null || true)"
CAND_GATES="$(grep -E '^\| (build|tests|static_analysis|secret_scan|dependency_audit|runtime|spec_drift) ' "$REPO_C/.loki/verify-candidate/report.md" 2>/dev/null || true)"
if [ "$BASE_GATES" = "$CAND_GATES" ]; then
    _ok "case C: report.md gate table identical (no runtime row leaked)"
else
    _no "case C: report.md gate table differs (no-app regression!)"
    diff <(printf '%s' "$BASE_GATES") <(printf '%s' "$CAND_GATES") | head -20
fi

# ---------------------------------------------------------------------------
# Case D: DEFAULT-PORT path (no LOKI_APP_PORT override). Proves the gate exports
# PORT=<detected default> so a 12-factor app that honors process.env.PORT boots
# where the probe looks. Without the PORT export this case would time out and
# emit a false "did not boot" High finding on an app that actually runs -- the
# exact false-positive a verifier must not have. The app defaults to an
# unusual port (59999) when PORT is unset, so a pass PROVES the gate set PORT to
# the detected default (npm -> 3000), not that the app happened to bind 3000.
# ---------------------------------------------------------------------------
if [ "$HAVE_NODE" = "true" ] && [ -n "$TIMEOUT_BIN" ]; then
    # Reclaim the default port the gate will probe for an npm app (3000), in case
    # a leftover server holds it, so the test is hermetic. Kill any holder, then
    # WAIT (bounded) until the port is actually free before booting -- a residual
    # server from a rapidly preceding run would otherwise answer the probe on a
    # dead app or block our own bind, flaking the case.
    if command -v lsof >/dev/null 2>&1; then
        _d=0
        while [ "$_d" -lt 10 ]; do
            _holders="$(lsof -ti tcp:3000 2>/dev/null || true)"
            [ -z "$_holders" ] && break
            printf '%s\n' "$_holders" | while IFS= read -r p; do
                [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
            done
            sleep 1; _d=$((_d + 1))
        done
    fi
    REPO_D="$TMP_ROOT/case-d"
    init_repo "$REPO_D"
    # Server binds process.env.PORT; if PORT is UNSET it uses 59999 (a port the
    # gate never probes). So a green result can only mean the gate set PORT=3000.
    cat > "$REPO_D/server.js" <<'JS'
const http = require('http');
const port = process.env.PORT || 59999;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body>default-port ok</body></html>');
}).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
JS
    cat > "$REPO_D/package.json" <<'JSON'
{
  "name": "case-d",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  }
}
JSON
    commit_feature "$REPO_D"

    # NO LOKI_APP_PORT: the gate must resolve npm -> 3000 and export PORT=3000.
    run_verify "$REPO_D"
    STATUS_D="$(gate_status "$REPO_D" runtime)"
    if [ "$STATUS_D" = "pass" ]; then
        _ok "case D: default-port path passes (gate exported PORT=3000 to the app)"
    else
        _no "case D: default-port status was '$STATUS_D' (expected pass; PORT export broken?)"
    fi

    # Reclaim 3000 after the case so nothing lingers for other suites.
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti tcp:3000 2>/dev/null | while IFS= read -r p; do
            [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
        done
    fi
else
    _skip "case D: needs node + a timeout binary"
fi

# ---------------------------------------------------------------------------
# Case E: Node CLI/library WITH a conventional "start" script but NO HTTP signal
# (no server framework dep, no listen/createServer). This is the false-RED shape
# the review flagged: "start":"node cli.js" on a CLI that prints and exits. The
# gate MUST NOT treat it as an HTTP app -> NO gate row, verdict not BLOCKED by
# runtime. Byte-identity for CLIs/libraries with start scripts.
# ---------------------------------------------------------------------------
REPO_E="$TMP_ROOT/case-e"
init_repo "$REPO_E"
cat > "$REPO_E/cli.js" <<'JS'
// A legitimate CLI: prints and exits 0. NOT a server (no listen/createServer).
console.log("mycli: did the thing");
process.exit(0);
JS
cat > "$REPO_E/package.json" <<'JSON'
{
  "name": "mycli",
  "version": "1.0.0",
  "bin": { "mycli": "cli.js" },
  "scripts": { "start": "node cli.js" }
}
JSON
commit_feature "$REPO_E"

# detect must return empty (no HTTP signal) -> no boot, no row.
DET_E="$(_verify_runtime_detect "$REPO_E" 2>/dev/null || true)"
if [ -z "$DET_E" ]; then
    _ok "case E: Node CLI with start script + no HTTP signal -> detect empty (no false-RED)"
else
    _no "case E: Node CLI wrongly detected as bootable HTTP app (got '$DET_E')"
fi
# End-to-end: the gate emits NO runtime row and the verdict is not BLOCKED by it.
run_verify "$REPO_E"
STATUS_E="$(gate_status "$REPO_E" runtime)"
if [ -z "$STATUS_E" ] || [ "$STATUS_E" = "absent" ]; then
    _ok "case E: no runtime gate row for a Node CLI (byte-identity preserved)"
else
    _no "case E: runtime gate row '$STATUS_E' on a Node CLI (false-RED regression)"
fi

# Positive control: the same package.json but WITH an http.createServer source
# MUST still be detected (the fix must not over-suppress real servers).
REPO_F="$TMP_ROOT/case-f"
init_repo "$REPO_F"
cat > "$REPO_F/server.js" <<'JS'
const http = require('http');
http.createServer((req,res)=>{res.writeHead(200);res.end('ok');}).listen(process.env.PORT||3000,'127.0.0.1');
JS
cat > "$REPO_F/package.json" <<'JSON'
{ "name": "srv", "version": "1.0.0", "scripts": { "start": "node server.js" } }
JSON
commit_feature "$REPO_F"
DET_F="$(_verify_runtime_detect "$REPO_F" 2>/dev/null || true)"
if [ -n "$DET_F" ]; then
    _ok "case F: Node app WITH createServer/listen signal IS still detected (no over-suppression)"
else
    _no "case F: Node HTTP server no longer detected after the signal fix (over-suppression!)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== summary: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
