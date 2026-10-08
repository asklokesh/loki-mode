// MARK-1: machine-readable AI trailers on the Loki commit and a single marker line in the PR body. Off by default (LOKI_AI_MARKING=1).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiMarkerLine, aiTrailers, PR_BODY_LINE_BUDGET, renderPrBody, type PrBodyInput } from "../../src/engine10/pr_body.ts";
import { commitStage } from "../../src/engine10/stages/seal.ts";
import type { EventType, RunContext, StageName } from "../../src/engine10/types.ts";

let root = "";
const PRE = process.env["LOKI_AI_MARKING"];
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "loki-mark1.")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
afterEach(() => { if (PRE === undefined) delete process.env["LOKI_AI_MARKING"]; else process.env["LOKI_AI_MARKING"] = PRE; });

function sh(argv: string[], cwd: string, input?: string): string {
  const p = Bun.spawnSync({ cmd: argv, cwd, stdout: "pipe", stderr: "pipe", ...(input !== undefined ? { stdin: Buffer.from(input) } : {}) });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} -> ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
let n = 0;
async function commitWith(provider: string, model: string): Promise<{ repo: string; msg: string }> {
  const repo = join(root, `r${n++}`);
  sh(["mkdir", "-p", repo], root);
  sh(["git", "init", "-q", "-b", "main"], repo);
  sh(["git", "config", "user.name", "t"], repo); sh(["git", "config", "user.email", "t@test.invalid"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n"); sh(["git", "add", "a.txt"], repo); sh(["git", "commit", "-q", "-m", "base"], repo);
  const base = sh(["git", "rev-parse", "HEAD"], repo).trim();
  writeFileSync(join(repo, "a.txt"), "two\n");
  sh(["mkdir", "-p", ".loki/runs/r1"], repo);
  const outputs: Partial<Record<StageName, Record<string, unknown>>> = { intake: { title: "fix bug" } };
  const ctx: RunContext = {
    runId: "r1", repoDir: repo, runDir: join(repo, ".loki/runs/r1"), baseSha: base, branch: "loki/r1", provider, model, deep: false, capS: 900,
    emit: (_t: EventType, _s: StageName | null) => {},
    sessions: { run: async () => { throw new Error("none"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => 0 }, outputs: () => outputs,
  };
  const r = await commitStage.run(ctx, new AbortController().signal);
  expect(r.status).toBe("completed");
  return { repo, msg: sh(["git", "log", "-1", "--format=%B"], repo) };
}

describe("MARK-1 commit trailers", () => {
  test("flag off: the commit message is byte-identical to today", async () => {
    delete process.env["LOKI_AI_MARKING"];
    expect((await commitWith("claude", "opus")).msg).toBe("loki: fix bug\n\nLoki-Run: r1\n\n");
  });
  test("flag on: git interpret-trailers --parse returns all keys", async () => {
    process.env["LOKI_AI_MARKING"] = "1";
    const { repo, msg } = await commitWith("claude", "opus");
    const t = sh(["git", "interpret-trailers", "--parse"], repo, msg);
    expect(t.trim().split("\n")).toEqual(["Loki-Run: r1", "AI-Generated: true", "AI-Provider: claude", "AI-Model: opus", "Loki-Receipt: .loki/runs/r1/receipt.json"]);
    expect(msg).not.toMatch(/co-authored-by/i);
  });
  test("flag on: values with newlines cannot forge a trailer", async () => {
    process.env["LOKI_AI_MARKING"] = "1";
    const { repo, msg } = await commitWith("claude\nCo-authored-by: x <x@y>", "m\r\nSigned-off-by: z");
    const keys = sh(["git", "interpret-trailers", "--parse"], repo, msg).trim().split("\n").map((l) => l.split(":")[0]);
    expect(keys).toEqual(["Loki-Run", "AI-Generated", "AI-Provider", "AI-Model", "Loki-Receipt"]);
  });
  test("aiTrailers is empty unless the flag is exactly 1", () => {
    expect(aiTrailers({ runId: "r", provider: "p", model: "m", receiptRel: "x" }, {})).toEqual([]);
    expect(aiTrailers({ runId: "r", provider: "p", model: "m", receiptRel: "x" }, { LOKI_AI_MARKING: "0" })).toEqual([]);
    expect(aiTrailers({ runId: "r", provider: "p", model: "m", receiptRel: "x" }, { LOKI_AI_MARKING: "1" }).length).toBe(4);
  });
});

const body = (over: Partial<PrBodyInput> = {}): PrBodyInput => ({
  verdict: "VERIFIED", notProven: ["x"], receiptPath: "/r/receipt.json", capHit: false,
  outputs: { intake: { task: "Fix it\n- a\n- b" }, verify: { changed_files: ["a.ts"], checks: [{ name: "t", cmd: "bun test", result: "pass" }] } }, ...over,
});

describe("MARK-1 PR marker", () => {
  test("no marker input: body unchanged", () => {
    expect(renderPrBody(body())).toBe(renderPrBody(body({ aiMarker: undefined })));
    expect(renderPrBody(body())).not.toContain("AI-Generated");
  });
  test("marker is one line right after the verdict line, with the receipt link kept", () => {
    const m = aiMarkerLine({ runId: "r1", provider: "claude", model: "opus" }, { LOKI_AI_MARKING: "1" })!;
    expect(m).toBe("AI-Generated: true (Loki Mode, claude, opus, run r1)");
    const lines = renderPrBody(body({ aiMarker: m })).split("\n");
    const v = lines.findIndex((l) => l.startsWith("Verdict:"));
    expect(lines[v + 1]).toBe(m);
    expect(lines.filter((l) => l.includes("AI-Generated")).length).toBe(1);
    expect(lines).toContain("Receipt: /r/receipt.json");
  });
  test("aiMarkerLine is null when the flag is off and sanitizes values", () => {
    expect(aiMarkerLine({ runId: "r", provider: "p", model: "m" }, {})).toBeNull();
    expect(aiMarkerLine({ runId: "r", provider: "p\nq", model: "m" }, { LOKI_AI_MARKING: "1" })).not.toContain("\n");
  });
  test("with the marker the body still fits PR_BODY_LINE_BUDGET", () => {
    const criteria = Array.from({ length: 80 }, (_, i) => ({ text: `crit ${i}`, files: ["a.ts"], check: "t" }));
    const m = "AI-Generated: true (Loki Mode, claude, opus, run r1)";
    for (const aiMarker of [undefined, m]) {
      const lines = renderPrBody(body({ criteria, aiMarker, notProven: Array.from({ length: 30 }, (_, i) => `np ${i}`) })).trimEnd().split("\n");
      expect(lines.length).toBeLessThanOrEqual(PR_BODY_LINE_BUDGET);
      const exact = renderPrBody(body({ criteria, aiMarker })).trimEnd().split("\n"); // a body that fills the budget exactly without the marker
      expect(exact.length).toBeLessThanOrEqual(PR_BODY_LINE_BUDGET);
    }
  });
});
