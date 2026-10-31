// loki-ts/src/util/seal_drift.ts -- P12-01: compare a sealed receipt with the workspace it describes (composite_seal.ts is group binding; nothing owned this).
// Three checks on an intact VERIFIED/UNSIGNED receipt: fabricated success (a pass the bound log never recorded), intent drift (task sha256 vs the current spec),
// head drift (head_sha vs the repo HEAD). Fabricated success is TAMPERED; drift is UNCHECKED (the seal is intact but no longer describes the current state).
import { safeGit } from "./safe_git.ts";
import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { atomicWriteText } from "./atomic.ts";
import { kidOf, loadSigningKey, pubFor } from "./receipt_signer.ts";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { EventEnvelope } from "../engine10/types.ts";

const EMPTY_SHA = createHash("sha256").digest("hex");
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
export interface Drift { verdict: "TAMPERED" | "UNCHECKED"; reason: string }
type Obj = Record<string, unknown>;

/** True only for a log whose FINAL line is unterminated (no trailing newline) and does not parse: an append cut mid-write. An unparseable line followed by a newline, or any
 *  unparseable middle line, is never torn (it is an edit). Callers treat a torn tail as UNCHECKED, not TAMPERED. */
export function tornTail(raw: string): boolean {
  if (raw === "" || raw.endsWith("\n")) return false;
  const last = raw.slice(raw.lastIndexOf("\n") + 1);
  if (last.trim() === "") return false;
  try { JSON.parse(last); return false; } catch { return true; }
}

/** An answered run.resumed: answered:true with a string answer whose recorded answer_sha256 is the sha256 of that answer (what `loki answer` writes). */
export const isAnsweredResume = (e: EventEnvelope): boolean => e.type === "run.resumed" && e.data["answered"] === true && typeof e.data["answer"] === "string" && e.data["answer_sha256"] === createHash("sha256").update(e.data["answer"]).digest("hex");
/** True when the receipt.sealed at `seal` is an earlier attempt of an answered BLOCKED run: its next run.completed is a SPEC_CONFLICT that comes before `next`, and an answered resume follows it before `next`. */
export function answeredBlockedBetween(events: readonly EventEnvelope[], seal: number, next: number): boolean {
  const c = events.findIndex((e, i) => i > seal && e.type === "run.completed");
  return c > seal && events[c]!.data["verdict"] === "SPEC_CONFLICT" && events.some((e, i) => i > c && i < next && isAnsweredResume(e));
}

/** The events the receipt hash actually covers: the line-aligned prefix of events.jsonl hashing to events_sha256 (verify_cmd checkEventLog's rule), cut at log.sealed.
 *  Lines appended after seal are unbound and prove nothing. Null when no prefix matches (checkEventLog already reports that as TAMPERED). */
function boundEvents(log: string, bound: string): EventEnvelope[] | null {
  if (!existsSync(log)) return null;
  const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.trim() !== ""), h = createHash("sha256");
  let n = -1;
  for (let i = 0; i <= lines.length; i++) { if (h.copy().digest("hex") === bound) { n = i; break; } if (i < lines.length) h.update(lines[i] + "\n"); }
  if (n < 0) return null;
  const evs = lines.slice(0, n).flatMap((l) => { try { return [JSON.parse(l) as EventEnvelope]; } catch { return []; } });
  const seals = evs.flatMap((e, i) => (e.type === "receipt.sealed" ? [i] : []));
  const sealed = seals.find((s, k) => !answeredBlockedBetween(evs, s, seals[k + 1] ?? evs.length)); // a log.sealed inside the prefix is a cancel seal of an earlier attempt; only a receipt.sealed that no answered BLOCKED run separates from the next seal (or from the end of the bound prefix) ends the bound run (an answered BLOCKED run seals once per attempt)
  return sealed !== undefined ? evs.slice(0, sealed) : evs;
}

/** The shared log.sealed reader (every reader that once cut at the first log.sealed uses this instead). Each log.sealed must hash every line before it, carry
 *  tampered:false, and be signed by a known key (the receipt's kid when given). Every run.completed except the last must be followed by its seal (when sealing
 *  is expected: a signing key exists or a seal is present), so a deleted cancel seal cannot hide an edit. Null when intact or when the log was never sealed. */
