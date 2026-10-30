// WC-01b: LOKI_E10_WALL_CONCURRENT=1 authors the Wall alongside plan and implement, installs once before verify.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooks } from "../../src/engine10/hooks.ts";
import { FLOW, runMachine } from "../../src/engine10/machine.ts";
import { verdictOf, wallGreenOnBaseOf } from "../../src/engine10/stages/seal.ts";
import { STEER_MAX_BYTES, staleAtSeal, staleReason, staleWallRevisions } from "../../src/util/steer.ts";
import type { RunContext, Stage, StageName, StageResult } from "../../src/engine10/types.ts";

type Ev = { type: string; stage: StageName | null; data: Record<string, unknown> };
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((res) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }); });
const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const dirs: string[] = [];
afterEach(() => { delete process.env.LOKI_E10_WALL_CONCURRENT; delete process.env.LOKI_E10_WALL_TIER; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Template repo built once; each test copies it instead of running git init/add/commit.
let templateDir = "", templateSha = "";
beforeAll(() => {
  templateDir = mkdtempSync(join(tmpdir(), "loki-wc01b-tpl-"));
  git(templateDir, "init", "-q"); writeFileSync(join(templateDir, "README.md"), "x\n"); git(templateDir, "add", "README.md"); git(templateDir, "commit", "-qm", "init");
  templateSha = git(templateDir, "rev-parse", "HEAD").trim();
});
afterAll(() => { rmSync(templateDir, { recursive: true, force: true }); });

function fixture() {
  const repoDir = mkdtempSync(join(tmpdir(), "loki-wc01b-repo-")); dirs.push(repoDir);
  cpSync(templateDir, repoDir, { recursive: true });
  const baseSha = templateSha;
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
  }, 15000);
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
    expect(r.outputs.wall).toEqual({ readOnlyFiles: [], duration_s: expect.any(Number) }); // duration_s is stamped on every completed stage (RECEIPT-TRUTH)
  });
  it("P12-02: a steer consumed during implement is stale against the concurrent Wall (timeline gets the wall start)", async () => {
    process.env.LOKI_E10_WALL_CONCURRENT = "1";
    const f = fixture(), s = stages(f, { authorMs: 80 });
    f.ctx.sessions = { run: async () => ({ exit: 0, durationMs: 1, text: "", stderrTail: "" }) as never };
    let stale: number[] = [];
    s.implement = { name: "implement", targetS: 1, limitS: 5, run: async (c: RunContext) => {
      mkdirSync(join(f.repoDir, ".loki"), { recursive: true }); writeFileSync(join(f.repoDir, ".loki", "HUMAN_INPUT.md"), "## Operator directive rev 1 (t) actor=a source=chat\nchange it\n");
      await sleep(5); await c.sessions.run({ stage: "implement", brief: "b" } as never); return { status: "completed", data: {} };
    } };
    s.seal = { name: "seal", targetS: 1, limitS: 5, run: async (c: RunContext) => { stale = staleWallRevisions(c.intentRevisions, c.timeline).map((r) => r.rev); return { status: "completed", data: {} }; } };
    await run(f, s);
    expect(stale).toEqual([1]);
  });
  it("P12-07d: the sequential Wall path also records start_ms", async () => {
    const f = fixture(), s = stages(f);
    s.wall = { name: "wall", targetS: 1, limitS: 5, run: async () => ({ status: "completed", data: { readOnlyFiles: [] } }) };
    await run(f, s);
    expect(typeof f.events.find((e) => e.type === "stage.started" && e.stage === "wall")?.data.start_ms).toBe("number");
  });
  it("P12-07d: the machine emits the applied revisions and the wall start so a resume can restore them", async () => {
    process.env.LOKI_E10_WALL_CONCURRENT = "1";
    const f = fixture(), s = stages(f, { authorMs: 80 });
    f.ctx.sessions = { run: async () => ({ exit: 0, durationMs: 1, text: "", stderrTail: "" }) as never };
    s.implement = { name: "implement", targetS: 1, limitS: 5, run: async (c: RunContext) => {
      mkdirSync(join(f.repoDir, ".loki"), { recursive: true }); writeFileSync(join(f.repoDir, ".loki", "HUMAN_INPUT.md"), "## Operator directive rev 1 (t) actor=a source=chat\nchange it\n");
      await sleep(5); await c.sessions.run({ stage: "implement", brief: "b" } as never); return { status: "completed", data: {} };
    } };
    await run(f, s);
    expect((f.events.find((e) => e.type === "intent.revised")?.data.revisions as { rev: number }[]).map((r) => r.rev)).toEqual([1]);
    expect(typeof f.events.find((e) => e.type === "stage.started" && e.stage === "wall")?.data.start_ms).toBe("number");
  });
  describe("P12-02b: following the Seal refusal remedy produces a run that seals", () => {
    const HDR = "## Operator directive rev 1 (t) actor=a source=chat\n";
    // Plan consumes a steer present at run start (plan||wall start together), Seal applies the real staleness check.
    const attempt = async (f: ReturnType<typeof fixture>) => {
      f.ctx.intentRevisions = undefined; f.ctx.timeline = undefined; f.log.length = 0;
      const s = stages(f), out: { status: string; reason?: string } = { status: "?" };
      s.plan = { name: "plan", targetS: 1, limitS: 5, run: async (c: RunContext) => { await c.sessions.run({ stage: "plan", brief: "b" } as never); return { status: "completed", data: {} }; } };
      s.seal = { name: "seal", targetS: 1, limitS: 5, run: async (c: RunContext) => { const st = staleAtSeal(c.repoDir, c); out.status = st.length ? "failed" : "completed"; if (st.length) out.reason = staleReason(st); return { status: "completed", data: {} }; } };
      f.ctx.sessions = { run: async () => ({ exit: 0, durationMs: 1, text: "", stderrTail: "" }) as never };
      await run(f, s); return out;
    };
    const cases: [string, (repo: string) => void, (repo: string) => void][] = [
      ["symlink", (r) => symlinkSync("/dev/null", join(r, ".loki/HUMAN_INPUT.md")), () => undefined],
      ["not a regular file", (r) => mkdirSync(join(r, ".loki/HUMAN_INPUT.md")), (r) => rmSync(join(r, ".loki/HUMAN_INPUT.md"), { recursive: true })],
      ["over 1 MiB", (r) => writeFileSync(join(r, ".loki/HUMAN_INPUT.md"), `${HDR}${"x".repeat(STEER_MAX_BYTES + 1)}`), () => undefined],
      ["logs dir unwritable or file unreadable", (r) => { writeFileSync(join(r, ".loki/logs"), "f"); writeFileSync(join(r, ".loki/HUMAN_INPUT.md"), `${HDR}go\n`); }, (r) => { rmSync(join(r, ".loki/HUMAN_INPUT.md")); rmSync(join(r, ".loki/logs")); mkdirSync(join(r, ".loki/logs")); }],
    ];
    for (const [reason, setup, remedy] of cases) {
      it(`${reason}: refused, then the remedy leaves a run that seals`, async () => {
        process.env.LOKI_E10_WALL_CONCURRENT = "1";
        const f = fixture(); mkdirSync(join(f.repoDir, ".loki"), { recursive: true }); setup(f.repoDir);
        const first = await attempt(f);
        expect(first.status).toBe("failed");
        expect(first.reason).toContain(`(${reason})`); expect(first.reason).toContain('delete .loki/HUMAN_INPUT.md and re-run with loki "<task with the steer folded in>"');
        // Follow the remedy exactly: delete .loki/HUMAN_INPUT.md (and make .loki/logs writable); the steer is folded into the task, not left in place.
        remedy(f.repoDir); expect(lstatSync(join(f.repoDir, ".loki/HUMAN_INPUT.md"), { throwIfNoEntry: false })).toBeUndefined();
        expect((await attempt(f)).status).toBe("completed");
      });
    }
    it("control: leaving the steer in place (the old remedy) is refused again", async () => {
      process.env.LOKI_E10_WALL_CONCURRENT = "1";
      const f = fixture(); mkdirSync(join(f.repoDir, ".loki"), { recursive: true });
      writeFileSync(join(f.repoDir, ".loki/HUMAN_INPUT.md"), `${HDR}go\n`);
      expect((await attempt(f)).status).toBe("failed");
    });
  });
});

