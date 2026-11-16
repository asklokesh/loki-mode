// Worker process control for the Loki 10 supervisor (extracted verbatim from engine10/supervisor.ts, CAP-1131):
// spawn the worker in its own process group, drain its stdout, and kill the group on a backstop or stop.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { providerCause } from "./retry_class.ts";

const CANCEL_GRACE_MS = Number(process.env["LOKI_E10_CANCEL_GRACE_MS"]) > 0 ? Number(process.env["LOKI_E10_CANCEL_GRACE_MS"]) : 10000; // SIGINT/SIGTERM: time the worker gets to stop sessions and record usage before SIGKILL
const DRAIN_MS = 2000; // after the worker exits, how long P0 waits for stdout to drain before closing it
export function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { /* group already gone */ }
}
const KILL_GRACE_MS = 2000; // ENGINE.md section 10: SIGKILL 2s after SIGTERM
// SIGTERM now, SIGKILL after the grace, against the whole group; shared by the limit timeout and an external abort.
export function killGroupWithGrace(pgid: number | undefined): void {
  if (!pgid) return;
  const send = (signal: NodeJS.Signals) => { try { process.kill(-pgid, signal); } catch { /* already exited */ } };
  send("SIGTERM");
  // Re-check before SIGKILL: a group that is gone may have its pgid reused by an unrelated process.
  setTimeout(() => { try { process.kill(-pgid, 0); } catch { return; } send("SIGKILL"); }, KILL_GRACE_MS);
}
/** On a child's exit, reap its own group (recorded pgid only) when anything is still alive in it; onReap runs first, only then. */
export function reapLiveGroup(pgid: number | undefined, onReap: () => void): void {
  if (!pgid) return;
  try { process.kill(-pgid, 0); } catch { return; }
  onReap();
  killGroupWithGrace(pgid);
}
const BASH_CLAMP_FLOOR_MS = 30_000, BASH_CLAMP_MARGIN_MS = 10_000;
export const MAX_TURNS_EXIT = 98; // a session whose SDK result said error_max_turns: harness-owned, never a code failure
const SECONDS_PER_TURN = 3, MIN_TURNS = 10;
/** Per-stage turn cap derived from the stage's own time budget; an explicit positive-integer LOKI_E10_MAX_TURNS wins. */
export function maxTurnsFor(limitS: number, env: NodeJS.ProcessEnv): number {
  const user = Number(env["LOKI_E10_MAX_TURNS"]);
  return Number.isInteger(user) && user > 0 ? user : Math.max(MIN_TURNS, Math.ceil(limitS / SECONDS_PER_TURN));
}
/** Clamp Claude Code's Bash timeouts to the stage budget (minus a margin, floored) so one command cannot outlive the stage; a smaller user value wins. Also hands the session its maxTurns cap. */
export function clampBashTimeoutEnv(env: NodeJS.ProcessEnv, limitS: number): void {
  env["LOKI_E10_MAX_TURNS"] = String(maxTurnsFor(limitS, env));
  const budget = Math.max(BASH_CLAMP_FLOOR_MS, Math.floor(limitS * 1000) - BASH_CLAMP_MARGIN_MS);
  for (const [k, dflt] of [["BASH_DEFAULT_TIMEOUT_MS", 120_000], ["BASH_MAX_TIMEOUT_MS", 600_000]] as const) {
    const cur = Number(env[k]);
    env[k] = String(Math.min(Number.isFinite(cur) && cur > 0 ? cur : dflt, budget));
  }
}
const POSIX_BASH = "/bin/bash";
const isExecutable = (p: string): boolean => { try { accessSync(p, fsConstants.X_OK); return true; } catch { return false; } };
/** Claude Code's Bash tool sources the rc of the shell named in SHELL and replays its aliases, so a user's `alias ls=eza` hangs a heredoc followed by a bare `ls` to the Bash timeout. Pin SHELL to /bin/bash for the session (only SHELL changes). Cost: zsh-only aliases and functions are not available to agent Bash commands; LOKI_E10_KEEP_USER_SHELL=1 leaves SHELL as is. `canExec` is injectable for tests. */
export function pinBashShellEnv(env: NodeJS.ProcessEnv, canExec: (p: string) => boolean = isExecutable): void {
  if (env["LOKI_E10_KEEP_USER_SHELL"] === "1" || !canExec(POSIX_BASH)) return;
  env["SHELL"] = POSIX_BASH;
}
// A spawn with cwd D must give the child PWD=D: node/bun set the cwd but inherit the parent PWD, so a non-shell
// child (opencode, node tools) resolves "." against the parent. Only PWD changes; cwd undefined leaves env untouched.
export function envWithPwd<T extends Record<string, string | undefined>>(env: T, cwd: string | undefined): T {
  return cwd === undefined ? env : { ...env, PWD: resolve(cwd) };
}
/** Bun reads bunfig.toml (preload) and .env from its cwd, which for a respawn is the user repo. Every Bun respawn from that cwd starts with these flags. */
export const SAFE_BUN_FLAGS = ["--no-env-file", "--config=/dev/null"] as const;
export const ULIMIT_REFUSED_EXIT = 97;
// Debian/Ubuntu /bin/sh is dash, which has no `ulimit -u` ("Illegal option -u"); bash is on macOS and every Linux runner.
const LIMIT_SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
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
  return [LIMIT_SHELL, "-c", script, "sh", ...values, ...argv];
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
    const child = spawn(cmd, args, { cwd, env: envWithPwd(env, cwd), stdio: ["ignore", "pipe", "inherit"], detached: true });
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
// E-68 (augmentiq #52 P0): every exit code a provider call can produce, named. 125 and 143 are explicitly in scope (a container runtime or the shell itself can emit either). A code outside this table
// still names the number: classifyExitCause never falls back to an un-named string.
const EXIT_CAUSES: Readonly<Record<number, string>> = Object.fromEntries(([
  [0, "success"], [1, "general error"], [2, "misuse of shell command"], [124, "timeout"], [125, "timeout or container failure"],
  [126, "command not executable"], [127, "command not found"], [130, "SIGINT"], [137, "SIGKILL"], [143, "SIGTERM"], [98, "turn cap"],
] as const).map(([code, what]) => [code, `exit ${code} (${what})`]));
// E-68: a session child traps SIGTERM and exits 143, so classify from what the ENGINE knows (it sent the kill), never the child's code: killed always wins. killCause names which kill fired; it defaults to "limit".
export function classifyExitCause(exit: number | null, killed: boolean, killCause?: "limit" | "aborted" | "stalled", tail?: string, provider?: string): string {
  if (killed) return killCause ?? "limit";
  if (exit === null) return "external kill";
  if (exit !== 0) { const c = providerCause(tail, provider); if (c) return c; } // a known provider auth or credit line outranks the bare exit code
  return EXIT_CAUSES[exit] ?? `exit ${exit} (unrecognized code)`;
}

