// E-09 Fast verify (ENGINE.md 4 "Fast verify", 16 E-09). Runs impacted + changed test files + Wall tests,
// plus lint/typecheck of changed files, each under one per-check timeout. A missing tool is NOT PROVEN
// ("not_run"), never a failure; a failing check gets one rerun, fail-then-pass is "flaky". An empty diff with
// the already_done marker seals ALREADY_SATISFIED; without it, FAILED (ENGINE.md 2). Reaches testmap.ts/
// machine.ts only through RunContext's `tests: TestMapProvider`, injected as a fake in tests, never imported here.
import { scopedOutOf } from "../../project_model/scope.ts";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { testConfigChanged } from "../../features/runner_config.ts"; import { assertDeltaNotes } from "../../e10ext/assert_delta.ts"; import { failIds } from "../failures.ts";
import { failedFirst } from "../../e10ext/select.ts"; import { harnessLoadReason } from "../../runner/load_owner.ts";
import { loadRepoMap, namedFiles } from "../sizing.ts";
import { isTestFile } from "../testmap.ts";
import { failureExcerpt, truncateBytes, EXCERPT_TOTAL_CAP, changedFiles, classifyCheck, classifyRisk, diffFiles, markExecuted, recordRisk, plainTestEnv, stripAnsi, goRunner, hasExecutedProof, ran, skipped, summaryPassFailCount } from "../../util/check_result.ts";
import { WALL_COMPILE_REASON, wallOwnedFailure } from "../../util/wall_owned.ts"; import { isHoldoutCheck, recordHoldoutTriage, stageHoldout } from "../../util/holdout.ts";
import type { ImplementExit, RunContext, Stage, StageResult, TestRef } from "../types.ts";
import { STAGE_BUDGETS } from "../types.ts";
import type { ProjectApi } from "../../project_model/api.ts"; import { groupByPackage, loadProjectApi, siteFor } from "../../project_model/resolve.ts";
import { safeGit } from "../../util/safe_git.ts"; import { attribute, attributeFullSuite, staticPreExisting, type StaticTool } from "../../runner/repo_profile.ts";
const CHECK_TIMEOUT_MS = 60_000; // ENGINE.md 16 E-09: "60s limit" per check; limitS (120s) is the stage's outer bound
/** implement.ts's full stage.completed.data isn't in the shared contract yet; this is the one
 *  field verify.ts reads from it (ImplementExit itself IS a contract type, types.ts). */
interface ImplementOutput {
  exit?: ImplementExit;
}
/** wall.ts's full output isn't in the contract either; only the sealed file list, shaped like
 *  Receipt["wall"].files, is needed here. */
