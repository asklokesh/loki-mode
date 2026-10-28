// E-07: SessionRunner. Runs one provider session in its own OS process group so the whole tree can be killed together at limitS (ENGINE.md 10). E-32: the child re-enters via cli.ts's `engine10 session` route.
import { createWatchdog, stallKillS, stallThresholdS } from "../runner/watchdog.ts";
import { SAFE_BUN_FLAGS } from "../runner/worker_proc.ts";
import { neutralizeEngineMarkers, sdkAuthCause } from "../runner/retry_class.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { diffShortstat, diffSignature, untrackedList } from "../util/anti_loop.ts"; export { diffShortstat, diffSignature, untrackedList }; // watchdog diff signature lives with the other tree-change detectors
import { cancelSessions, sessionsCancelled, trackSession } from "../util/run_pid.ts"; export { cancelSessions }; // one registry covers every provider child (docs/cost-controls.md)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { archivePriorCosts, writeProviderCost, stageMedianGapMs } from "../providers/provider_cost.ts";
import { modelRouteModel } from "../providers/model_routes.ts";
import { canonicalSessionPin, explicitSetupModel, PROVIDER_DEFAULT_MODEL } from "../util/claude_model.ts";
import { recordSessionCost, resultCostPath, tokensUnmeasured, UNMETERED } from "./cost.ts";
import { hooks } from "./hooks.ts";
import { readSessionId } from "../runner/session_resume.ts";
import { routerEnabled } from "../runner/router/flag.ts";
import { routedCostFields, routerMarkers, routerSessionPin } from "../runner/router/session_route.ts";
import type { ImplementExit, SessionMarkers, SessionResult, SessionRunner, SessionRunOptions } from "./types.ts";
import { clampBashTimeoutEnv, envWithPwd, pinBashShellEnv, killGroupWithGrace, reapLiveGroup } from "../runner/worker_proc.ts"; import { claudeTierToModel, engine10StaticPrefix } from "../runner/providers.ts"; import { idleGapMs, prefixParts, prefixSha } from "../util/cost_breakdown.ts";
import { beginGuard, finishGuard, isGuarded, watchBudget } from "../providers/provider_guard.ts"; // PARITY-ENFORCE: non-Claude guardrails
import { calculateCostFromRecords, partialUsagePath, readEfficiencyDir, recordPartialStreamCost } from "../runner/budget.ts"; import { childBudgetLimit, parseCapUsd } from "../e10ext/budget_cap.ts";
const STDERR_TAIL_BYTES = 64 * 1024; // E-61: kept for stage.failed diagnostics, tail only
export const HEARTBEAT_MS_DEFAULT = 30_000; // E-68 (augmentiq #52 P0): a provider call emits progress at least every 30s
/** CH-02: stages Opus marks for the advisor. Wall is never marked (Rule of Two). */
const ADVISOR_MARKED_STAGES: ReadonlySet<string> = new Set(["plan", "fix"]);
export type EmitFn = (type: string, stage: string | null, data: Record<string, unknown>) => void;
// provider, model and emit are bound per run on this factory config, since SessionRunOptions carries only per-call fields.
export interface SessionRunnerConfig {
  provider: string; // "claude" is special-cased; anything else is generic
  model?: string;
  emit?: EmitFn; // ENGINE.md section 5: heartbeat, session.started, session.ended
  heartbeatMs?: number; // default 30_000 (E-68: at least every 30s); tests use a smaller value
  childCommand?: [string, string[]]; // test-only: replaces the self-respawn
  lokiRoot?: string; remaining?: () => number | null; // lokiRoot: where efficiency records and result-cost files live (the repo's .loki); remaining: dollars left under the run cap, null or absent = no cap
  /** ROUTER-1 R1-09: advisor availability for this run (R1-06 probe). Only read under LOKI_ROUTER=1. */
  advisor?: { available: boolean; reason?: string };
}
/** Recorded when a claude run has no configured model: the provider CLI runs its own default, exactly like raw `claude -p` (L1). */
export { PROVIDER_DEFAULT_MODEL }; // label lives in util/claude_model.ts (a leaf the runner can import without a cycle)
/** The model a LOKI_SESSION_MODEL pin names for a claude run (undefined when unset). Throws on an unrecognized value (never the provider default). opus|sonnet|haiku are themselves, fable collapses to opus as the bash resolver does, and a tier
 *  name takes that tier's configured model. An explicit haiku pin is honored without LOKI_ALLOW_HAIKU: the user asked for it; bash would dispatch sonnet there. */
