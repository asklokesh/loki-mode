// loki-ts/src/runner/retry_class.ts -- v8 harness intelligence (3d).
//
// SMART RETRY: distinguish a TRANSIENT failure (worth retrying) from a
// NON-RETRYABLE one (retrying only burns tokens and wall-clock).
//
// The loop previously treated every non-zero exit identically: back off, retry,
// repeat until maxRetries. That is correct for a rate limit or a network blip
// and actively wasteful for an auth failure or an unknown-model error, where
// every retry is a guaranteed-identical failure. jcode's discipline is to stop
// early on a non-retryable error and SAVE the budget for real work.
//
// FAIL-SAFE DIRECTION, and this is the property that matters most here: an
// UNRECOGNIZED failure classifies as TRANSIENT, i.e. it keeps retrying, which
// is exactly today's behavior. Only a positively-identified permanent error
// stops early. So a bad guess costs a retry (cheap, the status quo); it can
// never abandon a build that would have succeeded. Never invert this default.

export type RetryClass = "transient" | "non_retryable";

// Positively-identified PERMANENT failures. Every pattern here must describe a
// condition that CANNOT change by retrying the identical request:
//   - credentials absent/invalid  -> same result every time
//   - a model/endpoint that does not exist -> same result every time
//   - a malformed request the engine itself built -> same result every time
//   - hard quota exhaustion (distinct from a rate limit, which IS transient)
//
// Deliberately conservative. Anything ambiguous is left out so it falls through
// to transient. A false "non_retryable" is the expensive mistake (it abandons
// recoverable work); a false "transient" merely costs one more retry.
//
// SCAN-TARGET HAZARD, and this is why the patterns below are narrower than they
// look like they "should" be. The text handed to classifyFailure is the agent's
// ENTIRE captured output (autonomous.ts:856-860 reads capturedOutputPath, the
// same file checkCompletionPromise parses at autonomous.ts:835) -- up to 64KB of
// the agent's own prose, test logs, and fixtures. It is NOT a provider error
// envelope. So any pattern that is also ordinary APPLICATION vocabulary matches
// an agent that merely BUILT that feature: a bare "401" appears in every auth
// test log, "permission denied" and "payment required" appear in ordinary UI
// copy. Those alternatives were removed because they fired on benign output and
// aborted healthy runs outright (the run terminates, it does not just skip a
// retry). What remains is provider-specific wire text that an application
// building the feature has no reason to emit.
//
// The rule for anything added here: it must be a string the PROVIDER emits when
// rejecting the request, not a string an app can legitimately print. When in
// doubt, leave it out -- omission costs one retry, inclusion can kill a build.
const NON_RETRYABLE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["auth", /\b(?:invalid[_ -]?api[_ -]?key|invalid[_ -]?x-api-key|authentication[_ -]?(?:failed|error))/i],
  ["unknown_model", /\b(?:model[_ -]?not[_ -]?found|unknown[_ -]?model|does not exist.{0,20}model)/i],
  ["bad_request", /\b(?:invalid[_ -]?request[_ -]?error|malformed[_ -]?request)/i],
  // "quota"/"billing" = the account is out of funds; unlike a rate limit this
  // does not clear on its own within a run.
  ["quota_exhausted", /\b(?:insufficient[_ -]?(?:quota|credit|funds)|billing[_ -]?(?:hard[_ -]?limit|issue)|credit[_ -]?balance[_ -]?(?:is[_ -]?)?too[_ -]?low|exceeded your current quota|check your plan and billing details)/i],
];

// Explicitly TRANSIENT markers that must win even if a permanent-looking word
// appears nearby. A rate limit is the classic case: it often carries a 4xx and
// quota-adjacent wording, but it absolutely does clear with time, and treating
// it as permanent would abandon healthy builds.
const TRANSIENT_OVERRIDE =
  /\b(?:rate[_ -]?limit|429\b|overloaded|please try again|temporarily unavailable|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|502\b|503\b|504\b|service unavailable)/i;