interface WallOutput {
  files?: { path: string }[];
  holdout_dir?: string; // P12-05: private store of the held-out Wall tests
}
type Interpreter = "project" | "system";
export interface VerifyCheck {
  name: string;
  cmd: string;
  result: "pass" | "fail" | "not_run" | "flaky"; // ENGINE.md section 5 test.result enum
  duration_s: number;
  reason?: string; n?: number; sk?: number; ids?: string[]; first_error?: string; // A-112: failing test ids; A-113: first failing output line, normalized; feeds the stall signature
  interpreter?: Interpreter; // E-98a: which python/ruff this check actually ran on
  owner?: "harness"; // FC-02: the runner could not load or collect; not_run, never a code failure
}
// E-98a B2: .venv, then venv, then an in-repo (realpath under repoDir) VIRTUAL_ENV are "project";
// else <fallback> on PATH, or <lastResort> literal, is "system" -- never proven against repo sources.
function resolveTool(repoDir: string, bin: string, fallback: string, lastResort = fallback): [string, Interpreter, string[]] {
  const inRepo = (p: string): boolean => { try { const r = relative(realpathSync(repoDir), realpathSync(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); } catch { return false; } };
  const venvEnv = process.env["VIRTUAL_ENV"], onPath = (b: string): string | null => Bun.which(b, { PATH: process.env["PATH"] ?? "" }); // Bun.which caches the startup PATH unless given the live one
  const project = [join(repoDir, ".venv", "bin", bin), join(repoDir, "venv", "bin", bin), ...(venvEnv && inRepo(venvEnv) ? [join(venvEnv, "bin", bin)] : [])].find(existsSync);
  return project ? [project, "project", []] : existsSync(join(repoDir, "uv.lock")) && onPath("uv") ? ["uv", "project", ["run", "--", bin]] : [onPath(fallback) ? fallback : lastResort, "system", []]; // TEN-QUALITY-11: uv.lock, no venv: uv run is the project interpreter
}
// Command shapes exactly as ENGINE.md section 8's table names them per runner (npm/cargo are
// "coarse": no per-file selection; go runs per package dir, also coarse below that grain).
export function runnerCmd(t: TestRef, repoDir: string): [string, string[], Interpreter?] {
  switch (t.runner) {
    case "pytest": {
      const [cmd, interpreter, pre] = resolveTool(repoDir, "python", "python3", "python");
      return [cmd, [...pre, "-m", "pytest", "-q", t.path], interpreter];
    }
    case "vitest": return ["npx", ["--no-install", "vitest", "run", t.path]];
    case "jest": return ["npx", ["--no-install", "jest", t.path]];
    case "bun": return ["bun", ["test", t.path]];
    case "node": return ["node", ["--test", `./${t.path}`]];
    case "npm": return ["npm", ["test", "--silent"]];
    case "go": return ["go", ["test", "-json", `./${dirname(t.path)}`]];
    case "cargo": return ["cargo", ["test"]];
  }
}
/** FC-01: the one resolver for a test invocation: a package-owned file runs in its package dir with a package-relative path, else exactly runnerCmd at the root. */
export function commandFor(t: TestRef, repoDir: string, api?: ProjectApi | null): { cwd: string; cmd: string; args: string[]; argv: string[]; interpreter?: Interpreter; pkgRoot: string } {
  const site = siteFor(api, repoDir, t.path);
  const [cmd, args, interpreter] = runnerCmd(site ? { runner: t.runner, path: site.file } : t, repoDir);
  return { cwd: site?.cwd ?? repoDir, cmd, args, argv: [cmd, ...args], ...(interpreter ? { interpreter } : {}), pkgRoot: site?.root ?? "." };
}
/** TEN-QUALITY-01: stage-local failure excerpts keyed by check object; never on VerifyCheck, never emitted, never set for a held-out check. */
const excerpts = new WeakMap<object, string>();
const isHold = (c: { name: string }): boolean => isHoldoutCheck(c.name); // C-C4b-c: pubHold is the one public shape of a held-out check: result and counts only
const pubHold = (c: VerifyCheck): VerifyCheck => ({ name: "holdout", cmd: "holdout", result: c.result, duration_s: c.duration_s, ...(c.n !== undefined ? { n: c.n } : {}), ...(c.sk !== undefined ? { sk: c.sk } : {}), ...(c.owner ? { owner: c.owner, reason: "holdout infrastructure failure" } : {}) });
/** The one check name a test run gets: runner:path. Provenance (check_result.ts) parses this shape. */
export const testCheckName = (t: { runner: string; path: string }): string => `${t.runner}:${t.path}`;
const dedupeTests = (tests: TestRef[]): TestRef[] => [...new Map(tests.map((t) => [`${t.runner}:${t.path}`, t] as const)).values()];
export { changedFiles } from "../../util/check_result.ts"; // one owner: check_result.ts (diffFiles builds on it)
interface RunOpts {
  path?: string; // PATH override, tests only, so "missing tool" never depends on the host
  stdin?: string;
  protect?: boolean; // FC-02: Wall or task-relevant check, never harness-owned
  timeoutMs?: number; // per-attempt timeout override, tests only; defaults to CHECK_TIMEOUT_MS
  interpreter?: Interpreter; // E-98a: recorded on the resulting VerifyCheck as-is
  cwd?: string; // FC-01: directory the check runs in (the owning package); defaults to ctx.repoDir
  wall?: ReadonlySet<string>; // FC-23: repo-relative Wall files; a static check failing only inside them is harness-owned
  opaque?: boolean; // C-C4b-c: held-out check, its event and public record carry no id, message or output
  kind?: "test" | "static"; // FC-16: "test" (default) needs a parsed executed count n>0 to pass; "static" (lint, typecheck, selector) is decided by exit code
}
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go)$/; // the extensions testmap.ts maps (JS/TS, Python, Go)
export { ran, skipped } from "../../util/check_result.ts"; // FC-16: the one shared count parser and classifier live in check_result.ts
export { testConfigChanged } from "../../features/runner_config.ts"; // D86 FC-09r: the one runner-config registry lives in features/
/** `cut` means the timeout or the stage's AbortSignal killed the child: never read as "fail" and
 *  never retried (a hung check must not burn 2x its timeout). `out` is a 64 KB tail, unread when cut. The result comes from exit + timeout, never pipe EOF (an orphaned grandchild may hold the pipes). */
