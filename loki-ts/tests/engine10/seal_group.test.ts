// D61-13: one Seal and a combined receipt with a per-unit sub-receipt, bound by hash.
// Wall check: verify passes on the combined receipt; tampering one unit's events fails it.
// The only spawn is git through the sh helper, which passes an explicit env.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sealedLog } from "./log_fixture.ts";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { commitStage, loadSigningKey, receiptSha256, sealStage, sha256, signReceipt } from "../../src/engine10/stages/seal.ts";
import { computeReceiptHash, main as verifyMain, verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { unitSpecReceiptBlock } from "../../src/features/speed/unit_mode.ts";
import { readSliceJournal, sliceKey, writeSliceJournal, repoCacheDir, repoKey } from "../../src/engine10/cache.ts";
import { runGroup } from "../../src/features/speed/run_group.ts";
import type { Dag } from "../../src/features/decompose.ts";
import { capGroupVerdict, sealGroup } from "../../src/features/speed/seal_group.ts";
import { collectToolchain, composeComposite, compositeHash } from "../../src/util/composite_seal.ts";
import type { EventType, Receipt, RunContext, StageName, Verdict } from "../../src/engine10/types.ts";

let root = "";
const PRE_KEY_FILE = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];

function sh(argv: string[], cwd: string): string {
  const p = Bun.spawnSync({ cmd: argv, cwd, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} -> ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function makeRepo(name: string): { repo: string; base: string } {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  sh(["git", "init", "-q", "-b", "main"], repo);
  sh(["git", "config", "user.name", "seal-test"], repo);
  sh(["git", "config", "user.email", "seal@test.invalid"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(["git", "add", "a.txt"], repo);
  sh(["git", "commit", "-q", "-m", "base"], repo);
  const base = sh(["git", "rev-parse", "HEAD"], repo).trim();
  writeFileSync(join(repo, "a.txt"), "two\n");
  mkdirSync(join(repo, ".loki/runs/r1"), { recursive: true });
  writeFileSync(join(repo, ".loki/runs/r1/events.jsonl"), JSON.stringify({ v: 1, seq: 0, ts: "2026-01-01T00:00:00.000Z", run: "r1", type: "run.started", stage: null, data: {} }) + "\n");
  return { repo, base };
}

function ctxFor(repo: string, base: string, intake: Record<string, unknown> = {}): RunContext {
  const outputs: Partial<Record<StageName, Record<string, unknown>>> = {
    intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "group task", resumed: false, ...intake },
    wall: { files: [] },
    implement: { exit: "done", tests_reverted: [], duration_s: 3, iteration_id: "e10-r1-impl" },
    verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1.5 }], flaky: [], wall_passed: true, duration_s: 2 },
  };
  return {
    runId: "r1", repoDir: repo, runDir: join(repo, ".loki/runs/r1"), baseSha: base, branch: "loki/r1",
    provider: "claude", model: "m", deep: false, capS: 900,
    emit: (_t: EventType, _s: StageName | null, _d: Record<string, unknown>) => {},
    sessions: { run: async () => { throw new Error("no sessions in seal"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: 0.5, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }) },
    clock: { now: () => 0 },
    outputs: () => outputs,
  } as unknown as RunContext;
}

interface U { id: string; verdict?: string; unsigned?: boolean }
/** Writes group/manifest.json and one signed (unless u.unsigned) sub-receipt plus events per unit under runDir. */
function writeGroup(runDir: string, units: U[]): void {
  const g = join(runDir, "group");
  mkdirSync(join(g, "units"), { recursive: true });
  const manifest = { group_id: "g1", units: units.map((u) => ({ unit_id: u.id, goal: `goal ${u.id}`, files: [`${u.id}.txt`], tests: 2, tokens: 100, model: "sonnet" })) };
  writeFileSync(join(g, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const u of units) {
    const d = join(g, "units", u.id);
    mkdirSync(d, { recursive: true });
    const events = JSON.stringify({ v: 1, seq: 0, ts: "2026-01-01T00:00:00.000Z", run: u.id, type: "run.started", stage: null, data: { group_id: "g1", unit_id: u.id } }) + "\n";
    writeFileSync(join(d, "events.jsonl"), events);
    const body = { schema: "loki.v10.receipt/1", run_id: u.id, verdict: u.verdict ?? "VERIFIED", head_sha: "h".repeat(40), events_sha256: sha256(events), time: { wall_s: 0, stages: {} }, not_proven: [] };
    const h = receiptSha256(body as never), sig = u.unsigned ? { jwt: null, kid: null } : signReceipt(u.id, h);
    writeFileSync(join(d, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: h, verification: sig }, null, 2) + "\n");
  }
}

