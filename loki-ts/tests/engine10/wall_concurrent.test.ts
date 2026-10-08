// WC-01b: LOKI_E10_WALL_CONCURRENT=1 authors the Wall alongside plan and implement, installs once before verify.
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOW, runMachine } from "../../src/engine10/machine.ts";
import type { RunContext, Stage, StageName, StageResult } from "../../src/engine10/types.ts";

type Ev = { type: string; stage: StageName | null; data: Record<string, unknown> };
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((res) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }); });
const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const dirs: string[] = [];
afterEach(() => { delete process.env.LOKI_E10_WALL_CONCURRENT; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const repoDir = mkdtempSync(join(tmpdir(), "loki-wc01b-repo-")); dirs.push(repoDir);
  git(repoDir, "init", "-q"); writeFileSync(join(repoDir, "README.md"), "x\n"); git(repoDir, "add", "README.md"); git(repoDir, "commit", "-qm", "init");
  const baseSha = git(repoDir, "rev-parse", "HEAD").trim();
  const events: Ev[] = [], log: string[] = [];
  const ctx: RunContext = {
    runId: "wc01b", repoDir, runDir: join(repoDir, ".run"), baseSha, branch: "b", provider: "claude", model: "fake", deep: false, capS: 900,
    emit: (type, stage, data) => { events.push({ type, stage, data }); },
    sessions: { run: async () => { throw new Error("no sessions"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() }, outputs: () => ({}),
  };
  return { ctx, events, log, repoDir };
}

function stages(f: ReturnType<typeof fixture>, o: { authorMs?: number; implement?: (repo: string) => void; installBase?: string[] } = {}): Partial<Record<StageName, Stage>> {
  const mk = (name: StageName, run?: Stage["run"]): Stage => ({ name, targetS: 1, limitS: 5, run: run ?? (async () => { f.log.push(name); return { status: "completed", data: {} }; }) });
  const wall = {
    ...mk("wall", async () => { throw new Error("sequential wall must not run under the flag"); }),
    split: {
      author: async (_c: RunContext, signal: AbortSignal) => {
        f.log.push("author:start"); await sleep(o.authorMs ?? 60, signal);
        if (signal.aborted) throw new Error("aborted");
        f.log.push("author:end");
        return { kind: "authored", targetDir: join(f.repoDir, "tests"), contents: new Map([["loki_wall_a.test.ts", "t\n"]]) };
      },
      install: (_c: RunContext, a: { contents: Map<string, string> }, baseDir: string): StageResult => {
        f.log.push("install"); o.installBase?.push(baseDir);
        o.installBase?.push(existsSync(join(baseDir, "tests", "loki_wall_a.test.ts")) ? "base-has-wall" : "base-missing-wall");
        mkdirSync(join(f.repoDir, "tests"), { recursive: true }); writeFileSync(join(f.repoDir, "tests", "loki_wall_a.test.ts"), "t\n");
        return { status: "completed", data: { files: [], readOnlyFiles: [], base_run: { pass: 0, fail: 1, not_run: 0 }, already_satisfied: false } };
      },
    },
  } as Stage;
  return {
    intake: mk("intake"), plan: mk("plan", async () => { f.log.push("plan"); await sleep(10); return { status: "completed", data: {} }; }), wall,
    implement: mk("implement", async () => { f.log.push("implement:start"); await sleep(10); o.implement?.(f.repoDir); f.log.push(`implement:tree:${existsSync(join(f.repoDir, "tests", "loki_wall_a.test.ts")) ? "sealed" : "clean"}`); return { status: "completed", data: {} }; }),
    verify: mk("verify", async () => { f.log.push("verify"); return { status: "completed", data: {} }; }), fix: mk("fix"), commit: mk("commit"), seal: mk("seal"), pr: mk("pr"),
  };
}
const run = (f: ReturnType<typeof fixture>, s: Partial<Record<StageName, Stage>>) => runMachine(f.ctx, { load: async (n) => s[n] ?? null, flow: FLOW });

describe("WC-01b wall concurrent", () => {
  it("implement starts before the author ends; its tree has no sealed path; install happens once, before verify", async () => {
    process.env.LOKI_E10_WALL_CONCURRENT = "1";
    const f = fixture(), bases: string[] = [], r = await run(f, stages(f, { authorMs: 80, installBase: bases }));
    expect(f.log.indexOf("implement:start")).toBeLessThan(f.log.indexOf("author:end"));
    expect(f.log).toContain("implement:tree:clean");
    expect(f.log.filter((x) => x === "install")).toHaveLength(1);
    expect(f.log.indexOf("install")).toBeLessThan(f.log.indexOf("verify"));
    expect(f.log.indexOf("author:end")).toBeLessThan(f.log.indexOf("install"));
    expect(r.outputs.wall?.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
    expect(bases[0]).not.toBe(f.repoDir); expect(bases[1]).toBe("base-has-wall");
    expect(existsSync(bases[0]!)).toBe(false); // base worktree removed
  });
  it("records deps:head when implement touched a manifest", async () => {
    process.env.LOKI_E10_WALL_CONCURRENT = "1";
    const f = fixture(), r = await run(f, stages(f, { implement: (repo) => writeFileSync(join(repo, "package.json"), "{}\n") }));
    expect((r.outputs.wall?.base_run as { deps?: string }).deps).toBe("head");
  });
  it("no deps field when implement touched no manifest", async () => {
    process.env.LOKI_E10_WALL_CONCURRENT = "1";
    const f = fixture(), r = await run(f, stages(f, { implement: (repo) => writeFileSync(join(repo, "src.ts"), "x\n") }));
    expect((r.outputs.wall?.base_run as { deps?: string }).deps).toBeUndefined();
  });
  it("an abort before install installs nothing", async () => {
    process.env.LOKI_E10_WALL_CONCURRENT = "1";
    const f = fixture(), s = stages(f, { authorMs: 5000 });
    s.implement = { name: "implement", targetS: 1, limitS: 5, run: async () => ({ status: "failed", data: {}, reason: "boom" }) };
    await run(f, s);
    expect(f.log).not.toContain("install"); expect(existsSync(join(f.repoDir, "tests"))).toBe(false);
  });
  it("flag off: the original sequential wall runs and split is never used", async () => {
    const f = fixture(), s = stages(f);
    s.wall = { name: "wall", targetS: 1, limitS: 5, run: async () => { f.log.push("wall:seq"); return { status: "completed", data: { readOnlyFiles: [] } }; } };
    const r = await run(f, s);
    expect(f.log).toEqual(["intake", "plan", "wall:seq", "implement:start", "implement:tree:clean", "verify", "commit", "seal", "pr"]);
    expect(r.outputs.wall).toEqual({ readOnlyFiles: [] });
  });
});
