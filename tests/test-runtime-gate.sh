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
# Case G: TEST-DIR EXCLUSION false-RED. A CLI/library whose ONLY
# createServer/.listen call lives in a test/ dir (a common shape:
# test/http.test.js spins up http.createServer().listen(0) for a fixture).
# The OLD detector grepped bare `.listen(`/`createServer(` with only
# node_modules/.git excluded, so it saw the test fixture and falsely marked the
# CLI as a bootable HTTP app -> emitted "npm start\t3000" -> false-RED boot
# failure. The fix excludes test/tests/__tests__/examples/example/dist/build/spec
# and keys on a STRONG module-qualified server constructor, so a server that only
# exists in test/ no longer counts. Detect MUST return empty here.
#
# This case is the specific regression guard: unlike case E (no server anywhere)
# and case F (server at repo root), only case G's result FLIPS between the old
# (detects -> "npm start\t3000") and fixed (empty) detector, so it is the case
# that actually fails on the unfixed behavior. Verified against the real old
# function extracted from HEAD: old emitted "npm start\t3000", new emits empty.
# ---------------------------------------------------------------------------
REPO_G="$TMP_ROOT/case-g"
init_repo "$REPO_G"
mkdir -p "$REPO_G/bin" "$REPO_G/test"
# The actual program: a CLI that prints and exits -- no server.
cat > "$REPO_G/bin/cli.js" <<'JS'
#!/usr/bin/env node
console.log("hello from cli");
process.exit(0);
JS
cat > "$REPO_G/package.json" <<'JSON'
{ "name": "mycli", "version": "1.0.0", "scripts": { "start": "node bin/cli.js" } }
JSON
# The ONLY createServer/.listen in the repo lives under test/ (a fixture).
cat > "$REPO_G/test/http.test.js" <<'JS'
const http = require('http');
const srv = http.createServer((req, res) => res.end('ok'));
srv.listen(0, () => { srv.close(); });
JS
commit_feature "$REPO_G"

# detect MUST return empty: the test/-only server does not make this a web app.
DET_G="$(_verify_runtime_detect "$REPO_G" 2>/dev/null || true)"
if [ -z "$DET_G" ]; then
    _ok "case G: CLI whose only createServer/.listen is in test/ -> detect empty (no false-RED)"
else
    _no "case G: test/-only server wrongly detected as bootable HTTP app (got '$DET_G'; test-dir exclusion regressed)"
fi
# End-to-end: no runtime gate row leaks in for this CLI.
run_verify "$REPO_G"
STATUS_G="$(gate_status "$REPO_G" runtime)"
if [ -z "$STATUS_G" ] || [ "$STATUS_G" = "absent" ]; then
    _ok "case G: no runtime gate row for a CLI with a test/-only server (byte-identity preserved)"
else
    _no "case G: runtime gate row '$STATUS_G' on a CLI with only a test/ server (false-RED regression)"
fi

# Positive control for case G: move the SAME server out of test/ (to server.js at
# root) and it MUST be detected again -- proving the exclusion is scoped to
# test/example/dist and does not over-suppress a real co-located server.
REPO_G2="$TMP_ROOT/case-g2"
init_repo "$REPO_G2"
cat > "$REPO_G2/server.js" <<'JS'
const http = require('http');
const srv = http.createServer((req, res) => res.end('ok'));
srv.listen(process.env.PORT || 3000);
JS
cat > "$REPO_G2/package.json" <<'JSON'
{ "name": "myserver", "version": "1.0.0", "scripts": { "start": "node server.js" } }
JSON
commit_feature "$REPO_G2"
DET_G2="$(_verify_runtime_detect "$REPO_G2" 2>/dev/null || true)"
if [ -n "$DET_G2" ]; then
    _ok "case G2: same server at repo root (not in test/) IS still detected (exclusion not over-broad)"
else
    _no "case G2: root server.js no longer detected after test-dir exclusion (over-suppression!)"
fi