async function sealGroupRun(name: string, units: U[], intake: Record<string, unknown> = {}): Promise<{ path: string; receipt: Receipt; runDir: string }> {
  const { repo, base } = makeRepo(name);
  const ctx = ctxFor(repo, base, intake);
  writeGroup(ctx.runDir, units);
  await commitStage.run(ctx, new AbortController().signal);
  const s = await sealStage.run(ctx, new AbortController().signal);
  const path = s.data["receipt_path"] as string;
  const receipt = JSON.parse(readFileSync(path, "utf8")) as Receipt;
  sealedLog(dirname(path), receipt.receipt_sha256);
  return { path, receipt, runDir: ctx.runDir };
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "loki-seal-group.")); });
beforeEach(() => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "nokey", "k.pem"); });
afterEach(() => {
  if (PRE_KEY_FILE === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = PRE_KEY_FILE;
  delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const U3: U[] = [{ id: "u1" }, { id: "u2" }, { id: "u3" }];
const rewrite = (p: string, f: (r: Record<string, unknown>) => void, rehash: boolean): void => {
  const r = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  f(r);
  if (rehash) r["receipt_sha256"] = receiptSha256(r as never);
  writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
};

describe("D61-13 group seal and verify", () => {
  test("one Seal binds every unit by hash and verify passes on the combined receipt", async () => {
    const { path, receipt, runDir } = await sealGroupRun("ok", U3);
    expect(receipt.verdict).toBe("VERIFIED");
    const g = (receipt as unknown as { group: { group_id: string; units: Record<string, unknown>[] } }).group;
    expect(g.group_id).toBe("g1");
    expect(g.units.map((u) => u["unit_id"])).toEqual(["u1", "u2", "u3"]);
    for (const u of g.units) {
      expect(u["sub_receipt_sha256"]).toBe(sha256(readFileSync(join(runDir, "group/units", String(u["unit_id"]), "receipt.json"))));
      expect(u["events_file_sha256"]).toBe(sha256(readFileSync(join(runDir, "group/units", String(u["unit_id"]), "events.jsonl"))));
      expect(u["verdict"]).toBe("VERIFIED");
    }
    expect(receipt.verification.jwt).not.toBeNull();
    const v = await verifyReceipt(path);
    expect(v.reasons).toEqual([]);
    expect(v.verdict).toBe("VERIFIED");
  }, 30000);

  test("tampering one unit's events fails verify", async () => {
    const { path, runDir } = await sealGroupRun("t-events", U3);
    const ev = join(runDir, "group/units/u2/events.jsonl");
    writeFileSync(ev, readFileSync(ev, "utf8").replace("run.started", "run.startee"));
    const v = await verifyReceipt(path);
    expect(v.verdict).toBe("TAMPERED");
    expect(v.reasons.join(" ")).toContain("u2");
  }, 30000);

  test("an appended valid event line (sub prefix hash still matches) and a reformatted sub-receipt each fail verify", async () => {
    const a = await sealGroupRun("t-append", U3);
    const ev = join(a.runDir, "group/units/u2/events.jsonl");
    writeFileSync(ev, readFileSync(ev, "utf8") + JSON.stringify({ v: 1, seq: 1, ts: "2026-01-01T00:00:01.000Z", run: "u2", type: "run.completed", stage: null, data: {} }) + "\n");
    const v = await verifyReceipt(a.path);
    expect(v.verdict).toBe("TAMPERED");
    expect(v.reasons.join(" ")).toContain("events.jsonl does not match");
    const b = await sealGroupRun("t-format", U3);
    const rp = join(b.runDir, "group/units/u3/receipt.json");
    writeFileSync(rp, JSON.stringify(JSON.parse(readFileSync(rp, "utf8"))));
    const w = await verifyReceipt(b.path);
    expect(w.verdict).toBe("TAMPERED");
    expect(w.reasons.join(" ")).toContain("does not match its recorded hash");
  }, 30000);

  test("altered sub-receipt, even with its own hash recomputed, fails verify", async () => {
    const { path, runDir } = await sealGroupRun("t-sub", U3);
    rewrite(join(runDir, "group/units/u1/receipt.json"), (r) => { r["verdict"] = "FAILED"; }, true);
    expect((await verifyReceipt(path)).verdict).toBe("TAMPERED");
  }, 30000);

  test("a missing unit, an extra unit and a removed events file each fail verify", async () => {
    for (const [name, mutate] of [
      ["missing", (d: string) => rmSync(join(d, "group/units/u3"), { recursive: true })],
      ["extra", (d: string) => { mkdirSync(join(d, "group/units/u9")); writeFileSync(join(d, "group/units/u9/receipt.json"), "{}"); }],
      ["noevents", (d: string) => rmSync(join(d, "group/units/u1/events.jsonl"))],
    ] as const) {
      const { path, runDir } = await sealGroupRun(`t-${name}`, U3);
      mutate(runDir);
      expect((await verifyReceipt(path)).verdict).toBe("TAMPERED");
    }
  }, 60000);

  test("reordered units fail verify, signed (hash binds) and re-hashed (index binds)", async () => {
    const { path } = await sealGroupRun("t-order", U3);
    const swap = (r: Record<string, unknown>): void => { const g = r["group"] as { units: unknown[] }; g.units = [g.units[1], g.units[0], g.units[2]]; };
    rewrite(path, swap, false);
    expect((await verifyReceipt(path)).verdict).toBe("TAMPERED");
    // An attacker who re-hashes and strips the signature still cannot reorder: indexes must match positions.
    rewrite(path, (r) => { r["verification"] = { jwt: null, kid: null }; }, true);
    const v = await verifyReceipt(path);
    expect(v.verdict).toBe("TAMPERED");
  }, 30000);

  test("stripping the group section from a receipt whose group dir exists fails verify", async () => {
    const { path } = await sealGroupRun("t-strip", U3);
    rewrite(path, (r) => { delete r["group"]; r["verification"] = { jwt: null, kid: null }; }, true);
    expect((await verifyReceipt(path)).verdict).toBe("TAMPERED");
  }, 30000);

  test("a unit that is not VERIFIED caps the combined verdict below VERIFIED", async () => {
    const { receipt } = await sealGroupRun("cap", [{ id: "u1" }, { id: "u2", verdict: "PARTIAL" }]);
    expect(receipt.verdict).toBe("PARTIAL");
    expect(receipt.not_proven.some((n) => n.includes("u2"))).toBe(true);
  }, 30000);

  test("an already-satisfied intake with a failed unit seals PARTIAL and loki verify exits non-zero (B1)", async () => {
    const { path, receipt } = await sealGroupRun("b1", [{ id: "u1" }, { id: "u2", verdict: "FAILED" }], { already_satisfied: true });
    expect(receipt.verdict).toBe("PARTIAL");
    const pub = join(root, "b1.pub.pem");
    writeFileSync(pub, createPublicKey(loadSigningKey(false)!).export({ type: "spki", format: "pem" }));
    expect(await verifyMain(["--pubkey", pub, path])).toBe(4); // intact receipt, run outcome not verified
  }, 30000);

  test("a signed combined receipt over an unsigned sub-receipt is UNCHECKED, never VERIFIED", async () => {
    const { path } = await sealGroupRun("unsigned-sub", [{ id: "u1" }, { id: "u2", unsigned: true }]);
    const v = await verifyReceipt(path);
    expect(v.verdict).toBe("UNCHECKED");
    expect(v.reasons.join(" ")).toContain("u2");
  }, 30000);

  test("case-colliding unit ids fail seal; dotfiles in group/units are ignored; a bare group dir is inert", async () => {
    const { repo, base } = makeRepo("case");
    const ctx = ctxFor(repo, base);
    writeGroup(ctx.runDir, [{ id: "Ab" }, { id: "ab" }]);
    expect(sealGroup(ctx.runDir, receiptSha256 as never).problems).toBeGreaterThan(0);
    const ok = await sealGroupRun("dot", U3);
    writeFileSync(join(ok.runDir, "group/units/.DS_Store"), "x");
    expect((await verifyReceipt(ok.path)).verdict).toBe("VERIFIED");
    const bare = makeRepo("bare");
    const bctx = ctxFor(bare.repo, bare.base);
    mkdirSync(join(bctx.runDir, "group"), { recursive: true });
    expect(sealGroup(bctx.runDir, receiptSha256 as never).section).toBeUndefined();
    expect(sealGroup(bctx.runDir, receiptSha256 as never).problems).toBe(0);
  }, 60000);

  test("B2: a forged combined receipt over an unsigned sub-receipt reads TAMPERED, not UNCHECKED", async () => {
    const { path } = await sealGroupRun("forge-comb", [{ id: "u1" }, { id: "u2", verdict: "FAILED", unsigned: true }]);
    rewrite(path, (r) => { r["verdict"] = "VERIFIED"; }, true);
    const v = await verifyReceipt(path);
    expect(v.verdict).toBe("TAMPERED");
  }, 60000);

  test("B2: a forged single-run receipt with an injected group section reads TAMPERED", async () => {
    const { repo, base } = makeRepo("forge-single");
    const ctx = ctxFor(repo, base);
    ctx.outputs().verify!["checks"] = [{ name: "pytest", cmd: "pytest -q", result: "fail", duration_s: 1 }];
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    const path = s.data["receipt_path"] as string;
    sealedLog(dirname(path), (JSON.parse(readFileSync(path, "utf8")) as Receipt).receipt_sha256);
    rewrite(path, (r) => { r["verdict"] = "VERIFIED"; }, true);
    const ud = join(ctx.runDir, "group/units/x");
    mkdirSync(ud, { recursive: true });
    const body = { schema: "loki.v10.receipt/1", run_id: "x", verdict: "VERIFIED", head_sha: "h".repeat(40), events_sha256: sha256(""), time: { wall_s: 0, stages: {} }, not_proven: [] };
    const h = receiptSha256(body as never), subTxt = JSON.stringify({ ...body, receipt_sha256: h, verification: { jwt: null, kid: null } });
    writeFileSync(join(ud, "receipt.json"), subTxt);
    rewrite(path, (r) => { r["group"] = { group_id: "g", units: [{ index: 0, unit_id: "x", sub_receipt_sha256: sha256(subTxt), receipt_sha256: h, events_file_sha256: null, verdict: "VERIFIED" }] }; }, true);
    expect((await verifyReceipt(path)).verdict).toBe("TAMPERED");
  }, 60000);

  test("deps pass-through: sub-receipts verify with --pubkey when no local signing key exists", async () => {
    const { path } = await sealGroupRun("deps", U3);
    const pub = join(root, "deps.pub.pem");
    writeFileSync(pub, createPublicKey(loadSigningKey(false)!).export({ type: "spki", format: "pem" }));
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "absent", "nokey.pem");
    expect(await verifyMain(["--pubkey", pub, path])).toBe(0);
  }, 60000);

  test("INTEL-1b B1: a verified signed two-unit group exports as a DSSE envelope (sub-receipts read their own bytes)", async () => {
    const { path } = await sealGroupRun("dsse-group", [{ id: "u1" }, { id: "u2" }]);
    expect((await verifyReceipt(path)).verdict).toBe("VERIFIED");
    let out = "", err = "";
    const w = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((x: string) => ((out += x), true)) as never;
    process.stderr.write = ((x: string) => ((err += x), true)) as never;
    let rc = -1;
    try { rc = await verifyMain([path, "--export-dsse"]); } finally { process.stdout.write = w; process.stderr.write = e; }
    expect(err).toBe("");
    expect(rc).toBe(0);
    const env = JSON.parse(out);
    expect(JSON.parse(Buffer.from(env.payload, "base64").toString()).predicate.receipt_sha256).toBe((JSON.parse(readFileSync(path, "utf8")) as Receipt).receipt_sha256);
    const ep = join(root, "dsse-group.env.json");
    writeFileSync(ep, out);
    expect(await verifyMain([ep])).toBe(0);
  }, 60000);

  test("verify side rejects case-colliding unit ids in the group section", async () => {
    const { path } = await sealGroupRun("case-verify", [{ id: "ab" }, { id: "cd" }]);
    rewrite(path, (r) => { const g = r["group"] as { units: Array<Record<string, unknown>> }; g.units[0]!["unit_id"] = "Cd"; }, true);
    const v = await verifyReceipt(path);
    expect(v.verdict).toBe("TAMPERED");
    expect(v.reasons.join(" ")).toContain("case-colliding");
  }, 60000);

  test("a corrupt sub-receipt at seal time fails closed, never VERIFIED", async () => {
    const { repo, base } = makeRepo("corrupt");
    const ctx = ctxFor(repo, base);
    writeGroup(ctx.runDir, U3);
    writeFileSync(join(ctx.runDir, "group/units/u2/receipt.json"), "not json");
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data["verdict"]).toBe("FAILED");
  }, 30000);

  test("capGroupVerdict only lowers a verdict and never produces VERIFIED from another", () => {
    const ok = { section: undefined, notProven: [], problems: 0, allUnitsPass: true };
    const all: Verdict[] = ["VERIFIED", "PARTIAL", "FAILED", "ALREADY_SATISFIED", "SPEC_CONFLICT"];
    for (const v of all) {
      expect(capGroupVerdict(v, ok)).toBe(v);
      for (const bad of [{ ...ok, problems: 1 }, { ...ok, allUnitsPass: false }]) {
        const out = capGroupVerdict(v, bad);
        expect(out === "VERIFIED").toBe(false);
        if (bad.allUnitsPass === false) expect(["VERIFIED", "ALREADY_SATISFIED"].includes(out)).toBe(false);
        if (v !== "VERIFIED") expect(["PARTIAL", "FAILED"].includes(out) || out === v).toBe(true);
      }
    }
    expect(capGroupVerdict("VERIFIED", { ...ok, allUnitsPass: false })).toBe("PARTIAL");
    expect(capGroupVerdict("VERIFIED", { ...ok, problems: 1 })).toBe("FAILED");
    expect(capGroupVerdict("FAILED", { ...ok, allUnitsPass: false })).toBe("FAILED");
    expect(capGroupVerdict("ALREADY_SATISFIED", { ...ok, allUnitsPass: false })).toBe("PARTIAL");
  });
});

describe("D61-13 single run is unchanged", () => {
  test("no group directory: no group key, inert helper, verify passes", async () => {
    const { repo, base } = makeRepo("single");
    const ctx = ctxFor(repo, base);
    expect(sealGroup(ctx.runDir, receiptSha256 as never)).toEqual({ section: undefined, notProven: [], problems: 0, allUnitsPass: true });
    await commitStage.run(ctx, new AbortController().signal);
    process.env["LOKI_MUTATION_PROOF"] = "0"; // T2: opt-out keeps the receipt key set byte-identical
    const s = await sealStage.run(ctx, new AbortController().signal).finally(() => { delete process.env["LOKI_MUTATION_PROOF"]; });
    const receipt = JSON.parse(readFileSync(s.data["receipt_path"] as string, "utf8")) as Record<string, unknown>;
    expect("group" in receipt).toBe(false);
    expect(Object.keys(receipt).sort()).toEqual(["base_sha", "checks", "cost", "cost_preview", "diff_sha256", "evidence", "events_sha256", "head_sha", "log_seal", "model", "not_proven", "provider", "receipt_sha256", "repo", "resumed", "run_id", "schema", "seal_accuracy", "seeded_corpus", "task", "time", "toolchain", "tree", "verdict", "verification", "wall"].sort());
    sealedLog(ctx.runDir, String(receipt["receipt_sha256"]));
    expect((await verifyReceipt(s.data["receipt_path"] as string)).verdict).toBe("VERIFIED");
    expect(readdirSync(ctx.runDir)).not.toContain("group");
  }, 30000);
  test("TEN-GATES-22: per-run receipt toolchain is recorded, hash-covered, and an old receipt without it still verifies", async () => {
    const { repo, base } = makeRepo("tc22");
    const ctx = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    process.env["LOKI_MUTATION_PROOF"] = "0";
    const s = await sealStage.run(ctx, new AbortController().signal).finally(() => { delete process.env["LOKI_MUTATION_PROOF"]; });
    const p = s.data["receipt_path"] as string;
    const r = JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
    expect(Object.keys(r["toolchain"]).sort()).toEqual(["bun", "git", "node", "python3"]);
    expect(Object.values(r["toolchain"]).every((v) => v === null || typeof v === "string")).toBe(true);
    expect(collectToolchain(() => null).git).toBeNull(); // absent tool is null
    const logPath = join(ctx.runDir, "events.jsonl"), sealTimeLog = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0); // the log as the seal stage bound the receipt to it
    sealedLog(ctx.runDir, String(r["receipt_sha256"]));
    expect((await verifyReceipt(p)).verdict).toBe("VERIFIED");
    // editing the toolchain without re-hashing is caught
    const raw = readFileSync(p, "utf8");
    r["toolchain"]["node"] = "0.0.0-forged";
    writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
    expect((await verifyReceipt(p)).verdict).toBe("TAMPERED");
    // a receipt sealed before the field existed (re-hashed and re-signed without it) still verifies
    delete r["toolchain"];
    r["receipt_sha256"] = receiptSha256(r as never);
    r["verification"] = signReceipt(String(r["run_id"]), r["receipt_sha256"]);
    writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
    writeFileSync(logPath, sealTimeLog); // a second receipt.sealed on one log is TAMPERED, so the re-signed receipt is sealed onto the log it is bound to
    sealedLog(ctx.runDir, String(r["receipt_sha256"]));
    expect((await verifyReceipt(p)).verdict).toBe("VERIFIED");
    expect(raw.length).toBeGreaterThan(0);
  }, 30000);
});

