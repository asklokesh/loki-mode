// E-15: Wall author (ENGINE.md 4). One provider session, cwd a fresh temp dir holding only task.md and repomap.txt (never sees the code), writes loki_wall_* tests, copied into the repo (never on abort/kill/timeout, E-54) and
// sealed under <runDir>/wall/ (sha256 each); wall.sealed before Implement; clean base-tree pass short-circuits to already_satisfied. E-64: skipped outright on the small-task lean path (plan.ts logs the same decision).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { goPackagePath } from "../../runner/repo_profile.ts";
import { dirname, isAbsolute, join, relative } from "node:path";
import { type RunContext, type RunnerName, type Stage, type StageResult, type TestMap, type TestRef, taskBlock } from "../types.ts";
import { clauseDroppedNote, extractClauses, untaggedClauses, type ClauseSet } from "../../util/spec_file.ts";
import { unitSpec } from "../../features/speed/unit_mode.ts";
import type { ReadOnlyFile } from "./implement.ts";
import { withStagePrefix } from "../../features/lean_prefix.ts";
import { RUNNER_HINT, wallManifestFor } from "../../e10ext/wall_hints.ts";
import { hasRelevantTests, isTinyGreenfield, WALL_TINY_BOUND, loadRepoMap, namedFiles, planMode, repoMapText, sizeTask, smallTaskPath, wallEnabled, wallFirstModel, wallLimitS, wallOutputCap, wallModel, capToRunTier } from "../sizing.ts";
import { sha256, wallGreenOnBaseOf } from "./seal.ts"; import { publishSealed, removeHoldout, sealStageDir, stashHoldout, wallHoldoutRatio } from "../../util/holdout.ts";
import { clauseEvidenceBlock, evidenceOf, ingestWallCases, wallCasesBrief, wallCasesRunner, withUnreproducedEvidence, type WallEvidence } from "../../util/wall_cases.ts"; import { commandFor } from "./verify.ts"; import { guessRunner, harnessRunners, missingJavaTool, projectInterpreter } from "../testmap.ts";
import type { ProjectApi } from "../../project_model/api.ts"; import { loadProjectApi } from "../../project_model/resolve.ts";
import { sealedWallDir, baseJobs, classify, plannedGoDir, goPackageBrief, corroboratePass, corroborateGoPassSync, goRunner, harnessSkipCode, classifyCheck, mapPool, NO_RUNNER_REASON, notRunReason, plainTestEnv, spawnCollect, spawnGroupSync, stripAnsi } from "../../util/check_result.ts";
import { conventionViolation, conventionsBrief, outOfRepoReask, outOfRepoTarget, phantomReason, phantomRepoPaths, readPackageConventions, vacuousCheck } from "../../project_model/conventions.ts"; // FC-23

const WALL_PREFIX = "loki_wall_";

export interface WallSealedFile { path: string; sha256: string; runner?: RunnerName; } // path: absolute, in the repo working tree