# ---------------------------------------------------------------------------
# Case H: NON-DEFAULT bound port scraped from boot.log (the v7.109.0 false-RED
# fix). Detection maps a vite-signalled npm app to the default port 3000, but the
# app IGNORES PORT and always binds 5173, printing a Vite-style
# "Local: http://localhost:5173/" banner. The gate must scrape 5173 from the boot
# log and re-point the probe THERE (not the guessed 3000) -> pass.
#
# Regression property: with the pre-fix detector (probe stays on the guessed
# default 3000, where nothing listens) this app false-REDs (boot timeout -> High
# finding -> not VERIFIED). So a green here can only mean the scrape ran.
#
# The url assertion is the tight guard: it fails not only on a full revert (probe
# stuck on 3000 -> timeout -> status != pass) but also on the degenerate "fix"
# where the default-port map is edited to 5173 (status would pass, but the scrape
# never ran and the recorded url would carry the guessed default). The app binds
# 5173 UNCONDITIONALLY (ignores PORT) so the gate's `export PORT=3000` cannot make
# it bind 3000 -- if it did, this case would green with the fix reverted (a dead
# guard). Mirrors case D's discipline in reverse (D proves PORT export; H proves
# boot-log scrape).
# ---------------------------------------------------------------------------
if [ "$HAVE_NODE" = "true" ] && [ -n "$TIMEOUT_BIN" ]; then
    # Hermeticity: reclaim BOTH 3000 (the guessed default -- must find nothing so
    # a revert is caught) and 5173 (the real bound port -- a stray holder would
    # green a broken app or block our bind) before booting.
    if command -v lsof >/dev/null 2>&1; then
        for _hp in 3000 5173; do
            _h=0
            while [ "$_h" -lt 10 ]; do
                _holders="$(lsof -ti tcp:"$_hp" 2>/dev/null || true)"
                [ -z "$_holders" ] && break
                printf '%s\n' "$_holders" | while IFS= read -r p; do
                    [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
                done
                sleep 1; _h=$((_h + 1))
            done
        done
    fi
    REPO_H="$TMP_ROOT/case-h"
    init_repo "$REPO_H"
    # A vite-like server: IGNORES process.env.PORT, always binds 5173, and prints
    # the "Local: http://localhost:5173/" banner the scraper keys on.
    cat > "$REPO_H/server.js" <<'JS'
const http = require('http');
// Deliberately ignore process.env.PORT: mimic bare Vite which binds 5173 and
// ignores PORT. If this honored PORT, the gate's PORT=3000 export would bind
// 3000 and the case would pass even with the scrape fix reverted (a dead guard).
const port = 5173;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body>vite-like app on 5173</body></html>');
}).listen(port, '127.0.0.1', () => {
  console.log('  VITE ready');
  console.log('  Local:   http://localhost:5173/');
});
JS
    # vite dep -> HTTP signal (detected); default-port map sends npm -> 3000.
    cat > "$REPO_H/package.json" <<'JSON'
{
  "name": "case-h-vite",
  "version": "1.0.0",
  "scripts": { "start": "node server.js" },
  "dependencies": { "vite": "^5.0.0" }
}
JSON
    commit_feature "$REPO_H"

    # Precondition: detection resolves the WRONG default (3000), not 5173. This is
    # exactly the false-RED shape -- the guessed port is not where the app binds.
    DET_H="$(_verify_runtime_detect "$REPO_H" 2>/dev/null || true)"
    PORT_H="$(printf '%s' "$DET_H" | cut -f2)"
    if [ "$PORT_H" = "3000" ]; then
        _ok "case H: detection defaults to 3000 (the wrong guess; app really binds 5173)"
    else
        _no "case H: detection port was '$PORT_H' (expected the default 3000)"
    fi

    run_verify "$REPO_H"
    STATUS_H="$(gate_status "$REPO_H" runtime)"
    if [ "$STATUS_H" = "pass" ]; then
        _ok "case H: gate PASSES a server on a non-default port (5173 scraped from boot.log)"
    else
        _no "case H: runtime status was '$STATUS_H' (expected pass; boot-log port scrape broken -> false-RED)"
    fi

    # Tight guard: the recorded runtime.json url must carry the SCRAPED 5173, not
    # the guessed 3000. Catches a revert (probe stuck on 3000) AND a degenerate
    # default-map edit (status pass but scrape never ran).
    URL_H="$(python3 - "$REPO_H/.loki/verify/runtime" <<'PYEOF' 2>/dev/null || true
import json, os, sys
d = sys.argv[1]
try:
    files = [f for f in os.listdir(d) if f.endswith(".json")]
except Exception:
    sys.exit(0)
for f in files:
    try:
        rec = json.load(open(os.path.join(d, f)))
    except Exception:
        continue
    if isinstance(rec, dict) and rec.get("url"):
        print(rec["url"])
        break
