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
import { spawn, spawnSync } from "node:child_process";
import { safeGit } from "../util/safe_git.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { lokiYamlTexts, yamlKey } from "../util/yaml_key.ts";
import { baselineCmdS, baselineSuites, suiteBaselineBudgetS } from "../runner/repo_profile.ts";
import { LOCK_RULES, has, inWorkspace, isYarnBerry, type LockRule } from "../util/lock_ecosystems.ts";
import type { RunContext, RunnerName } from "../engine10/types.ts";
import type { ProjectApi } from "./api.ts";
import { fullSuiteSpecs } from "./package_suite.ts";
import { loadProjectApi } from "./resolve.ts";
import { guideNotes, guidesFor } from "./guides.ts";

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
  intake?: boolean; // G2 INTAKE-VENV: only intakeDeps sets it; a .venv is never created outside intake (never during verify)
}
export interface PrepareResult {
  checks: InstallCheck[];
  notProven: string[];
  restored: string[]; // tracked files the install changed and the guard restored
  unrestored: string[]; // tracked files the install changed that were already dirty before (left alone)
  untracked: string[]; // new untracked files outside ignored-style dirs
  skipped: "opt-out" | null;
  lokiVenv: string[]; // G2 INTAKE-VENV: the repo-relative .venv dirs Loki created at intake and installed into (shown on the receipt; intake's baseline, recorded after them)
  lokiVenvMade: string[]; // every .venv dir Loki made at intake, as "dir/", whatever the install did: always recorded in install_created, so never part of the change
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

/** The project names ruff itself: a [tool.ruff] table, a ruff config file, or ruff in a dependency or tooling manifest. Config detection only. */
export function projectDeclaresRuff(repoDir: string): boolean {
  if (["ruff.toml", ".ruff.toml"].some((f) => existsSync(join(repoDir, f)))) return true;
  const files = ["pyproject.toml", "setup.cfg", "tox.ini", ".pre-commit-config.yaml", "Pipfile", "requirements.txt", "requirements-dev.txt", "dev-requirements.txt"];
  return files.some((f) => { try { return /\bruff\b/i.test(readFileSync(join(repoDir, f), "utf8")); } catch { return false; } });
}
/** G2 DECLARED-INSTALLS (LOKI_E10_DECLARED_INSTALLS, default on; =0 off): Loki runs an install only when the repository declares it: the frozen form of a
 *  lockfile it commits (lockedInstall answers locked), a script the repository tracks run by its path (`./install.sh`), the command's own text in a file
 *  the project model cited for it or in a CI file the repository commits (CI_FILES), or a setup command a repo guide documents for that directory; `python3 -m pip`
 *  and `pip` are the same command for this match. A plain `npm|pnpm|yarn install` from a package.json with no node_modules yet is declared too (the manifest is the
 *  repo's own dependency list and a fresh clone needs it); a lockfile, when there is one, already gives its frozen form above. An install Loki would have to invent (`pip install -e .` from a bare manifest) is not run: across 37 stored C1, C2 and
 *  real-world runs no unlocked install ever passed (0 of 59). Replaces the PEP 668 retry, which invented a .venv inside the checkout. */
export const UNDECLARED_INSTALL = "install not run by Loki:";
/** The disclosed line for an install Loki declined to invent: what was skipped, and what the user can run. A pip install is shown inside a virtualenv outside
 *  Loki's run, since a system Python may refuse it (PEP 668) and Loki no longer makes a .venv in the checkout. */
export function undeclaredNote(cwd: string, cmd: string, noVenv = false): string {
  const req = ["requirements.txt", "requirements-dev.txt", "dev-requirements.txt"].filter((f) => existsSync(join(cwd, f)));
  const pip = /^\s*(?:python3?(?:\.\d+)?\s+-m\s+pip[\d.]*|pip[\d.]*)\s+install\b(.*)$/.exec(cmd);
  const run = pip ? `python3 -m venv .venv && .venv/bin/python -m pip install${pip[1]}` : cmd.trim();
  return `${UNDECLARED_INSTALL} ${noVenv ? "Loki could not make a .venv with pip in the checkout for this Python install (python3 -m venv failed or gave no pip), and it never installs into the machine's own Python" : "the repository declares no install command for this package (no committed lockfile, tracked install script, cited file, guide or CI file names it), so Loki did not invent one"}${req.length ? `; ${req.join(", ")} present; Loki did not install it (not declared or locked)` : ""}; to install the dependencies yourself, run: ${run}`;
}
export const declaredInstallsOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_DECLARED_INSTALLS"] ?? "").trim());
const CI_FILES = [".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", ".travis.yml", "bitbucket-pipelines.yml"];
function ciTexts(repoDir: string): string[] {
  const out: string[] = [];
  for (const f of CI_FILES) { try { out.push(readFileSync(join(repoDir, f), "utf8")); } catch { /* absent */ } }
  try { for (const f of readdirSync(join(repoDir, ".github", "workflows"))) if (/\.ya?ml$/.test(f)) { try { out.push(readFileSync(join(repoDir, ".github", "workflows", f), "utf8")); } catch { /* unreadable */ } } } catch { /* no workflows */ }
  return out;
}
/** A pip install (`pip`, `pip3`, `python3 -m pip`). */
const PIP_INSTALL = /^\s*(?:python3?(?:\.\d+)?\s+-m\s+pip[\d.]*|pip[\d.]*)\s+install\b(.*)$/; // pip, pip3, pip3.11, python3 -m pip (review: pip3.11 slipped past)
/** The unlocked pip install as `<venv>/bin/python -m pip install <args>`, run only when that interpreter can run pip (review: a `uv venv` has no pip, and a bare `pip`
 *  would then resolve to the machine's). null: no runnable pip there, so the install is skipped. */
export function pipInVenv(cmd: string, venv: string): string | null {
  const m = PIP_INSTALL.exec(cmd); if (!m) return null;
  const py = join(venv, "bin", "python");
  try { if (spawnSync(py, ["-m", "pip", "--version"], { stdio: "ignore", timeout: 30000 }).status !== 0) return null; } catch { return null; }
  return `${py} -m pip install${m[1]}`;
}
/** Whether a non-pip install is declared (an unlocked pip install never asks: prepareDeps gives it the intake .venv, see pythonEnvAt and makeIntakeVenv). */
export function installDeclared(repoDir: string, mc: { cmd: string; cwd: string; cite?: readonly string[] }, li: LockedInstall): boolean {
  if (li.locked) return true;
  const norm = (x: string): string => x.replace(/\s+/g, " ").trim().replace(/\bpython3?(?:\.\d+)? -m pip[\d.]*(?=\s|$)/g, "pip").replace(/\bpip[\d.]+(?=\s|$)/g, "pip"), want = norm(mc.cmd);
  if (!want) return false;
  // a JS manifest is the repo's own declaration of its dependencies (lead ruling 2026-11-20): a fresh clone (no node_modules) gets the package manager's install once, at intake, before any baseline
  if (/^(?:npm|pnpm|yarn)(?: install)?$/.test(want) && existsSync(join(repoDir, mc.cwd, "package.json")) && !existsSync(join(repoDir, mc.cwd, "node_modules"))) return true;
  const exe = want.split(" ")[0]!;
  if (exe.includes("/") && !isAbsolute(exe)) { try { const rel = relative(repoDir, join(repoDir, mc.cwd, exe)); if (!rel.startsWith("..") && safeGit(repoDir, ["ls-files", "--error-unmatch", "--", rel]).trim()) return true; } catch { /* untracked or outside: not a declaration */ } }
  const named = (mc.cite ?? []).some((f) => { try { return norm(readFileSync(join(repoDir, f), "utf8")).includes(want); } catch { return false; } }) // a cited file
    || (() => { try { return guidesFor(join(repoDir, mc.cwd), repoDir).setup.some((g) => norm(g.cmd).includes(want)); } catch { return false; } })() // a repo guide
    || ciTexts(repoDir).some((t) => norm(t).includes(want)); // a CI workflow
  return named;
}

/** An existing Python environment for `cwd`: a .venv or venv (with pyvenv.cfg or bin/python) in the package dir or the repo root, or VIRTUAL_ENV naming a real dir.
 *  Loki never replaces or reinstalls one. Returns how to name it, or null. */
export function pythonEnvAt(repoDir: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const ve = env["VIRTUAL_ENV"]; if (ve && existsSync(ve)) return `VIRTUAL_ENV=${ve}`;
  for (const d of new Set([cwd, realpathSync(repoDir)])) for (const n of [".venv", "venv"]) { const v = join(d, n); if (existsSync(join(v, "pyvenv.cfg")) || existsSync(join(v, "bin", "python"))) return relative(realpathSync(repoDir), v) || n; }
  return null;
}
/** `python3 -m venv .venv` in the package dir, at intake only. The interpreter that makes it is the machine's, but nothing is ever installed into that one:
 *  every install then runs as `.venv/bin/python -m pip`. Returns the venv path, or null when creation failed. */
export function makeIntakeVenv(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const v = join(cwd, ".venv");
  try { const r = spawnSync("python3", ["-m", "venv", ".venv"], { cwd, env, stdio: "ignore", timeout: 120000 }); return r.status === 0 && existsSync(join(v, "bin", "python")) ? v : null; } catch { return null; }
}
/** The receipt line for each .venv Loki created at intake (verify files it under N/A). Intake records its environment baseline after this, so it is never a dependency change. */
export function lokiVenvNotes(intake: unknown): string[] {
  const v = (intake as { loki_venv?: unknown } | null | undefined)?.loki_venv;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => `Loki created ${x} at intake (the checkout had no Python environment) and installed the repository's dependencies into it with its own python -m pip; it is the intake baseline, not a change`) : [];
}

