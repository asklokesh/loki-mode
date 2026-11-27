// Q1 PROVE (LOKI_E10_PROVE, default on; 0/off/false/no opts out): an issue run on the claude provider. A short listing call fixes the issue's asks
// (stages/prove_list.ts, each a verbatim line of the issue); one fresh session that did not write the change writes one script per ask that runs it
// against an empty environment built by the repository's own setup path; the harness runs the scripts and the exit codes decide. New file: no existing
// stage owns a session kept away from the implementer's reply, nor harness-run user-level scripts. FireLater#24: 22 attempts scored blind by starting
// the product; 13 scored 6 of 9 or less with tests, lint and typecheck green on 21 of 22, and 4 of 7 runs labelled VERIFIED were broken.
// Static imports stay off seal.ts, machine.ts and implement.ts (seal and pr import this file; implement imports seal): machine.ts loads lazily.
// THIN-WRAP (#712): runProofAuthor below is the independent proof session of the implement stage's thin route; implement imports it, so the same rule
// keeps this file from importing implement.ts back.
import { defaultBudgetsOn, MAX_TIMER_MS } from "../types.ts";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cleanupSessionScratch, createSessionScratch, killGroup, ownedProcesses, scratchSessionEnv, withScratchMarker, type ScratchCleanup, type SessionScratch } from "../../runner/worker_proc.ts";
import { plainTestEnv } from "../../util/check_result.ts";
import { treeFingerprint } from "../../util/anti_loop.ts";
import { snapshotDiff } from "../../e10ext/treeswap.ts";
import { restoreTurnPaths, turnChangedPaths } from "../../features/self_review.ts";
import { redactSecrets, sanitizeReason } from "../../util/redact.ts";
import { safeGit } from "../../util/safe_git.ts";
import { missingServices, readEnvCardFile } from "../../util/stack_tools.ts";
import { checkAsks, listBrief } from "./prove_list.ts";
import { resumeForProve } from "../../util/conflict_resume.ts";
import { ISSUE_FINISH_LINE, STAGE_BUDGETS, taskBlock, type Obj, type RunContext, type SessionResult, type SessionRunOptions, type Stage, type StageResult } from "../types.ts";
import { OLD_RECORD_PROOF_LINE, PROOF_SCRIPT_LINE } from "../../e10ext/context.ts";
import { repoCardOn, SETUP_FIRST_LINE } from "../../e10ext/repomemory.ts";
import { PROOF_SCRIPT, PROVES_NOTHING_FIX } from "../proof_rerun.ts";

const off = (v: string | undefined): boolean => /^(0|off|false|no)$/i.test((v ?? "").trim());
const num = (v: string | undefined, d: number): number => { const n = Number((v ?? "").trim()); return (v ?? "").trim() !== "" && Number.isFinite(n) && n > 0 ? n : d; };
export const proveOn = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|on|true|yes)$/i.test((env["LOKI_E10_PROVE"] ?? "").trim()); // off by default (2026-11-16 wrap-up); LOKI_E10_PROVE=1 turns the stage on
/** The runs the prove stage owns. Every other run (a text goal, opencode, the opt-out) never sees this stage, its notes, its budget or its receipt key. */
export const proveScope = (provider: string, o: Partial<Record<string, Obj>>, env: NodeJS.ProcessEnv = process.env): boolean => provider === "claude" && o.intake?.source === "issue" && proveOn(env);
/** The stage runs, and seal requires its record, when implement ended done (any other exit is already below VERIFIED). */
export const proveApplies = (provider: string, o: Partial<Record<string, Obj>>, env: NodeJS.ProcessEnv = process.env): boolean => proveScope(provider, o, env) && o.implement?.exit === "done" && o.intake?.already_satisfied !== true;
/** The stage's own budget (listing, prover session, head pass, base pass), held back from implement and added to a sized run cap. */
export const proveBudgetS = (env: NodeJS.ProcessEnv = process.env): number => num(env["LOKI_E10_PROVE_BUDGET_S"], defaultBudgetsOn(env) ? 600 : Infinity); // NO-DEFAULT-BUDGET: no stage budget unless set; a user run cap still bounds it (machine.ts proveNow room)
/** What the machine holds back for the prove stage when it sizes implement under a user's run cap: the stage's own budget, or 600 s when it has none. */
export const proveReserveOfS = (env: NodeJS.ProcessEnv = process.env): number => { const b = proveBudgetS(env); return Number.isFinite(b) ? b : 600; };
/** NO-DEFAULT-BUDGET: the listing session's turn cap: 3 only with LOKI_E10_DEFAULT_BUDGETS=1 or LOKI_E10_PROVE_LIST_TURNS; otherwise none (the session's silence and loop kills end it). */
export const proveListTurns = (env: NodeJS.ProcessEnv = process.env): number | undefined => { const n = Number((env["LOKI_E10_PROVE_LIST_TURNS"] ?? "").trim()); return Number.isInteger(n) && n > 0 ? n : defaultBudgetsOn(env) ? 3 : undefined; };
export const scriptLimitS = (env: NodeJS.ProcessEnv = process.env): number => num(env["LOKI_E10_PROVE_SCRIPT_S"], 120);
/** Repair (default on; LOKI_E10_PROVE_REPAIR=0 opts out): unproved asks go back to the implement session by same-session resume, at most MAX_REPAIR_ROUNDS. */
export const proveRepairOn = (env: NodeJS.ProcessEnv = process.env): boolean => !off(env["LOKI_E10_PROVE_REPAIR"]);
export const MAX_REPAIR_ROUNDS = 2;

export const MAX_ASKS = 12, NOT_RUN_HERE_EXIT = 3, TEARDOWN_S = 60, PROVER_MAX_S = 600, LIST_S = 90, PROVE_MIN_S = 120;
const MARGIN_S = 10;
export const PROVE_DIR = "prove";
export const NOT_OURS = "port was not ours";
export const ALSO_ON_BASE = "check also passes without the change";
export type AskResult = "proved" | "not run here" | "not proved";
export interface ScriptOutcome { exit: number | "timeout" | "missing" | "not run" | "skipped"; tail: string }
export interface ProveAsk { id: string; text: string; command: string; cmd_line: string; head: ScriptOutcome; base: ScriptOutcome | "base not run"; result: AskResult; reason: string }
export interface Leftover { pid: number; stopped: boolean; why: string }
export interface ProveRecord {
  status: "ran" | "not_run" | "killed"; reason?: string; dir: string;
  asks: ProveAsk[]; setup?: ScriptOutcome; endpoints?: { name: string; target: string; ok: boolean; why: string }[]; base: string;
  rounds: { round: number; iteration_id?: string; failing: string[] }[];
  notes: string[]; tree_restored: string[]; tree_fp: string | null; iteration_ids: string[]; leftovers: Leftover[]; wall_s: number; reused?: boolean;
}
export const proveNotRun = (status: "not_run" | "killed", reason: string): ProveRecord => ({ status, reason, dir: PROVE_DIR, asks: [], base: "base not run", rounds: [], notes: [], tree_restored: [], tree_fp: null, iteration_ids: [], leftovers: [], wall_s: 0 });

