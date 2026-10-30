#!/usr/bin/env bash
# Test: Loki CLI Commands
# Tests non-destructive CLI commands that are safe to run without an active session.
# These verify exit codes and expected output patterns.
#
# Note: Not using -e to allow collecting all test results

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
VERSION_FILE="$SCRIPT_DIR/../VERSION"

PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; ((FAIL++)); }

# Run a CLI command, check exit code and optionally grep for expected output
# Usage: test_cmd "description" expected_exit_code "grep_pattern" args...
test_cmd() {
    local desc="$1"
    local expected_exit="$2"
    local pattern="$3"
    shift 3

    ((TOTAL++))

    local output
    local actual_exit=0
    output=$("$LOKI" "$@" 2>&1) || actual_exit=$?

    if [ "$actual_exit" -ne "$expected_exit" ]; then
        log_fail "$desc" "expected exit $expected_exit, got $actual_exit"
        return 0
    fi

    if [ -n "$pattern" ]; then
        # Case-insensitive substring check done in-shell (no pipe). Piping into
        # `grep -q` races: grep exits on first match and closes the pipe, so the
        # upstream `echo` is killed by SIGPIPE ("write error: Broken pipe"), and
        # on a loaded CI runner that broken-pipe exit can be misread as no-match.
        # A bash glob match has no subprocess and no pipe, so it is race-free.
        local hay_lc pat_lc
        hay_lc=$(printf '%s' "$output" | tr '[:upper:]' '[:lower:]')
        pat_lc=$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')
        case "$hay_lc" in
            *"$pat_lc"*) ;;
            *)
                log_fail "$desc" "output missing pattern: $pattern"
                echo "  Actual output (first 5 lines):"
                printf '%s\n' "$output" | head -5 | sed 's/^/    /'
                return 0
                ;;
        esac
    fi

    log_pass "$desc"
    return 0
}

echo "========================================"
echo "Loki CLI Command Tests"
echo "========================================"
echo "CLI: $LOKI"
echo "VERSION: $(cat "$VERSION_FILE")"
echo ""

# Verify the loki script exists and is executable
if [ ! -x "$LOKI" ]; then
    echo -e "${RED}Error: $LOKI not found or not executable${NC}"
    exit 1
fi

EXPECTED_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')

# -------------------------------------------
# Test: loki help
# -------------------------------------------
test_cmd "loki help exits 0 and shows Usage" \
    0 "Usage" help

# -------------------------------------------
# Test: loki --help
# -------------------------------------------
test_cmd "loki --help exits 0 and shows Usage" \
    0 "Usage" --help

# -------------------------------------------
# Test: loki version
# -------------------------------------------
test_cmd "loki version exits 0 and shows version" \
    0 "$EXPECTED_VERSION" version

# -------------------------------------------
# Test: loki --version
# -------------------------------------------
test_cmd "loki --version exits 0 and shows version" \
    0 "$EXPECTED_VERSION" --version

# -------------------------------------------
# Test: loki status
# -------------------------------------------
test_cmd "loki status exits 0" \
    0 "" status

# P12-19: status freshness label for the newest Loki 10 run (bash route)
((TOTAL++))
_fresh_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-fresh.XXXXXXXX")"
mkdir -p "$_fresh_dir/.loki/runs/e10-20261016T000000Z-aaaa"
printf '%s\n' '{"v":1,"seq":7,"ts":"2020-01-01T00:00:00Z","run":"e10-20261016T000000Z-aaaa","type":"heartbeat","stage":null,"data":{}}' > "$_fresh_dir/.loki/runs/e10-20261016T000000Z-aaaa/events.jsonl"
_fresh_out="$(cd "$_fresh_dir" && LOKI_DIR="$_fresh_dir/.loki" "$LOKI" status 2>&1)" || true
if grep -Eq 'last event [0-9]+s ago \(seq 7\)' <<<"$_fresh_out"; then
    log_pass "loki status shows last event age and seq"
else
    log_fail "loki status shows last event age and seq" "got: $_fresh_out"
fi
rm -rf -- "$_fresh_dir"

# -------------------------------------------
# Test: loki config show
# -------------------------------------------
test_cmd "loki config show exits 0 and shows Configuration" \
    0 "Configuration" config show

# -------------------------------------------
# Test: loki config path
# -------------------------------------------
test_cmd "loki config path exits 0" \
    0 "" config path

# -------------------------------------------
# FIX A (v7.34.0): the top-level help must NOT advertise a `config provider`
# subcommand that does not exist. `provider` is a settable KEY (config set
# provider X) and a SEPARATE top-level command (loki provider ...); it is not a
# config subcommand. The cmd_config handler has no `provider)` arm, so
# `loki config provider` falls through to the usage error.
# -------------------------------------------
((TOTAL++))
_help_out=$("$LOKI" help 2>&1) || true
case "$_help_out" in
    *"show|set|get|provider"*)
        log_fail "loki help does not claim a nonexistent config provider subcommand" \
            "help still advertises 'config ... provider' as a subcommand"
        ;;
    *)
        log_pass "loki help does not claim a nonexistent config provider subcommand"
        ;;
