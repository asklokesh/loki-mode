// loki-ts/src/engine10/session.ts
//
// E-07: SessionRunner (types.ts/E-01). Runs one provider session in its own
// OS process group so the whole tree (the CLI process and anything it forks)
// can be killed together at limitS -- util/shell.ts:87 run() kills only its
// direct child, which is the gap this module exists to close (ENGINE.md
// section 10, "Session bounds").
//
// In production the spawned child re-invokes this same file with
// --engine10-session-child (see sessionChildMain at the bottom), which
// reuses runner/providers.ts resolveProvider() to make the real provider
// call. Running that call inside the spawned child, rather than in-process,
// is what puts it in its own process group.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type {
  SessionRunner,
  SessionRunOptions,
  SessionResult,
  SessionMarkers,
  ImplementExit,
} from "./types.ts";

const KILL_GRACE_MS = 2000; // ENGINE.md section 10: SIGKILL 2s after SIGTERM
const HEARTBEAT_MS_DEFAULT = 60_000; // ENGINE.md section 5: heartbeat every 60s

export type EmitFn = (type: string, stage: string | null, data: Record<string, unknown>) => void;

// ponytail: types.ts (E-01) declares SessionRunner/SessionRunOptions but
// SessionRunOptions carries no provider, model, emit or spawn-injection
// point -- session.ts is its only implementer, so RunContext never needed
// one on the shared contract. Rather than edit types.ts, those live on this
// factory config instead: whoever builds RunContext (E-03) constructs one
// SessionRunner per run with the provider/model/emit already bound, and
// every call to run() then takes only real SessionRunOptions fields, the
// same shape E-08 (Implement) will call. Reported per the task's
// contract-gap instruction.
export interface SessionRunnerConfig {
  provider: string; // "claude" is special-cased; anything else is generic
  model?: string;
  emit?: EmitFn; // ENGINE.md section 5: heartbeat, session.started, session.ended
  heartbeatMs?: number; // default 60_000; tests use a smaller value
  childCommand?: [string, string[]]; // test-only: replaces the self-respawn
}

function childEnv(opts: SessionRunOptions, cfg: SessionRunnerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env["LOKI_ITERATION"] = opts.iterationId;
  env["LOKI_E10_STAGE"] = opts.stage;
  env["LOKI_E10_BRIEF"] = opts.brief;
  env["LOKI_E10_TIER"] = opts.tier;
  env["LOKI_E10_PROVIDER"] = cfg.provider;
  // Only ever ADD variables here. Never blank an inherited var for a
  // non-claude provider: LOKI_HOST_GUARD in particular gates resolveProvider's
  // fail-closed throw (providers.ts:63), and clearing it would defeat it.
  if (cfg.provider === "claude") {
    env["LOKI_SDK_LOOP"] = "1";
    env["LOKI_HOST_GUARD"] = "1";
    const override = process.env["LOKI_MODEL_OVERRIDE"];
    if (override) {
      env["LOKI_CLAUDE_MODEL_PLANNING"] = override;
      env["LOKI_CLAUDE_MODEL_DEVELOPMENT"] = override;
      env["LOKI_CLAUDE_MODEL_FAST"] = override;
    }
  }
  return env;
}

function diffShortstat(cwd: string | undefined): { files: number; insertions: number; deletions: number } {
  try {
    const out = execFileSync("git", ["diff", "--shortstat"], { cwd, encoding: "utf8", env: process.env }).trim();
    const files = /(\d+) files? changed/.exec(out);
    const ins = /(\d+) insertions?\(\+\)/.exec(out);
    const del = /(\d+) deletions?\(-\)/.exec(out);
    return {
      files: files ? Number(files[1]) : 0,
      insertions: ins ? Number(ins[1]) : 0,
      deletions: del ? Number(del[1]) : 0,
    };
  } catch {
    return { files: 0, insertions: 0, deletions: 0 };
  }
}

