// loki-ts/src/engine10/verify_cmd.ts -- E-22 `loki verify [run-id]` (ENGINE.md section 11/9).
// Reads receipt.json straight off disk, no RunContext. Three checks, cheapest first: TAMPER
// (recompute receipt_sha256 with `verification`+itself removed), SIGNATURE (native Ed25519
// against the active + retired keys), UNSIGNED (jwt null). Node crypto only, no python (A-121).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { lokiDir } from "../util/paths.ts";
import { readEvents } from "./events.ts";
import { kidOf, loadSigningKey, receiptSha256 } from "./stages/seal.ts";
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
}
interface AttestationOutcome {
  status: "verified" | "tampered" | "unchecked";
  reason: string | null;
}
/** Native EdDSA check against the local key's public half plus LOKI_RECEIPT_RETIRED_PUBKEYS (colon-separated PEM paths). Selection is by kid; an unknown kid is refused, never tried against every key. */
function checkAttestation(jwt: string, expectedHash: string): AttestationOutcome {
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
  const active = loadSigningKey(false);
  const pubs = (process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"] ?? "").split(":").map((f) => f.trim()).filter(Boolean).flatMap((f) => {
    try { return [createPublicKey(readFileSync(f))]; } catch { return []; }
  });
  const pub = [...(active ? [createPublicKey(active)] : []), ...pubs].find((k) => kidOf(k) === header.kid);
  // An unknown kid (other machine, CI, after a rotation) cannot be checked here; that is not evidence of tampering.
  if (!pub) return { status: "unchecked", reason: `no key for kid ${String(header.kid)} on this machine (set LOKI_RECEIPT_SIGNING_KEY_FILE or LOKI_RECEIPT_RETIRED_PUBKEYS)` };
  if (!verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, "base64url"))) return bad("signature does not verify");
  return payload?.receipt_sha256 === expectedHash ? { status: "verified", reason: null } : bad("attestation binds a different receipt hash");
}
/** A-117: the worker seals before the supervisor can detect a log tamper, so the receipt alone cannot say so. Bind it to events.jsonl: the log must exist, hold a
 *  prefix hashing to receipt.events_sha256, contiguous seq from 0 and no tamper.detected. Removing the evidence breaks these too.
 *  ponytail: a forger who rewrites the whole post-seal tail consistently is not caught; only a signature made after the run could close that. */
function checkEventLog(receiptPath: string, receipt: Record<string, unknown>): string | null {
  const bound = receipt["events_sha256"];
  if (typeof bound !== "string" || bound === createHash("sha256").digest("hex")) return null; // no log bound at seal time (a real run writes run.started first; the receipt hash covers this field)
  const path = join(dirname(receiptPath), "events.jsonl");
  if (!existsSync(path)) return "events.jsonl is missing";
  const raw = readFileSync(path, "utf8"), events = readEvents(path), lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (events.length !== lines.length || events.some((e, i) => e.seq !== i)) return "events.jsonl has a forged, edited or missing line";
  if (events.some((e) => e.type === "tamper.detected")) return "the supervisor detected events.jsonl being modified during the run";
  const h = createHash("sha256"); // the worker hashed the log as it stood at seal; the supervisor may lag, so any line-boundary prefix may match
  for (const l of lines) { if (h.copy().digest("hex") === bound) return null; h.update(l + "\n"); }
  return h.digest("hex") === bound ? null : "events.jsonl does not match the hash recorded at seal";
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
  const logProblem = checkEventLog(receiptPath, receipt);
  if (logProblem) return { verdict: "TAMPERED", reasons: [logProblem] };
  const verification = (receipt["verification"] ?? {}) as { jwt?: string | null };
  const jwt = verification.jwt ?? null;
  if (jwt !== null && typeof jwt !== "string") return { verdict: "UNCHECKED", reasons: ["verification.jwt is not a string"] };
  if (!jwt) {
    return { verdict: "UNSIGNED", reasons: [], receiptSha256: computed };
  }
  const outcome = checkAttestation(jwt, computed);
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
    process.stdout.write("attestation: UNSIGNED (this receipt carries no signature)\n");
  } else if (result.verdict === "VERIFIED") {
    process.stdout.write("attestation: VERIFIED against the local JWKS\n");
  }
  return EXIT_BY_VERDICT[result.verdict];
}
