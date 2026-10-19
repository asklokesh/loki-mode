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

interface LockRule {
  tool: string; subs: string[]; locks: string[];
  locked: (sub: string, rest: string[], env: string[]) => boolean; // the command is already a lock-honoring form
  build: (sub: string, rest: string[], ctx: { berry: boolean }) => string[]; // words of the locked form, the model's flags kept
  /** Glob patterns of the workspace an ancestor directory declares; absent: the ecosystem has no workspace lockfile sharing. */
  ws?: (ancestor: string) => string[];
}
const has = (rest: string[], ...f: string[]): boolean => rest.some((x) => f.includes(x));
const withFlag = (rest: string[], flag: string): string[] => (rest.includes(flag) ? rest : [...rest, flag]);
const text = (dir: string, file: string): string | null => { try { return readFileSync(join(dir, file), "utf8"); } catch { return null; } };
const quoted = (s: string): string[] => [...s.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
/** package.json `workspaces` (array, or {packages: []}): npm, yarn and bun. */
const pkgWorkspaces = (dir: string): string[] => {
  try {
    const w = (JSON.parse(text(dir, "package.json") ?? "{}") as { workspaces?: unknown }).workspaces;
    const l = Array.isArray(w) ? w : (w as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};
/** pnpm-workspace.yaml `packages:` list (a leading ! excludes): block (indented or not) and inline lists. */
const pnpmWorkspaces = (dir: string): string[] => {
  const out: string[] = []; let inBlock = false;
  for (const l of (text(dir, "pnpm-workspace.yaml") ?? "").split("\n")) {
    const top = /^packages\s*:\s*(.*)$/.exec(l);
    if (top) {
      const v = top[1]!.replace(/\s+#.*$/, "").trim();
      inBlock = v === "" || v.startsWith("#");
      if (v.startsWith("[")) out.push(...v.slice(1, v.includes("]") ? v.indexOf("]") : undefined).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
      continue;
    }
    if (inBlock && /^[^\s#-]/.test(l)) inBlock = false;
    const m = inBlock ? /^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(l) : null;
    if (m) out.push(m[1]!);
  }
  return out;
};
/** `members` (and `exclude`, as ! patterns) of one TOML table such as [workspace] or [tool.uv.workspace]. */
const tomlWorkspace = (dir: string, file: string, header: string): string[] => {
  const t = text(dir, file); if (!t) return [];
  const at = t.indexOf(`[${header}]`); if (at < 0) return [];
  const body = t.slice(at + header.length + 2).split(/^\[/m)[0]!;
  const list = (k: string): string[] => quoted(new RegExp(`^\\s*${k}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(body)?.[1] ?? "");
  return [...list("members"), ...list("exclude").map((x) => `!${x}`)];
};
const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/^\.\//, "").replace(/\/+$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*").replace(/\?/g, "[^/]")}$`);
/** True when `pats` (a workspace declaration; ! excludes) includes the package at `rel` (posix, relative to the ancestor). */
const inWorkspace = (pats: string[], rel: string): boolean =>
  pats.some((g) => !g.startsWith("!") && globRe(g).test(rel)) && !pats.some((g) => g.startsWith("!") && globRe(g.slice(1)).test(rel));

/** The ecosystem table: one row per package manager, its official frozen form. `poetry install` already honors poetry.lock, so it is kept
 *  as written (`--no-root` would skip installing the project itself and break src-layout imports; `--sync` would delete environment
 *  packages the lock lacks). */
const LOCK_RULES: LockRule[] = [
  { tool: "npm", subs: ["install", "i", "ci"], locks: ["package-lock.json", "npm-shrinkwrap.json"], locked: (s) => s === "ci", build: (_s, r) => ["npm", "ci", ...r], ws: pkgWorkspaces },
  { tool: "pnpm", subs: ["install", "i"], locks: ["pnpm-lock.yaml"], locked: (_s, r) => has(r, "--frozen-lockfile") && !has(r, "--no-frozen-lockfile"), build: (_s, r) => ["pnpm", "install", ...withFlag(r.filter((x) => x !== "--no-frozen-lockfile"), "--frozen-lockfile")], ws: pnpmWorkspaces },
  { tool: "yarn", subs: ["", "install"], locks: ["yarn.lock"], locked: (_s, r) => has(r, "--immutable", "--frozen-lockfile"), build: (_s, r, c) => ["yarn", "install", ...withFlag(r, c.berry ? "--immutable" : "--frozen-lockfile")], ws: pkgWorkspaces },
  { tool: "bun", subs: ["install", "i", "ci"], locks: ["bun.lock", "bun.lockb"], locked: (s, r) => s === "ci" || has(r, "--frozen-lockfile"), build: (_s, r) => ["bun", "install", ...withFlag(r, "--frozen-lockfile")], ws: pkgWorkspaces },
  { tool: "uv", subs: ["sync"], locks: ["uv.lock"], locked: (_s, r, e) => has(r, "--locked") || e.some((x) => /^UV_(FROZEN|LOCKED)=(?!0$|false$|$)/i.test(x)), build: (_s, r) => ["uv", "sync", ...withFlag(r.filter((x) => x !== "--frozen"), "--locked")], ws: (d) => tomlWorkspace(d, "pyproject.toml", "tool.uv.workspace") },
  { tool: "poetry", subs: ["install"], locks: ["poetry.lock"], locked: () => true, build: (_s, r) => ["poetry", "install", ...r] },
  { tool: "pipenv", subs: ["install", "sync"], locks: ["Pipfile.lock"], locked: (_s, r) => has(r, "--deploy"), build: (_s, r) => ["pipenv", "install", ...withFlag(r, "--deploy")] },
  { tool: "cargo", subs: ["fetch", "build"], locks: ["Cargo.lock"], locked: (_s, r) => has(r, "--locked", "--frozen"), build: (s, r) => ["cargo", s, ...withFlag(r, "--locked")], ws: (d) => tomlWorkspace(d, "Cargo.toml", "workspace") },
  { tool: "bundle", subs: ["", "install"], locks: ["Gemfile.lock"], locked: (_s, r, e) => e.includes("BUNDLE_FROZEN=true") || has(r, "--frozen", "--deployment"), build: (_s, r) => ["bundle", "install", ...r] },
  { tool: "composer", subs: ["install", "update"], locks: ["composer.lock"], locked: (s) => s === "install", build: (_s, r) => ["composer", "install", ...r] },
];
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
/** Yarn Berry (2+): .yarnrc.yml beside the lockfile or package.json packageManager yarn@>=2; anything else is Classic. */
function isYarnBerry(dir: string): boolean {
  if (existsSync(join(dir, ".yarnrc.yml"))) return true;
  try { return /^yarn@([2-9]|\d{2,})/.test(String((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { packageManager?: unknown }).packageManager ?? "")); } catch { return false; }
}

/** Maps (package root contents, model install command) to the command actually run: each install segment whose tool has a governing
 *  lockfile (see lockDir) becomes the ecosystem's frozen form; an already-locked form is kept; a segment that names packages, has no
 *  governing lockfile, runs in a directory that cannot be resolved, is joined to a `||` fallback or matches no rule is kept as written and the result
 *  says it is not locked. A `cd X` segment moves the lookup to X. Never guesses a package manager. */
export function lockedInstall(repoDir: string, cwd: string, modelCmd: string): LockedInstall {
  const parts = modelCmd.split(/(\s*(?:&&|\|\||;|\n)\s*)/);
  // Shell reads `a && b || c` as `(a && b) || c`: a `||` masks a failure anywhere earlier in its `;`/newline-separated list.
  const listOf: number[] = []; let li = 0;
  parts.forEach((p, k) => { listOf[k] = li; if (k % 2 === 1 && /[;\n]/.test(p)) li++; });
  const masked = new Set(parts.flatMap((p, k) => (k % 2 === 1 && p.includes("||") ? [listOf[k]!] : [])));
  const notes: string[] = [];
  let hits = 0, locked = true, rewritten = false, cur: string | null = realpathSync(cwd);
  const out = parts.map((seg, k) => {
    if (k % 2 === 1) return seg;
    const w = seg.trim().split(/\s+/).filter(Boolean), e = w.findIndex((x) => !/^[A-Za-z_]\w*=/.test(x));
    if (e < 0) return seg;
    const env = w.slice(0, e), tool = w[e]!, hasSub = w[e + 1] !== undefined && !w[e + 1]!.startsWith("-"), sub = hasSub ? w[e + 1]! : "";
    if (tool === "cd") {
      try { cur = cur !== null && w.length === e + 2 && !/[$~`*]/.test(w[e + 1]!) && !w[e + 1]!.startsWith("-") ? realpathSync(join(cur, w[e + 1]!)) : null; } catch { cur = null; }
      return seg;
    }
    const rule = LOCK_RULES.find((r) => r.tool === tool && r.subs.includes(sub));
    if (!rule) return seg;
    hits++;
    if (masked.has(listOf[k]!)) { locked = false; notes.push("fallback masks install failure"); return seg; }
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
  return { cmd: rewritten ? out.join("") : modelCmd, locked, rewritten, ...(!locked ? { note: `install not lockfile-locked: ${notes.join("; ")}` } : rewritten ? { note: "install rewritten to its lockfile-frozen form" } : {}) };
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
export async function intakeDeps(ctx: Pick<RunContext, "repoDir" | "runId" | "emit">, signal: AbortSignal, runners: RunnerName[]): Promise<Record<string, unknown>> {
  const model = loadProjectApi(ctx.repoDir), roots = absentDepRoots(ctx.repoDir, model), before = untrackedTops(ctx.repoDir);
  const r = await prepareDeps({ repoDir: ctx.repoDir, model, failed: roots.map((root) => ({ root, harnessOwned: true })), signal, timeoutMs: INSTALL_CAP_MS, opts: { runId: ctx.runId } });
  for (const c of r.checks) ctx.emit("deps.install", "intake", { ...c });
  const created = r.checks.some((c) => c.result === "pass") ? installCreatedSince(ctx.repoDir, before) : null; // a failed install records nothing, so nothing is hidden
  baselineSuites(ctx.repoDir, fullSuiteSpecs(ctx.repoDir, runners), { rerun: r.checks.some((c) => c.result === "pass") });
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
