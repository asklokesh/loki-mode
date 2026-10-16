// MW-2 / CH-03: LOKI_E10_FIX_RESUME (default off; =1 opts in; CH-03 flips the default after RECEIPT-TRUTH). A fix round resumes the implement session; every failure path
// starts fresh and records why. Mocked sessions only: no real model, no query().
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import type { FailureGroup } from "../../src/engine10/failures.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner, StageName } from "../../src/engine10/types.ts";

const groups: FailureGroup[] = [{ signature: "AssertionError: x", count: 1, sample: "expected 1 to equal 2" }];
const ok: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
let repo: string;
let envBackup: Record<string, string | undefined>;
const KEYS = ["LOKI_E10_FIX_RESUME", "LOKI_E10_INVOKER", "LOKI_E10_RESUME_SESSION"];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "loki-fixresume-"));
  envBackup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const k of KEYS) { if (envBackup[k] === undefined) delete process.env[k]; else process.env[k] = envBackup[k]; }
});

function writeId(iter: string, id: string): void {
  mkdirSync(join(repo, ".loki"), { recursive: true });
  writeFileSync(join(repo, ".loki", `e10-session-${iter}.json`), JSON.stringify({ session_id: id }));
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
    cost: { read: (_r, ids) => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: ids.some((i) => i.endsWith("f")) ? 7 : 123 }) },
    clock: { now: () => 0 }, outputs: () => outputs,
  };
}
const impl = { diff_stat: "1 file", model: "sonnet", session_id: "sess-impl" };
const run = (c: RunContext) => fixStage.run(c, new AbortController().signal);

describe("fix resume (MW-2)", () => {
  test("flag unset reproduces the old behaviour: one fresh session, full brief, no resume option", async () => {
    const s = new Fake(() => ok);
    const r = await run(ctxFor(s, { intake: { task: "do it" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(1);
    expect("resumeSessionId" in s.calls[0]!).toBe(false);
    expect(s.calls[0]!.brief).toContain("do it");
    expect(s.calls[0]!.iterationId).toBe("r1-fix1");
    expect(r.data.fix_resume).toBe("fresh");
    expect(r.data.iteration_ids).toEqual(["r1-fix1"]);
  });

  test("flag on passes resume with the captured implement session id and sends only the failure turn", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake(() => { writeId("r1-fix1", "sess-fix1"); return ok; });
    const r = await run(ctxFor(s, { intake: { task: "do it" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.resumeSessionId).toBe("sess-impl");
    expect(s.calls[0]!.brief).toContain("expected 1 to equal 2");
    expect(s.calls[0]!.brief).not.toContain("do it");
    expect(r.data.fix_resume).toBe("resumed");
    expect(r.data.session_id).toBe("sess-fix1");
    expect(r.data.fix_rounds).toEqual([{ round: 1, fix_resume: "resumed", cache_read_tokens: 123 }]);
  });

  test("round 2 resumes the latest session of the chain", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake(() => ok);
    await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl, fix: { round: 1, session_id: "sess-fix1", model: "sonnet", signatures: "other" } }));
    expect(s.calls[0]!.resumeSessionId).toBe("sess-fix1");
  });

  test("a resume error falls back to a fresh session and records the reason", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake((o) => (o.resumeSessionId ? { ...ok, exit: 1, stderrTail: "[sdk-loop error: No conversation found with session ID sess-impl]" } : ok));
    const r = await run(ctxFor(s, { intake: { task: "do it" }, verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.resumeSessionId).toBeUndefined();
    expect(s.calls[1]!.brief).toContain("do it");
    expect(s.calls[1]!.iterationId).toBe("r1-fix1f");
    expect(r.status).toBe("completed");
    expect(r.data.fix_resume).toBe("fallback (No conversation found with session ID sess-impl)");
    expect(r.data.iteration_ids).toEqual(["r1-fix1", "r1-fix1f"]);
    expect((r.data.fix_rounds as { cache_read_tokens: number }[])[0]!.cache_read_tokens).toBe(7);
  });

  test("a timeout kill is not retried (never stalls the run)", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake(() => ({ ...ok, exit: null, killed: true }));
    const r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl }));
    expect(s.calls).toHaveLength(1);
    expect(r.data.killed).toBe(true);
  });

  test("fallback when there is no session id, a non-claude provider, or the CLI invoker", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    let s = new Fake(() => ok);
    let r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: { diff_stat: "x" } }));
    expect(r.data.fix_resume).toBe("fallback (no session id recorded)");
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
    s = new Fake(() => ok);
    r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl }, "sonnet", "codex"));
    expect(r.data.fix_resume).toBe("fallback (provider is not the SDK)");
    process.env["LOKI_E10_INVOKER"] = "cli";
    s = new Fake(() => ok);
    r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl }));
    expect(r.data.fix_resume).toBe("fallback (provider is not the SDK)");
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
  });

  test("escalation to a different model starts fresh and records why (L1)", async () => {
    process.env["LOKI_E10_FIX_RESUME"] = "1";
    const s = new Fake(() => ok);
    const r = await run(ctxFor(s, { verify: { failures_grouped: groups }, implement: impl, fix: { round: 1, signatures: "AssertionError: x", model: "sonnet", session_id: "sess-fix1" } }, "sonnet"));
    expect(s.calls[0]!.model).toBeDefined(); // escalated pin
    expect(s.calls[0]!.resumeSessionId).toBeUndefined();
    expect(r.data.fix_resume).toBe("fresh");
    expect(String(r.data.fix_resume_why)).toContain("model changed sonnet ->");
  });

  test("the session runner exports the resume id to the child only when asked", async () => {
    const runner = createSessionRunner({ provider: "claude", childCommand: ["sh", ["-c", "echo R=$LOKI_E10_RESUME_SESSION"]] });
    const base = { stage: "fix" as const, brief: "b", tier: "development" as const, iterationId: "i", limitS: 10, signal: new AbortController().signal, cwd: repo };
    process.env["LOKI_E10_RESUME_SESSION"] = "leaked";
    expect((await runner.run({ ...base, resumeSessionId: "abc" })).summary).toContain("R=abc");
    const plain = (await runner.run(base)).summary ?? "";
    expect(plain).toContain("R=");
    expect(plain).not.toContain("leaked");
  });
});