esac

# And `loki config provider` itself is not a real subcommand: it must NOT exit 0
# (unknown subcommand error pointing at help, exit 2, TEN-UX-26). We assert it
# reports the unknown subcommand rather than succeeding silently.
test_cmd "loki config provider is not a subcommand (unknown subcommand, exit 2)" \
    2 "unknown subcommand 'provider'" config provider

# -------------------------------------------
# Test: loki memory list
# -------------------------------------------
test_cmd "loki memory list exits 0 and shows Learnings" \
    0 "Learnings" memory list

# -------------------------------------------
# Test: loki compound list
# -------------------------------------------
test_cmd "loki compound list exits 0 and shows Solutions" \
    0 "Solutions" compound list

# -------------------------------------------
# Test: loki provider list
# -------------------------------------------
test_cmd "loki provider list exits 0 and shows claude" \
    0 "claude" provider list

# -------------------------------------------
# Test: loki provider show
# -------------------------------------------
test_cmd "loki provider show exits 0 and shows provider" \
    0 "provider" provider show

# -------------------------------------------
# Test: loki completions bash
# -------------------------------------------
test_cmd "loki completions bash exits 0 and shows complete" \
    0 "complete" completions bash

# -------------------------------------------
# Test: loki completions zsh
# -------------------------------------------
test_cmd "loki completions zsh exits 0 and shows compdef" \
    0 "compdef" completions zsh

# -------------------------------------------
# Test: loki preview --help
# -------------------------------------------
test_cmd "loki preview --help exits 0 and shows Usage" \
    0 "Usage: loki preview" preview --help

# -------------------------------------------
# Test: loki preview with no running app (honest message, exit 0)
# Run against an ISOLATED empty LOKI_DIR so the assertion is deterministic and
# does not depend on a stray .loki/app-runner/state.json in the test cwd (the
# command reads ${LOKI_DIR:-.loki}/app-runner/state.json).
# -------------------------------------------
_PREVIEW_TMP=$(mktemp -d 2>/dev/null || echo "/tmp/loki-preview-test-$$")
mkdir -p "$_PREVIEW_TMP"
LOKI_DIR="$_PREVIEW_TMP" test_cmd "loki preview --no-open exits 0 with no app running" \
    0 "No app running" preview --no-open
rm -rf "$_PREVIEW_TMP"

# -------------------------------------------
# Test: loki spec --help
# -------------------------------------------
test_cmd "loki spec --help exits 0 and shows the living-spec usage" \
    0 "the living spec" spec --help

# -------------------------------------------
# Test: loki spec status with no spec present -> usage error exit 2.
# Run in an ISOLATED empty dir so no stray prd.md/.loki is picked up.
# -------------------------------------------
_SPEC_TMP=$(mktemp -d 2>/dev/null || echo "/tmp/loki-spec-test-$$")
mkdir -p "$_SPEC_TMP"
( cd "$_SPEC_TMP" && "$LOKI" spec status >/dev/null 2>&1; [ "$?" -eq 2 ] ) \
    && { echo -e "${GREEN}[PASS]${NC} loki spec status with no spec exits 2 (usage)"; ((PASS++)); } \
    || { echo -e "${RED}[FAIL]${NC} loki spec status with no spec -- expected exit 2"; ((FAIL++)); }
((TOTAL++))
rm -rf "$_SPEC_TMP"

# -------------------------------------------
# Test: loki grill --help
# -------------------------------------------
test_cmd "loki grill --help exits 0 and shows the interrogation usage" \
    0 "interrogate a spec" grill --help

# -------------------------------------------
# Test: loki grill with no spec present -> usage error exit 2.
# -------------------------------------------
_GRILL_TMP=$(mktemp -d 2>/dev/null || echo "/tmp/loki-grill-test-$$")
mkdir -p "$_GRILL_TMP"
( cd "$_GRILL_TMP" && "$LOKI" grill >/dev/null 2>&1; [ "$?" -eq 2 ] ) \
    && { echo -e "${GREEN}[PASS]${NC} loki grill with no spec exits 2 (usage)"; ((PASS++)); } \
    || { echo -e "${RED}[FAIL]${NC} loki grill with no spec -- expected exit 2"; ((FAIL++)); }
((TOTAL++))

# -------------------------------------------
# Test: loki grill with an unavailable provider -> clean error exit 3.
# Uses a bogus LOKI_PROVIDER so the failure is deterministic regardless of
# whether the claude CLI is installed on the runner. Honest no-provider path:
# never a silent success, never fabricated questions.
# -------------------------------------------
printf '# Spec\n## Feature\nDo a thing.\n' > "$_GRILL_TMP/prd.md"
( cd "$_GRILL_TMP" && LOKI_PROVIDER=bogus "$LOKI" grill prd.md >/dev/null 2>&1; [ "$?" -eq 3 ] ) \
    && { echo -e "${GREEN}[PASS]${NC} loki grill with an unavailable provider exits 3 (clean error)"; ((PASS++)); } \
    || { echo -e "${RED}[FAIL]${NC} loki grill unavailable provider -- expected exit 3"; ((FAIL++)); }
