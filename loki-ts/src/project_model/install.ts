// loki-ts/src/project_model/install.ts -- FC-22b: the install pre-step library (wiring is S4, not here).
// Evidence-triggered: a package is installed only when a selected check in it came back as a harness-owned load error (FC-02).
// Once per package per run (memo), timeout min(300s, cap left), recorded as check `install:<root>`. A failed install is
// not_run owned by the harness, never fail. No install command: nothing runs, NOT PROVEN names the package (never guess).
// Opt-out: LOKI_E10_INSTALL=0 or loki.yaml `verify.install_deps: false`.
// L2 classification (docs/v10/ENGINE-LAWS.md L2): TRUST path. restoreTracked is the only destructive call here: it restores a
// tracked file only when the file was clean before the install and the install changed it; a file that was already dirty
// (the agent's work) is never touched, only listed. No static L2 registry exists yet; this header is the classification.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
  opts?: { runId?: string } | undefined;
}
export interface PrepareResult {
  checks: InstallCheck[];
  notProven: string[];
  restored: string[]; // tracked files the install changed and the guard restored
  unrestored: string[]; // tracked files the install changed that were already dirty before (left alone)
  untracked: string[]; // new untracked files outside ignored-style dirs
  skipped: "opt-out" | null;
}

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
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: repoDir, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

interface Snap { status: Map<string, string>; hash: Map<string, string> }
function snapshot(repoDir: string, env: Record<string, string>): Snap {
  const status = new Map<string, string>(), hash = new Map<string, string>();
  const parts = git(repoDir, env, ["status", "--porcelain", "-z"]).split("\0");
  for (let k = 0; k < parts.length; k++) {
    const e = parts[k]!;
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), path = e.slice(3);
    if (/[RC]/.test(xy)) k++; // a rename or copy carries its source as the next field
    status.set(path, xy);
    if (xy !== "??") { try { hash.set(path, createHash("sha1").update(readFileSync(join(repoDir, path))).digest("hex")); } catch { hash.set(path, "absent"); } }
  }
  return { status, hash };
}

function guardTree(repoDir: string, env: Record<string, string>, before: Snap | null, out: Pick<PrepareResult, "restored" | "unrestored" | "untracked">): void {
  if (!before) return;
  let after: Snap;
  try { after = snapshot(repoDir, env); } catch { return; }
  for (const [path, xy] of after.status) {
    if (xy === "??") {
      if (!before.status.has(path)) out.untracked.push(path); // git already omits ignored paths (dependency dirs)
      continue;
    }
    if (!before.status.has(path)) {
      try { git(repoDir, env, ["checkout", "--", path]); out.restored.push(path); } catch { out.unrestored.push(path); }
    } else if (before.hash.get(path) !== after.hash.get(path)) out.unrestored.push(path);
  }
}

interface RunOut { code: number | null; cut: "timeout" | "abort" | null; err?: string }
function runDetached(cmd: string, cwd: string, env: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<RunOut> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn("bash", ["-c", cmd], { cwd, env, detached: true, stdio: "ignore" }); } catch (e) { resolve({ code: null, cut: null, err: String(e) }); return; }
    const pid = child.pid;
    let cut: RunOut["cut"] = null, done = false;
    const killGroup = (): void => {
      // Only the group this call spawned: a pid that is not a real positive id is never signalled (no kill(-0) or kill(-1)).
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) { try { process.kill(-pid, "SIGKILL"); return; } catch { /* group gone */ } }
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    };
    const finish = (r: RunOut): void => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(r); };
    const onAbort = (): void => { cut = "abort"; killGroup(); };
    const timer = setTimeout(() => { cut = "timeout"; killGroup(); }, timeoutMs);
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => finish({ code: null, cut, err: String(e) }));
    child.on("exit", (code) => finish({ code, cut }));
  });
}

/** Install dependencies for each package whose selected check hit a harness-owned load error; see the file header. */
export async function prepareDeps(input: PrepareInput): Promise<PrepareResult> {
  const res: PrepareResult = { checks: [], notProven: [], restored: [], unrestored: [], untracked: [], skipped: null };
  const env = mergedEnv(input.env);
  const roots = [...new Set(input.failed.filter((f) => f.harnessOwned).map((f) => f.root))];
  if (roots.length === 0) return res;
  if (optedOut(input.repoDir, env)) { res.skipped = "opt-out"; res.notProven.push(`dependencies not installed for ${roots.join(", ")} (install disabled by LOKI_E10_INSTALL=0 or verify.install_deps: false)`); return res; }
  const runId = input.opts?.runId ?? "";
  let left = input.timeoutMs;
  for (const root of roots) {
    const key = `${runId}\0${root}`;
    if (memo.has(key)) continue;
    memo.add(key);
    const mc = input.model?.installFor(root) ?? null;
    if (!mc) { res.notProven.push(`NOT PROVEN: package ${root} has no known install command, its dependencies were not installed`); continue; }
    const name = `install:${root}`, rel = relative(input.repoDir, join(input.repoDir, mc.cwd));
    const mk = (result: InstallCheck["result"], duration_s: number, reason?: string): InstallCheck => ({ name, cmd: mc.cmd, cwd: mc.cwd, result, duration_s, ...(reason ? { reason } : {}), ...(result === "not_run" ? { owner: "harness" as const } : {}) });
    const budget = Math.min(INSTALL_CAP_MS, left);
    if (isAbsolute(mc.cwd) || rel.startsWith("..")) { res.checks.push(mk("not_run", 0, `install cwd ${mc.cwd} is outside the repo`)); res.notProven.push(`${name} not run: cwd outside the repo`); continue; }
    if (budget <= 0 || input.signal.aborted) { res.checks.push(mk("not_run", 0, input.signal.aborted ? "aborted" : "no budget left for install")); res.notProven.push(`${name} not run: ${input.signal.aborted ? "aborted" : "no budget left"}`); continue; }
    let before: Snap | null = null;
    try { before = snapshot(input.repoDir, env); } catch { before = null; }
    const t0 = Date.now();
    const r = await runDetached(mc.cmd, join(input.repoDir, mc.cwd), env, input.signal, budget);
    const dt = (Date.now() - t0) / 1000;
    left -= Date.now() - t0;
    guardTree(input.repoDir, env, before, res);
    if (r.code === 0 && !r.cut) { res.checks.push(mk("pass", dt)); continue; }
    const reason = r.cut === "timeout" ? `install timed out after ${Math.round(budget / 1000)}s` : r.cut === "abort" ? "aborted" : r.err ? `install could not start: ${r.err}` : `install exited ${r.code}`;
    res.checks.push(mk("not_run", dt, reason));
    res.notProven.push(`${reason} (${name}; harness-owned)`);
  }
  return res;
}
