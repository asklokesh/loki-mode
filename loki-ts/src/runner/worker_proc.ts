// Worker process control for the Loki 10 supervisor (extracted verbatim from engine10/supervisor.ts, CAP-1131):
// spawn the worker in its own process group, drain its stdout, and kill the group on a backstop or stop.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CANCEL_GRACE_MS = Number(process.env["LOKI_E10_CANCEL_GRACE_MS"]) > 0 ? Number(process.env["LOKI_E10_CANCEL_GRACE_MS"]) : 10000; // SIGINT/SIGTERM: time the worker gets to stop sessions and record usage before SIGKILL
const DRAIN_MS = 2000; // after the worker exits, how long P0 waits for stdout to drain before closing it
export function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { /* group already gone */ }
}
export const ULIMIT_REFUSED_EXIT = 97;
const ULIMIT_KNOBS = [["LOKI_ULIMIT_VMEM_KB", "-v"], ["LOKI_ULIMIT_NPROC", "-u"]] as const;
// Opt-in process limits (#265 slice B). Node cannot set rlimits, so a set knob wraps argv in a shell that applies them
// and execs the worker. Values are positional arguments, never script text. Unset knobs return argv unchanged.
export function ulimitArgv(argv: string[], env: NodeJS.ProcessEnv): string[] {
  const set = ULIMIT_KNOBS.filter(([name]) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) return argv;
  const values: string[] = [];
  for (const [name] of set) {
    const v = env[name]!;
    if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}; refusing to start the worker`);
    values.push(v);
  }
  const why = `loki: the OS refused the requested process limit (${set.map(([name]) => name).join(", ")}); the worker was not started. macOS rejects ulimit -v, so use LOKI_ULIMIT_NPROC alone there.`;
  const script = `${set.map(([, flag], i) => `ulimit ${flag} "$${i + 1}"`).join(" && ")} || { printf '%s\\n' '${why}' >&2; exit ${ULIMIT_REFUSED_EXIT}; }; shift ${set.length}; exec "$@"`;
  return ["/bin/sh", "-c", script, "sh", ...values, ...argv];
}
// Spawns the worker in its own process group, waits for exit plus stdout drain (DRAIN_MS), and backstops at
// backstopMs with SIGTERM then SIGKILL after escalateMs, clamped so a SIGTERM-trapping worker cannot outlive the cap.
export function spawnWorker(
  argv: string[], env: NodeJS.ProcessEnv, cwd: string, backstopMs: number, escalateMs: number, onLine: (l: string) => void, onStopped: (stopped: boolean) => void = () => {},
): Promise<{ code: number | null; killed: boolean; cancelled?: NodeJS.Signals }> {
  return new Promise((resolve) => {
    if (!argv[0]) return resolve({ code: null, killed: false });
    let wrapped: string[];
    try { wrapped = ulimitArgv(argv, env); } catch (e) { process.stderr.write(`${(e as Error).message}\n`); return resolve({ code: ULIMIT_REFUSED_EXIT, killed: false }); }
    const [cmd, ...args] = wrapped as [string, ...string[]];
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "inherit"], detached: true });
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", onLine);
    let killed = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Cancel: SIGTERM the worker so it can stop its sessions and record partial usage, keep draining its stdout, and
    // SIGKILL the group after CANCEL_GRACE_MS (a second signal escalates at once). finish() then reports `cancelled`.
    let cancelled: NodeJS.Signals | undefined;
    const onStop = (sig: NodeJS.Signals) => { // the worker no longer shares the terminal's group, so forward a stop to it
      if (cancelled) { killGroup(child.pid, "SIGKILL"); return; }
      cancelled = sig;
      killGroup(child.pid, "SIGTERM");
      timers.push(setTimeout(() => killGroup(child.pid, "SIGKILL"), CANCEL_GRACE_MS));
    };
    process.on("SIGINT", onStop);
    process.on("SIGTERM", onStop);
    process.on("SIGHUP", onStop); // terminal closed: the detached worker would otherwise outlive the supervisor and keep spending
    (globalThis as Record<symbol, unknown>)[Symbol.for("loki.ownsStopSignals")] = true; // cli.ts's blanket exit(130/143) stands down while this supervisor owns the stop
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onStop);
      process.off("SIGTERM", onStop);
      process.off("SIGHUP", onStop);
      (globalThis as Record<symbol, unknown>)[Symbol.for("loki.ownsStopSignals")] = false;
      for (const t of timers) clearTimeout(t);
      rl.close();
      child.stdout?.destroy();
      killGroup(child.pid, "SIGKILL"); onStopped(cancelled !== undefined); // reap anything the worker left in its group, and every announced session group (backstop and worker-exit paths too)
      resolve({ code, killed, ...(cancelled ? { cancelled } : {}) });
    };
    timers.push(setTimeout(() => {
      killed = true;
      killGroup(child.pid, "SIGTERM");
      timers.push(setTimeout(() => killGroup(child.pid, "SIGKILL"), escalateMs));
    }, backstopMs));
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      if (child.stdout?.readableEnded) return finish(code);
      child.stdout?.once("end", () => finish(code));
      timers.push(setTimeout(() => finish(code), DRAIN_MS));
    });
  });
}
