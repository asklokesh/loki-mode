// loki-ts/src/project_model/install.ts -- FC-22b: the install pre-step library (wiring is S4, not here).
// Evidence-triggered: a package is installed only when a selected check in it came back as a harness-owned load error (FC-02).
// Once per package per run (memo), timeout min(300s, cap left), recorded as check `install:<root>`. A failed install is
// not_run owned by the harness, never fail. No install command: nothing runs, NOT PROVEN names the package (never guess).
// Opt-out: LOKI_E10_INSTALL=0 or loki.yaml `verify.install_deps: false`.
// L2 classification (docs/v10/ENGINE-LAWS.md L2): TRUST path, registered in tests/engine10/l2_destructive_registry.test.ts.
// guardTree is the only destructive call: it restores a tracked file (literal pathspec) only when the file was clean before the
// install and the install changed it, and counts it restored only if a re-snapshot shows it clean. A file that was already dirty
// (the agent's work) is never touched, only listed. If a snapshot fails the guard did not run and NOT PROVEN says so.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { yamlKey } from "../util/yaml_key.ts";
import type { ProjectApi } from "./api.ts";

export const INSTALL_CAP_MS = 300_000;
const memo = new Set<string>(); // `${runId}\0${root}`: once per package per run, across fix rounds

export interface FailedCheck { root: string; harnessOwned: boolean }
export interface InstallCheck {
  name: string; // install:<root>
  cmd: string;
  cwd: string; // repo-relative
  result: "pass" | "not_run";
  duration_s: number;
  reason?: string;
  owner?: "harness";
}
export interface PrepareInput {
  repoDir: string;
  model: ProjectApi | null | undefined;
  failed: FailedCheck[];
  signal: AbortSignal;
  timeoutMs: number; // the cap left; the install gets min(300s, this)
  env?: Record<string, string | undefined> | undefined;
  opts: { runId: string };
}
export interface PrepareResult {
  checks: InstallCheck[];
  notProven: string[];
  restored: string[]; // tracked files the install changed and the guard restored
  unrestored: string[]; // tracked files the install changed that were already dirty before (left alone)
  untracked: string[]; // new untracked files outside ignored-style dirs
  skipped: "opt-out" | null;
}
const TAIL_BYTES = 65_536;
const STATUS_MAX_BUFFER = 64 * 1024 * 1024;

/** Test hook: forget the once-per-run memo. */
export function resetInstallMemo(): void { memo.clear(); }

const mergedEnv = (e?: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries({ ...process.env, ...(e ?? {}) }).filter((kv): kv is [string, string] => typeof kv[1] === "string"));

function optedOut(repoDir: string, env: Record<string, string>): boolean {
  if (env["LOKI_E10_INSTALL"] === "0") return true;
  try {
    const f = join(repoDir, "loki.yaml");
    return existsSync(f) && yamlKey(readFileSync(f, "utf8"), "verify", "install_deps")?.toLowerCase() === "false";
  } catch { return false; }
}

const git = (repoDir: string, env: Record<string, string>, args: string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: repoDir, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: STATUS_MAX_BUFFER });

/** Content identity of a path without following links or opening anything that is not a regular file. */
function fingerprint(repoDir: string, path: string): string {
  try {
    const st = lstatSync(join(repoDir, path));
    if (st.isFile()) return createHash("sha1").update(readFileSync(join(repoDir, path))).digest("hex");
    if (st.isSymbolicLink()) return `link:${readlinkSync(join(repoDir, path))}`;
    return st.isDirectory() ? "dir" : "other";
  } catch { return "absent"; }
}

interface Snap { status: Map<string, string>; hash: Map<string, string> }
function snapshot(repoDir: string, env: Record<string, string>): Snap | null {
  try {
    const status = new Map<string, string>(), hash = new Map<string, string>();
    const parts = git(repoDir, env, ["status", "--porcelain", "-z"]).split("\0");
    for (let k = 0; k < parts.length; k++) {
      const e = parts[k]!;
      if (e.length < 4) continue;
      const xy = e.slice(0, 2), path = e.slice(3);
      if (/[RC]/.test(xy)) k++; // a rename or copy carries its source as the next field
      status.set(path, xy);
      if (!path.endsWith("/")) hash.set(path, fingerprint(repoDir, path)); // a collapsed untracked directory is not hashed
    }
    return { status, hash };
  } catch { return null; }
}

/** Restores tracked files the install changed (clean before, dirty after); anything already dirty or untracked before is only
 *  listed. Returns false when a snapshot failed, so the caller must say the guard did not run. */
function guardTree(repoDir: string, env: Record<string, string>, before: Snap | null, out: Pick<PrepareResult, "restored" | "unrestored" | "untracked">): boolean {
  const after = before ? snapshot(repoDir, env) : null;
  if (!before || !after) return false;
  const tried: string[] = [];
  for (const [path, xy] of after.status) {
    if (!before.status.has(path)) {
      if (xy === "??") out.untracked.push(path);
      else { // literal pathspec: a name such as pages/[id].tsx is a path, never a glob that could match the agent's own file
        try { git(repoDir, env, ["--literal-pathspecs", "checkout", "--", path]); tried.push(path); } catch { out.unrestored.push(path); }
      }
    } else if (before.hash.get(path) !== after.hash.get(path)) out.unrestored.push(path);
  }
  if (tried.length === 0) return true;
  const again = snapshot(repoDir, env);
  if (!again) { out.unrestored.push(...tried); return false; }
  for (const path of tried) (again.status.has(path) ? out.unrestored : out.restored).push(path); // submodules and failed restores stay dirty
  return true;
}

