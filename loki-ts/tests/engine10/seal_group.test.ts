// D61-13: one Seal and a combined receipt with a per-unit sub-receipt, bound by hash.
// Wall check: verify passes on the combined receipt; tampering one unit's events fails it.
// The only spawn is git through the sh helper, which passes an explicit env.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sealedLog } from "./log_fixture.ts";
import { renderPrBody } from "../../src/engine10/pr_body.ts";
import { createPublicKey } from "node:crypto";
import { commitStage, loadSigningKey, receiptSha256, sealStage, sha256, signReceipt } from "../../src/engine10/stages/seal.ts";
import { main as verifyMain, verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { capGroupVerdict, sealGroup } from "../../src/features/speed/seal_group.ts";
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
    verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1.5 }], flaky: [], wall_passed: true, duration_s: 2 },
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
    const body = { schema: "loki.v10.receipt/1", run_id: u.id, verdict: u.verdict ?? "VERIFIED", head_sha: "h".repeat(40), events_sha256: sha256(events), not_proven: [] };
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
    const body = { schema: "loki.v10.receipt/1", run_id: "x", verdict: "VERIFIED", head_sha: "h".repeat(40), events_sha256: sha256(""), not_proven: [] };
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
    const s = await sealStage.run(ctx, new AbortController().signal);
    const receipt = JSON.parse(readFileSync(s.data["receipt_path"] as string, "utf8")) as Record<string, unknown>;
    expect("group" in receipt).toBe(false);
    expect(Object.keys(receipt).sort()).toEqual(["base_sha", "checks", "cost", "diff_sha256", "evidence", "events_sha256", "head_sha", "log_seal", "model", "not_proven", "provider", "receipt_sha256", "repo", "resumed", "run_id", "schema", "task", "time", "tree", "verdict", "verification", "wall"].sort());
    sealedLog(ctx.runDir, String(receipt["receipt_sha256"]));
    expect((await verifyReceipt(s.data["receipt_path"] as string)).verdict).toBe("VERIFIED");
    expect(readdirSync(ctx.runDir)).not.toContain("group");
  }, 30000);

  test("PR body without a group is byte-identical to the legacy rendering", () => {
    const body = renderPrBody({ verdict: "VERIFIED", notProven: ["full suite"], receiptPath: "/r/receipt.json", capHit: false, outputs: { implement: { duration_s: 3 } } });
    expect(body).toBe("Verdict: VERIFIED\n\nStage times:\n- implement: 3s\n\nNOT PROVEN:\n- full suite\n\nReceipt: /r/receipt.json\n");
  });

  test("PR body with a group appends a unit table", () => {
    const group = { group_id: "g1", units: [{ index: 0, unit_id: "u1", goal: "add csv", files: ["a.ts", "b.ts"], tests: 2, tokens: 100, model: "sonnet", verdict: "VERIFIED" }] };
    const body = renderPrBody({ verdict: "VERIFIED", notProven: [], receiptPath: null, capHit: false, outputs: {}, group: group as never });
    expect(body).toContain("| Unit | Goal | Files | Tests | Tokens | Model | Verdict |");
    expect(body).toContain("| u1 | add csv | a.ts, b.ts | 2 | 100 | sonnet | VERIFIED |");
  });
});
