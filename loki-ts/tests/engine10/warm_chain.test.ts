// CH-03: warm chain plan -> implement -> fix 1..n over one SDK session (default OFF, LOKI_E10_FIX_RESUME=1 opts in).
// Mocked sessions only. Wall, verify and seal never join the chain.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import type { FailureGroup } from "../../src/engine10/failures.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner, StageName } from "../../src/engine10/types.ts";

const ok: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
const groups: FailureGroup[] = [{ signature: "AssertionError: x", count: 1, sample: "expected 1 to equal 2" }];
const KEYS = ["LOKI_E10_FIX_RESUME", "LOKI_E10_INVOKER", "LOKI_E10_RESUME_SESSION", "LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_FAST", "LOKI_ALLOW_HAIKU", "LOKI_ROUTER", "LOKI_E10_CASCADE"];
let repo: string;
let backup: Record<string, string | undefined>;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "loki-warmchain-"));
  backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env["LOKI_E10_FIX_RESUME"] = "1";
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const k of KEYS) { if (backup[k] === undefined) delete process.env[k]; else process.env[k] = backup[k]; }
});

function writeId(iter: string, id: string): void {
  mkdirSync(join(repo, ".loki"), { recursive: true });
  writeFileSync(join(repo, ".loki", `e10-session-${iter}.json`), JSON.stringify({ session_id: id }));
}
function writeCost(iter: string, firstTurn: number): void {
  mkdirSync(join(repo, ".loki", "metrics"), { recursive: true });
  writeFileSync(join(repo, ".loki", "metrics", `result-cost-${iter}.json`), JSON.stringify({ total_cost_usd: 0.1, first_turn_prompt_tokens: firstTurn }));
}
class Fake implements SessionRunner {
  calls: SessionRunOptions[] = [];
  constructor(private script: (o: SessionRunOptions, n: number) => SessionResult & { stderrTail?: string }) {}
  async run(o: SessionRunOptions): Promise<SessionResult> { this.calls.push(o); return this.script(o, this.calls.length); }
}
function ctxFor(sessions: SessionRunner, outputs: Partial<Record<StageName, Record<string, unknown>>>, model = "sonnet", provider = "claude"): RunContext {
  return {
    runId: "r1", repoDir: repo, runDir: join(repo, ".loki/runs/r1"), baseSha: "x", branch: "b", provider, model, deep: false, capS: 900,
    emit: () => {}, sessions,
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => 0 }, outputs: () => outputs,
  };
}
const planOut = { plan: "do the thing", relevant_files: [], iteration_ids: ["r1-plan"] };
const runImpl = (c: RunContext) => implementStage.run(c, new AbortController().signal);

describe("warm chain: plan -> implement (CH-03)", () => {
  test("implement resumes plan's session on the same model, with the full brief", async () => {
    writeId("r1-plan", "sess-plan");
    const s = new Fake(() => ok);
    const r = await runImpl(ctxFor(s, { intake: { task: "do it" }, plan: planOut }));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.resumeSessionId).toBe("sess-plan");
    expect(s.calls[0]!.brief).toContain("do it");
    expect(s.calls[0]!.brief).toContain("do the thing");
    expect(r.data.plan_chain).toBe("resumed");
  });

  test("a model mismatch starts a fresh session and records why", async () => {
    writeId("r1-plan", "sess-plan");
    const s = new Fake(() => ok);
    const r = await runImpl(ctxFor(s, { intake: { task: "do it" }, plan: planOut }, "opus"));
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
    expect(String(r.data.plan_chain)).toBe("fresh (model changed sonnet -> opus)");
  });

  test("a failed plan (no plan text) or missing session id starts fresh", async () => {
    writeId("r1-plan", "sess-plan");
    let s = new Fake(() => ok);
    await runImpl(ctxFor(s, { intake: { task: "t" }, plan: { iteration_ids: ["r1-plan"] } }));
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
    s = new Fake(() => ok);
    const r = await runImpl(ctxFor(s, { intake: { task: "t" }, plan: { ...planOut, iteration_ids: ["r1-other"] } }));
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
    expect(r.data.plan_chain).toBe("fresh (no plan session id recorded)");
  });

  test("flag unset (default) never resumes", async () => {
    delete process.env["LOKI_E10_FIX_RESUME"];
    writeId("r1-plan", "sess-plan");
    const s = new Fake(() => ok);
    const r = await runImpl(ctxFor(s, { intake: { task: "t" }, plan: planOut }));
    expect("resumeSessionId" in s.calls[0]!).toBe(false);
    expect(r.data.plan_chain).toBe("fresh (LOKI_E10_FIX_RESUME is not 1)");
  });

  test("first turn above 100K tokens starts fresh", async () => {
    writeId("r1-plan", "sess-plan");
    writeCost("r1-plan", 100_001);
    const s = new Fake(() => ok);
    const r = await runImpl(ctxFor(s, { intake: { task: "t" }, plan: planOut }));
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
    expect(String(r.data.plan_chain)).toContain("above 100000");
  });

  test("a failed resume reruns fresh with the same full brief and no resume option", async () => {
    writeId("r1-plan", "sess-plan");
    const s = new Fake((o) => (o.resumeSessionId ? { ...ok, exit: 1 } : ok));
    const r = await runImpl(ctxFor(s, { intake: { task: "do it" }, plan: planOut }));
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.resumeSessionId).toBeUndefined();
    expect(s.calls[1]!.brief).toBe(s.calls[0]!.brief);
    expect(s.calls[1]!.iterationId).toBe("r1-implf");
    expect(r.status).toBe("completed");
    expect(r.data.iteration_ids).toEqual(["r1-impl", "r1-implf"]);
  });

  test("a resumed implement still restores read-only Wall files", async () => {
    writeId("r1-plan", "sess-plan");
    const f = join(repo, "wall.test.ts");
    writeFileSync(f, "sealed");
    const s = new Fake(() => { writeFileSync(f, "tampered"); return ok; });
    const r = await runImpl(ctxFor(s, { intake: { task: "t" }, plan: planOut, wall: { readOnlyFiles: [{ path: f, content: "sealed" }] } }));
    expect(s.calls[0]!.resumeSessionId).toBe("sess-plan");
    expect(readFileSync(f, "utf8")).toBe("sealed");
    expect(r.data.tests_reverted).toEqual([f]);
  });
});

