// loki-ts/src/engine10/verify_cmd.ts -- E-22 `loki verify [run-id]` (ENGINE.md section 11/9).
// Reads receipt.json straight off disk, no RunContext. Three checks, cheapest first: TAMPER (recompute receipt_sha256 with `verification`+itself removed), SIGNATURE (native Ed25519 against the active
// + retired keys), UNSIGNED (jwt null). Node crypto only, no python (A-121).
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { lokiDir } from "../util/paths.ts"; import { isCancelDone, isResumableDone, receiptSealAccuracy } from "../util/run_outputs.ts"; import { answerMark } from "../util/conflict_resume.ts";
import { applyMaxAge, deployAttestCmd, pubFor, receiptShapeProblem, takeMaxAge } from "../util/receipt_signer.ts";
import { latestRunId } from "../commands/run_status.ts"; import { answeredBlockedBetween, isAnsweredResume, sealDrift, tornTail, verifyLogSeals, wallNotComparedNote } from "../util/seal_drift.ts";
import { readEvents } from "./events.ts"; import type { EventEnvelope } from "./types.ts";
import { isExecutedProof, printable, sealedWallCopy, sealedWallDir, withExplain, type ExplainRec } from "../util/check_result.ts";
import { kidOf, loadSigningKey, receiptSha256, signReceipt } from "./stages/seal.ts";
import { exportDsseReceipt, isEnvelope, outcomeOf, runIdGuard, verifyDsseReceipt } from "../features/receipt_dsse.ts";
import { verifyGroup } from "../features/speed/seal_group.ts"; import { composeComposite, compositeHash, compositeLines, isComposite, verifyComposite } from "../util/composite_seal.ts"; import { takePubkey } from "./keys_cmd.ts"; import { receiptScreensProblem } from "../features/visual_evidence.ts";
export type Verdict = "VERIFIED" | "UNSIGNED" | "TAMPERED" | "UNCHECKED";
export interface VerifyResult { verdict: Verdict; reasons: string[]; receiptSha256?: string }
/** The hash seal writes into receipt.json; receiptSha256 strips `verification` and `receipt_sha256` itself. */
export const computeReceiptHash = (receipt: Record<string, unknown>): string => receiptSha256(receipt as never);
export interface VerifyDeps {
  runsRoot?: string; // overrides lokiDir()/runs, for tests
  pubkey?: KeyObject; // --pubkey: check against this key only, never the local JWKS
  now?: () => number; // --max-age clock in ms, for tests; default Date.now
  read?: (path: string) => string; // reads the receipt file (tests count reads); default readFileSync utf8
}
interface AttestationOutcome { status: "verified" | "tampered" | "unchecked"; reason: string | null }
/** Native EdDSA check against the local key's public half plus LOKI_RECEIPT_RETIRED_PUBKEYS (colon-separated PEM paths). Selection is by kid; an unknown kid is refused, never tried against every key. */
export function checkAttestation(jwt: string, expectedHash: string, given?: KeyObject): AttestationOutcome {
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
const isPlain = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v);
/** A-117: the worker seals before the supervisor can detect a log tamper, so the receipt alone cannot say so. Bind it to events.jsonl: the log must exist, hold a  prefix hashing to receipt.events_sha256, contiguous seq from 0
 *  and no tamper.detected. Removing the evidence breaks these too.  Deleting the post-seal tail is closed by checkLogSeal (signed receipts); an unsigned receipt carries no key, so it stays exposed to that. */
