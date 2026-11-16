// Worker process control for the Loki 10 supervisor (extracted verbatim from engine10/supervisor.ts, CAP-1131):
// spawn the worker in its own process group, drain its stdout, and kill the group on a backstop or stop.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
/** The processes this scratch's run owns, by the evidence above; `why` says which. */
export function ownedProcesses(s: SessionScratch): (Cand & { why: string })[] {
  const c = candidates(s.since), nonce = s.nonce ? carriesNonce(c.map((x) => x.pid), s.nonce) : new Set<number>(), owned = new Map<number, Cand & { why: string }>();
  for (const x of c) {
    const why = nonce.has(x.pid) ? "environment" : inside(cwdOf(x.pid), s.dir) ? "working directory" : x.command.split(/\s+/).some((w) => w.startsWith("/") && inside(w.replace(/[,;:]+$/, ""), s.dir)) ? "command line" : null;
    if (why) owned.set(x.pid, { ...x, why });
  }
  for (let grew = true; grew;) { grew = false; for (const x of c) if (!owned.has(x.pid) && owned.has(x.ppid)) { owned.set(x.pid, { ...x, why: "child of an owned process" }); grew = true; } }
  return [...owned.values()];
}
/** One process in a cleanup record: the base name of its executable only, never its arguments (a command line can carry a password or a token). */
export interface ScratchProc { pid: number; name: string; port: number | null; why: string }
export const procName = (command: string): string => (command.trim().split(/\s+/)[0] ?? "").split("/").pop()!.slice(0, 60);
export interface ScratchCleanup { dir: string; stopped: ScratchProc[]; left: ScratchProc[]; removed: boolean; kept?: string }
/** Stops every process the run owns (start time rechecked before each signal; TERM, about 2 s, then KILL), scans again until nothing owned is alive, and
 *  only then removes the directory (its marker must hold its own path). A pid the session listed in <dir>/pids that is not provably the run's is left alone and
 *  reported. `signal` is a test seam. Never throws. */
export function cleanupSessionScratch(s: SessionScratch, o: { signal?: (pid: number, sig: NodeJS.Signals) => void; termWaitMs?: number } = {}): ScratchCleanup {
  const send = o.signal ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); }), stopped: ScratchCleanup["stopped"] = [], left: ScratchCleanup["left"] = [];
  let still: (Cand & { why: string })[] = [];
  try {
    for (let round = 0; round < 4; round++) {
      const own = ownedProcesses(s).filter((x) => alive(x.pid));
      if (own.length === 0) { still = []; break; }
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
  const live = stopped.filter((x) => still.some((y) => y.pid === x.pid));
  if (live.length) return { dir: s.dir, stopped, left, removed: false, kept: `kept: ${live.length} owned process(es) did not stop: ${live.map((x) => x.pid).join(", ")}` };
  let removed = false;
  try { if (readFileSync(join(s.dir, SCRATCH_MARKER), "utf8") === s.dir) { rmSync(s.dir, { recursive: true, force: true }); removed = !existsSync(s.dir); } } catch { removed = !existsSync(s.dir); }
  return { dir: s.dir, stopped, left, removed };
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
