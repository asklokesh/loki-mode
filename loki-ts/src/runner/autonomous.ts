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
import { maybeGenerateProof } from "./proof.ts";
import { cavemanCaptureUserMode } from "../providers/claude_flags.ts";
import { resolvePrdForRun } from "./prd_reuse.ts";

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
// Module-resolution contract (fail-fast, no silent stubs).
//
// During Phase 4 this file shipped logStub() / noopCouncil / stubProvider
// no-op fallbacks for the sibling helper modules (state, council, queues,
// providers, build_prompt) that were still being authored in parallel. All
// five now EXIST and conform to their tryImport marker keys, so those
// fallbacks were unreachable dead code: tryImport only returns null on an
// import FAILURE (missing file) and THROWS on a present-but-nonconforming
// module. A present, conforming module never yields null.
//
// Worse, the fallbacks degraded SILENTLY to WRONG results rather than safe
// no-ops: stubProvider always returned exitCode 1 (every iteration "fails"),
// noopCouncil never stopped (the loop can't complete), a skipped queue/state
// path drops real work, and a missing state writer was already escalated to a
// hard throw in persistState() below (lines documenting the reviewer-caught
// stub-schema corruption, v7.4.25). Removing the remaining stubs makes the
// whole module-resolution policy consistent: a load-bearing helper that
// cannot be loaded is a fatal contract violation, surfaced loudly, not masked
// behind a stub that produces a wrong build. The happy path (all modules
// present, which is the only path that exists today and the one tests
// exercise via the real modules or explicit overrides) is unchanged.
//
// Note: tryImport itself is intentionally left untouched -- its null-on-
// missing return is directly unit-tested. Fail-fast is enforced at the call
// sites by requireModule() below.
// ---------------------------------------------------------------------------

function requireModule<T>(mod: T | null, specForError: string): T {
  if (mod === null) {
    throw new Error(
      `[runner] FATAL: required module ${specForError} is not loadable; ` +
        `refusing to run with a degraded stub (see autonomous.ts module-resolution contract)`,
    );
  }
  return mod;
}

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
  // FEAT-PRD-REUSE: resolve the PRD path BEFORE building the context, so the
  // persisted PRD path (or codebase-analysis mode) propagates into ctx.prdPath
  // (makeContext below reads opts.prdPath) and from there into the prompt
  // builder (build_prompt.ts buildPromptForRunner consumes ctx.prdPath).
  //   - explicit user file  -> copied to .loki/generated-prd.md (source=user),
  //                            opts.prdPath repointed at the generated path.
  //   - no file + persisted -> reuse/update/user_owned -> generated path;
  //                            generate -> undefined (re-enter analysis mode).
  //   - no file + none      -> undefined (codebase-analysis, existing behavior).
  // Never throws (resolvePrdForRun falls back to the input on any error).
  //
  // PARITY (state vs prompt split): bash records state.prdPath from the GLOBAL
  // PRD_PATH (run.sh:12141), which the PRD-reuse persistence logic NEVER
  // repoints; it repoints only a LOCAL prd_path (run.sh:13938) used for the
  // prompt anchor + reuse decision. So bash splits: original user path -> state,
  // resolved/persisted path -> prompt + reuse. Capture the ORIGINAL here before
  // resolvePrdForRun overwrites opts.prdPath, and thread it into ctx so the
  // state writer (state.ts saveStateForRunner) records the original while
  // ctx.prdPath continues to carry the resolved path for the prompt builder.
  // 1st-with-file: state = original file, prompt = .loki/generated-prd.md.
  // 2nd-no-file:   original was undefined -> state = "" (exactly bash).
  const originalPrdPath = opts.prdPath;
  const resolved = resolvePrdForRun({
    prdPath: opts.prdPath,
    cwd: opts.cwd,
    log: opts.loggerStream
      ? (line: string) => opts.loggerStream!.write(line + "\n")
      : (line: string) => {
          // eslint-disable-next-line no-console
          console.log(line);
        },
  });
  opts.prdPath = resolved.prdPath;

  // Build the context once so both the core loop and the post-completion
  // proof-of-run hook see the same iteration count / lokiDir / provider.
  const ctx = makeContext(opts);
  // Stamp the ORIGINAL user-supplied PRD path onto ctx for the state writer.
  // Set unconditionally (string, possibly "") so every persistState call site
  // records bash's global-PRD_PATH value rather than the resolved/persisted
  // path now held in ctx.prdPath. RunnerContext is a type alias (no declaration
  // merging), so attach via an intersection cast rather than editing types.ts.
  (ctx as RunnerContext & { statePrdPath?: string }).statePrdPath =
    originalPrdPath ?? "";
  try {
    return await runAutonomousCore(opts, ctx);
  } finally {
    // R1: shareable proof-of-run. Single call site -> emits on EVERY terminal
    // return (success and failure). Fire-and-forget; never throws.
    await maybeGenerateProof(ctx).catch(() => {});
  }
}

