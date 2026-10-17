// A-101: seal and verify must share one canonicalizer. Non-ASCII in any string field
// (model-written spec_conflict_reason, paths, keys) must round-trip through the real
// JSON.stringify(receipt, null, 2) file path and verify OK.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptSha256, sealStage } from "../../src/engine10/stages/seal.ts";
import type { Obj, RunContext, StageName } from "../../src/engine10/types.ts";
import { main, verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { seededCorpusBlock } from "../../src/util/run_outputs.ts";
import { REPO_ROOT } from "../../src/util/paths.ts";

const root = mkdtempSync(join(tmpdir(), "e10-roundtrip-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function seal(raw: Record<string, unknown>, dir: string): string {
  const body = { schema: "loki.v10.receipt/1", time: { wall_s: 0, stages: {} }, events_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ...raw };
  const receipt = { ...body, receipt_sha256: receiptSha256(body as never), verification: { jwt: null, kid: null } };
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "receipt.json");
  writeFileSync(p, JSON.stringify(receipt, null, 2) + "\n");
  return p;
}

async function capture(args: string[], runsRoot: string): Promise<{ rc: number; out: string }> {
  let out = "";
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => ((out += s), true)) as never;
  try {
    return { rc: await main(args, { runsRoot }), out };
  } finally {
    process.stdout.write = w;
  }
}

describe("seal then verify round-trip", () => {
  test("non-ASCII in every string field, key, and nested value verifies", async () => {
    const p = seal(
      {
        verdict: "SPEC_CONFLICT",
        spec_conflict_reason: "a \u2192 b, caf\u00e9, \u65e5\u672c\u8a9e, " + String.fromCodePoint(0x1f600),
        task: "t\u00e2che",
        not_proven: ["n\u00f6t proven \u2260 failed"],
        nested: { "k\u00e9y": ["\u2713", { z: "\u00fc" }], skipped: undefined },
        provider: "p\u00f8",
        model: "m\u00f6",
      },
      join(root, "a"),
    );
    const r = await verifyReceipt(p);
    expect(r.reasons).toEqual([]);
    expect(r.verdict).toBe("UNSIGNED");
  });

  test("main prints the full receipt_sha256", async () => {
    seal({ verdict: "VERIFIED", reason: "\u2192" }, join(root, "runs", "e10-1"));
    const { rc, out } = await capture(["e10-1", "--allow-unsigned"], join(root, "runs"));
    expect(rc).toBe(0);
    expect(out).toMatch(/receipt_sha256: [0-9a-f]{64}/);
  });

  test("--help and -h print usage and exit 0", async () => {
    for (const flag of ["--help", "-h"]) {
      const { rc, out } = await capture([flag], join(root, "none"));
      expect(rc).toBe(0);
      expect(out).toContain("Usage");
    }
  });
});

// TEN-GATES-15: the corpus version and catch rate ride in the signed receipt body.
const sh = (cwd: string, ...a: string[]): string => execFileSync(a[0]!, a.slice(1), { cwd, encoding: "utf8" });
async function realSeal(name: string, planted: Record<string, unknown> | null, results: ((v: string) => unknown) | null, manifest = '{"defects":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}', started: number | null = Date.now() - 60_000): Promise<{ receipt: Record<string, unknown>; path: string; runsRoot: string; version: string }> {
  const repo = join(root, name), corpus = join(root, name + "-corpus"), runDir = join(repo, ".loki/runs/r1");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(corpus, "results"), { recursive: true });
  writeFileSync(join(corpus, "manifest.json"), manifest);
  const version = createHash("sha256").update(manifest).digest("hex");
  if (results) writeFileSync(join(corpus, "results/wrong-pass.json"), JSON.stringify(results(version)));
  if (planted) { // what an agent under test with write access to repoDir could leave behind; the receipt must not read it
    mkdirSync(join(repo, ".loki/quality"), { recursive: true });
    writeFileSync(join(repo, ".loki/quality/ablation.json"), JSON.stringify(planted));
  }
  sh(repo, "git", "init", "-q", "-b", "main");
  sh(repo, "git", "config", "user.name", "t");
  sh(repo, "git", "config", "user.email", "t@t.invalid");
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(repo, "git", "add", "a.txt");
  sh(repo, "git", "commit", "-q", "-m", "base");
  const base = sh(repo, "git", "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "a.txt"), "two\n");
  sh(repo, "git", "commit", "-q", "-am", "work");
  const outputs = {
    intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", resumed: false }, wall: { files: [] }, implement: { exit: "done" },
    verify: { checks: [{ name: "bun:w.test.ts", cmd: "bun test", result: "pass", n: 2, duration_s: 1 }], flaky: [], wall_passed: true, target_checks: [] },
  } as Partial<Record<StageName, Obj>>;
  const ctx: RunContext = {
    runId: "r1", repoDir: repo, runDir, baseSha: base, branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {}, sessions: { run: async () => ({ exit: 0 }) as never },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() }, outputs: () => outputs, ...(started === null ? {} : { startedAtMs: started }),
  };
  const prev = process.env["LOKI_SEEDED_DEFECTS_DIR"];
  process.env["LOKI_SEEDED_DEFECTS_DIR"] = corpus;
  try {
    const r = await sealStage.run(ctx, new AbortController().signal), path = r.data.receipt_path as string;
    return { receipt: JSON.parse(readFileSync(path, "utf8")), path, runsRoot: join(repo, ".loki/runs"), version };
  } finally {
    if (prev === undefined) delete process.env["LOKI_SEEDED_DEFECTS_DIR"];
    else process.env["LOKI_SEEDED_DEFECTS_DIR"] = prev;
  }
}
const measured = (v: string): unknown => ({
  schema: "loki.seeded-defects.results/v2", manifest_sha256: v,
  runs: [
    { setup: "top", model: "x", outcomes: { a: "NOT_SEALED", b: "NOT_SEALED", c: "NOT_SEALED", d: "NOT_SEALED" } },
    { setup: "floor", model: "y", outcomes: { a: "NOT_SEALED", b: "NOT_SEALED", c: "NOT_SEALED", d: "SEALED" } },
  ],
});

