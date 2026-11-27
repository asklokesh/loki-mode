// Worker process control for the Loki 10 supervisor (extracted verbatim from engine10/supervisor.ts, CAP-1131):
// spawn the worker in its own process group, drain its stdout, and kill the group on a backstop or stop.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { join, resolve } from "node:path";
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, lstatSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { providerCause } from "./retry_class.ts";
import { armTimer } from "../engine10/types.ts";

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
  const turns = maxTurnsFor(limitS, env); if (Number.isFinite(turns)) env["LOKI_E10_MAX_TURNS"] = String(turns); else delete env["LOKI_E10_MAX_TURNS"]; // NO-DEFAULT-BUDGET: no stage limit, no derived turn cap (the session's silence and loop guards end it)
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
/** True only while the live console owns the terminal (console.ts sets the mark while its wrapper is installed) and this process's stderr is that terminal. */
export const forwardsWorkerStderr = (stream: { isTTY?: boolean } = process.stderr): boolean => stream.isTTY === true && (globalThis as Record<symbol, unknown>)[Symbol.for("loki.consoleOwnsTerminal")] === true;
const HANG_POLL_MS = 30_000;
/** True when `pid` has at least one child process (pgrep -P). An unreadable process table reads as true: the hang guard never kills on a failed probe. */
export function hasChildProcess(pid: number): boolean {
  try { const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 5000 }); return r.status === 1 && r.stdout.trim() === "" ? false : true; } catch { return true; }
}
export function spawnWorker(
  argv: string[], env: NodeJS.ProcessEnv, cwd: string, backstopMs: number, escalateMs: number, onLine: (l: string) => void,
  hang?: { silenceS: number; lastEventMs: () => number }, onStopped: (stopped: boolean) => void = () => {},
): Promise<{ code: number | null; killed: boolean; cancelled?: NodeJS.Signals; hung?: true }> {
  return new Promise((resolve) => {
    if (!argv[0]) return resolve({ code: null, killed: false });
    let wrapped: string[];
    try { wrapped = ulimitArgv(argv, env); } catch (e) { process.stderr.write(`${(e as Error).message}\n`); return resolve({ code: ULIMIT_REFUSED_EXIT, killed: false }); }
    const [cmd, ...args] = wrapped as [string, ...string[]];
    // The worker's stderr is the supervisor's own stderr, with one exception: while the live console owns the terminal, a byte the worker wrote straight
    // to it would land under the panel and the next redraw would leave that many rows of the old panel behind. So in that one case (the console is up
    // AND stderr is the terminal) stderr is a pipe, and each line is written through process.stderr.write, which the console wraps to print it above the
    // panel. Every other case (--json, --verbose, a pipe, `2>file`) keeps "inherit", byte for byte as before.
    const fwd = forwardsWorkerStderr();
    const child = spawn(cmd, args, { cwd, env: envWithPwd(fwd ? { ...env, LOKI_E10_STDERR_TTY: "1" } : env, cwd), stdio: ["ignore", "pipe", fwd ? "pipe" : "inherit"], detached: true });
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", onLine);
    let killed = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Whole lines are passed on as they arrive, in order; an unfinished line waits 200 ms for its end (so one line is never printed as two), and whatever
    // is left is written when the pipe ends and again before this returns, so a crash trace or a last line with no newline is never lost.
    const dec = new StringDecoder("utf8"); let errTail = "", errTimer: ReturnType<typeof setTimeout> | null = null;
    const flushErr = (): void => { if (errTimer) { clearTimeout(errTimer); errTimer = null; } if (errTail) { const t = errTail; errTail = ""; process.stderr.write(t); } };
    const onErr = (b: Buffer | string): void => {
      errTail += typeof b === "string" ? b : dec.write(b);
      const cut = errTail.lastIndexOf("\n");
      if (cut >= 0) { const whole = errTail.slice(0, cut + 1); errTail = errTail.slice(cut + 1); if (errTimer) { clearTimeout(errTimer); errTimer = null; } process.stderr.write(whole); }
      if (errTail && !errTimer) errTimer = setTimeout(() => { errTimer = null; flushErr(); }, 200);
    };
    if (fwd && child.stderr) { child.stderr.on("data", onErr); child.stderr.on("end", () => { errTail += dec.end(); flushErr(); }); }
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
      for (const t of timers) clearTimeout(t); backstop.clear(); if (hangBeat) clearInterval(hangBeat);
      rl.close();
      child.stdout?.destroy();
      if (fwd && child.stderr) { for (let b = child.stderr.read() as Buffer | string | null; b !== null; b = child.stderr.read() as Buffer | string | null) onErr(b); flushErr(); child.stderr.off("data", onErr); child.stderr.destroy(); }
      killGroup(child.pid, "SIGKILL"); onStopped(cancelled !== undefined); // reap anything the worker left in its group, and every announced session group (backstop and worker-exit paths too)
      resolve({ code, killed, ...(cancelled ? { cancelled } : {}), ...(hung ? { hung: true as const } : {}) });
    };
    const stopWorker = (): void => {
      if (killed) return;
      killed = true;
      killGroup(child.pid, "SIGTERM");
      timers.push(setTimeout(() => killGroup(child.pid, "SIGKILL"), escalateMs));
    };
    const backstop = armTimer(stopWorker, backstopMs); // NO-DEFAULT-BUDGET: Infinity (no time limit) arms nothing
    // NO-DEFAULT-BUDGET hang guard (only when there is no backstop): no worker event for hang.silenceS while the worker runs no process of its own. A long
    // test suite or a model session is a child process with its own silence guard, so it never trips this.
    let hung = false;
    const hangBeat = hang ? setInterval(() => { if (!killed && Date.now() - hang.lastEventMs() >= hang.silenceS * 1000 && child.pid !== undefined && !hasChildProcess(child.pid)) { hung = true; stopWorker(); } }, Math.max(100, Math.min(HANG_POLL_MS, Math.floor(hang.silenceS * 500)))) : null;
    hangBeat?.unref();
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      const drained = (): boolean => (child.stdout?.readableEnded ?? true) && (!fwd || (child.stderr?.readableEnded ?? true)); // a piped stderr is read to its end too
      if (drained()) return finish(code);
      const check = (): void => { if (drained()) finish(code); };
      child.stdout?.once("end", check); if (fwd) child.stderr?.once("end", check);
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
// limited to about 104 characters; a session's tsx failed with EINVAL on a 107-character TMPDIR), owner-marked. The session gets it as LOKI_SCRATCH and TMPDIR
// and the run's nonce as LOKI_RUN_OWNER. Its record (dir, nonce, since, worker pid) is written to <runDir>/scratch.json at creation, so the supervisor, an exit
// hook or the next run can clean up after a stop the worker never saw.
// Q1 SCRATCH-OWNED: the harness proves ownership itself and never trusts the session's own pids file. A process of this user that started at or after `since`
// is the run's when its environment carries the run's nonce, its resolved working directory is inside the scratch directory, a path on its command line
// resolves inside it, or its parent is the run's. Never by a path in the work tree, never by anything else under a shared temp root. A pid in
// <dir>/pids that passes none of these is left alone and reported. Measured on macOS (2026-11-16, real binaries): a pg_ctl postmaster carries the nonce
// and sits in its data directory; npm exec tsx and its node children carry it or descend from it; `redis-server --daemonize yes` loses it (its process
// title overwrites the environment area) and is found only when its --dir is in scratch. macOS also hides the environment of its own platform binaries
// (/bin/sleep and the like) from ps; such a process is found only by its directory, its command line or its parent.
export const SCRATCH_MARKER = ".loki-scratch-owned", SCRATCH_RECORD = "scratch.json", OWNER_ENV = "LOKI_RUN_OWNER";
/** TASK MEMORY: the read-only subdirectory of an implement scratch that holds Loki's MEMORY.md (engine10/proof_rerun.ts writeTaskMemory). */
export const TASK_MEMORY_SUBDIR = "task-memory";
export interface SessionScratch { dir: string; since: number; nonce: string }
export function createSessionScratch(runDir?: string): SessionScratch {
  const base = existsSync("/tmp") ? realpathSync("/tmp") : realpathSync(tmpdir());
  const dir = realpathSync(mkdtempSync(join(base, "lk-")));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, SCRATCH_MARKER), dir, { mode: 0o600 });
  const s = { dir, since: Math.floor(Date.now() / 1000), nonce: `o${randomBytes(9).toString("hex")}` };
  if (runDir) { try { mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, SCRATCH_RECORD), JSON.stringify({ ...s, worker_pid: process.pid }) + "\n", { mode: 0o600 }); } catch { /* the in-process hooks still clean up */ } }
  return s;
}
/** The LOKI_RUN_OWNER value and the env a session of this scratch gets. */
export const scratchSessionEnv = (s: SessionScratch): Record<string, string> => ({ LOKI_SCRATCH: s.dir, LOKI_SCRATCH_SINCE: String(s.since), TMPDIR: s.dir, [OWNER_ENV]: s.nonce });
/** Epoch seconds of a `ps -o lstart=` text ("Mon Nov  6 01:02:03 2026"; one or two spaces before a single-digit day), or null. The text is read as UTC:
 *  psOut runs ps with TZ=UTC, so both sides use one zone whatever TZ the user exported (a local-time read shifted every start by the TZ offset). */