// Runs the sealed Wall tests on the base tree; local since types.ts has no "execute tests" contract yet. not_run (D42 (3)): no real result; counts toward neither pass nor fail. Optional for pre-D42(3) fakes.
/** interpreter: "system" is set by the base runner itself when the file ran under the system interpreter, so no caller keys a decision on the reason wording */
export interface NotRunRow { file: string; reason: string; interpreter?: "system"; }
export interface BaseTestRunner { run(repoDir: string, files: TestRef[]): { pass: number; fail: number; not_run?: number }; /** FC-69: why each not_run file of the LAST run was not executed */ lastNotRunFiles?: NotRunRow[]; /** TEN-SPEED-19: one result per file, input order, at most `jobs` processes at once */ runEach?(repoDir: string, files: TestRef[], jobs: number, corroborate?: boolean): Promise<BaseEachResult[]>; }
export const BASE_RUN_TIMEOUT_MS = 60_000; // same per-check budget as verify.ts's CHECK_TIMEOUT_MS
export { sealedWallCopy, sealedWallDir } from "../../util/check_result.ts";
export { classify, notRunReason, pytestCollectionIsRed } from "../../util/check_result.ts"; // moved to util/check_result.ts (core line budget)
// One process per file, through verify's own interpreter resolution (E-98a) so a missing `python` is never misread as a failing test. env is explicit, matching verify.ts's runOnce (its default PATH lookup can otherwise resolve a
// snapshot from process start, not the live env).
export class RealBaseTestRunner implements BaseTestRunner {
  lastNotRunFiles: NotRunRow[] = [];
  constructor(private readonly api?: ProjectApi | null, private readonly timeoutMs: number = BASE_RUN_TIMEOUT_MS, private readonly extraEnv: Record<string, string> = {}) {} // FC-01: undefined = load the repo's cached Project Model per run
  run(repoDir: string, files: TestRef[]): { pass: number; fail: number; not_run: number } {
    this.lastNotRunFiles = [];
    let pass = 0, fail = 0, not_run = 0; const not_run_files: NotRunRow[] = []; const api = this.api === undefined ? loadProjectApi(repoDir) : this.api; for (const f of files) {
      const { cmd, args, interpreter, cwd } = commandFor(f, repoDir, api);
      const r = spawnGroupSync(cmd, f.runner === "pytest" ? [...args, "-rfE"] : args, { cwd, timeoutMs: Math.max(1000, this.timeoutMs), env: { ...plainTestEnv(), ...this.extraEnv } }); // FC-69: plain env in, ANSI stripped out; group-kill launcher reaps a grandchild runner
      const status = r.status, out = stripAnsi(r.output), base = classify(f, status, out, repoDir, interpreter);
      const result = base === "not_run" && status === 0 && f.runner === "go" && interpreter !== "system" && corroborateGoPassSync(classifyCheck({ kind: "test", ok: true, out, ...goRunner(cmd, args) }), out, cmd, args.filter((a, k) => a !== "-run" && args[k - 1] !== "-run"), { cwd, env: plainTestEnv() }).result === "pass" ? "pass" : base; // same Go exit 0 corroboration as runEach, synchronous
      if (result === "pass") pass++; else if (result === "fail") fail++; else { not_run++; not_run_files.push({ file: f.path, reason: notRunReason(status, interpreter), ...(interpreter === "system" ? { interpreter } : {}) }); }
    }
    this.lastNotRunFiles = not_run_files; return { pass, fail, not_run };
  }
  async runEach(repoDir: string, files: TestRef[], jobs: number, corroborate = false, remaining?: () => number): Promise<BaseEachResult[]> { // TEN-SPEED-19: same classification as run(), at most `jobs` processes at once
    const api = this.api === undefined ? loadProjectApi(repoDir) : this.api; return mapPool(files, jobs, async (f) => { const { cmd, args, interpreter, cwd } = commandFor(f, repoDir, api), r = await spawnCollect(cmd, f.runner === "pytest" ? [...args, "-rfE"] : args, { cwd, env: plainTestEnv(), timeoutMs: Math.max(1000, Math.min(this.timeoutMs, remaining?.() ?? this.timeoutMs)) }), out = stripAnsi(r.output), base = classify(f, r.status, out, repoDir, interpreter), result = corroborate && base === "not_run" && r.status === 0 && f.runner === "go" && interpreter !== "system" && (await corroboratePass(classifyCheck({ kind: "test", ok: true, out, ...goRunner(cmd, args) }), out, cmd, args.filter((a, k) => a !== "-run" && args[k - 1] !== "-run") /* corroboration refuses the -run regex, so it reruns the package */, { cwd, env: plainTestEnv() })).result === "pass" ? "pass" : base; return { pass: +(result === "pass"), fail: +(result === "fail"), not_run: +(result === "not_run"), notRunFiles: result === "not_run" ? [{ file: f.path, reason: notRunReason(r.status, interpreter), ...(interpreter === "system" ? { interpreter } : {}) }] : [] }; }, () => remaining !== undefined && remaining() <= 0); // remaining: the caller's budget; no new file starts once it is spent
  }
}

export interface BaseEachResult { pass: number; fail: number; not_run: number; notRunFiles: NotRunRow[]; } export interface WallOptions { baseRunner?: BaseTestRunner; }
/** E-45: the Wall repo map is paths only, capped, so the (sonnet) brief stays short. */
export const WALL_MAP_MAX_LINES = 200;

/** COST-14: static output budget, placed before any run-specific text so it stays in the cache-stable prefix. */
export const WALL_OUTPUT_BUDGET = "Output budget: write one test file, one assertion block per acceptance line, no docstrings, and no closing summary.";

/** FC-WALL-OUT-OF-REPO-TARGET: static, cache-stable, sits beside the output budget before any run-specific text. */
export const WALL_REPO_PATHS = "Reach repo code by repo-relative paths, never via home dir, $HOME or ~/. A file the task names keeps that path from the repo root (a bare name such as rotate.sh is at the root), never beside your test file.";