describe("RUN5-C1 concurrent Wall is the default", () => {
  // A fake snapshot hook: these tests pin ordering and blindness, so they must not depend on a real copy succeeding (the whole-directory run pollutes the environment the real copy needs, which already reds the WC-01b tests above there).
  const saved = hooks.wall; const snaps: string[] = [];
  beforeEach(() => { hooks.wall = { snapshotTree: async () => { const d = mkdtempSync(join(tmpdir(), "loki-run5c1-snap-")); snaps.push(d); return d; }, changedSinceBase: () => [], manifests: /package\.json$/ }; });
  afterEach(() => { hooks.wall = saved; for (const d of snaps.splice(0)) rmSync(d, { recursive: true, force: true }); });
  it("with the knob unset and sonnet already the Wall model, the Wall is authored concurrently and installed once before verify", async () => {
    delete process.env.LOKI_E10_WALL_CONCURRENT; process.env.LOKI_E10_WALL_TIER = "sonnet";
    const f = fixture(), r = await run(f, stages(f, { authorMs: 80 }));
    expect(f.log.indexOf("implement:start")).toBeLessThan(f.log.indexOf("author:end"));
    expect(f.log.filter((x) => x === "install")).toHaveLength(1);
    expect(f.log.indexOf("install")).toBeLessThan(f.log.indexOf("verify"));
    expect(r.outputs.wall?.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
  }, 15000);
  it("an unreproduced-evidence Wall green on base keeps its base run when implement touched files, so seal stays PARTIAL", async () => {
    delete process.env.LOKI_E10_WALL_CONCURRENT; process.env.LOKI_E10_WALL_TIER = "sonnet";
    const verdictFor = async (flagged: boolean) => {
      hooks.wall = { ...hooks.wall!, changedSinceBase: () => ["src/a.ts"] }; // implement touched a file: the unsure branch
      const f = fixture(), s = stages(f), split = (s.wall as unknown as { split: { install: (c: RunContext, a: never, b: string) => StageResult } }).split;
      split.install = () => ({ status: "completed", data: { files: [], readOnlyFiles: [], already_satisfied: false, green_on_base: true, base_run: { pass: 1, fail: 0, not_run: 0 }, ...(flagged ? { reproduction_green_on_base: true } : {}) } });
      const r = await run(f, s), o = { wall: r.outputs.wall, implement: { exit: "done" }, intake: {} } as never;
      return { v: verdictOf(o, [{ name: "t", cmd: "t", result: "pass", duration_s: 0 }], false, false, wallGreenOnBaseOf(o), true), base: r.outputs.wall?.base_run };
    };
    const yes = await verdictFor(true);
    expect(yes.base).toEqual({ pass: 1, fail: 0, not_run: 0 }); expect(yes.v).toBe("PARTIAL");
    expect((await verdictFor(false)).base).toEqual({ pass: 1, fail: 0, not_run: 1, unproven: true }); // unchanged distrust for an ordinary green
  }, 15000);
  it("with the knob unset and no pin (haiku-first routing) the Wall stays sequential even when the stage has a split", async () => {
    delete process.env.LOKI_E10_WALL_CONCURRENT; delete process.env.LOKI_E10_WALL_TIER;
    const f0 = fixture(), s0 = stages(f0);
    s0.wall = { ...(s0.wall as Stage), run: async () => { f0.log.push("wall:seq"); return { status: "completed", data: { readOnlyFiles: [] } }; } };
    await run(f0, s0);
    expect(f0.log).not.toContain("install"); expect(f0.log.indexOf("wall:seq")).toBeLessThan(f0.log.indexOf("implement:start"));
  });
  it("LOKI_E10_WALL_CONCURRENT=0 forces the sequential Wall even under a sonnet pin", async () => {
    process.env.LOKI_E10_WALL_CONCURRENT = "0"; process.env.LOKI_E10_WALL_TIER = "sonnet";
    const f = fixture(), s = stages(f);
    s.wall = { ...(s.wall as Stage), run: async () => { f.log.push("wall:seq"); return { status: "completed", data: { readOnlyFiles: [] } }; } };
    await run(f, s);
    expect(f.log).not.toContain("author:start"); expect(f.log).not.toContain("install");
    expect(f.log.indexOf("wall:seq")).toBeLessThan(f.log.indexOf("implement:start"));
  });
  it("blind: no Wall content reaches the implement stage, in its tree or in the outputs it can read", async () => {
    delete process.env.LOKI_E10_WALL_CONCURRENT; process.env.LOKI_E10_WALL_TIER = "sonnet";
    const MARK = "WALL_CONTENT_MARKER_7f3a";
    const f = fixture(), s = stages(f, { authorMs: 30 });
    const split = (s.wall as unknown as { split: { author: (c: RunContext, sig: AbortSignal) => Promise<Record<string, unknown>>; install: (c: RunContext, a: never, b: string) => StageResult } }).split;
    const inner = split.author; split.author = async (c, sig) => ({ ...(await inner(c, sig)), contents: new Map([["loki_wall_a.test.ts", `${MARK}\n`]]) });
    const innerInstall = split.install; split.install = (c, a, b) => { const r = innerInstall(c, a, b); writeFileSync(join(f.repoDir, "tests", "loki_wall_a.test.ts"), `${MARK}\n`); return r; };
    const scan = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === ".git" ? [] : e.isDirectory() ? scan(join(dir, e.name)) : [join(dir, e.name)]);
    let leaked: string[] | null = null;
    s.implement = { name: "implement", targetS: 1, limitS: 5, run: async (c: RunContext) => {
      await sleep(120); // the author has finished by now; the Wall is authored but must still be uninstalled
      leaked = [...scan(f.repoDir).filter((p) => readFileSync(p, "utf8").includes(MARK)), ...(JSON.stringify(c.outputs()).includes(MARK) ? ["outputs"] : [])];
      return { status: "completed", data: {} };
    } };
    await run(f, s);
    expect(f.log).toContain("author:end"); expect(f.log).toContain("install");
    expect(leaked as string[] | null).toEqual([]); // null would mean implement never ran
  }, 15000);
});