function parseMarkers(stdout: string): SessionMarkers {
  const doneMatch = /LOKI_ALREADY_DONE:\s*(.+)/.exec(stdout);
  const conflictMatch = /LOKI_SPEC_CONFLICT:\s*(.+)/.exec(stdout);
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

// SIGTERM now, SIGKILL after the grace period, against the whole group.
// Shared by both the stage-limit timeout and an external abort, per
// ENGINE.md section 10, so neither path can leave a group that traps
// SIGTERM running forever.
function killGroupWithGrace(pgid: number | undefined): void {
  if (!pgid) return;
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pgid, signal);
    } catch {
      // already exited
    }
  };
  send("SIGTERM");
  setTimeout(() => send("SIGKILL"), KILL_GRACE_MS);
}

export function createSessionRunner(cfg: SessionRunnerConfig): SessionRunner {
  return {
    run(opts: SessionRunOptions): Promise<SessionResult> {
      const start = Date.now();
      // A signal that aborted before run() was even called (a cap-hit or
      // cancel racing the stage boundary) never fires the "abort" listener
      // below -- addEventListener only sees events after it attaches. Honor
      // it up front so a pre-aborted signal never spawns a session at all.
      if (opts.signal.aborted) {
        return Promise.resolve({
          exit: null,
          markers: { done: false, alreadyDone: null, specConflict: null },
          durationS: (Date.now() - start) / 1000,
          killed: true,
        });
      }
      const env = childEnv(opts, cfg);
      const [cmd, args] = cfg.childCommand ?? [
        process.execPath,
        [import.meta.path, "--engine10-session-child"],
      ];
      const sessionId = opts.iterationId;

      const child: ChildProcess = spawn(cmd, args, {
        cwd: opts.cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "ignore"], // stderr ignored: nothing reads markers there, and piping it unread risks a full-pipe stall
      });
      const pgid = child.pid;
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      let killed = false;

      cfg.emit?.("session.started", opts.stage, {
        session_id: sessionId,
        provider: cfg.provider,
        model: cfg.model ?? null,
        pgid: pgid ?? null,
      });

      const limitTimer = setTimeout(() => {
        killed = true;
        killGroupWithGrace(pgid);
      }, opts.limitS * 1000);

      const heartbeatMs = cfg.heartbeatMs ?? HEARTBEAT_MS_DEFAULT;
      const heartbeatTimer = setInterval(() => {
        cfg.emit?.("heartbeat", opts.stage, {
          waiting_on: opts.stage,
          elapsed_s: (Date.now() - start) / 1000,
          diff: diffShortstat(opts.cwd),
        });
      }, heartbeatMs);

      const onAbort = () => {
        killed = true;
        killGroupWithGrace(pgid);
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });

      return new Promise<SessionResult>((resolve) => {
        // "close" (not "exit"): stdout can still be draining when the
        // process exits, and the marker line is usually the last one.
        child.on("close", (code) => {
          clearTimeout(limitTimer);
          clearInterval(heartbeatTimer);
          opts.signal.removeEventListener("abort", onAbort);
          const markers = parseMarkers(stdout);
          const durationS = (Date.now() - start) / 1000;
          cfg.emit?.("session.ended", opts.stage, {
            session_id: sessionId,
            exit: exitKind(code, killed, markers),
            duration_s: durationS,
          });
          resolve({ exit: code, markers, durationS, killed });
        });
      });
    },
  };
}

// Child role: reuses resolveProvider (runner/providers.ts) to make the real
// provider call from inside the spawned, own-process-group child. Exported
// as a function rather than run unconditionally so cli.ts's `engine10
// session` dispatch (E-12) can reach it too, via the `main` alias below.
//
// Known gap, left for whoever wires this in: if a provider's invoke() only
// writes markers to call.iterationOutputPath and never tees to stdout, this
// process's stdout (what the parent above reads) will miss them. The sdk
// loop path (providers.ts ~:681) already tees to process.stdout; the plain
// CLI paths were not audited here for time -- verify before relying on
// markers in production for a non-SDK invocation.
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

// cli.ts's TABLE routes "session" to {module: "session.ts", fn: "main"}
// (ENGINE.md section 11). Same body as sessionChildMain: it calls
// process.exit itself, so runEngine10 never sees this return.
export const main = sessionChildMain;

if (import.meta.main && process.argv.includes("--engine10-session-child")) {
  void sessionChildMain();
}