export function verifyLogSeals(rawLog: string, events: readonly EventEnvelope[], opts: { kid?: unknown; given?: KeyObject; expectSeal?: boolean; sealLast?: boolean } = {}): string | null {
  const lines = rawLog.split("\n").filter((l) => l.trim() !== "");
  const sealIdx = events.flatMap((e, i) => (e.type === "log.sealed" ? [i] : []));
  const lastDone = events.findLastIndex((e) => e.type === "run.completed");
  if (!(opts.expectSeal === true || sealIdx.length > 0 || loadSigningKey(false) !== null)) return null;
  if (lines.length !== events.length) return `events.jsonl holds ${lines.length - events.length} unparsable line(s): a sealed log cannot be checked line by line, so it was edited or torn`; // a path that never runs resumePoint (publish resume) must not read a garbage line as "nothing to check"
  for (const i of sealIdx) {
    const d = events[i]!.data, want = createHash("sha256").update(lines.slice(0, i).join("\n") + (i > 0 ? "\n" : "")).digest("hex");
    const pub = (opts.kid === undefined || d["kid"] === opts.kid) ? pubFor(d["kid"], opts.given) : undefined;
    if (!pub || d["events_sha256"] !== want || d["tampered"] !== false || typeof d["sig"] !== "string" || !verify(null, Buffer.from(`${want}:false`), pub, Buffer.from(d["sig"], "base64url"))) return `a log.sealed line (seq ${events[i]!.seq}) does not match the lines before it: events.jsonl was edited, or the seal is forged or unverifiable (if the signing key was rotated, list the old public key in LOKI_RECEIPT_RETIRED_PUBKEYS)`;
  }
  for (let i = 0; i < (opts.sealLast ? lastDone + 1 : lastDone); i++) if (events[i]!.type === "run.completed" && events[i + 1]?.type !== "log.sealed") return `run.completed (seq ${events[i]!.seq}) is not followed by its log.sealed line: the seal was removed`;
  return null;
}

/** A receipt whose bound log shows the verify stage ran must not claim a passing check the log never recorded as a test.result pass. Unbound receipts (no log at seal) are skipped. */
function fabricatedPass(receiptPath: string, r: Obj): string | null {
  const bound = r["events_sha256"];
  if (typeof bound !== "string" || bound === EMPTY_SHA || !Array.isArray(r["checks"])) return null;
  const events = boundEvents(join(dirname(receiptPath), "events.jsonl"), bound);
  if (!events || !events.some((e) => e.stage === "verify")) return null; // the verify stage left no trace (hand-built or partial log): nothing to compare
  const passed = new Set(events.filter((e) => e.type === "test.result" && e.stage === "verify" && e.data["result"] === "pass").map((e) => String(e.data["name"])));
  const missing = (r["checks"] as Obj[]).filter((c) => c?.["result"] === "pass" && !passed.has(String(c["name"]))).map((c) => String(c["name"]));
  return missing.length ? `receipt claims pass with no test.result pass in events.jsonl: ${missing.join(", ")}` : null;
}

/** The current spec the sealed task sha256 is compared with: the run's issue.json (issue source), or the file named by LOKI_VERIFY_TASK_FILE (text source). Null when none is available. */
function currentTaskSha(runDir: string, source: unknown, env: NodeJS.ProcessEnv): string | null {
  const f = source === "issue" ? join(runDir, "issue.json") : env["LOKI_VERIFY_TASK_FILE"];
  return f && existsSync(f) ? sha(readFileSync(f)) : null;
}

/** <repo>/.loki/runs/<id>/receipt.json -> <repo>; null for any other layout (a copied receipt has no workspace to drift from). */
function repoOf(receiptPath: string): string | null {
  const runs = dirname(dirname(receiptPath));
  return basename(runs) === "runs" && basename(dirname(runs)) === ".loki" ? dirname(dirname(runs)) : null;
}

/** Paths changed since the seal (head_sha..HEAD) that the sealed diff (base_sha..head_sha) also touched. A moved HEAD with no overlap is benign (empty list).
 *  Null when the sealed diff cannot be established (no usable base_sha, repo error, empty sealed diff): the caller then treats any HEAD move as drift. */