async function runAutonomousCore(
  opts: RunnerOpts,
  ctx: RunnerContext,
): Promise<number> {
  const log = ctx.log;
  const clock = opts.clock ?? realClock;
  const signals = opts.signals ?? fileSignals;

  log("[runner] Starting autonomous execution");
  log(`[runner] PRD: ${ctx.prdPath ?? "Codebase Analysis Mode"}`);
  log(`[runner] provider=${ctx.provider} mode=${ctx.autonomyMode} model=${ctx.sessionModel}`);
  log(`[runner] max_retries=${ctx.maxRetries} max_iterations=${ctx.maxIterations}`);

  ensureLokiDirs(ctx);

  // Capture the user's pre-existing global caveman mode ONCE at startup, before
  // any caveman activate/suppress path runs (providers.ts:292-295). Mirrors the
  // source-time capture in autonomy/lib/claude-flags.sh:574-577: the bash route
  // snapshots CAVEMAN_DEFAULT_MODE into LOKI_CAVEMAN_USER_MODE before clobbering
  // the default tree-wide, so the no-raise / opt-out guard in cavemanActivateEnv
  // has the user's level to read. On the Bun route nothing else populated this
  // var, so without this call the guard was dead and a globally-lite/off user
  // would be silently raised to Loki's level (or have their opt-out ignored).
  cavemanCaptureUserMode();

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

  // Fail-fast: these helpers are load-bearing. A missing/nonconforming module
  // is a fatal contract violation, not a degrade-to-stub condition (test
  // injection still bypasses the real modules via the *Override opts below).
  await requireModule(stateMod, "./state.ts").loadStateForRunner(ctx);

  await requireModule(councilMod, "./council.ts").councilInit(ctx.prdPath);

  const queues = requireModule(queueMod, "./queues.ts");
  await queues.populateBmadQueue(ctx);
  await queues.populateOpenspecQueue(ctx);
  await queues.populateMirofishQueue(ctx);
  await queues.populatePrdQueue(ctx);

  // Council hook: explicit test override wins; otherwise the real module's
  // defaultCouncil. councilMod is guaranteed non-null by the requireModule
  // call above, so there is no silent no-op council fallback.
  const council: CouncilHook = opts.council ?? requireModule(councilMod, "./council.ts").defaultCouncil;

  // Resolve provider invoker (test override > real module). No stub fallback:
  // a missing providers.ts is fatal, not a fake provider that always fails.
  const provider: ProviderInvoker = opts.providerOverride
    ? opts.providerOverride
    : await requireModule(providerMod, "./providers.ts").resolveProvider(ctx.provider);

  // Hoist the prompt + gate module assertions to resolution time so that
  // module ABSENCE is fatal here (consistent with the load-bearing helpers
  // above), while the per-iteration try/catch blocks below wrap only the
  // EXECUTION of these modules -- preserving the legitimate runtime-error
  // fallbacks (a transient buildPrompt/gate throw must not kill the loop).
  const promptModule = requireModule(promptMod, "./build_prompt.ts");
  const gatesModule = requireModule(gatesMod, "./quality_gates.ts");

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

    // Mirror bash check_max_iterations (run.sh:9895-9901): `-ge` (>=), evaluated
    // AFTER the post-increment at run.sh:12889. The Bun increment above (post)
    // plus `>=` here matches bash's increment-then-`-ge` boundary exactly.
    // Previously this used strict `>`, so Bun ran exactly ONE extra iteration
    // past the cap relative to bash. With `>=` the message reports the count as
    // observed (no `-1`), since the trigger now fires at iterationCount == max.
    if (ctx.iterationCount >= ctx.maxIterations) {
      log(`[runner] max iterations reached (${ctx.iterationCount}/${ctx.maxIterations})`);
      await persistState(stateMod, ctx, "max_iterations_reached", 0);
      return 0;
    }

    // Build prompt (run.sh:10342). Wrap in try/catch -- a thrown buildPrompt
    // would otherwise abort the whole loop with no retry. (Reviewer A3 + DA
    // findings 2026-04-25.) This try/catch wraps only the RUNTIME execution
    // of an already-resolved builder; module ABSENCE was already made fatal at
    // resolution time (promptModule via requireModule). On a runtime throw we
    // fall back to a stub-prompt so the loop can advance and surface the
    // failure via provider invocation logs.
    let prompt: string;
    try {
      prompt = await promptModule.buildPrompt(ctx);
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

      // v7.5.10 (L5 BUG-9): persist the RARV phase so the dashboard's
      // 2s poll of `.loki/state/orchestrator.json` reflects the live phase
      // instead of whatever the bootstrap writer last set. We merge into
      // the existing record so other dashboard-critical fields
      // (complexity, agents, metrics, ...) survive the round-trip.
      try {
        const stateModForPhase = await import("./state.ts");
        stateModForPhase.updateCurrentPhase(phase, {
          lokiDirOverride: ctx.lokiDir,
          iteration: ctx.iterationCount,
        });
      } catch (err) {
        log(`[runner] updateCurrentPhase failed (non-fatal): ${(err as Error).message}`);
      }
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
        mainLoop: true,
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
    // Default to a non-blocking outcome so a gate runtime error never refuses
    // completion (bash logs and continues at run.sh:10845-10980).
    let gateOutcome: GateOutcomeShape = {
      passed: [],
      failed: [],
      blocked: false,
      escalated: false,
    };
    try {
      // Module absence was already made fatal at resolution time (gatesModule
      // via requireModule); only gate EXECUTION errors are best-effort -- the
      // bash equivalent at run.sh:10845-10980 logs and continues. Do not crash
      // the loop on a gate runtime error.
      gateOutcome = await gatesModule.runQualityGates(ctx);
    } catch (err) {
      log(`[runner] runQualityGates threw (non-fatal): ${(err as Error).message}`);
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

      // Honor the quality-gate verdict like bash, with bash-parity semantics
      // (run.sh:16868-16930). The ONLY gate that drives a completion refusal on
      // the bash route is code_review: a real code_review BLOCK appends
      // `code_review` to gate-failures.txt (and at GATE_PAUSE_LIMIT writes a
      // PAUSE) so the build cannot be called complete. Every other gate
      // (static_analysis, test_coverage, mock_integrity, ...) is advisory here:
      // it injects findings into the next iteration but never refuses
      // completion. So we refuse ONLY when:
      //   gateOutcome.blocked              -- hard-gates path is active
      //                                       (quality_gates.ts:2519/2529 force
      //                                       blocked=false on the soft-gates
      //                                       path, so this implies hardGates)
      //   AND failed.includes("code_review") -- a genuine code_review BLOCK,
      //                                       not a bare-project test_coverage
      //                                       fail that would over-block a clean
      //                                       run (LOKI_HARD_GATES defaults true
      //                                       + blocked = failed.length > 0).
      // A cleared code_review (CLEAR_LIMIT) lands in `passed`, not `failed`
      // (quality_gates.ts:2583-2587), so it correctly does NOT refuse.
      if (gateOutcome.blocked && gateOutcome.failed.includes("code_review")) {
        log(
          "[runner] code_review BLOCK -- refusing completion this iteration; continuing to next iteration with findings injected",
        );
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

// Parse a non-empty integer env var, falling back to a default. Mirrors the
// module-private envInt in build_prompt.ts:73-78 (which is not exported, and the
// file is out of scope for this change, so we inline an identical copy here).
function envIntLocal(key: string, dflt: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
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
    // Default 1000 to match bash MAX_ITERATIONS (run.sh:619,
    // `MAX_ITERATIONS=${LOKI_MAX_ITERATIONS:-1000}`) and build_prompt.ts:1160
    // (`envInt(env, "MAX_ITERATIONS", 1000)`). Was 100 -- an internal
    // inconsistency where the loop capped at 100 while the prompt advertised
    // 1000. We read the MAX_ITERATIONS env key to match build_prompt.ts; note
    // bash itself reads LOKI_MAX_ITERATIONS for the env override, but the Bun
    // route standardizes on the MAX_ITERATIONS key build_prompt already uses.
    maxIterations: opts.maxIterations ?? envIntLocal("MAX_ITERATIONS", 1000),
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