describe("warm chain: fix rounds (CH-03)", () => {
  const impl = { diff_stat: "1 file", model: "sonnet", session_id: "sess-impl", iteration_ids: ["r1-impl"] };
  const runFix = (c: RunContext) => fixStage.run(c, new AbortController().signal);

  test("fix round 1 resumes implement with the flag on", async () => {
    const s = new Fake(() => ok);
    const r = await runFix(ctxFor(s, { intake: { task: "t" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls[0]!.resumeSessionId).toBe("sess-impl");
    expect(r.data.fix_resume).toBe("resumed");
  });

  test("fix round with the flag unset starts fresh", async () => {
    delete process.env["LOKI_E10_FIX_RESUME"];
    const s = new Fake(() => ok);
    const r = await runFix(ctxFor(s, { intake: { task: "t" }, verify: { failures_grouped: groups }, implement: impl }));
    expect("resumeSessionId" in s.calls[0]!).toBe(false);
    expect(r.data.fix_resume).toBe("fresh");
  });

  test("implement first turn above 100K starts the fix round fresh", async () => {
    writeCost("r1-impl", 150_000);
    const s = new Fake(() => ok);
    const r = await runFix(ctxFor(s, { intake: { task: "t" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
    expect(String(r.data.fix_resume_why)).toContain("above 100000");
  });
});

describe("warm chain: Wall, verify and seal never join (CH-03)", () => {
  test("wall's child env never has LOKI_E10_RESUME_SESSION, even when the parent leaks it", async () => {
    const runner = createSessionRunner({ provider: "claude", childCommand: ["sh", ["-c", "echo R=$LOKI_E10_RESUME_SESSION"]] });
    process.env["LOKI_E10_RESUME_SESSION"] = "leaked";
    const r = await runner.run({ stage: "wall", brief: "b", tier: "development", model: "sonnet", iterationId: "w", limitS: 10, signal: new AbortController().signal, cwd: repo });
    expect(r.summary).toContain("R=");
    expect(r.summary).not.toContain("leaked");
  });

  test("wall, verify and seal sources never reference resume or the chain module", () => {
    const dir = join(import.meta.dir, "..", "..", "src", "engine10", "stages");
    for (const f of ["wall.ts", "verify.ts", "seal.ts"]) expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/resumeSessionId|session_resume|RESUME_SESSION|planChain/);
  });
});

describe("warm chain: FC-43 empty-done resume stays unchained (CH-03)", () => {
  let g: string, base: string;
  const git = (args: string[]): string => execFileSync("git", args, { cwd: g, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  beforeEach(() => {
    g = mkdtempSync(join(tmpdir(), "loki-warmchain-git-"));
    git(["init", "-q"]);
    writeFileSync(join(g, "a.txt"), "one\n");
    writeFileSync(join(g, ".gitignore"), ".loki/\n");
    git(["add", "a.txt", ".gitignore"]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    base = git(["rev-parse", "HEAD"]);
    mkdirSync(join(g, ".loki"), { recursive: true });
    writeFileSync(join(g, ".loki", "e10-session-r1-plan.json"), JSON.stringify({ session_id: "sess-plan" }));
  });
  afterEach(() => rmSync(g, { recursive: true, force: true }));
  const ctxG = (s: SessionRunner): RunContext => ({ ...ctxFor(s, { intake: { task: "do it" }, plan: planOut }), repoDir: g, baseSha: base });

  test("the empty-done resume never inherits the plan session id", async () => {
    const s = new Fake(() => ok); // implement session records no id of its own
    await runImpl(ctxG(s));
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]!.resumeSessionId).toBe("sess-plan");
    expect(s.calls[1]!.iterationId).toBe("r1-impl-e");
    expect(s.calls[1]!.resumeSessionId).toBeUndefined();
  });

  test("after a failed-resume retry the empty-done resume continues the retry iteration", async () => {
    const s = new Fake((o) => (o.resumeSessionId ? { ...ok, exit: 1 } : ok));
    const r = await runImpl(ctxG(s));
    expect(s.calls.map((c) => c.iterationId)).toEqual(["r1-impl", "r1-implf", "r1-implf-e"]);
    expect(s.calls[2]!.resumeSessionId).toBeUndefined();
    expect(r.data.iteration_ids).toEqual(["r1-impl", "r1-implf", "r1-implf-e"]);
  });
});