export function lstartEpoch(t: string): number | null {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(t.trim());
  if (!m) return null;
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[1]!);
  return mon < 0 ? null : Math.floor(Date.UTC(Number(m[6]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000);
}
const psOut = (args: string[], timeout = 4000): string => (spawnSync("ps", args, { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, timeout }).stdout ?? "");
/** Epoch seconds a process started (ps lstart, read in UTC), or null when it is gone or unreadable. */
export function processStartEpoch(pid: number): number | null { return lstartEpoch(psOut(["-o", "lstart=", "-p", String(pid)])); }
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const inside = (p: string, dir: string): boolean => { let r = p; try { r = realpathSync(p); } catch { /* a path that no longer exists keeps its text */ } return r === dir || r.startsWith(`${dir}/`); };
interface Cand { pid: number; ppid: number; start: number; command: string }
/** This user's processes that started at or after `since`, never this process or its parent. */
function candidates(since: number): Cand[] {
  const uid = process.getuid?.() ?? -1, out: Cand[] = [];
  for (const l of psOut(["-A", "-o", "pid=,ppid=,uid=,lstart=,command="], 8000).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(l); if (!m) continue;
    const pid = Number(m[1]), start = lstartEpoch(m[4]!);
    if (pid > 1 && pid !== process.pid && pid !== process.ppid && Number(m[3]) === uid && start !== null && start >= since) out.push({ pid, ppid: Number(m[2]), start, command: m[5]!.slice(0, 400) });
  }
  return out;
}
/** Which of `pids` carry this nonce in their environment (linux /proc/PID/environ, else `ps eww`); nothing else of an environment is kept or printed. */
function carriesNonce(pids: number[], nonce: string): Set<number> {
  const out = new Set<number>(), needle = `${OWNER_ENV}=${nonce}`;
  if (existsSync("/proc/self/environ")) { for (const pid of pids) { try { if (readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(needle)) out.add(pid); } catch { /* gone */ } } return out; }
  for (let i = 0; i < pids.length; i += 40) for (const l of psOut(["eww", "-o", "pid=,command=", "-p", pids.slice(i, i + 40).join(",")], 8000).split("\n")) { const p = /^\s*(\d+)\s/.exec(l); if (p && (` ${l} `).includes(` ${needle} `)) out.add(Number(p[1])); }
  return out;
}
/** A process's resolved working directory (linux /proc, else lsof), or "". */
function cwdOf(pid: number): string {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* not linux, or gone */ }
  const r = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 3000 });
  return (r.stdout ?? "").split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? "";
}
const portOf = (pid: number): number | null => { const r = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8", timeout: 3000 }); const m = /\nn[^\n]*:(\d+)/.exec(`\n${r.stdout ?? ""}`); return m ? Number(m[1]) : null; };
/** #713 RUN MARKER: a script the harness runs gets a read-only descriptor on the scratch's marker file as descriptor 3, opened by a small sh wrapper that then
 *  execs the script (same pid, so a group kill or a timeout is unchanged). fork, setsid, `env -i` and a process title that overwrites the environment all keep an
 *  inherited descriptor (measured on macOS 2026-11-26: a python double fork under env -i and `redis-server --daemonize yes` both still held it), so a daemon that
 *  left the run's group, lost the nonce and sits in a directory outside the scratch is still provably this run's. A program that closes its inherited
 *  descriptors, or a session whose shells do not pass them on, loses it. The child opens the file itself: a descriptor handed to Bun.spawn is closed by Bun
 *  later, so a parent that also closed it could close a reused descriptor number. When the marker is not readable the script runs without it. */
export const withScratchMarker = (s: SessionScratch, argv: readonly string[]): string[] => ["/bin/sh", "-c", '[ -r "$1" ] && exec 3<"$1"; shift; exec "$@"', "loki-run-marker", join(s.dir, SCRATCH_MARKER), ...argv];
/** Which of `pids` hold this file open (linux /proc/PID/fd, else one `lsof` on the file). */
function holdsFile(pids: number[], file: string): Set<number> {
  const out = new Set<number>(); if (!pids.length) return out;
  if (existsSync("/proc/self/fd")) { for (const pid of pids) { try { for (const f of readdirSync(`/proc/${pid}/fd`)) { try { if (readlinkSync(`/proc/${pid}/fd/${f}`) === file) { out.add(pid); break; } } catch { /* closed meanwhile */ } } } catch { /* gone, or not ours */ } } return out; }
  const want = new Set(pids), r = spawnSync("lsof", ["-Fp", "--", file], { encoding: "utf8", timeout: 4000 });
  for (const l of (r.stdout ?? "").split("\n")) if (l.startsWith("p") && want.has(Number(l.slice(1)))) out.add(Number(l.slice(1)));
  return out;
}
/** #713 OUTSIDE DIRECTORY: the directory to remove for a process already proven the run's whose working directory is outside the scratch: a directory that sits
 *  directly in a temp root, was created after the run's scratch directory and is no other run's scratch. Never the temp root itself. Also how a suspect is
 *  told apart (below). Returns the directory, or null. */
function outsideTempDir(cwd: string, since: number, scratchDir: string): string | null {
  if (!cwd) return null;
  let born = since * 1000; try { const b = lstatSync(scratchDir).birthtimeMs; if (b > 0) born = b; } catch { /* scratch already gone: the second-level start time stands */ }
  const roots = new Set<string>(); for (const r of ["/tmp", "/var/tmp", tmpdir(), process.env["TMPDIR"] ?? ""]) { if (!r) continue; try { roots.add(realpathSync(r)); } catch { /* absent */ } }
  for (const root of roots) {
    if (!cwd.startsWith(`${root}/`)) continue;
    const top = join(root, cwd.slice(root.length + 1).split("/")[0]!);
    try {
      const st = lstatSync(top); if (!st.isDirectory() || st.isSymbolicLink() || !(st.birthtimeMs > 0) || st.birthtimeMs < born) return null; // no birth time: a ctime moves with every new entry, so an old shared directory could pass
      if (existsSync(join(top, SCRATCH_MARKER)) || existsSync(join(top, ".loki-run-owned"))) return null;
      return top;
    } catch { return null; }
  }
  return null;
}
/** #713 OUTSIDE HOLDERS: live processes other than `skip` whose working directory or an open file is inside `dir` (linux /proc, else one `lsof +D`). An outside
 *  directory can be shared: a foreign process in a sibling subdirectory must keep it. When the check cannot run (no lsof), the answer is "held". */
function holdersIn(dir: string, skip: Set<number>): number[] | null {
  const out = new Set<number>(), under = (l: string): boolean => l === dir || l.startsWith(`${dir}/`); // /proc links are already resolved
  if (existsSync("/proc/self/fd")) {
    for (const e of readdirSync("/proc")) {
      if (!/^\d+$/.test(e)) continue; const pid = Number(e); if (skip.has(pid)) continue;
      try { if (under(readlinkSync(`/proc/${pid}/cwd`))) { out.add(pid); continue; } } catch { /* gone, or not readable */ }
      try { for (const f of readdirSync(`/proc/${pid}/fd`)) { try { if (under(readlinkSync(`/proc/${pid}/fd/${f}`))) { out.add(pid); break; } } catch { /* closed meanwhile */ } } } catch { /* gone, or not ours */ }
    }
    return [...out];
  }
  const r = spawnSync("lsof", ["-Fp", "+D", dir], { encoding: "utf8", timeout: 8000 });
  if (r.error || r.status === null) return null;
  for (const l of (r.stdout ?? "").split("\n")) if (l.startsWith("p")) { const pid = Number(l.slice(1)); if (pid > 0 && !skip.has(pid)) out.add(pid); }
  return [...out];
}
/** The processes this scratch's run owns, by the evidence above; `why` says which. `outside` is set when an owned process sits in a temp directory made during
 *  the run outside the scratch: that directory is removed once every owned process is gone and no other live process sits in it or holds a file in it. */
export function ownedProcesses(s: SessionScratch): (Cand & { why: string; outside?: string })[] {
  const c = candidates(s.since), pids = c.map((x) => x.pid), nonce = s.nonce ? carriesNonce(pids, s.nonce) : new Set<number>(), marker = holdsFile(pids, join(s.dir, SCRATCH_MARKER)), owned = new Map<number, Cand & { why: string; outside?: string }>();
  for (const x of c) {
    const cwd = nonce.has(x.pid) && !marker.has(x.pid) ? "" : cwdOf(x.pid);
    const why = nonce.has(x.pid) ? "environment" : marker.has(x.pid) ? "holds the run's marker" : inside(cwd, s.dir) ? "working directory" : x.command.split(/\s+/).some((w) => w.startsWith("/") && inside(w.replace(/[,;:]+$/, ""), s.dir)) ? "command line" : null;
    if (!why) continue;
    const top = marker.has(x.pid) && cwd && !inside(cwd, s.dir) ? outsideTempDir(cwd, s.since, s.dir) : null;
    owned.set(x.pid, { ...x, why, ...(top ? { outside: top } : {}) });
  }
  for (let grew = true; grew;) { grew = false; for (const x of c) if (!owned.has(x.pid) && owned.has(x.ppid)) { owned.set(x.pid, { ...x, why: "child of an owned process" }); grew = true; } }
  return [...owned.values()];
}
/** One process in a cleanup record: the base name of its executable only, never its arguments (a command line can carry a password or a token). */
export interface ScratchProc { pid: number; name: string; port: number | null; why: string }
export const procName = (command: string): string => (command.trim().split(/\s+/)[0] ?? "").split("/").pop()!.slice(0, 60);
/** #713 SUSPECT: a listener the run's evidence does not cover but that looks like a leak (it started during the run, its parent is init, and its working
 *  directory is in a temp directory made after the scratch). Recorded for a person to check, never signalled; its directory is never removed. It may be another
 *  run's or an unrelated test's. */
export interface ScratchSuspect { pid: number; name: string; port: number; cwd: string }
export interface ScratchCleanup { dir: string; stopped: ScratchProc[]; left: ScratchProc[]; removed: boolean; kept?: string; outside_removed?: string[]; outside_kept?: { dir: string; pids: number[] }[]; suspects?: ScratchSuspect[] }
function suspectProcesses(s: SessionScratch, skip: Set<number>): ScratchSuspect[] {
  const out: ScratchSuspect[] = [];
  for (const x of candidates(s.since)) {
    if (x.ppid !== 1 || skip.has(x.pid) || !alive(x.pid)) continue;
    const cwd = cwdOf(x.pid); if (!cwd || inside(cwd, s.dir) || !outsideTempDir(cwd, s.since, s.dir)) continue;
    const port = portOf(x.pid); if (port !== null) out.push({ pid: x.pid, name: procName(x.command), port, cwd: cwd.slice(0, 200) });
  }
  return out.slice(0, 20);
}
/** Stops every process the run owns (start time rechecked before each signal; TERM, about 2 s, then KILL), scans again until nothing owned is alive, and
 *  only then removes the directory (its marker must hold its own path). A pid the session listed in <dir>/pids that is not provably the run's is left alone and
 *  reported. `signal` is a test seam. Never throws. */
export function cleanupSessionScratch(s: SessionScratch, o: { signal?: (pid: number, sig: NodeJS.Signals) => void; termWaitMs?: number } = {}): ScratchCleanup {
  const send = o.signal ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); }), stopped: ScratchCleanup["stopped"] = [], left: ScratchCleanup["left"] = [];
  let still: (Cand & { why: string })[] = []; const outside = new Set<string>();
  try {
    for (let round = 0; round < 4; round++) {
      const own = ownedProcesses(s).filter((x) => alive(x.pid));
      if (own.length === 0) { still = []; break; }
      for (const x of own) if (x.outside) outside.add(x.outside);
      const info = own.map((x) => ({ ...x, port: portOf(x.pid) }));
      for (const x of info) { if (processStartEpoch(x.pid) === x.start) { try { send(x.pid, "SIGTERM"); } catch { /* gone */ } } }
      for (let i = 0; i < Math.ceil((o.termWaitMs ?? 2000) / 100) && info.some((x) => alive(x.pid)); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      for (const x of info) if (alive(x.pid) && processStartEpoch(x.pid) === x.start) { try { send(x.pid, "SIGKILL"); } catch { /* gone */ } }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      for (const x of info) if (!stopped.some((y) => y.pid === x.pid)) stopped.push({ pid: x.pid, name: procName(x.command), port: x.port, why: x.why });
      still = info.filter((x) => alive(x.pid) && processStartEpoch(x.pid) === x.start);
    }
    try {
      const listed = [...new Set(readFileSync(join(s.dir, "pids"), "utf8").split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number))];
      for (const pid of listed) if (alive(pid) && !stopped.some((y) => y.pid === pid)) left.push({ pid, name: procName(psOut(["-o", "comm=", "-p", String(pid)])), port: portOf(pid), why: "left running, not proven ours" });
    } catch { /* no pids file: it is only a hint */ }
  } catch { /* never fails the run */ }
  let suspects: ScratchSuspect[] = []; try { suspects = suspectProcesses(s, new Set([...stopped, ...left].map((x) => x.pid))); } catch { /* a record only */ }
  const sus = suspects.length ? { suspects } : {};
  const live = stopped.filter((x) => still.some((y) => y.pid === x.pid));
  if (live.length) return { dir: s.dir, stopped, left, removed: false, ...sus, kept: `kept: ${live.length} owned process(es) did not stop: ${live.map((x) => x.pid).join(", ")}` };
  // #713: only after every owned process is gone, and only when no other live process sits in the directory or holds a file in it (then it is kept and named)
  const outside_removed: string[] = [], outside_kept: { dir: string; pids: number[] }[] = [], mine = new Set([process.pid, ...stopped.map((x) => x.pid)]);
  for (const d of outside) {
    let held: number[] | null = null; try { held = holdersIn(d, mine); } catch { held = null; }
    if (held === null || held.length) { outside_kept.push({ dir: d, pids: (held ?? []).slice(0, 20) }); continue; }
    try { rmSync(d, { recursive: true, force: true }); if (!existsSync(d)) outside_removed.push(d); } catch { /* left: the next run's scan or the user */ }
  }
  let removed = false;
  try { if (readFileSync(join(s.dir, SCRATCH_MARKER), "utf8") === s.dir) { try { chmodSync(join(s.dir, TASK_MEMORY_SUBDIR), 0o700); } catch { /* no task memory here */ } rmSync(s.dir, { recursive: true, force: true }); removed = !existsSync(s.dir); } } catch { removed = !existsSync(s.dir); } // TASK MEMORY: its read-only directory is made writable first, or the removal fails on it
  return { dir: s.dir, stopped, left, removed, ...(outside_removed.length ? { outside_removed } : {}), ...(outside_kept.length ? { outside_kept } : {}), ...sus };
}
/** The record a run wrote at scratch creation, when its directory still exists. */
export function readScratchRecord(runDir: string): (SessionScratch & { worker_pid?: number }) | null {
  try { const r = JSON.parse(readFileSync(join(runDir, SCRATCH_RECORD), "utf8")) as SessionScratch & { worker_pid?: number }; return typeof r.dir === "string" && typeof r.since === "number" && existsSync(r.dir) ? r : null; } catch { return null; }
}
/** Q1 SCRATCH-FINAL: what the worker's exit hook cleaned (a cancelled or aborted run ends before implement records anything), kept in the run directory
 *  for the supervisor to turn into the scratch.cleanup event. */