function overlap(repo: string, base: unknown, sealedHead: string, head: string): string[] | null {
  if (typeof base !== "string" || !/^[0-9a-f]{40,64}$/.test(base) || !/^[0-9a-f]{40,64}$/.test(sealedHead)) return null;
  try {
    const names = (a: string, b: string): string[] => safeGit(repo, ["diff", "--name-only", "--no-renames", "-z", a, b]).split("\0").filter((x) => x !== "");
    const sealed = new Set(names(base, sealedHead));
    if (sealed.size === 0) return null;
    return names(sealedHead, head).filter((x) => sealed.has(x));
  } catch { return null; }
}

/** FC-VERIFIED-PR-WITHOUT-ITS-TEST: true only when EVERY commit after the sealed head is this run's Wall publish commit: a trailer line naming the receipt's run_id, only paths of the receipt's wall.files, each blob sha256 equal to the sealed one.
 *  Anything else (a hook-added file, a rewritten Wall file, a forged trailer, a non-linear history) is not benign. */
export function onlyWallPublish(repo: string, r: Obj, sealedHead: string, head: string): boolean {
  const run = r["run_id"], wall = ((r["wall"] ?? {}) as { files?: { path?: unknown; sha256?: unknown }[] }).files;
  if (typeof run !== "string" || run === "" || !Array.isArray(wall) || !/^[0-9a-f]{40,64}$/.test(sealedHead)) return false;
  try {
    const real = (x: string): string => { try { return realpathSync(x); } catch { return x; } }, rr = real(repo), want = new Map(wall.map((w) => [relative(rr, join(real(dirname(String(w.path))), basename(String(w.path)))), String(w.sha256)] as const));
    const commits = safeGit(repo, ["rev-list", "--reverse", "--topo-order", `${sealedHead}..${head}`]).split("\n").filter(Boolean);
    if (commits.length === 0 || safeGit(repo, ["rev-list", "--merges", "--count", `${sealedHead}..${head}`]).trim() !== "0") return false;
    let parent = sealedHead;
    for (const c of commits) {
      if (safeGit(repo, ["rev-parse", `${c}^`]).trim() !== parent) return false;
      if (!safeGit(repo, ["log", "-1", "--format=%B", c]).split("\n").includes(`Loki-Wall-Publish: ${run}`)) return false;
      const names = safeGit(repo, ["diff", "--name-only", "--no-renames", "-z", parent, c]).split("\0").filter(Boolean);
      if (names.length === 0) return false;
      for (const n of names) { const h = want.get(n); if (h === undefined || sha(safeGit(repo, ["cat-file", "blob", `${c}:${n}`])) !== h) return false; }
      parent = c;
    }
    return true;
  } catch { return false; }
}

/** Any commit after the sealed head that carries this run's Wall trailer. Such a commit must pass onlyWallPublish; other later commits keep the TEN-GATES-16 sealed-path overlap rule. */
function claimsWallPublish(repo: string, r: Obj, sealedHead: string, head: string): boolean {
  try { return typeof r["run_id"] === "string" && safeGit(repo, ["log", "--format=%B", `${sealedHead}..${head}`]).split("\n").includes(`Loki-Wall-Publish: ${r["run_id"]}`); } catch { return false; }
}