((TOTAL++))

# -------------------------------------------
# Test: loki grill SUCCESS path with a stubbed provider.
# Regression guard for the printf leading-dash bug (council R2, v7.28.0):
# bash's printf builtin parsed '- Spec: %s\n' as an option flag and silently
# dropped the report metadata header lines. Stub a fake `claude` on PATH so
# the success path runs deterministically with no cost, then assert the
# report file carries the '- Spec:' and '- Provider:' header lines and the
# stubbed body, with zero printf errors on stderr.
# -------------------------------------------
_GRILL_STUB=$(mktemp -d 2>/dev/null || echo "/tmp/loki-grillstub-test-$$")
mkdir -p "$_GRILL_STUB/bin"
printf '#!/usr/bin/env bash\necho "Q1: What happens when the thing fails?"\n' > "$_GRILL_STUB/bin/claude"
chmod +x "$_GRILL_STUB/bin/claude"
_GRILL_ERR="$_GRILL_STUB/stderr.txt"
( cd "$_GRILL_TMP" \
    && PATH="$_GRILL_STUB/bin:$PATH" "$LOKI" grill prd.md >/dev/null 2>"$_GRILL_ERR"; [ "$?" -eq 0 ] ) \
    && grep -q -- "- Spec:" "$_GRILL_TMP/.loki/grill/report.md" 2>/dev/null \
    && grep -q -- "- Provider:" "$_GRILL_TMP/.loki/grill/report.md" 2>/dev/null \
    && grep -q "What happens when the thing fails" "$_GRILL_TMP/.loki/grill/report.md" 2>/dev/null \
    && ! grep -q "invalid option" "$_GRILL_ERR" 2>/dev/null \
    && { echo -e "${GREEN}[PASS]${NC} loki grill success path writes full report header (stubbed provider)"; ((PASS++)); } \
    || { echo -e "${RED}[FAIL]${NC} loki grill success path -- report header missing or printf error"; sed 's/^/    /' "$_GRILL_ERR" 2>/dev/null | head -4; ((FAIL++)); }
((TOTAL++))
rm -rf "$_GRILL_STUB" "$_GRILL_TMP"

# -------------------------------------------
# Test: loki quickstart --help (v7.29.0). Falls through to bash on both routes
# (not in the bin/loki Bun allowlist), so behaves identically Bun and bash.
# -------------------------------------------
test_cmd "loki quickstart --help exits 0 and shows the guided-build usage" \
    0 "guided first build" quickstart --help

# -------------------------------------------
# Test: loki quickstart with no TTY -> interactive-only refusal, exit 2.
# test_cmd captures via $(...), so stdin/stdout are not a TTY: the gate must
# fire and exit 2 with the automation hint, never hanging on a read.
# -------------------------------------------
test_cmd "loki quickstart non-TTY exits 2 with the automation hint" \
    2 "needs a terminal" quickstart

# -------------------------------------------
# Test: loki open alias --help routes to preview
# -------------------------------------------
test_cmd "loki open --help exits 0 and shows preview usage" \
    0 "Usage: loki preview" open --help

# -------------------------------------------
# Test: loki mcp --help (task 562 MCP server launcher)
# -------------------------------------------
test_cmd "loki mcp --help exits 0 and shows the MCP launcher usage" \
    0 "launch the MCP" mcp --help

# -------------------------------------------
# Test: loki api start --help short-circuits to help (#574), does NOT start
# the server. The help banner shows and exits 0; a started server would print a
# different first line and would not exit cleanly here.
# -------------------------------------------
test_cmd "loki api start --help shows help, does not start the server (#574)" \
    0 "Dashboard/API Server" api start --help
test_cmd "loki api start -h shows help (#574)" \
    0 "Dashboard/API Server" api start -h

# -------------------------------------------
# Test: unknown command exits non-zero
# -------------------------------------------
test_cmd "loki unknown-command exits 2 (usage error)" \
    2 "Unknown command" nonexistent-command-xyz

# -------------------------------------------
# Test: _loki_verdict_badge (share badge maker)
# -------------------------------------------
_badge_fn="$(awk '/^_loki_verdict_badge\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$LOKI")"
check_badge() {
    local desc="$1" expected="$2" headline="$3" url="$4" out
    ((TOTAL++))
    out="$(bash -c "$_badge_fn"$'\n''_loki_verdict_badge "$1" "$2"' _ "$headline" "$url")"
    if [ "$out" = "$expected" ]; then log_pass "$desc"; else log_fail "$desc" "got '$out'"; fi
}
_bu="https://gist.github.com/x/1"
_bi="https://img.shields.io/static/v1?label=Loki"
check_badge "badge: VERIFIED is brightgreen" "[![Loki: verified](${_bi}&message=verified&color=brightgreen)](${_bu})" "VERIFIED" "$_bu"
check_badge "badge: VERIFIED WITH GAPS is orange" "[![Loki: verified with gaps](${_bi}&message=verified%20with%20gaps&color=orange)](${_bu})" "VERIFIED WITH GAPS" "$_bu"
check_badge "badge: NOT VERIFIED is red" "[![Loki: not verified](${_bi}&message=not%20verified&color=red)](${_bu})" "NOT VERIFIED" "$_bu"
check_badge "badge: unmapped headline omitted" "" "PASSED" "$_bu"
check_badge "badge: empty headline omitted" "" "" "$_bu"
check_badge "badge: no url omitted" "" "VERIFIED" ""