// Provider billing wording that is unambiguous even when sent with a 429: OpenAI
// and Gemini both return exhausted-funds errors under 429, so this must beat the
// override. Deliberately narrow: bare "insufficient quota" or RESOURCE_EXHAUSTED
// also appear in per-minute rate limits and stay transient.
const BILLING_STRONG = /\b(?:insufficient_quota|check your plan and billing details)/i;

export type RetryDecision = {
  readonly klass: RetryClass;
  /** Which rule matched, for logs/telemetry. "unrecognized" when none did. */
  readonly reason: string;
};

export function classifyFailure(text: string): RetryDecision {
  const t = text ?? "";
  if (t.trim() === "") return { klass: "transient", reason: "empty_output" };

  if (BILLING_STRONG.test(t)) return { klass: "non_retryable", reason: "quota_exhausted" };

  // Transient overrides are checked next so a rate limit is never mistaken for
  // a permanent quota failure.
  if (TRANSIENT_OVERRIDE.test(t)) return { klass: "transient", reason: "transient_marker" };

  for (const [reason, re] of NON_RETRYABLE_PATTERNS) {
    if (re.test(t)) return { klass: "non_retryable", reason };
  }

  // Unrecognized -> retry, preserving existing behavior exactly.
  return { klass: "transient", reason: "unrecognized" };
}

// Should the loop stop retrying now? DEFAULT ON; disable with
// LOKI_SMART_RETRY=0 to restore the retry-everything behavior verbatim.
export function shouldStopRetrying(
  decision: RetryDecision,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["LOKI_SMART_RETRY"] === "0") return false;
  return decision.klass === "non_retryable";
}

// P12-09: quota exhaustion is a bounded wait-then-rerun of the SAME provider call, not a fatal stop.
// Only the call is repeated (never the stage), so no stage side effect runs twice. Auth stays fatal.
const SDK_ERR = /\[sdk-loop error: [^\n]*?(?:(Failed to authenticate|API key is invalid|Not logged in)|(credit balance))/; // the SDK's real wording, matched only on its own error line
export const QUOTA_WAIT_BASE_MS = 30_000;
export const QUOTA_WAIT_MAX_MS = 300_000;

/** "auth" | "quota_exhausted" | other classifyFailure reason for a failed session; null on success. */
export function sessionKind(r: { exit: number | null; stderrTail?: string }): string | null {
  if (r.exit === 0) return null;
  const t = r.stderrTail ?? "", sdk = SDK_ERR.exec(t);
  return sdk ? (sdk[1] ? "auth" : "quota_exhausted") : classifyFailure(t).reason;
}

export type WaitClock = { now(): number; sleep?(ms: number, signal?: AbortSignal): Promise<void> };
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((res) => {
  const t = setTimeout(res, Math.max(0, ms));
  signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});

/**
 * Runs `run`; while it reports quota_exhausted, waits (exponential, via clock.sleep) and runs it again.
 * Bounded by `untilMs` (the run cap) and `signal`: when the next wait would pass the deadline it sleeps
 * to the deadline and returns the quota result, so the caller ends budget_stopped, never waits forever.
 */
export async function rerunOnQuota<R>(run: () => Promise<R>, kindOf: (r: R) => string | null, clock: WaitClock, signal: AbortSignal | undefined, untilMs: number, stop?: () => boolean): Promise<R> {
  const sleep = clock.sleep ?? realSleep;
  let r = await run();
  const start = clock.now(); let slept = 0; // a clock that never advances still spends the requested waits, so the loop is bounded by untilMs
  const nowMs = (): number => Math.max(clock.now(), start + slept);
  for (let i = 0; kindOf(r) === "quota_exhausted" && !signal?.aborted && !stop?.(); i++) {
    const left = untilMs - nowMs(), wait = Math.min(QUOTA_WAIT_BASE_MS * 2 ** i, QUOTA_WAIT_MAX_MS);
    if (wait >= left) { for (let k = 0; k < 5 && clock.now() < untilMs && !signal?.aborted; k++) await sleep(Math.max(0, untilMs - clock.now()), signal); return r; } // a timer that fires early is re-armed, so the caller sees the deadline as reached
    await sleep(wait, signal); slept += wait;
    if (signal?.aborted || stop?.()) return r; // stop: the dollar cap, checked between waits
    r = await run();
  }
  return r;
}
