// Shared runner types for the autonomous loop port.
// Bash source: autonomy/run.sh:10168-11108 (run_autonomous, 941 LOC).
//
// Other Phase 4 agents (C1-C3, B1) build the modules referenced here. This
// file owns the contract surface so the loop in autonomous.ts compiles even
// while those modules are still being written.

export type ProviderName = "claude" | "codex" | "gemini" | "cline" | "aider";

export type AutonomyMode = "perpetual" | "checkpoint" | "single-pass";

export type SessionTier = "planning" | "development" | "fast" | string;

// Inputs passed by the CLI into the runner.
export type RunnerOpts = {
  prdPath?: string;
  provider?: ProviderName;
  maxRetries?: number;
  maxIterations?: number;
  baseWaitSeconds?: number;
  maxWaitSeconds?: number;
  autonomyMode?: AutonomyMode;
  sessionModel?: SessionTier;
  budgetLimit?: number;
  completionPromise?: string;
  // Hermetic test injection points -- production code leaves these undefined.
  cwd?: string;
  loggerStream?: NodeJS.WritableStream;
  providerOverride?: ProviderInvoker;
  council?: CouncilHook;
  signals?: SignalSource;
  clock?: Clock;
  // Hermetic test override for the state-persistence adapter. When set,
  // autonomous.ts uses this object instead of dynamically importing
  // ./state.ts. Production code leaves this undefined.
  stateOverride?: RunnerStateMod;
  // Pre-iteration policy gate. Returning false maps to POLICY_BLOCKED state
  // and skips the iteration after a brief backoff. Phase 4+ port; the real
  // policy engine integration lands in Phase 5.
  policyCheck?: (ctx: RunnerContext) => Promise<boolean>;
};

// Live mutable context threaded through the loop. Mirrors the bash globals
// (RETRY_COUNT, ITERATION_COUNT, CURRENT_TIER, ...) without leaking them
// onto the actual process env.
export type RunnerContext = {
  cwd: string;
  lokiDir: string;
  prdPath: string | undefined;
  provider: ProviderName;
  maxRetries: number;
  maxIterations: number;
  baseWaitSeconds: number;
  maxWaitSeconds: number;
  autonomyMode: AutonomyMode;
  sessionModel: SessionTier;
  budgetLimit: number | undefined;
  completionPromise: string | undefined;
  iterationCount: number;
  retryCount: number;
  currentTier: SessionTier;
  log: (line: string) => void;
};

// Result of a single iteration (provider invocation + post-iteration checks).
export type IterationOutcome = {
  exitCode: number;
  durationSeconds: number;
  capturedOutputPath: string | undefined;
  // Set when post-iteration checks decided the loop should terminate.
  terminate?: TerminateReason;
};

export type TerminateReason =
  | { kind: "council_approved" }
  | { kind: "completion_promise_fulfilled" }
  | { kind: "max_iterations_reached" }
  | { kind: "stop_signal" }
  | { kind: "max_retries_exceeded" }
  | { kind: "failed"; exitCode: number };

// Provider invocation contract. C2 (provider modules) implements the
// real version; tests inject a FakeProvider.
export type ProviderInvocation = {
  provider: ProviderName;
  prompt: string;
  tier: SessionTier;
  cwd: string;
  // When set, provider implementations should tee into this file in addition
  // to writing the captured stream.
  iterationOutputPath: string;
};

export interface ProviderInvoker {
  invoke(call: ProviderInvocation): Promise<ProviderResult>;
}

export type ProviderResult = {
  exitCode: number;
  // Path to the per-iteration captured output (used for completion-promise
  // detection and rate-limit detection -- see run.sh BUG-RUN-001/002).
  capturedOutputPath: string;
  // Optional structured signal -- providers that detect a rate-limit cap
  // can pre-populate this so the loop skips re-parsing the log.
  rateLimitWaitSeconds?: number;
};

// Council voting hook. C3 implements the real council, tests stub it.
export interface CouncilHook {
  shouldStop(ctx: RunnerContext): Promise<boolean>;
  trackIteration?(logFile: string): Promise<void>;
}

// Signal source -- abstracts .loki/PAUSE, .loki/STOP, .loki/HUMAN_INPUT.md.
// In production the file-based source is used; tests can drive it directly.
export interface SignalSource {
  // 0 = no signal, 1 = pause/continue, 2 = stop.
  checkHumanIntervention(ctx: RunnerContext): Promise<0 | 1 | 2>;
  // Returns true if budget exceeded (caller will pause).
  isBudgetExceeded(ctx: RunnerContext): Promise<boolean>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

// State-persistence adapter contract. Mirrors the StateMod shape inside
// autonomous.ts (kept private there for clarity) but re-exported here so
// tests can inject a hermetic FakeStateMod via RunnerOpts.stateOverride
// instead of mocking dynamic imports.
//
// v7.4.4 (BUG-24) regression guard: the runner ALWAYS uses these adapter
// functions, never the bare saveState() in state.ts. Tests assert that
// saveCallCount > 0 and loadCallCount === 1 to prove the adapter path
// fired and the no-op fallback throw did NOT.
export interface RunnerStateMod {
  loadStateForRunner(ctx: RunnerContext): Promise<void>;
  saveStateForRunner(ctx: RunnerContext, status: string, exitCode: number): Promise<void>;
}

// Default Clock backed by Date.now / setTimeout. Tests override with a
// virtual clock so the retry-backoff path can be exercised in milliseconds.
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
};
