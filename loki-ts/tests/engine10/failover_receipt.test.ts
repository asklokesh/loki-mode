// T9: the sealed receipt carries the provider failover records; a run with none has no `failover` key (hash stays stable).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealStage } from "../../src/engine10/stages/seal.ts";
import type { FailoverRecord } from "../../src/runner/provider_failover.ts";
import type { Obj, RunContext, StageName } from "../../src/engine10/types.ts";

let tmp = "";
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "t9-failover-")); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

const sh = (cwd: string, ...argv: string[]): string => execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" });
async function seal(name: string, failovers?: () => FailoverRecord[]): Promise<Record<string, unknown>> {
  const repo = join(tmp, name);
  mkdirSync(join(repo, ".loki/runs/r1"), { recursive: true });
  sh(repo, "git", "init", "-q", "-b", "main");
  sh(repo, "git", "config", "user.name", "t"); sh(repo, "git", "config", "user.email", "t@t.invalid");
  writeFileSync(join(repo, "a.txt"), "one\n"); sh(repo, "git", "add", "a.txt"); sh(repo, "git", "commit", "-q", "-m", "base");
  const base = sh(repo, "git", "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "a.txt"), "two\n"); sh(repo, "git", "commit", "-q", "-am", "work");
  const outputs = {
    intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", resumed: false }, wall: { files: [] }, implement: { exit: "done" },
    verify: { checks: [{ name: "bun:w.test.ts", cmd: "bun test", result: "pass", n: 2, duration_s: 1 }], flaky: [], wall_passed: true, target_checks: [] },
  } as Partial<Record<StageName, Obj>>;
  const ctx: RunContext = {
    runId: "r1", repoDir: repo, runDir: join(repo, ".loki/runs/r1"), baseSha: base, branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {}, sessions: { run: async () => ({ exit: 0 }) as never },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() }, outputs: () => outputs, ...(failovers ? { failovers } : {}),
  };
  const r = await sealStage.run(ctx, new AbortController().signal);
  return JSON.parse(readFileSync(r.data.receipt_path as string, "utf8"));
}

describe("failover on the receipt", () => {
  test("records stage, from, to, reason and the evidence line", async () => {
    const rec: FailoverRecord = { stage: "implement", from: "claude", to: "codex", reason: "rate_limit", evidence: "429 rate_limit_error" };
    const r = await seal("with", () => [rec]);
    expect(r.failover).toEqual([rec]);
  });
  test("a none-available record keeps the note", async () => {
    const rec: FailoverRecord = { stage: "implement", from: "claude", to: null, reason: "outage", evidence: "503 service unavailable", note: "failover: none available" };
    expect(((await seal("none", () => [rec])).failover as FailoverRecord[])[0]!.note).toBe("failover: none available");
  });
  test("no failover leaves the key out", async () => {
    expect("failover" in (await seal("empty", () => []))).toBe(false);
    expect("failover" in (await seal("unset"))).toBe(false);
  });
});
