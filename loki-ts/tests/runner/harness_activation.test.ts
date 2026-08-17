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
import { runAutonomous } from "../../src/runner/autonomous.ts";
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
