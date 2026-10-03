#!/usr/bin/env bash
# P0-VERIFY-ARG: `loki verify --pubkey=FILE <run>` must reach the v10 verifier from the real
# bin/loki on the DEFAULT engine, in either flag form and any position (rc 0 matching key,
# rc 2 mismatched key), never the legacy verifier (rc 3).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

if ! command -v bun >/dev/null 2>&1; then
    echo "SKIP: bun not installed"
    exit 0
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/verify-pubkey-cli.XXXXXX")"
trap 'rm -rf -- "$T"' EXIT
mkdir -p "$T/.loki/runs/e10-pk-1"

cat >"$T/fixture.ts" <<TS
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { computeReceiptHash } from "$REPO/loki-ts/src/engine10/verify_cmd.ts";
import { kidOf } from "$REPO/loki-ts/src/engine10/stages/seal.ts";
const dir = process.argv[2]!;
const f: Record<string, unknown> = {
  schema: "loki.v10.receipt/1", run_id: "e10-pk-1", task: { source: "text", sha256: "a".repeat(64) }, repo: "o/r",
  base_sha: "b".repeat(40), head_sha: "c".repeat(40), tree: "d".repeat(40), diff_sha256: "e".repeat(64),
  wall: { files: [], passed: true }, checks: [{ name: "unit", cmd: "bun test", result: "pass", duration_s: 1 }],
  not_proven: ["full suite"], verdict: "VERIFIED", cost: { usd: 0.1, input_tokens: 1, output_tokens: 1 },
  time: { wall_s: 1, stages: { intake: 1 } }, provider: "claude", model: "m", resumed: false,
  events_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};
const k = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
const kid = kidOf(k.publicKey), hash = computeReceiptHash(f);
const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid })).toString("base64url");
const p = Buffer.from(JSON.stringify({ receipt_sha256: hash })).toString("base64url");
const jwt = h + "." + p + "." + sign(null, Buffer.from(h + "." + p), k.privateKey).toString("base64url");
writeFileSync(dir + "/.loki/runs/e10-pk-1/receipt.json", JSON.stringify({ ...f, receipt_sha256: hash, verification: { jwt, kid } }));
writeFileSync(dir + "/good.jwk", JSON.stringify(k.publicKey.export({ format: "jwk" })));
writeFileSync(dir + "/bad.jwk", JSON.stringify(other.publicKey.export({ format: "jwk" })));
TS
if ! bun "$T/fixture.ts" "$T" >"$T/fixture.log" 2>&1; then
    bad "fixture generation failed: $(cat "$T/fixture.log")"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

# run_verify <args...>: real bin/loki, default engine (LOKI_ENGINE unset), from source.
run_verify() {
    (cd "$T" && env -u LOKI_ENGINE LOKI_NO_BROWSER=1 LOKI_TELEMETRY_DISABLED=1 LOKI_DIR="$T/.loki" \
        BUN_FROM_SOURCE=1 timeout -k 5 120 bash "$REPO/bin/loki" verify "$@") >"$T/out" 2>"$T/err"
    echo $?
}

expect_rc() {
    local label="$1" want="$2" got
    shift 2
    got="$(run_verify "$@")"
    if [ "$got" = "$want" ] && grep -q "verdict:" "$T/out" 2>/dev/null; then ok "$label (rc $got)"
    elif [ "$got" = "$want" ] && [ "$want" = "2" ]; then ok "$label (rc $got)"
    else bad "$label: want rc $want, got $got: $(head -c 300 "$T/out") $(head -c 300 "$T/err")"; fi
}

expect_rc "--pubkey=good run -> v10 VERIFIED" 0 "--pubkey=$T/good.jwk" e10-pk-1
expect_rc "--pubkey=good run again" 0 "--pubkey=$T/good.jwk" e10-pk-1
if grep -q "VERIFIED against the supplied key" "$T/out"; then ok "good key attested by the supplied key"; else bad "good key output: $(cat "$T/out")"; fi
expect_rc "run --pubkey=good (flag last) -> v10 VERIFIED" 0 e10-pk-1 "--pubkey=$T/good.jwk"
expect_rc "--pubkey good (space form) -> v10 VERIFIED" 0 --pubkey "$T/good.jwk" e10-pk-1
expect_rc "--pubkey=bad run -> v10 UNCHECKED" 2 "--pubkey=$T/bad.jwk" e10-pk-1
if grep -q "run: e10-pk-1" "$T/out"; then ok "mismatched key reaches the v10 verdict output"; else bad "mismatched key output: $(cat "$T/out") $(cat "$T/err")"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
