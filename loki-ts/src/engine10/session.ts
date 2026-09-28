// E-07: SessionRunner. Runs one provider session in its own OS process group so the whole tree can be killed together
// at limitS (ENGINE.md section 10). The child re-invokes this file (--engine10-session-child), calling through runner/providers.ts resolveProvider().
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordSessionCost, resultCostPath } from "./cost.ts";
import type { ImplementExit, SessionMarkers, SessionResult, SessionRunner, SessionRunOptions } from "./types.ts";

const KILL_GRACE_MS = 2000; // ENGINE.md section 10: SIGKILL 2s after SIGTERM
const HEARTBEAT_MS_DEFAULT = 60_000; // ENGINE.md section 5: heartbeat every 60s

export type EmitFn = (type: string, stage: string | null, data: Record<string, unknown>) => void;

// provider, model and emit are bound per run on this factory config, since SessionRunOptions carries only per-call fields.
export interface SessionRunnerConfig {
  provider: string; // "claude" is special-cased; anything else is generic
  model?: string;
  emit?: EmitFn; // ENGINE.md section 5: heartbeat, session.started, session.ended
  heartbeatMs?: number; // default 60_000; tests use a smaller value
  childCommand?: [string, string[]]; // test-only: replaces the self-respawn
  lokiRoot?: string; // where efficiency records and result-cost files live (the repo's .loki)
}

/** The model a session really runs: the override, else the provider's development pin. Never "default". */
export function resolveModel(provider: string): string {
  const e = process.env;
  if (e.LOKI_MODEL_OVERRIDE) return e.LOKI_MODEL_OVERRIDE;
  if (provider !== "claude") return `${provider} (model not recorded)`;
  return e.LOKI_CLAUDE_MODEL_DEVELOPMENT || e.LOKI_MODEL_DEVELOPMENT || "sonnet";
}

function childEnv(opts: SessionRunOptions, cfg: SessionRunnerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env["LOKI_ITERATION"] = opts.iterationId;
  env["LOKI_E10_STAGE"] = opts.stage;
  env["LOKI_E10_BRIEF"] = opts.brief;
  env["LOKI_E10_TIER"] = opts.tier;
  env["LOKI_E10_PROVIDER"] = cfg.provider;
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
  if (opts.model) {
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
  return {
    done: !doneMatch && !conflictMatch,
    alreadyDone: doneMatch ? doneMatch[1]!.trim() : null,
    specConflict: conflictMatch ? conflictMatch[1]!.trim() : null,
  };
}

function exitKind(exit: number | null, killed: boolean, markers: SessionMarkers): ImplementExit | "error" {
  if (killed) return "killed";
  if (markers.specConflict) return "spec_conflict";
  if (markers.alreadyDone) return "already_done";
  if (exit === 0) return "done";
  return "error";
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
  const own = resultCostPath(join(opts.cwd ?? process.cwd(), ".loki"), opts.iterationId);
  const dest = resultCostPath(cfg.lokiRoot, opts.iterationId);
  if (own !== dest && existsSync(own)) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(own, dest); }
  const c = recordSessionCost(cfg.lokiRoot, opts.iterationId, { status, durationMs: Math.round(durationS * 1000), model: cfg.model ?? resolveModel(cfg.provider) });
  cfg.emit?.("cost", opts.stage, {
    session_id: opts.iterationId, usd: c.usd, input_tokens: c.input_tokens, output_tokens: c.output_tokens,
    cache_read_tokens: c.cache_read_tokens, cache_creation_tokens: c.cache_creation_tokens, source: c.source || "not measured",
  });
}

export function createSessionRunner(cfg: SessionRunnerConfig): SessionRunner {
  return {
    run(opts: SessionRunOptions): Promise<SessionResult> {
      const start = Date.now();
      // A signal aborted before run() never fires the listener below, so it never spawns.
      if (opts.signal.aborted) return Promise.resolve({ exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 0, killed: true });
      const env = childEnv(opts, cfg);
      const [cmd, args] = cfg.childCommand ?? [process.execPath, [import.meta.path, "--engine10-session-child"]];
      const sessionId = opts.iterationId;
      // stderr ignored: nothing reads markers there, and an unread pipe can stall.
      const child: ChildProcess = spawn(cmd, args, { cwd: opts.cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
      const pgid = child.pid;
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      let killed = false;
      cfg.emit?.("session.started", opts.stage, { session_id: sessionId, provider: cfg.provider, model: opts.model ?? cfg.model ?? null, pgid: pgid ?? null });
      const onAbort = () => { killed = true; killGroupWithGrace(pgid); };
      const limitTimer = setTimeout(onAbort, opts.limitS * 1000);
      const heartbeatTimer = setInterval(() => {
        cfg.emit?.("heartbeat", opts.stage, { waiting_on: opts.stage, elapsed_s: (Date.now() - start) / 1000, diff: diffShortstat(opts.cwd) });
      }, cfg.heartbeatMs ?? HEARTBEAT_MS_DEFAULT);
      opts.signal.addEventListener("abort", onAbort, { once: true });

      return new Promise<SessionResult>((resolve) => {
        // "close", not "exit": stdout may still be draining, and the marker is usually last.
        child.on("close", (code) => {
          clearTimeout(limitTimer);
          clearInterval(heartbeatTimer);
          opts.signal.removeEventListener("abort", onAbort);
          // The CLI invoker writes only to its iteration log, never stdout.
          const log = join(opts.cwd ?? process.cwd(), ".loki", `iteration-${sessionId}.log`);
          const markers = parseMarkers(stdout + (existsSync(log) ? readFileSync(log, "utf8") : ""));
          const durationS = (Date.now() - start) / 1000;
          cfg.emit?.("session.ended", opts.stage, { session_id: sessionId, exit: exitKind(code, killed, markers), duration_s: durationS });
          recordCost(cfg, opts, killed ? "killed" : code === 0 ? "completed" : "failed", durationS);
          resolve({ exit: code, markers, durationS, killed });
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
  process.exit(result.exitCode);
}

// cli.ts routes `engine10 session` here (section 11); it exits the process itself.
export const main = sessionChildMain;

if (import.meta.main && process.argv.includes("--engine10-session-child")) {
  void sessionChildMain();
}
