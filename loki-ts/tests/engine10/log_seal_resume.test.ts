import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadSigningKey } from "../../src/util/receipt_signer.ts";
import { runSupervisor, SupervisorLog } from "../../src/engine10/supervisor.ts";
import { receiptSha256, signReceipt } from "../../src/engine10/stages/seal.ts";
import { readEvents } from "../../src/engine10/events.ts";
import { findInterrupted, isCancelDone, resumeMain, resumePoint, resumePublish, phaseOf, startRecovery, type RunPrFn } from "../../src/util/run_outputs.ts";
import { verifyLogSeals } from "../../src/util/seal_drift.ts";
import { main, verifyReceipt } from "../../src/engine10/verify_cmd.ts";

const root = mkdtempSync(join(tmpdir(), "sb04r4-"));
beforeAll(() => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "k.pem"); signReceipt("warm", "0".repeat(64)); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const types = (ev: string): string => readFileSync(ev, "utf8").trim().split("\n").map((l) => JSON.parse(l).type).join(",");
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
let n = 0;
function seal(dir: string, id: string, ev: string, log: SupervisorLog, checks: unknown[]): void {
  const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", events_sha256: sha(readFileSync(ev)), time: { wall_s: 0, stages: {} }, log_seal: true, checks };
  const hash = receiptSha256(body as never);
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signReceipt(id, hash) }, null, 2));
  log.append("receipt.sealed", "seal", { receipt_sha256: hash });
}

test("F1: log edited between cancel and resume is TAMPERED", async () => {
  const id = `e10-r4-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  const a = new SupervisorLog(ev, id);
  a.append("run.started", null, { provider: "claude" });
  a.append("stage.completed", "wall", { holdout: "STRICT" });
  a.append("run.completed", null, { verdict: "FAILED", cancelled: true, signal: "SIGTERM", outcome: "CANCELLED" });
  a.sealLog();
  writeFileSync(ev, readFileSync(ev, "utf8").replace('"STRICT"', '"WEAKX"'));
  const b = new SupervisorLog(ev, id);
  b.append("run.resumed", null, {});
  seal(dir, id, ev, b, []);
  b.append("run.completed", null, { verdict: "VERIFIED" });
  b.sealLog();
  expect((await verifyReceipt(join(dir, "receipt.json"))).verdict).toBe("TAMPERED");
});

test("F1: resume refuses a log edited after the cancel seal", () => {
  const id = `e10-r4-${n++}`, repo = join(root, "repo"), dir = join(repo, ".loki", "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  const a = new SupervisorLog(ev, id);
  a.append("run.started", null, { provider: "claude" });
  a.append("stage.completed", "intake", { base_sha: "a".repeat(40), task: "t" });
  a.append("stage.completed", "wall", { holdout: "STRICT" });
  a.append("run.completed", null, { verdict: "FAILED", cancelled: true, signal: "SIGTERM", outcome: "CANCELLED" });
  a.sealLog();
  expect(findInterrupted(repo, id, true)).not.toBeNull();
  writeFileSync(ev, readFileSync(ev, "utf8").replace('"STRICT"', '"WEAKX"'));
  expect(resumePoint(readEvents(ev), readFileSync(ev, "utf8")).ok).toBe(false);
  expect(findInterrupted(repo, id, true)).toBeNull();
});

for (const cancelled of [true, false]) test(`F2: honest resume verifies, exit 0 (cancel pair=${cancelled})`, async () => {
  const id = `e10-r4-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  let log = new SupervisorLog(ev, id);
  log.append("run.started", null, { provider: "claude" });
  log.append("stage.started", "verify", {});
  if (cancelled) { log.append("run.completed", null, { verdict: "FAILED", cancelled: true, signal: "SIGTERM", outcome: "CANCELLED" }); log.sealLog(); log = new SupervisorLog(ev, id); log.append("run.resumed", null, {}); log.append("stage.started", "verify", {}); }
  log.append("test.result", "verify", { name: "unit", cmd: "bun test", result: "pass" });
  seal(dir, id, ev, log, [{ name: "unit", cmd: "bun test", result: "pass" }]);
  log.append("run.completed", null, { verdict: "VERIFIED" });
  log.sealLog();
  expect((await verifyReceipt(join(dir, "receipt.json"))).verdict).toBe("VERIFIED");
  const w = process.stdout.write.bind(process.stdout); process.stdout.write = (() => true) as never;
  let rc: number; try { rc = await main([id], { runsRoot: join(root, "runs") }); } finally { process.stdout.write = w; }
  expect(rc).toBe(0);
  expect(types(ev)).toContain("receipt.sealed");
});

