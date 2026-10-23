#!/usr/bin/env bash
# #352 (CW-17): `loki verify <run receipt path>` must reach the engine10 receipt verifier, the same
# one a run id reaches. Before the fix a path fell through to the diff verifier, which used the path as
# a git base ref and printed CONCERNS on a run that bare `loki verify` called VERIFIED.
# No shell test owned the routing from a verify path to engine10 (searched `loki verify e10-` and receipt.json).
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

T="$(mktemp -d "${TMPDIR:-/tmp}/verify-receipt-route.XXXXXX")"
trap 'rm -rf -- "$T"' EXIT
mkdir -p "$T/.loki/runs/e10-rr-1" "$T/.loki/runs/e10-rr-2" "$T/elsewhere"
git -C "$T" init -q . 2>/dev/null

cat >"$T/fixture.ts" <<TS
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { computeReceiptHash } from "$REPO/loki-ts/src/engine10/verify_cmd.ts";
import { kidOf } from "$REPO/loki-ts/src/engine10/stages/seal.ts";
const dir = process.argv[2]!;
const f: Record<string, unknown> = {
  schema: "loki.v10.receipt/1", run_id: "e10-rr-1", task: { source: "text", sha256: "a".repeat(64) }, repo: "o/r",
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
const body = JSON.stringify({ ...f, receipt_sha256: hash, verification: { jwt, kid } });
writeFileSync(dir + "/.loki/runs/e10-rr-1/receipt.json", body);
writeFileSync(dir + "/elsewhere/sealed.json", body);
writeFileSync(dir + "/.loki/runs/e10-rr-2/receipt.json", body.replace('"repo":"o/r"', '"repo":"o/tampered"'));
writeFileSync(dir + "/pub.pem", k.publicKey.export({ type: "spki", format: "pem" }));
TS
if ! bun "$T/fixture.ts" "$T" >"$T/fixture.log" 2>&1; then
    bad "fixture generation failed: $(cat "$T/fixture.log")"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

# run_verify <args...>: real bin/loki, default engine, from source. Prints the exit code.
run_verify() {
    (cd "$T" && env -u LOKI_ENGINE LOKI_NO_BROWSER=1 LOKI_TELEMETRY_DISABLED=1 LOKI_DIR="$T/.loki" \
        LOKI_RECEIPT_RETIRED_PUBKEYS="$T/pub.pem" \
        BUN_FROM_SOURCE=1 timeout -k 5 120 bash "$REPO/bin/loki" verify "$@") >"$T/out" 2>"$T/err"
    echo $?
}

rc="$(run_verify e10-rr-1)"
if grep -q "verdict: VERIFIED" "$T/out" && [ "$rc" = "0" ]; then ok "control: the run id form prints verdict: VERIFIED (rc 0)"; else bad "control: run id form rc=$rc: $(head -c 300 "$T/out") $(head -c 300 "$T/err")"; fi

rc="$(run_verify .loki/runs/e10-rr-1/receipt.json)"
if grep -q "verdict: VERIFIED" "$T/out" && [ "$rc" = "0" ]; then ok "run receipt path prints verdict: VERIFIED (rc 0)"; else bad "run receipt path rc=$rc: $(head -c 300 "$T/out") $(head -c 300 "$T/err")"; fi

rc="$(run_verify "$T/.loki/runs/e10-rr-1/receipt.json")"
if grep -q "verdict: VERIFIED" "$T/out" && [ "$rc" = "0" ]; then ok "absolute run receipt path prints verdict: VERIFIED (rc 0)"; else bad "absolute path rc=$rc: $(head -c 300 "$T/out") $(head -c 300 "$T/err")"; fi

rc="$(run_verify elsewhere/sealed.json)"
if grep -q "verdict: VERIFIED" "$T/out" && [ "$rc" = "0" ]; then ok "a receipt copied elsewhere is routed by its schema (rc 0)"; else bad "schema route rc=$rc: $(head -c 300 "$T/out") $(head -c 300 "$T/err")"; fi

rc="$(run_verify .loki/runs/e10-rr-2/receipt.json)"
if grep -q "verdict: TAMPERED" "$T/out" && [ "$rc" != "0" ] && ! grep -q "CONCERNS" "$T/out" "$T/err"; then ok "a tampered receipt prints the engine10 TAMPERED verdict, never CONCERNS (rc $rc)"; else bad "tampered receipt rc=$rc: $(head -c 300 "$T/out") $(head -c 300 "$T/err")"; fi

# Positive control: a git ref still runs the diff verifier, so the new route did not swallow every verify call.
rc="$(run_verify main)"
if grep -q "\[verify\] loki verify (deterministic" "$T/err" "$T/out" 2>/dev/null && ! grep -q "^run: " "$T/out"; then ok "control: loki verify main still runs the diff verifier"; else bad "diff verifier control rc=$rc: $(head -c 300 "$T/out") $(head -c 300 "$T/err")"; fi

# A .json that is not a receipt stays on the diff verifier.
printf '{"schema":"something.else/1"}\n' > "$T/other.json"
rc="$(run_verify other.json)"
if grep -q "\[verify\] loki verify (deterministic" "$T/err" "$T/out" 2>/dev/null; then ok "control: a non-receipt .json stays on the diff verifier"; else bad "non-receipt json rc=$rc: $(head -c 300 "$T/out") $(head -c 300 "$T/err")"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
