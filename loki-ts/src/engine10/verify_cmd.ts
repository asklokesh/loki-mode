// loki-ts/src/engine10/verify_cmd.ts -- E-22 `loki verify [run-id]` (ENGINE.md section 11/9).
// Reads receipt.json straight off disk, no RunContext. Three checks, cheapest first: TAMPER
// (recompute receipt_sha256 with `verification`+itself removed), SIGNATURE (verify_attestation
// against the active + retired JWKS), UNSIGNED (jwt null). Python runs via findIsolatedPython3()
// with -I ONLY, never -S: -S drops site-packages so `cryptography` never imports and every
// receipt would misreport UNCHECKED regardless of whether it was actually signed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { lokiDir, REPO_ROOT } from "../util/paths.ts";
import { findIsolatedPython3 } from "../util/python.ts";
import { run } from "../util/shell.ts";
import { receiptSha256 } from "./stages/seal.ts";
import type { ShellResult } from "../util/shell.ts";
export type Verdict = "VERIFIED" | "UNSIGNED" | "TAMPERED" | "UNCHECKED";
export interface VerifyResult {
  verdict: Verdict;
  reasons: string[];
  receiptSha256?: string;
}
/** The hash seal writes into receipt.json; receiptSha256 strips `verification` and `receipt_sha256` itself. */
export const computeReceiptHash = (receipt: Record<string, unknown>): string => receiptSha256(receipt as never);
type PyRunner = (argv: readonly string[], opts?: { timeoutMs?: number }) => Promise<ShellResult>;
export interface VerifyDeps {
  runsRoot?: string; // overrides lokiDir()/runs, for tests
  findPython?: () => Promise<string | null>;
  runPython?: PyRunner;
}
interface AttestationOutcome {
  status: "verified" | "tampered" | "unchecked";
  reason: string | null;
}
async function checkAttestation(
  jwt: string,
  expectedHash: string,
  findPython: () => Promise<string | null>,
  runPython: PyRunner,
): Promise<AttestationOutcome> {
  const py = await findPython();
  if (!py) return { status: "unchecked", reason: "no isolated python3 passed the -I probe" };
  const autonomyDir = resolve(REPO_ROOT, "autonomy");
  // sys.argv[1] carries the token: argv, never string interpolation, so a
  // JWT containing quote-like bytes cannot break out of the script.
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(autonomyDir)})
from receipt_jwt import load_signing_key, load_retired_public_keys, build_jwks, verify_attestation
priv, _kid = load_signing_key()
jwks = build_jwks(private_key=priv, retired_public_keys=load_retired_public_keys())
ok, payload = verify_attestation(sys.argv[1], jwks)
print(json.dumps({"ok": ok, "payload": payload if ok else None, "reason": None if ok else str(payload)}))
`;
  let r: ShellResult;
  try {
    r = await runPython([py, "-I", "-c", code, jwt], { timeoutMs: 10000 });
  } catch (e) {
    return { status: "unchecked", reason: `could not run the verifier: ${String((e as Error).message ?? e)}` };
  }
  if (r.exitCode > 128) {
    return { status: "unchecked", reason: `verifier was killed (exit ${r.exitCode})` };
  }
  if (r.exitCode !== 0) {
    return { status: "unchecked", reason: r.stderr.trim() || `verifier exited ${r.exitCode}` };
  }
  let parsed: { ok: boolean; payload: { receipt_sha256?: string } | null; reason: string | null };
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    return { status: "unchecked", reason: "verifier produced no parseable output" };
  }
  // Not installed is "could not check", never "tampered" (the honesty rule
  // this codebase already applies in autonomy/lib/proof-verify.py).
  if (parsed.reason === "cryptography is not installed") {
    return { status: "unchecked", reason: parsed.reason };
  }
  if (!parsed.ok) {
    return { status: "tampered", reason: parsed.reason ?? "signature does not verify" };
  }
  if (parsed.payload?.receipt_sha256 !== expectedHash) {
    return { status: "tampered", reason: "attestation binds a different receipt hash" };
  }
  return { status: "verified", reason: null };
}
export async function verifyReceipt(receiptPath: string, deps: VerifyDeps = {}): Promise<VerifyResult> {
  if (!existsSync(receiptPath)) {
    return { verdict: "UNCHECKED", reasons: [`receipt not found: ${receiptPath}`] };
  }
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    return { verdict: "UNCHECKED", reasons: ["receipt.json is not valid JSON"] };
  }
  const recorded = receipt["receipt_sha256"];
  const computed = computeReceiptHash(receipt);
  if (typeof recorded !== "string" || recorded !== computed) {
    return {
      verdict: "TAMPERED",
      reasons: [`receipt_sha256 mismatch: recorded ${JSON.stringify(recorded)}, computed ${computed}`],
    };
  }
  const verification = (receipt["verification"] ?? {}) as { jwt?: string | null };
  const jwt = verification.jwt ?? null;
  if (!jwt) {
    return { verdict: "UNSIGNED", reasons: [], receiptSha256: computed };
  }
  const outcome = await checkAttestation(
    jwt,
    computed,
    deps.findPython ?? findIsolatedPython3,
    deps.runPython ?? run,
  );
  if (outcome.status === "unchecked") return { verdict: "UNCHECKED", reasons: [outcome.reason ?? "attestation not checked"] };
  if (outcome.status === "tampered") return { verdict: "TAMPERED", reasons: [outcome.reason ?? "attestation invalid"] };
  return { verdict: "VERIFIED", reasons: [], receiptSha256: computed };
}
function latestRunId(runsRoot: string): string | null {
  if (!existsSync(runsRoot)) return null;
  const dirs = readdirSync(runsRoot).filter((d) => {
    try {
      return statSync(join(runsRoot, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (dirs.length === 0) return null;
  // Run ids are e10-<ISO-ish timestamp>-<suffix>, so lexicographic order is
  // chronological order.
  dirs.sort();
  return dirs[dirs.length - 1] ?? null;
}
const EXIT_BY_VERDICT: Record<Verdict, number> = {
  VERIFIED: 0,
  UNSIGNED: 0,
  TAMPERED: 1,
  UNCHECKED: 2,
};
export async function main(args: readonly string[], deps: VerifyDeps = {}): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write("Usage: loki verify [run-id]\nVerify .loki/runs/<run-id>/receipt.json (default: latest run).\nExit: 0 verified/unsigned, 1 tampered, 2 unchecked, 66 no runs.\n");
    return 0;
  }
  const runsRoot = deps.runsRoot ?? join(lokiDir(), "runs");
  const runId = args[0] ?? latestRunId(runsRoot) ?? undefined;
  if (!runId) {
    process.stderr.write("loki verify: no runs found\n");
    return 66;
  }
  const receiptPath = join(runsRoot, runId, "receipt.json");
  const result = await verifyReceipt(receiptPath, deps);
  process.stdout.write(`run: ${runId}\nverdict: ${result.verdict}\n`);
  if (result.receiptSha256) process.stdout.write(`receipt_sha256: ${result.receiptSha256}\n`);
  for (const reason of result.reasons) process.stdout.write(`  ${reason}\n`);
  if (result.verdict === "UNSIGNED") {
    process.stdout.write("attestation: UNSIGNED (no signing key was configured when this receipt was sealed)\n");
  } else if (result.verdict === "VERIFIED") {
    process.stdout.write("attestation: VERIFIED against the local JWKS\n");
  }
  return EXIT_BY_VERDICT[result.verdict];
}