/** A sealed Wall copy under <run dir>/wall that no longer hashes to the sha256 the receipt recorded was edited after the seal. A moved receipt (no wall dir beside it) has nothing to compare; once the wall dir exists, a recorded file whose sealed copy is gone was deleted after the seal. */
function wallTamperProblem(receiptPath: string, receipt: Record<string, unknown>): string | null {
  const wall = receipt["wall"] as { files?: unknown } | null | undefined, files = Array.isArray(wall?.files) ? (wall!.files as { path?: unknown; sha256?: unknown }[]) : [];
  const wallDir = sealedWallDir(dirname(receiptPath)), haveWallDir = existsSync(wallDir);
  for (const f of files) {
    if (typeof f?.path !== "string" || typeof f.sha256 !== "string") continue;
    const copy = sealedWallCopy(dirname(receiptPath), f.path);
    let cur: string; try { cur = createHash("sha256").update(readFileSync(copy)).digest("hex"); } catch { if (haveWallDir) return `sealed Wall file ${basename(f.path)} is missing from the run's wall directory: it was deleted after the seal`; continue; }
    if (cur !== f.sha256) return `sealed Wall file ${basename(f.path)} changed after the seal: receipt recorded sha256 ${f.sha256}, on disk ${cur}`;
  }
  return null;
}
/** Also used by resume: the receipt must bind a line-aligned prefix of the events.jsonl beside it. */
export function checkEventLog(receiptPath: string, receipt: Record<string, unknown>): string | null {
  const bound = receipt["events_sha256"];
  if (receipt["schema"] === "loki.v10.receipt/1") { // P12-01c: seal.ts always writes these, so absence means an edit (other receipt kinds are not gated)
    const time = receipt["time"] as { stages?: unknown } | null | undefined;
    const hashOk = typeof bound === "string" && /^[0-9a-f]{64}$/.test(bound);
    const miss = !hashOk ? "events_sha256" : !time || typeof time !== "object" ? "time" : !isPlain(time.stages) ? "time.stages" : null;
    if (miss) return `the receipt is missing a valid ${miss}, which seal always writes; it was edited. Re-run the task to produce a fresh receipt.`;
  }
  if (typeof bound !== "string") return null;
  if (bound === createHash("sha256").digest("hex")) { // P12-01b: the empty-log hash is honest only for a receipt that records zero events and stages (a real run writes run.started first); --allow-unsigned never waives this
    const st = (receipt["time"] as { stages?: unknown } | null | undefined)?.stages;
    const claims = st !== null && typeof st === "object" && Object.keys(st as object).length > 0;
    return claims ? "the receipt records stages but binds the empty-log hash, so no events.jsonl can back it (missing, empty or non-empty); the receipt is forged or was sealed without a log. Re-run the task to produce a fresh receipt" : null;
  }
  const path = join(dirname(receiptPath), "events.jsonl");
  if (!existsSync(path)) return "events.jsonl is missing";
  const raw = readFileSync(path, "utf8"), events = readEvents(path), all = raw.split("\n").filter((l) => l.trim() !== ""), lines = tornTail(raw) ? all.slice(0, -1) : all; // a torn final line is skipped here and reported UNCHECKED by sealDrift
  if (events.length !== lines.length || events.some((e, i) => e.seq !== i)) return "events.jsonl has a forged, edited or missing line";
  const segs = raw.split("\n"), tail = segs.pop() ?? ""; // the writer only emits whole newline-terminated JSON lines in one write each: a blank line or whitespace anywhere outside a line was added by hand
  // An unterminated tail is a crash mid-write only when it starts like a writer line (no leading whitespace, no raw tab or CR, which JSON.stringify always escapes): a torn cut stays
  // UNCHECKED through sealDrift, and a whole line missing only its newline must also carry no trailing whitespace. Anything else after the last newline is TAMPERED.
  const tailOk = tail === "" || (tail === tail.trimStart() && !/[\t\r]/.test(tail) && (tornTail(raw) || tail === tail.trimEnd()));
  if (!tailOk || segs.some((l) => l === "" || l !== l.trim())) return "events.jsonl has bytes the engine never writes (a blank line or stray whitespace); it was appended to after the seal";
  if (events.some((e) => e.type === "tamper.detected")) return "the supervisor detected events.jsonl being modified during the run";
  const h = createHash("sha256"); // the worker hashed the log as it stood at seal; the supervisor may lag, so any line-boundary prefix may match
  for (const l of lines) { if (h.copy().digest("hex") === bound) return null; h.update(l + "\n"); }
  return h.digest("hex") === bound ? null : "events.jsonl does not match the hash recorded at seal";
}
/** True when the log.sealed at `i`, beyond the last run.completed at `done`, may be a resume checkpoint: the completion is one a resume continues from (isResumableDone), and a SPEC_CONFLICT one only counts once an answered run.resumed with a valid answer_sha256 (answerMark, isAnsweredResume) sits between it and `i`. A cancel stop needs no answer. */
function resumeCheckpointOk(events: readonly EventEnvelope[], done: number, i: number): boolean {
  const d = events[done]!;
  if (!isResumableDone(d)) return false;
  if (isCancelDone(d)) return true;
  const m = answerMark(events.slice(0, i));
  return m > done && isAnsweredResume(events[m]!);
}
/** A-117: after run.completed the supervisor appends a log.sealed line, signed over the sha256 of every earlier byte plus a tampered flag. A signed receipt needs it
 *  right after run.completed (deep verify may append later events: lines after log.sealed are unauthenticated and no reader may trust them). A sealed receipt with no run.completed is an interrupted run: UNCHECKED, not TAMPERED. */
