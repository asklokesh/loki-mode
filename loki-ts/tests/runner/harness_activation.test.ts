// Activation tests for harness intelligence features 6 and 8.
//
// These are deliberately NOT source-substring tests. harness_intelligence.test.ts
// already asserts wiring with `expect(src).toContain("decideRecovery(")`, and
// that assertion was green for the entire time the runner passed no build signal
// and dropped the `revise` action on the floor -- the module's most carefully
// documented rule was reachable in a unit test and unreachable in production.
//
// So every test here drives the REAL runAutonomous loop (or the real buildPrompt)
// and observes the behavior that actually resulted.
//
// What is proven:
//   - the runner supplies a build signal, so decideRecovery's compile rule is
//     reachable in production (feature 8, rule 7)
//   - `revise` changes what the loop does (skips backoff) rather than being
//     observationally identical to `retry`
//   - the build signal is the GATE outcome, never the provider exit code
//   - LOKI_SMART_RETRY=0 keeps working with the recovery policy ON
//   - the repo profile reaches the prompt with the flag on, and is byte-absent
//     with the flag off
//   - the profile writer and the prompt reader address the SAME file

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(30_000);

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runAutonomous, taskClassForIteration } from "../../src/runner/autonomous.ts";
import { routeTaskClass } from "../../src/runner/capability_router.ts";
import { buildPrompt } from "../../src/runner/build_prompt.ts";
import { buildProfile } from "../../src/runner/repo_profile.ts";
import { decideRecovery } from "../../src/runner/recovery_policy.ts";
import type {
  Clock,
  ProviderInvocation,
  ProviderInvoker,
  ProviderResult,
  RunnerContext,
  RunnerOpts,
  SignalSource,
} from "../../src/runner/types.ts";

// --- doubles (same shapes as autonomous.test.ts) ---------------------------

class FakeProvider implements ProviderInvoker {
  public calls: ProviderInvocation[] = [];
  constructor(
    private readonly exitCode: number,
    private readonly output: string,
  ) {}
  async invoke(call: ProviderInvocation): Promise<ProviderResult> {
    this.calls.push(call);
    // Write real captured output: the recovery branch only runs when the
    // captured file exists and is non-empty.
    if (call.iterationOutputPath) {
      mkdirSync(resolve(call.iterationOutputPath, ".."), { recursive: true });
      writeFileSync(call.iterationOutputPath, this.output);
    }
    return { exitCode: this.exitCode, capturedOutputPath: call.iterationOutputPath };
  }
}

class FakeSignals implements SignalSource {
  async checkHumanIntervention(): Promise<0 | 1 | 2> {
    return 0;
  }
  async isBudgetExceeded(): Promise<boolean> {
    return false;
  }
}

// Records every sleep so we can prove `revise` skipped the backoff.
class RecordingClock implements Clock {
  public ticks = 0;
  public sleeps: number[] = [];
  now(): number {
    this.ticks += 1;
    return this.ticks * 1000;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }
}

type GateOutcome = { passed: string[]; failed: string[]; blocked: boolean; escalated: boolean };

function gates(failed: string[]) {
  return {
    async runQualityGates(_ctx: RunnerContext): Promise<GateOutcome> {
      return { passed: [], failed, blocked: failed.length > 0, escalated: false };
    },
  };
}

let tmpRoot: string;
let logLines: string[];
const logStream = {
  write(line: string | Uint8Array): boolean {
    logLines.push(typeof line === "string" ? line.trimEnd() : new TextDecoder().decode(line).trimEnd());
    return true;
  },
};

// Flags these tests own. Cleared before AND after so a leaked flag can neither
// contaminate another suite nor silently satisfy an assertion here.
const OWNED = [
  "LOKI_RECOVERY_POLICY",
  "LOKI_SMART_RETRY",
  "LOKI_REPO_PROFILE",
  "LOKI_REPO_PROFILE_TTL_SECONDS",
  "LOKI_DIR",
  "LOKI_CAPABILITY_ROUTER",
  "LOKI_SESSION_MODEL",
  "LOKI_MODEL_DEVELOPMENT",
  "LOKI_CLAUDE_MODEL_DEVELOPMENT",
  "LOKI_LEGACY_TIER_SWITCHING",
];
function clearOwned(): void {
  for (const k of OWNED) delete process.env[k];
}

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "loki-activation-"));
  mkdirSync(resolve(tmpRoot, ".loki"), { recursive: true });
  logLines = [];
  clearOwned();
});

