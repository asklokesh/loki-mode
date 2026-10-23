import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// E-02 wall check: state machine skeleton (docs/v10/ENGINE.md section 4).
// Siblings are fakes injected through RunContext; stages come from an injected loader.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { firstError, runCheck } from "../../src/engine10/stages/verify.ts";
import { hooks } from "../../src/engine10/hooks.ts";
import { FLOW, optional, runMachine, type MachineRunContext } from "../../src/engine10/machine.ts";
import type { RunContext, Stage, StageName, StageResult } from "../../src/engine10/types.ts";

type Ev = { type: string; stage: StageName | null; data: Record<string, unknown> };

function fakeCtx(capS = 900): { ctx: RunContext; events: Ev[] } {
  const events: Ev[] = [];
  const ctx: RunContext = {
    runId: "e10-test", repoDir: "/nonexistent", runDir: "/nonexistent/run", baseSha: "abc", branch: "loki/e10-test",
    provider: "claude", model: "fake", deep: false, capS,
    emit: (type, stage, data) => { events.push({ type, stage, data }); },
    sessions: { run: async () => { throw new Error("no sessions in machine tests"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() },
    outputs: () => ({}),
  };
  return { ctx, events };
}

function stage(name: StageName, run: Stage["run"] = async () => ({ status: "completed", data: { ok: name } }), limitS = 5): Stage {
  return { name, targetS: 1, limitS, run };
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); });
  });

function loaderOf(stages: Partial<Record<StageName, Stage>>) {
  return async (n: StageName): Promise<Stage | null> => stages[n] ?? null;
}

const all = (over: Partial<Record<StageName, Stage>> = {}): Partial<Record<StageName, Stage>> => {
  const s: Partial<Record<StageName, Stage>> = {};
  for (const n of ["intake", "plan", "wall", "implement", "verify", "fix", "commit", "seal", "pr"] as StageName[]) s[n] = stage(n);
  return { ...s, ...over };
};

const of = (events: Ev[], type: string) => events.filter((e) => e.type === type).map((e) => e.stage);

