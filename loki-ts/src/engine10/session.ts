// E-07: SessionRunner. Runs one provider session in its own OS process group so the whole tree can be
// killed together at limitS (ENGINE.md 10). E-32: the child re-enters via cli.ts's `engine10 session` route.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordSessionCost, resultCostPath, UNMETERED } from "./cost.ts";
import { partialUsagePath, recordPartialStreamCost } from "../runner/budget.ts";
import type { ImplementExit, SessionMarkers, SessionResult, SessionRunner, SessionRunOptions } from "./types.ts";
const KILL_GRACE_MS = 2000; // ENGINE.md section 10: SIGKILL 2s after SIGTERM
const STDERR_TAIL_BYTES = 64 * 1024; // E-61: kept for stage.failed diagnostics, tail only
export const HEARTBEAT_MS_DEFAULT = 30_000; // E-68 (augmentiq #52 P0): a provider call emits progress at least every 30s
export type EmitFn = (type: string, stage: string | null, data: Record<string, unknown>) => void;
// provider, model and emit are bound per run on this factory config, since SessionRunOptions carries only per-call fields.
export interface SessionRunnerConfig {
  provider: string; // "claude" is special-cased; anything else is generic
  model?: string;
  emit?: EmitFn; // ENGINE.md section 5: heartbeat, session.started, session.ended
  heartbeatMs?: number; // default 30_000 (E-68: at least every 30s); tests use a smaller value
  childCommand?: [string, string[]]; // test-only: replaces the self-respawn
  lokiRoot?: string; // where efficiency records and result-cost files live (the repo's .loki)
}
/** Recorded when a claude run has no configured model: the provider CLI runs its own default, exactly like raw `claude -p` (L1). */
export const PROVIDER_DEFAULT_MODEL = "claude (provider default)";
/** The model a session really runs: the override, else a configured pin, else the provider's own default (no --model flag, L1 never below raw). */
export function resolveModel(provider: string): string {
  const e = process.env;
  if (e.LOKI_MODEL_OVERRIDE) return e.LOKI_MODEL_OVERRIDE;
  if (provider !== "claude") return `${provider} (model not recorded)`;
  return e.LOKI_CLAUDE_MODEL_DEVELOPMENT || e.LOKI_MODEL_DEVELOPMENT || PROVIDER_DEFAULT_MODEL;
}
function childEnv(opts: SessionRunOptions, cfg: SessionRunnerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env["LOKI_ITERATION"] = opts.iterationId;
  env["LOKI_E10_STAGE"] = opts.stage;
  env["LOKI_E10_BRIEF"] = opts.brief;
  env["LOKI_E10_TIER"] = opts.tier;
  env["LOKI_E10_PROVIDER"] = cfg.provider;
  if (opts.resumeSessionId) env["LOKI_E10_RESUME_SESSION"] = opts.resumeSessionId; else delete env["LOKI_E10_RESUME_SESSION"]; // MW-2: only the per-call option sets it
  // Only ever ADD variables here; never blank an inherited var for a non-claude provider (LOKI_HOST_GUARD gates resolveProvider's fail-closed throw, providers.ts:63).
  if (cfg.provider === "claude") {
    // LOKI_E10_INVOKER=cli selects the claude CLI invoker (falls back to "legacy" when LOKI_SDK_LOOP is unset).
    if (process.env["LOKI_E10_INVOKER"] === "cli") delete env["LOKI_SDK_LOOP"];
    else env["LOKI_SDK_LOOP"] = "1";
    env["LOKI_HOST_GUARD"] = "1";
    const override = process.env["LOKI_MODEL_OVERRIDE"];
    if (override) {
      env["LOKI_CLAUDE_MODEL_PLANNING"] = override;
      env["LOKI_CLAUDE_MODEL_DEVELOPMENT"] = override;
      env["LOKI_CLAUDE_MODEL_FAST"] = override;
    }
  }
  if (cfg.provider === "claude" && (!opts.model || opts.model === PROVIDER_DEFAULT_MODEL) && resolveModel("claude") === PROVIDER_DEFAULT_MODEL) env["LOKI_E10_MODEL_DEFAULT"] = "1"; // providers.ts then omits --model
  if (opts.effort) env["LOKI_E10_EFFORT"] = opts.effort;
  if (opts.model && opts.model !== PROVIDER_DEFAULT_MODEL) { // the label is a record, never a --model value
    const t = String(opts.tier).toUpperCase(); // E-45: pin wins over any inherited tier model
    env[`LOKI_CLAUDE_MODEL_${t}`] = opts.model;
    env[`LOKI_MODEL_${t}`] = opts.model;
  }
  return env;
}
function diffShortstat(cwd: string | undefined): { files: number; insertions: number; deletions: number } {
  try {
    const out = execFileSync("git", ["diff", "--shortstat"], { cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const files = /(\d+) files? changed/.exec(out);
    const ins = /(\d+) insertions?\(\+\)/.exec(out);
    const del = /(\d+) deletions?\(-\)/.exec(out);
    return { files: files ? Number(files[1]) : 0, insertions: ins ? Number(ins[1]) : 0, deletions: del ? Number(del[1]) : 0 };
  } catch { return { files: 0, insertions: 0, deletions: 0 }; }
}
function parseMarkers(stdout: string): SessionMarkers {
  // Line-anchored, so prose that merely names a marker (or an echoed brief) never counts.
  const doneMatch = /^\W*LOKI_ALREADY_DONE:\s*(.+)$/m.exec(stdout);
  const conflictMatch = /^\W*LOKI_SPEC_CONFLICT:\s*(.+)$/m.exec(stdout);
  return { done: !doneMatch && !conflictMatch, alreadyDone: doneMatch ? doneMatch[1]!.trim() : null, specConflict: conflictMatch ? conflictMatch[1]!.trim() : null };
}
function exitKind(exit: number | null, killed: boolean, markers: SessionMarkers): ImplementExit | "error" {
  if (killed) return "killed";
  if (markers.specConflict) return "spec_conflict";
  if (markers.alreadyDone) return "already_done";
  if (exit === 0) return "done";
  return "error";
}
// E-68 (augmentiq #52 P0): every exit code a provider call can produce, named. 125 and 143 are
// explicitly in scope (a container runtime or the shell itself can emit either). A code outside
// this table still names the number: classifyExitCause never falls back to an un-named string.
const EXIT_CAUSES: Readonly<Record<number, string>> = {
  0: "exit 0 (success)",
  1: "exit 1 (general error)",
  2: "exit 2 (misuse of shell command)",
  124: "exit 124 (timeout)",
  125: "exit 125 (timeout or container failure)",
  126: "exit 126 (command not executable)",
  127: "exit 127 (command not found)",
  130: "exit 130 (SIGINT)",
  137: "exit 137 (SIGKILL)",
  143: "exit 143 (SIGTERM)",
};
// E-68: a session child traps SIGTERM and exits 143, so classify from what the ENGINE knows (it sent the kill), never the child's code:
// killed always wins. killCause names which kill fired; it defaults to "limit".
export function classifyExitCause(exit: number | null, killed: boolean, killCause?: "limit" | "aborted"): string {
  if (killed) return killCause ?? "limit";
  if (exit === null) return "external kill";
  return EXIT_CAUSES[exit] ?? `exit ${exit} (unrecognized code)`;
}
// SIGTERM now, SIGKILL after the grace, against the whole group; shared by the limit timeout and an external abort.
function killGroupWithGrace(pgid: number | undefined): void {
  if (!pgid) return;
  const send = (signal: NodeJS.Signals) => { try { process.kill(-pgid, signal); } catch { /* already exited */ } };
  send("SIGTERM");
  setTimeout(() => send("SIGKILL"), KILL_GRACE_MS);
}
/** Efficiency record plus cost event for one session; a run in another cwd (wall's temp dir) has its result-cost file copied into lokiRoot first, so seal can price it after that dir is gone. */
function recordCost(cfg: SessionRunnerConfig, opts: SessionRunOptions, status: string, durationS: number): void {
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
  const info = { status, durationMs: Math.round(durationS * 1000), model };
  // No `result` ever arrived: price streamed usage instead of leaving cost_usd null.
  const c = status === "killed" && !existsSync(dest) ? recordPartialStreamCost(cfg.lokiRoot, opts.iterationId, info) : recordSessionCost(cfg.lokiRoot, opts.iterationId, info);
  cfg.emit?.("cost", opts.stage, {
    session_id: opts.iterationId, model, usd: c.usd, input_tokens: c.input_tokens, output_tokens: c.output_tokens,
    cache_read_tokens: c.cache_read_tokens, cache_creation_tokens: c.cache_creation_tokens, source: c.unmetered ? UNMETERED : c.source || "not measured",
  });
}
export function createSessionRunner(cfg: SessionRunnerConfig): SessionRunner {
  return {
    run(opts: SessionRunOptions): Promise<SessionResult & { stderrTail: string }> {
      const start = Date.now();
      // A signal aborted before run() never fires the listener below, so it never spawns.
      if (opts.signal.aborted) return Promise.resolve({ exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 0, killed: true, stderrTail: "" });
      const env = childEnv(opts, cfg);
      const [cmd, args] = cfg.childCommand ?? [
        process.execPath,
        // Through the cli `engine10 session` route: import.meta.path is dist/loki.js in a bundle, session.ts from source.
        [import.meta.path.endsWith("session.ts") ? `${import.meta.dir}/../cli.ts` : import.meta.path, "engine10", "session"],
      ];
      const sessionId = opts.iterationId;
      // stderr is piped and kept (tail only, E-61) for stage.failed diagnostics; always drained
      // via the "data" listener below so a full pipe can never stall the child.
      const child: ChildProcess = spawn(cmd, args, { cwd: opts.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const pgid = child.pid;
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      // ponytail: re-concats on every chunk, fine for a CLI session's stderr volume; switch to a ring buffer if that stops holding.
      let stderrTail = Buffer.alloc(0);
      child.stderr?.on("data", (d: Buffer) => {
        stderrTail = Buffer.concat([stderrTail, d]);
        if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES);
      });
      let killed = false;
      // Which kill fired, from the engine's own point of view -- never guessed from the
      // child's exit code. First one wins: the limit timer and an external abort cannot
      // both be the cause of the same kill.
      let killCause: "limit" | "aborted" | null = null;
      const kill = (cause: "limit" | "aborted") => {
        if (killed) return;
        killed = true;
        killCause = cause;
        killGroupWithGrace(pgid);
      };
      cfg.emit?.("session.started", opts.stage, { session_id: sessionId, provider: cfg.provider, model: opts.model ?? cfg.model ?? null, pgid: pgid ?? null });
      const onAbort = () => kill("aborted");
      const limitTimer = setTimeout(() => kill("limit"), opts.limitS * 1000);
      const heartbeatTimer = setInterval(() => {
        cfg.emit?.("heartbeat", opts.stage, { waiting_on: opts.stage, elapsed_s: (Date.now() - start) / 1000, diff: diffShortstat(opts.cwd) });
      }, cfg.heartbeatMs ?? HEARTBEAT_MS_DEFAULT);
      opts.signal.addEventListener("abort", onAbort, { once: true });
      return new Promise<SessionResult & { stderrTail: string }>((resolve) => {
        // "close", not "exit": stdout may still be draining, and the marker is usually last.
        child.on("close", (code) => {
          clearTimeout(limitTimer);
          clearInterval(heartbeatTimer);
          opts.signal.removeEventListener("abort", onAbort);
          // The CLI invoker writes only to its iteration log, never stdout.
          const log = join(opts.cwd ?? process.cwd(), ".loki", `iteration-${sessionId}.log`);
          const logText = existsSync(log) ? readFileSync(log, "utf8") : ""; const markers = parseMarkers(stdout + logText);
          const durationS = (Date.now() - start) / 1000;
          cfg.emit?.("session.ended", opts.stage, {
            session_id: sessionId, exit: exitKind(code, killed, markers), cause: classifyExitCause(code, killed, killCause ?? undefined), duration_s: durationS,
          });
          recordCost(cfg, opts, killed ? "killed" : code === 0 ? "completed" : "failed", durationS);
          resolve({ exit: code, markers, durationS, killed, summary: (stdout + logText).trim().slice(-4096), stderrTail: stderrTail.toString("utf8") + (logText.match(/^\[sdk-loop error: .*\]$/gm) ?? []).join("\n") }); // only provider-written text is classified: child stderr and the SDK error line, never the agent transcript (A-113). The child echoes the provider's in-memory stderr (A-113b); only the claude CLI invoker returns one, since codex/cline/aider may print session activity on stderr (unmeasured)
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
  if (result.stderr) writeSync(2, result.stderr); process.exit(result.exitCode); // the CLI invoker's own in-memory stderr, never a file the agent can write
}
// cli.ts routes `engine10 session` here (section 11); it exits the process itself.
export const main = sessionChildMain;