async function runOnce(cmd: string, args: string[], cwd: string, signal: AbortSignal, opts: RunOpts): Promise<{ ok: boolean; missing: boolean; cut: boolean; out: string }> {
  if (!Bun.which(cmd, { PATH: opts.path ?? process.env["PATH"] ?? "" })) return { ok: false, missing: true, cut: false, out: "" };
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS);
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.any([signal, timeout]),
    env: opts.path ? { ...plainTestEnv(), PATH: opts.path } : plainTestEnv(), // FC-69
  });
  let tail = ""; const rs = [proc.stdout, proc.stderr].map((s) => s.getReader());
  const pumps = rs.map(async (r) => { const d = new TextDecoder(); for (;;) { const c = await r.read().catch(() => ({ done: true, value: undefined })); if (c.done) return; tail = (tail + d.decode(c.value, { stream: true })).slice(-65536); } });
  const exitCode = await proc.exited;
  await Promise.race([Promise.all(pumps), new Promise((r) => setTimeout(r, 300))]); rs.forEach((r) => r.cancel().catch(() => {}));
  const cut = timeout.aborted || signal.aborted;
  return { ok: exitCode === 0 && !cut, missing: false, cut, out: cut ? "" : stripAnsi(tail) }; // FC-69
}
export function firstError(out: string): string { // the line naming the failing test, minus what varies between identical failures (A-113 stall signature)
  const goOut = (l: string): string => { try { const e = JSON.parse(l) as { Action?: string; Output?: string }; return typeof e.Action === "string" ? (e.Action === "output" || e.Action === "build-output" ? (e.Output ?? "") : "") : l; } catch { return l; } }; // Go json event stream: the failing line is inside the event's Output
  const lines = out.slice(-65536).split("\n").map((l) => (l.startsWith("{") ? goOut(l) : l).trim()).filter(Boolean), l =lines.find((x) => /^(FAILED\s|\u25cf\s.*\u203a|not ok\s|_{3,}\s.+\s_{3,}$)/.test(x)) ?? lines.find((x) => /^[\w./-]+\.go:\d+:\d+: \S/.test(x)) /* go compiler line, before "FAIL pkg [build failed]" */ ?? lines.find((x) => /fail|error/i.test(x) && !/^(=|\u2713|ok\b|PASS)/.test(x)) ?? "";
  return l.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "").replace(/(^|\s)\/(?:[\w.@-]+\/)*[\w.@-]+/g, "$1<path>").replace(/:\d+(?::\d+)?/g, "").replace(/\[?\d+(?:\.\d+)?m?s\]?/g, "").replace(/\s+/g, " ").slice(0, 160);
}
/** Runs one check with a single retry: fail-then-pass is "flaky", not "fail". A missing tool, a
 *  timed-out/aborted run, or a run that executed 0 tests is recorded once as not_run and never retried. */