// Composite receipt: one signed artifact over every child repo receipt of a workspace run.
interface C { repo: string; verdict?: string; unsigned?: boolean; head?: string }
const childPath = (runDir: string, repo: string): string => join(runDir, "worktrees", repo, ".loki", "runs", `run-${repo}`, "receipt.json");
/** Writes integration.json plus one child receipt per repo under a fresh workspace run dir. */
function writeWs(name: string, kids: C[], integ: Record<string, unknown> = {}, log?: string): string {
  const runDir = join(root, "ws", name, "20261015T000000Z");
  mkdirSync(runDir, { recursive: true });
  const heads: Record<string, string> = {}, outcomes: Record<string, string> = {};
  for (const k of kids) {
    const head = k.head ?? `${k.repo[0]}`.repeat(40);
    heads[k.repo] = head; outcomes[k.repo] = "ok";
    const body = { schema: "loki.v10.receipt/1", run_id: `run-${k.repo}`, verdict: k.verdict ?? "VERIFIED", head_sha: head, events_sha256: sha256(""), time: { wall_s: 0, stages: {} }, not_proven: [] };
    const h = receiptSha256(body as never), sig = k.unsigned ? { jwt: null, kid: null } : signReceipt(`run-${k.repo}`, h);
    mkdirSync(dirname(childPath(runDir, k.repo)), { recursive: true });
    writeFileSync(childPath(runDir, k.repo), JSON.stringify({ ...body, receipt_sha256: h, verification: sig }, null, 2) + "\n");
  }
  if (log !== undefined) writeFileSync(join(runDir, "integration.log"), log);
  const log_sha256 = log === undefined ? null : sha256(log);
  writeFileSync(join(runDir, "integration.json"), JSON.stringify({ heads, outcomes, status: "passed", exit_code: 0, log_sha256, ...integ }, null, 2));
  return runDir;
}
const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const w = process.stdout.write.bind(process.stdout); process.stdout.write = (() => true) as typeof process.stdout.write; try { return await f(); } finally { process.stdout.write = w; } };
async function seal(runDir: string): Promise<string> {
  expect(await quiet(() => verifyMain(["--seal-composite", runDir]))).toBe(0);
  return join(runDir, "composite.json");
}
const verdictOf = (p: string, deps = {}): Promise<{ verdict: string; reasons: string[] }> => verifyReceipt(p, deps);
/** Re-signs an edited composite so only the semantic check (not the hash or signature) can catch the edit. */
function resign(p: string, f: (c: Record<string, any>) => void): void {
  const c = JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
  f(c);
  c["composite_sha256"] = compositeHash(c);
  c["verification"] = signReceipt(String(c["run_id"]), c["composite_sha256"]);
  writeFileSync(p, JSON.stringify(c));
}