const clean = (s: string, n = 300): string => { const t = sanitizeReason(redactSecrets(s)); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
const askFile = (id: string): string => `ask-${id}.sh`;
/** Every file the prover session may write (the SDK route's .loki/ deny lets exactly these through). */
export const proverOutputs = (dir: string): string[] => ["setup.sh", "teardown.sh", "endpoints", "pids", ...Array.from({ length: MAX_ASKS }, (_, i) => askFile(String(i + 1)))].map((f) => join(dir, f));
const ESCAPE = `A script may exit ${NOT_RUN_HERE_EXIT} (cannot be run here) only after the commands that could run the ask were tried: it prints each command it tried and what that command printed, and when the environment card above names a location for a service the ask needs, that location is among them.`;
/** The prover's brief: the issue, the environment card, the fixed asks and the rules. Never the implementer's reply, plan or brief. Stage-own text, outside the cache-stable prefix. */
export function proverBrief(issue: string, asks: { id: string; text: string }[], dir: string, card: string, scriptS: number): string {
  return [
    "Loki 10 prove stage. You did not write the change in this working tree; another session did. Check, by running it, whether it does what the issue asks. Read the issue below and the code; no summary of the change is given and none should be trusted.",
    `The issue:\n${issue}`,
    ...(card ? [card] : []),
    `The asks are fixed. Do not add, drop, merge or reword them; write one script per ask, by its id:\n${asks.map((a) => `${a.id}. ${a.text}`).join("\n")}`,
    "Build an empty environment the way a new deployment of this repository would, by the repository's own setup path: any database or other dependency is a throwaway one inside $PROVE_TMP (a temporary directory outside the repository that the harness creates for each run and removes afterwards), the schema comes from the repository's own migration or build command, and where the repository creates records through its own service code (accounts, tenants, users), one is created that way.",
    "Ports: never use a fixed port number. Prefer a unix socket inside $PROVE_TMP where the tool allows it; otherwise use a TCP port you have checked is free at that moment. Call only processes this environment started. setup.sh writes every endpoint it opened to $PROVE_DIR/endpoints, one per line as `<name> <port>` or `<name> <socket path>`, and every process id it starts to $PROVE_DIR/pids, one per line, including a detached daemon's (read from its pid file). Every ask script reads its targets from $PROVE_DIR/endpoints and never hard-codes them.",
    `Write these files into ${dir} and nowhere else:`,
    [
      "- setup.sh: builds that environment and starts what the asks need; it exits non-zero when setup fails. A process it starts keeps running for the ask scripts.",
      "- teardown.sh: stops every process id in $PROVE_DIR/pids and removes what setup.sh created.",
      `- ask-<id>.sh for each ask: exits 0 only if that ask works for a user of the fresh environment. Call each entry point the way its real caller does: for anything a client uses, the exact path and method the client code sends; for a page or component, that a page the app routes to renders it and the requests it makes succeed; for a library or command-line tool, one real invocation. ${ESCAPE}`,
    ].join("\n"),
    `The harness runs setup.sh, then every ask script in id order, then teardown.sh, each with bash, from the repository root, which is also $PROVE_ROOT. Use paths relative to it and never an absolute path to this checkout: the same scripts also run on a checkout of the base commit, where an ask this change delivers should fail. Each script gets ${scriptS} seconds.`,
    "Rules: do not edit, add or delete any file tracked by git, or any file in the repository outside that directory. Do not fix the code; this stage only checks it. Never weaken a check to make it pass: a script that exits 0 without exercising its ask is wrong.",
    "Before you finish, run setup.sh and then every ask script yourself, with PROVE_ROOT, PROVE_TMP (a fresh temporary directory you make outside the repository) and PROVE_DIR set as the harness sets them, then teardown.sh, and leave nothing running. A script that fails because of the script itself is yours to fix: wrong quoting, a request body or header the real caller does not send, data left over from your own earlier run, a name or key that collides on a second run. Never change what a script checks to make it pass; a script that also passes on the base commit is not counted. Every ask script must be safe to run more than once against the same environment and against a new one. The harness then runs your final scripts in a clean environment of its own (a new temporary directory, and any database or service set up again inside it), so nothing your own runs left behind is there.",
    "Finish with exactly one line: LOKI_DONE.",
  ].join("\n\n");
}

/** The repair brief: one line per unproved ask with its command and the end of its output. Stage-own text, after the resumed session's own context. */
export function repairBrief(round: number, failing: ProveAsk[], dirRel: string): string {
  return [
    `Prove repair, round ${round}. A separate session that did not write your change wrote a script for each of the issue's asks that runs it against a fresh environment built by the repository's own setup path (${dirRel}: setup.sh, ask-<id>.sh, teardown.sh). The harness ran them, and these asks are not proved:`,
    failing.map((a) => `- ask ${a.id} (${a.text}): bash ${dirRel}/${askFile(a.id)}: ${a.reason}`).join("\n"),
    "Read each failing script and its output, find why the ask fails for a real user of the fresh environment, and fix the code. Do not edit the scripts and do not weaken any check. The harness runs the same scripts again when you finish.",
    ISSUE_FINISH_LINE, // an issue run's own finish rule (LOKI_UNFINISHED included), as its implement brief has
  ].join("\n\n");
}

// ---- machine facts, read with the platform's own tools (darwin: netstat, lsof, ps; linux: ss or netstat, /proc, ps) --------------------------------
const sh = (cmd: string[], timeoutMs = 3000): string | null => { try { const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin" } }); return r.exitCode === 0 || r.stdout.length ? r.stdout.toString() : null; } catch { return null; } };
const portOf = (addr: string): number | null => { const m = /[.:](\d+)$/.exec(addr); return m ? Number(m[1]) : null; };
/** TCP ports listening before setup: this user's listeners from lsof (macOS: `netstat` prints nothing when run from inside a Loki worker, measured
 *  2026-11-16, while lsof works), joined with every user's from `ss -Hltn` on linux or `netstat -an` where they answer. Null when no tool answers. */
export function listeningPorts(): Set<number> | null {
  const ports = new Set<number>(); let any = false;
  const l = sh(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"]); if (l !== null) { any = true; for (const x of l.split("\n")) if (x.startsWith("n")) { const p = portOf(x.slice(1)); if (p) ports.add(p); } }
  const ss = process.platform === "darwin" ? null : sh(["ss", "-Hltn"]); if (ss !== null) { any = true; for (const x of ss.split("\n")) { const p = portOf(x.trim().split(/\s+/)[3] ?? ""); if (p) ports.add(p); } }
  const ns = sh(process.platform === "darwin" ? ["netstat", "-an", "-p", "tcp"] : ["netstat", "-ltn"]); if (ns !== null && ns.trim()) { any = true; for (const x of ns.split("\n")) if (/LISTEN/.test(x)) { const p = portOf(x.trim().split(/\s+/)[3] ?? ""); if (p) ports.add(p); } }
  return any ? ports : null;
}
/** The process ids listening on a port that this user can see (lsof, else `ss -Hltnp`); null when neither tool runs. */
function listenerPids(port: number): number[] | null {
  const l = sh(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
  if (l !== null) return [...new Set(l.split("\n").filter((x) => /^p\d+$/.test(x)).map((x) => Number(x.slice(1))))];
  if (process.platform === "darwin") return null;
  const s = sh(["ss", "-Hltnp", `sport = :${port}`]); if (s === null) return null;
  return [...new Set([...s.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
}
/** The working directory and open files of a process (linux /proc, else lsof); [] when unreadable. */
function pathsOf(pid: number): string[] {
  if (existsSync(`/proc/${pid}`)) { const out: string[] = []; try { out.push(readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone */ } try { for (const fd of readdirSync(`/proc/${pid}/fd`)) { try { out.push(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { /* closed */ } } } catch { /* unreadable */ } return out; }
  const o = sh(["lsof", "-nP", "-a", "-p", String(pid), "-Fn"]); return o === null ? [] : o.split("\n").filter((x) => x.startsWith("n")).map((x) => x.slice(1));
}
const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
const under = (p: string, dir: string): boolean => { const r = real(p), d = real(dir); return r === d || r.startsWith(`${d}/`); };
export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
/** Started at or after `sinceMs` and owned by this user: the only recorded ids the harness ever signals. */
function startedSince(pid: number, sinceMs: number): boolean {
  const o = sh(["ps", "-o", "uid=,lstart=", "-p", String(pid)]); if (!o) return false;
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(o.trim()); if (!m || Number(m[1]) !== process.getuid?.()) return false;
  const t = Date.parse(m[2]!); return Number.isFinite(t) && t >= sinceMs - 1500; // lstart has one-second resolution
}
const readPids = (dir: string): number[] => { try { return [...new Set(readFileSync(join(dir, "pids"), "utf8").split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number).filter((n) => n > 1))]; } catch { return []; } };
/** The pass's leftovers for the record: each process the harness stopped after teardown, each id in prove/pids still alive that was not proven the pass's
 *  (left running, never signalled), and a directory kept because an owned process would not stop. */
function scratchLeftovers(cl: ScratchCleanup, dir: string): Leftover[] {
  const out: Leftover[] = cl.stopped.map((x) => ({ pid: x.pid, stopped: true, why: `left running after teardown (${x.why}): stopped by the harness` }));
  for (const pid of readPids(dir)) if (alive(pid) && !out.some((l) => l.pid === pid)) out.push({ pid, stopped: false, why: "listed in prove/pids, not proven the pass's: left running" });
  if (cl.kept) out.push({ pid: 0, stopped: false, why: cl.kept });
  return out;
}
/** One endpoint is the run's own when its port was not listening before setup and it is owned by record: a recorded id listens on it, or the listener's
 *  working directory or an open file is inside the run's temporary directory, and that listener started during this pass; a unix socket is ours when it
 *  is inside that directory. */
export function endpointOwned(target: string, before: Set<number> | null, tmp: string, recorded: number[], sinceMs: number): { ok: boolean; why: string } {
  if (target.startsWith("/")) return under(target, tmp) && existsSync(target) ? { ok: true, why: "unix socket inside the run's temporary directory" } : { ok: false, why: `${NOT_OURS} (socket outside the run's temporary directory)` };
  if (!/^\d{1,5}$/.test(target)) return { ok: false, why: `${NOT_OURS} (not a port or a socket path: ${clean(target, 60)})` };
  const port = Number(target);
  if (before === null) return { ok: false, why: `${NOT_OURS} (no tool could list the listening ports)` };
  if (before.has(port)) return { ok: false, why: `${NOT_OURS} (port ${port} was listening before setup)` };
  const pids = listenerPids(port);
  if (pids === null) return { ok: true, why: "not listening before setup (no tool to read the listener's process id)" }; // the lead's fallback where ownership cannot be read
  if (pids.length === 0) return { ok: false, why: `${NOT_OURS} (nothing this user owns listens on port ${port} after setup)` };
  const fresh = pids.filter((p) => startedSince(p, sinceMs)); // a listener that existed before this pass is never ours, whatever the record says
  if (fresh.length === 0) return { ok: false, why: `${NOT_OURS} (port ${port}: listener ${pids.join(",")} started before this pass)` };
  if (fresh.some((p) => recorded.includes(p))) return { ok: true, why: "a process proven the pass's listens on it" };
  if (fresh.some((p) => pathsOf(p).some((f) => under(f, tmp)))) return { ok: true, why: "its listener works inside the run's temporary directory" };
  return { ok: false, why: `${NOT_OURS} (port ${port}: listener ${pids.join(",")} is not recorded and works outside the run's temporary directory)` };
}

// One driver per pass, so a server setup.sh starts lives on for the ask scripts. After setup it waits for the harness's endpoint check ($OUT/go: run or
// skip). Each script's output goes to a file (never a pipe a leftover process could hold open). The per-script limit kills the script; whatever it left
// in the group is reaped when the harness kills the driver's group; a detached daemon is stopped by its recorded id.
const DRIVER = `set -u
MODE="$1"; OUT="$2"; LIM="$3"; DIR="$4"; shift 4
run_one() {
  name="$1"; s="$DIR/$1.sh"; rm -f "$OUT/$name.timeout"
  if [ ! -f "$s" ]; then printf 'missing\\n' > "$OUT/$name.exit"; return 0; fi
  bash "$s" > "$OUT/$name.log" 2>&1 < /dev/null &
  pid=$!
  ( sleep "$LIM"; printf 'timeout\\n' > "$OUT/$name.timeout"; kill -KILL "$pid" 2>/dev/null ) > /dev/null 2>&1 < /dev/null &
  w=$!
  wait "$pid"; rc=$?
  kill -KILL "$w" 2>/dev/null; wait "$w" 2>/dev/null
  if [ -f "$OUT/$name.timeout" ]; then printf 'timeout\\n' > "$OUT/$name.exit"; else printf '%s\\n' "$rc" > "$OUT/$name.exit"; fi
}
if [ "$MODE" = teardown ]; then run_one teardown; exit 0; fi
run_one setup
if [ "$(cat "$OUT/setup.exit")" = 0 ]; then
  n=0; while [ ! -f "$OUT/go" ] && [ "$n" -lt 600 ]; do sleep 0.1; n=$((n + 1)); done
  if [ "$(cat "$OUT/go" 2>/dev/null)" = run ]; then for a in "$@"; do run_one "$a"; done; fi
fi
run_one teardown
printf 'done\\n' > "$OUT/driver.done"
`;
interface LivePass { pgid: number; dir: string; root: string; tmp: string; out: string; env: Record<string, string>; since: number; scratch: SessionScratch }
const LIVE = new Set<LivePass>();
/** Worker cancel (SIGINT/SIGTERM): every live pass gets its teardown, its group killed and its recorded ids stopped, before the worker exits. Never throws. */
export function cancelProve(): void {
  for (const p of [...LIVE]) {
    try { Bun.spawnSync(["bash", "-c", DRIVER, "loki-prove-driver", "teardown", p.out, "10", p.dir], { cwd: p.root, env: p.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 15_000 }); } catch { /* best effort */ }
    killGroup(p.pgid, "SIGKILL");
    try { cleanupSessionScratch(p.scratch, { termWaitMs: 1500 }); } catch { /* best effort */ } // proven ownership, never the pids file (runner/worker_proc.ts)
    LIVE.delete(p);
  }
}
const tailOf = (p: string): string => { try { return clean(readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ")); } catch { return ""; } };
const outcomeOf = (out: string, name: string): ScriptOutcome => {
  let raw: string | null = null; try { raw = readFileSync(join(out, `${name}.exit`), "utf8").trim(); } catch { /* the pass never reached it */ }
  const exit: ScriptOutcome["exit"] = raw === null ? "not run" : raw === "timeout" || raw === "missing" ? raw : /^\d+$/.test(raw) ? Number(raw) : "not run";
  return { exit, tail: tailOf(join(out, `${name}.log`)) };
};
export interface PassResult { setup: ScriptOutcome; asks: Record<string, ScriptOutcome>; teardown: ScriptOutcome; cut: boolean; endpoints: { name: string; target: string; ok: boolean; why: string }[]; skipped: string | null; leftovers: Leftover[] }
/** One pass on `root`: setup, the endpoint check, each ask, teardown (again on its own when the pass was cut before it), then the recorded ids and the
 *  files still held under $PROVE_TMP. The driver runs in its own process group (runner/worker_proc.ts killGroup on the limit, on abort and always at the
 *  end, the group kill util/shell.ts run() uses) with the token-free env verify's checks get (util/check_result.ts plainTestEnv). */
export async function runPass(root: string, dir: string, out: string, ids: string[], signal: AbortSignal, o: { scriptS?: number; passS?: number; teardownS?: number; pathAppend?: string[] } = {}): Promise<PassResult> {
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  for (const f of ["endpoints", "pids"]) rmSync(join(dir, f), { force: true });
  const scratch = createSessionScratch(join(dir, "..")), tmp = scratch.dir, since = Date.now(), // a harness scratch: short path, marker, the pass's nonce in every script's environment, recorded in the run dir
    scriptS = o.scriptS ?? scriptLimitS(), passS = o.passS ?? 480, teardownS = o.teardownS ?? TEARDOWN_S;
  const base = plainTestEnv(), env = { ...base, ...(o.pathAppend?.length ? { PATH: [...(base["PATH"] ?? "").split(":").filter(Boolean), ...o.pathAppend].join(":") } : {}), ...scratchSessionEnv(scratch), PROVE_ROOT: root, PROVE_TMP: tmp, PROVE_DIR: dir }; // the env card's directories, appended as the implement session had them
  const before = listeningPorts();
  const proc = Bun.spawn(withScratchMarker(scratch, ["bash", "-c", DRIVER, "loki-prove-driver", "pass", out, String(scriptS), dir, ...ids.map((id) => `ask-${id}`)]), { cwd: root, env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }); // #713: the pass's marker (runner/worker_proc.ts)
  const live: LivePass = { pgid: proc.pid, dir, root, tmp, out, env, since, scratch }; LIVE.add(live);
  let cut = false, endpoints: PassResult["endpoints"] = [], skipped: string | null = null, done = false;
  const stop = (): void => { cut = true; killGroup(proc.pid, "SIGKILL"); };
  const timer = setTimeout(stop, Math.min(MAX_TIMER_MS, Math.max(1, passS) * 1000)); // a pass with no limit (Infinity) waits the longest a timer can (Bun fires a longer delay at once)
  if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  void proc.exited.then(() => { done = true; });
  try {
    while (!done && !cut && !existsSync(join(out, "setup.exit"))) await Bun.sleep(100);
    if (!done && !cut && outcomeOf(out, "setup").exit === 0) {
      const recorded = ownedProcesses(scratch).map((x) => x.pid); // proven by the harness (nonce, directory, command line, parent), never the pids file
      try { for (const line of readFileSync(join(dir, "endpoints"), "utf8").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20)) { const [name = "", ...rest] = line.split(/\s+/); const target = rest.join(" "); endpoints.push({ name: clean(name, 40), target: clean(target, 200), ...endpointOwned(target, before, tmp, recorded, since) }); } } catch { /* no endpoints file: nothing to check */ }
      const bad = endpoints.filter((e) => !e.ok);
      skipped = bad.length ? bad.map((e) => `${e.name} ${e.target}: ${e.why}`).join("; ") : null;
      writeFileSync(join(out, "go"), skipped ? "skip\n" : "run\n");
    }
    await proc.exited;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); killGroup(proc.pid, "SIGKILL"); }
  if (!existsSync(join(out, "driver.done")) && !existsSync(join(out, "teardown.exit"))) { // teardown always runs, even after a cut or an abort
    const t = Bun.spawn(withScratchMarker(scratch, ["bash", "-c", DRIVER, "loki-prove-driver", "teardown", out, String(teardownS), dir]), { cwd: root, env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    const tt = setTimeout(() => killGroup(t.pid, "SIGKILL"), (teardownS + 5) * 1000);
    try { await t.exited; } finally { clearTimeout(tt); killGroup(t.pid, "SIGKILL"); }
  }
  // After teardown: what the pass started is stopped by proven ownership (the nonce in its environment, its directory or a command-line path in $PROVE_TMP, or an
  // owned parent; runner/worker_proc.ts), and $PROVE_TMP is removed only once nothing owned is alive. A pid in prove/pids that is not provably the pass's is
  // reported, never signalled.
  const cl = cleanupSessionScratch(scratch, { termWaitMs: 2000 }), leftovers = scratchLeftovers(cl, dir);
  LIVE.delete(live);
  const asks: Record<string, ScriptOutcome> = {};
  for (const id of ids) asks[id] = skipped ? { exit: "skipped", tail: "" } : outcomeOf(out, `ask-${id}`);
  return { setup: outcomeOf(out, "setup"), asks, teardown: outcomeOf(out, "teardown"), cut, endpoints, skipped, leftovers };
}
/** How one ask reads on head after a pass. */
export function headVerdict(p: PassResult, id: string, scriptS = scriptLimitS()): { result: AskResult; reason: string } {
  const s = p.setup, h = p.asks[id] ?? { exit: "not run", tail: "" }, last = h.tail.split(" | ").pop() ?? "";
  if (s.exit !== 0) return { result: "not proved", reason: `environment could not be built: setup failed (${s.exit === "timeout" ? `timed out after ${scriptS}s` : s.exit === "missing" ? "setup.sh missing" : `exit ${s.exit}`})${s.tail ? `: ${s.tail}` : ""}` };
  if (h.exit === "skipped") return { result: "not proved", reason: p.skipped ?? NOT_OURS };
  if (h.exit === 0) return { result: "proved", reason: "exit 0" };
  if (h.exit === NOT_RUN_HERE_EXIT) return { result: "not run here", reason: last || "no reason printed" };
  if (h.exit === "timeout") return { result: "not proved", reason: `timed out after ${scriptS}s${last ? `: ${last}` : ""}` };
  if (h.exit === "missing") return { result: "not proved", reason: `script ${askFile(id)} missing` };
  if (h.exit === "not run") return { result: "not proved", reason: "not run: the pass stopped at its time limit" };
  return { result: "not proved", reason: `exit ${h.exit}${last ? `: ${last}` : ""}` };
}
const cmdLineOf = (p: string): string => { try { return clean(readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !/^set\s+-/.test(l)).pop() ?? "", 120); } catch { return ""; } };
/** Puts back any tree change made since `pre` (the review-turn guard's restore path); returns the paths put back. */
function guardTree(repoDir: string, baseSha: string, pre: ReturnType<typeof snapshotDiff>): string[] {
  try { const paths = turnChangedPaths(pre, snapshotDiff(repoDir, baseSha)); if (paths.length) restoreTurnPaths(repoDir, baseSha, pre, paths); return paths; } catch { return []; }
}
/** The issue text the asks must come from: issue.json's title and body, else the intake task. */
export function issueText(runDir: string, task: string): string {
  try { const j = JSON.parse(readFileSync(join(runDir, "issue.json"), "utf8")) as { title?: unknown; body?: unknown }; if (typeof j.body === "string" || typeof j.title === "string") return `${typeof j.title === "string" ? j.title : ""}\n\n${typeof j.body === "string" ? j.body : ""}`.trim(); } catch { /* a run with no issue.json */ }
  return task;
}

export interface ProveCtx extends RunContext { proveBudgetS?: number }
export const proveStage: Stage = {
  name: "prove",
  ...STAGE_BUDGETS.prove,
  async run(ctx: ProveCtx, signal: AbortSignal): Promise<StageResult> {
    const o = ctx.outputs(), t0 = ctx.clock.now(), budgetS = ctx.proveBudgetS ?? proveBudgetS(), scriptS = scriptLimitS();
    const deadline = t0 + Math.max(0, budgetS - TEARDOWN_S - MARGIN_S) * 1000, leftS = (): number => (deadline - ctx.clock.now()) / 1000;
    const dir = join(ctx.runDir, PROVE_DIR), dirRel = relative(ctx.repoDir, dir), rec: ProveRecord = { ...proveNotRun("not_run", ""), status: "ran", dir: dirRel };
    delete rec.reason;
    const issue = issueText(ctx.runDir, String(o.intake?.task ?? "")), card = readEnvCardFile(ctx.runDir), pathAppend = card?.path_appended ?? []; // util/stack_tools.ts envCard, written before implement
    const finish = (): StageResult => { rec.wall_s = Math.round((ctx.clock.now() - t0) / 100) / 10; rec.tree_fp = treeFingerprint(ctx.repoDir, ctx.baseSha); ctx.emit("prove.completed", "prove", { asks: rec.asks.length, proved: rec.asks.filter((a) => a.result === "proved").length, base: rec.base, wall_s: rec.wall_s }); return { status: "completed", data: rec as unknown as Obj }; };
    // A resumed run whose prover already finished reuses its fixed list and scripts (prover.done, written only after the session returned).
    let fixed: { id: string; text: string }[] | null = null;
    try { const d = JSON.parse(readFileSync(join(dir, "prover.done"), "utf8")) as { asks?: { id: string; text: string }[] }; if (Array.isArray(d.asks) && d.asks.length) { fixed = d.asks; rec.reused = true; } } catch { /* a first run */ }
    ctx.emit("prove.started", "prove", { dir: dirRel, budget_s: budgetS, reused: fixed !== null });
    if (!fixed) {
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      // 1. The listing: a short session that sees the issue only; every ask must be a verbatim line of the issue, one retry naming the failures.
      let accepted: string[] | null = null, rejected: string[] = [];
      for (let attempt = 1; attempt <= 2 && !signal.aborted && accepted === null; attempt++) {
        const out = join(dir, `asks-list-${attempt}.json`), cwd = mkdtempSync(join(tmpdir(), "loki-prove-list-")), id = `${ctx.runId}-prove-ls${attempt}`; rec.iteration_ids.push(id);
        try { await ctx.sessions.run({ stage: "prove", brief: listBrief(issue, out, rejected), tier: "development", iterationId: id, limitS: LIST_S, ...(proveListTurns() ? { maxTurns: proveListTurns() } : {}), signal, cwd, outputs: [out] }); } finally { rmSync(cwd, { recursive: true, force: true }); }
        let raw: string | null = null; try { raw = readFileSync(out, "utf8"); } catch { /* nothing written */ }
        const c = checkAsks(raw, issue);
        if (!c.error && c.bad.length === 0) accepted = c.asks; else rejected = c.bad.length ? c.bad : [c.error ?? "no list"];
      }
      if (accepted === null) { rec.notes.push("not proved: asks could not be listed"); return finish(); }
      if (accepted.length > MAX_ASKS) rec.notes.push(`not proved: more than ${MAX_ASKS} asks (${accepted.length} listed; the first ${MAX_ASKS} were run): ${clean(accepted.slice(MAX_ASKS).join(" | "), 300)}`);
      fixed = accepted.slice(0, MAX_ASKS).map((text, i) => ({ id: String(i + 1), text }));
      writeFileSync(join(dir, "asks.json"), JSON.stringify(fixed, null, 2) + "\n");
      // 2. The prover: a fresh session on the session model; the issue, the card, the fixed asks and the tree; never the implementer's reply.
      const pre = snapshotDiff(ctx.repoDir, ctx.baseSha), proverId = `${ctx.runId}-prove`; rec.iteration_ids.push(proverId);
      const proverS = Math.max(60, Math.min(PROVER_MAX_S, Math.floor(budgetS * 0.5)));
      const proverScratch = createSessionScratch(ctx.runDir); // the prover runs its own scripts: its TMPDIR is a harness scratch, cleaned after the session
      const ps = await ctx.sessions.run({ stage: "prove", brief: proverBrief(issue, fixed, dir, card?.line ?? "", scriptS), tier: "development", iterationId: proverId, limitS: proverS, signal, cwd: ctx.repoDir, outputs: proverOutputs(dir), ...(pathAppend.length ? { pathAppend } : {}), sessionEnv: scratchSessionEnv(proverScratch) });
      { const c = cleanupSessionScratch(proverScratch); if (c.stopped.length) rec.notes.push(`prove: the prover's own runs left ${c.stopped.length} process(es) running; stopped by the harness: ${clean(c.stopped.map((x) => `${x.pid} (${x.why})`).join(", "), 200)}`); if (c.kept) rec.notes.push(`prove: ${c.kept}`); } // its self-run (setup, asks, teardown) may leave services behind; proven ownership, as for implement
      const put = guardTree(ctx.repoDir, ctx.baseSha, pre); rec.tree_restored.push(...put);
      const edited = put.filter((f) => existsSync(join(ctx.repoDir, f))), added = put.filter((f) => !edited.includes(f)); // after the put-back an edited or deleted file is there again; a file the prover's own run created is gone
      if (edited.length) rec.notes.push(`not proved: the prover changed ${edited.length} file(s) in the tree (put back): ${clean(edited.join(", "), 200)}`);
      if (added.length) rec.notes.push(`prove: the prover's own run left ${added.length} new file(s) in the tree; they were removed: ${clean(added.join(", "), 200)}`);
      if (ps.killed && !existsSync(join(dir, "setup.sh"))) rec.notes.push(`not proved: the prover session was stopped at its limit (${proverS}s) before it wrote setup.sh`);
      if (!signal.aborted) writeFileSync(join(dir, "prover.done"), JSON.stringify({ asks: fixed }) + "\n");
    }
    const ids = fixed.map((a) => a.id);
    rec.asks = fixed.map((a) => ({ id: a.id, text: a.text, command: `bash ${dirRel}/${askFile(a.id)}`, cmd_line: cmdLineOf(join(dir, askFile(a.id))), head: { exit: "not run", tail: "" }, base: "base not run", result: "not proved", reason: "not run: no stage time was left" }));
    // 3. The harness runs the scripts on head; the tree is put back if they touched it.
    if (leftS() < 30 || signal.aborted) { rec.notes.push("not proved: no stage time was left to run the scripts"); return finish(); }
    const headPass = async (round: number, iterationId?: string): Promise<void> => {
      const before = snapshotDiff(ctx.repoDir, ctx.baseSha);
      const p = await runPass(ctx.repoDir, dir, join(dir, `run-${round}`), ids, signal, { scriptS, passS: Math.max(1, Math.floor(leftS())), pathAppend });
      const back = guardTree(ctx.repoDir, ctx.baseSha, before); rec.tree_restored.push(...back);
      if (back.length) rec.notes.push(`prove: the scripts changed ${back.length} file(s) in the tree; they were put back: ${clean(back.join(", "), 200)}`);
      rec.setup = p.setup; rec.endpoints = p.endpoints; rec.leftovers.push(...p.leftovers);
      for (const a of rec.asks) { const v = headVerdict(p, a.id, scriptS); a.head = p.asks[a.id]!; a.result = v.result; a.reason = v.reason; ctx.emit("prove.ask", "prove", { round, id: a.id, text: a.text, exit: a.head.exit, result: a.result }); }
      rec.rounds.push({ round, ...(iterationId ? { iteration_id: iterationId } : {}), failing: rec.asks.filter((a) => a.result !== "proved").map((a) => a.id) });
    };
    await headPass(0);
    // Repair (LOKI_E10_PROVE_REPAIR): unproved asks go back to the implement session by same-session resume (util/conflict_resume.ts resumeForProve over
    // resumeWith, the mechanism session continue uses), inside the implement time left; then the same scripts run again. An ask its endpoint check skipped
    // or that cannot run here is not the implementer's to fix and is not sent.
    const repairable = (): ProveAsk[] => rec.asks.filter((a) => a.result === "not proved" && a.head.exit !== "skipped");
    if (proveRepairOn() && repairable().length) {
      const impl = o.implement ?? {}, implIds = Array.isArray(impl.iteration_ids) ? (impl.iteration_ids as unknown[]).map(String) : [];
      const { savedImplementBrief, restoreReadOnly } = await import("./implement.ts");
      const readOnly = (o.wall?.readOnlyFiles as { path: string; content: string }[] | undefined) ?? [];
      let first: SessionRunOptions | null = implIds.length ? { stage: "implement", brief: savedImplementBrief(ctx) ?? "", tier: "development", iterationId: implIds[implIds.length - 1]!, limitS: STAGE_BUDGETS.implement.limitS, signal, cwd: ctx.repoDir, ...(typeof impl.model === "string" && impl.model !== ctx.model ? { model: impl.model } : {}), ...(pathAppend.length ? { pathAppend } : {}) } : null;
      const done: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };
      for (let round = 1; first && round <= MAX_REPAIR_ROUNDS && repairable().length && !signal.aborted; round++) {
        if (leftS() < 90) { rec.notes.push(`prove: repair round ${round} not started (too little stage time left)`); break; }
        const repScratch = createSessionScratch(ctx.runDir);
        const r = await resumeForProve(ctx, { ...first, sessionEnv: scratchSessionEnv(repScratch) }, done, repairBrief(round, repairable(), dirRel), `-pv${round}`);
        { const c = cleanupSessionScratch(repScratch); if (c.stopped.length) rec.notes.push(`prove: repair round ${round} left ${c.stopped.length} process(es) running; stopped by the harness`); }
        if (!r) { rec.notes.push(`prove: repair round ${round} not started (too little implement time left)`); break; }
        rec.iteration_ids.push(r.iterationId); first = { ...first, iterationId: r.iterationId };
        restoreReadOnly(readOnly); // a resume started here skips implement's own restore of the sealed Wall files
        if (leftS() < 30) { rec.rounds.push({ round, iteration_id: r.iterationId, failing: repairable().map((a) => a.id) }); rec.notes.push(`not proved: no stage time was left to run the scripts again after repair round ${round}`); break; }
        await headPass(round, r.iterationId);
      }
    }
    // 4. The base commit, last and only with time left: an ask that also passes there is not evidence of this change.
    const onHead = rec.asks.filter((a) => a.result === "proved").map((a) => a.id);
    if (!onHead.length) rec.base = "base not run: no ask passed on head";
    else if (leftS() < 30 || signal.aborted) rec.base = "base not run: not enough stage time left";
    else {
      const { freshBaseCheckout } = await import("../machine.ts"), bdir = freshBaseCheckout(ctx.repoDir, ctx.baseSha);
      if (!bdir) rec.base = "base not run: no checkout of the base commit could be made";
      else try {
        const b = await runPass(bdir, dir, join(dir, "run-base"), onHead, signal, { scriptS, passS: Math.max(1, Math.floor(leftS())), pathAppend });
        rec.leftovers.push(...b.leftovers);
        rec.base = b.setup.exit !== 0 ? `base not run: setup failed on base (${b.setup.exit})` : b.skipped ? `base not run: ${b.skipped}` : "run";
        if (rec.base === "run") for (const id of onHead) { const a = rec.asks.find((x) => x.id === id)!; a.base = b.asks[id]!; if (a.base.exit === 0) { a.result = "not proved"; a.reason = ALSO_ON_BASE; } }
      } finally { rmSync(bdir, { recursive: true, force: true }); try { safeGit(ctx.repoDir, ["worktree", "prune"]); } catch { /* best effort */ } }
    }
    for (const l of rec.leftovers) rec.notes.push(`prove: process ${l.pid} ${l.why}${l.stopped ? "" : " (still alive)"}`);
    return finish();
  },
};
export const stage = proveStage;

/** After the verify loop: a fix round, a rule completion or another attempt changed the tree the scripts last ran on. Rerun them on head (no model);
 *  with no time to do so, a note keeps the label below VERIFIED. */
export async function recheckProve(ctx: RunContext, rec: ProveRecord, leftS: number, signal: AbortSignal): Promise<ProveRecord> {
  if (rec.status !== "ran" || rec.asks.length === 0) return rec;
  const fp = treeFingerprint(ctx.repoDir, ctx.baseSha);
  if (fp !== null && fp === rec.tree_fp) return rec;
  if (leftS < 30 || signal.aborted) return { ...rec, notes: [...rec.notes, "not proved: the tree changed after the prove scripts ran (a fix round) and there was no time to run them again"] };
  const dir = join(ctx.repoDir, rec.dir), ids = rec.asks.map((a) => a.id), before = snapshotDiff(ctx.repoDir, ctx.baseSha), round = rec.rounds.length;
  const p = await runPass(ctx.repoDir, dir, join(dir, `run-${round}`), ids, signal, { passS: Math.max(1, Math.floor(leftS)), pathAppend: readEnvCardFile(ctx.runDir)?.path_appended ?? [] });
  const back = guardTree(ctx.repoDir, ctx.baseSha, before);
  const asks = rec.asks.map((a) => { const v = headVerdict(p, a.id), onBase = a.reason === ALSO_ON_BASE && v.result === "proved"; const n: ProveAsk = { ...a, head: p.asks[a.id]!, result: onBase ? "not proved" : v.result, reason: onBase ? ALSO_ON_BASE : v.reason }; ctx.emit("prove.ask", "prove", { round, id: a.id, text: a.text, exit: n.head.exit, result: n.result, recheck: true }); return n; });
  return { ...rec, asks, setup: p.setup, endpoints: p.endpoints, leftovers: [...rec.leftovers, ...p.leftovers], rounds: [...rec.rounds, { round, failing: asks.filter((a) => a.result !== "proved").map((a) => a.id) }], tree_fp: treeFingerprint(ctx.repoDir, ctx.baseSha), tree_restored: [...rec.tree_restored, ...back], notes: back.length ? [...rec.notes, `prove: the scripts changed ${back.length} file(s) in the tree; they were put back: ${clean(back.join(", "), 200)}`] : rec.notes };
}

/** Seal's open notes: one line per unproved ask. Only ever lowers a label; empty outside the stage's scope. A "not run here" line names any service the
 *  environment card lists as not found. */
export function proveNotes(provider: string, o: Partial<Record<string, Obj>>, env: NodeJS.ProcessEnv = process.env, runDir?: string): string[] {
  if (!proveApplies(provider, o, env)) return [];
  const r = o.prove as ProveRecord | undefined;
  if (!r || !Array.isArray(r.asks)) return ["not proved: the prove stage did not run to the end"];
  if (r.status !== "ran") return [`not proved: the prove stage ${r.status === "killed" ? "was stopped" : "did not run"}: ${clean(r.reason ?? "no reason recorded")}`];
  const missing = runDir ? missingServices(readEnvCardFile(runDir)) : [];
  const lines = r.asks.filter((a) => a.result !== "proved").map((a) => `not proved: ${a.text}: ${a.result === "not run here" ? `not run here: ${a.reason}${missing.length ? `; not found on this machine (environment card): ${missing.join(", ")}` : ""}` : a.reason}`);
  return [...lines, ...r.notes.filter((n) => n.startsWith("not proved:"))].map((l) => clean(l, 400));
}
/** Disclosures that never cap (the tree put back after the scripts, a leftover process). */
export const proveDisclosures = (o: Partial<Record<string, Obj>>): string[] => ((o.prove as ProveRecord | undefined)?.notes ?? []).filter((n) => !n.startsWith("not proved:")).map((n) => clean(n, 400));
/** The receipt's prove record, written only when the stage left one. */
export function proveReceiptBlock(o: Partial<Record<string, Obj>>): { prove?: Record<string, unknown> } {
  const r = o.prove as ProveRecord | undefined;
  if (!r || !Array.isArray(r.asks)) return {};
  return { prove: { status: r.status, ...(r.reason ? { reason: r.reason } : {}), dir: r.dir, asks: r.asks.map((a) => ({ id: a.id, text: a.text, command: a.command, cmd_line: a.cmd_line, head: a.head, base: a.base, result: a.result, reason: a.reason })), ...(r.setup ? { setup: r.setup } : {}), ...(r.endpoints?.length ? { endpoints: r.endpoints } : {}), base: r.base, rounds: r.rounds, ...(r.leftovers?.length ? { leftovers: r.leftovers } : {}), wall_s: r.wall_s ?? 0, ...(r.reused ? { reused: true } : {}) } };
}
/** The PR body's table (ask, command, result), from the sealed receipt's prove record. The ask column is the fixed, verbatim list. */
export function proveTable(prove: unknown): string[] {
  const p = prove as { asks?: { id?: unknown; text?: unknown; command?: unknown; cmd_line?: unknown; result?: unknown; reason?: unknown }[] } | null | undefined;
  if (!p || !Array.isArray(p.asks) || p.asks.length === 0) return [];
  const cell = (x: unknown, n: number): string => clean(String(x ?? ""), n).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  return ["| Ask | Command | Result |", "|---|---|---|", ...p.asks.map((a) => `| ${cell(a.text, 160)} | \`${cell(a.cmd_line || a.command, 100)}\` | ${cell(a.result, 20)}${a.result === "proved" ? "" : `: ${cell(a.reason, 120)}`} |`), ""];
}

// ---- THIN-WRAP (#712): the independent proof session of the implement stage's thin route --------------------------------------------------------------
// A fresh session that never saw the author's reply writes the same loki-proof.sh contract the author used to write, so Loki's own re-run, the base
// comparison, the without-change run and the receipt read it unchanged. It may not change the repository: every path it changed is put back and listed.
// The prove stage above (LOKI_E10_PROVE) is a different session and stays off.
export const PROOF_AUTHOR_ROLE = "You did not write this change. Write the checks that decide whether it does what the issue asks.";
export const PROOF_AUTHOR_RULES = "Take what each check expects from the issue's line and from the code that calls the product, never from what the changed code currently returns. Do not change, add or delete any file in the repository: Loki restores every such change and reports it. Run your script until every failure left is a fault of the product, not of the script. End with one line per such failure: PRODUCT FAILS <item number>: <the command or request> | <what it returned> | <what the issue line requires>. Then finish with LOKI_DONE.";
export const PROOF_AUTHOR_CHANGE_RULE = "Change a check only when it is wrong against the issue's line or no longer reaches the product after this change; never to make it pass.";
export const PROOF_AUTHOR_AGAIN_LEAD = "Loki ran your script again by itself. What changed since, and what it found:";
/** The prover's brief. The first round quotes the issue exactly as the implement brief quotes it; a later round (a resume of the same session) carries what
 *  changed since (`extra`) and the rule for changing a check. Never the author's reply: the caller passes none. */
export function proofAuthorBrief(issueText: string, cardLine: string | null, knownText: string | null, firstRound: boolean, extra: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!firstRound) return [PROOF_AUTHOR_AGAIN_LEAD, extra, PROOF_AUTHOR_CHANGE_RULE, PROOF_AUTHOR_RULES].filter(Boolean).join("\n\n");
  return [PROOF_AUTHOR_ROLE, taskBlock(issueText).join("\n\n"), PROOF_SCRIPT_LINE, ...(repoCardOn(env) ? [SETUP_FIRST_LINE] : []), OLD_RECORD_PROOF_LINE, PROVES_NOTHING_FIX, cardLine ?? "", knownText ?? "", PROOF_AUTHOR_RULES, extra].filter(Boolean).join("\n\n");
}
export interface ProofAuthorOpts {
  issue: string; cardLine: string | null; knownText: string | null; extra: string;
  scratch: SessionScratch; model?: string; pathAppend?: string[]; limitS: number; signal: AbortSignal;
  prior?: { opts: SessionRunOptions; session: SessionResult }; // a later round: one resume of this same prover session, never a new one
}
export interface ProofAuthorRun { iterationId: string; ran: boolean; script: boolean; restored: string[]; created: string[]; seconds: number; opts: SessionRunOptions; session: SessionResult }
/** The paths changed since `pre`, put back: `restored` were edited or deleted (they are there again), `created` were new (they are removed). */
export function putBackTree(repoDir: string, baseSha: string, pre: ReturnType<typeof snapshotDiff>): { restored: string[]; created: string[] } {
  try {
    const paths = turnChangedPaths(pre, snapshotDiff(repoDir, baseSha)); if (paths.length) restoreTurnPaths(repoDir, baseSha, pre, paths);
    const restored = paths.filter((p) => existsSync(join(repoDir, p))); return { restored, created: paths.filter((p) => !restored.includes(p)) };
  } catch { return { restored: [], created: [] }; }
}
const scriptLeft = (dir: string): boolean => { try { const st = statSync(join(dir, PROOF_SCRIPT)); return st.isFile() && st.size > 0; } catch { return false; } };
/** One prover round: a fresh session (`${runId}-prv`, stage "prove") in the repository with the author's scratch as LOKI_SCRATCH and TMPDIR, or, with
 *  o.prior, one resume of that session. Afterwards every repository path it changed is put back. `script`: the scratch holds a non-empty loki-proof.sh. */
export async function runProofAuthor(ctx: RunContext, o: ProofAuthorOpts): Promise<ProofAuthorRun> {
  const t0 = Date.now(), pre = snapshotDiff(ctx.repoDir, ctx.baseSha), brief = proofAuthorBrief(o.issue, o.cardLine, o.knownText, !o.prior, o.extra);
  let opts: SessionRunOptions, session: SessionResult, iterationId: string, ran = true;
  if (o.prior) {
    opts = o.prior.opts;
    const r = o.signal.aborted ? null : await resumeForProve(ctx, o.prior.opts, o.prior.session, brief, "-r");
    if (r) { iterationId = r.iterationId; session = r.reply; } else { ran = false; iterationId = o.prior.opts.iterationId; session = o.prior.session; }
  } else {
    opts = { stage: "prove", brief, tier: "development", iterationId: `${ctx.runId}-prv`, limitS: o.limitS, signal: o.signal, cwd: ctx.repoDir, ...(o.model ? { model: o.model } : {}), ...(o.pathAppend?.length ? { pathAppend: o.pathAppend } : {}), sessionEnv: scratchSessionEnv(o.scratch) };
    iterationId = opts.iterationId; session = await ctx.sessions.run(opts);
  }
  const back = putBackTree(ctx.repoDir, ctx.baseSha, pre);
  return { iterationId, ran, script: scriptLeft(o.scratch.dir), ...back, seconds: Math.round((Date.now() - t0) / 100) / 10, opts, session };
}
