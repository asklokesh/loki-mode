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