/** A fire-and-forget child that outlives this process: its own process group, no stdio, unref'd. The pid, or null when it did not start. */
export function spawnDetached(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): number | null {
  try { const c = spawn(cmd, args, { ...opts, stdio: "ignore", detached: true }); c.on("error", () => {}); if (!c.pid) return null; c.unref(); return c.pid; } catch { return null; }
}

// Q1 RUN-SCRATCH (issue runs on claude, LOKI_E10_PROVE_BY_RUNNING=0 opts out): the implement session's own scratch directory. Short path (a unix socket path is
// limited to about 104 characters; a session's tsx failed with EINVAL on a 107-character TMPDIR), owner-marked so the host guard (autonomy/hooks/validate-bash.sh)
// honours it only when this harness made it. The session gets it as LOKI_SCRATCH and TMPDIR; the guard then lets it stop the processes it started (listed in
// $LOKI_SCRATCH/pids, or running inside the directory, and started after the session) and delete paths inside it. After implement the harness stops what is left.
export const SCRATCH_MARKER = ".loki-scratch-owned";
export interface SessionScratch { dir: string; since: number }
export function createSessionScratch(): SessionScratch {
  const base = existsSync("/tmp") ? realpathSync("/tmp") : realpathSync(tmpdir());
  const dir = realpathSync(mkdtempSync(join(base, "lk-")));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, SCRATCH_MARKER), dir, { mode: 0o600 });
  return { dir, since: Math.floor(Date.now() / 1000) };
}
/** Epoch seconds a process started (ps lstart, local time), or null when it is gone or unreadable. */
export function processStartEpoch(pid: number): number | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 3000 });
  const t = (r.stdout ?? "").trim();
  if (r.status !== 0 || !t) return null;
  const ms = Date.parse(t.replace(/^\w{3} /, "")); // "Nov 16 01:02:03 2026"
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Stops every process id in <dir>/pids that is still alive and started at or after `since` (TERM, then KILL after about 2 s), removes the directory, and says what it
 *  stopped. A pid that started before the session is never touched. Never throws. */
export function cleanupSessionScratch(s: SessionScratch): { dir: string; stopped: { pid: number; command: string }[]; removed: boolean } {
  const stopped: { pid: number; command: string }[] = [];
  try {
    const pids = [...new Set(readFileSync(join(s.dir, "pids"), "utf8").split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number))].filter((p) => p > 1 && p !== process.pid);
    for (const pid of pids) {
      const start = processStartEpoch(pid);
      if (start === null || start < s.since || !alive(pid)) continue;
      const command = (spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).stdout ?? "").trim().slice(0, 160);
      try { process.kill(pid, "SIGTERM"); } catch { continue; }
      for (let i = 0; i < 20 && alive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      stopped.push({ pid, command });
    }
  } catch { /* no pids file: nothing recorded */ }
  let removed = false;
  try {
    if (readFileSync(join(s.dir, SCRATCH_MARKER), "utf8") === s.dir) { rmSync(s.dir, { recursive: true, force: true }); removed = !existsSync(s.dir); }
  } catch { removed = !existsSync(s.dir); }
  return { dir: s.dir, stopped, removed };
}
