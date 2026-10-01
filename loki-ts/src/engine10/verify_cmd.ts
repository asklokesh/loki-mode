// loki-ts/src/engine10/verify_cmd.ts -- E-22 `loki verify [run-id]` (ENGINE.md section 11/9).
// Reads receipt.json straight off disk, no RunContext. Three checks, cheapest first: TAMPER
// (recompute receipt_sha256 with `verification`+itself removed), SIGNATURE (native Ed25519
// against the active + retired keys), UNSIGNED (jwt null). Node crypto only, no python (A-121).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { lokiDir } from "../util/paths.ts";
import { kidOf, loadSigningKey, receiptSha256 } from "./stages/seal.ts";
import { takePubkey } from "./keys_cmd.ts";
export type Verdict = "VERIFIED" | "UNSIGNED" | "TAMPERED" | "UNCHECKED";
export interface VerifyResult {
  verdict: Verdict;
  reasons: string[];
  receiptSha256?: string;
}
/** The hash seal writes into receipt.json; receiptSha256 strips `verification` and `receipt_sha256` itself. */
export const computeReceiptHash = (receipt: Record<string, unknown>): string => receiptSha256(receipt as never);
export interface VerifyDeps {
  runsRoot?: string; // overrides lokiDir()/runs, for tests
  pubkey?: KeyObject; // --pubkey: check against this key only, never the local JWKS
}
interface AttestationOutcome {
  status: "verified" | "tampered" | "unchecked";
  reason: string | null;
}
/** Native EdDSA check against the local key's public half plus LOKI_RECEIPT_RETIRED_PUBKEYS (colon-separated PEM paths). Selection is by kid; an unknown kid is refused, never tried against every key. */
function checkAttestation(jwt: string, expectedHash: string, given?: KeyObject): AttestationOutcome {
  const bad = (reason: string): AttestationOutcome => ({ status: "tampered", reason });
  const [h, p, s, ...rest] = jwt.split(".");
  if (!h || !p || !s || rest.length > 0) return bad("malformed token");
  let header: { alg?: unknown; kid?: unknown }, payload: { receipt_sha256?: unknown };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString());
    payload = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return bad("malformed token");
  }
  if (header?.alg !== "EdDSA") return bad(`unexpected alg: ${String(header?.alg)}`);
  const active = given ? null : loadSigningKey(false);
  const pubs = given ? [given] : (process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"] ?? "").split(":").map((f) => f.trim()).filter(Boolean).flatMap((f) => {
    try { return [createPublicKey(readFileSync(f))]; } catch { return []; }
  });
  const pub = [...(active ? [createPublicKey(active)] : []), ...pubs].find((k) => kidOf(k) === header.kid);
  // An unknown kid (other machine, CI, after a rotation) cannot be checked here; that is not evidence of tampering.
  if (!pub) return { status: "unchecked", reason: `no key for kid ${String(header.kid)} on this machine (set LOKI_RECEIPT_SIGNING_KEY_FILE or LOKI_RECEIPT_RETIRED_PUBKEYS)` };
  if (!verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, "base64url"))) return bad("signature does not verify");
  return payload?.receipt_sha256 === expectedHash ? { status: "verified", reason: null } : bad("attestation binds a different receipt hash");
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
  if (jwt !== null && typeof jwt !== "string") return { verdict: "UNCHECKED", reasons: ["verification.jwt is not a string"] };
  if (!jwt) {
    return { verdict: "UNSIGNED", reasons: [], receiptSha256: computed };
  }
  const outcome = checkAttestation(jwt, computed, deps.pubkey);
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
  const pk = takePubkey(args);
  if (pk.error) return (process.stderr.write(`loki verify: ${pk.error}\n`), 2);
  args = pk.args;
  if (pk.pubkey) deps = { ...deps, pubkey: pk.pubkey };
  const runsRoot = deps.runsRoot ?? join(lokiDir(), "runs");
  const runId = args[0] ?? latestRunId(runsRoot) ?? undefined;
  if (!runId) {
    process.stderr.write("loki verify: no runs found\n");
    return 66;
  }
  const receiptPath = existsSync(runId) && statSync(runId).isFile() ? runId : join(runsRoot, runId, "receipt.json"); // a receipt file path works directly
  const result = await verifyReceipt(receiptPath, deps);
  process.stdout.write(`run: ${runId}\nverdict: ${result.verdict}\n`);
  if (result.receiptSha256) process.stdout.write(`receipt_sha256: ${result.receiptSha256}\n`);
  for (const reason of result.reasons) process.stdout.write(`  ${reason}\n`);
  if (result.verdict === "UNSIGNED") {
    process.stdout.write("attestation: UNSIGNED (this receipt carries no signature)\n");
  } else if (result.verdict === "VERIFIED") {
    process.stdout.write("attestation: VERIFIED against the local JWKS\n");
  }
  return EXIT_BY_VERDICT[result.verdict];
}