describe("composite receipt", () => {
  const KIDS: C[] = [{ repo: "api" }, { repo: "web" }];
  test("TEN-GATES-19: sealed composite records the toolchain, absent tools are null, tampering is caught", async () => {
    const p = await seal(writeWs("tc", KIDS));
    const c = JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
    expect(Object.keys(c["toolchain"]).sort()).toEqual(["bun", "git", "node", "python3"]);
    // bun stays: process.versions.bun is genuine evidence. node is never taken from bun's Node-compat version.
    const none = collectToolchain(() => null);
    expect(none.node).toBeNull();
    expect(none.python3).toBeNull();
    expect(none.git).toBeNull();
    expect(typeof none.bun).toBe("string");
    const nulls = writeWs("tc-null", KIDS);
    const body = composeComposite(nulls, computeReceiptHash, { bun: null, node: null, python3: null, git: null });
    expect(body.toolchain).toEqual({ bun: null, node: null, python3: null, git: null });
    expect((await verdictOf(p)).verdict).toBe("VERIFIED");
    c["toolchain"]["node"] = "0.0.0";
    writeFileSync(p, JSON.stringify(c));
    expect((await verdictOf(p)).verdict).toBe("TAMPERED");
    resign(p, (x) => { x["toolchain"] = { bun: 1 }; });
    const r = await verdictOf(p);
    expect(r.verdict).toBe("TAMPERED");
    expect(r.reasons.join(" ")).toContain("toolchain");
  });
  test("TEN-GATES-19: a composite sealed before the toolchain field existed still verifies", async () => {
    const p = await seal(writeWs("tc-old", KIDS));
    resign(p, (x) => { delete x["toolchain"]; });
    expect((await verdictOf(p)).verdict).toBe("VERIFIED");
  });
  test("all green: signed composite verifies VERIFIED, exit 0, children in order", async () => {
    const dir = writeWs("green", KIDS);
    const p = await seal(dir);
    const c = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    expect((c["children"] as { repo: string }[]).map((x) => x.repo)).toEqual(["api", "web"]);
    expect(c["schema"]).toBe("loki.v10.composite/1");
    expect(c["composite_sha256"]).toBe(compositeHash(c));
    expect((await verdictOf(p)).verdict).toBe("VERIFIED");
    expect(await quiet(() => verifyMain([p]))).toBe(0);
  });
  test("pubkey of the signer passes, a wrong key is never VERIFIED", async () => {
    const dir = writeWs("pk", KIDS);
    const p = await seal(dir);
    expect((await verdictOf(p, { pubkey: createPublicKey(loadSigningKey(false)!) })).verdict).toBe("VERIFIED");
    expect((await verdictOf(p, { pubkey: generateKeyPairSync("ed25519").publicKey })).verdict).not.toBe("VERIFIED");
  });
  test("tampered child byte is TAMPERED and exits 1", async () => {
    const dir = writeWs("tamper", KIDS);
    const p = await seal(dir);
    rewrite(childPath(dir, "web"), (r) => { r["not_proven"] = ["x"]; }, false);
    expect((await verdictOf(p)).verdict).toBe("TAMPERED");
    expect(await quiet(() => verifyMain([p]))).toBe(1);
  });
  test("swapped child receipt (valid, different run) is TAMPERED", async () => {
    const dir = writeWs("swap", KIDS);
    const p = await seal(dir);
    const other = writeWs("swap-other", [{ repo: "api", head: "z".repeat(40) }, { repo: "web" }]);
    writeFileSync(childPath(dir, "api"), readFileSync(childPath(other, "api")));
    expect((await verdictOf(p)).verdict).toBe("TAMPERED");
  });
  test("composite body edited after signing is TAMPERED", async () => {
    const dir = writeWs("edit", KIDS);
    const p = await seal(dir);
    rewrite(p, (r) => { (r["children"] as { head_sha: string }[])[0]!.head_sha = "q".repeat(40); }, false);
    expect((await verdictOf(p)).verdict).toBe("TAMPERED");
  });
  test("unsigned child under a signed composite is UNCHECKED and exits 2", async () => {
    const dir = writeWs("unsigned", [{ repo: "api" }, { repo: "web", unsigned: true }]);
    const p = await seal(dir);
    expect((await verdictOf(p)).verdict).toBe("UNCHECKED");
    expect(await quiet(() => verifyMain([p]))).toBe(2);
  });
  test("head mismatch: a child head that is not the integrated head is TAMPERED", async () => {
    const dir = writeWs("head", KIDS);
    const p = await seal(dir);
    const ip = join(dir, "integration.json"), i = JSON.parse(readFileSync(ip, "utf8"));
    i.heads.api = "f".repeat(40);
    writeFileSync(ip, JSON.stringify(i));
    resign(p, (c) => { c["integration_sha256"] = createHash("sha256").update(readFileSync(ip)).digest("hex"); c["integration"].heads.api = "f".repeat(40); });
    const r = await verdictOf(p);
    expect(r.verdict).toBe("TAMPERED");
    expect(r.reasons.join(" ")).toContain("integrated head");
  });
  test("one PARTIAL child caps the composite at PARTIAL: integrity VERIFIED, exit 4", async () => {
    const dir = writeWs("partial", [{ repo: "api" }, { repo: "web", verdict: "PARTIAL" }]);
    const p = await seal(dir);
    expect(JSON.parse(readFileSync(p, "utf8")).verdict).toBe("PARTIAL");
    expect((await verdictOf(p)).verdict).toBe("VERIFIED");
    expect(await quiet(() => verifyMain([p]))).toBe(4);
  });
  test("a re-signed verdict higher than the weakest child is TAMPERED", async () => {
    const dir = writeWs("lie", [{ repo: "api" }, { repo: "web", verdict: "PARTIAL" }]);
    const p = await seal(dir);
    resign(p, (c) => { c["verdict"] = "VERIFIED"; });
    expect((await verdictOf(p)).verdict).toBe("TAMPERED");
  });
  test("a signed composite that omits a repo is TAMPERED", async () => {
    const dir = writeWs("omit", KIDS);
    const p = await seal(dir);
    resign(p, (c) => { c["children"] = (c["children"] as unknown[]).slice(0, 1); });
    const r = await verdictOf(p);
    expect(r.verdict).toBe("TAMPERED");
    expect(r.reasons.join(" ")).toContain("cover");
  });
  test("a signed composite that lists a repo twice is TAMPERED", async () => {
    const dir = writeWs("dup", KIDS);
    const p = await seal(dir);
    resign(p, (c) => { const k = c["children"] as unknown[]; c["children"] = [k[0], k[0]]; });
    expect((await verdictOf(p)).verdict).toBe("TAMPERED");
  });
  test("a child receipt_path pointing at another repo is TAMPERED", async () => {
    const dir = writeWs("xrepo", KIDS);
    const p = await seal(dir);
    resign(p, (c) => { const k = c["children"] as { receipt_path: string }[]; k[0]!.receipt_path = k[1]!.receipt_path; });
    expect((await verdictOf(p)).verdict).toBe("TAMPERED");
  });
  test("a child whose integration outcome is not ok is TAMPERED", async () => {
    const dir = writeWs("outcome", KIDS);
    const p = await seal(dir);
    const ip = join(dir, "integration.json"), i = JSON.parse(readFileSync(ip, "utf8"));
    i.outcomes.web = "FAILED: exit 1";
    writeFileSync(ip, JSON.stringify(i));
    resign(p, (c) => { c["integration_sha256"] = createHash("sha256").update(readFileSync(ip)).digest("hex"); });
    expect((await verdictOf(p)).verdict).toBe("TAMPERED");
  });
  test("sealing refuses a null integrated head; a legacy composite without the integration section stays UNCHECKED", async () => {
    const dir = writeWs("nullhead", KIDS);
    const p = await seal(dir);
    const ip = join(dir, "integration.json"), i = JSON.parse(readFileSync(ip, "utf8"));
    i.heads.api = null;
    writeFileSync(ip, JSON.stringify(i));
    expect(() => composeComposite(dir, computeReceiptHash)).toThrow(/integrated head/);
    resign(p, (c) => { c["integration_sha256"] = createHash("sha256").update(readFileSync(ip)).digest("hex"); delete c["integration"]; });
    expect((await verdictOf(p)).verdict).toBe("UNCHECKED");
  });
  test("a failed or interrupted integration run is never sealed and a re-signed edit is TAMPERED", async () => {
    for (const status of ["failed", "interrupted"]) {
      const bad = writeWs(`st-${status}`, KIDS, { status, exit_code: 1 });
      expect(() => composeComposite(bad, computeReceiptHash)).toThrow(/integration/);
    }
    expect(() => composeComposite(writeWs("st-rc", KIDS, { exit_code: 3 }), computeReceiptHash)).toThrow(/exit/);
    const dir = writeWs("st-edit", KIDS);
    const p = await seal(dir);
    const ip = join(dir, "integration.json"), i = JSON.parse(readFileSync(ip, "utf8"));
    i.status = "failed"; i.exit_code = 1;
    writeFileSync(ip, JSON.stringify(i));
    resign(p, (c) => { c["integration_sha256"] = createHash("sha256").update(readFileSync(ip)).digest("hex"); });
    const r = await verdictOf(p);
    expect(r.verdict).toBe("TAMPERED");
    expect(r.reasons.join(" ")).toContain("integration");
  });
  test("body states integration status, exit code, log hash and heads; editing the body is TAMPERED", async () => {
    const dir = writeWs("st-body", KIDS, {}, "all green\n");
    const p = await seal(dir);
    const c = JSON.parse(readFileSync(p, "utf8"));
    expect(c.integration).toEqual({ status: "passed", exit_code: 0, log_sha256: sha256("all green\n"), heads: { api: "a".repeat(40), web: "w".repeat(40) } });
    expect((await verdictOf(p)).verdict).toBe("VERIFIED");
    resign(p, (x) => { x["integration"].status = "not_configured"; });
    expect((await verdictOf(p)).verdict).toBe("TAMPERED");
  });
  test("integration.log is pinned: a swapped log is TAMPERED, a missing or mismatched log refuses sealing", async () => {
    const dir = writeWs("log", KIDS, {}, "real log\n");
    const p = await seal(dir);
    writeFileSync(join(dir, "integration.log"), "forged log\n");
    const r = await verdictOf(p);
    expect(r.verdict).toBe("TAMPERED");
    expect(r.reasons.join(" ")).toContain("integration.log");
    expect(() => composeComposite(dir, computeReceiptHash)).toThrow(/integration\.log/);
    rmSync(join(dir, "integration.log"));
    expect(() => composeComposite(dir, computeReceiptHash)).toThrow(/integration\.log/);
  });
  test("seal and verify print every repo head SHA and the integration result", async () => {
    const dir = writeWs("show", KIDS, {}, "ok\n");
    let out = "";
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    try {
      await verifyMain(["--seal-composite", dir]);
      const sealOut = out; out = "";
      await verifyMain([join(dir, "composite.json")]);
      for (const o of [sealOut, out]) {
        expect(o).toContain("integration: passed (exit 0, log_sha256 " + sha256("ok\n"));
        expect(o).toContain("api head_sha: " + "a".repeat(40));
        expect(o).toContain("web head_sha: " + "w".repeat(40));
      }
    } finally { process.stdout.write = w; }
  });
  test("sealing refuses a run dir whose name is not a valid run id", async () => {
    const dir = writeWs("badid", KIDS);
    const bad = join(root, "bad id");
    Bun.spawnSync({ cmd: ["cp", "-R", dir, bad] });
    const err = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { expect(await verifyMain(["--seal-composite", bad])).toBe(2); } finally { process.stderr.write = err; }
  });
  test("sealing refuses unless every repo has a receipt", async () => {
    const dir = writeWs("missing", KIDS);
    rmSync(join(dir, "worktrees", "web"), { recursive: true });
    expect(() => composeComposite(dir, computeReceiptHash)).toThrow(/web/);
    const err = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { expect(await verifyMain(["--seal-composite", dir])).toBe(2); } finally { process.stderr.write = err; }
    const ip = join(dir, "integration.json"), i = JSON.parse(readFileSync(ip, "utf8"));
    i.outcomes.web = "FAILED: exit 1";
    writeFileSync(ip, JSON.stringify(i));
    expect(() => composeComposite(dir, computeReceiptHash)).toThrow(/did not finish/);
  });
});

