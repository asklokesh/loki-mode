// E-09 Fast verify (ENGINE.md 4 "Fast verify", 16 E-09). Runs impacted + changed test files + Wall tests,
// plus lint/typecheck of changed files, each under one per-check timeout. A missing tool is NOT PROVEN
// ("not_run"), never a failure; a failing check gets one rerun, fail-then-pass is "flaky". An empty diff with
// the already_done marker seals ALREADY_SATISFIED; without it, FAILED (ENGINE.md 2). Reaches testmap.ts/
// machine.ts only through RunContext's `tests: TestMapProvider`, injected as a fake in tests, never imported here.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { assertDeltaNotes } from "../../e10ext/assert_delta.ts"; import { failIds } from "../failures.ts";
import { harnessLoadReason } from "../../runner/load_owner.ts";
import { loadRepoMap, namedFiles } from "../sizing.ts";
import { classifyCheck, ran, skipped } from "../../util/check_result.ts";
import type { ImplementExit, RunContext, Stage, StageResult, TestRef } from "../types.ts";
import { STAGE_BUDGETS } from "../types.ts";
import type { ProjectApi } from "../../project_model/api.ts"; import { groupByPackage, loadProjectApi, siteFor } from "../../project_model/resolve.ts";
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
function resolveTool(repoDir: string, bin: string, fallback: string, lastResort = fallback): [string, Interpreter] {
  const inRepo = (p: string): boolean => { try { const r = relative(realpathSync(repoDir), realpathSync(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); } catch { return false; } };
  const venvEnv = process.env["VIRTUAL_ENV"];
  const project = [join(repoDir, ".venv", "bin", bin), join(repoDir, "venv", "bin", bin), ...(venvEnv && inRepo(venvEnv) ? [join(venvEnv, "bin", bin)] : [])].find(existsSync);
  return project ? [project, "project"] : [Bun.which(fallback) ? fallback : lastResort, "system"];
}
// Command shapes exactly as ENGINE.md section 8's table names them per runner (npm/cargo are
// "coarse": no per-file selection; go runs per package dir, also coarse below that grain).
export function runnerCmd(t: TestRef, repoDir: string): [string, string[], Interpreter?] {
  switch (t.runner) {
    case "pytest": {
      const [cmd, interpreter] = resolveTool(repoDir, "python", "python3", "python");
      return [cmd, ["-m", "pytest", "-q", t.path], interpreter];
    }
    case "vitest": return ["npx", ["vitest", "run", t.path]];
    case "jest": return ["npx", ["jest", t.path]];
    case "bun": return ["bun", ["test", t.path]];
    case "node": return ["node", ["--test", `./${t.path}`]];
    case "npm": return ["npm", ["test", "--silent"]];
    case "go": return ["go", ["test", "-v", `./${dirname(t.path)}`]];
    case "cargo": return ["cargo", ["test"]];
  }
}
/** FC-01: the one resolver for a test invocation: a package-owned file runs in its package dir with a package-relative path, else exactly runnerCmd at the root. */
export function commandFor(t: TestRef, repoDir: string, api?: ProjectApi | null): { cwd: string; cmd: string; args: string[]; argv: string[]; interpreter?: Interpreter; pkgRoot: string } {
  const site = siteFor(api, repoDir, t.path);
  const [cmd, args, interpreter] = runnerCmd(site ? { runner: t.runner, path: site.file } : t, repoDir);
  return { cwd: site?.cwd ?? repoDir, cmd, args, argv: [cmd, ...args], ...(interpreter ? { interpreter } : {}), pkgRoot: site?.root ?? "." };
}
const dedupeTests = (tests: TestRef[]): TestRef[] => [...new Map(tests.map((t) => [`${t.runner}:${t.path}`, t] as const)).values()];
/** Tracked changes against baseSha, plus untracked new files (commit runs after verify). `.loki/`
 *  is filtered defensively even though intake also excludes it via .git/info/exclude. Throws if
 *  either git command fails: a broken baseSha must never read as "nothing changed" (~ALREADY_SATISFIED). */
export function changedFiles(repoDir: string, baseSha: string): string[] {
  const run = (args: string[]): string[] =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8", env: process.env })
      .split("\n").map((l) => l.trim()).filter(Boolean);
  const tracked = run(["diff", "--name-only", baseSha]);
  const untracked = run(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])].filter((f) => !f.startsWith(".loki/"));
}
interface RunOpts {
  path?: string; // PATH override, tests only, so "missing tool" never depends on the host
  stdin?: string;
  protect?: boolean; // FC-02: Wall or task-relevant check, never harness-owned
  timeoutMs?: number; // per-attempt timeout override, tests only; defaults to CHECK_TIMEOUT_MS
  interpreter?: Interpreter; // E-98a: recorded on the resulting VerifyCheck as-is
  cwd?: string; // FC-01: directory the check runs in (the owning package); defaults to ctx.repoDir
  kind?: "test" | "static"; // FC-16: "test" (default) needs a parsed executed count n>0 to pass; "static" (lint, typecheck, selector) is decided by exit code
}
export { ran, skipped } from "../../util/check_result.ts"; // FC-16: the one shared count parser and classifier live in check_result.ts
const CFG_ALWAYS = /(^|\/)(conftest\.py|\.?pytest\.(?:ini|toml)|tox\.ini|jest\.config\.[\w.]+|vitest\.config\.[\w.]+|\.mocharc[\w.]*)$/;
const CFG_SHARED = /(^|\/)(setup\.cfg|pyproject\.toml|package\.json)$/;
const CFG_LINE = /^[+-].*(pytest|jest|mocha|vitest|"test"\s*:|addopts|testpaths)/im;
/** A-115: changed files that configure the test runner. Files that also hold dependencies and metadata (setup.cfg, pyproject.toml,
 *  package.json) count only when a changed line names a runner or the test script, or the file is new (no diff against base).
 *  ponytail: a hit needs a human look, never a verdict; a runner key renamed without one of those words slips through. */
