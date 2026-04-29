// Skeleton port of run_autonomous() (autonomy/run.sh:10168-11108).
//
// Phase 4 Dev A1 deliverable. This file owns the control flow of the
// autonomous loop. Helpers (build_prompt, state.save, council, providers,
// budget tracker, gates) live in sibling modules being authored by the
// C1-C3 / B1 agents in parallel; we import them dynamically so this skeleton
// builds and tests pass even when those modules are missing.
//
// Bash citations are kept inline next to each ported block so reviewers can
// diff against the source while the integration is wired up.

import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  realClock,
  type Clock,
  type CouncilHook,
  type IterationOutcome,
  type ProviderInvocation,
  type ProviderInvoker,
  type ProviderName,
  type ProviderResult,
  type RunnerContext,
  type RunnerOpts,
  type SessionTier,
  type SignalSource,
  type TerminateReason,
} from "./types.ts";
import { run as shellRun } from "../util/shell.ts";

// ---------------------------------------------------------------------------
// Graceful dynamic imports.
//
// The C1/C2/C3/B1 agents are still writing these modules. We must compile and
// test today, so each helper is loaded via `import().catch()` and we fall
// back to a no-op stub when the module is missing. Once the real module
// lands, the loop picks it up automatically with no code change here.
// ---------------------------------------------------------------------------

type StateMod = {
  // v7.4.4 (BUG-24): runner-shaped adapters. The plain `saveState(ctx)` in
  // state.ts takes a single SaveStateContext; calling it with the runner's
  // RunnerContext + extra args silently wrote malformed JSON. The adapters
  // bridge the shapes; tryImport gates on these marker keys.
  loadStateForRunner(ctx: RunnerContext): Promise<void>;
  saveStateForRunner(ctx: RunnerContext, status: string, exitCode: number): Promise<void>;
};

type PromptMod = {
  buildPrompt(ctx: RunnerContext): Promise<string>;
};

type CouncilMod = {
  councilInit(prdPath: string | undefined): Promise<void>;
  defaultCouncil: CouncilHook;
};

type ProviderMod = {
  resolveProvider(name: ProviderName): Promise<ProviderInvoker>;
};

type QueueMod = {
  populatePrdQueue(ctx: RunnerContext): Promise<void>;
  populateBmadQueue(ctx: RunnerContext): Promise<void>;
  populateOpenspecQueue(ctx: RunnerContext): Promise<void>;
  populateMirofishQueue(ctx: RunnerContext): Promise<void>;
};

type BudgetMod = {
  // v7.4.2 fix (BUG-22): the runner-shaped adapter returns boolean.
  // The plain `checkBudgetLimit(opts)` returns an object and is for direct
  // callers; using it via this interface caused an infinite loop because JS
  // treated the truthy object as "over budget" on every iteration.
  checkBudgetLimitForRunner(ctx: RunnerContext): Promise<boolean>;
};

type CompletionMod = {
  checkCompletionPromise(ctx: RunnerContext, capturedOutputPath: string): Promise<boolean>;
};

// v7.5.0: signature matches the real implementation in quality_gates.ts.
// runQualityGates returns a structured GateOutcome and only takes RunnerContext.
// Pre-v7.5.0 this type expected (ctx, exitCode) -> Promise<void> AND looked up
// the wrong file ("./gates.ts" instead of "./quality_gates.ts") so gatesMod
// was always null. Both fixed together.
type GateOutcomeShape = {
  passed: string[];
  failed: string[];
  blocked: boolean;
  escalated: boolean;
};
type GatesMod = {
  runQualityGates(ctx: RunnerContext): Promise<GateOutcomeShape>;
};