PYEOF
)"
    case "$URL_H" in
        *:5173*) _ok "case H: probed url records the scraped port 5173 (url=$URL_H)" ;;
        *)       _no "case H: probed url did not record 5173 (url='$URL_H'; scrape did not re-point the probe)" ;;
    esac

    # Reclaim both ports after the case so nothing lingers for other suites.
    if command -v lsof >/dev/null 2>&1; then
        for _hp in 3000 5173; do
            lsof -ti tcp:"$_hp" 2>/dev/null | while IFS= read -r p; do
                [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
            done
        done
    fi
else
    _skip "case H: needs node + a timeout binary (node=$HAVE_NODE timeout=${TIMEOUT_BIN:-none})"
fi

# ---------------------------------------------------------------------------
# Case I: TEARDOWN reclaims the ACTUALLY-BOUND port when a server DAEMONIZES onto
# a non-detected port (the v7.109.0 port-leak fix). Detection maps a vite-signal
# npm app to the default 3000, but the launcher only prints a banner then spawns a
# FULLY DETACHED child (own process group, not a -P child of app_pid) that binds a
# different port and outlives the launcher, and the launcher exits 0.
#
# Regression property: the pre-fix teardown killed app_pid + its direct children
# and reclaimed ONLY the detected port (3000). The detached daemon is in its own
# process group (kill-chain misses it) and binds a port that is NOT 3000, so the
# detected-port-only reclaim misses it -> the daemon LEAKS (orphan holds the port
# after the gate returns). The fix scrapes the bound port from the boot banner and
# reclaims it too, so the port is CLEAN. This case is proven RED on
# `git show HEAD~:autonomy/verify.sh` (daemon still holding the port) and GREEN on
# the fixed code (port empty).
#
# Distinct from case H: H's listener is a child of app_pid and dies via the
# kill-chain regardless of the port fix; H only proves the SCRAPE re-points the
# probe. Here the daemon detaches, so ONLY the scraped-port reclaim can catch it
# -- this case isolates the teardown half of the fix. lsof is load-bearing (it IS
# the leak check) so this case additionally requires lsof.
# ---------------------------------------------------------------------------
DAEMON_PORT=41717   # non-detected bound port, distinct from case H's 3000/5173
if [ "$HAVE_NODE" = "true" ] && [ -n "$TIMEOUT_BIN" ] && command -v lsof >/dev/null 2>&1; then
    # Hermeticity: reclaim BOTH the guessed default 3000 and the daemon port so a
    # stray holder cannot green a broken teardown (or block the daemon's bind).
    for _ip in 3000 "$DAEMON_PORT"; do
        _ih=0
        while [ "$_ih" -lt 10 ]; do
            _iholders="$(lsof -ti tcp:"$_ip" 2>/dev/null || true)"
            [ -z "$_iholders" ] && break
            printf '%s\n' "$_iholders" | while IFS= read -r p; do
                [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
            done
            sleep 1; _ih=$((_ih + 1))
        done
    done

    REPO_I="$TMP_ROOT/case-i"
    init_repo "$REPO_I"
    # Launcher: print the banner for DAEMON_PORT (lands in boot.log -> scraper
    # keys on it), spawn a fully detached child (detached+unref, own process
    # group) that binds DAEMON_PORT and holds it, then EXIT 0 so the kill-chain
    # (kill app_pid / pkill -P app_pid) cannot reach the daemon. Only the
    # scraped-port lsof reclaim in teardown can free the port.
    cat > "$REPO_I/server.js" <<JS
const http = require('http');
const { spawn } = require('child_process');
const PORT = $DAEMON_PORT;
if (process.env.LOKI_DAEMON_CHILD === '1') {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>daemon on $DAEMON_PORT</body></html>');
  }).listen(PORT, '127.0.0.1');
  return;
}
console.log('  Local:   http://localhost:$DAEMON_PORT/');
const child = spawn(process.execPath, [__filename], {
  detached: true,
  stdio: 'ignore',
  env: Object.assign({}, process.env, { LOKI_DAEMON_CHILD: '1' }),
});
child.unref();
setTimeout(() => process.exit(0), 1500);
JS
    # vite dep -> HTTP signal (detected); default-port map sends npm -> 3000.
    cat > "$REPO_I/package.json" <<'JSON'
{
  "name": "case-i-daemon",
  "version": "1.0.0",
  "scripts": { "start": "node server.js" },
  "dependencies": { "vite": "^5.0.0" }
}
JSON
    commit_feature "$REPO_I"

    # Precondition: detection resolves the default 3000 (NOT the daemon port), so
    # the old detected-port-only reclaim provably targets the wrong port.
    DET_I="$(_verify_runtime_detect "$REPO_I" 2>/dev/null || true)"
    PORT_I="$(printf '%s' "$DET_I" | cut -f2)"
    if [ "$PORT_I" = "3000" ]; then
        _ok "case I: detection defaults to 3000 (daemon binds $DAEMON_PORT; old reclaim misses it)"
    else
        _no "case I: detection port was '$PORT_I' (expected the default 3000)"
    fi

    # Bound the worst case: the gate boots, probes, and tears down within this.
    ( cd "$REPO_I" && LOKI_RUNTIME_BOOT_TIMEOUT=15 bash "$VERIFY_SH" ) >/dev/null 2>&1 || true

    # Give any orphan a beat to settle, then check the daemon port. On the fixed
    # code teardown reclaimed the scraped $DAEMON_PORT -> no holder. On the pre-fix
    # code the detached daemon still holds it -> non-empty (LEAK).
    sleep 1
    LEAK_I="$(lsof -ti tcp:"$DAEMON_PORT" 2>/dev/null || true)"
    if [ -z "$LEAK_I" ]; then
        _ok "case I: teardown reclaimed the daemonized non-detected port $DAEMON_PORT (no orphan leaked)"
    else
        _no "case I: orphan still holds tcp:$DAEMON_PORT after teardown (pids: $LEAK_I) -- port-leak fix regressed"
    fi

    # Reclaim both ports after the case so nothing lingers for other suites.
    for _ip in 3000 "$DAEMON_PORT"; do
        lsof -ti tcp:"$_ip" 2>/dev/null | while IFS= read -r p; do
            [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
        done
    done
else
    _skip "case I: needs node + a timeout binary + lsof (node=$HAVE_NODE timeout=${TIMEOUT_BIN:-none} lsof=$(command -v lsof >/dev/null 2>&1 && echo yes || echo no))"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== summary: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