describe("engine10 machine", () => {
  it("runs the stage table in order with plan and wall in parallel", async () => {
    const { ctx, events } = fakeCtx();
    let concurrent = 0;
    let peak = 0;
    const par = (n: StageName) => stage(n, async () => {
      concurrent++; peak = Math.max(peak, concurrent);
      await sleep(30);
      concurrent--;
      return { status: "completed", data: {} };
    });
    const r = await runMachine(ctx, { load: loaderOf(all({ plan: par("plan"), wall: par("wall") })) });
    expect(peak).toBe(2);
    expect(of(events, "stage.completed")).toEqual(["intake", "plan", "wall", "implement", "verify", "commit", "seal", "pr"]);
    expect(r.capHit).toBe(false);
    const started = events.find((e) => e.type === "stage.started" && e.stage === "intake");
    expect(started?.data).toEqual({ target_s: 1, limit_s: 5 });
    expect(typeof events.find((e) => e.type === "stage.completed")?.data.duration_s).toBe("number");
    expect(FLOW).toContainEqual(["plan", "wall"]);
  });

  it("missing optional stages emit stage.skipped with module not present", async () => {
    const { ctx, events } = fakeCtx();
    const s = all();
    delete s.plan; delete s.wall; delete s.fix;
    await runMachine(ctx, { load: loaderOf(s) });
    const skipped = events.filter((e) => e.type === "stage.skipped");
    expect(skipped.map((e) => e.stage)).toEqual(["plan", "wall"]);
    for (const e of skipped) expect(e.data.reason).toBe("module not present");
    expect(of(events, "stage.completed")).toContain("seal");
  });

  it("the default loader skips stages whose module file is absent", async () => {
    const { ctx, events } = fakeCtx();
    // No stages/*.ts exist in this slice: every stage is skipped, none throws.
    await runMachine(ctx, { stagesDir: join(tmpdir(), "e10-no-such-stages-dir") });
    expect(of(events, "stage.skipped")).toEqual(["intake", "plan", "wall", "implement", "verify", "commit", "seal", "pr"]);
  });

  it("feeds earlier outputs to later stages through ctx.outputs()", async () => {
    const { ctx } = fakeCtx();
    let seen: unknown;
    await runMachine(ctx, {
      load: loaderOf(all({
        intake: stage("intake", async () => ({ status: "completed", data: { base_sha: "b1" } })),
        implement: stage("implement", async (c) => { seen = c.outputs().intake; return { status: "completed", data: {} }; }),
      })),
    });
    expect(seen).toMatchObject({ base_sha: "b1" }); // the machine adds duration_s to every stored output
  });

  it("the same failure signature 3 verifies running ends STALLED", async () => {
    const { ctx } = fakeCtx();
    let verifies = 0;
    const r = await runMachine(ctx, { load: loaderOf(all({
      verify: stage("verify", async () => { verifies++; return { status: "completed", data: { failures_grouped: [{ signature: "node:tests/sum.test.js AssertionError: expected 1 to equal 2" }] } }; }),
    })) });
    expect(verifies).toBe(3);
    expect(r.stopped).toBe("stalled");
  });

  it("two fix rounds that left the tree unchanged against the same failure stall without a third verify", async () => {
    const { ctx, events } = fakeCtx();
    let verifies = 0, fixes = 0;
    const r = await runMachine(ctx, { load: loaderOf(all({
      verify: stage("verify", async () => { verifies++; return { status: "completed", data: { failures_grouped: [{ signature: "same" }] } }; }),
      fix: stage("fix", async () => { fixes++; return { status: "completed", data: { round: fixes, tree_before: "t0", tree_after: "t0", signatures: "same" } }; }),
    })) });
    expect(r.stopped).toBe("stalled");
    expect(fixes).toBe(2);
    expect(verifies).toBe(2);
    expect(events.some((e) => e.type === "loop.repeat")).toBe(true);
  });

  it("a fix round that reports a spec conflict ends as SPEC_CONFLICT on the implement output, never STALLED (FC-FIX-CONFLICT-STALLED)", async () => {
    const { ctx, events } = fakeCtx();
    let fixes = 0;
    const r = await runMachine(ctx, { load: loaderOf(all({
      implement: stage("implement", async () => ({ status: "completed", data: { exit: "done" } })),
      verify: stage("verify", async () => ({ status: "completed", data: { failures_grouped: [{ signature: "same" }] } })),
      fix: stage("fix", async () => { fixes++; return { status: "completed", data: { round: fixes, tree_before: "t0", tree_after: "t0", signatures: "same", ...(fixes === 2 ? { exit: "spec_conflict", spec_conflict_reason: "needs a hosted service" } : {}) } }; }),
    })) });
    expect(r.stopped).not.toBe("stalled");
    expect(events.some((e) => e.type === "loop.repeat")).toBe(false);
    expect(r.outputs.implement?.exit).toBe("spec_conflict");
    expect(r.outputs.implement?.spec_conflict_reason).toBe("needs a hosted service");
    expect(fixes).toBe(2);
  });

  it("one no-op fix round still gets its verify: a flaky check may pass on the same tree", async () => {
    const { ctx, events } = fakeCtx();
    let verifies = 0, fixes = 0;
    await runMachine(ctx, { load: loaderOf(all({
      verify: stage("verify", async () => { verifies++; return { status: "completed", data: { failures_grouped: verifies === 1 ? [{ signature: "flaky" }] : [] } }; }),
      fix: stage("fix", async () => { fixes++; return { status: "completed", data: { round: fixes, tree_before: "t0", tree_after: "t0" } }; }),
    })) });
    expect(fixes).toBe(1);
    expect(verifies).toBe(2);
    expect(events.some((e) => e.type === "loop.repeat")).toBe(false);
  });

  it("a crashed verify between two no-op fix rounds is not a repeat (A-113b)", async () => {
    const { ctx, events } = fakeCtx();
    let verifies = 0, fixes = 0;
    await runMachine(ctx, { load: loaderOf(all({
      verify: stage("verify", async () => {
        verifies++;
        if (verifies === 2) return { status: "failed", reason: "verify crashed", data: {} };
        return { status: "completed", data: { failures_grouped: [{ signature: "same" }] } };
      }),
      fix: stage("fix", async () => { fixes++; return { status: "completed", data: { round: fixes, tree_before: "t0", tree_after: "t0" } }; }),
    })) });
    expect(events.some((e) => e.type === "loop.repeat")).toBe(false);
    expect(verifies).toBe(3);
  });

  it("a fix round that changed the tree is verified, even with the same failure", async () => {
    const { ctx, events } = fakeCtx();
    let verifies = 0, fixes = 0;
    await runMachine(ctx, { load: loaderOf(all({
      verify: stage("verify", async () => { verifies++; return { status: "completed", data: { failures_grouped: [{ signature: "same" }] } }; }),
      fix: stage("fix", async () => { fixes++; return { status: "completed", data: { round: fixes, tree_before: `t${fixes}`, tree_after: `t${fixes + 1}`, signatures: "same" } }; }),
    })) });
    expect(verifies).toBe(3);
    expect(events.some((e) => e.type === "loop.repeat")).toBe(false);
  });

  it("a failed fix stage keeps the old output but is never read as a repeat", async () => {
    const { ctx, events } = fakeCtx();
    let verifies = 0, fixes = 0;
    await runMachine(ctx, { load: loaderOf(all({
      verify: stage("verify", async () => { verifies++; return { status: "completed", data: { failures_grouped: [{ signature: `s${verifies}` }] } }; }),
      fix: stage("fix", async () => {
        fixes++;
        return fixes === 1
          ? { status: "completed", data: { round: 1, tree_before: "t0", tree_after: "t1" } }
          : { status: "failed", reason: "session error", data: {} };
      }),
    })) });
    expect(verifies).toBe(3);
    expect(events.some((e) => e.type === "loop.repeat")).toBe(false);
  });

  it("changing signatures are not stalled", async () => {
    const { ctx } = fakeCtx();
    let n = 0;
    const r = await runMachine(ctx, { load: loaderOf(all({
      verify: stage("verify", async () => ({ status: "completed", data: { failures_grouped: [{ signature: `sig${n++}` }] } })),
    })) });
    expect(r.stopped).toBeNull();
  });

  const sessionStage = (tail: string, runs: { n: number }): Stage => stage("implement", async (c, signal) => {
    runs.n++;
    await c.sessions.run({ stage: "implement", brief: "", tier: "development", iterationId: "i", limitS: 1, signal, cwd: "/" });
    return { status: "failed", data: {}, reason: "exit 1" };
  });
  const failing = (tail: string) => ({ exit: 1, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 0, killed: false, stderrTail: tail });

  for (const [tail, klass] of [["invalid x-api-key", "auth"]] as const) {
    it(`a ${klass} error is fatal on the first occurrence (quota now waits, P12-09): no fix round, no further session`, async () => {
      const { ctx, events } = fakeCtx();
      let sessions = 0;
      ctx.sessions = { run: async () => { sessions++; return failing(tail); } };
      const r = await runMachine(ctx, { load: loaderOf(all({ implement: sessionStage(tail, { n: 0 }), verify: stage("verify", async () => ({ status: "completed", data: { failures_grouped: [{ signature: "x" }] } })) })) });
      expect(sessions).toBe(1);
      expect(r.stopped).toBe(`fatal:${klass}`);
      expect(of(events, "stage.started")).not.toContain("fix");
    });
  }

  describe("P12-09 quota wait and rerun", () => {
    const okRes = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false, stderrTail: "" };
    const virtual = (ctx: RunContext) => { let now = Date.now(); const slept: number[] = []; ctx.clock = { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms; } }; return slept; };
    it("a quota error twice then success waits on ctx.clock and the run completes", async () => {
      const { ctx, events } = fakeCtx();
      const slept = virtual(ctx);
      let calls = 0, stageRuns = 0;
      ctx.sessions = { run: async () => (++calls <= 2 ? failing("[sdk-loop error: Your credit balance is too low to access the API]") : okRes) };
      const r = await runMachine(ctx, { load: loaderOf(all({ implement: stage("implement", async (c, signal) => { stageRuns++; await c.sessions.run({ stage: "implement", brief: "", tier: "development", iterationId: "i", limitS: 1, signal, cwd: "/" }); return { status: "completed", data: {} }; }) })) });
      expect(calls).toBe(3);
      expect(stageRuns).toBe(1);
      expect(slept.length).toBe(2);
      expect(r.stopped).toBeNull();
      expect(r.capHit).toBe(false);
      expect(of(events, "stage.started").filter((n) => n === "implement").length).toBe(1);
    });
    it("a quota that never recovers ends budget_stopped (cap.hit), not fatal and not an infinite wait", async () => {
      const { ctx, events } = fakeCtx(900);
      const slept = virtual(ctx);
      let calls = 0;
      ctx.sessions = { run: async () => { calls++; return failing("insufficient_quota"); } };
      const r = await runMachine(ctx, { load: loaderOf(all({ implement: sessionStage("", { n: 0 }) })) });
      expect(r.capHit).toBe(true);
      expect(r.stopped).toBeNull();
      expect(of(events, "cap.hit").length).toBe(1);
      expect(calls).toBeGreaterThan(1);
      expect(calls).toBeLessThan(40);
      expect(slept.length).toBeGreaterThan(0);
    });
    it("the dollar cap (ctx.overCap) ends the quota wait between attempts", async () => {
      const { ctx } = fakeCtx(900000);
      const slept = virtual(ctx);
      let calls = 0;
      ctx.overCap = () => slept.length >= 1;
      ctx.sessions = { run: async () => { calls++; return failing("insufficient_quota"); } };
      const r = await runMachine(ctx, { load: loaderOf(all({ implement: sessionStage("", { n: 0 }) })) });
      expect(calls).toBe(1);
      expect(slept.length).toBe(1);
      expect(r.stopped).toBeNull();
      expect(r.capHit).toBe(true);
    });
    it("the SDK iteration-log credit line, through the real session runner, waits and ends budget_stopped", async () => {
      const dir = mkdtempSync(join(tmpdir(), "loki-p1209b-"));
      try {
        const { ctx } = fakeCtx(900000);
        const slept = virtual(ctx);
        const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", 'mkdir -p .loki; echo "[sdk-loop error: Your credit balance is too low to access the API]" > ".loki/iteration-$LOKI_ITERATION.log"; exit 1']] });
        let calls = 0;
        ctx.overCap = () => slept.length >= 2;
        ctx.sessions = { run: (o) => { calls++; return runner.run({ ...o, cwd: dir }); } };
        const r = await runMachine(ctx, { load: loaderOf(all({ implement: sessionStage("", { n: 0 }) })) });
        expect(r.stopped).toBeNull();
        expect(r.capHit).toBe(true);
        expect(calls).toBe(2);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it("auth stays fatal with no wait", async () => {
      const { ctx } = fakeCtx();
      const slept = virtual(ctx);
      let calls = 0;
      ctx.sessions = { run: async () => { calls++; return failing("invalid x-api-key"); } };
      const r = await runMachine(ctx, { load: loaderOf(all({ implement: sessionStage("", { n: 0 }) })) });
      expect(r.stopped).toBe("fatal:auth");
      expect(calls).toBe(1);
      expect(slept.length).toBe(0);
    });
  });

  it("a 429 is transient: the run is not stopped fatal", async () => {
    const { ctx } = fakeCtx();
    ctx.sessions = { run: async () => failing("429 rate limit exceeded, please try again") };
    const r = await runMachine(ctx, { load: loaderOf(all({ implement: sessionStage("", { n: 0 }) })) });
    expect(r.stopped).toBeNull();
  });

  it("firstError separates two failures in one file for pytest, jest and node (real runner formats)", () => {
    const py = (t: string, r: string) => `=== FAILURES ===\n___ ${t} ___\n\ntests/test_a.py:12: ${r}\n=== short test summary info ===\nFAILED tests/test_a.py::${t} - ${r}\n`;
    expect(firstError(py("test_login", "assert 1 == 2"))).not.toBe(firstError(py("test_logout", "KeyError: 'u'")));
    expect(firstError(py("test_login", "assert 1 == 2"))).toContain("test_login");
    const jest = (t: string) => `FAIL src/a.test.js\n  \u2713 handles error case (3 ms)\n  \u25cf Math \u203a ${t}\n\n    expect(received).toBe(expected)\n`;
    expect(firstError(jest("adds"))).not.toBe(firstError(jest("subtracts")));
    expect(firstError(jest("adds"))).toContain("adds");
    expect(firstError("ok 1 - a\nnot ok 2 - sum adds [3.2ms] at /tmp/x1/sum.js:10:5")).toBe("not ok 2 - sum adds at <path>");
  });

  // Real session runner. `child` replaces the self-respawned session child; `claude` is a fake binary for the CLI invoker.
  async function realSession(runs: { n: number }, o: { child?: string; claude?: string }) {
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-fatal-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$*" in *--help*) echo "--settings"; exit 0;; esac\necho '${o.claude ?? ""}'\nexit 1\n`, { mode: 0o755 });
    const saved = { PATH: process.env.PATH, inv: process.env.LOKI_E10_INVOKER };
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.LOKI_E10_INVOKER = "cli";
    try {
      const { ctx } = fakeCtx();
      const real = createSessionRunner({ provider: "claude", ...(o.child ? { childCommand: ["bash", ["-c", o.child]] as [string, string[]] } : {}) });
      ctx.sessions = { run: (x) => { runs.n++; return real.run({ ...x, cwd: dir, limitS: 60 }); } };
      const ses = (n: StageName) => stage(n, async (c, signal) => {
        await c.sessions.run({ stage: n as never, brief: "b", tier: "development", iterationId: `it-${n}`, limitS: 60, signal });
        return { status: "completed", data: {} } as StageResult;
      });
      const verify = stage("verify", async () => ({ status: "completed", data: { failures_grouped: [{ signature: "x" }] } }));
      return await runMachine(ctx, { load: loaderOf(all({ implement: ses("implement"), fix: ses("fix"), verify })) });
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.inv === undefined) delete process.env.LOKI_E10_INVOKER; else process.env.LOKI_E10_INVOKER = saved.inv;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [label, child, klass] of [
    ["the session child's own stderr", "echo 'invalid x-api-key' >&2; exit 1", "auth"],
    ["the real SDK auth line in the iteration log", "mkdir -p .loki; echo '[sdk-loop error: Claude Code returned an error result: Failed to authenticate. API Error: 401 API key is invalid.]' > .loki/iteration-it-implement.log; exit 1", "auth"],
    ["the SDK Not logged in error line", "mkdir -p .loki; echo '[sdk-loop error: Claude Code returned an error result: Not logged in - Please run /login]' > .loki/iteration-it-implement.log; exit 1", "auth"],
  ] as const) {
    it(`real session runner: ${label} stops fatal:${klass} after ONE session`, async () => {
      const runs = { n: 0 };
      const r = await realSession(runs, { child });
      expect(runs.n).toBe(1);
      expect(r.stopped).toBe(`fatal:${klass}`);
    }, 60_000);
  }

  it("real session runner: agent transcript that merely mentions an auth error is NOT fatal (fix round still runs)", async () => {
    const runs = { n: 0 };
    const r = await realSession(runs, { claude: "FAILED tests/test_login.py::test_bad_password - AuthenticationError: authentication failed for user bob ... Reached max turns." });
    expect(runs.n).toBeGreaterThan(1);
    expect(r.stopped).not.toMatch(/^fatal/);
  }, 60_000);

  it("real session runner: a 429 is retried (the fix round still runs its session), never fatal", async () => {
    const runs = { n: 0 };
    const r = await realSession(runs, { child: "echo '429 rate limit exceeded, please try again' >&2; exit 1" });
    expect(runs.n).toBeGreaterThan(1);
    expect(r.stopped).not.toMatch(/^fatal/);
  }, 60_000);

  it("runCheck: a failing check that leaves a background child holding the pipes is fail, fast, never not_run", async () => {
    const { ctx } = fakeCtx();
    ctx.repoDir = tmpdir();
    const checks: never[] = [];
    const t0 = Date.now();
    const c = await runCheck(ctx, "x", "sh", ["-c", "sleep 25 & echo FAILED x; exit 1"], new AbortController().signal, checks, { timeoutMs: 5000 });
    expect(c.result).toBe("fail");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(c.first_error).toBe("FAILED x");
  }, 10_000);

  it("the global cap aborts the running stage and jumps to commit and seal", async () => {
    // capS=25 is just above the ~24.83s threshold below which softCapS's
    // commit+seal-tail budget goes negative (E-67 round 5), so softCapS(25)
    // stays the small budget value (167ms) rather than being clamped to 0 --
    // still fast, but a real nonzero delay before the cap fires.
    const { ctx, events } = fakeCtx(25); // softCapS(25) = 0.1667s = ~167ms
    let aborted = false;
    let sealCap: boolean | undefined;
    const r = await runMachine(ctx, {
      load: loaderOf(all({
        implement: stage("implement", async (_c, signal) => {
          await sleep(5000, signal);
          aborted = signal.aborted;
          return { status: "completed", data: {} };
        }),
        verify: stage("verify", async () => { throw new Error("verify must not run after the cap"); }),
        seal: stage("seal", async (c) => { sealCap = (c as MachineRunContext).capHit(); return { status: "completed", data: { verdict: "PARTIAL" } }; }),
      })),
    });
    expect(r.capHit).toBe(true);
    expect(aborted).toBe(true);
    const cap = events.find((e) => e.type === "cap.hit");
    expect(cap?.stage).toBe("implement");
    expect(typeof cap?.data.elapsed_s).toBe("number");
    expect(events.find((e) => e.type === "stage.failed" && e.stage === "implement")?.data.reason).toBe("cap");
    expect(of(events, "stage.started")).not.toContain("verify");
    expect(of(events, "stage.completed")).toEqual(["intake", "plan", "wall", "commit", "seal", "pr"]);
    expect(sealCap).toBe(true);
  });

  it("a stage over its limit is aborted and failed with reason limit, then verify still runs", async () => {
    const { ctx, events } = fakeCtx();
    const r = await runMachine(ctx, {
      load: loaderOf(all({
        implement: stage("implement", async () => { await sleep(5000); return { status: "completed", data: {} }; }, 0.05),
      })),
    });
    expect(events.find((e) => e.type === "stage.failed" && e.stage === "implement")?.data.reason).toBe("limit");
    expect(of(events, "stage.started")).toContain("verify"); // FC-21 (a): a limit still verifies the work that exists
    expect(of(events, "stage.completed")).toContain("seal");
    expect(r.capHit).toBe(false);
  });

  it("deep raises the implement limit", async () => {
    const { ctx, events } = fakeCtx();
    ctx.deep = true;
    await runMachine(ctx, { load: loaderOf(all({ implement: { name: "implement", targetS: 180, limitS: 480, run: async () => ({ status: "completed", data: {} }) } })) });
    expect(events.find((e) => e.type === "stage.started" && e.stage === "implement")?.data.limit_s).toBe(1800);
  });

  it("FC-19: deep-mode implement session gets the 1800s limit, not the stage's 480s", async () => {
    const { ctx } = fakeCtx();
    ctx.deep = true;
    const seen: number[] = [];
    ctx.sessions = { run: async (o) => { seen.push(o.limitS); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } };
    const impl: Stage = { name: "implement", targetS: 180, limitS: 480, run: async (c, _s) => { await c.sessions.run({ stage: "implement", brief: "b", tier: "development", iterationId: "i", limitS: 480, signal: new AbortController().signal }); return { status: "completed", data: {} }; } };
    await runMachine(ctx, { load: loaderOf(all({ implement: impl })) });
    expect(seen[0]).toBeGreaterThan(1799); // runs 37171623026 and 37173985482: the budget-left limit (FC-21b A2) can read 1799.999 after 1ms elapsed; assert the deep limit, not the elapsed ms
    expect(seen[0]).toBeLessThanOrEqual(1800);
    expect(seen.every((s) => s > 480 && s <= 1800)).toBe(true);
  });

  it("FC-19: implement limit comes from the run budget, not a fixed 480s", async () => {
    const { ctx, events } = fakeCtx();
    ctx.capS = 900;
    await runMachine(ctx, { load: loaderOf(all({ implement: { name: "implement", targetS: 180, limitS: 480, run: async () => ({ status: "completed", data: {} }) } })) });
    const lim = events.find((e) => e.type === "stage.started" && e.stage === "implement")?.data.limit_s as number;
    expect(lim).toBeGreaterThan(480);
    expect(lim).toBeLessThan(900);
  });

  it("already satisfied jumps to commit and seal", async () => {
    const { ctx, events } = fakeCtx();
    await runMachine(ctx, { load: loaderOf(all({ intake: stage("intake", async () => ({ status: "completed", data: { already_satisfied: true } })) })) });
    expect(of(events, "stage.started")).not.toContain("verify");
    expect(of(events, "stage.completed").slice(-3)).toEqual(["commit", "seal", "pr"]);
  });

  it("spec_conflict still runs verify (E-98b) but no fix round (FC-FIX-OVER-CONFLICT); seal still reports SPEC_CONFLICT", async () => {
    const { ctx, events } = fakeCtx();
    let fixRan = false;
    await runMachine(ctx, {
      load: loaderOf(all({
        implement: stage("implement", async () => ({ status: "completed", data: { exit: "spec_conflict" } })),
        verify: stage("verify", async () => ({ status: "completed", data: { failures_grouped: [{ signature: "x" }] } })),
        fix: stage("fix", async () => { fixRan = true; return { status: "completed", data: {} }; }),
        // Mirrors seal.ts:110 (spec_conflict checked before the checks/emptyDiff verdict logic).
        seal: stage("seal", async (c) => {
          const exit = (c.outputs().implement as { exit?: string } | undefined)?.exit;
          return { status: "completed", data: { verdict: exit === "spec_conflict" ? "SPEC_CONFLICT" : "VERIFIED" } };
        }),
      })),
    });
    expect(of(events, "stage.started").filter((n) => n === "verify")).toHaveLength(1);
    expect(fixRan).toBe(false);
    const seal = events.find((e) => e.type === "stage.completed" && e.stage === "seal");
    expect(seal?.data.verdict).toBe("SPEC_CONFLICT");
  });

  it("intake failure ends the run without sealing", async () => {
    const { ctx, events } = fakeCtx();
    const r = await runMachine(ctx, { load: loaderOf(all({ intake: stage("intake", async () => ({ status: "failed", data: {}, reason: "dirty tree" })) })) });
    expect(events.find((e) => e.type === "stage.failed")?.data.reason).toBe("dirty tree");
    expect(of(events, "stage.started")).toEqual(["intake"]);
    expect(r.stopped).toBe("intake failed");
  });

  // E-67 r4 follow-up 3: softCapS(30) is ~5s (tightened well below intake's own 15s target so
  // commit+seal's tail fits before the backstop). That means a cap can now fire WHILE intake is
  // still running at this capS, and the aborted stage comes back status:"failed" just like a real
  // intake failure -- the pre-existing "intake failed" early return could not tell the two apart
  // and bailed before commit/seal/pr ever ran, defeating the whole point of leaving tail room. Red
  // on the bare `results[0]?.status === "failed"` check (stopped: "intake failed", no seal); green
  // once that check also excludes a cap-caused failure (!capHit).
  it("a cap that fires mid-intake at a small capS still reaches seal, not an early 'intake failed' stop", async () => {
    const { ctx, events } = fakeCtx(30);
    const startedAtMs = Date.now() - 4000; // softCapS(30) ~= 5.0s: cap fires ~1s after intake starts (real margin under load)
    const intakeHang = stage("intake", async (_c, signal) => { await sleep(60_000, signal); return { status: "completed", data: {} }; });
    const r = await runMachine(ctx, { load: loaderOf(all({ intake: intakeHang })), startedAtMs });
    expect(r.capHit).toBe(true);
    // Pins that intake was genuinely running (not skipped pre-start): the abort must be attributed to "cap".
    expect(events.find((e) => e.type === "stage.failed" && e.stage === "intake")?.data.reason).toBe("cap");
    expect(r.stopped).toBeNull();
    expect(of(events, "stage.completed")).toContain("seal");
  }, 10_000);

  it("verify failures run at most two fix rounds, each followed by verify", async () => {
    const { ctx, events } = fakeCtx();
    const failing = stage("verify", async () => ({ status: "completed", data: { failures_grouped: [{ signature: "x" }] } }));
    await runMachine(ctx, { load: loaderOf(all({ verify: failing })) });
    expect(of(events, "stage.started")).toEqual([
      "intake", "plan", "wall", "implement", "verify", "fix", "verify", "fix", "verify", "commit", "seal", "pr",
    ]);
  });

  it("the fix loop checks the clock before starting a stage past the cap", async () => {
    // A fake clock jumps past the cap inside verify; the real-time cap timer has not fired yet.
    const { ctx, events } = fakeCtx();
    let now = Date.now();
    ctx.clock = { now: () => now };
    let fixRan = false;
    const r = await runMachine(ctx, {
      load: loaderOf(all({
        verify: stage("verify", async () => { now += 20 * 60_000; return { status: "completed", data: { failures_grouped: [{}] } }; }),
        fix: stage("fix", async () => { fixRan = true; return { status: "completed", data: {} }; }),
      })),
    });
    expect(fixRan).toBe(false);
    expect(r.capHit).toBe(true);
    expect(of(events, "cap.hit")).toEqual(["fix"]);
    expect(of(events, "stage.started").slice(-3)).toEqual(["commit", "seal", "pr"]);
  });

  it("the cap during the parallel plan and wall group emits exactly one cap.hit", async () => {
    const { ctx, events } = fakeCtx(25); // softCapS(25) = 0.1667s = ~167ms; see comment above
    const slow = (n: StageName) => stage(n, async (_c, signal) => { await sleep(5000, signal); return { status: "completed", data: {} }; });
    const r = await runMachine(ctx, { load: loaderOf(all({ plan: slow("plan"), wall: slow("wall") })) });
    expect(r.capHit).toBe(true);
    expect(events.filter((e) => e.type === "cap.hit").length).toBe(1);
    expect(events.filter((e) => e.type === "stage.failed").map((e) => e.data.reason)).toEqual(["cap", "cap"]);
  });

  it("the cap fires at 14:00 of a 15:00 cap (14/15 of capS)", async () => {
    // Started 14:05 ago: past 14/15 of 900s, before the full cap.
    const late = fakeCtx();
    const r1 = await runMachine(late.ctx, { load: loaderOf(all()), startedAtMs: Date.now() - 845_000 });
    expect(r1.capHit).toBe(true);
    expect(of(late.events, "stage.started")).toEqual(["commit", "seal", "pr"]);
    const hit = late.events.find((e) => e.type === "cap.hit");
    expect(hit?.data.elapsed_s as number).toBeGreaterThanOrEqual(840);
    // Started 13:55 ago: every fast stage runs and the cap does not fire.
    const early = fakeCtx();
    const r2 = await runMachine(early.ctx, { load: loaderOf(all()), startedAtMs: Date.now() - 835_000 });
    expect(r2.capHit).toBe(false);
    expect(of(early.events, "stage.completed")).toContain("verify");
  });

  it("after a kill, commit waits for the aborted stage to settle", async () => {
    const { ctx, events } = fakeCtx();
    let implDone = 0;
    let commitStart = 0;
    await runMachine(ctx, {
      load: loaderOf(all({
        // Ignores the signal and finishes 300ms after its 50ms limit.
        implement: stage("implement", async () => { await sleep(350); implDone = Date.now(); return { status: "completed", data: {} }; }, 0.05),
        commit: stage("commit", async () => { commitStart = Date.now(); return { status: "completed", data: {} }; }),
      })),
    });
    expect(events.find((e) => e.type === "stage.failed" && e.stage === "implement")?.data.reason).toBe("limit");
    expect(implDone).toBeGreaterThan(0);
    expect(commitStart).toBeGreaterThanOrEqual(implDone);
  });

  it("the post-kill grace wait is bounded at about 2s", async () => {
    const { ctx } = fakeCtx();
    let commitStart = 0;
    const t0 = Date.now();
    await runMachine(ctx, {
      load: loaderOf(all({
        implement: stage("implement", async () => { await sleep(10_000); return { status: "completed", data: {} }; }, 0.05),
        commit: stage("commit", async () => { commitStart = Date.now(); return { status: "completed", data: {} }; }),
      })),
    });
    expect(commitStart - t0).toBeLessThan(3000);
  });

  it("a green verify after one fix stops the loop", async () => {
    const { ctx, events } = fakeCtx();
    let n = 0;
    const v = stage("verify", async (): Promise<StageResult> => ({ status: "completed", data: { failures_grouped: n++ === 0 ? [{}] : [] } }));
    await runMachine(ctx, { load: loaderOf(all({ verify: v })) });
    expect(of(events, "stage.started").filter((s) => s === "fix")).toEqual(["fix"]);
  });
});

describe("engine10 optional()", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("returns null for an absent module and the module for a present one", async () => {
    expect(await optional(join(tmpdir(), "e10-absent-module.ts"))).toBeNull();
    dir = mkdtempSync(join(tmpdir(), "e10-opt-"));
    const p = join(dir, "present.ts");
    writeFileSync(p, "export const answer = 42;\n");
    expect(((await optional(p)) as { answer: number }).answer).toBe(42);
  });

  it("a present module that fails to load throws instead of being skipped", async () => {
    dir = mkdtempSync(join(tmpdir(), "e10-opt-"));
    const p = join(dir, "broken.ts");
    writeFileSync(p, "throw new Error('boom');\n");
    await expect(optional(p)).rejects.toThrow("boom");
  });

describe("TEN-COST-11 r3: spend of failed or killed stages reaches seal", () => {
  const OKS = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false };
  const run = async (wall: Stage["run"], limitS = 5) => {
    const { ctx } = fakeCtx();
    ctx.sessions = { run: async () => OKS } as RunContext["sessions"];
    let seen: string[] | undefined, outWall: unknown = "unset";
    const seal = stage("seal", async (c) => { seen = c.sessionIds?.(); outWall = c.outputs().wall; return { status: "completed", data: {} }; });
    await runMachine(ctx, { load: loaderOf(all({ wall: stage("wall", wall, limitS), seal })) });
    return { seen, outWall };
  };
  it("a failed+killed wall stage's session ids are visible to seal although outputs.wall is empty", async () => {
    const r = await run(async (c) => {
      await c.sessions.run({ stage: "wall", iterationId: "w1" } as never); await c.sessions.run({ stage: "wall", iterationId: "w1-r2" } as never);
      return { status: "failed", data: { iteration_ids: ["w1", "w1-r2"] }, killed: true };
    });
    expect(r.outWall).toBeUndefined();
    expect(r.seen).toEqual(expect.arrayContaining(["w1", "w1-r2"]));
  });
  it("a wall stage cut off by its limit keeps the ids of sessions it had started", async () => {
    const r = await run(async (c, sig) => { await c.sessions.run({ stage: "wall", iterationId: "w1" } as never); await sleep(5000, sig); return { status: "completed", data: {} }; }, 0.05);
    expect(r.seen).toContain("w1");
  });
});
});