const top = (v: string, o: Obj): unknown => ({ ...(measured(v) as Obj), runs: [{ setup: "top", model: "x", outcomes: o }, (measured(v) as { runs: unknown[] }).runs[1]] });
const all = (x: string): Obj => ({ a: x, b: x, c: x, d: x });
const corpusOf = (s: { receipt: Record<string, unknown> }): Obj => s.receipt["seeded_corpus"] as Obj;

describe("receipt records the seeded-defect corpus (TEN-GATES-15)", () => {
  test("version, defect count and worst-run catch rate are sealed, and verify rejects a tampered value", async () => {
    const s = await realSeal("g15a", null, measured);
    expect(s.receipt["seeded_corpus"]).toEqual({ corpus_version: s.version, corpus_defects: 4, catch_rate: 0.75 });
    expect("ablation" in s.receipt).toBe(false);
    expect((await verifyReceipt(s.path)).reasons.some((r) => r.startsWith("receipt_sha256 mismatch"))).toBe(false); // events.jsonl is absent in this fixture; integrity is what is under test
    for (const [k, v, orig] of [["catch_rate", 1, 0.75], ["corpus_version", "0".repeat(64), s.version], ["corpus_defects", 5, 4]] as const) {
      const t = JSON.parse(readFileSync(s.path, "utf8"));
      t.seeded_corpus[k] = v;
      writeFileSync(s.path, JSON.stringify(t, null, 2) + "\n");
      const bad = await verifyReceipt(s.path);
      expect(bad.verdict).toBe("TAMPERED");
      expect(bad.reasons[0]).toStartWith("receipt_sha256 mismatch");
      expect((await capture(["r1", "--allow-unsigned"], s.runsRoot)).rc).toBe(1);
      t.seeded_corpus[k] = orig;
      writeFileSync(s.path, JSON.stringify(t, null, 2) + "\n");
    }
  });
  test("a file planted in the agent's repo neither adds, removes nor changes the signed block (GATES-15 blocker)", async () => {
    const clean = corpusOf(await realSeal("g15p0", null, measured));
    for (const [n, planted, started] of [["g15p1", { status: "load_bearing" }, Date.now() - 60_000], ["g15p2", { status: "not_load_bearing" }, null], ["g15p3", { status: "not_applicable" }, Date.now() + 60_000], ["g15p4", { status: "load_bearing", corpus_version: "0".repeat(64), catch_rate: 1 }, Date.now() - 60_000]] as const) {
      const s = await realSeal(n, planted, measured, undefined, started);
      expect(corpusOf(s)).toEqual(clean);
      expect("ablation" in s.receipt).toBe(false);
    }
  });
  test("a results file for a different manifest gives catch_rate null, never a stale rate", async () => {
    expect(corpusOf(await realSeal("g15b", null, (v) => ({ ...(measured(v) as object), manifest_sha256: "f".repeat(64) })))["catch_rate"]).toBeNull();
  });
  test("catch_rate is null unless the results honour the p4 contract", async () => {
    const bad: [string, (v: string) => unknown][] = [
      ["g15c", (v) => ({ manifest_sha256: v, runs: [{ outcomes: {} }] })],
      ["g15d", (v) => ({ ...(measured(v) as Obj), runs: [(measured(v) as { runs: unknown[] }).runs[0]] })], // no floor run
      ["g15j", (v) => ({ ...(measured(v) as Obj), runs: [...(measured(v) as { runs: unknown[] }).runs, (measured(v) as { runs: unknown[] }).runs[0]] })], // two top runs
      ["g15k", (v) => top(v, { a: "NOT_SEALED", b: "NOT_SEALED", c: "NOT_SEALED" })], // missing a defect id
      ["g15l", (v) => top(v, { ...all("NOT_SEALED"), zz: "SEALED" })], // extra id
      ["g15m", (v) => top(v, { ...all("NOT_SEALED"), d: "PASS" })], // outcome outside the vocabulary
    ];
    for (const [n, r] of bad) expect(corpusOf(await realSeal(n, null, r))["catch_rate"]).toBeNull();
    expect(corpusOf(await realSeal("g15c2", null, null))["catch_rate"]).toBeNull();
    expect(corpusOf(await realSeal("g15n", null, (v) => top(v, all("SEALED"))))["catch_rate"]).toBe(0);
  });
  test("an unreadable or empty manifest leaves the key out or reports zero defects with no rate", async () => {
    expect("seeded_corpus" in (await realSeal("g15g", null, measured, "{not json")).receipt).toBe(false);
    expect(corpusOf(await realSeal("g15o", null, measured, '{"defects":[]}'))).toMatchObject({ corpus_defects: 0, catch_rate: null });
  });
  test("the shipped corpus is what an unconfigured seal signs", async () => {
    const prev = process.env["LOKI_SEEDED_DEFECTS_DIR"];
    delete process.env["LOKI_SEEDED_DEFECTS_DIR"];
    try {
      const shipped = seededCorpusBlock(process.env).seeded_corpus!;
      const bytes = readFileSync(join(REPO_ROOT, "benchmarks/seeded-defects/manifest.json"));
      expect(shipped.corpus_version).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(shipped.corpus_defects).toBe((JSON.parse(bytes.toString("utf8")) as { defects: unknown[] }).defects.length);
    } finally { if (prev !== undefined) process.env["LOKI_SEEDED_DEFECTS_DIR"] = prev; }
  });
});