export const SCRATCH_EXIT_RECORD = "scratch-cleanup.json";
export function writeExitCleanup(runDir: string, r: ScratchCleanup): void { try { writeFileSync(join(runDir, SCRATCH_EXIT_RECORD), JSON.stringify(r) + "\n", { mode: 0o600 }); } catch { /* the event is a record, never a reason to fail */ } }
export function readExitCleanup(runDir: string): ScratchCleanup | null { try { const r = JSON.parse(readFileSync(join(runDir, SCRATCH_EXIT_RECORD), "utf8")) as ScratchCleanup; return Array.isArray(r.stopped) && Array.isArray(r.left) ? r : null; } catch { return null; } }
/** The supervisor's pass after the worker exited, and the next run's pass over records whose worker is gone: the same ownership cleanup. */
export function cleanupScratchRecord(runDir: string): ScratchCleanup | null { const r = readScratchRecord(runDir); return r ? cleanupSessionScratch({ dir: r.dir, since: r.since, nonce: r.nonce ?? "" }) : null; }
export function cleanupStaleScratches(lokiRoot: string): ScratchCleanup[] {
  const out: ScratchCleanup[] = []; let runs: string[] = [];
  try { runs = readdirSync(join(lokiRoot, "runs")); } catch { return out; }
  for (const id of runs) { const d = join(lokiRoot, "runs", id), r = readScratchRecord(d); if (r && typeof r.worker_pid === "number" && !alive(r.worker_pid)) { const c = cleanupScratchRecord(d); if (c) out.push(c); } }
  return out;
}