export function buildWallBrief(task: string, repomapText = "", runners: RunnerName[] = [], hasManifest = false, conventions = "", acceptance: string[] = [], location: string | null = null, clauses: ClauseSet | null = null, evidence: WallEvidence | null = null, tiny = false): string { // location: repo-relative destination directory; "" is the repo root; null is unknown (no line)
  return withStagePrefix([
    "You are the Loki 10 Wall author.",
    WALL_OUTPUT_BUDGET,
    WALL_REPO_PATHS,
    ...(tiny ? [WALL_TINY_BOUND] : []),
    `You cannot see the repository. This directory holds only task.md and repomap.txt${hasManifest ? " and wall_manifest.txt (signatures, runner config, test layout and test-style examples)" : ""}.`,
    ...(repomapText ? [`Repository paths (repomap.txt):\n${repomapText}`] : []),
    ...taskBlock(task),
    ...(acceptance.length ? [`Acceptance criteria frozen for this unit (each must be covered by a test):\n${acceptance.map((a) => `Acceptance: ${a}`).join("\n")}`] : []),
    ...clauseEvidenceBlock(clauses, evidence),
    "Write behavioral acceptance tests that prove the task is done. A test that errors on import, uses another framework's globals, or fails for a reason unrelated to the task is discarded. Negative case: for each acceptance line include one assertion that rejects bad input or would fail before the fix.",
    `Test runner: ${runners.map((r) => RUNNER_HINT[r]).find(Boolean) ?? "the framework named in repomap.txt"}`,
    ...(conventions ? [conventions] : []),
    ...(location === "" ? ["Each file you write is copied to the repository root before it runs, so __dirname and import.meta.dir resolve to the repository root, not this directory."] : location ? [`Each file you write is copied to ${location}/ (relative to the repository root) before it runs, so __dirname and import.meta.dir resolve to that directory, not this one and not the repo root. Build repo paths from it (join(__dirname, ${[...location.split("/").filter(Boolean)].map(() => '".."').join(", ") || '"."'}, "<repo path>")) or from process.cwd() only when you know the runner starts at the root.`] : []),
    `Start file names with "${WALL_PREFIX}" (JS/TS: end in .test.<ext>). Write nothing else.`,
  ].join("\n\n"));
}

/** RunContext carries no task text; read it as intake.ts does: prior.intake.task, else issue.json title+body, else LOKI_E10_TASK_TEXT. */
export function loadTaskText(ctx: RunContext, fromPrior: string | undefined): string {
  if (fromPrior) return fromPrior;
  const issueJsonPath = process.env.LOKI_E10_ISSUE_JSON ?? join(ctx.runDir, "issue.json");
  if (existsSync(issueJsonPath)) {
    try {
      const issue = JSON.parse(readFileSync(issueJsonPath, "utf8")) as { title?: string; body?: string };
      const text = [issue.title, issue.body].filter((s) => typeof s === "string" && s.length > 0).join("\n\n");
      if (text) return text;
    } catch { /* malformed issue.json: fall through to the text-mode env var */ }
  }
  return process.env.LOKI_E10_TASK_TEXT ?? "";
}

// Alongside an existing detected test file, else by the runner's test-visibility rule. Java: the build tool only sees src/test/java (HV1-03b). Go is package-directory scoped: a test in tests/ cannot see root package code and
// only compiles through an implementer shim that is never committed, so the Wall goes beside the first planned or named .go file (the repo root without one). Every other runner sees code from a top-level tests/.
function wallTargetDir(repoDir: string, existingTests: TestRef[], runners: RunnerName[] = [], texts: string[] = []): string {
  const first = existingTests[0];
  if (!first && runners.some((r) => r === "maven" || r === "gradle" || r === "javac")) return join(repoDir, "src", "test", "java"); // HV1-03b: the build tool only sees Java tests here
  if (!first && runners.includes("go")) return plannedGoDir(repoDir, texts).dir;
  return first ? join(repoDir, dirname(first.path)) : join(repoDir, "tests");
}
/** Runner for a generated file: extension decides for Python/Go, a JS/TS file takes the repo's detected JS runner; anything else never guesses (unselectable). */

/** WC-01a: what wallAuthor hands installWall. Sealed copies live under <runDir>/wall; nothing here touches repoDir. */
export interface WallAuthored { kind: "authored"; staged?: boolean; model?: string; iterationId?: string; task: string; sizeName: string; runners: RunnerName[]; targetDir: string; generated: string[]; contents: Map<string, string>; discarded: { file: string; reason: string }[]; manifestSha256?: string; holdoutDir?: string; clauses?: ClauseSet; evidence?: WallEvidence; }
export type WallAuthorOutcome = { kind: "done"; result: StageResult } | WallAuthored;