# -------------------------------------------
# Test: loki try (clone a public repo into a run-owned temp dir, pick a task, keep the receipt)
# -------------------------------------------
# Everything runs under one test-owned TMPDIR so leftover loki-run.* dirs from loki try are countable.
_TRY_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
_TRY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-try-test.XXXXXXXX")"
_TRY_TMP="$_TRY_ROOT/tmp"
mkdir -p "$_TRY_TMP" "$_TRY_ROOT/home"
check_try() {
    local desc="$1" ok="$2" detail="${3:-}"
    ((TOTAL++))
    if [ "$ok" = "1" ]; then log_pass "$desc"; else log_fail "$desc" "$detail"; fi
}
try_has() { case "$1" in *"$2"*) echo 1 ;; *) echo 0 ;; esac; }
try_leftovers() { find "$_TRY_TMP" -mindepth 1 -maxdepth 1 -name 'loki-run.*' 2>/dev/null | wc -l | tr -d ' '; }

# Public-style fixture repo (file://) with one TODO line, and a separate caller checkout.
_TRY_FX="$_TRY_ROOT/fixture"
_TRY_CALLER="$_TRY_ROOT/caller"
mkdir -p "$_TRY_FX" "$_TRY_CALLER"
(
    cd "$_TRY_FX" && git init -q . \
        && printf '%s\n' '// TODO: retry the request on timeout' 'export const x = 1;' > app.js \
        && git add app.js && git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m init
    cd "$_TRY_CALLER" && git init -q . \
        && printf '%s\n' 'caller file' > mine.txt \
        && git add mine.txt && git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m caller
    printf '%s\n' 'uncommitted caller edit' >> mine.txt
) >/dev/null 2>&1
_try_caller_state() { (cd "$_TRY_CALLER" && git rev-parse HEAD && git status --porcelain && cksum mine.txt) 2>&1; }
_TRY_BEFORE="$(_try_caller_state)"

_try_out=""
_try_rc=0
_try_out="$(cd "$_TRY_CALLER" && env TMPDIR="$_TRY_TMP" HOME="$_TRY_ROOT/home" LOKI_NO_BROWSER=1 "$LOKI" try "file://$_TRY_FX" --dry-run 2>&1)" || _try_rc=$?
check_try "loki try file:// --dry-run exits 0" "$([ "$_try_rc" = "0" ] && echo 1 || echo 0)" "rc=$_try_rc: $_try_out"
check_try "loki try --dry-run prints the clone path" "$(try_has "$_try_out" 'Clone path: ')" "$_try_out"
check_try "loki try --dry-run picks the TODO line as the task" "$(try_has "$_try_out" 'Task: Resolve the TODO in app.js (line 1): // TODO: retry the request on timeout')" "$_try_out"
check_try "loki try --dry-run prints an estimate" "$(try_has "$_try_out" 'Estimate: ')" "$_try_out"
check_try "loki try --dry-run removes the temp clone" "$(try_has "$_try_out" 'Removed the temp clone.')" "$_try_out"

# No provider ready (bare PATH, empty HOME, no keys): one login/key line per supported provider, once, exit 2.
_try_rc=0
_try_out="$(cd "$_TRY_CALLER" && env -i PATH=/usr/bin:/bin TMPDIR="$_TRY_TMP" HOME="$_TRY_ROOT/home" LOKI_NO_BROWSER=1 "$LOKI" try "file://$_TRY_FX" 2>&1 </dev/null)" || _try_rc=$?
check_try "loki try with no provider ready exits 2" "$([ "$_try_rc" = "2" ] && echo 1 || echo 0)" "rc=$_try_rc: $_try_out"
for _tp in $(sed -n 's/^SUPPORTED_PROVIDERS=(\(.*\))$/\1/p' "$_TRY_REPO/providers/loader.sh" | tr -d '"'); do
    _tn="$(printf '%s\n' "$_try_out" | grep -c "^  $_tp: " || true)"
    check_try "loki try with no provider ready lists $_tp exactly once" "$([ "$_tn" = "1" ] && echo 1 || echo 0)" "count=$_tn: $_try_out"