describe("concurrent wall distrusts a green base run when implement changed files (TEN-COST-11-F1)", () => {
  const saved = hooks.wall;
  afterEach(() => { hooks.wall = saved; delete process.env.LOKI_E10_WALL_CONCURRENT; });
  const go = async (changed: string[] | null) => {
    process.env.LOKI_E10_WALL_CONCURRENT = "1";
    const repo = mkdtempSync(join(tmpdir(), "loki-f1-")); const base = mkdtempSync(join(tmpdir(), "loki-f1-base-"));
    try {
      hooks.wall = { snapshotTree: async () => base, changedSinceBase: () => changed, manifests: /package\.json$/ };
      const { ctx } = fakeCtx(); ctx.repoDir = repo;
      const wall = { ...stage("wall"), split: {
        author: async () => ({ kind: "authored", targetDir: join(repo, "tests"), contents: new Map([["loki_wall_a.test.ts", "t\n"]]) }),
        install: (): StageResult => ({ status: "completed", data: { base_run: { pass: 3, fail: 0, not_run: 0 }, already_satisfied: true } }),
      } } as Stage;
      const r = await runMachine(ctx, { load: loaderOf(all({ wall })), flow: FLOW });
      return r.outputs.wall as Record<string, unknown> & { base_run: Record<string, unknown> };
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); }
  };
  it("implement changed a source file: already_satisfied false and base_run unproven", async () => {
    const w = await go(["src/x.ts"]);
    expect(w.already_satisfied).toBe(false); expect(w.already_satisfied_distrusted).toBe(true);
    expect(w.base_run).toMatchObject({ pass: 3, fail: 0, not_run: 1, unproven: true });
  });
  it("changed set unknown (null): distrusted too", async () => {
    expect((await go(null)).already_satisfied).toBe(false);
  });
  it("positive control: only .loki and wall files changed keeps already_satisfied true", async () => {
    const w = await go([".loki/x", "tests/loki_wall_a.test.ts"]);
    expect(w.already_satisfied).toBe(true); expect(w.base_run.unproven).toBeUndefined();
  });
});

