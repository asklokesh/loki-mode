#!/usr/bin/env bash
# shellcheck disable=SC2015

# MCP-D: a loki_v10_verify Task is a read-only wrapper. Its result is byte-identical to calling the
# adapter directly, the receipt file is untouched, and nothing but verify/run is reachable.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-mcpd.XXXXXXXX")" || exit 1
PASSED=0
FAILED=0
cleanup() { [ -n "${WORK:-}" ] && [ -d "$WORK" ] && rm -rf -- "$WORK"; }
trap cleanup EXIT
pass() { PASSED=$((PASSED + 1)); echo "[PASS] $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[FAIL] $1"; }

export LOKI_NO_BROWSER=1
command -v python3 >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || { echo "SKIP: python3 or node missing"; exit 0; }

ADAPTER="$ROOT/mcp/v10_tools.py"
mkdir -p "$WORK/repo" || exit 1
printf '%s\n' '{"schema":"loki.v10.receipt/1","run_id":"r1","verdict":"VERIFIED"}' >"$WORK/repo/receipt.json"
cd "$WORK/repo" || exit 1
before="$(shasum -a 256 receipt.json | cut -d' ' -f1)"

direct="$(python3 -I "$ADAPTER" verify "$WORK/repo/receipt.json" "$WORK/repo")"
direct_rc=$?
[ "$direct_rc" -eq 0 ] && [ -n "$direct" ] && pass "direct adapter call prints one result line" || fail "direct adapter call rc=$direct_rc"

task="$(ADAPTER_ROOT="$ROOT" RECEIPT="$WORK/repo/receipt.json" REPO="$WORK/repo" LOKI_MCP_TASKS=1 node -e '
const s = require(process.env.ADAPTER_ROOT + "/src/protocols/mcp-server.js");
const call = (m, p) => s.handleRequest({ jsonrpc: "2.0", method: m, params: p, id: 1 });
const c = call("tasks/create", { tool: "loki_v10_verify", arguments: { receipt_path: process.env.RECEIPT, repo_path: process.env.REPO } });
if (c.error) { console.error(JSON.stringify(c.error)); process.exit(3); }
const id = c.result.task.taskId;
const t0 = Date.now();
(function poll() {
  const st = call("tasks/get", { taskId: id }).result.task.status;
  if (st === "working") { if (Date.now() - t0 > 150000) process.exit(4); return setTimeout(poll, 100); }
  const r = call("tasks/result", { taskId: id });
  process.stdout.write(r.result.content[0].text);
})();
')"
task_rc=$?
[ "$task_rc" -eq 0 ] && pass "task finished" || fail "task rc=$task_rc"
[ "$task" = "$direct" ] && pass "task result is byte-identical to the direct result" || fail "task result differs: [$task] vs [$direct]"

after="$(shasum -a 256 receipt.json | cut -d' ' -f1)"
[ "$before" = "$after" ] && pass "receipt file unchanged" || fail "receipt file changed"

python3 -I "$ADAPTER" status r1 x >/dev/null 2>&1
[ $? -eq 2 ] && pass "adapter refuses any command other than verify/run" || fail "adapter accepted an unknown command"

out="$(python3 -I "$ADAPTER" verify "" /etc 2>&1)"
case "$out" in *"outside the working directory"*) pass "adapter refuses a path outside the working directory" ;; *) fail "outside path not refused: $out" ;; esac

echo "Passed: $PASSED  Failed: $FAILED"
[ "$FAILED" -eq 0 ]