// Generic runtime type guard: verifies that every `key` in `keys` is present
// on `mod` AND points at a function value. Narrows `mod` to a record where
// every listed key is a function, which is the strongest contract we can
// enforce on a dynamically-imported module without pulling in zod.
//
// v7.5.8: replaces the prior bare `as unknown as T` cast in tryImport. The
// cast lied to the type-system because it claimed conformance after only
// checking the keys via a side-effecting loop -- a refactor that renamed a
// validator key would compile clean while shipping a runtime crash. The
// guard below makes the post-condition explicit and enforced.
function hasRequiredFunctions<K extends string>(
  mod: Record<string, unknown>,
  keys: readonly K[],
): mod is Record<K, (...args: unknown[]) => unknown> & Record<string, unknown> {
  for (const k of keys) {
    if (typeof mod[k] !== "function") return false;
  }
  return true;
}

// Dynamic import that validates the module exposes the expected function
// names. Two failure modes are distinguished:
//
//   1. Module not found / import error -> return null. Sibling modules being
//      authored in parallel by other Phase-4 agents may not yet exist on
//      disk; the loop falls back to a stub for these.
//
//   2. Module loaded but missing one of the required keys, OR the key is
//      present but not a function -> throw a clear error naming the spec
//      path AND the offending key. This is a contract violation (the file
//      exists, so it MUST conform) and silently null-returning would mask
//      the bug behind a stub fallback for the rest of the run.
export async function tryImport<T>(spec: string, requiredKeys: readonly string[] = []): Promise<T | null> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(spec)) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Module loaded -- validate each required key. Throw on the FIRST offender
  // so the error message points at exactly one missing/wrong key per run.
  for (const k of requiredKeys) {
    if (typeof mod[k] !== "function") {
      const actual = mod[k] === undefined ? "missing" : `${typeof mod[k]}`;
      throw new Error(
        `tryImport(${spec}): required export '${k}' is ${actual} (expected function)`,
      );
    }
  }
  if (!hasRequiredFunctions(mod, requiredKeys)) {
    // Defensive -- the loop above already throws, but the type guard makes
    // the narrowing explicit for downstream callers.
    throw new Error(`tryImport(${spec}): runtime contract validation failed`);
  }
  return mod as unknown as T;
}

// ---------------------------------------------------------------------------
// Default fallbacks for unimplemented modules. Each one logs once so the
// developer can see exactly which Phase-4 agent's work is still pending.
// ---------------------------------------------------------------------------

const stubLogged = new Set<string>();
function logStub(ctx: RunnerContext, name: string): void {
  if (stubLogged.has(name)) return;
  stubLogged.add(name);
  ctx.log(`[runner] stub: ${name} not yet implemented; skipping`);
}

const noopCouncil: CouncilHook = {
  async shouldStop(): Promise<boolean> {
    return false;
  },
};

// FakeProvider for the unimplemented case -- always returns exitCode 1 so the
// loop exercises its retry path. Tests inject a real FakeProvider via
// RunnerOpts.providerOverride.
const stubProvider: ProviderInvoker = {
  async invoke(call: ProviderInvocation): Promise<ProviderResult> {
    return { exitCode: 1, capturedOutputPath: call.iterationOutputPath };
  },
};

// v7.5.3: route through the richer intervention.ts module (PAUSE/STOP/INPUT
// signals, prompt-injection limits, quarantine-on-validation-fail) instead
// of the inline 4-line stub. Falls back to inline check on dynamic-import
// failure so the loop never wedges. Honest-audit gap #6 closed.
const fileSignals: SignalSource = {
  async checkHumanIntervention(ctx: RunnerContext): Promise<0 | 1 | 2> {
    try {
      const mod = await import("./intervention.ts");
      const result = mod.checkHumanIntervention({
        lokiDirOverride: ctx.lokiDir,
        autonomyMode: ctx.autonomyMode === "perpetual" ? "perpetual" : "standard",
      });
      switch (result.action) {
        case "stop":
          return 2;
        case "pause":
        case "input":
          return 1;
        default:
          return 0;
      }
    } catch {
      const stop = resolve(ctx.lokiDir, "STOP");
      const pause = resolve(ctx.lokiDir, "PAUSE");
      if (existsSync(stop)) return 2;
      if (existsSync(pause)) return 1;
      return 0;
    }
  },
  async isBudgetExceeded(): Promise<boolean> {
    return false;
  },
};

