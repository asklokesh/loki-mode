// loki-ts/src/engine10/verify_cmd.ts -- E-22 `loki verify [run-id]` (ENGINE.md section 11/9).
// Reads receipt.json straight off disk, no RunContext. Three checks, cheapest first: TAMPER
// (recompute receipt_sha256 with `verification`+itself removed), SIGNATURE (native Ed25519
// against the active + retired keys), UNSIGNED (jwt null). Node crypto only, no python (A-121).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { lokiDir } from "../util/paths.ts";
import { readEvents } from "./events.ts";
import { kidOf, loadSigningKey, receiptSha256 } from "./stages/seal.ts";
import { takePubkey } from "./keys_cmd.ts"; import { receiptScreensProblem } from "../features/visual_evidence.ts";
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
interface AttestationOutcome { status: "verified" | "tampered" | "unchecked"; reason: string | null }
/** The public key for a kid: the local key's public half, or a retired one from LOKI_RECEIPT_RETIRED_PUBKEYS (colon-separated PEM paths). Never creates a key. */
function pubFor(kid: unknown, given?: KeyObject): KeyObject | undefined {
  if (given) return kidOf(given) === kid ? given : undefined; // --pubkey: that key only, never the local JWKS
  const active = loadSigningKey(false);
  const pubs = (process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"] ?? "").split(":").map((f) => f.trim()).filter(Boolean).flatMap((f) => {
    try { return [createPublicKey(readFileSync(f))]; } catch { return []; }
  });
  return [...(active ? [createPublicKey(active)] : []), ...pubs].find((k) => kidOf(k) === kid);
}
/** Native EdDSA check against the local key's public half plus LOKI_RECEIPT_RETIRED_PUBKEYS (colon-separated PEM paths). Selection is by kid; an unknown kid is refused, never tried against every key. */
function checkAttestation(jwt: string, expectedHash: string, given?: KeyObject): AttestationOutcome {
  const bad = (reason: string): AttestationOutcome => ({ status: "tampered", reason });
  const [h, p, s, ...rest] = jwt.split(".");
  if (!h || !p || !s || rest.length > 0) return bad("malformed token");
  let header: { alg?: unknown; kid?: unknown }, payload: { receipt_sha256?: unknown };
  try { header = JSON.parse(Buffer.from(h, "base64url").toString()); payload = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return bad("malformed token"); }
  if (header?.alg !== "EdDSA") return bad(`unexpected alg: ${String(header?.alg)}`);
  const pub = pubFor(header.kid, given);
  // An unknown kid (other machine, CI, after a rotation) cannot be checked here; that is not evidence of tampering.
  if (!pub) return { status: "unchecked", reason: `no key for kid ${String(header.kid)} on this machine (set LOKI_RECEIPT_SIGNING_KEY_FILE or LOKI_RECEIPT_RETIRED_PUBKEYS)` };
  if (!verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, "base64url"))) return bad("signature does not verify");
  return payload?.receipt_sha256 === expectedHash ? { status: "verified", reason: null } : bad("attestation binds a different receipt hash");
}
/** A-117: the worker seals before the supervisor can detect a log tamper, so the receipt alone cannot say so. Bind it to events.jsonl: the log must exist, hold a
 *  prefix hashing to receipt.events_sha256, contiguous seq from 0 and no tamper.detected. Removing the evidence breaks these too.
 *  Deleting the post-seal tail is closed by checkLogSeal (signed receipts); an unsigned receipt carries no key, so it stays exposed to that. */
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
/** A-117: after run.completed the supervisor appends a log.sealed line, signed over the sha256 of every earlier byte plus a tampered flag. A signed receipt needs it
 *  right after run.completed (deep verify may append later events: lines after log.sealed are unauthenticated and no reader may trust them). A sealed receipt with no run.completed is an interrupted run: UNCHECKED, not TAMPERED. */