/** Session plus compile check. Writes only <runDir>/wall (sealed copies); repoDir is read, never written. */
export async function wallAuthor(ctx: RunContext, signal: AbortSignal, retry?: { model: string; suffix: string; note?: string | undefined }): Promise<WallAuthorOutcome> {
  const done = (result: StageResult): WallAuthorOutcome => ({ kind: "done", result });
  if (signal.aborted) return done({ status: "failed", data: {}, reason: "aborted before wall started" });
  if (!wallEnabled()) return done({ status: "skipped", data: {}, reason: "LOKI_E10_WALL=0" });

  const prior = ctx.outputs();
  const task = loadTaskText(ctx, prior.intake?.task as string | undefined);
  const repomapRef = prior.intake?.repomap_ref as string | undefined;
  const testMap = (prior.intake?.testmap as TestMap | undefined) ?? null;
  const existingTests: TestRef[] = testMap?.tests ?? [];

  // E-64: skip Wall too on the lean path (plan.ts, which always runs, logs this same decision on "variant"). LOKI_E10_PLAN=always forces a plan even for a small task, so the lean path never applies: a forced plan still gets the
  // Wall's independent acceptance tests. An external diff (CW-12) never takes the lean skip: the Wall is its only independent proof.
  const repoMap = loadRepoMap(repomapRef);
  const focus = namedFiles(task, repoMap), runners: RunnerName[] = testMap ? harnessRunners(testMap.runners, repoMap?.files ?? [], process.env, ctx.repoDir, focus) : [];
  const sz = sizeTask(task, repoMap, testMap);
  if (!ctx.externalPatch && planMode() !== "always" && smallTaskPath(sz.size, hasRelevantTests(task, repoMap, testMap, ctx.tests.impacted)) === "lean") {
    return done({ status: "skipped", data: { size: sz.size }, reason: "small task with a relevant test: cascade skips Wall" });
  }

  if (testMap && runners.length === 0) { const miss = missingJavaTool(repoMap?.files ?? [], process.env, ctx.repoDir); return done({ status: "skipped", data: { size: sz.size, files: [], no_runner: true, skip_code: harnessSkipCode(), not_proven: [miss ? `Wall not run: ${miss} is not installed on this machine, so this Java repo could not be tested (harness-owned)` : "Wall skipped: no runnable test command for this stack"] }, reason: miss ? `${miss} is not installed: the Wall cannot run Java tests (harness-owned, not proven)` : "no runnable test command detected: the Wall cannot write a runnable check" }); } // FC-17: decided before any model session

  // TEN-COST-09: a pytest-only Wall under the system interpreter is classified not_run (classify, notRunReason), so the author session would be paid for and discarded. Skip it before any session ONLY when the holdout is off: with it on, held files never go through the base-run classify and verify runs them on the system interpreter, which drives fix rounds and the seal, so the Wall must still run. The held count is unknown before authoring, so ratio 0 is the only provable zero. Seal reads not_proven and the verdict can never be VERIFIED by this Wall.
  if (testMap && runners.every((r) => r === "pytest") && projectInterpreter(ctx.repoDir) === "system" && wallHoldoutRatio() === 0) return done({ status: "skipped", data: { size: sz.size, files: [], no_interpreter: true, not_proven: ["Wall skipped: no project test interpreter"] }, reason: "Wall skipped: no project test interpreter" });

  const tree = prior.intake?.tree as string | undefined;
  const repomapText = repoMapText(ctx.repoDir, tree, repomapRef, WALL_MAP_MAX_LINES);

  const srcTexts = [typeof prior.plan?.plan === "string" ? prior.plan.plan : "", task], targetDir = wallTargetDir(ctx.repoDir, existingTests, runners, srcTexts), pkg = loadProjectApi(ctx.repoDir)?.packageOf(`${relative(ctx.repoDir, targetDir)}/x`); // FC-23: the target package's own module system, read by a parser
  const conv = readPackageConventions(join(ctx.repoDir, pkg?.root ?? "."), pkg?.runner ?? null);
  const cwd = mkdtempSync(join(tmpdir(), "loki-e15-wall-"));
  const wm = wallManifestFor(ctx.repoDir, tree, task); // D77: flag-gated, null (as if off) on any failure
  for (const [n, c] of [["task.md", task], ["repomap.txt", repomapText], ...(wm ? [["wall_manifest.txt", wm.text]] : [])] as [string, string][]) writeFileSync(join(cwd, n), c, "utf8");

  const clauseSet = extractClauses(task), evidence = evidenceOf(prior.intake?.runtime_evidence);
  const model = retry?.model ?? wallFirstModel(sz.size), iterationId = `${ctx.runId}-wall${retry?.suffix ?? ""}`; // COST-11
  const session = await ctx.sessions.run({
    stage: "wall",
    brief: buildWallBrief(task, repomapText, runners, !!wm, conventionsBrief(conv), unitSpec()?.acceptance ?? [], relative(ctx.repoDir, targetDir), clauseSet, evidence, isTinyGreenfield(sz.size, task, testMap)) + wallCasesBrief(runners) + goPackageBrief(ctx.repoDir, targetDir, runners, srcTexts) + (retry?.note ? `\n\n${retry.note}` : ""), // CCR-06: "" unless LOKI_E10_WALL_CASES=1 on a Python repo
    // E-45: pinned cheaper model; development tier because the planning tier yields to the LOKI_SESSION_MODEL=opus pin.
    tier: "development",
    model,
    iterationId,
    limitS: wallLimitS(sz.size), maxOutputTokens: wallOutputCap(), // W1-S3
    signal,
    cwd,
  });
  if (session.killed || session.exit === null) { rmSync(cwd, { recursive: true, force: true }); return done({ status: "failed", data: { iteration_ids: [iterationId], model }, reason: "wall session aborted, killed, or timed out", killed: true }); } // E-54: also covers killed-from-outside (exit:null, "killed before exiting" per types.ts)
  const casesBad = ingestWallCases(cwd, runners, ctx.repoDir); if (casesBad) { rmSync(cwd, { recursive: true, force: true }); return done({ status: "failed", data: { iteration_ids: [iterationId], model }, reason: casesBad }); } // CCR-06: invalid structured output fails closed with a named reason, never free-form code
  const planText = typeof prior.plan?.plan === "string" ? prior.plan.plan : null, repoFiles = repoMap?.files ?? [];
  const goPkgPath = goPackagePath((f) => { try { return readFileSync(f, "utf8"); } catch { return undefined; } }, ctx.repoDir, targetDir); // the Go package under test, by import path
  const oor = (): { name: string; why: string }[] => readdirSync(cwd).filter((f) => f.startsWith(WALL_PREFIX)).flatMap((name) => { const text = readFileSync(join(cwd, name), "utf8"), why = outOfRepoTarget(text) ?? vacuousCheck(name, text, goPkgPath) ?? phantomReason(phantomRepoPaths(text, name, targetDir, ctx.repoDir, planText, task), repoFiles, relative(ctx.repoDir, targetDir), pkg?.root ?? "", task); return why ? [{ name, why }] : []; });
  const bad1 = oor(); if (bad1.length > 0 && !wallCasesRunner(runners) && !signal.aborted && !ctx.overCap?.()) await ctx.sessions.run({ stage: "wall", brief: withStagePrefix(outOfRepoReask("Rewrite these Wall files in place, keeping the same names and acceptance coverage.", bad1)), tier: "development", model, iterationId: `${iterationId}-oor`, limitS: wallLimitS(sz.size), maxOutputTokens: wallOutputCap(), signal, cwd }); // FC-WALL-OUT-OF-REPO-TARGET: re-ask once in the same directory with the precise reason
  const oorBad = new Map(oor().map((b) => [b.name, b.why])), all = readdirSync(cwd).filter((f) => f.startsWith(WALL_PREFIX)), held = stashHoldout({ runId: ctx.runId, repoDir: ctx.repoDir, srcDir: cwd, targetDir, names: all.filter((n) => !oorBad.has(n) && !conventionViolation(conv, n, readFileSync(join(cwd, n), "utf8"))), runnerOf: (n) => guessRunner(n, runners) }), generated = all.filter((n) => !held?.names.has(n)); // P12-05: the held-out subset never reaches the repo, runDir or the implementer
  const sealedDir = sealStageDir(ctx.runId, ctx.repoDir); rmSync(sealedDir, { recursive: true, force: true }); // staged outside the repo tree; publishSealed moves it to <runDir>/wall at install
  if (generated.length > 0) mkdirSync(sealedDir, { recursive: true });

  const contents = new Map<string, string>();
  const discarded: { file: string; reason: string }[] = []; // FC-23: a file the package's own compiler would reject is harness-owned: sealed copy only, never in the tree
  for (const name of generated) {
    const content = readFileSync(join(cwd, name), "utf8"), oorWhy = oorBad.get(name), bad = oorWhy ?? conventionViolation(conv, name, content);
    writeFileSync(join(sealedDir, name), content, "utf8");
    if (oorWhy) discarded.push({ file: name, reason: `${oorWhy}; wall test discarded after one rewrite request` }); else if (bad) discarded.push({ file: name, reason: `${bad}; wall test did not compile under the package config` }); else contents.set(name, content);
  }
  rmSync(cwd, { recursive: true, force: true });
  return { kind: "authored", ...(generated.length > 0 ? { staged: true } : {}), model, iterationId, task, sizeName: sz.size, runners, targetDir, generated, contents, discarded, ...(clauseSet.clauses.length ? { clauses: clauseSet } : {}), ...(evidence ? { evidence } : {}), ...(wm ? { manifestSha256: wm.sha256 } : {}), ...(held ? { holdoutDir: held.dir } : {}) };
}