export function sealDrift(given: string, r: Obj, env: NodeJS.ProcessEnv = process.env): Drift | null {
  let receiptPath = given;
  try { receiptPath = join(realpathSync(dirname(given)), basename(given)); } catch { /* keep the given path */ } // resolve the DIRECTORY only (as verifyReceipt/checkEventLog read the log from dirname(given)); a receipt.json symlink must not move the log and layout lookup
  const fab = fabricatedPass(receiptPath, r);
  if (fab) return { verdict: "TAMPERED", reason: fab };
  try { const log = join(dirname(receiptPath), "events.jsonl"); if (existsSync(log) && tornTail(readFileSync(log, "utf8"))) return { verdict: "UNCHECKED", reason: "events.jsonl ends in a torn, unterminated line (an append cut mid-write); every complete line is intact but the log is not whole" }; } catch { /* unreadable log: checkEventLog owns that */ }
  const task = (r["task"] ?? {}) as { source?: unknown; sha256?: unknown };
  const cur = currentTaskSha(dirname(receiptPath), task.source, env);
  if (cur !== null && typeof task.sha256 === "string" && task.sha256 !== "" && cur !== task.sha256) return { verdict: "UNCHECKED", reason: `intent drift: sealed task sha256 ${task.sha256} differs from the current spec ${cur}` };
  const repo = repoOf(receiptPath);
  if (repo && env["LOKI_VERIFY_ALLOW_HEAD_DRIFT"] !== "1" && typeof r["head_sha"] === "string") {
    let head = "";
    try { head = safeGit(repo, ["rev-parse", "HEAD"]).trim(); } catch { return null; }
    if (head !== "" && head !== r["head_sha"] && !onlyWallPublish(repo, r, r["head_sha"], head)) {
      if (claimsWallPublish(repo, r, r["head_sha"], head)) return { verdict: "UNCHECKED", reason: `head drift: HEAD ${head} carries a Loki-Wall-Publish commit for this run that is not exactly its sealed Wall files (LOKI_VERIFY_ALLOW_HEAD_DRIFT=1 accepts)` }; // a trailer is a claim; a forged or hook-widened child is never benign
      const hit = overlap(repo, r["base_sha"], r["head_sha"], head);
      if (hit === null) return { verdict: "UNCHECKED", reason: `head drift: receipt head_sha ${r["head_sha"]} is not the current HEAD ${head} (LOKI_VERIFY_ALLOW_HEAD_DRIFT=1 accepts)` };
      if (hit.length) return { verdict: "UNCHECKED", reason: `head drift: HEAD ${head} changed sealed path(s) after the seal: ${hit.join(", ")} (LOKI_VERIFY_ALLOW_HEAD_DRIFT=1 accepts)` };
    }
  }
  return null;
}

/** Honest note, never a verdict change: the receipt lists sealed Wall files but no <run dir>/wall exists to compare them with (an exported bundle omits it on purpose). */
export function wallNotComparedNote(receiptPath: string): string | null {
  try {
    const r = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    if (r["schema"] !== "loki.v10.receipt/1") return null;
    const files = (r["wall"] as { files?: unknown } | null | undefined)?.files;
    return Array.isArray(files) && files.length > 0 && !existsSync(join(dirname(receiptPath), "wall")) ? "sealed Wall copies not present: not compared" : null;
  } catch { return null; }
}

/** The run-state record: the supervisor's verdict on the run's own integrity, kept in run.state.json beside the log so it survives a truncated or rewritten log tail.
 *  Written "open" at the receipt checkpoint, rewritten the moment a tamper is seen and once more when the run ends. It is bound to the run id (and the receipt hash) and
 *  signed when a signing key exists. A publish resume needs it intact, untampered and closed as CANCELLED: a missing record or an open one (all a crash leaves, and a copy a child could have captured) is a refusal. */
const stateSig = (r: Obj): string => `loki.run.state/1:${String(r["run_id"])}:${String(r["receipt_sha256"])}:${String(r["state"])}:${String(r["tampered"])}:${String(r["outcome"])}`;
export function writeRunState(runDir: string, runId: string, s: { state: "open" | "closed"; tampered: boolean; receipt_sha256: string | null; outcome?: string }): void {
  const rec: Obj = { schema: "loki.run.state/1", run_id: runId, state: s.tampered ? "closed" : s.state, tampered: s.tampered, receipt_sha256: s.receipt_sha256, outcome: s.outcome ?? null }, key = loadSigningKey(false);
  if (key) rec["signed"] = { kid: kidOf(createPublicKey(key)), sig: sign(null, Buffer.from(stateSig(rec)), key).toString("base64url") };
  try { atomicWriteText(join(runDir, "run.state.json"), JSON.stringify(rec) + "\n"); } catch { /* the resume refuses when the record is missing */ }
}
const FRESH = "set LOKI_NO_RESUME=1 to start a fresh run instead";
/** Null when run.state.json lets a publish resume proceed for this receipt hash; otherwise the reason it must be refused. */
/** The signed checkpoint contract for a publish resume (the writer is SupervisorLog.checkpoint, the other readers are verify_cmd and the Control Plane's integrity.ts):
 *  a signed receipt (a jwt, or log_seal) is followed at once by a log.sealed that hashes every earlier line, carries tampered:false and verifies under the receipt's key.
 *  `signed` is false for a receipt written without a key (no checkpoint exists then); `problem` is null when a signed checkpoint is present and valid.
 *  `receipt` is the parsed receipt.json; when omitted it is read from runDir, and an unreadable one reports a problem. */