done
check_try "loki try with no provider ready names the exact claude login" "$(try_has "$_try_out" '  claude: claude login')" "$_try_out"
check_try "loki try with no provider ready names the exact codex login" "$(try_has "$_try_out" '  codex: codex login')" "$_try_out"
# No provider ready (bare PATH, empty HOME, no keys): one login/key line per supported provider, once, exit 2.
_try_rc=0
_try_out="$(cd "$_TRY_CALLER" && env -i PATH=/usr/bin:/bin TMPDIR="$_TRY_TMP" HOME="$_TRY_ROOT/home" LOKI_NO_BROWSER=1 "$LOKI" try "file://$_TRY_FX" 2>&1 </dev/null)" || _try_rc=$?
check_try "loki try with no provider ready exits 2" "$([ "$_try_rc" = "2" ] && echo 1 || echo 0)" "rc=$_try_rc: $_try_out"
for _tp in $(sed -n 's/^SUPPORTED_PROVIDERS=(\(.*\))$/\1/p' "$_TRY_REPO/providers/loader.sh" | tr -d '"'); do
    _tn="$(printf '%s\n' "$_try_out" | grep -c "^  $_tp: " || true)"
    check_try "loki try with no provider ready lists $_tp exactly once" "$([ "$_tn" = "1" ] && echo 1 || echo 0)" "count=$_tn: $_try_out"
done
check_try "loki try with no provider ready names the exact claude login" "$(try_has "$_try_out" '  claude: claude login')" "$_try_out"
check_try "loki try with no provider ready names the exact codex login" "$(try_has "$_try_out" '  codex: codex login')" "$_try_out"
_try_rc=0
_try_out="$(cd "$_TRY_CALLER" && env TMPDIR="$_TRY_TMP" HOME="$_TRY_ROOT/home" "$LOKI" try ftp://example.com/x 2>&1)" || _try_rc=$?
check_try "loki try rejects a non-clone URL scheme with exit 2" "$([ "$_try_rc" = "2" ] && echo 1 || echo 0)" "rc=$_try_rc: $_try_out"
_try_rc=0
_try_out="$(cd "$_TRY_CALLER" && env TMPDIR="$_TRY_TMP" HOME="$_TRY_ROOT/home" "$LOKI" try "file://$_TRY_ROOT/does-not-exist" --dry-run 2>&1)" || _try_rc=$?
check_try "loki try reports a failed clone with exit 1" "$([ "$_try_rc" = "1" ] && echo 1 || echo 0)" "rc=$_try_rc: $_try_out"