export function testConfigChanged(repoDir: string, baseSha: string, changed: string[]): string[] {
  const diff = (f: string): string => execFileSync("git", ["diff", "-U0", baseSha, "--", f], { cwd: repoDir, encoding: "utf8", env: process.env });
  return changed.filter((f) => CFG_ALWAYS.test(f) || (CFG_SHARED.test(f) && (() => { const d = diff(f); return !d || CFG_LINE.test(d); })()));
}
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
    env: opts.path ? { ...process.env, PATH: opts.path } : process.env,
  });
  let tail = ""; const rs = [proc.stdout, proc.stderr].map((s) => s.getReader());
  const pumps = rs.map(async (r) => { const d = new TextDecoder(); for (;;) { const c = await r.read().catch(() => ({ done: true, value: undefined })); if (c.done) return; tail = (tail + d.decode(c.value, { stream: true })).slice(-65536); } });
  const exitCode = await proc.exited;
  await Promise.race([Promise.all(pumps), new Promise((r) => setTimeout(r, 300))]); rs.forEach((r) => r.cancel().catch(() => {}));
  const cut = timeout.aborted || signal.aborted;
  return { ok: exitCode === 0 && !cut, missing: false, cut, out: cut ? "" : tail };
}
export function firstError(out: string): string { // the line naming the failing test, minus what varies between identical failures (A-113 stall signature)
  const lines = out.slice(-65536).split("\n").map((l) => l.trim()).filter(Boolean), l = lines.find((x) => /^(FAILED\s|\u25cf\s.*\u203a|not ok\s|_{3,}\s.+\s_{3,}$)/.test(x)) ?? lines.find((x) => /^[\w./-]+\.go:\d+:\d+: \S/.test(x)) /* go compiler line, before "FAIL pkg [build failed]" */ ?? lines.find((x) => /fail|error/i.test(x) && !/^(=|\u2713|ok\b|PASS)/.test(x)) ?? "";
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
    let c: ReturnType<typeof classifyCheck> & { owner?: "harness" } = classifyCheck({ kind, ok: a.ok, cut: a.cut, missing: a.missing, out: a.out, ...(cmd === "go" ? { runner: "go" as const } : {}), path: /\.[cm]?[jt]s$/.test(args[args.length - 1] ?? "") ? args[args.length - 1] : undefined });
    const lr = kind === "test" && !a.ok && !a.cut && !a.missing ? await harnessLoadReason({ repoDir: ctx.repoDir, baseSha: ctx.baseSha, out: a.out, cmd, args, signal, cwd, protect: opts.protect, ...(opts.path ? { env: { PATH: opts.path } } : {}) }) : undefined; // FC-02: only kind "test"; lint/tsc/selector (kind "static") never reach it
    if (lr) c = { result: "not_run", reason: lr, owner: "harness" }; // harness-owned load error: never retried, never a fix round
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
  checks.push(check);
  ctx.emit("test.result", "verify", { ...check });
  return check;
}
/** A-112: a test check red on head, in a file the diff did not touch, whose every failing id is also red on a pristine detached base
 *  worktree (never a reset of the implement tree, D42 (2)) is pre_red: ids go to NOT PROVEN, seal skips it in the verdict, the check stays
 *  "fail" and in the fix loop unless the TARGET progressed: a passing Wall test, or a relevant test (`rel`: impacted tests of the task-named
 *  files, the lean-path Wall stand-in) that failed on base, now passes and ran no fewer tests (absent or skipped is not green). Relevant checks
 *  are never pre_red. Base reruns get no node_modules or .venv: a dependency-only failure yields no ids (failIds needs the count covered).
 *  A-115: a relevant check that passes with more skipped or deselected tests than base is `weak`: no progress, and the caller lists it in
 *  NOT PROVEN (a skipped target is not a fixed target). Weak also means it ran FEWER tests than base (pytest.exit, xfail, a deleted test):
 *  every relevant pass is compared with its base run, and xfailed counts as skipped, never passed.
 *  ponytail: bun/go/cargo/npm yield no ids and no skip count, so they are never subtracted or judged weak. */
