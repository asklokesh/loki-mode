// E-02 wall check: state machine skeleton (docs/v10/ENGINE.md section 4).
// Siblings are fakes injected through RunContext; stages come from an injected loader.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { firstError, runCheck } from "../../src/engine10/stages/verify.ts";
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
    expect(seen).toEqual({ base_sha: "b1" });
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

  for (const [tail, klass] of [["Your credit balance is too low", "quota_exhausted"], ["invalid x-api-key", "auth"], ["billing_hard_limit_reached ... insufficient_quota", "quota_exhausted"]] as const) {
    it(`a ${klass} error aborts on the first occurrence: no fix round, no further session`, async () => {
      const { ctx, events } = fakeCtx();
      let sessions = 0;
      ctx.sessions = { run: async () => { sessions++; return failing(tail); } };
      const r = await runMachine(ctx, { load: loaderOf(all({ implement: sessionStage(tail, { n: 0 }), verify: stage("verify", async () => ({ status: "completed", data: { failures_grouped: [{ signature: "x" }] } })) })) });
      expect(sessions).toBe(1);
      expect(r.stopped).toBe(`fatal:${klass}`);
      expect(of(events, "stage.started")).not.toContain("fix");
    });
  }

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
    ["the SDK error line in the iteration log", "mkdir -p .loki; echo '[sdk-loop error: Your credit balance is too low to access the API]' > .loki/iteration-it-implement.log; exit 1", "quota_exhausted"],
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

  it("a stage over its limit is aborted and failed with reason limit", async () => {
    const { ctx, events } = fakeCtx();
    const r = await runMachine(ctx, {
      load: loaderOf(all({
        implement: stage("implement", async () => { await sleep(5000); return { status: "completed", data: {} }; }, 0.05),
      })),
    });
    expect(events.find((e) => e.type === "stage.failed" && e.stage === "implement")?.data.reason).toBe("limit");
    expect(of(events, "stage.started")).not.toContain("verify");
    expect(of(events, "stage.completed")).toContain("seal");
    expect(r.capHit).toBe(false);
  });

  it("deep raises the implement limit", async () => {
    const { ctx, events } = fakeCtx();
    ctx.deep = true;
    await runMachine(ctx, { load: loaderOf(all({ implement: { name: "implement", targetS: 180, limitS: 480, run: async () => ({ status: "completed", data: {} }) } })) });
    expect(events.find((e) => e.type === "stage.started" && e.stage === "implement")?.data.limit_s).toBe(1800);
  });

  it("already satisfied jumps to commit and seal", async () => {
    const { ctx, events } = fakeCtx();
    await runMachine(ctx, { load: loaderOf(all({ intake: stage("intake", async () => ({ status: "completed", data: { already_satisfied: true } })) })) });
    expect(of(events, "stage.started")).not.toContain("verify");
    expect(of(events, "stage.completed").slice(-3)).toEqual(["commit", "seal", "pr"]);
  });

  it("spec_conflict still runs verify and the fix loop; seal still reports SPEC_CONFLICT (E-98b)", async () => {
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
    expect(of(events, "stage.started")).toContain("verify");
    expect(fixRan).toBe(true);
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
});