function checkLogSeal(receiptPath: string, hash: string, kid: unknown, given?: KeyObject): { verdict: "TAMPERED" | "UNCHECKED"; reason: string } | null {
  const path = join(dirname(receiptPath), "events.jsonl"), events = readEvents(path), done = events.findLastIndex((e) => e.type === "run.completed"); // a cancelled-then-resumed run holds several pairs: the LAST one, after this receipt's seal, is the run's end
  const rs = events.findIndex((e) => e.type === "receipt.sealed" && e.data["receipt_sha256"] === hash);
  if (rs < 0) return { verdict: "TAMPERED", reason: "events.jsonl has no receipt.sealed event for this receipt" };
  const seals = events.flatMap((e, i) => (e.type === "receipt.sealed" ? [i] : [])); // a run seals one receipt; only an answered BLOCKED run seals once per attempt: each earlier seal is followed by a SPEC_CONFLICT run.completed, then an answered run.resumed, all before the next seal, and this receipt's seal is the last (the signed log.sealed chain covers every attempt)
  if (!seals.every((s, k) => { const n = seals[k + 1]; return n === undefined ? s === rs : answeredBlockedBetween(events, s, n); })) return { verdict: "TAMPERED", reason: "events.jsonl holds more than one receipt.sealed event without an answered BLOCKED run between them; a run seals exactly one receipt" };
  const raw = readFileSync(path, "utf8"), whole = tornTail(raw) ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw; // a torn final line is dropped as checkEventLog drops it, so sealDrift reports it UNCHECKED
  const chain = verifyLogSeals(whole, events, { kid, given, expectSeal: true }); // every cancel seal, not only the last, must hash the lines before it
  if (chain) return { verdict: "TAMPERED", reason: chain };
  // sealLog only ever runs right after a run.completed, so the last log.sealed of an honest log sits at done+1; a later one means the final run.completed was retyped or deleted
  // The extra log.sealed lines an honest log holds beyond done+1 are checkpoints the supervisor writes right after a run.resumed (resume) or a receipt.sealed (seal); each was already hashed and signature-checked by verifyLogSeals above, and anything else there still reads as a retyped run.completed.
  if (events.some((e, i) => e.type === "log.sealed" && i > done + 1 && (!resumeCheckpointOk(events, done, i) || (events[i - 1]!.type !== "run.resumed" && events[i - 1]!.type !== "receipt.sealed")))) return { verdict: "TAMPERED", reason: "events.jsonl holds a log.sealed line that does not follow the last run.completed; the final run.completed was retyped or removed" };
  if (done < 0) return { verdict: "UNCHECKED", reason: "run did not complete, or the log was truncated (no run.completed in events.jsonl)" };
  const seal = events[done + 1], d = seal?.type === "log.sealed" ? seal.data : null;
  if (!d) return { verdict: "TAMPERED", reason: "events.jsonl has no signed log.sealed line after run.completed" };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== ""), sha = createHash("sha256").update(lines.slice(0, done + 1).join("\n") + "\n").digest("hex");
  const pub = d["kid"] === kid ? pubFor(kid, given) : undefined; // the line must be signed by the key that signed the receipt
  if (!pub || d["events_sha256"] !== sha || d["tampered"] !== false || typeof d["sig"] !== "string" || !verify(null, Buffer.from(`${sha}:false`), pub, Buffer.from(d["sig"], "base64url"))) return { verdict: "TAMPERED", reason: "log.sealed line is invalid, forged, or records a tamper" };
  if (done < rs) { // the last run.completed predates this receipt's seal: only a validly sealed CANCELLED pair followed by an unfinished resume is honest (the cancel marker is the isCancelDone test, inlined to keep run_outputs.ts's large import graph out of the verifier)
    if (events[done]!.data["cancelled"] !== true) return { verdict: "TAMPERED", reason: "run.completed precedes this receipt's receipt.sealed but is not a cancelled run; events.jsonl was reordered or edited" };
    return { verdict: "UNCHECKED", reason: "run was cancelled and resumed but the resumed run did not complete, or the log was truncated (no run.completed after receipt.sealed)" };
  }
  return null;
}
export async function verifyReceipt(receiptPath: string, deps: VerifyDeps = {}): Promise<VerifyResult> {
  if (!existsSync(receiptPath)) return { verdict: "UNCHECKED", reasons: [`receipt not found: ${receiptPath}`] };
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse((deps.read ?? ((p) => readFileSync(p, "utf8")))(receiptPath)); } catch { return { verdict: "UNCHECKED", reasons: ["receipt.json is not valid JSON"] }; }
  const shape = receiptShapeProblem(receipt); if (shape) return { verdict: "UNCHECKED", reasons: [shape] }; // one gate before any kind dispatch (envelope, composite, plain, group)
  if (isEnvelope(receipt)) return verifyDsseReceipt(receipt, { pubFor: (kid) => pubFor(kid, deps.pubkey), hash: computeReceiptHash, attest: (j, h) => checkAttestation(j, h, deps.pubkey) }); // INTEL-1: DSSE envelope
  if (isComposite(receipt)) return verifyCompositeFile(receiptPath, receipt, deps);
  const recorded = receipt["receipt_sha256"];
  let computed: string;
  try { computed = computeReceiptHash(receipt); } catch { return { verdict: "UNCHECKED", reasons: ["receipt.json cannot be hashed (nested too deeply)"] }; }
  if (typeof recorded !== "string" || recorded !== computed) return { verdict: "TAMPERED", reasons: [`receipt_sha256 mismatch: recorded ${JSON.stringify(recorded)}, computed ${computed}`] };
  if (receipt["schema"] !== "loki.v10.receipt/1" && receipt["schema"] !== "loki.v10.group/1") return { verdict: "TAMPERED", reasons: [`unrecognized receipt schema ${JSON.stringify(receipt["schema"] ?? null)}; a renamed or removed schema would downgrade the receipt past its checks`] }; // P12-01d
  if (receipt["schema"] === "loki.v10.group/1" && !isPlain(receipt["group"])) return { verdict: "TAMPERED", reasons: ["a loki.v10.group/1 receipt has no group section, which composeGroupReceipt always writes; it was edited or renamed from another schema"] }; // P12-01d
  const logProblem = checkEventLog(receiptPath, receipt);
  if (logProblem) return { verdict: "TAMPERED", reasons: [logProblem] };
  const wallProblem = receipt["schema"] === "loki.v10.receipt/1" ? wallTamperProblem(receiptPath, receipt) : null;
  if (wallProblem) return { verdict: "TAMPERED", reasons: [wallProblem] };
  const gp = await verifyGroup(receiptPath, receipt, computeReceiptHash, verifyReceipt, deps); // D61-13
  if (gp?.verdict === "TAMPERED") return { verdict: "TAMPERED", reasons: [gp.reason] }; // UNCHECKED is held: a forged combined receipt must read TAMPERED before it can read UNCHECKED
  const shot = receiptScreensProblem(receiptPath, receipt); if (shot) return { verdict: "TAMPERED", reasons: [shot] };
  const verification = (receipt["verification"] ?? {}) as { jwt?: string | null };
  const jwt = verification.jwt ?? null;
  if (jwt !== null && typeof jwt !== "string") return { verdict: "UNCHECKED", reasons: ["verification.jwt is not a string"] };
  if (!jwt && gp) return { verdict: gp.verdict, reasons: [gp.reason] };
  if (!jwt) return { verdict: "UNSIGNED", reasons: [], receiptSha256: computed };
  const outcome = checkAttestation(jwt, computed, deps.pubkey);
  if (outcome.status === "unchecked") return { verdict: "UNCHECKED", reasons: [outcome.reason ?? "attestation not checked"] };
  if (outcome.status === "tampered") return { verdict: "TAMPERED", reasons: [outcome.reason ?? "attestation invalid"] };
  // verification.kid is shown to readers but sits outside receipt_sha256; the signed JWT header kid is the truth, so a forged display kid is TAMPERED.
  const shownKid = (verification as { kid?: unknown }).kid, signedKid = (JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString()) as { kid?: unknown }).kid;
  if (shownKid !== undefined && shownKid !== signedKid) return { verdict: "TAMPERED", reasons: ["verification.kid differs from the signing kid in the attestation header (metadata outside the signed digest was edited)"] };
  const seal = receipt["log_seal"] !== true ? null : checkLogSeal(receiptPath, computed, (JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString()) as { kid?: unknown }).kid, deps.pubkey);
  if (seal) return { verdict: seal.verdict, reasons: [seal.reason] };
  if (gp) return { verdict: gp.verdict, reasons: [gp.reason] };
  return { verdict: "VERIFIED", reasons: [], receiptSha256: computed };
}
/** composite.json: recompute composite_sha256, check every child against disk (TAMPERED first), then the composite signature. Unsigned or unchecked children under a signed composite make it UNCHECKED. */
async function verifyCompositeFile(receiptPath: string, receipt: Record<string, unknown>, deps: VerifyDeps): Promise<VerifyResult> {
  const computed = compositeHash(receipt);
  if (receipt["composite_sha256"] !== computed) return { verdict: "TAMPERED", reasons: [`composite_sha256 mismatch: recorded ${JSON.stringify(receipt["composite_sha256"])}, computed ${computed}`] };
  const c = await verifyComposite(receiptPath, receipt, computeReceiptHash, verifyReceipt, deps);
  if (c.problem?.verdict === "TAMPERED") return { verdict: "TAMPERED", reasons: [c.problem.reason] };
  const jwt = ((receipt["verification"] ?? {}) as { jwt?: unknown }).jwt ?? null;
  if (jwt !== null && typeof jwt !== "string") return { verdict: "UNCHECKED", reasons: ["verification.jwt is not a string"] };
  if (!jwt) return c.problem ? { verdict: c.problem.verdict, reasons: [c.problem.reason] } : { verdict: "UNSIGNED", reasons: [], receiptSha256: computed };
  const outcome = checkAttestation(jwt, computed, deps.pubkey);
  if (outcome.status === "unchecked") return { verdict: "UNCHECKED", reasons: [outcome.reason ?? "attestation not checked"] };
  if (outcome.status === "tampered") return { verdict: "TAMPERED", reasons: [outcome.reason ?? "attestation invalid"] };
  const shown = (receipt["verification"] as { kid?: unknown }).kid, signed = (JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString()) as { kid?: unknown }).kid;
  if (shown !== undefined && shown !== signed) return { verdict: "TAMPERED", reasons: ["verification.kid differs from the signing kid in the attestation header"] };
  if (c.problem) return { verdict: c.problem.verdict, reasons: [c.problem.reason] };
  return { verdict: "VERIFIED", reasons: [], receiptSha256: computed };
}
/** `loki verify --seal-composite <run_dir>`: writes a signed composite.json, refusing unless every child repo has a receipt. */
function sealCompositeCmd(runDir: string): number {
  let body;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(basename(runDir.replace(/\/+$/, "")))) return (process.stderr.write("loki verify: run directory name is not a valid run id; composite would never verify\n"), 2);
  try { body = composeComposite(runDir, computeReceiptHash); } catch (e) { return (process.stderr.write(`loki verify: ${(e as Error).message}\n`), 2); }
  const hash = compositeHash(body as unknown as Record<string, unknown>), sig = signReceipt(body.run_id, hash);
  const out = { ...body, composite_sha256: hash, verification: { jwt: sig.jwt, kid: sig.kid } }, path = join(runDir, "composite.json");
  writeFileSync(`${path}.tmp`, JSON.stringify(out, null, 2) + "\n"); renameSync(`${path}.tmp`, path);
  process.stdout.write(`composite: ${path}\nverdict: ${body.verdict}\nchildren: ${body.children.length}\nsignature: ${sig.jwt ? "signed" : "UNSIGNED (no signing key)"}\n${compositeLines(out).join("\n")}\n`);
  return sig.jwt ? 0 : EXIT_BY_VERDICT.UNSIGNED;
}
/** TEN-GATES-03: count passing checks by the provenance seal recorded (GATES-02). exogenous and independent are agent-independent; agent_authored and llm_judge are advisory.
 *  Absent or unknown provenance never counts as agent-independent (k=null prints "provenance not recorded"). */