describe("fix resume trust and mutation (MW-2)", () => {
  const SRC = join(import.meta.dir, "..", "..", "src");
  test("seal reads only the engine-recorded fix_rounds, never a session id, transcript or resume module", () => {
    const seal = readFileSync(join(SRC, "engine10/stages/seal.ts"), "utf8");
    expect(seal).not.toMatch(/session_resume|e10-session|resumeSessionId|LOKI_E10_RESUME_SESSION|LOKI_E10_FIX_RESUME/);
    const fixRefs = [...seal.matchAll(/\bo\.fix\??\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(fixRefs)).toEqual(new Set(["fix_rounds"]));
    for (const f of ["verify.ts", "wall.ts"]) expect(readFileSync(join(SRC, "engine10/stages", f), "utf8")).not.toMatch(/session_resume|e10-session/);
  });

  test("mutation: dropping the resume option from runFixSession turns the resume assertion red", async () => {
    const orig = readFileSync(join(SRC, "runner/session_resume.ts"), "utf8");
    const mutated = orig.replace(/, \.\.\.\(resumeId \? \{ resumeSessionId: resumeId \} : \{\}\)/, "");
    expect(mutated).not.toBe(orig);
    const dir = mkdtempSync(join(tmpdir(), "loki-fixresume-mut-"));
    try {
      const file = join(dir, "mut.ts");
      writeFileSync(file, mutated.replace(/from "\.\.\/engine10\//g, `from "${join(SRC, "engine10")}/`));
      const mod = await import(file);
      process.env["LOKI_E10_FIX_RESUME"] = "1";
      const s = new Fake(() => ok);
      await mod.runFixSession(ctxFor(s, {}), { stage: "fix", tier: "development", limitS: 1, signal: new AbortController().signal }, "r1-fix1", [], { sessionId: "sess-impl", model: "sonnet" }, "sonnet", "full", "resume");
      // The real test asserts resumeSessionId === "sess-impl"; under the mutation it is undefined, so that assertion goes red.
      expect(s.calls[0]!.resumeSessionId).toBeUndefined();
      expect(s.calls[0]!.resumeSessionId).not.toBe("sess-impl");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// P12-07: per-stage checkpoints and resume-from-stage. Resume fails closed on any torn or inconsistent log.
import { execFileSync } from "node:child_process";
import { makeEvent } from "../../src/engine10/events.ts";
import { firstIncompleteStage, resumeFlag, resumePoint, stageCheckpoints } from "../../src/util/run_outputs.ts";
import { composeHandoff, renderHandoff } from "../../src/util/run_summary.ts";

const RID = "e10-20260101T000000Z-abcd";
type Spec = [string, string | null, Record<string, unknown>?];
const mk = (spec: Spec[]) => spec.map(([t, s, d], i) => makeEvent(RID, i, t, s as never, d ?? {}, "2026-01-01T00:00:00.000Z"));
const killedAfterImplement = () => mk([
  ["run.started", null], ["stage.completed", "intake", { base_sha: "abc", task: "t" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["stage.completed", "implement"],
]);
const text = (evs: ReturnType<typeof mk>): string => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("resume from stage (P12-07)", () => {
  test("kill after implement: resume skips intake, plan and wall and re-enters at verify", () => {
    const evs = killedAfterImplement();
    const r = resumePoint(evs, text(evs));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.stage).toBe("verify"); expect(r.skip).toEqual(["intake", "plan", "wall", "implement"]); expect(r.checkpoints.map((c) => c.stage)).toEqual(["intake", "plan", "wall", "implement"]); }
  });
  test("checkpoints are deterministic and chain inputs to prior outputs", () => {
    const a = stageCheckpoints(killedAfterImplement()), b = stageCheckpoints(killedAfterImplement());
    expect(a).toEqual(b);
    expect(a[1]!.inputs_sha).not.toBe(a[0]!.inputs_sha);
  });
  test("torn mid-log line refuses", () => {
    const evs = killedAfterImplement(), lines = text(evs).split("\n");
    lines[2] = lines[2]!.slice(0, 20);
    expect(resumePoint(evs.filter((_, i) => i !== 2), lines.join("\n")).ok).toBe(false);
  });
  test("torn last line, seq gap, finished run, out-of-order stage, empty log all refuse", () => {
    const evs = killedAfterImplement();
    expect(resumePoint(evs, text(evs).trimEnd()).ok).toBe(false);
    expect(resumePoint(evs.map((e, i) => (i === 4 ? { ...e, seq: 9 } : e))).ok).toBe(false);
    expect(resumePoint([...evs, makeEvent(RID, evs.length, "run.completed", null, {})]).ok).toBe(false);
    expect(resumePoint(evs.filter((e) => e.stage !== "plan").map((e, i) => ({ ...e, seq: i }))).ok).toBe(false);
    expect(resumePoint([]).ok).toBe(false);
  });
  test("handoff names the stage a stopped run never settled", () => {
    const evs = killedAfterImplement();
    const h = (outcome: string): string => renderHandoff(composeHandoff({ repoDir: tmpdir(), runId: RID, events: evs, outcome, usd: null, elapsedS: null, notProven: [] }));
    expect(firstIncompleteStage(evs)).toBe("verify");
    expect(h("BUDGET_STOP")).toContain("Stopped before stage verify completed");
    expect(h("VERIFIED")).not.toContain("Stopped before stage");
  });
  test("resumeFlag: torn log exits 2 and never resumes; intact pre-publish log exits 4 naming the stage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1207-"));
    const cwd = process.cwd();
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
      const p = join(dir, ".loki", "runs", RID, "events.jsonl");
      const evs = killedAfterImplement();
      const say: string[] = [], out = (s: string): void => { say.push(s); };
      process.chdir(dir);
      writeFileSync(p, text(evs));
      expect(await resumeFlag(RID, false, { out })).toBe(4);
      expect(say.join("")).toContain("resume from stage verify");
      writeFileSync(p, text(evs) + '{"v":1,"seq":5,"ty');
      say.length = 0;
      expect(await resumeFlag(RID, false, { out })).toBe(2);
      expect(say.join("")).toContain("refused");
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("resume review fixes (P12-07)", () => {
  test("handoff does not count a cap-skipped stage as settled", () => {
    const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "a" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["stage.completed", "implement"], ["stage.skipped", "verify"]]);
    const h = renderHandoff(composeHandoff({ repoDir: tmpdir(), runId: RID, events: evs, outcome: "BUDGET_STOP", usd: null, elapsedS: null, notProven: [] }));
    expect(h).toContain("Stopped before stage verify completed");
    expect(h).toContain("in a new run: loki start");
  });
  test("P12-07b: handoff states what reruns and that only a sealed publish phase resumes", () => {
    const evs = killedAfterImplement();
    const h = renderHandoff(composeHandoff({ repoDir: tmpdir(), runId: RID, events: evs, outcome: "BUDGET_STOP", usd: null, elapsedS: null, notProven: [] }));
    expect(h).toContain("No stage is re-entered");
    expect(h).toContain("stage verify and every later stage rerun only in a new run");
    expect(h).toContain("reuses that receipt and reruns only the PR step");
    expect(h).toContain("loki resume or loki start --resume");
    expect(h).not.toContain("Resuming a stopped run is not available");
  });
  test("wall finishing before plan is accepted; resume re-enters at plan", () => {
    const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "a" }], ["stage.completed", "wall"]]);
    const r = resumePoint(evs, text(evs));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stage).toBe("plan");
  });
  test("a log containing tamper.detected refuses", () => {
    const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "a" }], ["tamper.detected", null]]);
    expect(resumePoint(evs, text(evs)).ok).toBe(false);
  });
  test("--no-pr on a publish-phase run refuses and never publishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1207b-"));
    const cwd = process.cwd();
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
      const evs = mk([["run.started", null], ["stage.completed", "intake", { base_sha: "a" }], ["stage.completed", "plan"], ["stage.completed", "wall"], ["stage.completed", "implement"], ["stage.completed", "verify"], ["stage.completed", "commit"], ["receipt.sealed", "seal", { verdict: "VERIFIED" }]]);
      writeFileSync(join(dir, ".loki", "runs", RID, "events.jsonl"), text(evs));
      process.chdir(dir);
      const say: string[] = [];
      let called = 0;
      const runPr = async (): Promise<never> => { called++; throw new Error("must not publish"); };
      expect(await resumeFlag(RID, true, { out: (s) => { say.push(s); }, runPr })).toBe(2);
      expect(called).toBe(0);
      expect(say.join("")).toContain("--no-pr");
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
});