export async function runCheck(
  ctx: RunContext, name: string, cmd: string, args: string[], signal: AbortSignal,
  checks: VerifyCheck[], opts: RunOpts = {},
): Promise<VerifyCheck> {
  const started = Date.now();
  const cmdStr = [cmd, ...args].join(" ");
  const kind = opts.kind ?? "test";
  const cwd = opts.cwd ?? ctx.repoDir;
  const one = async (a: Awaited<ReturnType<typeof runOnce>>) => {
    let c: ReturnType<typeof classifyCheck> & { owner?: "harness" } = classifyCheck({ kind, ok: a.ok, cut: a.cut, missing: a.missing, out: a.out, ...goRunner(cmd, args), path: /\.[cm]?[jt]s$/.test(args[args.length - 1] ?? "") ? args[args.length - 1] : undefined });
    const lr = kind === "test" && !a.ok && !a.cut && !a.missing ? await harnessLoadReason({ repoDir: ctx.repoDir, baseSha: ctx.baseSha, out: a.out, cmd, args, signal, cwd, protect: opts.protect, ...(opts.path ? { env: { PATH: opts.path } } : {}) }) : undefined; // FC-02: only kind "test"; lint/tsc/selector (kind "static") never reach it
    if (lr) c = { result: "not_run", reason: lr, owner: "harness" };
    if (!lr && kind === "static" && !a.ok && !a.cut && !a.missing && opts.wall?.size && wallOwnedFailure(a.out, cwd, ctx.repoDir, opts.wall)) c = { result: "not_run", reason: WALL_COMPILE_REASON, owner: "harness" }; // FC-23: never a fix round on a read-only Wall file // harness-owned load error: never retried, never a fix round
    const reason = a.missing ? `${cmd} not found on PATH` : a.cut ? (signal.aborted ? "aborted" : `timed out after ${(opts.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000}s`) : c.reason;
    return { ...c, ...(reason ? { reason } : {}) };
  };
  let attempt = await runOnce(cmd, args, cwd, signal, opts);
  let c = await one(attempt);
  let result: VerifyCheck["result"] = c.result;
  if (c.result === "fail") {
    attempt = await runOnce(cmd, args, cwd, signal, opts);
    c = await one(attempt);
    result = c.result === "not_run" ? "not_run" : c.result === "pass" ? "flaky" : "fail";
  }
  const reason = c.reason;
  const check: VerifyCheck = { name, cmd: cmdStr, result, duration_s: (Date.now() - started) / 1000, ...(result === "fail" ? { first_error: firstError(attempt.out), ids: failIds(attempt.out) } : result === "pass" && kind === "test" ? { n: c.n ?? 0, sk: skipped(attempt.out) } : {}), ...(reason ? { reason } : {}), ...(c.owner ? { owner: "harness" as const } : {}), ...(opts.interpreter ? { interpreter: opts.interpreter } : {}) };
  if (result === "fail" && !opts.opaque && !isHold(check)) excerpts.set(check, failureExcerpt(attempt.out, ctx.repoDir));
  checks.push(check); if (opts.opaque && check.result !== "pass" && check.reason) recordHoldoutTriage(ctx.runDir, { check: name, result: check.result, reason: check.reason }); // C-C4b-c-b: real reason stays out of the event below
  ctx.emit("test.result", "verify", opts.opaque ? { ...pubHold(check) } : { ...check });
  return check;
}
type Counts = { run: number; skipped: number };
type BaseSubtraction = { ids: string[]; names: string[]; weak: string[]; cnt: Record<string, { b: Counts; h: Counts }> };
/** A-112: a test check red on head, in a file the diff did not touch, whose every failing id is also red on a pristine detached base
 *  worktree (never a reset of the implement tree, D42 (2)) is pre_red: ids go to NOT PROVEN, seal skips it in the verdict, the check stays
 *  "fail" and in the fix loop unless the TARGET progressed: a passing Wall test, or a relevant test (`rel`: impacted tests of the task-named
 *  files, the lean-path Wall stand-in) that failed on base, now passes and ran no fewer tests (absent or skipped is not green). Relevant checks
 *  are never pre_red. Base reruns get no node_modules or .venv: a dependency-only failure yields no ids (failIds needs the count covered).
 *  A-115: a relevant check that passes with more skipped or deselected tests than base is `weak`: no progress, and the caller lists it in
 *  NOT PROVEN (a skipped target is not a fixed target). Weak also means it ran FEWER tests than base (pytest.exit, xfail, a deleted test):
 *  every relevant pass is compared with its base run, and xfailed counts as skipped, never passed.
 *  ponytail: bun/go/cargo/npm yield no ids and no skip count, so they are never subtracted or judged weak. */
async function subtractBase(
  ctx: RunContext, api: ProjectApi | null, checks: VerifyCheck[], tests: TestRef[], changed: string[],
  wall: Set<string>, rel: Set<string>, signal: AbortSignal,
): Promise<BaseSubtraction> {
  const out: BaseSubtraction = { ids: [], names: [], weak: [], cnt: {} };
  const pairs = checks.flatMap((c) => {
    const t = tests.find((x) => testCheckName(x) === c.name);
    return t ? [{ c, t }] : [];
  });
  const un = pairs.filter(({ t }) => !changed.includes(t.path));
  const sus = pairs.filter(({ c }) => rel.has(c.name) && c.result === "pass");
  if (!(un.some(({ c }) => c.result === "fail" && c.ids?.length) || sus.length) || signal.aborted) return out;
  const dir = mkdtempSync(join(tmpdir(), "e10-base-"));
  const git = (args: string[]): void => { safeGit(ctx.repoDir, args, { stdio: "ignore", repoDrivers: true }); }; // worktree add checks out base content
  try {
    git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, ctx.baseSha]);
    const base = new Map<VerifyCheck, { red: string[]; n: number; sk: number }>();
    for (const { c, t } of new Set([...un, ...sus])) {
      const bc = commandFor(t, dir, api);
      const b = await runOnce(bc.cmd, bc.args, bc.cwd, signal, {});
      const red = !b.ok && !b.cut ? failIds(b.out) : [];
      base.set(c, { red, n: ran(b.out) ?? summaryPassFailCount(b.out), sk: skipped(b.out) });
    }
    out.weak = sus
      .filter(({ c }) => (c.sk ?? 0) > base.get(c)!.sk || (c.n ?? 0) < base.get(c)!.n)
      .map(({ c }) => c.name);
    for (const { c } of sus) {
      out.cnt[c.name] = { b: { run: base.get(c)!.n, skipped: base.get(c)!.sk }, h: { run: c.n ?? 0, skipped: c.sk ?? 0 } };
    }
    // A-115b: sus includes an EDITED relevant file (its base-red ids now pass;
    // the caller's `weakened test:` note keeps it PARTIAL)
    const progress = checks.some((c) => wall.has(c.name) && c.result === "pass")
      || sus.some(({ c }) => !out.weak.includes(c.name) && base.get(c)!.red.length > 0 && (c.n ?? 0) >= base.get(c)!.n);
    if (progress) {
      for (const { c } of un) {
        if (!rel.has(c.name) && c.result === "fail" && c.ids?.length && c.ids.every((i) => base.get(c)!.red.includes(i))) {
          out.names.push(c.name);
          out.ids.push(...c.ids);
        }
      }
    }
  } catch { /* base unavailable: checks stay failing */ } finally {
    try { git(["worktree", "remove", "--force", dir]); } catch { /* pruned below */ }
    rmSync(dir, { recursive: true, force: true });
    try { git(["worktree", "prune"]); } catch { /* best effort */ }
  }
  return out;
}