function independentLine(receiptPath: string): { line: string; k: number; of: number } {
  let checks: Array<{ result?: unknown; provenance?: unknown; n?: unknown }> = [];
  try { const c = (JSON.parse(readFileSync(receiptPath, "utf8")) as { checks?: unknown }).checks; if (Array.isArray(c)) checks = c; } catch { /* unreadable: no provenance */ }
  const pass = checks.filter((c) => c?.result === "pass");
  if (!pass.some((c) => typeof c.provenance === "string")) return { line: "agent-independent: provenance not recorded", k: 0, of: pass.length };
  const k = pass.filter((c) => isExecutedProof(c) && (c.provenance === "exogenous" || c.provenance === "independent")).length, m = pass.filter((c) => c.provenance === "agent_authored" || c.provenance === "llm_judge").length;
  return { line: `agent-independent: ${k} of ${pass.length} passing checks (wall/holdout/pre-existing/static/probe); advisory: ${m}`, k, of: pass.length };
}
const independentCounts = (receiptPath: string): { k: number; of: number } => { const { k, of } = independentLine(receiptPath); return { k, of }; }; // TEN-GATES-26: --json agent_independent
// D47: a stripped receipt must never rank above UNCHECKED; --allow-unsigned opts in
/** A receipt found by run id must be signed for that run: a sealed directory copied under another id carries the original signed run_id and must not read VERIFIED. */
function signedRunIdProblem(receiptPath: string, runId: string): string | null {
  try { const r = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>, s = r["run_id"]; return isEnvelope(r) || typeof s !== "string" || s === runId ? null : `receipt run_id ${JSON.stringify(printable(s).slice(0, 128))} does not match the run id ${JSON.stringify(runId)} it was found under (a sealed run copied under another id)`; } catch { return null; }
}
const EXIT_BY_VERDICT:Record<Verdict, number> = { VERIFIED: 0, UNSIGNED: 3, TAMPERED: 1, UNCHECKED: 2 }; export const main = (args: readonly string[], deps: VerifyDeps = {}): Promise<number> => withExplain(args, (a, rec) => verifyMain(a, deps, rec)); // TEN-GATES-14: --explain / --json, read-only (util/check_result.ts)
async function verifyMain(args: readonly string[], deps: VerifyDeps, rec: ExplainRec): Promise<number> {
  const allowUnsigned = args.includes("--allow-unsigned") || process.env["LOKI_VERIFY_ALLOW_UNSIGNED"] === "1";
  const exportDsse = args.includes("--export-dsse"), requireExo = args.includes("--require-exogenous") || process.env["LOKI_VERIFY_REQUIRE_EXOGENOUS"] === "1"; // TEN-GATES-03
  args = args.filter((a) => a !== "--allow-unsigned" && a !== "--export-dsse" && a !== "--require-exogenous");
  const ma = takeMaxAge(args);
  if (ma.error) return (process.stderr.write(`loki verify: ${ma.error}\n`), 2);
  args = ma.args;
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write("Usage: loki verify [run-id]\nVerify .loki/runs/<run-id>/receipt.json (default: latest run).\nExit: 0 verified, 1 tampered, 2 unchecked, 3 unsigned (refused), 4 run outcome not verified, 66 no runs.\nOptions: --allow-unsigned (or LOKI_VERIFY_ALLOW_UNSIGNED=1) accepts an UNSIGNED receipt; never changes tampered/unchecked.\n         --pubkey FILE (or --pubkey=FILE, once) checks the signature against that Ed25519 JWK/PEM public key only, never the local JWKS.\n         --seal-composite RUN_DIR signs <RUN_DIR>/composite.json over every child repo receipt of a workspace run (refuses unless each has one); verify RUN_DIR/composite.json re-checks it offline.\n         --max-age DUR (or --max-age=DUR; Ns, Nm, Nh, Nd or seconds) rejects a receipt whose signed JWT iat is older than DUR, in the future, or absent: UNCHECKED, exit 2. Checked after integrity; tampered stays tampered.\n         --export-dsse prints a VERIFIED or ALREADY_SATISFIED run receipt as an in-toto Statement v1 in a DSSE envelope (Ed25519 over PAE); verify accepts that file too.\n         --sign-deploy FILE signs a loki.deploy/1 deploy record in place; verify FILE (add --receipt FILE when the cited receipt is not beside it) re-checks it offline and is VERIFIED only when the signature and the cited receipt both are.\n         --sign-provenance FILE signs a loki.provenance/1 doc (head_sha, tree_sha, receipt_sha256, run_id, built_at) in place; --url https://host [--expect-sha SHA] [--receipt FILE] [--pubkey FILE] fetches <host>/.well-known/loki-provenance.json (5s timeout, 64KB cap) and is VERIFIED only when the signature and any cited receipt both are; fetch failure or unknown kid is UNCHECKED. With --url, --max-age checks the signed built_at (stale, future, missing or unparseable: UNCHECKED, exit 2); --seal-composite and --export-dsse refuse --max-age (exit 2).\n         --require-exogenous (or LOKI_VERIFY_REQUIRE_EXOGENOUS=1) exits 4 when a VERIFIED receipt has no agent-independent passing check (see the agent-independent line) or no recorded provenance.\n         --explain lists each gate after the verdict as exogenous, agent-influenced or unrecorded, with its provenance, result and the evidence command it read; --json prints {run_id, run, verdict, exit_code, receipt_sha256, reasons, agent_independent:{k,of}, gates, signing_kid, key_kid, head_sha, receipt_verdict, signed_run_id, signed_sha256} on stdout (human lines on stderr; agent_independent and gates are null when TAMPERED; signing_kid is the JWT header kid of a VERIFIED receipt, key_kid the --pubkey thumbprint, signed_run_id the run_id inside the receipt, signed_sha256 its recomputed hash). Neither changes the verdict or exit code.\nUnknown flags and more than one run-id exit 2.\n");
    return 0;
  }
  const sc = args.indexOf("--seal-composite");
  if (ma.raw !== null && (sc >= 0 || exportDsse)) return (process.stderr.write("loki verify: --max-age is not supported with --seal-composite or --export-dsse; freshness was not checked\n"), 2);
  if (sc >= 0) return args.length === 2 && sc === 0 ? sealCompositeCmd(args[1]!) : (process.stderr.write("loki verify: --seal-composite takes exactly one run directory\n"), 2);
  const dep = await deployAttestCmd(args, { takePubkey, maxAge: ma.raw, now: deps.now, make: (pkey) => { const d = pkey ? { ...deps, pubkey: pkey } : deps; return { pubFor: (k) => pubFor(k, d.pubkey), verifyReceipt: (p) => verifyReceipt(p, d), attest: (j, h) => checkAttestation(j, h, d.pubkey) }; } }); if (dep !== null) return dep; // loki.deploy/1
  const pk = takePubkey(args); if (pk.error) return (process.stderr.write(`loki verify: ${pk.error}\n${/^(unknown option|expected at most one)/.test(pk.error) ? "Usage: loki verify [run-id] (see loki verify --help)\n" : ""}`), 2); // TEN-GATES-25
  args = pk.args;
  if (pk.pubkey) deps = { ...deps, pubkey: pk.pubkey };
  const runsRoot = deps.runsRoot ?? join(lokiDir(), "runs");
  const runId = args[0] ?? latestRunId(runsRoot) ?? undefined;
  if (!runId) return (process.stderr.write("loki verify: no runs found\n"), 66);
  const isFile = existsSync(runId) && statSync(runId).isFile();
  const isPath = isFile || /[\\/]/.test(runId) || runId.endsWith(".json"); // a path is reported as given, even when nothing is there
  const receiptPath = isPath ? runId : join(runsRoot, runId, "receipt.json"); // a receipt file path works directly
  const byRunId = !isPath; rec.runId = runId; rec.receiptPath = receiptPath; // TEN-GATES-14
  if (exportDsse) return exportDsseReceipt({ receiptPath, runId: byRunId ? runId : null, deps, verify: verifyReceipt, key: loadSigningKey(false), kidOf }); // INTEL-1 / INTEL-1b
  const bad = byRunId ? (runIdGuard(receiptPath, runId) ?? signedRunIdProblem(receiptPath, runId)) : null; // INTEL-1b: an envelope found under a run id must be for that run; a receipt must carry the run id it is found under
  if (bad) return (rec.verdict = "TAMPERED", rec.reasons = [bad], process.stdout.write(`run: ${runId}\nverdict: TAMPERED\n  ${bad}\n`), 1);
  let result = await verifyReceipt(receiptPath, deps); if (result.verdict === "VERIFIED" || result.verdict === "UNSIGNED") { const d = (() => { try { return sealDrift(receiptPath, JSON.parse(readFileSync(receiptPath, "utf8"))); } catch { return null; } })(); if (d) result = { verdict: d.verdict, reasons: [d.reason] }; } // P12-01
  if (ma.raw !== null) result = applyMaxAge(result, receiptPath, ma.raw, ma.seconds, (deps.now ?? Date.now)());
  { // --json identity for the audit verify.sh: read from the same parse the signature covers, never a text scan
    const id = (() => { try { const r = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>; const j = (r["verification"] as { jwt?: unknown } | undefined)?.jwt; const k = result.verdict === "VERIFIED" && typeof j === "string" ? (JSON.parse(Buffer.from(j.split(".")[0]!, "base64url").toString()) as { kid?: unknown }).kid : null; return { kid: typeof k === "string" ? k : null, head: typeof r["head_sha"] === "string" ? r["head_sha"] : null, verdict: typeof r["verdict"] === "string" ? r["verdict"] : null, run: typeof r["run_id"] === "string" ? r["run_id"] : null }; } catch { return { kid: null, head: null, verdict: null, run: null }; } })();
    rec.signingKid = id.kid; rec.keyKid = deps.pubkey ? kidOf(deps.pubkey) : null; rec.headSha = id.head; rec.receiptVerdict = id.verdict; rec.signedRunId = id.run; rec.signedSha = result.receiptSha256 ?? null;
  }
  // An intact (VERIFIED or UNSIGNED) receipt of a run that did not verify is never exit 0 and no flag changes that; unreadable fails closed.
  if (result.verdict === "VERIFIED" || result.verdict === "UNSIGNED") {
    const outcome = (() => { try { return outcomeOf(JSON.parse(readFileSync(receiptPath, "utf8"))); } catch { return "UNREADABLE"; } })();
    if (outcome !== "VERIFIED" && outcome !== "ALREADY_SATISFIED") { rec.verdict = `NOT VERIFIED (run outcome ${outcome})`; rec.independent = independentCounts(receiptPath); process.stdout.write(`run: ${runId}\nverdict: NOT VERIFIED (run outcome ${outcome}; receipt integrity ${result.verdict === "UNSIGNED" ? "unattested" : "intact"})\n`); return 4; }
  }
  if (result.verdict === "VERIFIED" || result.verdict === "UNSIGNED") { const note = wallNotComparedNote(receiptPath); if (note) result = { ...result, reasons: [...result.reasons, note] }; }
  rec.verdict = result.verdict; rec.reasons = result.reasons; rec.receiptSha256 = result.receiptSha256 ?? null; rec.independent = independentCounts(receiptPath); process.stdout.write(`run: ${runId}\nverdict: ${result.verdict}\n`);
  if (result.receiptSha256) process.stdout.write(`receipt_sha256: ${result.receiptSha256}\n`);
  for (const reason of result.reasons) process.stdout.write(`  ${reason}\n`);
  if (result.verdict !== "TAMPERED") try { const r = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>; if (isComposite(r)) for (const l of compositeLines(r)) process.stdout.write(`${l}\n`); else if (r["schema"] === "loki.v10.receipt/1") process.stdout.write(`${receiptSealAccuracy(r)}\n`); } catch { /* unreadable: the verdict above already says so */ }
  if (result.verdict === "UNSIGNED") {
    if (deps.pubkey) { process.stdout.write("attestation: UNSIGNED, but --pubkey asked for a signature check; refusing\n"); return EXIT_BY_VERDICT.UNSIGNED; }
    if (requireExo) { const ind = independentLine(receiptPath); process.stdout.write(`${ind.line}\n`); if (allowUnsigned && ind.k === 0) return (process.stdout.write("require-exogenous: refused, no agent-independent passing check\n"), 4); } // TEN-GATES-03-F1
    process.stdout.write(allowUnsigned ? "attestation: UNSIGNED (accepted by --allow-unsigned; integrity not attested)\n" : "attestation: UNSIGNED, integrity not attested; refusing (pass --allow-unsigned to accept)\n");
    return allowUnsigned ? 0 : EXIT_BY_VERDICT.UNSIGNED;
  } else if (result.verdict === "VERIFIED") {
    process.stdout.write(deps.pubkey ? `attestation: VERIFIED against the supplied key (kid ${kidOf(deps.pubkey)})\n` : "attestation: VERIFIED against the local JWKS\n");
    const ind = independentLine(receiptPath); process.stdout.write(`${ind.line}\n`); // TEN-GATES-03
    if (requireExo && ind.k === 0) return (process.stdout.write("require-exogenous: refused, no agent-independent passing check\n"), 4);
  }
  return EXIT_BY_VERDICT[result.verdict];
}