export function checkpointProblem(runDir: string, events: readonly EventEnvelope[], receipt?: Obj): { signed: boolean; problem: string | null } {
  let r = receipt;
  if (!r) { try { r = JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8")) as Obj; } catch { return { signed: false, problem: "receipt.json is missing or unreadable" }; } }
  const at = events.findIndex((e) => e.type === "receipt.sealed"), jwt = ((r["verification"] ?? {}) as { jwt?: unknown }).jwt ?? null, signed = jwt !== null || r["log_seal"] === true;
  if (!signed) return { signed: false, problem: null };
  const ck = at + 1;
  if (at < 0 || events[ck]?.type !== "log.sealed") return { signed, problem: "the signed checkpoint after receipt.sealed is missing; the log was cut or edited" };
  let kid: unknown;
  if (typeof jwt === "string") { try { kid = (JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString()) as { kid?: unknown }).kid; } catch { return { signed, problem: "the receipt signature header is malformed" }; } }
  let raw = "";
  try { raw = readFileSync(join(runDir, "events.jsonl"), "utf8"); } catch { return { signed, problem: "events.jsonl is unreadable" }; }
  const prefix = raw.split("\n").filter((l) => l.trim() !== "").slice(0, ck + 1).join("\n") + "\n";
  const bad = verifyLogSeals(prefix, events.slice(0, ck + 1), { kid, expectSeal: true });
  return { signed, problem: bad ? `the signed checkpoint after receipt.sealed is invalid (${bad})` : null }; // verifyLogSeals only accepts a tampered:false seal, so a recorded tamper is invalid here too
}
/** `openOk`: a record still "open" is accepted. Set only by a caller that has verified the signed checkpoint: an open record is all a crash in the publish phase can leave, and
 *  everything the resume then trusts lies at or before that checkpoint, so a tamper after it (or a child holding a copy of the open record) changes nothing it reads. */
export function runStateProblem(runDir: string, runId: string, receiptSha: string, openOk = false): string | null {
  const f = join(runDir, "run.state.json");
  let r: Obj;
  try { if (lstatSync(f).isSymbolicLink()) return "run.state.json is a symlink"; r = JSON.parse(readFileSync(f, "utf8")) as Obj; } catch { return `run.state.json is missing or unreadable; the supervisor's integrity verdict for this run is unknown; ${FRESH}`; }
  if (r["schema"] !== "loki.run.state/1" || r["run_id"] !== runId) return "run.state.json does not belong to this run";
  const sg = r["signed"] as { kid?: unknown; sig?: unknown } | undefined, key = loadSigningKey(false);
  if (sg === undefined) { if (key !== null) return "run.state.json is unsigned although a signing key exists"; }
  else {
    const pub = typeof sg.sig === "string" ? pubFor(sg.kid) : undefined; let ok = false;
    try { ok = !!pub && verify(null, Buffer.from(stateSig(r)), pub, Buffer.from(String(sg.sig), "base64url")); } catch { /* ok stays false */ }
    if (!ok) return "run.state.json signature does not verify";
  }
  if (r["tampered"] !== false) return "the supervisor recorded a tamper on this run";
  if (r["receipt_sha256"] !== receiptSha) return "run.state.json is not bound to this receipt";
  if (r["state"] === "closed" && r["outcome"] === "CANCELLED") return null; // written after the final verify with every child dead, so no child can hold a copy of it
  if (r["state"] === "open" && openOk) return null;
  if (r["state"] === "open") return `the supervisor never recorded a clean end for this run (a crash leaves only an open record, and a child could hold a copy of it); ${FRESH}`;
  return `the supervisor closed this run as ${String(r["outcome"])}; it is not an interrupted run`;
}
