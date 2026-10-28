// loki-ts/src/project_model/install.ts -- FC-22b: the install pre-step library, wired at intake by intakeDeps (FC-DEPS-NOT-INSTALLED).
// Evidence-triggered: a package is installed only when a selected check in it came back as a harness-owned load error (FC-02),
// or when absentDepRoots shows its dependencies were never installed (a fresh clone), before the baseline and the Wall base run.
// Once per package per run (memo), timeout min(300s, cap left), recorded as check `install:<root>`. A failed install is
// not_run owned by the harness, never fail. No install command: nothing runs, NOT PROVEN names the package (never guess).
// Opt-out: LOKI_E10_INSTALL=0 or loki.yaml `verify.install_deps: false`.
// Locked install (founder 2026-10-19): lockedInstall maps (package root contents, model command) to the ecosystem's frozen form, which
// never rewrites the lockfile. If that install fails the run is NOT PROVEN (harness-owned); it never falls back to a mutating install.
// L2 classification (docs/v10/ENGINE-LAWS.md L2): TRUST path, registered in tests/engine10/l2_destructive_registry.test.ts.
// guardTree is the only destructive call: it restores a tracked file (literal pathspec) only when the file was clean before the
// install and the install changed it, and counts it restored only if a re-snapshot shows it clean. A file that was already dirty
// (the agent's work) is never touched, only listed. If a snapshot fails the guard did not run and NOT PROVEN says so.
import { spawn } from "node:child_process";
import { safeGit } from "../util/safe_git.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { lokiYamlTexts, yamlKey } from "../util/yaml_key.ts";
import { baselineSuites } from "../runner/repo_profile.ts";
import { LOCK_RULES, has, isYarnBerry, type LockRule } from "../util/lock_ecosystems.ts";
import type { RunContext, RunnerName } from "../engine10/types.ts";
import type { ProjectApi } from "./api.ts";
import { fullSuiteSpecs } from "./package_suite.ts";
import { loadProjectApi } from "./resolve.ts";

export const INSTALL_CAP_MS = 300_000;
const memo = new Set<string>(); // `${runId}\0${root}`: once per package per run, across fix rounds

export interface FailedCheck { root: string; harnessOwned: boolean }
export interface InstallCheck {
  name: string; // install:<root>
  cmd: string;
  cwd: string; // repo-relative
  result: "pass" | "not_run";
  locked: boolean; // true: the command run is the ecosystem's lockfile-frozen form
  lock_note?: string; // why it is not locked, or that it was rewritten (model_cmd carries the model's original)
  model_cmd?: string; // the model's command, only when it was rewritten into its locked form
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
  const t = lokiYamlTexts(repoDir, { yamlOnly: true })[0];
  return t !== undefined && yamlKey(t, "verify", "install_deps")?.toLowerCase() === "false";
}

const git = (repoDir: string, env: Record<string, string>, args: string[]): string =>
  safeGit(repoDir, args, { env, maxBuffer: STATUS_MAX_BUFFER }); // FC-25: supervisor-side, hardened and token-free

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

const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/^\.\//, "").replace(/\/+$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*").replace(/\?/g, "[^/]")}$`);
/** True when `pats` (a workspace declaration; ! excludes) includes the package at `rel` (posix, relative to the ancestor). */
const inWorkspace = (pats: string[], rel: string): boolean =>
  pats.some((g) => !g.startsWith("!") && globRe(g).test(rel)) && !pats.some((g) => g.startsWith("!") && globRe(g.slice(1)).test(rel));

export interface LockedInstall { cmd: string; locked: boolean; note?: string; rewritten: boolean }

/** The directory whose lockfile governs the package at `cwd`: the package directory itself if it holds one of the rule's lockfiles, else
 *  the nearest ancestor (up to `repoDir`) that holds one AND declares a workspace containing the package. An ancestor lockfile alone
 *  proves nothing: a standalone sub-project beside a root lockfile has no lock of its own, and a frozen install there would fail. */
function lockDir(repoDir: string, cwd: string, rule: LockRule): string | null {
  const top = realpathSync(repoDir), start = realpathSync(cwd);
  if (rule.locks.some((n) => existsSync(join(start, n)))) return start;
  if (!rule.ws) return null;
  for (let d = dirname(start); !relative(top, d).startsWith(".."); d = dirname(d)) {
    if (rule.locks.some((n) => existsSync(join(d, n))) && inWorkspace(rule.ws(d), relative(d, start).split("\\").join("/"))) return d;
    if (d === top || d === dirname(d)) break;
  }
  return null;
}