// V118-01: runGroup composes a signed group receipt and resumes on the same spec. Fake launcher (the BacklogLauncher seam) writes
// signed unit receipts into the harvest layout (group/units/<id>/) exactly as backlog.py does.
describe("group run: Group Seal and resume", () => {
  const SPEC = "- add alpha\n- add beta\n- add gamma\n";
  const DAG: Dag = {
    units: ["alpha", "beta", "gamma"].map((w, i) => ({ id: `u${i + 1}`, items: [`add ${w}`], writeSet: [`src/${w}.ts`], modules: [], serialized: [] })),
    sharedFiles: [], edges: [],
  };
  const mkRepo = (name: string): string => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    for (const a of [["init", "-q", "-b", "main"], ["config", "user.name", "t"], ["config", "user.email", "t@t.invalid"], ["config", "commit.gpgsign", "false"]]) sh(["git", ...a], d);
    writeFileSync(join(d, "README.md"), "x\n");
    sh(["git", "add", "README.md"], d); sh(["git", "commit", "-q", "-m", "init"], d);
    sh(["git", "remote", "add", "origin", "git@github.com:acme/widgets.git"], d);
    return d;
  };
  interface Opt { fail?: number[]; unsigned?: number[]; tamper?: number[]; satisfied?: number[]; shared?: number[]; fixNoop?: boolean; fixFail?: boolean; fixSkipMerge?: boolean; wall?: Record<number, string>; extra?: Record<number, [string, string]>; badTask?: number[]; noTask?: number[]; noSpec?: number[]; originHead?: string }
  /** Fake backlog.py: for each unit not marked done in the dag, commit on loki/unit-<g>-<n> and harvest a signed receipt at that head. */
  const fake = (repo: string, calls: string[], o: Opt = {}) => async (argv: string[]): Promise<{ code: number; stdout: string }> => {
    const g = argv[argv.indexOf("--group") + 1]!;
    const dag = JSON.parse(readFileSync(argv[argv.indexOf("--dag") + 1]!, "utf8")) as { units: { id: string; items?: string[]; done?: boolean; fixKind?: string; fixFor?: string; base?: string; spec?: string }[] };
    let out = "";
    for (const [i, u] of dag.units.entries()) {
      const n = i + 1, br = `loki/unit-${g}-${n}`;
      if (u.done) continue;
      calls.push(u.id);
      if (o.fail?.includes(n)) { out += `backlog: unit-${g}-${n} FAILED: exit 1\n`; continue; }
      const has = Bun.spawnSync({ cmd: ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${br}`], cwd: repo }).exitCode === 0;
      const prev = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo).trim();
      if (u.fixKind) {
        // Model backlog.py: a worktree starts at the unit's dag base when given, else at origin/HEAD (main here), never at the checked-out group branch.
        if (o.fixFail) { out += `backlog: unit-${g}-${n} FAILED: exit 1\n`; continue; }
        sh(["git", "checkout", "-q", "-b", br, u.base ?? "main"], repo);
        if (u.fixKind === "conflict" && !o.fixSkipMerge) sh(["git", "merge", "--no-ff", "-q", "-X", "theirs", "-m", "fix", `loki/unit-${g}-${dag.units.findIndex((x) => x.id === u.fixFor) + 1}`], repo);
        else if (!o.fixNoop) { writeFileSync(join(repo, "ok.txt"), "ok\n"); sh(["git", "add", "ok.txt"], repo); }
        sh(["git", "commit", "-q", "--allow-empty", "-m", "fix"], repo);
      } else {
        sh(has ? ["git", "checkout", "-q", br] : ["git", "checkout", "-q", "-b", br, u.base ?? o.originHead ?? "main"], repo); // backlog.py: an empty base starts at origin/HEAD
        const f = o.shared?.includes(n) ? "shared.txt" : `${g}-u${n}.txt`;
        writeFileSync(join(repo, f), o.shared?.includes(n) ? `${n}\n` : `${calls.length}\n`);
        sh(["git", "add", f], repo);
        const ex = o.extra?.[n];
        if (ex) { writeFileSync(join(repo, ex[0]), ex[1]); sh(["git", "add", ex[0]], repo); }
        sh(["git", "commit", "-q", "-m", `u${n}`], repo);
      }
      const head = sh(["git", "rev-parse", "HEAD"], repo).trim();
      sh(["git", "checkout", "-q", prev], repo);
      const d = join(repo, ".loki", "groups", g, "group", "units", u.id);
      mkdirSync(d, { recursive: true });
      const events = JSON.stringify({ v: 1, seq: 0, ts: "2026-01-01T00:00:00.000Z", run: u.id, type: "run.started", stage: null, data: {} }) + "\n";
      writeFileSync(join(d, "events.jsonl"), events);
      const wallSrc = o.wall?.[n];
      if (wallSrc !== undefined) { // harvest layout: the sealed copy sits beside the receipt; the receipt path points into the (gone) unit worktree
        mkdirSync(join(d, "wall"), { recursive: true });
        writeFileSync(join(d, "wall", "loki_wall_x.test.ts"), wallSrc);
      }
      const body = { ...(wallSrc !== undefined ? { wall: { files: [{ path: `${repo}-backlog/unit-${g}-${n}/loki_wall_x.test.ts`, sha256: sha256(wallSrc) }] } } : {}), schema: "loki.v10.receipt/1", run_id: u.id, verdict: o.satisfied?.includes(n) ? "ALREADY_SATISFIED" : "VERIFIED", head_sha: head, events_sha256: sha256(events), ...(o.noSpec?.includes(n) ? {} : unitSpecReceiptBlock({ LOKI_UNIT_SPEC: u.spec ?? "", LOKI_SPEED: "1" } as NodeJS.ProcessEnv)), ...(o.noTask?.includes(n) ? {} : { task: { source: "text", sha256: sha256(o.badTask?.includes(n) ? "forged task" : (u.items ?? []).join("\n")) } }), time: { wall_s: 0, stages: {} }, not_proven: [] };
      const h = receiptSha256(body as never), sig = o.unsigned?.includes(n) ? { jwt: null, kid: null } : signReceipt(u.id, h);
      const rec = { ...body, receipt_sha256: h, verification: sig };
      if (o.tamper?.includes(n)) rec.verdict = "FAILED";
      writeFileSync(join(d, "receipt.json"), JSON.stringify(rec, null, 2) + "\n");
      out += `backlog: unit-${g}-${n} VERIFIED\n`;
    }
    return { code: 0, stdout: out };
  };
  const go = async (repo: string, l: ReturnType<typeof fake>, env: Record<string, string> = {}, spec = SPEC): Promise<{ code: number; err: string }> => {
    let err = "";
    const code = await runGroup(l, DAG, { task: "t", repoDir: repo, env: { LOKI_GROUP_TEST_CMD: "true", LOKI_PROVIDER: "claude", LOKI_CACHE_ROOT: `${repo}-cache`, ...env } as NodeJS.ProcessEnv, provider: "claude", spec, specPath: null, seal: { receiptSha256, verifyReceipt }, say: (s) => { err += s; } });
    return { code, err };
  };
  const groups = (repo: string): string[] => readdirSync(join(repo, ".loki", "groups")).filter((n) => n.startsWith("g"));
  const dagOf = (repo: string, g: string): Record<string, any> => JSON.parse(readFileSync(join(repo, ".loki", "groups", g, "dag.json"), "utf8"));

  test("green run: signed group receipt verifies, exit 0, dag carries spec_sha256 base_ref and unit specs", async () => {
    const repo = mkRepo("gr-green"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls));
    expect(code).toBe(0);
    const [g] = groups(repo), gd = join(repo, ".loki", "groups", g!);
    const rec = JSON.parse(readFileSync(join(gd, "receipt.json"), "utf8"));
    expect(rec.schema).toBe("loki.v10.group/1");
    expect(rec.verdict).toBe("VERIFIED");
    expect(rec.run_id).toBe(g);
    expect(rec.base_sha).toBe(dagOf(repo, g!).base_ref);
    expect(rec.head_sha).toBe(sh(["git", "rev-parse", `refs/heads/loki/group-${g}`], repo).trim());
    expect(rec.verification.jwt).toBeTruthy();
    expect((await verifyReceipt(join(gd, "receipt.json"))).verdict).toBe("VERIFIED");
    expect(err).not.toContain("NOT PROVEN");
    const dag = dagOf(repo, g!);
    expect(dag.spec_sha256).toBe(createHash("sha256").update(SPEC).digest("hex"));
    for (const u of dag.units) {
      expect(u.spec).toBe(join(gd, "unit_specs", `${u.id}.json`));
      const us = JSON.parse(readFileSync(u.spec, "utf8"));
      expect(us).toMatchObject({ id: u.id, writeSet: u.writeSet, pack: u.writeSet, tokenBudget: 1e9, acceptance: [] });
    }
    expect(JSON.parse(readFileSync(join(gd, "group", "manifest.json"), "utf8")).units.map((u: { unit_id: string }) => u.unit_id)).toEqual(["u1", "u2", "u3"]);
  });

  // GAME10-06a: the loki start path hands each harvested unit's sealed Wall to integrate.
  const absentCfg = `import { expect, test } from "bun:test";\nimport { existsSync } from "node:fs";\nimport { join } from "node:path";\ntest("cfg.txt is absent", () => { expect(existsSync(join(import.meta.dir, "cfg.txt"))).toBe(false); });\n`;
  test("runGroup reruns u1's sealed Wall on the merged tree: u2 adds cfg.txt, the group fails naming u1", async () => {
    const repo = mkRepo("gr-wall-red"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls, { wall: { 1: absentCfg }, extra: { 2: ["cfg.txt", "x\n"] } }));
    expect(code).toBe(1);
    expect(err).toContain("sealed Wall failed on the merged tree: u1");
    expect(err).toContain("loki: unit u1 sealed Wall on the merged tree: fail");
  });
  test("runGroup: compatible units keep the group VERIFIED and report the Wall pass; units without a Wall are no_wall", async () => {
    const repo = mkRepo("gr-wall-green"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls, { wall: { 1: absentCfg } }));
    expect(err).toContain("loki: unit u1 sealed Wall on the merged tree: pass");
    expect(err).toContain("loki: unit u2 sealed Wall on the merged tree: no_wall");
    expect(code).toBe(0);
  });
  test("runGroup: every unit sealed with no Wall file ends VERIFIED with a no_wall line per unit", async () => {
    const repo = mkRepo("gr-wall-none"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls));
    expect(code).toBe(0);
    expect(err).toContain("VERIFIED");
    expect(err).not.toContain("NOT PROVEN");
    for (const u of ["u1", "u2", "u3"]) expect(err).toContain(`loki: unit ${u} sealed Wall on the merged tree: no_wall (no sealed Wall to rerun)`);
  });
  test("runGroup: a harvested unit receipt removed ends NOT PROVEN (exit 4) and that unit reads no_wall", async () => {
    const repo = mkRepo("gr-wall-norcpt"), calls: string[] = [];
    const base = fake(repo, calls);
    const { code, err } = await go(repo, async (argv) => {
      const r = await base(argv);
      rmSync(join(repo, ".loki", "groups", argv[argv.indexOf("--group") + 1]!, "group", "units", "u2", "receipt.json"));
      return r;
    });
    expect(code).toBe(4);
    expect(err).toContain("NOT PROVEN");
    expect(err).toContain("loki: unit u2 sealed Wall on the merged tree: no_wall (sealed receipt missing or unreadable)");
    expect(err).toContain("unit u2 sub-receipt missing");
  });
  test("runGroup: a tampered harvested Wall copy fails closed", async () => {
    const repo = mkRepo("gr-wall-tamper"), calls: string[] = [];
    const base = fake(repo, calls, { wall: { 1: absentCfg } });
    const { code, err } = await go(repo, async (argv) => {
      const r = await base(argv);
      const g = argv[argv.indexOf("--group") + 1]!;
      writeFileSync(join(repo, ".loki", "groups", g, "group", "units", "u1", "wall", "loki_wall_x.test.ts"), "test('x', () => {});\n");
      return r;
    });
    expect(code).toBe(1);
    expect(err).toContain("not the sealed bytes");
  });

  test("a verified group receipt on the group branch short-circuits: exit 0, nothing launched", async () => {
    const repo = mkRepo("gr-again"), calls: string[] = [];
    expect((await go(repo, fake(repo, calls))).code).toBe(0);
    const before = calls.length;
    const { code, err } = await go(repo, fake(repo, calls));
    expect(code).toBe(0);
    expect(calls.length).toBe(before);
    expect(groups(repo).length).toBe(1);
    expect(err).toContain("already VERIFIED");
  });

  test("an ALREADY_SATISFIED unit exits 4 and a rerun does not short-circuit to 0", async () => {
    const repo = mkRepo("gr-satisfied"), calls: string[] = [];
    const first = await go(repo, fake(repo, calls, { satisfied: [2] }));
    expect(first.code).toBe(4);
    const before = calls.length;
    const second = await go(repo, fake(repo, calls, { satisfied: [2] }));
    expect(second.code).toBe(4);
    expect(second.err).not.toContain("nothing to run");
    expect(calls.length).toBeGreaterThan(before);
  });

  test("resume skips VERIFIED units: only the failed unit reruns, same gid, done flags set", async () => {
    const repo = mkRepo("gr-resume"), calls: string[] = [];
    expect((await go(repo, fake(repo, calls, { fail: [3] }))).code).toBe(1);
    expect(calls).toEqual(["u1", "u2", "u3"]);
    const { code, err } = await go(repo, fake(repo, calls));
    expect(code).toBe(0);
    expect(calls).toEqual(["u1", "u2", "u3", "u3"]);
    expect(groups(repo).length).toBe(1);
    expect(err).toContain(`loki: resuming group ${groups(repo)[0]}: 2 of 3 units already VERIFIED`);
    expect(dagOf(repo, groups(repo)[0]!).units.map((u: { done: boolean }) => u.done)).toEqual([true, true, false]);
  });

  // #283: per-subtask resume is run_group's signed-receipt skip (unitDone); a 3-unit rerun with one VERIFIED unit dispatches the other two.
  test("rerun of a 3-unit group with one VERIFIED unit dispatches exactly the 2 others", async () => {
    const repo = mkRepo("gr-resume-1of3"), calls: string[] = [];
    expect((await go(repo, fake(repo, calls, { fail: [2, 3] }))).code).toBe(1);
    expect(calls).toEqual(["u1", "u2", "u3"]); // first run dispatches 3
    calls.length = 0;
    const { code, err } = await go(repo, fake(repo, calls));
    expect(code).toBe(0);
    expect(calls).toEqual(["u2", "u3"]); // rerun dispatches 2; u1 is skipped
    expect(err).toContain("1 of 3 units already VERIFIED");
    expect(dagOf(repo, groups(repo)[0]!).units.map((u: { done: boolean }) => u.done)).toEqual([true, false, false]);
  });

  test("#283 journal: a fresh group with the same card and base reuses the VERIFIED unit and dispatches 2", async () => {
    const repo = mkRepo("gr-journal"), calls: string[] = [], env = { LOKI_CACHE_ROOT: join(root, "gr-journal-cache") };
    expect((await go(repo, fake(repo, calls, { fail: [2, 3] }), env)).code).toBe(1);
    expect(calls).toEqual(["u1", "u2", "u3"]);
    calls.length = 0;
    sh(["git", "checkout", "-q", "main"], repo); // a run leaves HEAD on the group branch; the user's base is main again
    const { code, err } = await go(repo, fake(repo, calls), { ...env, LOKI_GROUP_RESUME: "0" });
    expect(code).toBe(0);
    expect(calls).toEqual(["u2", "u3"]);
    expect(err).toContain("unit u1 reused from the slice journal");
    expect(groups(repo).length).toBe(2);
  });
  test("#283 journal: a changed base sha misses, all 3 dispatch", async () => {
    const repo = mkRepo("gr-journal-base"), calls: string[] = [], env = { LOKI_CACHE_ROOT: join(root, "gr-journal-base-cache") };
    expect((await go(repo, fake(repo, calls, { fail: [2, 3] }), env)).code).toBe(1);
    sh(["git", "checkout", "-q", "main"], repo);
    writeFileSync(join(repo, "moved.txt"), "m\n"); sh(["git", "add", "moved.txt"], repo); sh(["git", "commit", "-q", "-m", "moved"], repo);
    calls.length = 0;
    expect((await go(repo, fake(repo, calls), { ...env, LOKI_GROUP_RESUME: "0" })).code).toBe(0);
    expect(calls).toEqual(["u1", "u2", "u3"]);
  });
  test("#283 journal: a moved unit branch head is not reused", async () => {
    const repo = mkRepo("gr-journal-head"), calls: string[] = [], env = { LOKI_CACHE_ROOT: join(root, "gr-journal-head-cache") };
    expect((await go(repo, fake(repo, calls, { fail: [2, 3] }), env)).code).toBe(1);
    const g = groups(repo)[0]!;
    sh(["git", "checkout", "-q", `loki/unit-${g}-1`], repo);
    writeFileSync(join(repo, "extra.txt"), "x\n"); sh(["git", "add", "extra.txt"], repo); sh(["git", "commit", "-q", "-m", "moved"], repo);
    sh(["git", "checkout", "-q", "main"], repo);
    calls.length = 0;
    expect((await go(repo, fake(repo, calls), { ...env, LOKI_GROUP_RESUME: "0" })).code).toBe(0);
    expect(calls).toEqual(["u1", "u2", "u3"]);
  });

  test("#283 journal: a unit re-sealed for an edited card in its old group is not adopted for the old card", async () => {
    const repo = mkRepo("gr-journal-resealed"), calls: string[] = [], env = { LOKI_CACHE_ROOT: join(root, "gr-journal-resealed-cache") };
    const B = "## Acceptance criteria\n- add alpha\n- add beta\n- add gamma\n", R = "## Acceptance criteria\n- add alpha\n- add beta v2\n- add gamma\n";
    expect((await go(repo, fake(repo, calls), env, B)).code).toBe(0);
    sh(["git", "checkout", "-q", "main"], repo);
    expect((await go(repo, fake(repo, calls), env, R)).code).toBe(0);
    expect(calls).toEqual(["u1", "u2", "u3", "u2"]);
    sh(["git", "checkout", "-q", "main"], repo);
    calls.length = 0;
    const { err } = await go(repo, fake(repo, calls), { ...env, LOKI_GROUP_RESUME: "0" }, B);
    expect(calls).toEqual(["u2"]);
    expect(err).not.toContain("unit u2 reused from the slice journal");
  });
  test("#283 journal: a journaled receipt whose signed task text differs from the unit is not adopted", async () => {
    const repo = mkRepo("gr-journal-forged"), calls: string[] = [], env = { LOKI_CACHE_ROOT: join(root, "gr-journal-forged-cache") };
    expect((await go(repo, fake(repo, calls, { badTask: [1], fail: [2, 3] }), env)).code).toBe(1);
    sh(["git", "checkout", "-q", "main"], repo);
    calls.length = 0;
    const { err } = await go(repo, fake(repo, calls), { ...env, LOKI_GROUP_RESUME: "0" });
    expect(calls).toEqual(["u1", "u2", "u3"]);
    expect(err).not.toContain("unit u1 reused from the slice journal");
  });

  test("#283 journal: a receipt with no task.sha256 is not adopted", async () => {
    const repo = mkRepo("gr-journal-notask"), calls: string[] = [], env = { LOKI_CACHE_ROOT: join(root, "gr-journal-notask-cache") };
    expect((await go(repo, fake(repo, calls, { noTask: [1], fail: [2, 3] }), env)).code).toBe(1);
    sh(["git", "checkout", "-q", "main"], repo);
    calls.length = 0;
    const { err } = await go(repo, fake(repo, calls), { ...env, LOKI_GROUP_RESUME: "0" });
    expect(calls).toEqual(["u1", "u2", "u3"]);
    expect(err).not.toContain("unit u1 reused from the slice journal");
  });

  test("#317b journal: a colliding key whose signed unit spec has a different acceptance is not adopted", async () => {
    const repo = mkRepo("gr-journal-specsha"), calls: string[] = [], cacheRoot = join(root, "gr-journal-specsha-cache"), env = { LOKI_CACHE_ROOT: cacheRoot };
    const B = "## Acceptance criteria\n- add alpha\n- add beta\n- add gamma\n", R = "## Acceptance criteria\n- add alpha\n- add beta v2\n- add gamma\n";
    expect((await go(repo, fake(repo, calls, { fail: [3] }), env, B)).code).toBe(1);
    sh(["git", "checkout", "-q", "main"], repo);
    expect((await go(repo, fake(repo, calls, { fail: [1, 2, 3] }), { ...env, LOKI_GROUP_RESUME: "0" }, R)).code).toBe(1);
    sh(["git", "checkout", "-q", "main"], repo);
    const jdir = repoCacheDir(repoKey("git@github.com:acme/widgets.git", repo), cacheRoot);
    const u2 = (g: string): { id: string; items: string[]; writeSet: string[]; acceptance: string[]; base: string } => JSON.parse(readFileSync(join(repo, ".loki", "groups", g, "unit_specs", "u2.json"), "utf8"));
    const gs = groups(repo), a = gs.map(u2).find((x) => !x.acceptance.join().includes("v2"))!, b = gs.map(u2).find((x) => x.acceptance.join().includes("v2"))!;
    const kOf = (x: typeof a): string => sliceKey(JSON.stringify({ id: x.id, items: x.items, writeSet: x.writeSet, acceptance: x.acceptance }), x.base);
    const entry = readSliceJournal(jdir, kOf(a));
    expect(entry).not.toBeNull();
    writeSliceJournal(jdir, kOf(b), entry!);
    calls.length = 0;
    const { err } = await go(repo, fake(repo, calls), { ...env, LOKI_GROUP_RESUME: "0" }, R);
    expect(calls).toContain("u2");
    expect(err).not.toContain("unit u2 reused from the slice journal");
  });
  test("#317b journal: a receipt with no signed unit_spec is not adopted", async () => {
    const repo = mkRepo("gr-journal-nospec"), calls: string[] = [], env = { LOKI_CACHE_ROOT: join(root, "gr-journal-nospec-cache") };
    expect((await go(repo, fake(repo, calls, { noSpec: [1], fail: [2, 3] }), env)).code).toBe(1);
    sh(["git", "checkout", "-q", "main"], repo);
    calls.length = 0;
    const { err } = await go(repo, fake(repo, calls), { ...env, LOKI_GROUP_RESUME: "0" });
    expect(calls).toEqual(["u1", "u2", "u3"]);
    expect(err).not.toContain("unit u1 reused from the slice journal");
  });

  test("#317: local HEAD ahead of origin/HEAD, every unit starts at the journal-key base, not at origin/HEAD", async () => {
    const repo = mkRepo("gr-base317"), calls: string[] = [], env = { LOKI_CACHE_ROOT: join(root, "gr-base317-cache") };
    sh(["git", "branch", "origin-sim"], repo); // stands in for origin/HEAD at the init commit
    writeFileSync(join(repo, "ahead.txt"), "a\n"); sh(["git", "add", "ahead.txt"], repo); sh(["git", "commit", "-q", "-m", "local ahead"], repo);
    expect((await go(repo, fake(repo, calls, { originHead: "origin-sim" }), env)).code).toBe(0);
    const g = groups(repo)[0]!, d = dagOf(repo, g), baseRef = d.base_ref as string;
    expect(baseRef).toBe(sh(["git", "rev-parse", "main"], repo).trim());
    for (const [i, u] of (d.units as { id: string; base?: string }[]).entries()) {
      expect(u.base).toBe(baseRef);
      expect(sh(["git", "rev-parse", `loki/unit-${g}-${i + 1}~1`], repo).trim()).toBe(baseRef);
    }
  });

  const AC = "## Acceptance criteria\n", BASE = AC + SPEC, REVISED = AC + "- add alpha\n- add beta v2\n- add gamma\n";
  test("spec revision resume: unaffected units are skipped-unchanged, the changed unit reruns on the same gid", async () => {
    const repo = mkRepo("gr-revised"), calls: string[] = [];
    expect((await go(repo, fake(repo, calls), {}, BASE)).code).toBe(0);
    const { code, err } = await go(repo, fake(repo, calls), {}, REVISED);
    expect(code).toBe(0);
    expect(calls).toEqual(["u1", "u2", "u3", "u2"]);
    expect(groups(repo).length).toBe(1);
    expect(err).toContain("unit u1 skipped-unchanged");
    expect(err).toContain("unit u3 skipped-unchanged");
    expect(err).not.toContain("unit u2 skipped-unchanged");
    expect(dagOf(repo, groups(repo)[0]!).spec_sha256).toBe(createHash("sha256").update(REVISED).digest("hex"));
  });

  test("a unit whose branch head moved since its receipt reruns", async () => {
    const repo = mkRepo("gr-head"), calls: string[] = [];
    expect((await go(repo, fake(repo, calls, { fail: [3] }))).code).toBe(1);
    const g = groups(repo)[0]!;
    sh(["git", "checkout", "-q", `loki/unit-${g}-1`], repo);
    writeFileSync(join(repo, "extra.txt"), "x\n"); sh(["git", "add", "extra.txt"], repo); sh(["git", "commit", "-q", "-m", "moved"], repo);
    sh(["git", "checkout", "-q", "main"], repo);
    expect((await go(repo, fake(repo, calls))).code).toBe(0);
    expect(calls).toEqual(["u1", "u2", "u3", "u1", "u3"]);
  });

  test("LOKI_GROUP_RESUME=0 starts a new group id and runs every unit", async () => {
    const repo = mkRepo("gr-fresh"), calls: string[] = [];
    expect((await go(repo, fake(repo, calls, { fail: [3] }))).code).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    await go(repo, fake(repo, calls), { LOKI_GROUP_RESUME: "0" });
    expect(groups(repo).length).toBe(2);
    expect(calls.length).toBe(6);
  });

  test("a tampered unit receipt is never exit 0 and the group does not verify", async () => {
    const repo = mkRepo("gr-tamper"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls, { tamper: [2] }));
    expect(code).toBe(4);
    expect(err).toContain("NOT PROVEN");
  });

  test("tampering a harvested unit receipt after sealing makes the group receipt not VERIFIED", async () => {
    const repo = mkRepo("gr-tamper2"), calls: string[] = [];
    expect((await go(repo, fake(repo, calls))).code).toBe(0);
    const g = groups(repo)[0]!, gd = join(repo, ".loki", "groups", g);
    rewrite(join(gd, "group", "units", "u2", "receipt.json"), (r) => { r["verdict"] = "FAILED"; }, false);
    expect((await verifyReceipt(join(gd, "receipt.json"))).verdict).not.toBe("VERIFIED");
  });

  // GROUP-FIX-UNITS: u1 and u2 both add shared.txt, so integration conflicts on u2.
  const unitsOf = (repo: string): string[] => dagOf(repo, groups(repo)[0]!).units.map((u: { id: string }) => u.id);
  const brs = (repo: string): string[] => sh(["git", "branch", "--list", "loki/group-*"], repo).split("\n").map((l) => l.replace(/^[*+ ]+/, "")).filter(Boolean);

  test("fix unit: conflict then a passing fix unit merges, re-runs the suite and VERIFIES with the fix in the receipt", async () => {
    const repo = mkRepo("gr-fix-conflict"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls, { shared: [1, 2] }));
    expect(err).toContain("running fix unit fixu-1");
    expect(calls).toEqual(["u1", "u2", "u3", "fixu-1"]);
    expect(code).toBe(0);
    const gd = join(repo, ".loki", "groups", groups(repo)[0]!);
    const rec = JSON.parse(readFileSync(join(gd, "receipt.json"), "utf8"));
    expect(rec.verdict).toBe("VERIFIED");
    expect(rec.group.units.map((u: { unit_id: string }) => u.unit_id)).toEqual(["u1", "u2", "u3", "fixu-1"]);
    expect((await verifyReceipt(join(gd, "receipt.json"))).verdict).toBe("VERIFIED");
    expect(unitsOf(repo)).toEqual(["u1", "u2", "u3", "fixu-1"]);
    expect(dagOf(repo, groups(repo)[0]!).units[3]).toMatchObject({ fixKind: "conflict", fixFor: "u2", done: true });
  });

  test("fix unit: a failing suite gets one suite fix unit and then VERIFIES", async () => {
    const repo = mkRepo("gr-fix-suite"), calls: string[] = [];
    const { code } = await go(repo, fake(repo, calls), { LOKI_GROUP_TEST_CMD: "test -f ok.txt" });
    expect(calls).toEqual(["u1", "u2", "u3", "fixu-1"]);
    expect(code).toBe(0);
  });

  test("fix unit: a fix whose suite still fails ends not-verified naming the fix unit, and the cap of 2 holds", async () => {
    const repo = mkRepo("gr-fix-cap"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls, { shared: [1, 2, 3], fixNoop: true }), { LOKI_GROUP_TEST_CMD: "test -f never.txt" });
    expect(calls.filter((c) => c.startsWith("fixu-"))).toEqual(["fixu-1", "fixu-2"]);
    expect(calls).not.toContain("fixu-3");
    expect(err).not.toContain("fixu-3");
    expect(code).toBe(1);
    expect(err).toMatch(/unit fixu-2 fail|suite exit 1/);
    expect(err).toContain("FAILED: group not verified");
  });

  test("fix unit: a fix unit that fails keeps stop-and-name for the conflicting unit", async () => {
    const repo = mkRepo("gr-fix-fails"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls, { shared: [1, 2], fixFail: true }));
    expect(calls).toEqual(["u1", "u2", "u3", "fixu-1"]);
    expect(code).toBe(1);
    expect(err).toContain("unit u2 conflict");
    expect(err).toContain("fix unit fixu-1 did not pass");
  });

  test("fix unit: a conflict fix that never merged the unit branch is a failed fix, not VERIFIED", async () => {
    const repo = mkRepo("gr-fix-skipmerge"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls, { shared: [1, 2], fixSkipMerge: true }));
    expect(code).toBe(1);
    expect(err).toContain("unit u2 conflict");
    expect(err).toContain("fix unit fixu-1 did not pass");
  });

  test("fix unit: LOKI_GROUP_FIX_UNITS=0 restores stop-and-name with no fix launched", async () => {
    const repo = mkRepo("gr-fix-off"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls, { shared: [1, 2] }), { LOKI_GROUP_FIX_UNITS: "0" });
    expect(calls).toEqual(["u1", "u2", "u3"]);
    expect(code).toBe(1);
    expect(err).toContain("unit u2 conflict");
    expect(err).not.toContain("fix unit");
    expect(brs(repo).length).toBe(1);
  });

  test("fix unit: resume treats a finished fix unit like any other unit and launches nothing", async () => {
    const repo = mkRepo("gr-fix-resume"), calls: string[] = [];
    expect((await go(repo, fake(repo, calls, { shared: [1, 2] }))).code).toBe(0);
    const gd = join(repo, ".loki", "groups", groups(repo)[0]!);
    rmSync(join(gd, "receipt.json"));
    const before = calls.length;
    const { code, err } = await go(repo, fake(repo, calls, { shared: [1, 2] }));
    expect(code).toBe(0);
    expect(err).toContain("4 of 4 units already VERIFIED");
    expect(calls.length).toBe(before);
  });

  test("an unsigned unit receipt under a signed group is NOT PROVEN, never exit 0", async () => {
    const repo = mkRepo("gr-unsigned"), calls: string[] = [];
    const { code, err } = await go(repo, fake(repo, calls, { unsigned: [2] }));
    expect(code).toBe(4);
    expect(err).toContain("NOT PROVEN");
  });
});