// ponytail: existence of our own selector script is a strong enough marker
// that repoDir IS the loki-mode repo; a build target repo will not carry it.
function isLokiModeRepo(repoDir: string): boolean {
  return existsSync(join(repoDir, "scripts", "select-tests.sh"));
}
const ESLINT_CONFIGS = [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];
/** ENGINE.md section 4's named tool per language: bash -n + shellcheck for shell, tsc + eslint
 *  (when configured) for TS/JS, ruff for Python. Every named tool that applies to the changed set
 *  gets a check entry: a missing tool is not_run, never silently absent (section 9 NOT PROVEN). */
/** TEN-QUALITY-03: a failed ruff/shellcheck/eslint check whose every diagnostic is also on the base content (git show, fed on stdin, same per-check timeout) is pre-existing. */
const excuseLint = (ctx: RunContext, signal: AbortSignal, c: VerifyCheck, tool: StaticTool, cmd: string, prefix: string[], cwd: string, rel: string[], opts: RunOpts): Promise<boolean> => c.result !== "fail" || signal.aborted ? Promise.resolve(false) : staticPreExisting(tool, prefix, rel, { run: async (a, stdin) => { if (signal.aborted) return null; const r = await runOnce(cmd, a, cwd, AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS)]), { ...opts, ...(stdin !== undefined ? { stdin } : {}) }); return r.missing || r.cut ? null : r; }, base: (f) => { try { return safeGit(ctx.repoDir, ["show", `${ctx.baseSha}:${relative(ctx.repoDir, join(cwd, f))}`], { stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } } });
export async function runLintChecks(
  ctx: RunContext, changed: string[], signal: AbortSignal, checks: VerifyCheck[], opts: RunOpts & { api?: ProjectApi | null } = {},
): Promise<string[]> {
  const { api, ...runOpts } = opts; opts = runOpts; const pre: string[] = []; // check names whose static diagnostics are all pre-existing
  const py = changed.filter((f) => f.endsWith(".py"));
  if (py.length) {
    const [ruffCmd, interpreter, uvPre] = resolveTool(ctx.repoDir, "ruff", "ruff"); // E-98a: same project-first resolution as pytest
    const c = await runCheck(ctx, "lint:ruff", ruffCmd, [...uvPre, "check", "--output-format=concise", ...py], signal, checks, { ...opts, interpreter, kind: "static" });
    if (await excuseLint(ctx, signal, c, "ruff", ruffCmd, [...uvPre, "check"], ctx.repoDir, py, opts)) pre.push(c.name);
  }
  const sh = changed.filter((f) => f.endsWith(".sh"));
  if (sh.length) {
    await runCheck(ctx, "lint:bash-n", "bash", ["-c", 'for f in "$@"; do bash -n "$f" || exit 1; done', "_", ...sh], signal, checks, { ...opts, kind: "static" });
    const c = await runCheck(ctx, "lint:shellcheck", "shellcheck", sh, signal, checks, { ...opts, kind: "static" });
    if (await excuseLint(ctx, signal, c, "shellcheck", "shellcheck", [], ctx.repoDir, sh, opts)) pre.push(c.name);
  }
  // FC-01: tsc and eslint belong to the package that owns the file: config lookup, cwd and file paths are per package.
  for (const g of groupByPackage(api, ctx.repoDir, changed.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f)))) {
    const sfx = g.root === "." ? "" : `:${g.root}`, co = g.root === "." ? opts : { ...opts, cwd: g.cwd };
    if (existsSync(join(g.cwd, "tsconfig.json"))) await runCheck(ctx, `lint:tsc${sfx}`, "npx", ["--no-install", "tsc", "--noEmit", "-p", "."], signal, checks, { ...co, kind: "static" });
    if (ESLINT_CONFIGS.some((f) => existsSync(join(g.cwd, f)))) { const c = await runCheck(ctx, `lint:eslint${sfx}`, "npx", ["--no-install", "eslint", ...g.rel], signal, checks, { ...co, kind: "static" }); if (await excuseLint(ctx, signal, c, "eslint", "npx", ["--no-install", "eslint"], g.cwd, g.rel, co)) pre.push(c.name); }
  }
  return pre;
}
/** TEN-SPEED-18: LOKI_E10_VERIFY_JOBS, an integer 1..8; unset, invalid or below 1 means 1. */
export const verifyJobs = (): number => { const n = Number.parseInt(process.env["LOKI_E10_VERIFY_JOBS"] ?? "", 10); return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 1; };
export const verifyStage: Stage = {
  name: "verify",
  targetS: STAGE_BUDGETS.verify.targetS,
  limitS: STAGE_BUDGETS.verify.limitS,
  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    let changed: string[];
    try {
      changed = changedFiles(ctx.repoDir, ctx.baseSha);
    } catch (err) {
      return { status: "failed", data: {}, reason: `git diff against base failed: ${(err as Error).message}` };
    }
    if (changed.length === 0) {
      const implementExit = (ctx.outputs().implement as ImplementOutput | undefined)?.exit;
      if (implementExit === "already_done") {
        return { status: "completed", data: { already_satisfied: true, checks: [], flaky: [], failures_grouped: [], changed_files: [] } };
      }
      return { status: "failed", data: { changed_files: [] }, reason: "empty diff without an already_done marker" };
    }
    let risk = (() => { try { const r = classifyRisk(diffFiles(ctx.repoDir, ctx.baseSha)); recordRisk(ctx.repoDir, r); return r; } catch { return null; } })(); // RISKTIER: artifact-based tier, recorded; deferred checks are never a pass
    const checks: VerifyCheck[] = [];
    const api = loadProjectApi(ctx.repoDir); // FC-01: null (repo-root behavior) unless the model has a package below the root
    const map = await ctx.tests.detect(ctx.repoDir);
    const impacted = ctx.tests.impacted(map, changed);
    const changedTestFiles = map.tests.filter((t) => changed.includes(t.path));
    const wall = (ctx.outputs().wall as WallOutput | undefined) ?? {};
    // E-56: wall.ts seals files under an absolute targetDir; normalize to repo-relative so an
    // absolute Wall path still matches and runs in fast verify.
    const wallPaths = new Set(
      (wall.files ?? []).map((f) => (isAbsolute(f.path) ? relative(ctx.repoDir, f.path) : f.path)),
    );
    const wallTests = map.tests.filter((t) => wallPaths.has(t.path));
    // A-114: the relevant tests of the task-named files are always selected, whatever the diff touches.
    const intake = ctx.outputs().intake as { task?: string; repomap_ref?: string } | undefined, relevant = ctx.tests.impacted(map, namedFiles(intake?.task ?? "", loadRepoMap(intake?.repomap_ref)));
    const tests = failedFirst(dedupeTests([...impacted, ...changedTestFiles, ...wallTests, ...relevant]), (ctx.outputs().verify as { checks?: Array<{ name?: unknown; result?: unknown }> } | undefined)?.checks); // TEN-SPEED-07
    const scopedOut = scopedOutOf(map); // FC-22: audit trail for package-scoped selection (LOKI_E10_SCOPE=1)
    if (scopedOut.length) ctx.emit("test.scoped_out", "verify", { tests: scopedOut });
    const slots = tests.map(() => [] as VerifyCheck[]); let next = 0; // TEN-SPEED-18: LOKI_E10_VERIFY_JOBS bounds concurrent test processes; slots keep the selected (failed-first) order whatever order they finish in
    const work = async (): Promise<void> => { while (next < tests.length && !signal.aborted) { const i = next++, t = tests[i]!, tc = commandFor(t, ctx.repoDir, api); await runCheck(ctx, testCheckName(t), tc.cmd, tc.args, signal, slots[i]!, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), protect: [...wallTests, ...relevant].includes(t), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) }); } };
    await Promise.all(Array.from({ length: Math.min(verifyJobs(), tests.length) }, work)); checks.push(...slots.flat());
    const hold = wall.holdout_dir ? stageHoldout(wall.holdout_dir, ctx.repoDir) : null; // P12-05: held-out Wall tests, copied in under neutral names for this run only, blocking (protect), named holdout:N internally and "holdout" in every record that leaves this stage
    try { for (const [i, h] of (hold?.tests ?? []).entries()) { if (signal.aborted) break; const t = h as TestRef, tc = commandFor(t, ctx.repoDir, api); await runCheck(ctx, `holdout:${i + 1}`, tc.cmd, tc.args, signal, checks, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), protect: true, opaque: true, ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) }); } } finally { hold?.cleanup(); }
    if (hold?.missing.length) { for (const m of hold.missing) recordHoldoutTriage(ctx.runDir, { check: "holdout:store", result: "not_run", reason: m }); const k: VerifyCheck = { name: "holdout:store", cmd: "holdout", result: "not_run", duration_s: 0, reason: "holdout store unavailable", owner: "harness" }; checks.push(k); ctx.emit("test.result", "verify", { ...pubHold(k) }); } // C-C4b-c: a store failure is a harness/infrastructure failure (not_run, no fix round), never a test failure the fixer sees; the missing-file text stays out of the log
    const targetNames = new Set([...[...wallTests, ...relevant].map(testCheckName), ...checks.filter(isHold).map((c) => c.name)]); // FC-21b: Wall and task-named tests, the proof a limit-stopped run needs
    const preRed = await subtractBase(ctx, api, checks, tests, changed, new Set(wallTests.map(testCheckName)), new Set(relevant.map(testCheckName)), signal);
    // REPOMEM: a failing, untouched, non-target test whose every id was already red in the intake baseline (same base commit) is pre-existing: never blocks. Anything else that fails is introduced and always blocks.
    const attr = attribute(ctx.repoDir, ctx.baseSha, checks.filter((c) => c.result === "fail" && !preRed.names.includes(c.name)).map((c) => ({ name: c.name, ids: c.ids, eligible: !targetNames.has(c.name) && !changed.includes(c.name.slice(c.name.indexOf(":") + 1)) })));
    attr.introducedChecks = [...new Set(attr.introducedChecks.map((n) => (isHoldoutCheck(n) ? "holdout" : n)))]; preRed.names.push(...attr.preExistingChecks); preRed.ids.push(...attr.preExistingIds);
    if (!signal.aborted) {
      // Lint/typecheck of changed files only (ENGINE.md section 4's named tool per language).
      const lintPre = await runLintChecks(ctx, changed, signal, checks, { api, wall: wallPaths });
      preRed.names.push(...lintPre); // TEN-QUALITY-03: the same pre-existing path tests use
      if (lintPre.length) attr.line = [attr.line, `baseline: ${lintPre.join(", ")} static diagnostics already on base (not blocking)`].filter(Boolean).join("; ");
      // Self-hosting only: also run the repo's own fast-gate selector (section 4).
      if (isLokiModeRepo(ctx.repoDir)) {
        await runCheck(ctx, "select-tests", "bash", ["scripts/select-tests.sh", "--files", "-", "--run"], signal, checks, {
          kind: "static", // the selector reruns tests whose counts are not parsed here; per-file test checks carry the proof
          stdin: changed.join("\n") + "\n",
        });
      }
    }
    const fullNotProven = new Set<string>(); // no-runner entries are dropped at not_proven: nothing ran, and the risk record keeps the full test command deferred
    if (risk && risk.tier !== "low" && !signal.aborted) { // RISKTIER: medium and high run the detected full test command (deep.ts runner table); the reviewer, council and security scan stay recorded as not run
      const { runFullSuite } = await import("./deep.ts"); // lazy: deep.ts imports this module
      const full: Parameters<typeof runFullSuite>[3] = [];
      await runFullSuite(ctx, signal, {}, full, fullNotProven);
      for (const c of full) { const k: VerifyCheck = { name: c.name, cmd: c.cmd, result: c.result as VerifyCheck["result"], duration_s: c.duration_s, ...(c.reason ? { reason: c.reason } : {}) }; checks.push(k); ctx.emit("test.result", "verify", { ...k }); } // P12-01: full-suite checks leave the same test.result evidence per-file checks do
      const fa = attributeFullSuite(ctx.repoDir, ctx.baseSha, full, checks.filter((c) => c.result === "fail" && !preRed.names.includes(c.name)).flatMap((c) => c.ids ?? []), changed); preRed.names.push(...fa.preExistingChecks); preRed.ids.push(...fa.preExistingIds); attr.introducedChecks.push(...fa.introducedChecks); attr.line = [attr.line, fa.line].filter(Boolean).join("; ") || null; // REPOMEM: same attribution for the full suite
      if (full.some((c) => c.result === "pass" || c.result === "fail")) { risk = markExecuted(risk, ["full test command", "full suite"]); recordRisk(ctx.repoDir, risk); }
    }
    const cfgChanged = testConfigChanged(ctx.repoDir, ctx.baseSha, changed); // FC-21b: also feeds uncovered_changed
    const covered = (f: string): boolean => ctx.tests.impacted(map, [f]).some((t) => checks.some((c) => c.name === testCheckName(t) && hasExecutedProof([c])));
    const uncoveredChanged = changed.filter((f) => CODE_EXT.test(f) && !isTestFile(f) && !wallPaths.has(f) && !cfgChanged.includes(f) && !covered(f)); // FC-21b: changed code no passing impacted check ran; seal denies VERIFIED after a limit
    const flaky = checks.filter((c) => c.result === "flaky").map((c) => (isHold(c) ? "holdout" : c.name));
    // ponytail: real clustering is failures.ts, which depends on this stage; a naive 1:1
    // placeholder keeps the section-4 output key populated until that slice lands.
    let excerptLeft = EXCERPT_TOTAL_CAP; // TEN-QUALITY-01: sample = rerun cmd + redacted excerpt, 6 KB across all groups
    const failuresGrouped = checks
      .filter((c) => c.result === "fail" && !preRed.names.includes(c.name) && !isHold(c))
      .map((c) => {
        const x = isHold(c) ? "" : truncateBytes(excerpts.get(c) ?? "", Math.max(0, excerptLeft));
        excerptLeft -= Buffer.byteLength(x);
        return { signature: c.first_error ? `${c.name} ${c.first_error}` : c.name, count: 1, sample: x ? `${c.cmd}\n${x}` : c.cmd };
      });
    const pub = checks.map((c) => (isHold(c) ? pubHold(c) : c)), holdoutFailed = checks.filter((c) => c.result === "fail" && isHold(c) && !preRed.names.includes(c.name)).length; // C-C4b-c: pub leaves this stage, holdoutFailed (C-C4b) is the only form in which a held-out failure reaches the fix stage
    // E-98a/E-115: a check that ran (not_run has its own NOT PROVEN entry at seal) on a system interpreter/ruff.
    // A-115: test configuration edits and relevant checks with more skips than base are listed, which makes the verdict PARTIAL at seal.
    const inBase = (f: string): boolean => { try { safeGit(ctx.repoDir, ["cat-file", "-e", `${ctx.baseSha}:${f}`], { stdio: "ignore" }); return true; } catch { return false; } };
    const testCounts: Record<string, unknown> = {}; const modifiedRel = relevant.filter((t) => changed.includes(t.path) && inBase(t.path)).flatMap((t) => { const k = preRed.cnt[testCheckName(t)]; if (k) testCounts[t.path] = k; return [`weakened test: ${t.path}`, ...(assertDeltaNotes(ctx.repoDir, ctx.baseSha, null, t.path, intake?.task ?? "", k?.b, k?.h) ?? [])]; }); // a relevant test file edited: NOT VERIFIED (seal lists the same line)
    const weakened = [...modifiedRel, ...cfgChanged.map((f) => `test configuration changed: ${f}`), ...preRed.weak.map((n) => `skipped or fewer tests than base: ${n}`)];
    const notProven = [...weakened, ...pub.filter((c) => c.name === "holdout" && c.result !== "pass").map((c) => (c.result === "not_run" ? "holdout not executed" : "holdout check failed")), ...[...fullNotProven].filter((n) => !n.startsWith("full suite (no test runner")), ...pub.filter((c) => c.owner === "harness" && c.name !== "holdout").map((c) => `${c.reason} (${c.name}; harness-owned, no fix rounds)`), ...new Set(checks.filter((c) => c.interpreter === "system" && c.result !== "not_run").map((c) => (c.name.startsWith("lint:") ? "lint ran on the system ruff" : "tests ran on the system interpreter")))];
    return { status: "completed", data: { checks: pub, flaky, failures_grouped: failuresGrouped, holdout_failed: holdoutFailed, changed_files: changed, not_proven: notProven, pre_red: preRed.ids, pre_red_checks: preRed.names, ...(attr.line ? { baseline_line: attr.line, introduced_checks: attr.introducedChecks } : {}), test_counts: testCounts, uncovered_changed: uncoveredChanged, target_checks: checks.filter((c) => c.result === "pass" && targetNames.has(c.name)).map((c) => (isHold(c) ? "holdout" : c.name)), risk } };
  },
};
export const stage = verifyStage;