async function subtractBase(ctx: RunContext, api: ProjectApi | null, checks: VerifyCheck[], tests: TestRef[], changed: string[], wall: Set<string>, rel: Set<string>, signal: AbortSignal): Promise<{ ids: string[]; names: string[]; weak: string[]; cnt: Record<string, { b: { run: number; skipped: number }; h: { run: number; skipped: number } }> }> {
  const out = { ids: [] as string[], names: [] as string[], weak: [] as string[], cnt: {} as Record<string, { b: { run: number; skipped: number }; h: { run: number; skipped: number } }> };
  const pairs = checks.flatMap((c) => {
    const t = tests.find((x) => `${x.runner}:${x.path}` === c.name);
    return t ? [{ c, t }] : [];
  });
  const un = pairs.filter(({ t }) => !changed.includes(t.path));
  const sus = pairs.filter(({ c }) => rel.has(c.name) && c.result === "pass");
  if (!(un.some(({ c }) => c.result === "fail" && c.ids?.length) || sus.length) || signal.aborted) return out;
  const dir = mkdtempSync(join(tmpdir(), "e10-base-"));
  const git = (args: string[]): void => { execFileSync("git", args, { cwd: ctx.repoDir, stdio: "ignore", env: process.env }); };
  try {
    git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, ctx.baseSha]);
    const base = new Map<VerifyCheck, { red: string[]; n: number; sk: number }>();
    for (const { c, t } of new Set([...un, ...sus])) {
      const bc = commandFor(t, dir, api), b = await runOnce(bc.cmd, bc.args, bc.cwd, signal, {});
      base.set(c, { red: !b.ok && !b.cut ? failIds(b.out) : [], n: ran(b.out) ?? (['pass', 'fail'] as const).reduce((t, k) => t + +([...b.out.matchAll(new RegExp(`^(?:#|\\u2139) ${k} (\\d+)$`, 'gm'))].pop()?.[1] ?? 0), 0) /* node spec prints its failing-tests section after the summary block; take the LAST pass and fail lines, not every one */, sk: skipped(b.out) });
    }
    out.weak = sus.filter(({ c }) => (c.sk ?? 0) > base.get(c)!.sk || (c.n ?? 0) < base.get(c)!.n).map(({ c }) => c.name); for (const { c } of sus) out.cnt[c.name] = { b: { run: base.get(c)!.n, skipped: base.get(c)!.sk }, h: { run: c.n ?? 0, skipped: c.sk ?? 0 } };
    const progress = checks.some((c) => wall.has(c.name) && c.result === "pass")
      || sus.some(({ c }) => !out.weak.includes(c.name) && base.get(c)!.red.length > 0 && (c.n ?? 0) >= base.get(c)!.n); // A-115b: sus includes an EDITED relevant file (its base-red ids now pass; the caller's `weakened test:` note keeps it PARTIAL)
    if (progress) {
      for (const { c } of un) {
        if (!rel.has(c.name) && c.result === "fail" && c.ids?.length && c.ids.every((i) => base.get(c)!.red.includes(i))) { out.names.push(c.name); out.ids.push(...c.ids); }
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
export async function runLintChecks(
  ctx: RunContext, changed: string[], signal: AbortSignal, checks: VerifyCheck[], opts: RunOpts & { api?: ProjectApi | null } = {},
): Promise<void> {
  const { api, ...runOpts } = opts; opts = runOpts;
  const py = changed.filter((f) => f.endsWith(".py"));
  if (py.length) {
    const [ruffCmd, interpreter] = resolveTool(ctx.repoDir, "ruff", "ruff"); // E-98a: same project-first resolution as pytest
    await runCheck(ctx, "lint:ruff", ruffCmd, ["check", ...py], signal, checks, { ...opts, interpreter, kind: "static" });
  }
  const sh = changed.filter((f) => f.endsWith(".sh"));
  if (sh.length) {
    await runCheck(ctx, "lint:bash-n", "bash", ["-c", 'for f in "$@"; do bash -n "$f" || exit 1; done', "_", ...sh], signal, checks, { ...opts, kind: "static" });
    await runCheck(ctx, "lint:shellcheck", "shellcheck", sh, signal, checks, { ...opts, kind: "static" });
  }
  // FC-01: tsc and eslint belong to the package that owns the file: config lookup, cwd and file paths are per package.
  for (const g of groupByPackage(api, ctx.repoDir, changed.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f)))) {
    const sfx = g.root === "." ? "" : `:${g.root}`, co = g.root === "." ? opts : { ...opts, cwd: g.cwd };
    if (existsSync(join(g.cwd, "tsconfig.json"))) await runCheck(ctx, `lint:tsc${sfx}`, "npx", ["tsc", "--noEmit", "-p", "."], signal, checks, { ...co, kind: "static" });
    if (ESLINT_CONFIGS.some((f) => existsSync(join(g.cwd, f)))) await runCheck(ctx, `lint:eslint${sfx}`, "npx", ["eslint", ...g.rel], signal, checks, { ...co, kind: "static" });
  }
}
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
    const tests = dedupeTests([...impacted, ...changedTestFiles, ...wallTests, ...relevant]);
    for (const t of tests) {
      if (signal.aborted) break;
      const tc = commandFor(t, ctx.repoDir, api);
      await runCheck(ctx, `${t.runner}:${t.path}`, tc.cmd, tc.args, signal, checks, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), protect: [...wallTests, ...relevant].includes(t), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) });
    }
    const preRed = await subtractBase(ctx, api, checks, tests, changed, new Set(wallTests.map((t) => `${t.runner}:${t.path}`)), new Set(relevant.map((t) => `${t.runner}:${t.path}`)), signal);
    if (!signal.aborted) {
      // Lint/typecheck of changed files only (ENGINE.md section 4's named tool per language).
      await runLintChecks(ctx, changed, signal, checks, { api });
      // Self-hosting only: also run the repo's own fast-gate selector (section 4).
      if (isLokiModeRepo(ctx.repoDir)) {
        await runCheck(ctx, "select-tests", "bash", ["scripts/select-tests.sh", "--files", "-", "--run"], signal, checks, {
          kind: "static", // the selector reruns tests whose counts are not parsed here; per-file test checks carry the proof
          stdin: changed.join("\n") + "\n",
        });
      }
    }
    const flaky = checks.filter((c) => c.result === "flaky").map((c) => c.name);
    // ponytail: real clustering is failures.ts, which depends on this stage; a naive 1:1
    // placeholder keeps the section-4 output key populated until that slice lands.
    const failuresGrouped = checks
      .filter((c) => c.result === "fail" && !preRed.names.includes(c.name))
      .map((c) => ({ signature: c.first_error ? `${c.name} ${c.first_error}` : c.name, count: 1, sample: c.cmd }));
    // E-98a/E-115: a check that ran (not_run has its own NOT PROVEN entry at seal) on a system interpreter/ruff.
    // A-115: test configuration edits and relevant checks with more skips than base are listed, which makes the verdict PARTIAL at seal.
    const inBase = (f: string): boolean => { try { execFileSync("git", ["cat-file", "-e", `${ctx.baseSha}:${f}`], { cwd: ctx.repoDir, stdio: "ignore", env: process.env }); return true; } catch { return false; } };
    const testCounts: Record<string, unknown> = {}; const modifiedRel = relevant.filter((t) => changed.includes(t.path) && inBase(t.path)).flatMap((t) => { const k = preRed.cnt[`${t.runner}:${t.path}`]; if (k) testCounts[t.path] = k; return [`weakened test: ${t.path}`, ...(assertDeltaNotes(ctx.repoDir, ctx.baseSha, null, t.path, intake?.task ?? "", k?.b, k?.h) ?? [])]; }); // a relevant test file edited: NOT VERIFIED (seal lists the same line)
    const weakened = [...modifiedRel, ...testConfigChanged(ctx.repoDir, ctx.baseSha, changed).map((f) => `test configuration changed: ${f}`), ...preRed.weak.map((n) => `skipped or fewer tests than base: ${n}`)];
    const notProven = [...weakened, ...checks.filter((c) => c.owner === "harness").map((c) => `${c.reason} (${c.name}; harness-owned, no fix rounds)`), ...new Set(checks.filter((c) => c.interpreter === "system" && c.result !== "not_run").map((c) => (c.name.startsWith("lint:") ? "lint ran on the system ruff" : "tests ran on the system interpreter")))];
    return { status: "completed", data: { checks, flaky, failures_grouped: failuresGrouped, changed_files: changed, not_proven: notProven, pre_red: preRed.ids, pre_red_checks: preRed.names, test_counts: testCounts } };
  },
};
export const stage = verifyStage;