/** Copy the sealed files into repoDir, emit wall.sealed, run the base run in baseDir, drop not_run files. */
export function installWall(ctx: RunContext, a: WallAuthored, baseDir: string, opts: WallOptions = {}): StageResult { const g = installCore(ctx, a, baseDir, opts), first = g.next(); if (first.done) return first.value as StageResult; return g.next(null).value as StageResult; } // TEN-SPEED-19: sequential base run; installWallAsync runs it concurrently
export async function installWallAsync(ctx: RunContext, a: WallAuthored, baseDir: string, opts: WallOptions = {}): Promise<StageResult> { const g = installCore(ctx, a, baseDir, opts), first = g.next(); if (first.done) return first.value as StageResult; const y = first.value as { runner: BaseTestRunner; tests: TestRef[] }, jobs = baseJobs();
  return g.next(jobs > 1 && y.runner.runEach && y.tests.length > 1 ? await y.runner.runEach(baseDir, y.tests, jobs) : null).value as StageResult; } // LOKI_E10_BASE_JOBS > 1 and a runner with runEach: concurrent base run
function* installCore(ctx: RunContext, a: WallAuthored, baseDir: string, opts: WallOptions): Generator<{ runner: BaseTestRunner; tests: TestRef[] }, StageResult, BaseEachResult[] | null> {
  const { generated, contents, discarded, targetDir, runners } = a;
  if (generated.length > 0) { mkdirSync(targetDir, { recursive: true }); if (!publishSealed(ctx.runId, ctx.repoDir, ctx.runDir) && a.staged) return { status: "failed", data: {}, reason: "wall sealed copies missing: the staged Wall directory in the system temp directory was removed before install" }; } const sealedFiles: WallSealedFile[] = [], readOnlyFiles: ReadOnlyFile[] = [], wallTests: TestRef[] = [];
  for (const name of generated) {
    const content = contents.get(name); if (content === undefined) continue; // discarded: sealed copy only
    const dest = join(targetDir, name), runner = guessRunner(name, runners, relative(ctx.repoDir, dest));
    writeFileSync(dest, content, "utf8");
    sealedFiles.push({ path: dest, sha256: sha256(content), ...(runner ? { runner } : {}) }); readOnlyFiles.push({ path: dest, content });
    if (runner) wallTests.push({ runner, path: relative(ctx.repoDir, dest) });
  }
  ctx.wallSealed = true;
  ctx.emit("wall.sealed", "wall", { files: sealedFiles, ...(a.manifestSha256 ? { manifest_sha256: a.manifestSha256 } : {}) });
  const baseRunner = opts.baseRunner ?? new RealBaseTestRunner(), baseRun = { pass: 0, fail: 0, not_run: discarded.length }, notRunFiles: { file: string; reason: string }[] = []; // A-103: one file at a time; a file with no real result (not_run) proves nothing, so it leaves the tree and Implement's read-only set. Its sealed copy stays under runDir/wall; base_run.not_run lets Seal list it.
  for (const f of sealedFiles) { const rel = relative(ctx.repoDir, f.path); if (!wallTests.some((t) => t.path === rel)) notRunFiles.push({ file: rel, reason: NO_RUNNER_REASON }); } // FC-WALL-FILE-WITHOUT-RUNNER-SILENTLY-DROPPED: a sealed file no runner can run is named, never dropped
  const each = yield { runner: baseRunner, tests: wallTests }; for (const [i, t] of wallTests.entries()) {
    const e = each?.[i], r = e ?? baseRunner.run(baseDir, [t]), abs = join(ctx.repoDir, t.path); baseRun.pass += r.pass; baseRun.fail += r.fail; baseRun.not_run += r.not_run ?? 0; notRunFiles.push(...(e ? e.notRunFiles : baseRunner.lastNotRunFiles ?? [])); if (r.pass + r.fail === 0) { rmSync(abs, { force: true }); for (const l of [sealedFiles, readOnlyFiles] as { path: string }[][]) l.splice(0, l.length, ...l.filter((f) => f.path !== abs)); }
  }
  // Gate on generated.length, not wallTests.length: an unselectable (guessRunner() null) file is sealed but never run, and must never be silently missing from the already_satisfied count.
  const unselectable = generated.length - wallTests.length;
  // D42 (3): not_run refuses the seal too -- never short-circuit on a base run that never proved anything.
  const alreadySatisfied = generated.length > 0 && unselectable === 0 && baseRun.fail === 0 && (baseRun.not_run ?? 0) === 0 && baseRun.pass === generated.length;

  return withUnreproducedEvidence({
    status: "completed",
    data: {
      files: sealedFiles,
      ...(a.manifestSha256 ? { manifest_sha256: a.manifestSha256 } : {}),
      readOnlyFiles,
      base_run: baseRun,
      ...(notRunFiles.length ? { not_run_files: notRunFiles } : {}),
      iteration_ids: [a.iterationId ?? `${ctx.runId}-wall`],
      already_satisfied: false, ...(alreadySatisfied ? { green_on_base: true } : {}), ...(a.holdoutDir ? { holdout_dir: a.holdoutDir } : {}), // opaque path only: names stay in the private store
      ...(discarded.length ? { discarded } : {}),
      ...(a.clauses ? { clauses: a.clauses.clauses.length, ...untaggedData(a.clauses, contents), ...(a.clauses.dropped ? { not_proven: [clauseDroppedNote(a.clauses.dropped)] } : {}) } : {}),
    },
  }, a.evidence, alreadySatisfied, generated.length === 0);
}