interface RunOut { code: number | null; cut: "timeout" | "abort" | null; err?: string; tail: string }

/** Signals only the group this call spawned; a pid that is not a real positive id is never used (no kill(-0), no kill(-1)). */
function signalGroup(pid: number | undefined, sig: NodeJS.Signals | 0): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, sig); return true; } catch { return false; }
}
async function groupGone(pid: number | undefined): Promise<void> {
  for (let k = 0; k < 40 && signalGroup(pid, 0); k++) await new Promise((r) => setTimeout(r, 50));
}

function runDetached(cmd: string, cwd: string, env: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<RunOut> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn("bash", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { resolve({ code: null, cut: null, err: String(e), tail: "" }); return; }
    const pid = child.pid;
    let cut: RunOut["cut"] = null, done = false, tail = "";
    const keep = (c: Buffer): void => { tail = (tail + c.toString("utf8")).slice(-TAIL_BYTES); };
    child.stdout?.on("data", keep); child.stderr?.on("data", keep);
    const killGroup = (): void => { if (!signalGroup(pid, "SIGKILL")) { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
    const finish = async (r: Omit<RunOut, "tail">): Promise<void> => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", onAbort);
      killGroup(); await groupGone(pid); // a backgrounded orphan must not write after the tree guard looks
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve({ ...r, tail });
    };
    const onAbort = (): void => { cut = "abort"; killGroup(); };
    const timer = setTimeout(() => { cut = "timeout"; killGroup(); }, timeoutMs);
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => { void finish({ code: null, cut, err: String(e) }); });
    child.on("exit", (code) => { void finish({ code, cut }); });
  });
}

/** One short honest line from the install output (L3): the last non-empty line, whitespace collapsed. */
const excerpt = (tail: string): string => {
  const l = tail.split("\n").map((x) => x.trim()).filter(Boolean).pop() ?? "";
  return l.replace(/\s+/g, " ").slice(0, 160);
};

/** Install dependencies for each package whose selected check hit a harness-owned load error; see the file header. */
export async function prepareDeps(input: PrepareInput): Promise<PrepareResult> {
  const res: PrepareResult = { checks: [], notProven: [], restored: [], unrestored: [], untracked: [], skipped: null };
  const env = mergedEnv(input.env);
  const roots = [...new Set(input.failed.filter((f) => f.harnessOwned).map((f) => f.root))];
  if (roots.length === 0) return res;
  if (optedOut(input.repoDir, env)) { res.skipped = "opt-out"; res.notProven.push(`dependencies not installed for ${roots.join(", ")} (install disabled by LOKI_E10_INSTALL=0 or verify.install_deps: false)`); return res; }
  const runId = input.opts.runId;
  let left = input.timeoutMs;
  for (const root of roots) {
    const key = `${runId}\0${root}`;
    if (memo.has(key)) continue;
    memo.add(key);
    const mc = input.model?.installFor(root) ?? null;
    if (!mc) { res.notProven.push(`NOT PROVEN: package ${root} has no known install command, its dependencies were not installed`); continue; }
    const name = `install:${root}`;
    const mk = (result: InstallCheck["result"], duration_s: number, reason?: string): InstallCheck => ({ name, cmd: mc.cmd, cwd: mc.cwd, result, duration_s, ...(reason ? { reason } : {}), ...(result === "not_run" ? { owner: "harness" as const } : {}) });
    const notRun = (reason: string): void => { res.checks.push(mk("not_run", 0, reason)); res.notProven.push(`${name} not run: ${reason}`); };
    const budget = Math.min(INSTALL_CAP_MS, left);
    if (budget <= 0 || input.signal.aborted) { notRun(input.signal.aborted ? "aborted" : "no budget left for install"); continue; }
    let cwd: string;
    try { // resolved at run time: a link swapped in since discovery must not move the install out of the repo
      cwd = realpathSync(join(input.repoDir, mc.cwd));
      const rel = relative(realpathSync(input.repoDir), cwd);
      if (isAbsolute(mc.cwd) || rel.startsWith("..") || isAbsolute(rel)) { notRun(`install cwd ${mc.cwd} resolves outside the repo`); continue; }
    } catch { notRun(`install cwd ${mc.cwd} does not exist`); continue; }
    const before = snapshot(input.repoDir, env);
    const t0 = Date.now();
    const r = await runDetached(mc.cmd, cwd, env, input.signal, budget);
    const dt = (Date.now() - t0) / 1000;
    left -= Date.now() - t0;
    if (!guardTree(input.repoDir, env, before, res)) res.notProven.push(`${name} tree guard not run (git status failed)`);
    if (r.code === 0 && !r.cut) { res.checks.push(mk("pass", dt)); continue; }
    const why = r.cut === "timeout" ? `install timed out after ${(budget / 1000).toFixed(1)}s` : r.cut === "abort" ? "aborted" : r.err ? `install could not start: ${r.err}` : `install exited ${r.code}`;
    const ex = r.cut === "abort" ? "" : excerpt(r.tail), reason = ex ? `${why}: ${ex}` : why;
    res.checks.push(mk("not_run", dt, reason));
    res.notProven.push(`${reason} (${name}; harness-owned)`);
  }
  return res;
}