function checkLogSeal(receiptPath: string, hash: string, kid: unknown, given?: KeyObject): { verdict: "TAMPERED" | "UNCHECKED"; reason: string } | null {
  const path = join(dirname(receiptPath), "events.jsonl"), events = readEvents(path), done = events.findIndex((e) => e.type === "run.completed");
  if (!events.some((e) => e.type === "receipt.sealed" && e.data["receipt_sha256"] === hash)) return { verdict: "TAMPERED", reason: "events.jsonl has no receipt.sealed event for this receipt" };
  if (done < 0) return { verdict: "UNCHECKED", reason: "run did not complete, or the log was truncated (no run.completed in events.jsonl)" };
  const seal = events[done + 1], d = seal?.type === "log.sealed" ? seal.data : null;
  if (!d) return { verdict: "TAMPERED", reason: "events.jsonl has no signed log.sealed line after run.completed" };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== ""), sha = createHash("sha256").update(lines.slice(0, done + 1).join("\n") + "\n").digest("hex");
  const pub = d["kid"] === kid ? pubFor(kid, given) : undefined; // the line must be signed by the key that signed the receipt
  if (!pub || d["events_sha256"] !== sha || d["tampered"] !== false || typeof d["sig"] !== "string" || !verify(null, Buffer.from(`${sha}:false`), pub, Buffer.from(d["sig"], "base64url"))) return { verdict: "TAMPERED", reason: "log.sealed line is invalid, forged, or records a tamper" };
  return null;
}
export async function verifyReceipt(receiptPath: string, deps: VerifyDeps = {}): Promise<VerifyResult> {
  if (!existsSync(receiptPath)) return { verdict: "UNCHECKED", reasons: [`receipt not found: ${receiptPath}`] };
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(readFileSync(receiptPath, "utf8")); } catch { return { verdict: "UNCHECKED", reasons: ["receipt.json is not valid JSON"] }; }
  const recorded = receipt["receipt_sha256"];
  const computed = computeReceiptHash(receipt);
  if (typeof recorded !== "string" || recorded !== computed) {
    return { verdict: "TAMPERED", reasons: [`receipt_sha256 mismatch: recorded ${JSON.stringify(recorded)}, computed ${computed}`] };
  }
  const logProblem = checkEventLog(receiptPath, receipt);
  if (logProblem) return { verdict: "TAMPERED", reasons: [logProblem] };
  const shot = receiptScreensProblem(receiptPath, receipt); if (shot) return { verdict: "TAMPERED", reasons: [shot] };
  const verification = (receipt["verification"] ?? {}) as { jwt?: string | null };
  const jwt = verification.jwt ?? null;
  if (jwt !== null && typeof jwt !== "string") return { verdict: "UNCHECKED", reasons: ["verification.jwt is not a string"] };
  if (!jwt) return { verdict: "UNSIGNED", reasons: [], receiptSha256: computed };
  const outcome = checkAttestation(jwt, computed, deps.pubkey);
  if (outcome.status === "unchecked") return { verdict: "UNCHECKED", reasons: [outcome.reason ?? "attestation not checked"] };
  if (outcome.status === "tampered") return { verdict: "TAMPERED", reasons: [outcome.reason ?? "attestation invalid"] };
  const seal = receipt["log_seal"] !== true ? null : checkLogSeal(receiptPath, computed, (JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString()) as { kid?: unknown }).kid, deps.pubkey);
  if (seal) return { verdict: seal.verdict, reasons: [seal.reason] };
  return { verdict: "VERIFIED", reasons: [], receiptSha256: computed };
}
function latestRunId(runsRoot: string): string | null {
  if (!existsSync(runsRoot)) return null;
  const dirs = readdirSync(runsRoot).filter((d) => { try { return statSync(join(runsRoot, d)).isDirectory(); } catch { return false; } });
  return dirs.sort().pop() ?? null; // run ids are e10-<timestamp>-<suffix>: lexicographic is chronological
}
// D47: a stripped receipt must never rank above UNCHECKED; --allow-unsigned opts in
const EXIT_BY_VERDICT: Record<Verdict, number> = { VERIFIED: 0, UNSIGNED: 3, TAMPERED: 1, UNCHECKED: 2 };
export async function main(args: readonly string[], deps: VerifyDeps = {}): Promise<number> {
  const allowUnsigned = args.includes("--allow-unsigned") || process.env["LOKI_VERIFY_ALLOW_UNSIGNED"] === "1";
  args = args.filter((a) => a !== "--allow-unsigned");
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write("Usage: loki verify [run-id]\nVerify .loki/runs/<run-id>/receipt.json (default: latest run).\nExit: 0 verified, 1 tampered, 2 unchecked, 3 unsigned (refused), 4 run outcome not verified, 66 no runs.\nOptions: --allow-unsigned (or LOKI_VERIFY_ALLOW_UNSIGNED=1) accepts an UNSIGNED receipt; never changes tampered/unchecked.\n");
    return 0;
  }
  const pk = takePubkey(args);
  if (pk.error) return (process.stderr.write(`loki verify: ${pk.error}\n`), 2);
  args = pk.args;
  if (pk.pubkey) deps = { ...deps, pubkey: pk.pubkey };
  const runsRoot = deps.runsRoot ?? join(lokiDir(), "runs");
  const runId = args[0] ?? latestRunId(runsRoot) ?? undefined;
  if (!runId) return (process.stderr.write("loki verify: no runs found\n"), 66);
  const receiptPath = existsSync(runId) && statSync(runId).isFile() ? runId : join(runsRoot, runId, "receipt.json"); // a receipt file path works directly
  const result = await verifyReceipt(receiptPath, deps);
  // An intact (VERIFIED or UNSIGNED) receipt of a run that did not verify is never exit 0 and no flag changes that; unreadable fails closed.
  if (result.verdict === "VERIFIED" || result.verdict === "UNSIGNED") {
    const outcome = (() => { try { return String(JSON.parse(readFileSync(receiptPath, "utf8")).verdict); } catch { return "UNREADABLE"; } })();
    if (outcome !== "VERIFIED" && outcome !== "ALREADY_SATISFIED") { process.stdout.write(`run: ${runId}\nverdict: NOT VERIFIED (run outcome ${outcome}; receipt integrity ${result.verdict === "UNSIGNED" ? "unattested" : "intact"})\n`); return 4; }
  }
  process.stdout.write(`run: ${runId}\nverdict: ${result.verdict}\n`);
  if (result.receiptSha256) process.stdout.write(`receipt_sha256: ${result.receiptSha256}\n`);
  for (const reason of result.reasons) process.stdout.write(`  ${reason}\n`);
  if (result.verdict === "UNSIGNED") {
    if (deps.pubkey) { process.stdout.write("attestation: UNSIGNED, but --pubkey asked for a signature check; refusing\n"); return EXIT_BY_VERDICT.UNSIGNED; }
    process.stdout.write(allowUnsigned ? "attestation: UNSIGNED (accepted by --allow-unsigned; integrity not attested)\n" : "attestation: UNSIGNED, integrity not attested; refusing (pass --allow-unsigned to accept)\n");
    return allowUnsigned ? 0 : EXIT_BY_VERDICT.UNSIGNED;
  } else if (result.verdict === "VERIFIED") {
    process.stdout.write(deps.pubkey ? `attestation: VERIFIED against the supplied key (kid ${kidOf(deps.pubkey)})\n` : "attestation: VERIFIED against the local JWKS\n");
  }
  return EXIT_BY_VERDICT[result.verdict];
}