describe("FC-OUT-OF-REPO machine", () => {
  const ran = (events: Ev[]) => of(events, "stage.completed");
  it("an out-of-repo plan skips implement, verify and fix, runs the tail, and seals via spec_conflict", async () => {
    const { ctx, events } = fakeCtx();
    const plan = stage("plan", async () => ({ status: "completed", data: { out_of_repo: true, spec_conflict_reason: "out-of-repo: hosted service" } }));
    let sealSaw: Record<string, unknown> | undefined;
    const seal = stage("seal", async (c) => { sealSaw = c.outputs().implement; return { status: "completed", data: {} }; });
    const r = await runMachine(ctx, { load: loaderOf(all({ plan, seal })) });
    expect(ran(events)).toEqual(["intake", "plan", "wall", "commit", "seal", "pr"]);
    expect(sealSaw?.exit).toBe("spec_conflict"); expect(sealSaw?.spec_conflict_reason).toBe("out-of-repo: hosted service");
    expect(r.outputs.implement?.exit).toBe("spec_conflict");
  });
  it("an intent_declined plan stops the run before implement", async () => {
    const { ctx, events } = fakeCtx();
    const plan = stage("plan", async () => ({ status: "completed", data: { intent_declined: true } }));
    const r = await runMachine(ctx, { load: loaderOf(all({ plan })) });
    expect(r.stopped).toBe("intent declined");
    expect(ran(events)).not.toContain("implement");
  });
  it("positive control: a normal plan still runs implement and verify", async () => {
    const { ctx, events } = fakeCtx();
    await runMachine(ctx, { load: loaderOf(all()) });
    expect(ran(events)).toContain("implement"); expect(ran(events)).toContain("verify");
  });
});