/** One short honest line from the install output (L3): the last non-empty line, whitespace collapsed. */
const excerpt = (tail: string): string => {
  const l = tail.split("\n").map((x) => x.trim()).filter(Boolean).pop() ?? "";
  return l.replace(/\s+/g, " ").slice(0, 160);
};

/** Install dependencies for each package whose selected check hit a harness-owned load error; see the file header. */
export async function prepareDeps(input: PrepareInput): Promise<PrepareResult> {
  const res: PrepareResult = { checks: [], notProven: [], restored: [], unrestored: [], untracked: [], skipped: null, lokiVenv: [], lokiVenvMade: [] };
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
    const skip = (why: string): void => { res.checks.push(mk("not_run", 0, why)); res.notProven.push(`${why} (${name}; harness-owned)`); };
    let decl: boolean | string = true;
    if (declaredInstallsOn(env) && !li.locked && PIP_INSTALL.test(mc.cmd)) { // G2 INTAKE-VENV (lead ruling 2026-11-20): an unlocked Python install lands in a .venv Loki makes in the checkout, or does not run
      const have = pythonEnvAt(input.repoDir, cwd, env);
      if (have) { skip(`${UNDECLARED_INSTALL} a Python environment already exists (${have}); Loki never replaces or reinstalls it`); continue; }
      if (!input.intake) { skip(`${UNDECLARED_INSTALL} Loki makes a .venv only at intake, before any baseline, never later`); continue; }
      const made = makeIntakeVenv(cwd, env);
      if (existsSync(join(cwd, ".venv"))) res.lokiVenvMade.push(`${relative(realpathSync(input.repoDir), join(cwd, ".venv"))}/`); // review of 7b196ff16: kept in place and recorded even when the install then fails
      if (!made || !pipInVenv(mc.cmd, made)) { skip(undeclaredNote(cwd, mc.cmd, true)); continue; } // a venv that failed or has no pip: never the machine's Python (a made dir stays: nothing is deleted)
      decl = made; res.lokiVenv.push(relative(realpathSync(input.repoDir), made) || ".venv");
    } else if (declaredInstallsOn(env)) {
      decl = installDeclared(input.repoDir, mc, li);
      if (!decl) { skip(undeclaredNote(cwd, mc.cmd)); continue; } // G2: never an install Loki invents
    }
    const before = snapshot(input.repoDir, env);
    const t0 = Date.now();
    if (typeof decl === "string") li = { ...li, cmd: pipInVenv(mc.cmd, decl)! }; // an unlocked pip install: through the checkout venv's own python -m pip, never a PATH lookup
    const runEnv = typeof decl === "string" ? { ...env, VIRTUAL_ENV: decl, PATH: `${join(decl, "bin")}:${env["PATH"] ?? ""}` } : env;
    let r = await runDetached(li.cmd, cwd, runEnv, input.signal, budget);
    const uvNeed = r.code !== 0 && !r.cut && uvRequiredOn() ? UV_REQUIRED.exec(r.tail) : null, uvCmd = uvNeed ? uvRequiredCmd(li.cmd, uvNeed[1]!) : null; // UVR: the repo's own required uv version, not the host's
    if (uvCmd) { // a workspace member's sync runs at the workspace root, as the repo's CI does: a member-only sync of the shared .venv would drop the root's own test dependencies
      const ws = uvWorkspaceRoot(realpathSync(input.repoDir), cwd), at = ws ?? cwd;
      r = await runDetached(uvCmd, at, env, input.signal, Math.max(1, budget - (Date.now() - t0)));
      li = { ...li, cmd: uvCmd, note: `${li.note ? `${li.note}; ` : ""}the repo requires uv ${uvNeed![1]} and the host has an older uv: ran it with uvx${ws && ws !== cwd ? ` at the uv workspace root (${relative(realpathSync(input.repoDir), ws) || "."})` : ""}` };
    }
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

/** UVR LOKI_E10_UV_REQUIRED (default on, =0 opts out): a repo that pins `required-version` for uv (pydantic: ">=0.13.0") makes an older host uv refuse every
 *  `uv sync`, so the env verify ran in was not the one the repo's CI builds and its tests crashed on base and head alike. The install is retried once, unchanged, through
 *  `uvx --from "uv<spec>" uv ...`, so it runs on a uv the repo accepts. Only a command whose first word is uv is rewritten, and only after uv itself named the requirement. */
export const uvRequiredOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_UV_REQUIRED"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
const UV_REQUIRED = /Required uv version `([<>=!~^0-9.,* ]+)` does not match the running version/;
/** The nearest directory at or above `cwd`, inside `repo`, whose pyproject.toml declares a [tool.uv.workspace] that is not `cwd` itself; null when there is none. */
export function uvWorkspaceRoot(repo: string, cwd: string): string | null {
  for (let d = dirname(cwd); d.length >= repo.length && (d === repo || d.startsWith(`${repo}/`)); d = dirname(d)) {
    try { if (/^\s*\[tool\.uv\.workspace\]/m.test(readFileSync(join(d, "pyproject.toml"), "utf8"))) return d; } catch { /* no pyproject here */ }
    if (d === repo) break;
  }
  return null;
}
export function uvRequiredCmd(cmd: string, spec: string): string | null {
  const t = cmd.trim(); if (!/^uv\s/.test(t) || !/^[<>=!~^0-9.,* ]+$/.test(spec)) return null;
  return `uvx --from 'uv${spec.replace(/\s+/g, "")}' uv ${t.slice(2).trim()}`;
}
/** Intake installs every package whose dependencies were never installed (absentDepRoots), whether or not any check needs it. A failed install of a package nothing depends on is disclosed, never a cap:
 *  a package below the root with no test command, owning none of the changed files, holding no check verify ran, and whose ecosystem no check uses (lefthook's packaging/registries/pypi wrapper
 *  needs release binaries to install, while the change and every check are Go). A check of the same ecosystem anywhere in the repo could import what the install provides (a root pytest that
 *  importorskips it), so it keeps the cap (review of #543, C4), and so does a check or install whose ecosystem is unknown. Every other install line, and any line that is not a failed install,
 *  keeps capping. `checkNames` are verify's check names. */
const ecoOfCmd = (cmd: string): string | null => /\b(?:pip3?|python3?|uv|poetry|pdm|pipenv|hatch|tox|pytest)\b/.test(cmd) ? "py" : /\b(?:npm|pnpm|yarn|bun|npx|node)\b/.test(cmd) ? "js" : /\bcargo\b/.test(cmd) ? "rust" : /\b(?:mvn|mvnw|gradle|gradlew)\b/.test(cmd) ? "jvm" : /\bdotnet\b/.test(cmd) ? "dotnet" : /\bgo\b/.test(cmd) ? "go" : null;
const ecoOfDir = (repoDir: string | undefined, root: string): string | null => { if (!repoDir) return null; const has = (f: string): boolean => existsSync(join(repoDir, root, f)); return has("go.mod") ? "go" : has("pyproject.toml") || has("setup.py") || has("setup.cfg") ? "py" : has("package.json") ? "js" : has("Cargo.toml") ? "rust" : null; };
const ECO_PREFIX: [RegExp, string][] = [[/^go:/, "go"], [/^(?:pytest|unittest|lint:ruff|lint:mypy|lint:pyright)\b/, "py"], [/^(?:vitest|jest|bun|node|mocha|ava|lint:eslint|lint:tsc|tsc)\b/, "js"], [/^cargo:/, "rust"], [/^(?:maven|gradle|javac):/, "jvm"], [/^dotnet:/, "dotnet"]];
/** REPO-GUIDES: the receipt's informational lines gain which documented test command ran and where it came from, and each guide command Loki ignored (guides.ts guideNotes). Never a cap. */
export function withGuideNotes<T extends { na: string[] }>(notes: T, repoDir: string): T { try { const g = guideNotes(repoDir); return g.length ? { ...notes, na: [...notes.na, ...g] } : notes; } catch { return notes; } }
export function unusedInstallNotes(lines: readonly string[], model: ProjectApi | null | undefined, changed: readonly string[], checkNames: readonly string[], repoDir?: string, results?: readonly { name: string; result: string }[]): { cap: string[]; na: string[] } {
  const cap: string[] = [], na: string[] = [];
  const checkEco = (n: string): string | null => { for (const [re, e] of ECO_PREFIX) if (re.test(n)) return e; const pk = n.startsWith("full suite: ") ? model?.packages().find((p) => `full suite: ${p.name}` === n) : undefined; return pk ? ecoOfDir(repoDir, pk.root) ?? (pk.commands.test ? ecoOfCmd(pk.commands.test.cmd) : null) : null; };
  for (const l of lines) {
    const root = /\(install:([^;()]+); harness-owned\)$/.exec(l)?.[1], pkg = root && root !== "." ? model?.packages().find((p) => p.root === root) : undefined;
    const inRoot = (f: string): boolean => f === root || f.startsWith(`${root}/`), owned = (f: string): boolean => model?.packageOf(f)?.root === root || inRoot(f);
    const eco = pkg ? (model?.installFor(pkg.root)?.cmd ? ecoOfCmd(model.installFor(pkg.root)!.cmd) : null) ?? ecoOfDir(repoDir, pkg.root) : null;
    const used = !pkg || !eco || !!pkg.commands.test || changed.some(owned) || checkNames.some((n) => n === `full suite: ${pkg.name}` || inRoot(n.slice(n.indexOf(":") + 1).trim()) || (checkEco(n) ?? eco) === eco);
    if (l.startsWith(UNDECLARED_INSTALL)) { // G2 (review B4): an install Loki declined to invent is N/A only when nothing depends on it, or every check of its ecosystem passed;
      // a check that failed, even one excused as red on base, may be failing for want of the very dependencies (same ImportError both sides), so it stays NOT PROVEN
      const de = (pkg ? eco : null) ?? ecoOfDir(repoDir, root ?? ".") ?? (model?.installFor(root ?? ".")?.cmd ? ecoOfCmd(model.installFor(root ?? ".")!.cmd) : null);
      const mine = (results ?? []).filter((c) => !c.name.startsWith("lint:") && (!de || (checkEco(c.name) ?? de) === de || (!!root && root !== "." && inRoot(c.name.slice(c.name.indexOf(":") + 1).trim()))));
      (!used || (mine.length > 0 && mine.every((c) => c.result === "pass" || c.result === "flaky")) ? na : cap).push(l); continue;
    }
    (used ? cap : na).push(used ? l : `install failed for a package no check or changed file depends on: ${l}`);
  }
  return { cap, na };
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
export type PhaseTiming = { ms: number; at?: number; cached?: boolean } | { skipped: string }; // at: start offset in ms after intake began
export type IntakeTiming = Partial<Record<"setup" | "repo_walk" | "exec_spec_prefetch" | "already_done" | "project_model" | "deps_install" | "suite_baseline" | "zero_baseline" | "zero_probe", PhaseTiming>>;
export interface DepsTiming { install?: PhaseTiming; baseline_ms?: number }
export async function intakeDeps(ctx: Pick<RunContext, "repoDir" | "runId" | "emit"> & { capS?: number; baselineLeftS?: number }, signal: AbortSignal, runners: RunnerName[], timing?: DepsTiming): Promise<Record<string, unknown>> {
  const model = loadProjectApi(ctx.repoDir), roots = absentDepRoots(ctx.repoDir, model), before = untrackedTops(ctx.repoDir), t0 = Date.now();
  const r = await prepareDeps({ repoDir: ctx.repoDir, model, failed: roots.map((root) => ({ root, harnessOwned: true })), signal, timeoutMs: INSTALL_CAP_MS, opts: { runId: ctx.runId }, intake: true });
  for (const c of r.checks) ctx.emit("deps.install", "intake", { ...c });
  const created = withLokiVenvs(r.checks.some((c) => c.result === "pass") ? installCreatedSince(ctx.repoDir, before) : null, r.lokiVenvMade); // a failed install records nothing, so nothing is hidden, except a .venv Loki itself made
  const installMs = Date.now() - t0, tb = Date.now();
  baselineSuites(ctx.repoDir, fullSuiteSpecs(ctx.repoDir, runners), { rerun: r.checks.some((c) => c.result === "pass"), timeoutS: baselineCmdS(ctx.capS), budgetS: Math.min(suiteBaselineBudgetS(), baselineCmdS(ctx.capS)), ...(ctx.baselineLeftS !== undefined ? { deadlineMs: tb + ctx.baselineLeftS * 1000 } : {}) }); // baselineLeftS: what the root baseline left of intake's baseline budget (R3, counted after the install)
  const install: PhaseTiming = r.checks.length ? { ms: installMs } : { skipped: r.notProven.length ? "install not attempted" : "no dependencies to install" };
  if (timing) { timing.install = install; timing.baseline_ms = Date.now() - tb; }
  return { ...(r.checks.length || r.notProven.length ? { deps_install: r.checks, deps_not_proven: r.notProven } : {}), ...(created ? { install_created: created } : {}), ...(r.lokiVenv.length ? { loki_venv: r.lokiVenv } : {}) };
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
/** install_created plus every .venv Loki made at intake (as "dir/"), whatever its install did: a Loki-made virtualenv is never part of changedFiles or the commit. */
export function withLokiVenvs(created: InstallCreated | null, made: readonly string[]): InstallCreated | null {
  if (!made.length) return created;
  return { files: created?.files ?? {}, dirs: [...new Set([...(created?.dirs ?? []), ...made])] };
}
/** True for what the install made and the run has not touched: a recorded file only while its content still matches its intake hash
 *  (an agent-edited lockfile stays a change), anything under a recorded directory unconditionally. */
export function installOwned(repoDir: string, rec: unknown, env: NodeJS.ProcessEnv = process.env): (f: string) => boolean {
  const r = rec as Partial<InstallCreated> | null | undefined, files = r && typeof r.files === "object" && r.files ? r.files : {}, dirs = Array.isArray(r?.dirs) ? r.dirs : [];
  return (f) => dirs.some((d) => typeof d === "string" && f.startsWith(d)) || (Object.hasOwn(files, f) && (() => { try { return hashOf(repoDir, f, env) === files[f]; } catch { return false; } })());
}