// ---------------------------------------------------------------------------
// Public entrypoint.
// ---------------------------------------------------------------------------

export async function runAutonomous(opts: RunnerOpts): Promise<number> {
  const ctx = makeContext(opts);
  const log = ctx.log;
  const clock = opts.clock ?? realClock;
  const signals = opts.signals ?? fileSignals;

  log("[runner] Starting autonomous execution");
  log(`[runner] PRD: ${ctx.prdPath ?? "Codebase Analysis Mode"}`);
  log(`[runner] provider=${ctx.provider} mode=${ctx.autonomyMode} model=${ctx.sessionModel}`);
  log(`[runner] max_retries=${ctx.maxRetries} max_iterations=${ctx.maxIterations}`);

  ensureLokiDirs(ctx);
  // v7.4.9: refuse to start if a bash runner (or another Bun runner) is
  // already holding the session lock. Mirrors autonomy/run.sh:3013-3060.
  acquireSessionSingleton(ctx);

  // -- Initialization (run.sh:10231-10302) ---------------------------------
  // NOTE: required-key lists encode the contract this loop expects. Sibling
  // modules under loki-ts/src/runner/ that don't yet expose the listed
  // functions are treated as missing until they conform. See types.ts.
  // v7.4.4 (BUG-24) regression guard: prefer test injection over dynamic
  // import. Tests use this to instrument saveCallCount/loadCallCount and
  // prove the adapter path was taken (not the no-op fallback throw).
  const stateMod: StateMod | null = opts.stateOverride
    ? (opts.stateOverride as StateMod)
    : await tryImport<StateMod>("./state.ts", ["loadStateForRunner", "saveStateForRunner"]);
  // build_prompt.ts in tree (Phase4 B-agent) accepts BuildPromptOpts (different
  // shape from RunnerContext). Until an adapter exposes a runner-shaped
  // wrapper, gate on a marker key the adapter will publish.
  const promptMod = await tryImport<PromptMod>("./build_prompt.ts", ["buildPromptForRunner"]);
  const councilMod = await tryImport<CouncilMod>("./council.ts", ["councilInit"]);
  const providerMod = await tryImport<ProviderMod>("./providers.ts", ["resolveProvider"]);
  const queueMod = await tryImport<QueueMod>("./queues.ts", [
    "populateBmadQueue",
    "populateOpenspecQueue",
    "populateMirofishQueue",
    "populatePrdQueue",
  ]);
  // budget.ts in tree (Phase4 C-agent) exposes checkBudgetLimit with a
  // different signature -- it takes CheckBudgetOptions and returns an object.
  // Until the adapter wraps it, treat as not-yet-conformant by requiring a
  // contract marker the runner-side adapter will eventually add.
  const budgetMod = await tryImport<BudgetMod>("./budget.ts", [
    "checkBudgetLimitForRunner",
  ]);
  const completionMod = await tryImport<CompletionMod>("./completion.ts", [
    "checkCompletionPromise",
  ]);
  // v7.5.0 fix: was "./gates.ts" but the actual file is quality_gates.ts.
  // Pre-existing bug: gatesMod was always null, so runQualityGates never
  // executed from the autonomous loop. Fixed so the gate pipeline (and
  // Phase 1 wiring on top of it) is reachable.
  const gatesMod = await tryImport<GatesMod>("./quality_gates.ts", ["runQualityGates"]);

  if (stateMod) await stateMod.loadStateForRunner(ctx);
  else logStub(ctx, "state.loadState");

  if (councilMod) await councilMod.councilInit(ctx.prdPath);
  else logStub(ctx, "council.councilInit");

  if (queueMod) {
    await queueMod.populateBmadQueue(ctx);
    await queueMod.populateOpenspecQueue(ctx);
    await queueMod.populateMirofishQueue(ctx);
    await queueMod.populatePrdQueue(ctx);
  } else {
    logStub(ctx, "queues.populate*");
  }

  const council: CouncilHook = opts.council ?? councilMod?.defaultCouncil ?? noopCouncil;

  // Resolve provider invoker (test override > real module > stub).
  let provider: ProviderInvoker;
  if (opts.providerOverride) {
    provider = opts.providerOverride;
  } else if (providerMod) {
    provider = await providerMod.resolveProvider(ctx.provider);
  } else {
    logStub(ctx, "providers.resolveProvider");
    provider = stubProvider;
  }

  // Pre-loop max-iterations gate (run.sh:10303-10306).
  if (ctx.iterationCount >= ctx.maxIterations) {
    log(`[runner] max iterations already reached (${ctx.iterationCount}/${ctx.maxIterations})`);
    return 1;
  }

  // -- Main loop (run.sh:10308-11099) --------------------------------------
  while (ctx.retryCount < ctx.maxRetries) {
    // BUG-ST-010: pause/stop check BEFORE incrementing iteration count.
    const intervention = await signals.checkHumanIntervention(ctx);
    if (intervention === 1) {
      log("[runner] PAUSE signal -- waiting and re-checking");
      // v7.4.3 (BUG-18): persist "paused" state so loadState resume sees
      // the correct status instead of stale "running".
      await persistState(stateMod, ctx, "paused", 0);
      await clock.sleep(50); // tests use virtual clock; real value lives in run.sh
      continue;
    }
    if (intervention === 2) {
      log("[runner] STOP signal -- exiting cleanly");
      await persistState(stateMod, ctx, "stopped", 0);
      return 0;
    }

    // Budget check (run.sh:10316). When over-budget we sleep briefly before
    // re-checking; without the sleep the loop spins on a stale signal until
    // the operator clears the PAUSE marker. (Reviewer A3 finding 2026-04-25.)
    //
    // v7.4.2 fix (BUG-22): the previous call to `checkBudgetLimit(ctx)`
    // returned the OBJECT shape (not boolean), and JS treated the truthy
    // object as "over budget" on every iteration -> infinite loop hung
    // autonomous.test.ts. Use the adapter that returns boolean.
    const overBudget = budgetMod
      ? await budgetMod.checkBudgetLimitForRunner(ctx)
      : await signals.isBudgetExceeded(ctx);
    if (overBudget) {
      log("[runner] budget limit exceeded -- pausing");
      await persistState(stateMod, ctx, "budget_exceeded", 0);
      await clock.sleep(60_000); // 60s backoff matches bash autonomy/run.sh:7910
      continue;
    }

    // Policy check (run.sh:10447 check_policy). Phase 4 ships the state
    // transition; the actual policy engine port lives in Phase 5+.
    if (opts.policyCheck) {
      try {
        const allowed = await opts.policyCheck(ctx);
        if (!allowed) {
          log("[runner] policy engine denied iteration -- continuing without invoke");
          await persistState(stateMod, ctx, "policy_blocked", 0);
          await clock.sleep(5_000);
          continue;
        }
      } catch (err) {
        log(`[runner] policy check threw: ${(err as Error).message}`);
      }
    }

    ctx.iterationCount += 1;

    if (ctx.iterationCount > ctx.maxIterations) {
      log(`[runner] max iterations reached (${ctx.iterationCount - 1}/${ctx.maxIterations})`);
      await persistState(stateMod, ctx, "max_iterations_reached", 0);
      return 0;
    }

    // Build prompt (run.sh:10342). Wrap in try/catch -- a thrown buildPrompt
    // would otherwise abort the whole loop with no retry. (Reviewer A3 + DA
    // findings 2026-04-25.) On failure we use the stub-prompt so the loop
    // can advance and surface the failure via provider invocation logs.
    let prompt: string;
    try {
      prompt = promptMod
        ? await promptMod.buildPrompt(ctx)
        : `[stub-prompt iteration=${ctx.iterationCount} retry=${ctx.retryCount}]`;
      if (!promptMod) logStub(ctx, "build_prompt.buildPrompt");
    } catch (err) {
      log(`[runner] buildPrompt threw: ${(err as Error).message} -- using stub`);
      prompt = `[stub-prompt-fallback iteration=${ctx.iterationCount} retry=${ctx.retryCount}]`;
    }

    // v7.5.2: wire rarv.ts so the RARV phase + tier is logged per iteration
    // (matches autonomy/run.sh:10515 `RARV Phase: $rarv_phase -> Tier: ...`).
    // Pre-v7.5.2 the rarv module exported getRarvPhaseName/getRarvTier but
    // had zero production callers; the bash route logs the phase, the Bun
    // route silently swallowed it.
    try {
      const rarvMod = await import("./rarv.ts");
      const phase = rarvMod.getRarvPhaseName(ctx.iterationCount);
      const tier = rarvMod.getRarvTier(ctx.iterationCount, {
        sessionModel: typeof ctx.sessionModel === "string" ? ctx.sessionModel : undefined,
      });
      log(`[runner] RARV Phase: ${phase} -> Tier: ${tier}`);
      ctx.currentTier = tier;
    } catch (err) {
      log(`[runner] rarv module load failed (non-fatal): ${(err as Error).message}`);
    }

    log(`[runner] Attempt ${ctx.retryCount + 1}/${ctx.maxRetries} iteration=${ctx.iterationCount}`);
    await persistState(stateMod, ctx, "running", 0);

    // Provider invocation (run.sh:10500-10800).
    const startedAt = clock.now();
    const iterOutputPath = makeIterationOutputPath(ctx);
    let result: ProviderResult;
    try {
      result = await provider.invoke({
        provider: ctx.provider,
        prompt,
        tier: ctx.currentTier,
        cwd: ctx.cwd,
        iterationOutputPath: iterOutputPath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[runner] provider invocation threw: ${msg}`);
      result = { exitCode: 1, capturedOutputPath: iterOutputPath };
    }
    const durationSec = Math.max(0, Math.floor((clock.now() - startedAt) / 1000));

    const outcome: IterationOutcome = {
      exitCode: result.exitCode,
      durationSeconds: durationSec,
      capturedOutputPath: result.capturedOutputPath,
    };

    // v7.4.3 (BUG-17): persist "exited" state immediately after the provider
    // returns, so dashboard sees the per-iteration transition (was missing
    // -- only terminal states were persisted).
    await persistState(stateMod, ctx, "exited", outcome.exitCode);

    // v7.4.3 (BUG-20): create a checkpoint after each successful iteration
    // (sec 13 of STATE-MACHINES.md). Wrapped so checkpoint failure doesn't
    // abort the loop -- the checkpoint is recovery aid, not control flow.
    if (outcome.exitCode === 0) {
      try {
        const ckptMod = await tryImport<{
          createCheckpoint(opts: {
            iteration: number;
            taskId: string;
            taskDescription?: string;
            forceCreate?: boolean;
          }): Promise<unknown>;
        }>("./checkpoint.ts", ["createCheckpoint"]);
        if (ckptMod) {
          await ckptMod.createCheckpoint({
            iteration: ctx.iterationCount,
            taskId: ctx.prdPath ?? "codebase-analysis",
            taskDescription: `iteration ${ctx.iterationCount} success`,
            forceCreate: true,
          });
        }
      } catch (err) {
        log(`[runner] createCheckpoint failed (non-fatal): ${(err as Error).message}`);
      }
    }

    // Quality gates (run.sh:10845-10980).
    // v7.5.0: signature corrected -- runQualityGates(ctx) only. The exitCode
    // arg was never consumed by the real implementation; Phase 1 wiring
    // (findings injection, learnings, escalation handoff) hangs off this call.
    if (gatesMod) {
      try {
        await gatesMod.runQualityGates(ctx);
      } catch (err) {
        // Gate runner errors are best-effort -- the bash equivalent at
        // run.sh:10845-10980 logs and continues. Do not crash the loop.
        log(`[runner] runQualityGates threw (non-fatal): ${(err as Error).message}`);
      }
    } else {
      logStub(ctx, "gates.runQualityGates");
    }

    if (council.trackIteration) {
      try {
        await council.trackIteration(outcome.capturedOutputPath ?? iterOutputPath);
      } catch (err) {
        log(`[runner] council.trackIteration failed: ${(err as Error).message}`);
      }
    }

    // Success branch (run.sh:10989-11055) ---------------------------------
    if (outcome.exitCode === 0) {
      // Perpetual mode: never stop on success.
      if (ctx.autonomyMode === "perpetual") {
        ctx.retryCount = 0;
        continue;
      }

      // Council vote.
      try {
        if (await council.shouldStop(ctx)) {
          log("[runner] COMPLETION COUNCIL: project complete");
          await persistState(stateMod, ctx, "council_approved", 0);
          return 0;
        }
      } catch (err) {
        log(`[runner] council.shouldStop failed: ${(err as Error).message}`);
      }

      // Completion promise / loki_complete_task signal.
      const completed = completionMod
        ? await completionMod
            .checkCompletionPromise(ctx, outcome.capturedOutputPath ?? iterOutputPath)
            .catch(() => false)
        : await defaultCompletionPromiseCheck(ctx, outcome.capturedOutputPath ?? iterOutputPath);
      if (completed) {
        log("[runner] completion promise fulfilled");
        await persistState(stateMod, ctx, "completion_promise_fulfilled", 0);
        return 0;
      }

      // Default: continue immediately on success (run.sh:11041 BUG-RUN-010).
      ctx.retryCount = 0;
      continue;
    }

    // Failure branch (run.sh:11057-11096) ---------------------------------
    let wait = computeBackoffSeconds(ctx);

    // v7.4.3 (BUG-19): integrate isRateLimited from budget.ts. When the
    // captured output looks rate-limited, override the exponential backoff
    // with the rate-limit-aware backoff (clamped 60-300s per bash idiom).
    try {
      const captured = result.capturedOutputPath;
      const txt =
        captured && existsSync(captured)
          ? readFileSyncSafeForRunner(captured)
          : "";
      if (txt) {
        const budgetMod2 = await tryImport<{
          isRateLimited(text: string): boolean;
          calculateRateLimitBackoff(retryAfter?: number, providerRpm?: number): number;
        }>("./budget.ts", ["isRateLimited", "calculateRateLimitBackoff"]);
        if (budgetMod2 && budgetMod2.isRateLimited(txt)) {
          const rl = budgetMod2.calculateRateLimitBackoff();
          wait = Math.max(wait, rl);
          log(`[runner] rate-limit detected; backoff bumped to ${wait}s`);
        }
      }
    } catch (err) {
      log(`[runner] rate-limit probe failed (non-fatal): ${(err as Error).message}`);
    }

    log(`[runner] iteration failed (exit=${outcome.exitCode}); retry in ${wait}s`);
    await clock.sleep(wait * 1000);
    ctx.retryCount += 1;
  }

  log(`[runner] max retries (${ctx.maxRetries}) exceeded`);
  await persistState(stateMod, ctx, "failed", 1);
  return 1;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// v7.4.3 (BUG-19): tail-read a file safely; cap at 64KB to avoid OOM on big logs.
function readFileSyncSafeForRunner(path: string): string {
  try {
    const buf = readFileSync(path);
    const cap = 65536;
    return buf.byteLength <= cap ? buf.toString("utf8") : buf.subarray(buf.byteLength - cap).toString("utf8");
  } catch {
    return "";
  }
}

function makeContext(opts: RunnerOpts): RunnerContext {
  const cwd = opts.cwd ?? process.cwd();
  const lokiDir = process.env["LOKI_DIR"] ?? resolve(cwd, ".loki");
  const log = (line: string) => {
    if (opts.loggerStream) {
      opts.loggerStream.write(line + "\n");
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  };
  return {
    cwd,
    lokiDir,
    prdPath: opts.prdPath,
    provider: opts.provider ?? "claude",
    maxRetries: opts.maxRetries ?? 5,
    maxIterations: opts.maxIterations ?? 100,
    baseWaitSeconds: opts.baseWaitSeconds ?? 30,
    maxWaitSeconds: opts.maxWaitSeconds ?? 3600,
    autonomyMode: opts.autonomyMode ?? "checkpoint",
    sessionModel: opts.sessionModel ?? "sonnet",
    budgetLimit: opts.budgetLimit,
    completionPromise: opts.completionPromise,
    iterationCount: 0,
    retryCount: 0,
    currentTier: opts.sessionModel ?? "development",
    log,
  };
}

function ensureLokiDirs(ctx: RunnerContext): void {
  for (const sub of ["", "logs", "state", "quality", "queue", "checklist"]) {
    const p = sub ? resolve(ctx.lokiDir, sub) : ctx.lokiDir;
    try {
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    } catch {
      // best-effort; downstream writes will surface real errors
    }
  }
  cleanStaleSignalFiles(ctx);
}

// v7.4.16: parity with autonomy/run.sh:3052 cleanup. Only invoked at
// runner startup (after singleton lock is acquired), so we know no other
// runner is alive to need these files. Cleaning on startup prevents the
// user-reported regression where a stale PAUSE_AT_CHECKPOINT from a
// previous Ctrl+C-in-checkpoint-mode session caused fresh `loki start`
// to pause immediately.
//
// Files cleaned:
//   PAUSE                   -- explicit pause request from prior session
//   PAUSE_AT_CHECKPOINT     -- deferred pause from Ctrl+C in prior session
//   PAUSED.md               -- pause-state metadata sibling
//   STOP                    -- explicit stop from prior session
//   COMPLETED               -- prior-session completion sentinel
//   HUMAN_INPUT.md          -- prompt injection from prior session
function cleanStaleSignalFiles(ctx: RunnerContext): void {
  const stale = [
    "PAUSE",
    "PAUSE_AT_CHECKPOINT",
    "PAUSED.md",
    "STOP",
    "COMPLETED",
    "HUMAN_INPUT.md",
  ];
  for (const name of stale) {
    const p = resolve(ctx.lokiDir, name);
    if (!existsSync(p)) continue;
    try {
      unlinkSync(p);
    } catch {
      // best-effort -- if unlink fails (read-only fs, perms), we'll see
      // the symptoms downstream and the orphan-sweep will clean later.
    }
  }
}

// v7.4.9: cross-runtime session singleton.
// The bash runner (autonomy/run.sh:3013-3060) writes `.loki/loki.pid` and
// `.loki/session.lock` at startup and refuses to start if the existing PID
// is alive. The Bun runner now uses the same convention so two runners
// (one bash, one Bun) cannot race on `.loki/` state -- the second one to
// start gets a clear error and exits cleanly. Also writes a sibling
// `.loki/runner-route` so `loki status` / `loki doctor` can report which
// runtime owns the session.
//
// Returns a release function the caller invokes on exit.
function acquireSessionSingleton(ctx: RunnerContext): () => void {
  const pidFile = resolve(ctx.lokiDir, "loki.pid");
  const routeFile = resolve(ctx.lokiDir, "runner-route");

  if (existsSync(pidFile)) {
    let existingPid = 0;
    try {
      existingPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    } catch { /* unreadable - treat as stale */ }
    if (existingPid > 0 && existingPid !== process.pid) {
      let alive = false;
      try {
        process.kill(existingPid, 0);
        alive = true;
      } catch { /* ESRCH -> dead */ }
      if (alive) {
        let route = "unknown";
        try { route = readFileSync(routeFile, "utf8").trim() || "unknown"; } catch { /* missing */ }
        const msg =
          `Another loki session is already running (PID ${existingPid}, route: ${route}).\n` +
          `Stop it first with 'loki stop' or wait for it to finish.\n` +
          `If you believe the lock is stale, remove '${pidFile}' manually.`;
        ctx.log(`[runner] ERROR: ${msg}`);
        process.stderr.write(`${msg}\n`);
        throw new Error("session-singleton: another loki runner is active");
      }
      // Stale -- fall through and overwrite.
      ctx.log(`[runner] reaping stale ${pidFile} (PID ${existingPid} not alive)`);
    }
  }

  try {
    writeFileSync(pidFile, `${process.pid}\n`);
    writeFileSync(routeFile, "bun\n");
  } catch (err) {
    ctx.log(`[runner] WARN: could not write ${pidFile}: ${(err as Error).message}`);
    // Don't fail the run for a write error -- bash runner has the same
    // best-effort pattern. Singleton enforcement is opportunistic.
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try { unlinkSync(pidFile); } catch { /* may have been stolen */ }
    try { unlinkSync(routeFile); } catch { /* same */ }
  };

  // Register exit hooks so kill -TERM and clean exit both clean up.
  const signalCleanup = (signal: NodeJS.Signals): void => {
    release();
    // Re-raise so the caller's exit code reflects the signal.
    process.kill(process.pid, signal);
  };
  process.once("exit", release);
  process.once("SIGINT", () => signalCleanup("SIGINT"));
  process.once("SIGTERM", () => signalCleanup("SIGTERM"));

  return release;
}

function makeIterationOutputPath(ctx: RunnerContext): string {
  const dir = resolve(ctx.lokiDir, "logs");
  const path = resolve(dir, `iter-output-${ctx.iterationCount}-${Date.now()}.log`);
  try {
    writeFileSync(path, "");
  } catch {
    // surfaced by downstream readers
  }
  return path;
}

async function persistState(
  mod: StateMod | null,
  ctx: RunnerContext,
  status: string,
  exitCode: number,
): Promise<void> {
  if (mod) {
    try {
      await mod.saveStateForRunner(ctx, status, exitCode);
    } catch (err) {
      ctx.log(`[runner] saveState failed: ${(err as Error).message}`);
    }
    return;
  }
  // No fallback: state.ts is the only valid writer for autonomy-state.json.
  // Removed the previous snake_case stub because it produced a schema that
  // mismatched the dashboard contract (Reviewer X2 caught it 2026-04-25).
  // If state.ts is missing, fail loudly instead of silently corrupting state.
  ctx.log(
    `[runner] FATAL: src/runner/state.ts not loadable; refusing to write autonomy-state.json with stub schema`,
  );
  throw new Error("state.ts module is required but not loadable");
}

function computeBackoffSeconds(ctx: RunnerContext): number {
  // Mirror calculate_wait() in run.sh: exponential 2^retry * base, capped.
  const expWait = ctx.baseWaitSeconds * Math.pow(2, ctx.retryCount);
  return Math.min(ctx.maxWaitSeconds, Math.max(0, expWait));
}

async function defaultCompletionPromiseCheck(
  ctx: RunnerContext,
  capturedOutput: string,
): Promise<boolean> {
  // Fallback when completion.ts is not yet present. Two signals:
  //   (a) .loki/signals/TASK_COMPLETION_CLAIMED file (loki_complete_task).
  //   (b) literal completion-promise text in the captured output.
  const claimed = resolve(ctx.lokiDir, "signals", "TASK_COMPLETION_CLAIMED");
  if (existsSync(claimed)) return true;

  if (!ctx.completionPromise) return false;
  if (!existsSync(capturedOutput)) return false;
  try {
    const sz = statSync(capturedOutput).size;
    if (sz === 0) return false;
    const r = await shellRun(["grep", "-Fq", ctx.completionPromise, capturedOutput]);
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