# Live path with a stubbed engine (no model call). SKILL_DIR mirrors the repo except bin/loki; the stub
# start writes a really signed receipt so the kept copy can be re-checked with loki verify.
if command -v bun >/dev/null 2>&1; then
    _TRY_STUB="$_TRY_ROOT/skill"
    mkdir -p "$_TRY_STUB/bin" "$_TRY_ROOT/path" "$_TRY_ROOT/keep"
    for _e in "$_TRY_REPO"/*; do
        [ "$(basename "$_e")" = "bin" ] || ln -s "$_e" "$_TRY_STUB/$(basename "$_e")"
    done
    cat > "$_TRY_ROOT/fixture.ts" <<TS
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { computeReceiptHash } from "$_TRY_REPO/loki-ts/src/engine10/verify_cmd.ts";
import { kidOf } from "$_TRY_REPO/loki-ts/src/engine10/stages/seal.ts";
const dir = process.argv[2]!;
const f: Record<string, unknown> = {
  schema: "loki.v10.receipt/1", run_id: "e10-try-1", task: { source: "text", sha256: "a".repeat(64) }, repo: "o/r",
  base_sha: "b".repeat(40), head_sha: "c".repeat(40), tree: "d".repeat(40), diff_sha256: "e".repeat(64),
  wall: { files: [], passed: true }, checks: [{ name: "unit", cmd: "bun test", result: "pass", duration_s: 1 }],
  not_proven: ["full suite"], verdict: "VERIFIED", cost: { usd: 0.1, input_tokens: 1, output_tokens: 1 },
  time: { wall_s: 0, stages: {} }, provider: "claude", model: "m", resumed: false,
  events_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};
const k = generateKeyPairSync("ed25519");
const kid = kidOf(k.publicKey), hash = computeReceiptHash(f);
const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid })).toString("base64url");
const p = Buffer.from(JSON.stringify({ receipt_sha256: hash })).toString("base64url");
const jwt = h + "." + p + "." + sign(null, Buffer.from(h + "." + p), k.privateKey).toString("base64url");
writeFileSync(dir + "/signed-receipt.json", JSON.stringify({ ...f, receipt_sha256: hash, verification: { jwt, kid } }));
writeFileSync(dir + "/pub.pem", k.publicKey.export({ type: "spki", format: "pem" }));
TS
    if bun "$_TRY_ROOT/fixture.ts" "$_TRY_ROOT" >"$_TRY_ROOT/fixture.log" 2>&1; then
        cat > "$_TRY_STUB/bin/loki" <<STUB
#!/usr/bin/env bash
case "\$1" in
  start)
    mkdir -p .loki/runs/e10-try-1
    cp "$_TRY_ROOT/signed-receipt.json" .loki/runs/e10-try-1/receipt.json
    exit 0 ;;
esac
exit 0
STUB
        chmod +x "$_TRY_STUB/bin/loki"
        printf '#!/usr/bin/env bash\nexit 0\n' > "$_TRY_ROOT/path/claude"
        chmod +x "$_TRY_ROOT/path/claude"
        _try_rc=0
        _try_out="$(cd "$_TRY_CALLER" && env SKILL_DIR="$_TRY_STUB" PATH="$_TRY_ROOT/path:$PATH" ANTHROPIC_API_KEY=stub \
            TMPDIR="$_TRY_TMP" HOME="$_TRY_ROOT/home" LOKI_TRY_RECEIPT_DIR="$_TRY_ROOT/keep" LOKI_NO_BROWSER=1 \
            "$LOKI" try "file://$_TRY_FX" --provider claude 2>&1)" || _try_rc=$?
        _try_receipt="$(printf '%s\n' "$_try_out" | sed -n 's/^Receipt: //p' | head -1)"
        check_try "loki try live run (stub engine) exits 0 and prints a receipt path" \
            "$([ "$_try_rc" = "0" ] && [ -n "$_try_receipt" ] && [ -f "$_try_receipt" ] && echo 1 || echo 0)" "rc=$_try_rc: $_try_out"
        check_try "loki try live run prints the npx verify command for the kept receipt" \
            "$(try_has "$_try_out" "npx loki-mode verify $_try_receipt")" "$_try_out"
        check_try "loki try live run prints the npx verify command for the kept receipt" \
            "$(try_has "$_try_out" "npx loki-mode verify $_try_receipt")" "$_try_out"
        _try_vrc=0
        if [ -n "$_try_receipt" ]; then
            (cd "$_TRY_ROOT" && env -u LOKI_ENGINE LOKI_NO_BROWSER=1 LOKI_TELEMETRY_DISABLED=1 \
                LOKI_RECEIPT_RETIRED_PUBKEYS="$_TRY_ROOT/pub.pem" BUN_FROM_SOURCE=1 \
                timeout -k 5 120 bash "$_TRY_REPO/bin/loki" verify "$_try_receipt") >"$_TRY_ROOT/verify.out" 2>&1 || _try_vrc=$?
        else
            _try_vrc=99
        fi
        check_try "loki verify <kept receipt> exits 0" "$([ "$_try_vrc" = "0" ] && echo 1 || echo 0)" "rc=$_try_vrc: $(head -c 300 "$_TRY_ROOT/verify.out" 2>/dev/null)"
    else
        check_try "loki try live-run fixture generated" 0 "$(head -c 300 "$_TRY_ROOT/fixture.log")"
    fi
else
    echo "[SKIP] loki try live run: bun not installed"
fi

# --- loki try: untrusted-clone receipt handling (planted symlinks and a planted fake receipt) ---
# The stub engine writes no receipt, so anything reported or copied came from the clone itself.
_TRY_SECRET="$_TRY_ROOT/secret.txt"
printf '%s\n' 'SECRET_TOKEN_DO_NOT_COPY' > "$_TRY_SECRET"
mkdir -p "$_TRY_ROOT/ext/evil" "$_TRY_ROOT/ext2/evil" "$_TRY_ROOT/skill0/bin" "$_TRY_ROOT/path0"
printf '%s\n' 'SECRET_TOKEN_DO_NOT_COPY' > "$_TRY_ROOT/ext/evil/receipt.json"
printf '%s\n' 'SECRET_TOKEN_DO_NOT_COPY' > "$_TRY_ROOT/ext2/evil/receipt.json"
# Future mtimes make the symlink skip the only thing standing between the secret and the output dir.
touch -t 203012312359 "$_TRY_SECRET" "$_TRY_ROOT/ext/evil/receipt.json" "$_TRY_ROOT/ext2/evil/receipt.json"
for _e in "$_TRY_REPO"/*; do
    [ "$(basename "$_e")" = "bin" ] || ln -s "$_e" "$_TRY_ROOT/skill0/$(basename "$_e")"
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$_TRY_ROOT/skill0/bin/loki"
printf '#!/usr/bin/env bash\nexit 0\n' > "$_TRY_ROOT/path0/claude"
chmod +x "$_TRY_ROOT/skill0/bin/loki" "$_TRY_ROOT/path0/claude"

_try_plant() {
    # $1 = variant name; builds $_TRY_ROOT/plant-$1 as a git repo with a TODO and one planted entry
    local v="$1" d="$_TRY_ROOT/plant-$1"
    mkdir -p "$d"
    (
        cd "$d" && git init -q . && printf '%s\n' '// TODO: handle the edge case' > app.js
        case "$v" in
            filelink) mkdir -p .loki/runs/evil && ln -s "$_TRY_SECRET" .loki/runs/evil/receipt.json ;;
            dirlink) mkdir -p .loki/runs && ln -s "$_TRY_ROOT/ext/evil" .loki/runs/evil ;;
            runslink) mkdir -p .loki && ln -s "$_TRY_ROOT/ext2" .loki/runs ;;
            fake) mkdir -p .loki/runs/fake && printf '%s\n' '{"planted":"SECRET_TOKEN_DO_NOT_COPY"}' > .loki/runs/fake/receipt.json ;;
        esac
        git add -A . && git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m plant
    ) >/dev/null 2>&1
}
for _v in filelink dirlink runslink fake; do
    _try_plant "$_v"
    _keep="$_TRY_ROOT/keep-$_v"
    _try_rc=0
    _try_out="$(cd "$_TRY_CALLER" && env SKILL_DIR="$_TRY_ROOT/skill0" PATH="$_TRY_ROOT/path0:$PATH" ANTHROPIC_API_KEY=stub \
        TMPDIR="$_TRY_TMP" HOME="$_TRY_ROOT/home" LOKI_TRY_RECEIPT_DIR="$_keep" LOKI_NO_BROWSER=1 \
        "$LOKI" try "file://$_TRY_ROOT/plant-$_v" --provider claude 2>&1)" || _try_rc=$?
    _try_files="$(find "$_keep" -type f 2>/dev/null | wc -l | tr -d ' ')"
    _try_leak="$(grep -rl SECRET_TOKEN_DO_NOT_COPY "$_keep" 2>/dev/null | wc -l | tr -d ' ')"
    check_try "loki try planted $_v: nothing is copied to the output dir" "$([ "$_try_files" = "0" ] && [ "$_try_leak" = "0" ] && echo 1 || echo 0)" "files=$_try_files leak=$_try_leak"
    check_try "loki try planted $_v: no Receipt line is reported" "$(case "$_try_out" in *'Receipt:'*) echo 0 ;; *) echo 1 ;; esac)" "$_try_out"
    check_try "loki try planted $_v: says no receipt was written and exits non-zero" "$([ "$_try_rc" != "0" ] && case "$_try_out" in *'No receipt was written'*) echo 1 ;; *) echo 0 ;; esac)" "rc=$_try_rc: $_try_out"
done

# --- loki try: control characters in the task never reach the task text or the terminal ---
_try_ctl_task="$(cd "$_TRY_ROOT" && env TMPDIR="$_TRY_TMP" bash -c '
    eval "$(awk "/^try_pick_task\\(\\) \\{/,/^}/" "$1")"
    d="$2/ctl"; mkdir -p "$d/repo" && cd "$d/repo" && git init -q . && printf "// TODO: fix \033[31mred\033[0m \007bell\n" > a.js && git add a.js \
      && git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m c
    try_pick_task "$d/repo" file:///x' _ "$LOKI" "$_TRY_ROOT" 2>&1)"
check_try "loki try task text has no control characters" "$([ -n "$_try_ctl_task" ] && ! printf '%s' "$_try_ctl_task" | LC_ALL=C grep -q "[[:cntrl:]]" && echo 1 || echo 0)" "$(printf '%s' "$_try_ctl_task" | od -c | head -3)"

# --- temp-dir refusal guards: each unsafe directory must survive the cleanup call ---
_try_cleanup_call() {
    # $1 = dir; runs the real try_tmp_cleanup (and wow_cleanup_dir) extracted from the CLI under TMPDIR=$_TRY_TMP
    (env TMPDIR="$_TRY_TMP" bash -c '
        eval "$(awk "/^wow_cleanup_dir\\(\\) \\{/,/^}/" "$1")"
        eval "$(awk "/^try_tmp_cleanup\\(\\) \\{/,/^}/" "$1")"
        try_tmp_cleanup "$2"' _ "$LOKI" "$1") >/dev/null 2>&1 || true
}
_G="$_TRY_ROOT/guards"
mkdir -p "$_G/outside"
_TRY_RT="$(cd "$_TRY_TMP" && pwd -P)"
# positive control: a directory that satisfies every rule IS removed
mkdir -p "$_TRY_RT/loki-run.okay1234"
printf '%s\n' "$_TRY_RT/loki-run.okay1234" > "$_TRY_RT/loki-run.okay1234/.loki-run-owned"
_try_cleanup_call "$_TRY_RT/loki-run.okay1234"
check_try "temp guard: a valid owned dir is removed (positive control)" "$([ ! -e "$_TRY_RT/loki-run.okay1234" ] && echo 1 || echo 0)"
# outside the temp root, valid name and marker
mkdir -p "$_G/outside/loki-run.abcd1234"
printf '%s\n' "$_G/outside/loki-run.abcd1234" > "$_G/outside/loki-run.abcd1234/.loki-run-owned"
_try_cleanup_call "$_G/outside/loki-run.abcd1234"
check_try "temp guard: a dir outside the temp root is refused" "$([ -d "$_G/outside/loki-run.abcd1234" ] && echo 1 || echo 0)"
# direct child of the root but outside the loki-run namespace, valid marker
mkdir -p "$_TRY_RT/other.abcd1234"
printf '%s\n' "$_TRY_RT/other.abcd1234" > "$_TRY_RT/other.abcd1234/.loki-run-owned"
_try_cleanup_call "$_TRY_RT/other.abcd1234"
check_try "temp guard: a temp-root child outside the loki-run namespace is refused" "$([ -d "$_TRY_RT/other.abcd1234" ] && echo 1 || echo 0)"
# symlink named loki-run.* pointing at a real dir
mkdir -p "$_G/real"
printf '%s\n' "$_TRY_RT/loki-run.link1234" > "$_G/real/.loki-run-owned"
ln -s "$_G/real" "$_TRY_RT/loki-run.link1234"
_try_cleanup_call "$_TRY_RT/loki-run.link1234"
check_try "temp guard: a symlinked dir is refused and its target kept" "$([ -L "$_TRY_RT/loki-run.link1234" ] && [ -f "$_G/real/.loki-run-owned" ] && echo 1 || echo 0)"
# loki-run.* with no marker
mkdir -p "$_TRY_RT/loki-run.nomark12"
_try_cleanup_call "$_TRY_RT/loki-run.nomark12"
check_try "temp guard: a loki-run dir with no marker is refused" "$([ -d "$_TRY_RT/loki-run.nomark12" ] && echo 1 || echo 0)"
# marker that does not equal the path
mkdir -p "$_TRY_RT/loki-run.badmark1"
printf '%s\n' "$_TRY_RT/loki-run.someother" > "$_TRY_RT/loki-run.badmark1/.loki-run-owned"
_try_cleanup_call "$_TRY_RT/loki-run.badmark1"
check_try "temp guard: a marker that is not the dir path is refused" "$([ -d "$_TRY_RT/loki-run.badmark1" ] && echo 1 || echo 0)"
rm -f "$_TRY_RT/loki-run.link1234"
rmdir "$_TRY_RT/loki-run.nomark12"
rm -f "$_TRY_RT/loki-run.badmark1/.loki-run-owned" "$_TRY_RT/other.abcd1234/.loki-run-owned"
rmdir "$_TRY_RT/loki-run.badmark1" "$_TRY_RT/other.abcd1234"

# --- INT / TERM / HUP mid-run: the temp clone is removed and the exit code names the signal ---
mkdir -p "$_TRY_ROOT/skill1/bin" "$_TRY_ROOT/sync"
for _e in "$_TRY_REPO"/*; do
    [ "$(basename "$_e")" = "bin" ] || ln -s "$_e" "$_TRY_ROOT/skill1/$(basename "$_e")"
done
cat > "$_TRY_ROOT/skill1/bin/loki" <<STUB
#!/usr/bin/env bash
: > "$_TRY_ROOT/sync/started"
sleep 20
exit 0
STUB
chmod +x "$_TRY_ROOT/skill1/bin/loki"
for _sig in INT:130 TERM:143 HUP:129; do
    _sn="${_sig%%:*}"; _sc="${_sig##*:}"
    rm -f "$_TRY_ROOT/sync/started"
    set -m
    # A suite launched with SIGINT or SIGHUP ignored (CI runners, nohup) hands that to its background jobs and bash cannot trap an
    # ignored-on-entry signal, so restore the default dispositions before exec.
    python3 -c 'import os, signal, sys; [signal.signal(s, signal.SIG_DFL) for s in (signal.SIGINT, signal.SIGHUP, signal.SIGTERM)]; os.execvp(sys.argv[1], sys.argv[1:])' \
        env SKILL_DIR="$_TRY_ROOT/skill1" PATH="$_TRY_ROOT/path0:$PATH" ANTHROPIC_API_KEY=stub TMPDIR="$_TRY_TMP" \
        HOME="$_TRY_ROOT/home" LOKI_TRY_RECEIPT_DIR="$_TRY_ROOT/keep-sig" LOKI_NO_BROWSER=1 \
        "$LOKI" try "file://$_TRY_FX" --provider claude >"$_TRY_ROOT/sig.out" 2>&1 &
    _sp=$!
    set +m
    _i=0
    while [ ! -f "$_TRY_ROOT/sync/started" ] && [ "$_i" -lt 100 ]; do sleep 0.1; _i=$((_i + 1)); done
    _during="$(try_leftovers)"
    kill -s "$_sn" "$_sp" 2>/dev/null || true
    _src=0
    wait "$_sp" || _src=$?
    check_try "loki try $_sn mid-run: clone existed during the run, then 0 loki-run.* dirs remain, exit $_sc" \
        "$([ "$_during" = "1" ] && [ "$(try_leftovers)" = "0" ] && [ "$_src" = "$_sc" ] && echo 1 || echo 0)" \
        "during=$_during after=$(try_leftovers) rc=$_src: $(head -c 300 "$_TRY_ROOT/sig.out")"
done

check_try "loki try leaves 0 loki-run.* dirs behind" "$([ "$(try_leftovers)" = "0" ] && echo 1 || echo 0)" "found $(try_leftovers): $(ls -A "$_TRY_TMP" 2>&1)"
_TRY_AFTER="$(_try_caller_state)"
check_try "loki try leaves the caller checkout unchanged (HEAD, status, file bytes)" "$([ "$_TRY_BEFORE" = "$_TRY_AFTER" ] && echo 1 || echo 0)" "before: $_TRY_BEFORE / after: $_TRY_AFTER"
case "$_TRY_ROOT" in */loki-try-test.*) rm -rf -- "$_TRY_ROOT" ;; esac

# -------------------------------------------
# Summary
# -------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (out of $TOTAL)"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