test("F1: deleting the cancel seal to hide an edit is refused on resume and TAMPERED on verify", async () => {
  const id = `e10-r4-${n++}`, repo = join(root, "repo"), dir = join(repo, ".loki", "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  const a = new SupervisorLog(ev, id);
  a.append("run.started", null, { provider: "claude" });
  a.append("stage.completed", "intake", { base_sha: "a".repeat(40), task: "t" });
  a.append("stage.completed", "wall", { holdout: "STRICT" });
  a.append("run.completed", null, { verdict: "FAILED", cancelled: true, signal: "SIGTERM", outcome: "CANCELLED" });
  a.sealLog();
  const kept = readFileSync(ev, "utf8").trim().split("\n").slice(0, -1).join("\n").replace('"STRICT"', '"WEAKX"') + "\n";
  writeFileSync(ev, kept);
  expect(resumePoint(readEvents(ev), kept).ok).toBe(false);
  const b = new SupervisorLog(ev, id);
  b.append("run.resumed", null, {});
  seal(dir, id, ev, b, []);
  b.append("run.completed", null, { verdict: "VERIFIED" });
  b.sealLog();
  expect((await verifyReceipt(join(dir, "receipt.json"))).verdict).toBe("TAMPERED");
});

test("a second receipt.sealed is TAMPERED", async () => {
  const id = `e10-r4-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  const log = new SupervisorLog(ev, id);
  log.append("run.started", null, { provider: "claude" });
  log.append("stage.started", "verify", {});
  log.append("test.result", "verify", { name: "unit", cmd: "bun test", result: "pass" });
  seal(dir, id, ev, log, [{ name: "unit", cmd: "bun test", result: "pass" }]);
  log.append("receipt.sealed", "seal", { receipt_sha256: "f".repeat(64) });
  log.append("run.completed", null, { verdict: "VERIFIED" });
  log.sealLog();
  expect((await verifyReceipt(join(dir, "receipt.json"))).verdict).toBe("TAMPERED");
});

/** An answered run as the supervisor writes it: attempt one seals (first verdict, optionally BLOCKED), then an in-place answer resumes it and attempt two seals again. */
function answeredRun(firstVerdict: string, resumed: boolean, answered = true): { dir: string; ev: string; id: string; first: string } {
  const id = `e10-r4-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  let log = new SupervisorLog(ev, id);
  log.append("run.started", null, { provider: "claude" });
  log.append("stage.started", "verify", {});
  seal(dir, id, ev, log, []);
  const first = readFileSync(join(dir, "receipt.json"), "utf8");
  log.append("run.completed", null, { verdict: firstVerdict });
  log.sealLog();
  log = new SupervisorLog(ev, id);
  if (resumed) log.append("run.resumed", null, answered ? { answered: true, answer: "yes", answer_sha256: sha("yes"), question: "q" } : {});
  log.append("test.result", "verify", { name: "unit", cmd: "bun test", result: "pass" });
  seal(dir, id, ev, log, [{ name: "unit", cmd: "bun test", result: "pass" }]);
  log.append("run.completed", null, { verdict: "VERIFIED" });
  log.sealLog();
  return { dir, ev, id, first };
}
const tamperedBySecondSeal = async (dir: string): Promise<void> => {
  const r = await verifyReceipt(join(dir, "receipt.json"));
  expect(r.verdict).toBe("TAMPERED");
  expect(r.reasons.join(" ")).toContain("more than one receipt.sealed");
};

test("an answered BLOCKED run with two seals verifies VERIFIED", async () => {
  expect((await verifyReceipt(join(answeredRun("SPEC_CONFLICT", true).dir, "receipt.json"))).verdict).toBe("VERIFIED");
});
test("a second receipt.sealed with no run.resumed between is TAMPERED even after a BLOCKED first attempt", async () => {
  await tamperedBySecondSeal(answeredRun("SPEC_CONFLICT", false).dir);
});
test("a plain (not answered) run.resumed between two seals is TAMPERED", async () => {
  await tamperedBySecondSeal(answeredRun("SPEC_CONFLICT", true, false).dir);
});
test("a run.resumed forged after a VERIFIED (not BLOCKED) first seal is TAMPERED", async () => {
  await tamperedBySecondSeal(answeredRun("VERIFIED", true).dir);
});
test("a receipt that matches the first seal, not the last, is TAMPERED", async () => {
  const r = answeredRun("SPEC_CONFLICT", true);
  writeFileSync(join(r.dir, "receipt.json"), r.first);
  await tamperedBySecondSeal(r.dir);
});
test("an edited first-attempt event of an answered run is TAMPERED", async () => {
  const r = answeredRun("SPEC_CONFLICT", true);
  writeFileSync(r.ev, readFileSync(r.ev, "utf8").replace('"stage.started"', '"stage.started" '));
  expect((await verifyReceipt(join(r.dir, "receipt.json"))).verdict).toBe("TAMPERED");
});

// Round 5: a cancelled publish-phase run goes findInterrupted -> resumePublish without resumePoint, so the seal check and the receipt file must carry the trust.
/** git in a test repo with a fixed identity and no signing. */
const tgit = (repo: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" }).trim();
/** A commit on loki/<id>; its sha is what the receipt seals as head_sha. */
function sealedBranch(repo: string, id: string): string {
  tgit(repo, "commit", "-q", "--allow-empty", "-m", "sealed"); tgit(repo, "branch", `loki/${id}`);
  return tgit(repo, "rev-parse", "HEAD");
}
/** A publish-phase run written the way the supervisor writes it: receipt.sealed, then the signed checkpoint and an open run.state.json; a cancel appends its pair and closes the record as CANCELLED.
 *  cancel=false is the crash shape runSupervisor leaves when it dies in the publish phase: the checkpoint and an open record, nothing after. */
function publishRepo(verdict = "FAILED", cancel = false, logVerdict = verdict, wallFile = ""): { repo: string; dir: string; ev: string; id: string; calls: { verdict: unknown }[]; runPr: RunPrFn } {
  const id = `e10-r5-${n++}`, repo = mkdtempSync(join(root, "pub-")), dir = join(repo, ".loki", "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo }); execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: repo });
  const head = sealedBranch(repo, id);
  const log = new SupervisorLog(ev, id);
  log.append("run.started", null, { provider: "claude" });
  log.append("stage.completed", "intake", { base_sha: "a".repeat(40), task: "t" });
  const wall = wallFile === "" ? {} : { wall: { files: [{ path: join(repo, "wall_test.ts"), sha256: sha(wallFile) }] } };
  const body = { schema: "loki.v10.receipt/1", run_id: id, verdict, head_sha: head, not_proven: ["real gap"], events_sha256: sha(readFileSync(ev)), time: { wall_s: 0, stages: {} }, log_seal: true, checks: [], ...wall };
  const hash = receiptSha256(body as never);
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signReceipt(id, hash) }, null, 2));
  log.append("receipt.sealed", "seal", { receipt_sha256: hash, verdict: logVerdict, not_proven: [], path: join(dir, "receipt.json") }); log.checkpoint(hash);
  if (cancel) { log.append("run.completed", null, { verdict: "FAILED", cancelled: true, signal: "SIGTERM", outcome: "CANCELLED" }); log.sealLog(); }
  if (cancel) log.state("closed", "CANCELLED");
  const calls: { verdict: unknown }[] = [];
  const runPr: RunPrFn = async (c) => { calls.push({ verdict: ((c as { outputs: () => { seal: { verdict: unknown } } }).outputs()).seal.verdict }); return { status: "completed", data: { pr_url: "https://github.com/o/r/pull/9", draft: false, existing: null } }; };
  return { repo, dir, ev, id, calls, runPr };
}
/** The production entry: `loki resume` (resumeMain). A cancelled run is never resumed there (SB-12), so this reaches only the crash shape runSupervisor leaves. */
async function resumeIn(repo: string, runPr: RunPrFn): Promise<number> {
  const cwd = process.cwd(); process.chdir(repo);
  try { return await resumeMain([], { runPr, out: () => {} }); } finally { process.chdir(cwd); }
}
/** resumePublish handed a cancelled run directly: unreachable from loki start or loki resume, kept only to prove the guards inside it still refuse. */
async function resumeCancelledDirect(repo: string, runPr: RunPrFn): Promise<number> {
  const it = findInterrupted(repo, undefined, true);
  return it ? resumePublish(repo, it, { runPr, out: () => {} }) : 3;
}

test("R5-1: a seal-covered edit plus an unparsable appended line is refused on a cancelled publish resume", async () => {
  const p = publishRepo("FAILED");
  expect(await resumeIn(p.repo, p.runPr)).toBe(0); // control: the honest cancelled publish run resumes
  expect(p.calls).toEqual([{ verdict: "FAILED" }]);
  const q = publishRepo("FAILED");
  writeFileSync(q.ev, readFileSync(q.ev, "utf8").replace('"verdict":"FAILED","not_proven":[]', '"verdict":"VERIFIED","not_proven":[]') + "garbage\n");
  expect(readFileSync(q.ev, "utf8")).toContain('"verdict":"VERIFIED"');
  expect(await resumeIn(q.repo, q.runPr)).not.toBe(0);
  expect(q.calls).toEqual([]);
});

test("R5-2: a receipt.sealed VERIFIED appended after the cancel seal does not change the published verdict", async () => {
  const p = publishRepo("FAILED");
  new SupervisorLog(p.ev, p.id).append("receipt.sealed", "seal", { receipt_sha256: "f".repeat(64), verdict: "VERIFIED", not_proven: [] });
  expect(findInterrupted(p.repo, p.id, true)).not.toBeNull(); // the cancel seal still verifies, so the gap is in what resume trusts
  expect(await resumeIn(p.repo, p.runPr)).toBe(5);
  expect(p.calls).toEqual([]);
});

test("R5-2: a second receipt.sealed VERIFIED on a crashed (never cancel-sealed) publish run is refused", async () => {
  const p = publishRepo("FAILED", false);
  new SupervisorLog(p.ev, p.id).append("receipt.sealed", "seal", { receipt_sha256: "f".repeat(64), verdict: "VERIFIED", not_proven: [] });
  expect(await resumeIn(p.repo, p.runPr)).toBe(5);
  expect(p.calls).toEqual([]);
  const q = publishRepo("FAILED", false);
  expect(await resumeIn(q.repo, q.runPr)).toBe(0); // control: the same shape with a closed CANCELLED record resumes with the file's verdict
  expect(q.calls).toEqual([{ verdict: "FAILED" }]);
});

test("R5-2: a receipt.sealed line that disagrees with the signed receipt file publishes the file's verdict", async () => {
  const p = publishRepo("FAILED", false, "VERIFIED");
  expect(await resumeIn(p.repo, p.runPr)).toBe(0);
  expect(p.calls).toEqual([{ verdict: "FAILED" }]);
});

test("R5-2: any other event appended after the cancel seal refuses a publish resume", async () => {
  const p = publishRepo("FAILED", true);
  new SupervisorLog(p.ev, p.id).append("worker.note", null, { x: 1 });
  expect(await resumeCancelledDirect(p.repo, p.runPr)).toBe(5);
  expect(p.calls).toEqual([]);
});

test("R5-2: the published verdict comes from the signed receipt file, and an edited file is refused", async () => {
  const p = publishRepo("FAILED");
  const f = join(p.dir, "receipt.json"), good = readFileSync(f, "utf8");
  writeFileSync(f, good.replace('"verdict": "FAILED"', '"verdict": "VERIFIED"'));
  expect(await resumeIn(p.repo, p.runPr)).toBe(5);
  writeFileSync(f, good);
  expect(await resumeIn(p.repo, p.runPr)).toBe(0);
  expect(p.calls).toEqual([{ verdict: "FAILED" }]);
});

test("R5-3: a cancel seal signed by a different known key than the receipt's is TAMPERED", async () => {
  const keyB = join(root, "kB.pem"), keyA = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]!, id = `e10-r5-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyB;
  try {
    loadSigningKey(); // sealLog only signs with a key that already exists
    const a = new SupervisorLog(ev, id);
    a.append("run.started", null, { provider: "claude" });
    a.append("run.completed", null, { verdict: "FAILED", cancelled: true, signal: "SIGTERM", outcome: "CANCELLED" });
    a.sealLog(); // signed by the second key
    const pubB = join(root, "kB.pub.pem");
    writeFileSync(pubB, createPublicKey(loadSigningKey()!).export({ type: "spki", format: "pem" }));
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyA;
    process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"] = pubB; // known to this machine, so only the kid binding can reject it
    const b = new SupervisorLog(ev, id);
    b.append("run.resumed", null, {});
    seal(dir, id, ev, b, []);
    b.append("run.completed", null, { verdict: "VERIFIED" });
    b.sealLog(); // signed by the receipt's own key
    const v = await verifyReceipt(join(dir, "receipt.json"));
    expect(v.verdict).toBe("TAMPERED");
    expect(v.reasons.join(" ")).toContain("does not match the lines before it"); // the cancel seal's own check, not a later one
  } finally { process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyA; delete process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"]; }
});

test("R5-1: verifyLogSeals reports an unparsable line in a sealed log instead of skipping the check", () => {
  const p = publishRepo("FAILED"), raw = readFileSync(p.ev, "utf8");
  expect(verifyLogSeals(raw, readEvents(p.ev))).toBeNull();
  expect(verifyLogSeals(raw + "garbage\n", readEvents(p.ev))).toContain("unparsable");
});

// Round 6: a signed receipt from ANOTHER run must never ride into this run's publish resume.
function crashedVerified(): ReturnType<typeof publishRepo> { return publishRepo("VERIFIED", false); } // the crash shape: checkpoint and an open record, no cancel pair
async function refused(p: ReturnType<typeof publishRepo>): Promise<void> { expect(await resumeIn(p.repo, p.runPr)).not.toBe(0); expect(p.calls).toEqual([]); }
const failedRun = (): ReturnType<typeof publishRepo> => publishRepo("FAILED");

test("V6: B's events.jsonl and receipt.json symlinked to a crashed VERIFIED run X are refused", async () => {
  const x = crashedVerified(), b = failedRun();
  rmSync(b.ev); rmSync(join(b.dir, "receipt.json"));
  symlinkSync(x.ev, b.ev); symlinkSync(join(x.dir, "receipt.json"), join(b.dir, "receipt.json"));
  await refused(b);
});

test("V7: X's completed log cut after its receipt.sealed plus X/receipt.json placed into B is refused", async () => {
  const x = crashedVerified(), b = failedRun(), lines = readFileSync(x.ev, "utf8").trim().split("\n");
  writeFileSync(b.ev, lines.slice(0, lines.findIndex((l) => JSON.parse(l).type === "receipt.sealed") + 1).join("\n") + "\n");
  writeFileSync(join(b.dir, "receipt.json"), readFileSync(join(x.dir, "receipt.json")));
  await refused(b);
});

test("V8: B's own log minus its last 2 lines, receipt.sealed pointed at X's receipt, X/receipt.json copied in, is refused", async () => {
  const x = crashedVerified(), b = failedRun(), xr = JSON.parse(readFileSync(join(x.dir, "receipt.json"), "utf8"));
  const lines = readFileSync(b.ev, "utf8").trim().split("\n").slice(0, -2).map((l) => { const e = JSON.parse(l); if (e.type === "receipt.sealed") e.data.receipt_sha256 = xr.receipt_sha256; return JSON.stringify(e); });
  writeFileSync(b.ev, lines.join("\n") + "\n");
  writeFileSync(join(b.dir, "receipt.json"), readFileSync(join(x.dir, "receipt.json")));
  await refused(b);
});

test("V9: a receipt naming another run, or bound to a different log, is refused even when its hash and signature are intact", async () => {
  const p = crashedVerified(), f = join(p.dir, "receipt.json"), r = JSON.parse(readFileSync(f, "utf8"));
  const resign = (body: Record<string, unknown>): void => { const { receipt_sha256: _h, verification: _v, ...rest } = body; const hash = receiptSha256(rest as never); writeFileSync(f, JSON.stringify({ ...rest, receipt_sha256: hash, verification: signReceipt(String(rest["run_id"]), hash) })); const ls = readFileSync(p.ev, "utf8").trim().split("\n").map((l) => { const e = JSON.parse(l); if (e.type === "receipt.sealed") e.data.receipt_sha256 = hash; return JSON.stringify(e); }); writeFileSync(p.ev, ls.join("\n") + "\n"); };
  resign({ ...r, run_id: "e10-other" }); await refused(p);
  resign({ ...r, events_sha256: "2".repeat(64) }); await refused(p);
  resign(r); expect(await resumeIn(p.repo, p.runPr)).toBe(0); // control: the same receipt, honestly bound, resumes
});

test("V10: a crashed run's receipt edited and re-hashed under a stale JWT, with the log updated to match, is refused", async () => {
  const p = crashedVerified(), f = join(p.dir, "receipt.json"), r = JSON.parse(readFileSync(f, "utf8"));
  const { receipt_sha256: _h, ...rest } = { ...r, verdict: "FAILED", not_proven: ["edited"] }, hash = receiptSha256(rest as never);
  writeFileSync(f, JSON.stringify({ ...rest, receipt_sha256: hash }));
  writeFileSync(p.ev, readFileSync(p.ev, "utf8").trim().split("\n").map((l) => { const e = JSON.parse(l); if (e.type === "receipt.sealed") e.data.receipt_sha256 = hash; return JSON.stringify(e); }).join("\n") + "\n");
  await refused(p);
});

test("M8: an unsigned receipt while a signing key exists is refused", async () => {
  const p = crashedVerified(), f = join(p.dir, "receipt.json"), r = JSON.parse(readFileSync(f, "utf8")), { receipt_sha256: _h, verification: _v, ...rest } = r, hash = receiptSha256(rest as never);
  writeFileSync(f, JSON.stringify({ ...rest, receipt_sha256: hash }));
  writeFileSync(p.ev, readFileSync(p.ev, "utf8").trim().split("\n").map((l) => { const e = JSON.parse(l); if (e.type === "receipt.sealed") e.data.receipt_sha256 = hash; return JSON.stringify(e); }).join("\n") + "\n");
  await refused(p);
});

test("M5: a receipt whose hash field is stale, or whose receipt.sealed line names another hash, is refused", async () => {
  const p = crashedVerified(), f = join(p.dir, "receipt.json"), good = readFileSync(f, "utf8");
  writeFileSync(f, good.replace('"not_proven": [\n    "real gap"\n  ]', '"not_proven": []')); expect(readFileSync(f, "utf8")).not.toBe(good); await refused(p);
  writeFileSync(f, good);
  const q = crashedVerified(), lines = readFileSync(q.ev, "utf8").trim().split("\n").map((l) => { const e = JSON.parse(l); if (e.type === "receipt.sealed") e.data.receipt_sha256 = "f".repeat(64); return JSON.stringify(e); });
  writeFileSync(q.ev, lines.join("\n") + "\n"); await refused(q);
});

test("a cancelled publish run whose final log.sealed was removed is refused", async () => {
  const p = failedRun(), lines = readFileSync(p.ev, "utf8").trim().split("\n");
  writeFileSync(p.ev, lines.slice(0, -1).join("\n") + "\n");
  await refused(p);
});

test("the refusal names its real reason, not only 'no interrupted run'", () => {
  const p = publishRepo("FAILED", true), msgs: string[] = [];
  writeFileSync(p.ev, readFileSync(p.ev, "utf8").trim().split("\n").slice(0, -1).join("\n") + "\n");
  const why: { reason?: string } = {}; expect(findInterrupted(p.repo, p.id, true, why)).toBeNull(); msgs.push(why.reason ?? "");
  expect(msgs[0]).toContain("the seal was removed");
  const q = publishRepo("FAILED", true), ls = readFileSync(q.ev, "utf8").trim().split("\n"), w2: { reason?: string } = {};
  writeFileSync(q.ev, ls.map((l) => l.replace('"cancelled":true', '"cancelled":true,"x":1')).join("\n") + "\n");
  expect(findInterrupted(q.repo, q.id, true, w2)).toBeNull(); expect(w2.reason).toContain("LOKI_RECEIPT_RETIRED_PUBKEYS");
});

test("a second honest cancel seal on a publish resume still resumes, FAILED", async () => {
  const p = publishRepo("FAILED", true);
  const l = new SupervisorLog(p.ev, p.id); l.append("run.resumed", null, { phase: "publish", receipt_reused: true }); l.append("run.completed", null, { verdict: "FAILED", cancelled: true, signal: "SIGTERM", outcome: "CANCELLED" }); l.sealLog();
  expect(await resumeCancelledDirect(p.repo, p.runPr)).toBe(0);
  expect(p.calls).toEqual([{ verdict: "FAILED" }]);
});

// Direct resumePublish calls bypass findInterrupted, so each guard in the receipt facts is exercised on its own.
const direct = async (p: ReturnType<typeof publishRepo>, events = readEvents(p.ev)): Promise<number> => resumePublish(p.repo, { runId: p.id, phase: "publish", events, task: "t" }, { runPr: p.runPr, out: () => {} });

test("M5: a stale receipt_sha256 field is refused even when the log line and a fresh signature agree on the new hash", async () => {
  const p = crashedVerified(), f = join(p.dir, "receipt.json"), r = JSON.parse(readFileSync(f, "utf8")), { receipt_sha256: _h, verification: _v, ...rest } = { ...r, not_proven: [] }, hash = receiptSha256(rest as never);
  writeFileSync(f, JSON.stringify({ ...rest, receipt_sha256: "e".repeat(64), verification: signReceipt(p.id, hash) }));
  writeFileSync(p.ev, readFileSync(p.ev, "utf8").trim().split("\n").map((l) => { const e = JSON.parse(l); if (e.type === "receipt.sealed") e.data.receipt_sha256 = hash; return JSON.stringify(e); }).join("\n") + "\n");
  expect(await direct(p)).not.toBe(0); expect(p.calls).toEqual([]);
});

test("V6: an event from another run inside this run's log is refused by the receipt facts themselves", async () => {
  const p = crashedVerified(), evs = readEvents(p.ev);
  expect(await direct(p, [...evs, { ...evs[0]!, type: "stage.started", seq: evs.length, run: "e10-other" }])).toBe(5); expect(p.calls).toEqual([]);
  expect(await direct(p)).toBe(0); // control
});

test("V6: a receipt.json symlink to an honest copy of this run's own receipt is refused", async () => {
  const p = crashedVerified(), f = join(p.dir, "receipt.json"), copy = join(p.repo, "receipt-copy.json");
  writeFileSync(copy, readFileSync(f)); rmSync(f); symlinkSync(copy, f);
  expect(await direct(p)).toBe(5); expect(p.calls).toEqual([]);
});

test("a cancel run.completed with its log.sealed removed is refused by the receipt facts themselves", async () => {
  const p = failedRun(), evs = readEvents(p.ev);
  expect(await direct(p, evs.slice(0, -1))).toBe(5); expect(p.calls).toEqual([]);
  expect(phaseOf(evs.slice(0, -1).filter((e) => !isCancelDone(e)))).toBe("publish");
});

// SB-04c: a commit added to loki/<id> after the seal is never published, and refusal text never carries terminal escapes.
const resumeOut = async (p: ReturnType<typeof publishRepo>, events = readEvents(p.ev)): Promise<{ rc: number; text: string }> => {
  let text = ""; const rc = await resumePublish(p.repo, { runId: p.id, phase: "publish", events, task: "t" }, { runPr: p.runPr, out: (s) => { text += s; } });
  return { rc, text };
};
const onBranch = (p: ReturnType<typeof publishRepo>, msg: string, ...extra: string[]): void => { tgit(p.repo, "checkout", "-q", `loki/${p.id}`); tgit(p.repo, "commit", "-q", "--allow-empty", "-m", msg, ...extra); };
const WALL = "test('w', () => {});\n";
/** A child commit that writes the given files (path -> content) and carries the Wall trailer for `id`. */
const wallCommit = (p: ReturnType<typeof publishRepo>, id: string, files: Record<string, string>): void => {
  tgit(p.repo, "checkout", "-q", `loki/${p.id}`);
  for (const [f, c] of Object.entries(files)) { writeFileSync(join(p.repo, f), c); tgit(p.repo, "add", f); }
  tgit(p.repo, "commit", "-q", "-m", "wall", "-m", `Loki-Wall-Publish: ${id}`);
};

test("a commit added to the run branch after the seal is refused, not pushed", async () => {
  const p = publishRepo("VERIFIED");
  onBranch(p, "added after the seal");
  const r = await resumeOut(p);
  expect(r.rc).toBe(5); expect(r.text).toContain("added after the seal"); expect(p.calls).toEqual([]);
});

test("a child commit is accepted only as exactly one Wall commit naming this run", async () => {
  const ok = publishRepo("VERIFIED", true, "VERIFIED", WALL); wallCommit(ok, ok.id, { "wall_test.ts": WALL });
  expect((await resumeOut(ok)).rc).toBe(0); // control: one child, trailer names this run, only the sealed Wall file
  const other = publishRepo("VERIFIED", true, "VERIFIED", WALL); wallCommit(other, "e10-someone-else", { "wall_test.ts": WALL });
  expect((await resumeOut(other)).rc).toBe(5); expect(other.calls).toEqual([]);
  const two = publishRepo("VERIFIED", true, "VERIFIED", WALL); wallCommit(two, two.id, { "wall_test.ts": WALL }); onBranch(two, "again", "-m", `Loki-Wall-Publish: ${two.id}`);
  expect((await resumeOut(two)).rc).toBe(5); expect(two.calls).toEqual([]);
});

test("a child with the right trailer that also adds a non-Wall file, or rewrites a Wall file, is refused", async () => {
  const extra = publishRepo("VERIFIED", true, "VERIFIED", WALL); wallCommit(extra, extra.id, { "wall_test.ts": WALL, "backdoor.ts": "x\n" });
  const r1 = await resumeOut(extra); expect(r1.rc).toBe(5); expect(r1.text).toContain("added after the seal"); expect(extra.calls).toEqual([]);
  const rewrite = publishRepo("VERIFIED", true, "VERIFIED", WALL); wallCommit(rewrite, rewrite.id, { "wall_test.ts": "test('w', () => { evil(); });\n" });
  expect((await resumeOut(rewrite)).rc).toBe(5); expect(rewrite.calls).toEqual([]);
});

test("an event run value carrying an escape sequence never reaches the refusal text", async () => {
  const p = publishRepo("VERIFIED", false), evs = readEvents(p.ev);
  const r = await resumeOut(p, [...evs, { ...evs[0]!, type: "stage.started", seq: evs.length, run: "e10-\x1b[31mred\x07" }]);
  expect(r.rc).toBe(5); expect(r.text).toContain("e10-");
  expect(r.text).not.toContain("\x1b"); expect(r.text).not.toContain("\x07");
  const q = publishRepo("VERIFIED", true), qe = readEvents(q.ev); // the event type is echoed after a cancel seal
  const t = await resumeOut(q, [...qe, { ...qe[0]!, type: "x\x1b]0;pwned\x07y", seq: qe.length }]);
  expect(t.rc).toBe(5); expect(t.text).toContain("after its cancel seal");
  expect(t.text).not.toContain("\x1b"); expect(t.text).not.toContain("\x07");
});

test("C1, bidi, zero-width and OSC 8 characters in a forged run value never reach the refusal text", async () => {
  const p = publishRepo("VERIFIED", false), evs = readEvents(p.ev);
  const forged = "e10-\u009b31mA\u202eB\u2066C\u200bD\u2028E\ufeffF\u061cG\u2061H\u206aI\u180eJ\x1b]8;;https://evil.example/x\x07link\x1b]8;;\x07";
  const r = await resumeOut(p, [...evs, { ...evs[0]!, type: "stage.started", seq: evs.length, run: forged }]);
  expect(r.rc).toBe(5); expect(r.text).toContain("e10-");
  for (const c of ["\u009b", "\u202e", "\u2066", "\u200b", "\u2028", "\ufeff", "\u061c", "\u2061", "\u206a", "\u180e", "\x1b", "\x07"]) expect(r.text).not.toContain(c);
  const long = publishRepo("VERIFIED", false), le = readEvents(long.ev);
  const t = await resumeOut(long, [...le, { ...le[0]!, type: "stage.started", seq: le.length, run: "e10-" + "z".repeat(5000) }]);
  expect(t.text.length).toBeLessThan(1500);
});

// The supervisor's checkpoint: a signed log.sealed right after receipt.sealed plus a signed run.state.json, so a cut log tail cannot hide a tamper or forge what a publish resume trusts.
const supEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true", LOKI_CONTROL: "0" });
/** A real supervised run whose worker emits receipt.sealed for a signed VERIFIED receipt; `before` runs in the worker before that line, `after` 700ms later. */
async function supervised(after: string, before = ""): Promise<{ repo: string; dir: string; ev: string; id: string; ck: number; calls: { verdict: unknown }[]; runPr: RunPrFn }> {
  const id = `e10-d${n++}`, repo = mkdtempSync(join(root, "dur-")), dir = join(repo, ".loki", "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: repo }); tgit(repo, "commit", "-q", "--allow-empty", "-m", "b");
  const pre = new SupervisorLog(ev, id); pre.append("run.started", null, { provider: "claude" }); pre.append("stage.completed", "intake", { base_sha: "a".repeat(40), task: "t" });
  const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", head_sha: tgit(repo, "rev-parse", "HEAD"), not_proven: [], events_sha256: sha(readFileSync(ev)), time: { wall_s: 0, stages: {} }, log_seal: true, checks: [] }, hash = receiptSha256(body as never);
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signReceipt(id, hash) }, null, 2));
  const code = `const fs = require("fs"), ev = ${JSON.stringify(ev)}; ${before} console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { receipt_sha256: ${JSON.stringify(hash)}, verdict: "VERIFIED", not_proven: [] } })); setTimeout(() => { ${after} }, 700);`;
  await runSupervisor({ runId: id, repoDir: repo, env: supEnv(), workerArgv: [process.execPath, "-e", code], capS: 30 });
  const evs = readEvents(ev), sealedAt = evs.findIndex((e) => e.type === "receipt.sealed"), ck = evs.findIndex((e, i) => i > sealedAt && e.type === "log.sealed");
  const calls: { verdict: unknown }[] = [];
  return { repo, dir, ev, id, ck, calls, runPr: async (c) => { calls.push({ verdict: ((c as { outputs: () => { seal: { verdict: unknown } } }).outputs()).seal.verdict }); return { status: "completed", data: { pr_url: "https://github.com/o/r/pull/9", draft: false, existing: null } }; } };
}
const cutTo = (ev: string, keep: (l: string, i: number) => boolean): void => writeFileSync(ev, readFileSync(ev, "utf8").split("\n").filter((l) => l !== "").filter(keep).join("\n") + "\n");
const cutAfterType = (ev: string, type: string): void => { const l = readFileSync(ev, "utf8").trim().split("\n"); writeFileSync(ev, l.slice(0, l.findIndex((x) => JSON.parse(x).type === type) + 1).join("\n") + "\n"); };
const state = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, "run.state.json"), "utf8"));
const appendJunk = `fs.appendFileSync(ev, "not json\\n");`, preTamper = `fs.writeFileSync(ev, fs.readFileSync(ev, "utf8").replace('"task":"t"', '"task":"u"'));`;

test("CK: the supervisor signs a checkpoint right after receipt.sealed and records the run in run.state.json", async () => {
  const p = await supervised("void 0;"), evs = readEvents(p.ev), at = evs.findIndex((e) => e.type === "receipt.sealed");
  expect(at).toBeGreaterThan(0);
  expect(p.ck).toBe(at + 1); expect(evs[p.ck]!.data["tampered"]).toBe(false);
  expect(state(p.dir)).toMatchObject({ run_id: p.id, state: "closed", tampered: false, receipt_sha256: evs[at]!.data["receipt_sha256"] });
});

test("CK: a tamper present when the receipt is sealed is in the checkpoint itself and in the closed record", async () => {
  const p = await supervised("void 0;", preTamper), evs = readEvents(p.ev);
  expect(evs.findIndex((e) => e.type === "tamper.detected")).toBeGreaterThan(-1);
  expect(evs.findIndex((e) => e.type === "tamper.detected")).toBeLessThan(p.ck);
  expect(evs[p.ck]!.data["tampered"]).toBe(true); expect(state(p.dir)).toMatchObject({ state: "closed", tampered: true });
});

test("A1: a tampered VERIFIED run with its log cut right after receipt.sealed, or back to the checkpoint, is refused", async () => {
  const p = await supervised("void 0;", preTamper);
  cutAfterType(p.ev, "receipt.sealed"); // drops tamper.detected, the checkpoint, run.completed and the final seal
  expect(await resumeIn(p.repo, p.runPr)).toBe(5); expect(p.calls).toEqual([]);
  const q = await supervised(appendJunk); // the tamper is seen after the checkpoint
  expect(readFileSync(q.ev, "utf8")).toContain("tamper.detected");
  cutTo(q.ev, (_l, i) => i <= q.ck);
  expect(verifyLogSeals(readFileSync(q.ev, "utf8"), readEvents(q.ev), { sealLast: true })).toBeNull(); // the log alone looks clean
  expect(await resumeIn(q.repo, q.runPr)).toBe(5); expect(q.calls).toEqual([]);
  expect(state(q.dir)["tampered"]).toBe(true);
});

test("A1: a finished honest run cut back to its checkpoint is not resumable, and neither is a copied open record", async () => {
  const p = await supervised("void 0;"); cutTo(p.ev, (_l, i) => i <= p.ck);
  expect(await resumeIn(p.repo, p.runPr)).toBe(5); expect(p.calls).toEqual([]);
  const copy = `fs.copyFileSync(ev.replace(/events\\.jsonl$/, "run.state.json"), ev.replace(/events\\.jsonl$/, "state.snap"));`;
  const q = await supervised(copy + appendJunk);
  writeFileSync(join(q.dir, "run.state.json"), readFileSync(join(q.dir, "state.snap"))); cutTo(q.ev, (_l, i) => i <= q.ck);
  expect(await resumeIn(q.repo, q.runPr)).toBe(5); expect(q.calls).toEqual([]);
});

test("A2: an honest cancelled run with its cancel pair and checkpoint cut and a forged verify appended is refused", async () => {
  const c = publishRepo("VERIFIED");
  expect(await resumeIn(c.repo, c.runPr)).toBe(0); // control: the honest cancelled run resumes
  const p = publishRepo("VERIFIED");
  cutAfterType(p.ev, "receipt.sealed"); new SupervisorLog(p.ev, p.id).append("stage.completed", "verify", { forged: true });
  expect(await resumeIn(p.repo, p.runPr)).toBe(5); expect(p.calls).toEqual([]);
  const q = publishRepo("VERIFIED", true), seen: unknown[] = [];
  cutTo(q.ev, (l) => !/"type":"run.completed"/.test(l)); const kept = readFileSync(q.ev, "utf8").trim().split("\n"); writeFileSync(q.ev, kept.slice(0, -1).join("\n") + "\n"); // the checkpoint survives, the cancel pair does not
  new SupervisorLog(q.ev, q.id).append("stage.completed", "verify", { forged: true });
  const rc = await direct({ ...q, runPr: async (cx) => { seen.push((cx as { outputs: () => unknown }).outputs()); return { status: "completed", data: { pr_url: "https://github.com/o/r/pull/9", draft: false, existing: null } }; } });
  expect(rc).toBe(0); expect(seen).toHaveLength(1); // the record still says CANCELLED, so the publish runs on the receipt
  expect(JSON.stringify(seen)).not.toContain("forged"); // nothing past the signed checkpoint reaches the outputs
});

test("A4: a tampered cancelled run is refused as written and with its cancel pair cut", async () => {
  const mk = (): ReturnType<typeof publishRepo> => { const p = publishRepo("VERIFIED", false); const s = new SupervisorLog(p.ev, p.id); s.receiptSha = JSON.parse(readFileSync(join(p.dir, "receipt.json"), "utf8")).receipt_sha256; s.tampered = true; s.append("tamper.detected", null, {}); s.append("run.completed", null, { verdict: "FAILED", cancelled: true, signal: "SIGTERM", outcome: "CANCELLED" }); s.sealLog(); s.state("closed", "CANCELLED"); return p; };
  const p = mk(); expect(state(p.dir)).toMatchObject({ state: "closed", tampered: true });
  await refused(p);
  const q = mk(); cutAfterType(q.ev, "receipt.sealed"); await refused(q);
  const r = publishRepo("VERIFIED"); expect(await resumeIn(r.repo, r.runPr)).toBe(0); // control: the same run untampered resumes
});

test("run.state.json deleted, unsigned, from another run, or edited is refused; the honest closed CANCELLED record resumes", async () => {
  const honest = crashedVerified(), f = join(honest.dir, "run.state.json");
  expect(await resumeIn(honest.repo, honest.runPr)).toBe(0); // control
  const gone = crashedVerified(); rmSync(join(gone.dir, "run.state.json")); await refused(gone);
  const unsigned = crashedVerified(), rec = state(unsigned.dir); delete rec["signed"]; writeFileSync(join(unsigned.dir, "run.state.json"), JSON.stringify(rec)); await refused(unsigned);
  const other = crashedVerified(); writeFileSync(join(other.dir, "run.state.json"), readFileSync(f)); await refused(other);
  const edited = crashedVerified(), er = state(edited.dir); er["outcome"] = "VERIFIED"; writeFileSync(join(edited.dir, "run.state.json"), JSON.stringify(er)); await refused(edited);
});

/** A real runSupervisor run whose worker snapshots events.jsonl and run.state.json 700ms after receipt.sealed; restoring the snapshot models the supervisor being killed in the publish phase. */
async function supervisedCrash(): Promise<ReturnType<typeof publishRepo>> {
  const id = `e10-r3-${n++}`, repo = mkdtempSync(join(root, "sup-")), dir = join(repo, ".loki", "runs", id), ev = join(dir, "events.jsonl"); mkdirSync(dir, { recursive: true });
  const g = (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: repo });
  g("commit", "-q", "--allow-empty", "-m", "b"); g("branch", `loki/${id}`);
  const head = g("rev-parse", "HEAD"), pre = new SupervisorLog(ev, id);
  pre.append("run.started", null, { provider: "claude" }); pre.append("stage.completed", "intake", { base_sha: head, task: "t" });
  const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", head_sha: head, not_proven: [], events_sha256: sha(readFileSync(ev)), time: { wall_s: 0, stages: {} }, log_seal: true, checks: [] };
  const hash = receiptSha256(body as never);
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signReceipt(id, hash) }, null, 2));
  const sealed = JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { receipt_sha256: hash, verdict: "VERIFIED", not_proven: [] } });
  const snap = `const fs = require("fs"); fs.copyFileSync(${JSON.stringify(ev)}, ${JSON.stringify(ev + ".snap")}); fs.copyFileSync(${JSON.stringify(join(dir, "run.state.json"))}, ${JSON.stringify(join(dir, "st.snap"))});`;
  const code = `console.log(${JSON.stringify(sealed)}); setTimeout(() => { ${snap} }, 700);`;
  await runSupervisor({ runId: id, repoDir: repo, env: { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true", LOKI_CONTROL: "0" }, workerArgv: [process.execPath, "-e", code], capS: 30 } as never);
  writeFileSync(ev, readFileSync(ev + ".snap")); writeFileSync(join(dir, "run.state.json"), readFileSync(join(dir, "st.snap")));
  const calls: unknown[] = [];
  return { repo, dir, ev, id, calls, runPr: async (c) => { calls.push((c as { outputs: () => unknown }).outputs()); return { status: "completed", data: { pr_url: "https://github.com/o/r/pull/9", draft: false, existing: null } }; } } as ReturnType<typeof publishRepo>;
}

test("SB-04 r3: a real runSupervisor killed in the publish phase is offered by startRecovery and resumed by resumeMain, publishing once on the signed checkpoint", async () => {
  const a = await supervisedCrash();
  expect(types(a.ev)).toBe("run.started,stage.completed,run.started,capability.recorded,receipt.sealed,log.sealed"); // the shape the writer leaves
  expect(state(a.dir)).toMatchObject({ state: "open" });
  const cwd = process.cwd(); process.chdir(a.repo);
  try {
    expect(await startRecovery(a.repo, "t", false, { runPr: a.runPr, out: () => {}, tty: false })).toBe(0);
  } finally { process.chdir(cwd); }
  expect(a.calls).toHaveLength(1);
  const b = await supervisedCrash();
  expect(await resumeIn(b.repo, b.runPr)).toBe(0);
  expect(b.calls).toHaveLength(1);
  const c = await supervisedCrash(), l = readFileSync(c.ev, "utf8").trim().split("\n");
  writeFileSync(c.ev, l.slice(0, -1).join("\n") + "\n"); // the checkpoint cut: no signed boundary, so the same crash is refused
  expect(await resumeIn(c.repo, c.runPr)).toBe(5); expect(c.calls).toEqual([]);
}, 120000);