afterEach(() => {
  clearOwned();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function baseOpts(overrides: Partial<RunnerOpts> = {}): RunnerOpts {
  return {
    cwd: tmpRoot,
    provider: "claude",
    autonomyMode: "checkpoint",
    maxRetries: 2,
    maxIterations: 5,
    baseWaitSeconds: 30, // non-zero so a skipped backoff is observable
    maxWaitSeconds: 300,
    sessionModel: "sonnet",
    loggerStream: logStream as unknown as NodeJS.WritableStream,
    clock: new RecordingClock(),
    signals: new FakeSignals(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Feature 8: recovery is reachable and consequential in the real loop.
// ---------------------------------------------------------------------------

describe("recovery policy is active in the runner, not dormant", () => {
  it("a confirmed provider outage fails over to the requested tier without backoff", async () => {
    process.env["LOKI_RECOVERY_POLICY"] = "1";
    const clock = new RecordingClock();
    const calls: ProviderInvocation[] = [];
    const provider: ProviderInvoker = {
      async invoke(call) {
        calls.push(call);
        if (calls.length === 1) throw new Error("connect ECONNREFUSED 127.0.0.1");
        mkdirSync(resolve(call.iterationOutputPath, ".."), { recursive: true });
        writeFileSync(call.iterationOutputPath, "ordinary transient failure");
        return { exitCode: 1, capturedOutputPath: call.iterationOutputPath };
      },
    };

    await runAutonomous(
      baseOpts({
        clock,
        sessionModel: "fast",
        providerOverride: provider,
        gatesOverride: gates([]),
      }),
    );

    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]?.tier).toBe("fast");
    expect(calls[1]?.tier).toBe("development");
    expect(logLines.some((l) => l.includes("recovery decision 'failover'"))).toBe(true);
    expect(clock.sleeps[0]).toBe(0);
  });

  it("malformed checkpointed state is restored in-loop before retry", async () => {
    process.env["LOKI_RECOVERY_POLICY"] = "1";
    const statePath = resolve(tmpRoot, ".loki/queue/current-task.json");
    mkdirSync(resolve(statePath, ".."), { recursive: true });
    writeFileSync(statePath, '{"task":"known-good"}');
    let calls = 0;
    let stateSeenOnRetry: unknown;
    const provider: ProviderInvoker = {
      async invoke(call) {
        calls += 1;
        mkdirSync(resolve(call.iterationOutputPath, ".."), { recursive: true });
        writeFileSync(call.iterationOutputPath, "ordinary output");
        if (calls === 1) return { exitCode: 0, capturedOutputPath: call.iterationOutputPath };
        if (calls === 2) writeFileSync(statePath, "{truncated");
        else stateSeenOnRetry = JSON.parse(await Bun.file(statePath).text());
        return { exitCode: 1, capturedOutputPath: call.iterationOutputPath };
      },
    };

    await runAutonomous(
      baseOpts({
        maxIterations: 4,
        providerOverride: provider,
        gatesOverride: gates([]),
        council: { async shouldStop() { return false; } },
      }),
    );

    expect(JSON.parse(await Bun.file(statePath).text())).toEqual({ task: "known-good" });
    expect(stateSeenOnRetry).toEqual({ task: "known-good" });
    expect(logLines.some((l) => l.includes("recovery decision 'checkpoint_rollback'"))).toBe(true);
  });

  it("a failing test_coverage gate produces `revise`, and revise skips the backoff", async () => {
    process.env["LOKI_RECOVERY_POLICY"] = "1";
    const clock = new RecordingClock();
    // Provider fails with prose that classifies as UNRECOGNIZED -> transient.
    // Without a build signal this is a plain `retry` and backs off. The only
    // thing that can turn it into `revise` is the gate-derived exit code.
    const provider = new FakeProvider(1, "the agent wrote some words and then stopped");

    await runAutonomous(
      baseOpts({
        clock,
        providerOverride: provider,
        gatesOverride: gates(["test_coverage"]),
      }),
    );

    const revise = logLines.filter((l) => l.includes("recovery decision 'revise'"));
    expect(revise.length).toBeGreaterThan(0);
    expect(revise[0]).toContain("build_failed");

    // The behavioral claim: revise re-attempts WITHOUT the exponential backoff.
    // baseWaitSeconds is 30, so a plain retry would sleep >= 30_000ms.
    expect(clock.sleeps.some((ms) => ms >= 30_000)).toBe(false);
  });

  it("the same failure WITHOUT a failing gate stays a backing-off retry", async () => {
    // The control. Proves the previous test's `revise` came from the gate
    // signal and not merely from enabling the policy flag.
    process.env["LOKI_RECOVERY_POLICY"] = "1";
    const clock = new RecordingClock();
    const provider = new FakeProvider(1, "the agent wrote some words and then stopped");

    await runAutonomous(
      baseOpts({ clock, providerOverride: provider, gatesOverride: gates([]) }),
    );

    expect(logLines.some((l) => l.includes("recovery decision 'revise'"))).toBe(false);
    expect(clock.sleeps.some((ms) => ms >= 30_000)).toBe(true);
  });

  it("a PROVIDER failure with clean gates is never misread as a build failure", async () => {
    // The compile hazard, asserted at the call site. outcome.exitCode is 1 here
    // (the provider failed), but no gate failed, so `revise` must NOT fire.
    // Passing outcome.exitCode as buildExitCode would make this test fail.
    process.env["LOKI_RECOVERY_POLICY"] = "1";
    const provider = new FakeProvider(1, "ECONNRESET while streaming");

    await runAutonomous(
      baseOpts({ providerOverride: provider, gatesOverride: gates([]) }),
    );

    expect(logLines.some((l) => l.includes("recovery decision 'revise'"))).toBe(false);
  });

  it("LOKI_SMART_RETRY=0 still disables the early stop when the policy is ON", async () => {
    // The runner's own log line advertises this escape hatch by name. Before
    // this slice it was read only on the flag-off path, so enabling the recovery
    // policy silently revoked the operator's documented opt-out.
    process.env["LOKI_RECOVERY_POLICY"] = "1";
    process.env["LOKI_SMART_RETRY"] = "0";
    const provider = new FakeProvider(1, "invalid_api_key: bad credentials");

    await runAutonomous(
      baseOpts({ providerOverride: provider, gatesOverride: gates([]) }),
    );

    expect(logLines.some((l) => l.includes("stopping early"))).toBe(false);
    // And the unit-level contract behind it.
    expect(
      decideRecovery(
        { output: "invalid_api_key" },
        { env: { LOKI_RECOVERY_POLICY: "1", LOKI_SMART_RETRY: "0" } as NodeJS.ProcessEnv, history: [] },
      ).action,
    ).toBe("retry");
  });

  it("a permanent failure still stops early by default (fail-safe preserved)", async () => {
    process.env["LOKI_RECOVERY_POLICY"] = "1";
    const provider = new FakeProvider(1, "invalid_api_key: bad credentials");

    const code = await runAutonomous(
      baseOpts({ providerOverride: provider, gatesOverride: gates([]) }),
    );

    expect(logLines.some((l) => l.includes("stopping early"))).toBe(true);
    expect(code).not.toBe(0);
  });

  it("with the policy OFF, a failing gate does NOT change retry behavior", async () => {
    // Backwards compatibility: the new build signal is passed unconditionally,
    // but decideRecovery's flag-off path ignores it and reproduces
    // shouldStopRetrying verbatim. A failing gate must not start skipping
    // backoffs for operators who never enabled the policy.
    const clock = new RecordingClock();
    const provider = new FakeProvider(1, "the agent wrote some words and then stopped");

    await runAutonomous(
      baseOpts({ clock, providerOverride: provider, gatesOverride: gates(["test_coverage"]) }),
    );

    expect(logLines.some((l) => l.includes("recovery decision 'revise'"))).toBe(false);
    expect(clock.sleeps.some((ms) => ms >= 30_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature 6: the repo profile actually reaches the prompt.
// ---------------------------------------------------------------------------

describe("repo profile reaches the prompt, not just the disk", () => {
  function seedRepo(): void {
    writeFileSync(
      resolve(tmpRoot, "package.json"),
      '{"scripts":{"build":"tsc","test":"bun test","lint":"eslint ."}}',
    );
  }

  it("injects a NON-EMPTY evidence-backed fragment when the flag is on", async () => {
    // The trap this guards: profileFragment returns "" for any status other
    // than "fresh", and status is "absent" until buildProfile runs. Wiring only
    // the fragment would inject nothing forever while every flag-off test
    // still passed.
    seedRepo();
    buildProfile({ repoRoot: tmpRoot, lokiDirOverride: resolve(tmpRoot, ".loki") });

    const out = await buildPrompt({
      retry: 0,
      iteration: 1,
      prd: null,
      ctx: {
        cwd: tmpRoot,
        env: { LOKI_REPO_PROFILE: "1", LOKI_DIR: resolve(tmpRoot, ".loki") },
      },
    });

    expect(out).toContain("Repository profile (evidence-backed, local)");
    expect(out).toContain("script.test=test (from package.json)");
    expect(out).toContain("language=javascript");
  });

  it("is byte-absent from the prompt with the flag off, even when a profile exists on disk", async () => {
    seedRepo();
    buildProfile({ repoRoot: tmpRoot, lokiDirOverride: resolve(tmpRoot, ".loki") });

    const on = await buildPrompt({
      retry: 0,
      iteration: 1,
      prd: null,
      ctx: { cwd: tmpRoot, env: { LOKI_REPO_PROFILE: "1", LOKI_DIR: resolve(tmpRoot, ".loki") } },
    });
    const off = await buildPrompt({
      retry: 0,
      iteration: 1,
      prd: null,
      ctx: { cwd: tmpRoot, env: { LOKI_DIR: resolve(tmpRoot, ".loki") } },
    });

    expect(off).not.toContain("Repository profile");
    // The fragment is the ONLY difference between the two prompts.
    expect(off.length).toBeLessThan(on.length);
  });

  it("sits in the cache-stable prefix, above [CACHE_BREAKPOINT]", async () => {
    // The profile is hash-invalidated and TTL-bounded, so it must not sit in
    // <dynamic_context> where it would bust the prompt cache every iteration.
    seedRepo();
    buildProfile({ repoRoot: tmpRoot, lokiDirOverride: resolve(tmpRoot, ".loki") });

    const out = await buildPrompt({
      retry: 0,
      iteration: 1,
      prd: null,
      ctx: { cwd: tmpRoot, env: { LOKI_REPO_PROFILE: "1", LOKI_DIR: resolve(tmpRoot, ".loki") } },
    });

    expect(out.indexOf("Repository profile")).toBeLessThan(out.indexOf("[CACHE_BREAKPOINT]"));
  });

  it("a stale profile injects NOTHING rather than stale facts", async () => {
    seedRepo();
    buildProfile({ repoRoot: tmpRoot, lokiDirOverride: resolve(tmpRoot, ".loki") });
    // Change the evidence: the content hash no longer matches -> stale_hash.
    writeFileSync(resolve(tmpRoot, "package.json"), '{"scripts":{"test":"pytest"}}');

    const out = await buildPrompt({
      retry: 0,
      iteration: 1,
      prd: null,
      ctx: { cwd: tmpRoot, env: { LOKI_REPO_PROFILE: "1", LOKI_DIR: resolve(tmpRoot, ".loki") } },
    });

    expect(out).not.toContain("Repository profile");
  });

  it("the runner's writer and the prompt's reader address the SAME file", async () => {
    // If the writer used ctx.lokiDir while the reader resolved LOKI_DIR, the
    // fragment would stay empty forever with the flag ON -- a false-green no
    // flag-off test could catch. Drive the real loop, then build a prompt the
    // way the loop does and require the facts to be present.
    seedRepo();
    process.env["LOKI_REPO_PROFILE"] = "1";
    process.env["LOKI_DIR"] = resolve(tmpRoot, ".loki");

    const provider = new FakeProvider(0, "done");
    await runAutonomous(
      baseOpts({ maxIterations: 2, providerOverride: provider, gatesOverride: gates([]) }),
    );

    expect(logLines.some((l) => l.includes("repo profile derived:"))).toBe(true);

    const out = await buildPrompt({
      retry: 0,
      iteration: 1,
      prd: null,
      ctx: { cwd: tmpRoot, env: process.env },
    });
    expect(out).toContain("Repository profile (evidence-backed, local)");
  });

  it("the runner writes no profile at all when the flag is off", async () => {
    seedRepo();
    const provider = new FakeProvider(0, "done");
    await runAutonomous(
      baseOpts({ maxIterations: 2, providerOverride: provider, gatesOverride: gates([]) }),
    );
    expect(logLines.some((l) => l.includes("repo profile derived:"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Feature 5: capability/task-class routing is active in the runner.
//
// capability_router.ts had zero production callers. harness_intelligence.test.ts
// asserted its semantics directly, and every one of those assertions stayed
// green while the runner never once called routeTaskClass -- the same failure
// mode features 6 and 8 had above.
//
// So these drive the REAL loop and observe the tier that actually reached
// provider.invoke(). The primary assertion is a DIFFERENTIAL: the same scenario
// run flag-off and flag-on must dispatch DIFFERENT tier sequences. A test that
// only asserts the flag-on shape would still pass against a hardcoded tier.
// ---------------------------------------------------------------------------

// Drive the loop and return the tier handed to the provider each iteration.
async function tierSequence(overrides: Partial<RunnerOpts> = {}): Promise<string[]> {
  const provider = new FakeProvider(0, "done");
  await runAutonomous(
    // maxIterations 6 -> the cap check fires after the increment and before the
    // provider call, so iterations 1..5 dispatch: 5 calls, one more than the 4
    // the assertions index. Not sitting on the boundary.
    baseOpts({ maxIterations: 6, providerOverride: provider, gatesOverride: gates([]), ...overrides }),
  );
  const seq = provider.calls.map((c) => String(c.tier));
  // A short loop must fail LOUDLY here rather than producing `undefined`
  // comparisons downstream. A differential over two length-1 arrays looks like
  // a broken feature when the feature is fine.
  expect(seq.length).toBeGreaterThanOrEqual(4);
  return seq;
}

describe("capability router is active in the runner, not dormant", () => {
  it("DIFFERENTIAL: the dispatched tier sequence changes when the flag flips", async () => {
    // Legacy tier switching makes the RARV cycle rotate the phase, which is
    // what the task class is derived from. Without it a pinned session reports
    // one tier for every iteration and there is nothing to route.
    process.env["LOKI_LEGACY_TIER_SWITCHING"] = "true";

    const off = await tierSequence();
    process.env["LOKI_CAPABILITY_ROUTER"] = "1";
    const on = await tierSequence();

    // The claim: routing changed what the runner actually dispatched.
    expect(on).not.toEqual(off);
    expect(on.length).toBe(off.length);
    expect(on.length).toBeGreaterThan(0);
  });

  it("routes clean RARV phases to the tier their task class needs", async () => {
    process.env["LOKI_LEGACY_TIER_SWITCHING"] = "true";
    process.env["LOKI_CAPABILITY_ROUTER"] = "1";

    const seq = await tierSequence();

    // iteration 1 = ACT (implementation -> development)
    // iteration 2 = REFLECT (review -> development)
    // iteration 3 = VERIFY (verification -> fast)
    // At the cycle boundary the harness has accumulated a retry, so iteration
    // 4 is correctly short-circuited to recovery rather than planning.
    expect(seq[0]).toBe("development");
    expect(seq[1]).toBe("development");
    expect(seq[2]).toBe("fast");
    expect(seq[3]).toBe("development");
  });

  it("routing reclassifies a SESSION-PINNED run the RARV cycle would have frozen", async () => {
    // The sharpest evidence that routing is real. With a sonnet-pinned session
    // and legacy switching OFF (the shipping default), getRarvTier returns
    // "development" for EVERY iteration -- the un-routed loop dispatches one
    // frozen tier forever. Only the router can vary it by the work being done.
    //
    // This also isolates routing from the RARV cycle: under legacy switching
    // the cycle tier and the routed tier coincide, so that path cannot tell a
    // real router apart from a passthrough.
    //
    // LOKI_SESSION_MODEL is intentionally left unset: the ceiling must be
    // threaded from ctx.sessionModel, not read from the ambient environment.
    const off = await tierSequence({ sessionModel: "sonnet" });
    expect(new Set(off).size).toBe(1);
    expect(off[0]).toBe("development");

    process.env["LOKI_CAPABILITY_ROUTER"] = "1";
    const on = await tierSequence({ sessionModel: "sonnet" });

    // Verification work now routes DOWN to fast instead of burning sonnet.
    expect(new Set(on).size).toBeGreaterThan(1);
    expect(on).not.toEqual(off);
    // iteration 3 = VERIFY -> verification -> fast. A mutation collapsing the
    // task-class table to a single tier fails right here.
    expect(on[2]).toBe("fast");
  });

  it("a haiku-pinned session is never routed ABOVE its ceiling", async () => {
    // The session ceiling is the operator's cost guarantee. Routing may go
    // DOWN from it, never UP. Without the clamp, planning work on a haiku
    // session would silently dispatch opus.
    process.env["LOKI_CAPABILITY_ROUTER"] = "1";
    process.env["LOKI_LEGACY_TIER_SWITCHING"] = "true";
    // Deliberately NOT setting LOKI_SESSION_MODEL: the ceiling must come from
    // the sessionModel the runner resolved. This fails if the runner leaves the
    // router reading process.env instead of threading ctx.sessionModel.
    const seq = await tierSequence({ sessionModel: "haiku" });

    expect(seq.length).toBeGreaterThan(0);
    for (const t of seq) expect(t).toBe("fast");
  });

  it("an explicit tier pin survives routing and reaches dispatch", async () => {
    // Explicit override outranks the task-class table. The router resolves the
    // tier, then the pin names the model for it -- so the TIER we dispatch must
    // still be the routed one (providers.ts owns model identity).
    process.env["LOKI_CAPABILITY_ROUTER"] = "1";
    process.env["LOKI_MODEL_DEVELOPMENT"] = "pinned-dev-model";
    process.env["LOKI_LEGACY_TIER_SWITCHING"] = "true";

    const seq = await tierSequence();

    // ACT/REFLECT still route to development; the pin does not move the tier.
    expect(seq[0]).toBe("development");
    expect(seq[1]).toBe("development");
  });

  it("a retry routes as recovery and never below development", async () => {
    // Recovery re-attempts work that already failed. Routing it to `fast`
    // is how a build burns its remaining attempts without progressing.
    process.env["LOKI_CAPABILITY_ROUTER"] = "1";
    process.env["LOKI_LEGACY_TIER_SWITCHING"] = "true";

    // Fail the provider so the loop retries; retryCount > 0 forces "recovery".
    const provider = new FakeProvider(1, "transient blip");
    await runAutonomous(
      baseOpts({
        maxIterations: 3,
        maxRetries: 3,
        baseWaitSeconds: 0,
        providerOverride: provider,
        gatesOverride: gates([]),
      }),
    );

    const tiers = provider.calls.map((c) => String(c.tier));
    expect(tiers.length).toBeGreaterThan(1);
    // Retries must never dispatch below development.
    for (const t of tiers.slice(1)) expect(t).toBe("development");
  });

  it("the recovery short-circuit is what keeps a retried VERIFY off the fast tier", async () => {
    // The discriminating case, asserted on the derivation directly.
    //
    // The loop test above cannot prove this: `implementation` and `recovery`
    // BOTH map to development, so it passes with or without the short-circuit.
    // The two classes only diverge on a VERIFY iteration, where a first attempt
    // is verification (-> fast) and a retry must be recovery (-> development).
    expect(taskClassForIteration("VERIFY", 0)).toBe("verification");
    expect(taskClassForIteration("VERIFY", 1)).toBe("recovery");

    // And that difference is consequential at the tier level.
    const env = { LOKI_CAPABILITY_ROUTER: "1" };
    expect(routeTaskClass("verification", "sonnet", { env }).tier).toBe("fast");
    expect(routeTaskClass("recovery", "sonnet", { env }).tier).toBe("development");
  });

  // --- flag-off must be a byte-exact no-op ---------------------------------
  //
  // This is the one case unit tests cannot see, and the only way this
  // activation can regress a shipping default. routeTaskClass() returns
  // tier:"development" for BOTH "router_off" and "unknown_task_class", so an
  // unconditional assignment silently clobbers a pinned session.

  it("flag OFF leaves an opus-pinned session untouched", async () => {
    process.env["LOKI_SESSION_MODEL"] = "opus";
    const seq = await tierSequence({ sessionModel: "opus" });

    expect(seq.length).toBeGreaterThan(0);
    // Would be "development" if the router_off decision were assigned.
    for (const t of seq) expect(t).toBe("planning");
  });

  it("flag OFF leaves a fable-pinned session untouched", async () => {
    // fable is not a CapabilityTier and sessionCeiling() maps it to null, so
    // it is the pin most easily lost. Must survive both flag states.
    process.env["LOKI_SESSION_MODEL"] = "fable";
    const seq = await tierSequence({ sessionModel: "fable" });

    expect(seq.length).toBeGreaterThan(0);
    for (const t of seq) expect(t).toBe("fable");
  });

  it("flag ON also leaves a fable-pinned session untouched", async () => {
    // The router has no fable ceiling, so the runner skips routing entirely
    // rather than discarding the pin.
    process.env["LOKI_CAPABILITY_ROUTER"] = "1";
    process.env["LOKI_SESSION_MODEL"] = "fable";
    const seq = await tierSequence({ sessionModel: "fable" });

    expect(seq.length).toBeGreaterThan(0);
    for (const t of seq) expect(t).toBe("fable");
  });

  it("flag OFF logs no routing decision at all", async () => {
    process.env["LOKI_LEGACY_TIER_SWITCHING"] = "true";
    await tierSequence();
    expect(logLines.some((l) => l.includes("capability router:"))).toBe(false);
  });
});
