#!/usr/bin/env bash
# B2: the "Loki Receipt" check Action script runs `loki verify --pubkey` and posts a check run
# through `gh api`. A fixture receipt signed by a throwaway key posts success; a one-byte flip
# posts failure. `gh` is a stub on PATH that records argv; nothing touches ~/.loki or the network.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/.github/actions/receipt-check/check.sh"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

if ! command -v bun >/dev/null 2>&1; then
    echo "SKIP: bun not installed"
    exit 0
fi

loki_run_tmp_create() {
    local temp_root marker
    [ -z "${LOKI_RUN_TMP:-}" ] || return 64
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64
    LOKI_RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || return 1
    marker="${LOKI_RUN_TMP}/.loki-run-owned"
    chmod 700 "$LOKI_RUN_TMP" || return 1
    { printf '%s\n' "$LOKI_RUN_TMP" >"$marker" && chmod 600 "$marker"; } || return 1
    export LOKI_RUN_TMP
}
loki_run_tmp_cleanup() {
    local target="${LOKI_RUN_TMP:-}" temp_root
    [ -n "$target" ] || return 0
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64
    case "$target" in "${temp_root}"/loki-run.*) ;; *) return 64 ;; esac
    { [ -d "$target" ] && [ ! -L "$target" ] && [ -f "$target/.loki-run-owned" ]; } || return 64
    [ "$(head -n1 "$target/.loki-run-owned")" = "$target" ] || return 64
    rm -rf -- "$target"
    unset LOKI_RUN_TMP
}

loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
mkdir -p "$T/bin" "$T/runs/e10-rc-1"

if [ ! -f "$SCRIPT" ]; then
    bad "action script missing: $SCRIPT"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

cat >"$T/fixture.ts" <<TS
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { computeReceiptHash } from "$REPO/loki-ts/src/engine10/verify_cmd.ts";
import { kidOf } from "$REPO/loki-ts/src/engine10/stages/seal.ts";
const dir = process.argv[2]!;
const f: Record<string, unknown> = {
  schema: "loki.v10.receipt/1", run_id: "e10-rc-1", task: { source: "text", sha256: "a".repeat(64) }, repo: "o/r",
  base_sha: "b".repeat(40), head_sha: "c".repeat(40), tree: "d".repeat(40), diff_sha256: "e".repeat(64),
  wall: { files: [], passed: true }, checks: [{ name: "unit", cmd: "bun test", result: "pass", duration_s: 1 }],
  not_proven: ["full suite"], verdict: "VERIFIED", cost: { usd: 0.1, input_tokens: 1, output_tokens: 1 },
  time: { wall_s: 1, stages: { intake: 1 } }, provider: "claude", model: "m", resumed: false,
  events_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};
const k = generateKeyPairSync("ed25519");
const kid = kidOf(k.publicKey), hash = computeReceiptHash(f);
const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid })).toString("base64url");
const p = Buffer.from(JSON.stringify({ receipt_sha256: hash })).toString("base64url");
const jwt = h + "." + p + "." + sign(null, Buffer.from(h + "." + p), k.privateKey).toString("base64url");
writeFileSync(dir + "/runs/e10-rc-1/receipt.json", JSON.stringify({ ...f, receipt_sha256: hash, verification: { jwt, kid } }));
writeFileSync(dir + "/good.jwk", JSON.stringify(k.publicKey.export({ format: "jwk" })));
TS
if ! timeout -k 5 120 bun "$T/fixture.ts" "$T" >"$T/fixture.log" 2>&1; then
    bad "fixture generation failed: $(cat "$T/fixture.log")"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

# Stub gh: record one argv element per line, delimited per call.
cat >"$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
{ printf '%s\n' "--call--"; printf '%s\n' "$@"; } >>"$GH_ARGV_LOG"
exit 0
STUB
chmod +x "$T/bin/gh"

# Tampered copy: flip exactly one byte of the signed content (head_sha first char c -> d).
perl -pe 's/"head_sha":"c/"head_sha":"d/' "$T/runs/e10-rc-1/receipt.json" >"$T/tampered.json"
if [ "$(cmp -l "$T/runs/e10-rc-1/receipt.json" "$T/tampered.json" | wc -l | tr -d ' ')" = "1" ]; then ok "tampered fixture differs by exactly one byte"; else bad "tamper is not a single byte flip"; fi

SHA="$(printf 'c%.0s' $(seq 40))"
# run_check <receipt> <gh argv log>
run_check() {
    env -u LOKI_ENGINE PATH="$T/bin:$PATH" GH_ARGV_LOG="$2" LOKI_NO_BROWSER=1 LOKI_TELEMETRY_DISABLED=1 BUN_FROM_SOURCE=1 \
        LOKI_RECEIPT_CHECK_LOKI="$REPO/bin/loki" LOKI_RECEIPT_CHECK_RECEIPT="$1" LOKI_RECEIPT_CHECK_PUBKEY="$T/good.jwk" \
        GITHUB_REPOSITORY=o/r LOKI_RECEIPT_CHECK_SHA="$SHA" \
        timeout -k 5 120 bash "$SCRIPT" >"$T/out" 2>"$T/err"
}

run_check "$T/runs/e10-rc-1/receipt.json" "$T/good.log"
rc=$?
if [ "$rc" = "0" ]; then ok "valid receipt: script exits 0"; else bad "valid receipt rc $rc: $(head -c 300 "$T/err")"; fi
if grep -qx 'conclusion=success' "$T/good.log"; then ok "valid receipt records conclusion=success"; else bad "valid receipt argv: $(tr '\n' ' ' <"$T/good.log")"; fi
if grep -qx 'name=Loki Receipt' "$T/good.log" && grep -qx 'api' "$T/good.log"; then ok "check run is named Loki Receipt via gh api"; else bad "name/api argv missing"; fi
if grep -q 'verdict: VERIFIED' "$T/good.log"; then ok "summary carries verify output"; else bad "summary lacks verify output"; fi

run_check "$T/tampered.json" "$T/bad.log"
rc=$?
if [ "$rc" != "0" ]; then ok "tampered receipt: script exits non-zero (rc $rc)"; else bad "tampered receipt exited 0"; fi
if grep -qx 'conclusion=failure' "$T/bad.log"; then ok "tampered receipt records conclusion=failure"; else bad "tampered argv: $(tr '\n' ' ' <"$T/bad.log")"; fi
if grep -q 'TAMPERED' "$T/bad.log"; then ok "failure summary names TAMPERED"; else bad "failure summary lacks TAMPERED"; fi

# Autopilot merge stays opt-in: the action has no merge step.
if grep -Eqi 'pr merge|/merge|auto-?merge' "$REPO/.github/actions/receipt-check/action.yml" "$SCRIPT"; then bad "receipt-check must not merge"; else ok "no merge step in the action"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