const untaggedData = (set: ClauseSet, files: Map<string, string>): Record<string, string[]> => { const u = untaggedClauses(set, files); return { ...(u.untagged.length ? { untagged: u.untagged } : {}), ...(u.untagged_files.length ? { untagged_files: u.untagged_files } : {}) }; }; // listed, never silently counted as covered
const WALL_SESSION_MAX_S = 300; // sizing.ts wallLimitS caps a session at 300
export const WALL_BASE_FILES = 4; // files one rung's base run is sized for; RealBaseTestRunner spawns once per file at BASE_RUN_TIMEOUT_MS each
export const WALL_RUNG_S = WALL_SESSION_MAX_S + WALL_BASE_FILES * (BASE_RUN_TIMEOUT_MS / 1000), WALL_STAGE_LIMIT_S = 2 * WALL_RUNG_S; // one rung at its worst: a max session plus a per-file base run; the stage holds two rungs
export const distrustGreenBase = (d: Record<string, unknown>): Record<string, unknown> => ({ ...d, already_satisfied: false, already_satisfied_distrusted: true, base_run: { ...((d.base_run ?? {}) as Record<string, unknown>), not_run: 1, unproven: true } }); // Fail closed for EVERY consumer (wall, discard.alreadySatisfied, seal wallGreenOnBase): an untrusted green base run is recorded as unproven (not_run), which all of them already refuse. Shared by machine.ts (concurrent Wall) and runWall (budget-blocked cheap rung).

