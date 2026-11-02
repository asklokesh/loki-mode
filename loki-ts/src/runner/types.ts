// Shared provider types: the invocation contract providers.ts and provider_opencode.ts implement,
// and the provider and tier names start.ts and engine10 read.

export type ProviderName = "claude" | "codex" | "cline" | "aider" | "opencode";

export type SessionTier = "planning" | "development" | "fast" | string;

// Provider invocation contract, implemented by providers.ts and provider_opencode.ts.
export type ProviderInvocation = {
  provider: ProviderName;
  prompt: string;
  tier: SessionTier;
  cwd: string;
  // When set, provider implementations should tee into this file in addition
  // to writing the captured stream.
  iterationOutputPath: string;
  // v7.34.0: true ONLY for the main RARV-loop call. The session stamp
  // (--session-id, opt-in via LOKI_SESSION_STAMP) attaches only here, never on
  // subcalls (e.g. the override-council judge), mirroring the bash route which
  // confines --session-id to the main-loop argv. Defaults to false (no stamp).
  mainLoop?: boolean;
  // Session-continuity Phase 2 (GitHub #165): true on the FIRST main-loop call
  // of a RESTARTED run (the prior run was interrupted, non-terminal). With
  // LOKI_RESUME_SESSION=1 this is the single call that emits `claude --resume
  // <stored-uuid>` instead of the per-iteration stamp; the caller must clear it
  // after that one call so later iterations revert to normal (no resume chain).
  // Defaults to false. Mirrors the bash _LOKI_RESTARTED_RUN + _LOKI_RESUME_CONSUMED
  // snapshot/latch.
  // No caller sets this field today; providers.ts honors it. See #165.
  resumeFirstCall?: boolean;
  // Text-only call: the model gets no tools and cannot edit anything, and no
  // project settings load. Mirrors the bash text-only roles in
  // autonomy/lib/claude-flags.sh loki_lean_child_flags (--tools=). Honoured by
  // the claude provider; other providers are cwd-bound only (the caller passes
  // an empty directory), which the walled check author reports as such.
  textOnly?: boolean;
};

export interface ProviderInvoker {
  invoke(call: ProviderInvocation): Promise<ProviderResult>;
}

export type ProviderResult = {
  exitCode: number;
  // Path to the per-iteration captured output (used for completion-promise
  // detection and rate-limit detection -- see run.sh BUG-RUN-001/002).
  capturedOutputPath: string;
  // The provider's own stderr, in memory (never a file the agent can write); only the claude CLI invoker sets it (A-113b).
  stderr?: string;
  // Optional structured signal -- providers that detect a rate-limit cap
  // can pre-populate this so the loop skips re-parsing the log.
  rateLimitWaitSeconds?: number;
};