/** Maps (package root contents, model install command) to the command actually run: each install segment whose tool has a governing
 *  lockfile (see lockDir) becomes the ecosystem's frozen form; an already-locked form is kept; a segment that names packages, has no
 *  governing lockfile, runs in a directory that cannot be resolved, is joined to a `||` fallback or matches no rule is kept as written and the result
 *  says it is not locked. A `cd X` segment moves the lookup to X. Never guesses a package manager. */
export function lockedInstall(repoDir: string, cwd: string, modelCmd: string): LockedInstall {
  const flat = modelCmd.replace(/\\\r?\n/g, " ").replace(/[\s;]+$/, "");
  const parts = flat.split(/(\s*(?:&&|\|\||;|\n)\s*)/);
  // No shell parser, so an allowlist: only plain words and the separators && ; newline are understood. A `||`, any other character, any
  // assignment to PATH, NODE_OPTIONS, BASH_ENV or ENV, or a first install preceded by anything but `cd X`, `export VAR=value` or pure VAR=value assignments leaves every
  // install in the whole command as written.
  const wordsOf = (seg: string): { w: string[]; e: number; tool: string; hasSub: boolean; sub: string } => {
    const w = seg.trim().split(/\s+/).filter(Boolean), e = w.findIndex((x) => !/^[A-Za-z_]\w*=/.test(x));
    const hasSub = e >= 0 && w[e + 1] !== undefined && !w[e + 1]!.startsWith("-");
    return { w, e, tool: e >= 0 ? w[e]! : "", hasSub, sub: hasSub ? w[e + 1]! : "" };
  };
  const preludeOk = (): boolean => {
    for (let k = 0; k < parts.length; k += 2) {
      const { w, e, tool, sub } = wordsOf(parts[k]!);
      if (w.some((x) => /^(PATH|NODE_OPTIONS|BASH_ENV|ENV)=/.test(x))) return false;
      if (e < 0) continue;
      if (LOCK_RULES.some((r) => r.tool === tool && r.subs.includes(sub))) return true;
      if (e > 0 || !(tool === "cd" || (tool === "export" && w.length > 1 && w.slice(1).every((x) => /^[A-Za-z_]\w*=/.test(x))))) return false;
    }
    return true;
  };
  const whole = flat.includes("||") ? "fallback masks install failure"
    : !/^[A-Za-z0-9 _./=:@+,%~\t\n;-]*$/.test(flat.replace(/&&/g, " ")) || !preludeOk() ? "unparsed shell construct" : null;
  // runDetached runs `bash -c` without -e: a `;` or newline command after an install masks its failure, so only an install joined to
  // everything after it by `&&` is rewritten.
  const lastSemi = parts.reduce((m, p, k) => (k % 2 === 1 && /[;\n]/.test(p) ? k : m), -1);
  let later = false;
  const notes: string[] = [];
  let hits = 0, locked = true, rewritten = false, cur: string | null = realpathSync(cwd);
  const out = parts.map((seg, k) => {
    if (k % 2 === 1) return seg;
    const { w, e, tool, hasSub, sub } = wordsOf(seg);
    if (e < 0) return seg;
    const env = w.slice(0, e);
    if (tool === "cd") {
      try { cur = cur !== null && w.length === e + 2 && !/[$~`*]/.test(w[e + 1]!) && !w[e + 1]!.startsWith("-") ? realpathSync(join(cur, w[e + 1]!)) : null; } catch { cur = null; }
      return seg;
    }
    const rule = LOCK_RULES.find((r) => r.tool === tool && r.subs.includes(sub));
    if (!rule) return seg;
    hits++;
    if (whole) { locked = false; notes.push(whole); return seg; }
    if (k < lastSemi) { later = true; locked = false; notes.push("later command masks install failure"); return seg; }
    const rest = w.slice(e + (hasSub ? 2 : 1));
    if (rest.some((x) => !x.startsWith("-"))) { locked = false; notes.push(`${tool} ${sub} names packages or targets, kept as written`); return seg; }
    if (cur === null) { locked = false; notes.push(`${tool} runs in a directory that cannot be resolved, kept as written`); return seg; }
    const dir = lockDir(repoDir, cur, rule);
    if (!dir) { locked = false; notes.push(`no ${rule.locks.join(" or ")} governs this package for ${tool}`); return seg; }
    if (rule.locked(sub, rest, env)) {
      if (tool !== "uv" || !has(rest, "--locked", "--frozen") || !rest.includes("--frozen") || !rest.includes("--locked")) return seg;
      rewritten = true; return [...env, "uv", "sync", ...rest.filter((x) => x !== "--frozen")].join(" ");
    } // already a locked form: kept byte for byte
    rewritten = true;
    const frozenEnv = rule.tool === "bundle" ? ["BUNDLE_FROZEN=true"] : [];
    return [...env, ...frozenEnv, ...rule.build(sub, rest, { berry: isYarnBerry(dir) })].join(" ");
  });
  if (hits === 0) return { cmd: modelCmd, locked: false, note: "install not lockfile-locked: no lockfile rule matches this command", rewritten: false };
  return { cmd: rewritten && !later ? out.join("") : modelCmd, locked, rewritten: rewritten && !later, ...(!locked ? { note: `install not lockfile-locked: ${notes.join("; ")}` } : rewritten ? { note: "install rewritten to its lockfile-frozen form" } : {}) };
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
    let li: LockedInstall = { cmd: mc.cmd, locked: false, rewritten: false };
    const mk = (result: InstallCheck["result"], duration_s: number, reason?: string): InstallCheck => ({ name, cmd: li.cmd, cwd: mc.cwd, result, locked: li.locked, ...(li.note ? { lock_note: li.note } : {}), ...(li.rewritten ? { model_cmd: mc.cmd } : {}), duration_s, ...(reason ? { reason } : {}), ...(result === "not_run" ? { owner: "harness" as const } : {}) });
    const notRun = (reason: string): void => { res.checks.push(mk("not_run", 0, reason)); res.notProven.push(`${name} not run: ${reason}`); };
    const budget = Math.min(INSTALL_CAP_MS, left);
    if (budget <= 0 || input.signal.aborted) { notRun(input.signal.aborted ? "aborted" : "no budget left for install"); continue; }
    let cwd: string;
    try { // resolved at run time: a link swapped in since discovery must not move the install out of the repo
      cwd = realpathSync(join(input.repoDir, mc.cwd));
      const rel = relative(realpathSync(input.repoDir), cwd);
      if (isAbsolute(mc.cwd) || rel.startsWith("..") || isAbsolute(rel)) { notRun(`install cwd ${mc.cwd} resolves outside the repo`); continue; }
    } catch { notRun(`install cwd ${mc.cwd} does not exist`); continue; }
    li = lockedInstall(input.repoDir, cwd, mc.cmd);
    const before = snapshot(input.repoDir, env);
    const t0 = Date.now();
    const r = await runDetached(li.cmd, cwd, env, input.signal, budget);
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

/** FC-DEPS-NOT-INSTALLED: roots of model packages whose install command cites a manifest or lockfile inside the package root while git
 *  shows no untracked or ignored directory directly in that root (nothing was ever installed there: a fresh clone). Ecosystem-agnostic:
 *  git decides, never a list of dependency directory names. A git failure is not evidence of absence, so that package is left alone. */
export function absentDepRoots(repoDir: string, model: ProjectApi | null | undefined, env?: Record<string, string | undefined>): string[] {
  if (!model?.known()) return [];
  const e = mergedEnv(env), roots: string[] = [];
  for (const p of model.packages()) {
    const mc = model.installFor(p.root), pre = p.root === "." ? "" : `${p.root}/`;
    if (!mc || !(mc.cite ?? []).some((f) => f.startsWith(pre) && existsSync(join(repoDir, f)))) continue;
    let out: string;
    try { out = git(repoDir, e, ["ls-files", "--others", "--directory", "--", p.root]); } catch { continue; }
    const installed = out.split("\n").some((l) => l.startsWith(pre) && l.endsWith("/") && !l.slice(pre.length, -1).includes("/") && l !== ".loki/");
    if (!installed) roots.push(p.root);
  }
  return roots;
}

/** Intake's wired pre-step (FC-DEPS-NOT-INSTALLED, then FC-BASELINE-PER-PACKAGE): installs each package absentDepRoots names, once,
 *  through prepareDeps (event deps.install per package; a failure is NOT PROVEN and the run goes on), then records the per-command
 *  baseline for the full-suite commands verify will run. Returns intake's data; deps_not_proven reaches the receipt via verify's not_proven. */
/** Per-subphase intake wall time. A phase that did not run is `{ skipped: reason }`, never `{ ms: 0 }`. */
export type PhaseTiming = { ms: number; cached?: boolean } | { skipped: string };
export type IntakeTiming = Partial<Record<"repo_walk" | "project_model" | "deps_install" | "suite_baseline" | "zero_probe", PhaseTiming>>;
export interface DepsTiming { install?: PhaseTiming; baseline_ms?: number }
export async function intakeDeps(ctx: Pick<RunContext, "repoDir" | "runId" | "emit">, signal: AbortSignal, runners: RunnerName[], timing?: DepsTiming): Promise<Record<string, unknown>> {
  const model = loadProjectApi(ctx.repoDir), roots = absentDepRoots(ctx.repoDir, model), before = untrackedTops(ctx.repoDir), t0 = Date.now();
  const r = await prepareDeps({ repoDir: ctx.repoDir, model, failed: roots.map((root) => ({ root, harnessOwned: true })), signal, timeoutMs: INSTALL_CAP_MS, opts: { runId: ctx.runId } });
  for (const c of r.checks) ctx.emit("deps.install", "intake", { ...c });
  const created = r.checks.some((c) => c.result === "pass") ? installCreatedSince(ctx.repoDir, before) : null; // a failed install records nothing, so nothing is hidden
  const installMs = Date.now() - t0, tb = Date.now();
  baselineSuites(ctx.repoDir, fullSuiteSpecs(ctx.repoDir, runners), { rerun: r.checks.some((c) => c.result === "pass") });
  const install: PhaseTiming = r.checks.length ? { ms: installMs } : { skipped: r.notProven.length ? "install not attempted" : "no dependencies to install" };
  if (timing) { timing.install = install; timing.baseline_ms = Date.now() - tb; }
  return { ...(r.checks.length || r.notProven.length ? { deps_install: r.checks, deps_not_proven: r.notProven } : {}), ...(created ? { install_created: created } : {}) };
}

// --no-filters: never run a clean filter from the agent-writable .git/config
const hashOf = (repoDir: string, path: string, env: NodeJS.ProcessEnv = process.env): string => safeGit(repoDir, ["hash-object", "--no-filters", "--", path], { env }).trim();
/** FC-DEPS-NOT-INSTALLED: untracked entries (a wholly untracked directory collapsed to "dir/") the dependency install created. Files carry a
 *  content hash, directories are dependency trees. Nothing is written into the repo's git config or exclude files. */
export interface InstallCreated { files: Record<string, string>; dirs: string[] }
export const untrackedTops = (repoDir: string): Set<string> => { try { return new Set(safeGit(repoDir, ["ls-files", "-o", "--directory", "--exclude-standard", "-z"]).split("\0").filter(Boolean)); } catch { return new Set(); } };
export function installCreatedSince(repoDir: string, before: Set<string>): InstallCreated | null {
  const files: Record<string, string> = {}, dirs: string[] = [];
  for (const p of untrackedTops(repoDir)) if (!before.has(p) && !p.startsWith(".loki/")) { if (p.endsWith("/")) dirs.push(p); else { try { files[p] = hashOf(repoDir, p); } catch { /* unreadable: left visible */ } } }
  return dirs.length || Object.keys(files).length ? { files, dirs } : null;
}
/** True for what the install made and the run has not touched: a recorded file only while its content still matches its intake hash
 *  (an agent-edited lockfile stays a change), anything under a recorded directory unconditionally. */
export function installOwned(repoDir: string, rec: unknown, env: NodeJS.ProcessEnv = process.env): (f: string) => boolean {
  const r = rec as Partial<InstallCreated> | null | undefined, files = r && typeof r.files === "object" && r.files ? r.files : {}, dirs = Array.isArray(r?.dirs) ? r.dirs : [];
  return (f) => dirs.some((d) => typeof d === "string" && f.startsWith(d)) || (Object.hasOwn(files, f) && (() => { try { return hashOf(repoDir, f, env) === files[f]; } catch { return false; } })());
}