/** Brief note for the one re-author after an attempt left no Wall test that ran: the base-run counts and the per-file reasons, so the rewrite can run. Built only from harness-recorded fields. */
export function reauthorNote(d: Record<string, unknown>): string {
  const b = (d.base_run ?? {}) as Record<string, unknown>, rows = [...((d.discarded as { file: string; reason: string }[] | undefined) ?? []), ...((d.not_run_files as { file: string; reason: string }[] | undefined) ?? [])];
  return ["Your previous Wall attempt left no test that ran on the base tree, so it proved nothing and was dropped.", `Base run: pass ${Number(b.pass ?? 0)}, fail ${Number(b.fail ?? 0)}, not run ${Number(b.not_run ?? 0)}.`, ...rows.slice(0, 5).map((r) => `- ${String(r.file)}: ${String(r.reason).slice(0, 300)}`), "Write the Wall again so every test runs. An assertion about behaviour the repository already has must pass on the base tree; only assertions about the new behaviour may fail there."].join("\n");
}
export const WALL_REAUTHOR_EXHAUSTED = "Wall re-authored once and still no Wall test ran on the base tree";

export async function runWall(ctx: RunContext, signal: AbortSignal, opts: WallOptions = {}): Promise<StageResult> {
  const t0 = Date.now(), a = await wallAuthor(ctx, signal);
  const first = a.kind === "done" ? a.result : await installWallAsync(ctx, a, ctx.repoDir, opts);
  // COST-11: a cheaper first rung is re-authored exactly once on wallModel() when its result cannot be trusted: nothing usable (nothing written, all discarded or not_run), a killed or timed-out session (N3), or a Wall already green on the base tree (B1: a haiku test that passes before the change may be vacuous, so the sonnet result decides already_satisfied). Never loops. Any doubt escalates.
  const cheap = a.kind === "authored" ? a.model : (first.data.model as string | undefined) ?? "", killed = a.kind === "done" && first.killed === true, usable = a.kind === "authored" && first.status === "completed";
  const unusable = usable && ((first.data.files as unknown[] | undefined) ?? []).length === 0, green = usable && !unusable && (first.data.already_satisfied === true || first.data.reproduction_green_on_base === true || wallGreenOnBaseOf({ wall: first.data })); // same green test seal applies
  const nrf = (first.data.not_run_files as NotRunRow[] | undefined) ?? [], noInterp = nrf.length > 0 && nrf.every((x) => x.interpreter === "system"); // every not_run is "ran under the system interpreter": no rewrite can run without a project interpreter, so re-authoring only adds cost
  const dropped = unusable && ((Number(((first.data.base_run ?? {}) as Record<string, unknown>).not_run ?? 0) > 0 && !noInterp) || ((first.data.discarded as unknown[] | undefined) ?? []).length > 0); // a Wall test was written and then dropped (no real base result or did not compile), as opposed to nothing written
  const budgetLeft = WALL_STAGE_LIMIT_S * 1000 - (Date.now() - t0) >= WALL_RUNG_S * 1000; // the retry must fit its own session plus base run inside the stage limit, from the same constants
  if (!(unusable || green || killed) || !cheap || signal.aborted || (cheap === wallModel() && !dropped) || (noInterp && !dropped && !killed && !green)) return first; /* no project interpreter and nothing dropped: no second Wall can run either, so none is bought */ // a same-model rung re-authors only when a written Wall test was dropped and none ran (the rewrite gets the base-run results); a green or killed same-model result stands
  if (!budgetLeft) return green && first.data.reproduction_green_on_base !== true ? { ...first, data: distrustGreenBase(first.data) } : first; // fail closed: an unchecked cheap-rung green must not stand as already_satisfied
  if (a.kind === "authored") { for (const f of (first.data.files as { path: string }[] | undefined) ?? []) rmSync(f.path, { force: true }); rmSync(sealedWallDir(ctx.runDir), { recursive: true, force: true }); ctx.wallSealed = false; } // drop the abandoned attempt's installed copies, sealed copies and held-out tests so none leak into the retry
  removeHoldout(ctx.runId, ctx.repoDir);
  const r2Model = capToRunTier(wallModel(), ctx.model, ["LOKI_E10_WALL_TIER", "LOKI_MODEL_OVERRIDE"]);
  ctx.emit("wall.reauthor", "wall", { from_model: cheap, to_model: r2Model, reason: killed ? "first author session killed or timed out" : green ? "first author green on the base tree" : "no usable test from the first author" });
  const b = await wallAuthor(ctx, signal, { model: r2Model, suffix: "-r2", note: dropped ? reauthorNote(first.data) : undefined }), second = b.kind === "done" ? b.result : await installWallAsync(ctx, b, ctx.repoDir, opts);
  const ids = [...((first.data.iteration_ids as string[] | undefined) ?? []), ...((second.data.iteration_ids as string[] | undefined) ?? [])];
  const still = second.status === "completed" && ((second.data.files as unknown[] | undefined) ?? []).length === 0; // the one re-author is spent: a second empty Wall is disclosed, never retried
  return { ...second, data: { ...second.data, iteration_ids: ids, reauthored: true, ...(still ? { not_proven: [...((second.data.not_proven as string[] | undefined) ?? []), WALL_REAUTHOR_EXHAUSTED] } : {}) } }; // both tiers' spend reaches the ledger via iteration_ids
}

export const wallStage: Stage = {
  name: "wall",
  targetS: 45,
  limitS: WALL_STAGE_LIMIT_S, // B2: room for both rungs (each a session at the wallLimitS cap plus a base run), so the sonnet retry is never cut off by the stage ceiling
  run: (ctx, signal) => runWall(ctx, signal),
};
/** WC-01b: the split halves, read by the machine unless LOKI_E10_WALL_CONCURRENT=0. */
export const stage = Object.assign(wallStage, { split: { author: wallAuthor, install: installWall } });