export function sessionPinModel(e: NodeJS.ProcessEnv = process.env): string | undefined {
  const pin = canonicalSessionPin(e["LOKI_SESSION_MODEL"]);
  if (!pin) return undefined;
  if (pin === "fable") return "opus";
  if (pin === "planning" || pin === "development" || pin === "fast") return explicitSetupModel(pin, e) ?? claudeTierToModel(pin);
  return pin;
}
/** The model a session really runs: the override, else the session pin, else a configured pin, else the provider's own default (no --model flag, L1 never below raw). */
export function resolveModel(provider: string): string {
  const e = process.env;
  if (e.LOKI_MODEL_OVERRIDE) return e.LOKI_MODEL_OVERRIDE;
  const routed = provider === "claude" ? modelRouteModel(e) : null; // OC-MODELS: a model route names the real model
  if (routed) return routed;
  const pinned = provider === "claude" ? sessionPinModel(e) : undefined; // LOKI_SESSION_MODEL: the whole-run pin, ahead of the per-tier vars
  if (pinned) return pinned;
  if (provider === "opencode") return (e.LOKI_OPENCODE_MODEL ?? "").trim() || "opencode default (unreported)"; // opencode takes -m from LOKI_OPENCODE_MODEL only
  if (provider !== "claude") return `${provider} (model not recorded)`;
  return e.LOKI_CLAUDE_MODEL_DEVELOPMENT || e.LOKI_MODEL_DEVELOPMENT || PROVIDER_DEFAULT_MODEL;
}
// ER-05 / g09-47: effort is part of the cached prefix key, so a resumed session keeps the effort it was created with unless the stage
// escalates. Per-message effort (mid-conversation output_config) is not exposed by the SDK; revisit when it is, instead of adding a new path.
const EFFORT_RANK = ["low", "medium", "high", "xhigh", "max"];
const sessionEffort = new Map<string, string>(); // provider session id -> effort it ran with, filled when a session closes
/** Effort a call really runs at. A resumed session never drops below its recorded effort; a user LOKI_E10_EFFORT is explicit and always wins. */
export function sessionEffortFor(opts: SessionRunOptions): { effort: string | undefined; escalated?: { from: string; to: string } } {
  const resolved = (hooks.effort?.resolve(opts.stage, opts.effort) ?? opts.effort);
  const prior = opts.resumeSessionId ? sessionEffort.get(opts.resumeSessionId) : undefined;
  if (!prior || process.env["LOKI_E10_EFFORT"]) return { effort: resolved };
  const pr = EFFORT_RANK.indexOf(prior), rr = resolved ? EFFORT_RANK.indexOf(resolved) : -1;
  if (resolved && rr > pr && pr >= 0) return { effort: resolved, escalated: { from: prior, to: resolved } }; // escalation is allowed; it resets the cache
  if (resolved && rr < 0) return { effort: resolved }; // unknown level: pass through untouched
  return { effort: prior };
}
export function childEnv(opts: SessionRunOptions, cfg: SessionRunnerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["LOKI_E10_SEAL_EXISTING_PATCH"]; // CW-12 B2: defense in depth, no session env ever carries the external diff path
  env["LOKI_ITERATION"] = opts.iterationId;
  env["LOKI_E10_STAGE"] = opts.stage;
  env["LOKI_E10_BRIEF"] = opts.brief;
  const gap = cfg.lokiRoot ? stageMedianGapMs(cfg.lokiRoot, opts.stage) : null; // #244: the persisted median call gap of this stage picks the cache TTL in engine10CacheTtlEnv
  if (gap !== null) env["LOKI_E10_CACHE_GAP_MS"] = String(gap); else delete env["LOKI_E10_CACHE_GAP_MS"];
  env["LOKI_E10_TIER"] = opts.tier; if (cfg.provider === "claude" && opts.stopChecks?.checks.length) env["LOKI_E10_STOP_CHECKS"] = JSON.stringify(opts.stopChecks); else delete env["LOKI_E10_STOP_CHECKS"]; // in-session fix rounds: only the per-call option sets it
  env["LOKI_E10_PROVIDER"] = cfg.provider;
  if (opts.disallowedTools) env["LOKI_E10_DISALLOWED_TOOLS"] = opts.disallowedTools; else delete env["LOKI_E10_DISALLOWED_TOOLS"];
  if (opts.resumeSessionId) env["LOKI_E10_RESUME_SESSION"] = opts.resumeSessionId; else delete env["LOKI_E10_RESUME_SESSION"]; // MW-2: only the per-call option sets it
  // Only ever ADD variables here; never blank an inherited var for a non-claude provider (LOKI_HOST_GUARD gates resolveProvider's fail-closed throw, providers.ts:63).
  if (cfg.provider === "claude") {
    // LOKI_E10_INVOKER=cli selects the claude CLI invoker (falls back to "legacy" when LOKI_SDK_LOOP is unset).
    if (process.env["LOKI_E10_INVOKER"] === "cli") delete env["LOKI_SDK_LOOP"];
    else env["LOKI_SDK_LOOP"] = "1";
    env["LOKI_HOST_GUARD"] = "1";
    env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] = "1"; // an engine stage never needs background work; a Bash at its timeout stops instead of auto-backgrounding and pinning a finished session
    if (process.env["LOKI_E10_STAGE"]) delete env["LOKI_E10_MAX_TURNS"]; clampBashTimeoutEnv(env, opts.limitS); pinBashShellEnv(env); if (opts.maxOutputTokens) env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = String(opts.maxOutputTokens); // a nested run inside a stage session inherits the derived cap, never an explicit user value; Wall author output bound, other stages keep the inherited value
    if (env["LOKI_E10_PREFIX"] === undefined) env["LOKI_E10_PREFIX"] = "lean"; // TEN-COST-13: lean cache-stable prefix by default; an explicit user value (including off) wins
    const forced = process.env["LOKI_MODEL_OVERRIDE"] || sessionPinModel(process.env); // the override, else the session pin (after the override, ahead of the per-tier vars; throws on an unrecognized pin)
    if (forced) for (const t of ["PLANNING", "DEVELOPMENT", "FAST"]) env[`LOKI_CLAUDE_MODEL_${t}`] = forced;
  }
  if (cfg.provider === "claude" && (!opts.model || opts.model === PROVIDER_DEFAULT_MODEL) && resolveModel("claude") === PROVIDER_DEFAULT_MODEL) env["LOKI_E10_MODEL_DEFAULT"] = "1"; // providers.ts then omits --model
  const { effort, escalated } = sessionEffortFor(opts); // ER-01: a user LOKI_E10_EFFORT (already in env) wins over opts and the policy; ER-05: a resumed session keeps its effort
  if (escalated) cfg.emit?.("effort_escalation_cache_reset", opts.stage, { session_id: opts.iterationId, resume_session_id: opts.resumeSessionId, ...escalated });
  const lim = childBudgetLimit(cfg.remaining?.() ?? null); if (lim !== null) env["LOKI_BUDGET_LIMIT"] = lim; if (effort) env["LOKI_E10_EFFORT"] = effort; // lim: the SDK maxBudgetUsd (claude_flags.ts) then caps this one call at what is left
  if (routerEnabled() && !ADVISOR_MARKED_STAGES.has(opts.stage)) env["LOKI_ADVISOR_SCOPE"] = "off"; else delete env["LOKI_ADVISOR_SCOPE"]; // CH-02: only with the router on, so router-off envs stay byte-identical
  const pin = routerSessionPin(env, cfg.provider, cfg.advisor, opts); // ROUTER-1 (runner/router/session_route.ts): identical to opts.model with the router off or a user override set
  if (pin && pin !== PROVIDER_DEFAULT_MODEL) { // the label is a record, never a --model value
    const t = String(opts.tier).toUpperCase(); // E-45: pin wins over any inherited tier model
    env[`LOKI_CLAUDE_MODEL_${t}`] = pin;
    env[`LOKI_MODEL_${t}`] = pin;
  }
  return env;
}
function parseMarkers(stdout: string): SessionMarkers {
  // Line-anchored, so prose that merely names a marker (or an echoed brief) never counts.
  const doneMatch = /^\W*LOKI_ALREADY_DONE:\s*(.+)$/m.exec(stdout);
  const conflictMatch = /^\W*LOKI_SPEC_CONFLICT:\s*(.+)$/m.exec(stdout);
  return routerMarkers(stdout, { done: !doneMatch && !conflictMatch, alreadyDone: doneMatch ? doneMatch[1]!.trim() : null, specConflict: conflictMatch ? conflictMatch[1]!.trim() : null });
}
function exitKind(exit: number | null, killed: boolean, markers: SessionMarkers): ImplementExit | "error" {
  if (killed) return "killed";
  if (markers.specConflict) return "spec_conflict";
  if (markers.alreadyDone) return "already_done";
  if (exit === 0) return "done";
  return "error";
}
// E-68 (augmentiq #52 P0): every exit code a provider call can produce, named. 125 and 143 are explicitly in scope (a container runtime or the shell itself can emit either). A code outside this table
// still names the number: classifyExitCause never falls back to an un-named string.
const EXIT_CAUSES: Readonly<Record<number, string>> = Object.fromEntries(([
  [0, "success"], [1, "general error"], [2, "misuse of shell command"], [124, "timeout"], [125, "timeout or container failure"],
  [126, "command not executable"], [127, "command not found"], [130, "SIGINT"], [137, "SIGKILL"], [143, "SIGTERM"], [98, "turn cap"],
] as const).map(([code, what]) => [code, `exit ${code} (${what})`]));
// E-68: a session child traps SIGTERM and exits 143, so classify from what the ENGINE knows (it sent the kill), never the child's code: killed always wins. killCause names which kill fired; it defaults to "limit".
export function classifyExitCause(exit: number | null, killed: boolean, killCause?: "limit" | "aborted" | "stalled"): string {
  if (killed) return killCause ?? "limit";
  if (exit === null) return "external kill";
  return EXIT_CAUSES[exit] ?? `exit ${exit} (unrecognized code)`;
}
const lastStageEnd = new WeakMap<SessionRunnerConfig, Map<string, number>>(); // per run: runner config -> stage -> last session end (epoch ms)
/** Efficiency record plus cost event for one session; a run in another cwd (wall's temp dir) has its result-cost file copied into lokiRoot first, so seal can price it after that dir is gone. */
function recordCost(cfg: SessionRunnerConfig, opts: SessionRunOptions, status: string, durationS: number, outText = ""): void {
  if (!cfg.lokiRoot) return;
  const ownRoot = join(opts.cwd ?? process.cwd(), ".loki");
  const own = resultCostPath(ownRoot, opts.iterationId), dest = resultCostPath(cfg.lokiRoot, opts.iterationId);
  if (own !== dest && existsSync(own)) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(own, dest); }
  const ownPartial = partialUsagePath(ownRoot, opts.iterationId), destPartial = partialUsagePath(cfg.lokiRoot, opts.iterationId); // E-98e: killed session's partial-usage snapshot, same copy
  if (ownPartial !== destPartial && existsSync(ownPartial)) { mkdirSync(dirname(destPartial), { recursive: true }); copyFileSync(ownPartial, destPartial); }
  const model = opts.model ?? cfg.model ?? resolveModel(cfg.provider); // opts.model (E-45/E-64 pin) wins, matching session.started's precedence
  if (process.env["LOKI_E10_INVOKER"] === "cli" && cfg.provider === "claude" && status !== "killed" && !existsSync(dest)) { // D48: the CLI invoker (stub) reports no cost; record 0 with a marker, never null
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify({ total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, model, source: UNMETERED }));
  }
  const pcost = existsSync(dest) ? null : writeProviderCost(dest, cfg.provider, model, opts.brief, outText); // PARITY-COST: codex/cline/aider priced from output usage or sizes, estimated=true; feeds the same cap path
  const effort = sessionEffortFor(opts).effort;
  // #306: hash the whole cached prefix (system text, tool list incl. per-session denials, thinking, effort, brief), from the function providers.ts builds it with.
  const penv = { ...process.env, ...(cfg.provider === "claude" && process.env["LOKI_E10_PREFIX"] === undefined ? { LOKI_E10_PREFIX: "lean" } : {}) }, sp = engine10StaticPrefix(penv);
  const pparts = opts.brief ? prefixParts({ system: `${sp.systemPrompt ?? "preset"}|dyn=${sp.excludeDynamic}`, tools: [...sp.tools, ...(opts.disallowedTools ? [`-${opts.disallowedTools}`] : [])], thinking: process.env["MAX_THINKING_TOKENS"], effort, brief: opts.brief }) : undefined;
  const endedAt = Date.now(), ends = lastStageEnd.get(cfg) ?? new Map<string, number>(), prev = ends.get(opts.stage); // #244: gap to this run's previous call of the stage
  ends.set(opts.stage, endedAt); lastStageEnd.set(cfg, ends);
  const info = { status, durationMs: Math.round(durationS * 1000), model, stage: opts.stage, ...(prev !== undefined ? { gapMs: idleGapMs(endedAt, Math.round(durationS * 1000), prev) } : {}) };
  // No `result` ever arrived: price streamed usage instead of leaving cost_usd null.
  const c = status === "killed" && !existsSync(dest) ? recordPartialStreamCost(cfg.lokiRoot, opts.iterationId, info) : recordSessionCost(cfg.lokiRoot, opts.iterationId, info);
  const ambiguous = c.records?.resume === "ambiguous"; // FIX-RESUME: this resumed session's total may include its predecessor, so its figures are not emitted (NOT RECORDED), never summed on trust
  const unmeasured = tokensUnmeasured(c); // the predicate writeEfficiencyRecord shares: a session without usage emits no token keys, so the control plane never reads a missing session as 0
  cfg.emit?.("cost", opts.stage, {
    session_id: opts.iterationId, model, usd: c.usd, duration_ms: Math.round(durationS * 1000), ...(ambiguous ? { resume: "ambiguous" } : {}), ...(unmeasured ? {} : { input_tokens: c.input_tokens, output_tokens: c.output_tokens,
    cache_read_tokens: c.cache_read_tokens, cache_creation_tokens: c.cache_creation_tokens }), ...(pparts ? { prefix_sha: prefixSha(pparts), prefix_parts: pparts } : {}), source: c.unmetered ? UNMETERED : c.source || "not measured", ...(pcost?.estimated ? { estimated: true, cost_basis: pcost.cost_basis } : {}), ...(pcost?.unmeasured_reason ? { unmeasured_reason: pcost.unmeasured_reason, cost_basis: pcost.cost_basis } : {}), ...(effort ? { effort } : {}), ...routedCostFields(dest),
  });
}
export function createSessionRunner(cfg: SessionRunnerConfig): SessionRunner {
  return {
    run(opts: SessionRunOptions): Promise<SessionResult & { stderrTail: string }> {
      if (cfg.provider === "opencode" && opts.model) opts = { ...opts, model: undefined }; // a stage pin (Wall's claude tier) cannot reach opencode; record the model it really runs
      const start = Date.now();
      // A signal aborted before run() never fires the listener below, so it never spawns.
      if (opts.signal.aborted || sessionsCancelled()) return Promise.resolve({ exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 0, killed: true, stderrTail: "" });
      const env = childEnv(opts, cfg);
      archivePriorCosts(cfg.lokiRoot, opts.cwd, opts.iterationId);
      const [cmd, args] = cfg.childCommand ?? [
        process.execPath,
        // Through the cli `engine10 session` route: import.meta.path is dist/loki.js in a bundle, session.ts from source.
        [...SAFE_BUN_FLAGS, import.meta.path.endsWith("session.ts") ? `${import.meta.dir}/../cli.ts` : import.meta.path, "engine10", "session"],
      ];
      const sessionId = opts.iterationId;
      // stderr is piped and kept (tail only, E-61) for stage.failed diagnostics; always drained via the "data" listener below so a full pipe can never stall the child.
      const guardSnap = isGuarded(cfg.provider) && cfg.lokiRoot ? beginGuard(opts.cwd ?? process.cwd(), cfg.lokiRoot) : null; // PARITY-ENFORCE
      const child: ChildProcess = spawn(cmd, args, { cwd: opts.cwd, env: envWithPwd(env, opts.cwd), detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const pgid = child.pid;
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      // ponytail: re-concats on every chunk, fine for a CLI session's stderr volume; switch to a ring buffer if that stops holding.
      let stderrTail = Buffer.alloc(0), errBytes = 0;
      child.stderr?.on("data", (d: Buffer) => {
        errBytes += d.length; stderrTail = Buffer.concat([stderrTail, d]);
        if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES);
      });
      let killed = false;
      // Which kill fired, from the engine's own point of view -- never guessed from the child's exit code. First one wins: the limit timer and an external abort cannot both be the cause of the same kill.
      let killCause: "limit" | "aborted" | "stalled" | null = null;
      const kill = (cause: "limit" | "aborted" | "stalled") => {
        if (killed) return;
        killed = true;
        killCause = cause;
        killGroupWithGrace(pgid);
      };
      cfg.emit?.("session.started", opts.stage, { session_id: sessionId, provider: cfg.provider, model: opts.model ?? cfg.model ?? null, pgid: pgid ?? null });
      const onAbort = () => kill("aborted");
      const limitTimer = setTimeout(() => kill("limit"), opts.limitS * 1000);
      const capUsd = parseCapUsd(process.env["LOKI_E10_MAX_COST_USD"]), effDir = cfg.lokiRoot ? join(cfg.lokiRoot, "metrics", "efficiency") : null, effBase = effDir !== null && capUsd !== null ? calculateCostFromRecords(readEfficiencyDir(effDir)) : 0; const stopBudgetWatch = isGuarded(cfg.provider) && capUsd !== null ? watchBudget(() => (cfg.remaining?.() ?? 1) <= 0 || (effDir !== null && calculateCostFromRecords(readEfficiencyDir(effDir)) - effBase >= capUsd), () => { cfg.emit?.("guard.budget_stop", opts.stage, { provider: cfg.provider }); kill("limit"); }) : () => {}; // PARITY-ENFORCE: live kill on the run cap (LOKI_E10_MAX_COST_USD), not the unset BUDGET_LIMIT
      const watchdog = createWatchdog(Date.now), stallKill = stallKillS(); // FC-17: 0 (default) never kills
      const heartbeatTimer = setInterval(() => {
        const un = untrackedList(opts.cwd), diff = diffShortstat(opts.cwd, un), w = watchdog.tick(stdout.length + errBytes, diffSignature(opts.cwd, diff, un)); // one ls-files per tick, shared (TEN-SPEED-21)
        const live = readSessionId(opts.cwd ?? process.cwd(), opts.iterationId); // mirrors the provider session id into the append-only log so a SIGKILL cannot lose it; key absent until known
        cfg.emit?.("heartbeat", opts.stage, { waiting_on: opts.stage, elapsed_s: (Date.now() - start) / 1000, diff, progress: w.cls, ...(live ? { provider_session_id: live } : {}) });
        if (w.stalledNow) cfg.emit?.("session.stalled", opts.stage, { session_id: sessionId, idle_s: w.idleS, threshold_s: stallThresholdS() }); if (stallKill > 0 && w.idleS >= stallKill) kill("stalled");
      }, cfg.heartbeatMs ?? HEARTBEAT_MS_DEFAULT);
      opts.signal.addEventListener("abort", onAbort, { once: true });
      const untrack = trackSession(() => kill("aborted"));
      return new Promise<SessionResult & { stderrTail: string }>((resolve) => {
        // A background grandchild holding the stdout pipe delays "close" indefinitely: on "exit" reap the session's own group.
        child.on("exit", () => reapLiveGroup(pgid, () => cfg.emit?.("session.group_reaped", opts.stage, { session_id: sessionId, pgid })));
        // "close", not "exit": stdout may still be draining, and the marker is usually last.
        child.on("close", (code) => {
          clearTimeout(limitTimer);
          clearInterval(heartbeatTimer);
          stopBudgetWatch();
          const guard = finishGuard(guardSnap); // PARITY-ENFORCE: revert destructive changes, fail the iteration
          if (!guard.ok) cfg.emit?.("guard.violation", opts.stage, { provider: cfg.provider, violations: guard.violations, reverted: guard.reverted });
          opts.signal.removeEventListener("abort", onAbort);
          // The CLI invoker writes only to its iteration log, never stdout.
          const log = join(opts.cwd ?? process.cwd(), ".loki", `iteration-${sessionId}.log`);
          const logText = existsSync(log) ? readFileSync(log, "utf8") : ""; const markers = parseMarkers(stdout + logText);
          const durationS = (Date.now() - start) / 1000, authCause = code === 0 ? null : sdkAuthCause(logText); // FC-AUTH-CAUSE-ONLY-IN-IMPL-LOG: the provider text rides the event so the Reason line can name it
          cfg.emit?.("session.ended", opts.stage, {
            session_id: sessionId, exit: exitKind(guard.ok ? code : 1, killed, markers), cause: classifyExitCause(code, killed, killCause ?? undefined), ...(authCause !== null ? { provider_error: authCause } : {}), duration_s: durationS, ...(killCause === "stalled" ? { reason: "stalled" } : {}),
          });
          const psid = readSessionId(opts.cwd ?? process.cwd(), opts.iterationId), ran = sessionEffortFor(opts).effort; if (psid && ran) sessionEffort.set(psid, ran); // ER-05: what the next resume of this session must keep
          recordCost(cfg, opts, killed ? "killed" : code === 0 ? "completed" : "failed", durationS, stdout + logText);
          untrack();
          resolve({ exit: guard.ok ? code : 1, markers, durationS, killed, summary: (stdout + logText).trim().slice(-4096), stderrTail: (guard.ok ? "" : `guard violation: ${guard.violations.map((v) => v.detail).join("; ")}\n`) + stderrTail.toString("utf8") + (logText.match(/^\[sdk-loop error: .*\]$/gm) ?? []).join("\n") }); // only provider-written text is classified: child stderr and the SDK error line, never the agent transcript (A-113). The child echoes the provider's in-memory stderr (A-113b); only the claude CLI invoker returns one, since codex/cline/aider may print session activity on stderr (unmeasured)
        });
      });
    },
  };
}
// Child role: the real provider call, inside the own-process-group child.
export async function sessionChildMain(): Promise<never> {
  const { resolveProvider } = await import("../runner/providers.ts");
  const provider = (process.env["LOKI_E10_PROVIDER"] ?? "claude") as Parameters<typeof resolveProvider>[0];
  const invoker = await resolveProvider(provider);
  const result = await invoker.invoke({
    provider,
    prompt: process.env["LOKI_E10_BRIEF"] ?? "",
    tier: process.env["LOKI_E10_TIER"] ?? "development",
    cwd: process.cwd(),
    iterationOutputPath: `.loki/iteration-${process.env["LOKI_ITERATION"] ?? "0"}.log`,
    mainLoop: true,
  });
  if (result.stderr) writeSync(2, neutralizeEngineMarkers(result.stderr)); process.exit(result.exitCode); // the CLI invoker's own in-memory stderr, never a file the agent can write
}
// cli.ts routes `engine10 session` here (section 11); it exits the process itself.
export const main = sessionChildMain;
