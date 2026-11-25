// E-09 Fast verify (ENGINE.md 4 "Fast verify", 16 E-09). Runs impacted + changed test files + Wall tests, plus lint/typecheck of changed files, each under one per-check timeout. A missing tool is NOT PROVEN ("not_run"), never a failure; a failing check gets one rerun,
// fail-then-pass is "flaky". An empty diff with the already_done marker seals ALREADY_SATISFIED; without it, FAILED (ENGINE.md 2). Reaches testmap.ts/ machine.ts only through RunContext's `tests: TestMapProvider`, injected as a fake in tests, never imported here.
import { escapeRegex } from "../../util/regex_escape.ts";
import { installHint } from "../../util/stack_tools.ts";
import { atomicWriteText } from "../../util/atomic.ts"; import { redactSecrets } from "../../util/redact.ts";
import { installOwned, projectDeclaresRuff, unusedInstallNotes, withGuideNotes } from "../../project_model/install.ts"; import { nrdGroupsFor, settleNrd } from "../../features/no_regression.ts";
import { scopedOutOf } from "../../project_model/scope.ts";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs"; import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"; import { MANIFESTS } from "../../contrib/wall_snapshot.ts"; import { classifyRunnerOutput } from "../../runner/runner_errors.ts";
import { hiddenConfigChanged, testConfigChanged } from "../../features/runner_config.ts"; import { assertDeltaNotes } from "../../e10ext/assert_delta.ts"; import { failIds } from "../failures.ts";
import { failedFirst, QUICK_ONLY_NOTE, quickScope, quickSplit } from "../../e10ext/select.ts"; import { dependentNotes, dependentTests } from "../../features/dependents.ts"; import { harnessLoad } from "../../runner/load_owner.ts";
import { loadRepoMap, namedFiles, wallMode } from "../sizing.ts"; import { sealedWallCopy } from "../../util/check_result.ts";
import { avaTargets, guessRunner, isTestFile, mochaTargets } from "../testmap.ts"; import { coveredStem } from "../../util/test_file_text.ts"; import { comparableIds, errorsById, lineNamesChange, noiseOnlyErrors, sameErrors, changeLines, failedCount, sameFailures, SILENT_IDS_NOTE, CHANGE_LINES_MAX, PER_FILE_CUT_BYTES } from "../failures.ts"; export { errorsById, sameErrors } from "../failures.ts";
import { LINE_FALLBACK_COUNT, lineVerdict, UNMEASURED_REASON, failureLines, venvSkipNotes, goJsonStream, GO_JSON_KEEP, withoutStaleWall, failureExcerpt, EXCERPT_TOTAL_CAP, changedFiles, hiddenEdits, ignoreRuleChanges, classifyCheck, unmeasuredTail, corroboratePass, classifyRisk, mapPool, verifyJobs, diffFiles, markExecuted, recordRisk, plainTestEnv, stripAnsi, goRunner, hasExecutedProof, ran, skipped, summaryPassFailCount, SECURITY_SCAN, fileHashes, briefGroups, failureSignature } from "../../util/check_result.ts";
import { WALL_COMPILE_REASON, wallOwnedFailure } from "../../util/wall_owned.ts"; import { isHoldoutCheck, recordHoldoutTriage, stageHoldout } from "../../util/holdout.ts";
import { defaultBudgetsOn, cmdSilenceS, type ImplementExit, type RunContext, type RunnerName, type Stage, type StageResult, type TestRef, STAGE_BUDGETS } from "../types.ts";
import type { ProjectApi } from "../../project_model/api.ts"; import { groupByPackage, loadProjectApi } from "../../project_model/resolve.ts";
import { readReport, reportArgs, reportSource, structuredResultsMode } from "../../util/test_report.ts"; import { pruneQuarantine, readQuarantine, writeQuarantine } from "../../util/failure_memory.ts"; import { addedLines, checklistCmdOn, checklistMode, firedItems, readChecklist, runChecklist, type ChecklistResult } from "../../features/checklist.ts"; import { repoCacheDir, repoKey } from "../cache.ts"; import { ruleMode } from "../closure.ts"; import { safeGit } from "../../util/safe_git.ts"; import { testFileWeakened } from "../../util/test_guard.ts"; import { baseDepsLinker, baseDepsView, depsListing, linkWorkspaceMembers, envChangedSince, depsGoneSince, manifestBlocksBaseLink, zeroGate, zeroOnBase, type ZeroGate, guardEnv, harnessCmdBegin } from "../../util/base_guard.ts"; import { fullSuiteSpecs, type SuiteSpec } from "../../project_model/package_suite.ts"; import { asyncShellRunner, changedForLines, baseRedIds, headRerunOn, passedOnRerun, baseOnDemandOn, baselineSuiteOnDemand, writeBaselineRecord, TOUCHED_RED, collateralOnBaseline, touchedRedOnBase, attribute, attributeFullSuite, holdsPartial, exogenousHeldLine, couldNotRun, couldNotRunIfProved, missingTool, unrunnableCheckOn, unrunnableExternalOn, unrunnableSuites, exogenousRedOn, exogenousState, type ExogenousAttribution, baseRedById, staticPreExisting, whyFullSuiteNotExcused, type StaticTool } from "../../runner/repo_profile.ts"; import { lokiEnvNotes } from "../../util/check_result.ts"; import { lokiVenvNotes } from "../../project_model/install.ts";
export const timeoutCarryOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_TIMEOUT_CARRY"] ?? "").trim());
export const TIMEOUT_CARRY_NOTE = "carried from an earlier verify of this run, not rerun (untouched file)";
/** TIMEOUT-WAIT: after a check's timeout (or abort) fires, a process still alive this long later is SIGKILLed, so a test that ignores SIGTERM costs its limit, not minutes more. */
export const KILL_AFTER_MS = 5_000;
/** TIMEOUT-CARRY: the carried not_run checks for `tests`: each untouched test whose check timed out in the previous verify of this run, unless it is a Wall,
 *  task-named or held-out check (`keep`), whose own result must come from a fresh run. */
export function carriedTimeouts(prev: readonly VerifyCheck[], tests: readonly TestRef[], changed: readonly string[], keep: ReadonlySet<string>, env: NodeJS.ProcessEnv = process.env): VerifyCheck[] {
  if (!timeoutCarryOn(env)) return [];
  const timedOut = new Map(prev.filter((c) => c.result === "not_run" && /^timed out after /.test(c.reason ?? "")).map((c) => [c.name, c] as const));
  return tests.flatMap((t) => { const n = testCheckName(t), p = timedOut.get(n); if (!p || changed.includes(t.path) || keep.has(n) || isHoldoutCheck(n)) return []; return [{ name: n, cmd: p.cmd, result: "not_run" as const, duration_s: 0, reason: `${String(p.reason).replace(/; carried from an earlier verify.*$/, "")}; ${TIMEOUT_CARRY_NOTE}` }]; });
}
/** RW-01 NO-ID (LOKI_E10_BASE_ON_DEMAND, default on, =0 opts out): a test check that fails with no parsed test id (the command stops before it reports a
 *  test: hermes-agent#147745, 33 files each failing in 0.06 s with ".venv/bin/python: No module named pytest"; opencode#63152 plugin-migrations) is run
 *  once more with the change removed, on a base worktree. It is the environment, not the change, only when that run fails too and prints the same set of
 *  lines (failureLines, the BASE-RED-SHAPE normalizer; checkout paths made relative) and no line names a file or symbol the change edited. Then the check
 *  is not_run with NO_ID_BASE_REASON: never fix-round input, never a pass, so the label is capped at PARTIAL. A base that passes, one line more or fewer
 *  on either side, no base run, or an empty output keeps it a failure. */
export const NO_ID_BASE_REASON = "the test command does not run in this checkout: it fails the same way with the change removed";
const rootless = (out: string, roots: string[]): string => {
  const all = roots.flatMap((x) => { try { return [x, realpathSync(x)]; } catch { return [x]; } }).flatMap((x) => [x, x.startsWith("/private/") ? x.slice("/private".length) : `/private${x}`]);
  let o = out; for (const r of [...new Set(all)].filter((x) => x.length > 1).sort((a, b) => b.length - a.length)) o = o.split(r).join("<repo>");
  return o;
};
export function sameFailureLines(headOut: string, base: { ok: boolean; out: string } | null, changed: readonly string[], symbols: readonly string[], headRoot: string, baseRoot: string): boolean {
  if (!base || base.ok) return false;
  const h = new Set(failureLines(rootless(stripAnsi(headOut), [headRoot]))), b = new Set(failureLines(rootless(stripAnsi(base.out), [baseRoot])));
  if (h.size === 0 || h.size !== b.size || [...h].some((l) => !b.has(l))) return false;
  const names = lineNamesChange(changed, symbols);
  return ![...h].some((l) => names(l));
}
/** RW-01: one package suite's timeout is the time left of the verify stage (less a margin for the attribution that follows), at most the 300 s its base run
 *  gets (LOKI_E10_SUITE_TIMEOUT_S overrides that maximum). 0 means the suite is not started. No deadline (a caller outside the machine): the maximum. */
export const SUITE_MARGIN_MS = 5000;
export function suiteTimeoutFor(deadlineMs: number | undefined, nowMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = Number((env["LOKI_E10_SUITE_TIMEOUT_S"] ?? "").trim()), max = Number.isFinite(v) && v >= 1 ? Math.floor(v * 1000) : defaultBudgetsOn(env) ? 300_000 : Infinity; // NO-DEFAULT-BUDGET: no limit unless set (shell.run's silence guard ends a silent suite)
  if (deadlineMs === undefined) return max;
  const left = deadlineMs - nowMs - SUITE_MARGIN_MS;
  return left < 1000 ? 0 : Math.min(max, left);
}
const CHECK_TIMEOUT_MS = 60_000; // ENGINE.md 16 E-09: "60s limit" per check; limitS (120s) is the stage's outer bound
/** NO-DEFAULT-BUDGET: the per-check limit with budgets on; with none, a check has no time limit and stops only after cmdSilenceS() with no output. */
const checkTimeoutMs = (): number => (defaultBudgetsOn() ? CHECK_TIMEOUT_MS : Infinity);
/** implement.ts's full stage.completed.data isn't in the shared contract yet; this is the one  field verify.ts reads from it (ImplementExit itself IS a contract type, types.ts). */
interface ImplementOutput { exit?: ImplementExit; }
/** wall.ts's full output isn't in the contract either; only the sealed file list, shaped like  Receipt["wall"].files, is needed here. */
interface WallOutput {
  files?: { path: string; runner?: RunnerName }[];
  holdout_dir?: string; // P12-05: private store of the held-out Wall tests
}
type Interpreter = "project" | "system";
export interface VerifyCheck {
  name: string;
  cmd: string;
  result: "pass" | "fail" | "not_run" | "flaky"; // ENGINE.md section 5 test.result enum
  duration_s: number;
  reason?: string; n?: number; count?: string; sk?: number; ids?: string[]; first_error?: string; anchor?: string; /* file:line of the first failure, council anchor grammar */ // A-112: failing test ids; A-113: first failing output line, normalized; feeds the stall signature
  interpreter?: Interpreter; // E-98a: which python/ruff this check actually ran on
  secret_matches?: string[]; // SECRET-PUSH: the security scan's secret hits, "<file>:<head line>" (deep.ts runSecretScan); seal and the supervisor refuse the push on them
  owner?: "harness"; skip_code?: SkipCode; /* machine-readable twin of the "<cmd> not found on PATH" reason */ // FC-02: the runner could not load or collect; not_run, never a code failure
  load_external?: string[]; // UNRUNNABLE-EXTERNAL: the external modules a harness-owned load error misses on base and head alike (load_owner.ts harnessLoad)
  load_note?: string; // UNRUNNABLE-EXTERNAL: the exact NOT PROVEN line that load error produced (harnessNote, or deep.ts's full-suite line)
  reused?: boolean; // FULL-SUITE-REUSE: a full-suite result reused from the previous verify on the same key (reusableRun); the disclosure is here, never in not_proven
  reused_key?: string; // FULL-SUITE-REUSE: the key it was reused on (fullSuiteKey)
}
/** The NOT PROVEN line of a per-file check sealed not_run because its runner could not load (FC-02). One template, used where the line is listed and where
 *  UNRUNNABLE-EXTERNAL records it as load_note, so the two can never drift. */
export const harnessNote = (reason: string | undefined, name: string): string => `${reason} (${name}; harness-owned, no fix rounds)`;
/** UNRUNNABLE-EXTERNAL (repo_profile.ts unrunnableExternalOn): the could-not-run candidates of checks sealed not_run on a harness-owned load error that
 *  misses the same external modules on base and head. namesChanged is false by construction: harnessLoad sets load_external only after
 *  loadErrorIsHarnessOwned's conditions accepted the error, and those refuse output naming a changed file and a target file the change edited. A holdout
 *  check is never one. [] with the knob off. */
export function externalUnrunCands(checks: readonly Pick<VerifyCheck, "name" | "result" | "load_external" | "load_note">[], pkg: (name: string) => string, env: NodeJS.ProcessEnv = process.env): { name: string; pkg: string; namesChanged: boolean; external: true; note: string }[] {
  if (!unrunnableExternalOn(env)) return [];
  return checks.filter((c) => c.result === "not_run" && (c.load_external?.length ?? 0) > 0 && typeof c.load_note === "string" && c.load_note !== "" && !isHoldoutCheck(c.name))
    .map((c) => ({ name: c.name, pkg: pkg(c.name), namesChanged: false, external: true as const, note: c.load_note! }));
}
/** UNRUNNABLE-EXTERNAL: the lines that held the label for each listed external candidate; verify adds them to could_not_run_notes, which seal's
 *  unrunnableLifted removes from the capping notes only when it lifts the candidates. */
export const externalCouldNotNotes = (cands: readonly { name: string; note: string }[], listed: readonly string[]): string[] => cands.filter((c) => listed.includes(c.name)).map((c) => c.note);
export { runnerCmd, commandFor, firstError } from "../../util/check_result.ts"; // one owner: check_result.ts (test invocation resolver and failure-line normalizer)
import type { DeepCheck } from "./deep.ts"; import { loadErrors, loadErrorModule, toolFallbacks, type SkipCode, changedSymbols, firstFileLineAnchor, runnerCmd, commandFor, firstError, resolveTool, spawnFailedTool, NO_TESTS_REASON, NO_RUNNER_REASON, CODE_FILE_EXT as CODE_EXT } from "../../util/check_result.ts"; import { naNote, naText, wallRedOnBaseOf, wallProofOf } from "../../project_model/package_suite.ts";
/** TEN-QUALITY-01: stage-local failure excerpts keyed by check object; never on VerifyCheck, never emitted, never set for a held-out check. */
const excerpts = new WeakMap<object, string>();
/** VERIFY-PLAN V5 (LOKI_E10_STRUCTURED_RESULTS): per check, the runner's own report counts beside the text parse. Never a VerifyCheck field. */
type Structured = { source: string; run: number; failed: number; skipped: number; text_run: number | null; text_failed: number | null; agrees: boolean } | { report_unsupported: true };
const structured = new WeakMap<object, Structured>();
export function structuredSummary(cs: readonly VerifyCheck[]): { read: number; agree: number; unsupported: number; disagree: { name: string; text_run: number | null; report_run: number; text_failed: number | null; report_failed: number }[] } {
  let read = 0, agree = 0, unsupported = 0; const disagree: { name: string; text_run: number | null; report_run: number; text_failed: number | null; report_failed: number }[] = [];
  for (const c of cs) { const s = structured.get(c); if (!s) continue; if ("report_unsupported" in s) { unsupported++; continue; } read++; if (s.agrees) agree++; else if (disagree.length < 20) disagree.push({ name: c.name, text_run: s.text_run, report_run: s.run, text_failed: s.text_failed, report_failed: s.failed }); }
  return { read, agree, unsupported, disagree };
}
const failOuts = new WeakMap<object, string>(); // EXOGENOUS-RED: a failing per-file check's whole output, so a failure line naming a changed file is seen wherever it is printed
export const checkExcerpt = (c: VerifyCheck): string => excerpts.get(c) ?? ""; // the patch protocol's repair digest (features/patch_protocol.ts)
const suites = new WeakSet<object>(); // L005: full-suite checks, whose signature also carries the failing ids
const failTails = new WeakMap<object, string>(); // WALL-FAILOUT: redacted tail of a failed check's output, read only by writeWallFailureTail
const tscOut = new WeakMap<object, string>(); // a failed lint:tsc check's whole output tail, read only by tscUntouchedLocal
const crashSigs = new WeakMap<object, string>(); // BCE: a failing check's crash signature (a fatal signal or an import/collection error), read from the whole output
/** BCE LOKI_E10_BASE_CRASH_ENV (default on, =0 opts out): a test check that failed with no parseable test id because its process crashed or could not import (pydantic: a
 *  segfault, rc 139, and a conftest ImportError, from a stand-in env the repo's own install refused to build) is run once on base. When base crashes with the same
 *  signature, the check is environment: not_run with the signature on NOT PROVEN, never a failure of the change and never fix-round input. A different signature,
 *  a base that passes, or a check with ids stays a failure (fail-safe). */
export const baseCrashEnvOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_BASE_CRASH_ENV"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
export const BCE_REASON = "fails the same way on base, so its result cannot be read: the environment, not the change";
export function crashSignature(out: string): string | null {
  const m = /^(?:[.sxXFE]*(?=Fatal Python error: )Fatal Python error: [^\n]+|Segmentation fault[^\n]*|E\s+ModuleNotFoundError: No module named '[^']+'|ModuleNotFoundError: No module named '[^']+'|ImportError while (?:loading conftest|importing test module)[^\n]*)$/m.exec(out);
  return m ? m[0].replace(/^[.sxXFE]+(?=Fatal Python error: )/, "").replace(/\s+/g, " ").replace(/'\/[^']*\//g, "'").trim() : null; // pytest's progress marks before the fatal line differ between base and head
}
/** CHECK-FAILURE-TAILS: the redacted tail of every check that is still failing after this verify (never a held-out or opaque check: they get no tail),
 *  kept in the run dir as check-failures.txt so a failure Loki did not attribute can be read afterwards. closed-set-2 hm155462: one test file failed the same
 *  7 tests on base and on head, was not attributed, and both fix rounds chased it until the run STALLED; the base output was in base-runs.json and the head
 *  output was nowhere, so the two could not be compared. Overwritten by each verify, removed when nothing fails. 256 KiB in all, 16 KiB per check at most. */
export const CHECK_FAILURES_FILE = "check-failures.txt", CHECK_FAILURES_CAP = 262144;
export function writeCheckFailureTails(runDir: string, failed: { name: string; out: string }[]): string | undefined {
  const file = join(runDir, CHECK_FAILURES_FILE);
  try {
    if (failed.length === 0) { rmSync(file, { force: true }); return undefined; }
    const per = Math.min(WALL_FAILURE_TAIL_CAP, Math.floor(CHECK_FAILURES_CAP / failed.length));
    const tail = (t: string): string => { const b = Buffer.from(t, "utf8"); return b.length <= per ? t : b.subarray(b.length - per).toString("utf8").replace(/^\uFFFD+/, ""); };
    atomicWriteText(file, failed.map((f) => `== ${f.name} ==\n${tail(f.out)}\n`).join("\n"), { durable: false });
    return CHECK_FAILURES_FILE;
  } catch { return undefined; } // diagnostics only: never alters a verdict
}
const noIdOut = new WeakMap<object, string>(); // RW-01 NO-ID: the output of a failing test check that parsed no test id, read only by the no-id base comparison
const headErrors = new WeakMap<object, Map<string, string[]>>(); // each failing id's error line, read from the whole output (never the cut tail), for sameErrors
export { WALL_FAILURE_TAIL_FILE } from "../../util/check_result.ts"; import { WALL_FAILURE_TAIL_FILE } from "../../util/check_result.ts";
export const WALL_FAILURE_TAIL_CAP = 16384;
/** Redact the whole output first, then keep the tail: a secret straddling the cut would lose its prefix and escape redaction. */
export const wallTailOf = (out: string, repoDir: string): string => redactSecrets(stripAnsi(out).replace(/\r/g, "").split(repoDir.replace(/\/+$/, "") + "/").join("")).slice(-WALL_FAILURE_TAIL_CAP);
/** The last Wall run's failing output, kept in the run dir so a Wall that stays red can be diagnosed. Overwritten each run; a green run removes it. Held-out checks never get a tail. Returns the file name when written. */
export function writeWallFailureTail(runDir: string, failed: { name: string; out: string }[]): string | undefined {
  const file = join(runDir, WALL_FAILURE_TAIL_FILE);
  try {
    if (failed.length === 0) { rmSync(file, { force: true }); return undefined; }
    const per = Math.floor(WALL_FAILURE_TAIL_CAP / failed.length);
    const tail = (t: string): string => { const b = Buffer.from(t, "utf8"); return b.length <= per ? t : b.subarray(b.length - per).toString("utf8").replace(/^\uFFFD+/, ""); };
    atomicWriteText(file, failed.map((f) => `== ${f.name} ==\n${tail(f.out)}\n`).join("\n"), { durable: false });
    return WALL_FAILURE_TAIL_FILE;
  } catch { return undefined; } // diagnostics only: never alters a verdict
}
const isHold = (c: { name: string }): boolean => isHoldoutCheck(c.name); // C-C4b-c: pubHold is the one public shape of a held-out check: result and counts only
const pubHold = (c: VerifyCheck): VerifyCheck => ({ name: "holdout", cmd: "holdout", result: c.result, duration_s: c.duration_s, ...(c.n !== undefined ? { n: c.n } : {}), ...(c.sk !== undefined ? { sk: c.sk } : {}), ...(c.owner ? { owner: c.owner, reason: "holdout infrastructure failure" } : {}) });
/** The one check name a test run gets: runner:path. Provenance (check_result.ts) parses this shape. */
export const testCheckName = (t: { runner: string; path: string }): string => `${t.runner}:${t.path}`;
/** FireLater#21: the relevant tests (impacted by a task-named file) that are not the task's own: neither a named test file nor one whose covered stem is a named
 *  file's stem (register/page.test.tsx for a named register/page.tsx). A page test that only imports or mocks a named lib/api.ts is collateral: it gets the base
 *  comparison of an untouched test; failing the same way as on base (sameErrors) it feeds one fix round, and a same-error remainder after that round is
 *  pre-existing, listed with COLLATERAL_RED, which caps VERIFIED. A new error under the same id is never pre-existing. */
/** fl24: a check excused as red on base by every id whose error text differs from base, by noise only (the same error shapes) with no changed file or symbol in any failure (failures.ts noiseOnlyErrors). */
export const QUIET_RED = "excused as red on base although its error text differs from base by noise only (the same error shapes; no changed file or symbol appears in the failure)";
export const COLLATERAL_RED = "relevant test already failing on base, still failing the same tests (it imports a file the task names; capped, not blocking)";
export function collateralTests(relevant: TestRef[], named: string[]): TestRef[] {
  const stems = new Set(named.flatMap((f) => { const s = basename(f).replace(/\.[^.]+$/, ""); return /^(index|__init__|mod)$/.test(s) && f.includes("/") ? [s, basename(f.slice(0, f.lastIndexOf("/")))] : [s]; }));
  return relevant.filter((t) => !named.includes(t.path) && !stems.has(coveredStem(t.path)));
}
/** OWN-BY-PATH (LOKI_E10_OWN_BY_PATH, default on, =0 restores collateralTests' stem rule): the relevant tests that are the task's own, never excused as red on base.
 *  A test is own only when it is a test file the task names, or it is path-paired with a named non-test file the diff CHANGED: the same covered stem, and it sits in
 *  that file's directory or its __tests__, tests or test subdirectory. A named file the diff did not edit is a reference ("is not modified", "following the
 *  pattern in"), so its tests are collateral, as is every same-stem test elsewhere (FireLater#24: a named X/page.tsx made all 46 page.test.tsx own). */
export const noTestFallbackOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_NO_TEST_FALLBACK"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
/** G6 LOW-TIER-FULL-SUITE (LOKI_E10_LOW_TIER_FULL_SUITE, default on; =0/off/false/no restores the old rule): a low-tier verify also runs the repo's full test command before the seal, so a change that breaks another part of the repo cannot seal VERIFIED and surface only in the post-seal deep worker. */
export const lowTierFullSuiteOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_LOW_TIER_FULL_SUITE"] ?? "").trim());
/** G6 relief, FULL-SUITE-FINAL-ONLY (LOKI_E10_FULL_SUITE_FINAL_ONLY, default on; =0/off/false/no opts out). Low tier only. */
export const fullSuiteFinalOnlyOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_FULL_SUITE_FINAL_ONLY"] ?? "").trim());
/** G6 relief, FULL-SUITE-REUSE (LOKI_E10_FULL_SUITE_REUSE, default on; =0/off/false/no opts out). Low tier only. */
export const fullSuiteReuseOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_FULL_SUITE_REUSE"] ?? "").trim());
/** FULL-SUITE-FINAL-ONLY: the NOT PROVEN line of a verify that deferred its full suite. Every verify not_proven line caps (seal.ts capVerify), so a verify
 *  that deferred can never back VERIFIED; the text matches no closure.ts NO_CAP pattern, so held_by lists it. */
export const FULL_SUITE_DEFERRED_NOTE = "full suite deferred: a targeted check is red, so the full suite runs on the final candidate (LOKI_E10_FULL_SUITE_FINAL_ONLY)";
/** FULL-SUITE-FINAL-ONLY: true when a low-tier verify defers its full suite because a check that will certainly feed a fix round is red: a check with result
 *  fail, not excused as red on base (touchedRed), that is a blocking, Wall or task-named check (`keep`) or a test file the change touched. This is verify's
 *  `decisive` without its `qs !== null` term, so only a verify before the first fix round changes (a later red one is already quick). Never with the
 *  no-test fallback (ntf), on a stall re-run (settle), at medium or high tier, or with LOKI_E10_LOW_TIER_FULL_SUITE off (the suite would not run anyway). */
export function deferFullSuite(i: { tier: string | undefined; ntf: boolean; settle: boolean; checks: readonly Pick<VerifyCheck, "name" | "result">[]; touchedRed: ReadonlySet<string>; keep: ReadonlySet<string>; changed: readonly string[] }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (i.tier !== "low" || i.ntf || i.settle || !fullSuiteFinalOnlyOn(env) || !lowTierFullSuiteOn(env)) return false;
  return i.checks.some((c) => c.result === "fail" && !i.touchedRed.has(c.name) && (i.keep.has(c.name) || i.changed.includes(c.name.slice(c.name.indexOf(":") + 1))));
}
/** FULL-SUITE-REUSE: one suite's last run, carried in verify's output (full_suite_runs) across quick and deferred verifies. `check` is the whole result as the
 *  suite returned it (before HEAD-RERUN edits it), never a reused one. */
export interface FullSuiteRun { name: string; cmd: string; cwd: string; key: string; check: DeepCheck }
/** FULL-SUITE-REUSE: the dependency directories' stamp for a suite run at `cwd`: for node_modules, .venv and venv at the repo root and at cwd, every entry
 *  base_guard.ts depsListing lists (runner caches and __pycache__ left out, so a suite's own cache writes do not move it), each with what changes when it
 *  is installed again: a link's target, a file's size and mtime, a node package's package.json size and mtime; a site-packages directory by name (its
 *  dist-info name carries the version). An unreadable directory or entry stamps a fresh random value, so its key never matches (fail closed). */
export function depStamp(repoDir: string, cwd: string): string[] {
  const out: string[] = [], never = (): string[] => [`unreadable:${randomUUID()}`];
  for (const root of [...new Set([repoDir, join(repoDir, cwd)])]) for (const d of ["node_modules", ".venv", "venv"]) {
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    const names = depsListing(dir); if (names === null) return never();
    const sites = (() => { try { return ["lib", "lib64", "Lib"].flatMap((l) => (l === "Lib" ? [join(dir, l, "site-packages")] : existsSync(join(dir, l)) ? readdirSync(join(dir, l)).filter((p) => /^python/.test(p)).map((p) => join(dir, l, p, "site-packages")) : [])).filter((x) => existsSync(x)); } catch { return null; } })();
    if (sites === null) return never();
    const rel = relative(repoDir, dir);
    for (const n of names) {
      const p = n.startsWith("py/") ? sites.map((x) => join(x, n.slice(3))).find((x) => existsSync(x)) : join(dir, n);
      if (!p) return never();
      try {
        const st = lstatSync(p), pj = join(p, "package.json");
        const v = st.isSymbolicLink() ? `link:${readlinkSync(p)}` : st.isFile() ? `${st.size}:${st.mtimeMs}` : d === "node_modules" && existsSync(pj) ? (() => { const j = statSync(pj); return `pkg:${j.size}:${j.mtimeMs}`; })() : "dir";
        out.push(`${rel}/${n}=${v}`);
      } catch { return never(); }
    }
  }
  return out.sort();
}
/** FULL-SUITE-REUSE: sha256 of a canonical JSON of format version 1, baseSha, the suite's name, cmd and cwd, the sorted [path, content hash] of EVERY
 *  changed path (fileHashes over verify's changed set: the tracked diff from base plus untracked non-ignored files; a deleted path is "D"), and the
 *  dependency stamp. Every changed path is in every suite's scope, not only the paths under its package: a package suite reads its dependencies' sources
 *  (scopedSuites runs a dependent's suite for that reason) and a relative import across packages declares nothing, so a narrower scope could reuse a stale
 *  pass. A file outside the diff is byte-identical to base by definition. */
export function fullSuiteKey(k: { baseSha: string; name: string; cmd: string; cwd: string; hashes: Readonly<Record<string, string>>; deps: readonly string[] }): string {
  const files = Object.entries(k.hashes).map(([p, h]) => [p, h === "-" ? "D" : h] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([1, k.baseSha, k.name, k.cmd, k.cwd, files, [...k.deps].sort()])).digest("hex");
}
/** FULL-SUITE-REUSE: the well-formed records of a verify output's full_suite_runs. */
export function suiteRunsOf(v: unknown): FullSuiteRun[] {
  return (Array.isArray(v) ? v : []).filter((r): r is FullSuiteRun => !!r && typeof r === "object" && typeof r.name === "string" && typeof r.cmd === "string" && typeof r.cwd === "string" && typeof r.key === "string" && !!r.check && typeof r.check === "object" && typeof r.check.name === "string");
}
/** FULL-SUITE-REUSE: the previous verify's result for suite `s` on `key`, marked reused on the check, or null. Only when the previous verify was not stopped
 *  (stopped_at unset), a record for the same name, cmd and cwd exists, its key equals `key`, and its result is pass or fail (a not_run, a timeout or a cut,
 *  is run again). The caller passes null for prev with the knob off or above the low tier. */
export function reusableRun(prev: Record<string, unknown> | undefined, s: { name: string; cmd: string; cwd: string }, key: string): DeepCheck | null {
  if (!prev || prev["stopped_at"] !== undefined) return null;
  const r = suiteRunsOf(prev["full_suite_runs"]).find((x) => x.name === s.name && x.cmd === s.cmd && x.cwd === s.cwd);
  if (!r || r.key !== key || (r.check.result !== "pass" && r.check.result !== "fail")) return null;
  return { ...(structuredClone(r.check) as DeepCheck), reused: true, reused_key: key };
}
/** FULL-SUITE-REUSE: the records this verify writes: every previous record carried forward unchanged, and each suite this verify ran replacing its own. */
export function nextSuiteRuns(prev: readonly FullSuiteRun[], ran: readonly FullSuiteRun[]): FullSuiteRun[] {
  const id = (r: FullSuiteRun): string => `${r.name}\0${r.cmd}\0${r.cwd}`, m = new Map(prev.map((r) => [id(r), r]));
  for (const r of ran) m.set(id(r), r);
  return [...m.values()];
}
export const ownByPathOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_OWN_BY_PATH"] ?? "").trim());
export function ownTests(relevant: TestRef[], named: string[], changed: readonly string[]): TestRef[] {
  const src = named.filter((f) => !isTestFile(f) && changed.includes(f)).map((f) => { const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "."; const s = basename(f).replace(/\.[^.]+$/, ""); return { d, s }; });
  const inDir = (t: string, d: string): boolean => { const td = t.includes("/") ? t.slice(0, t.lastIndexOf("/")) : "."; return [d, ...["__tests__", "tests", "test"].map((x) => (d === "." ? x : `${d}/${x}`))].includes(td); };
  return relevant.filter((t) => named.includes(t.path) || src.some(({ d, s }) => coveredStem(t.path) === s && inDir(t.path, d)));
}
/** TOUCHED-BASE-RED: the titles of the test cases a change added or edited in one test file: a test/it title on an added line, and for each changed line the
 *  nearest test/it title above it in the head file (the case whose body it edits). Read from `git diff -U0 <base> -- <file>` and the working tree. */
const TEST_TITLE_RE = /\b(?:it|test)(?:\.\w+)*\(\s*(['"`])((?:(?!\1).)+)\1/;
export function editedTestTitles(repoDir: string, baseSha: string, rel: string): string[] {
  let d = ""; try { d = safeGit(repoDir, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", baseSha, "--", rel], { timeout: 20000 }); } catch { return []; }
  let lines: string[] = []; try { lines = readFileSync(join(repoDir, rel), "utf8").split("\n"); } catch { /* deleted: added lines only */ }
  const out = new Set<string>(); let at = -1;
  for (const l of d.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) { // lines of the hunk before its first test title belong to the case above them; a blank line edits nothing; after a title, lines belong to that (new) case
      at = Math.max(0, Number(h[1]) - 1); const n = h[2] === undefined ? 1 : Number(h[2]);
      const ind = (x: string): number => /^[ \t]*/.exec(x)![0].replace(/\t/g, "  ").length; // a line edits a case only when it sits deeper than that case's title (a top-level import or helper edits none)
      for (let k = at; k <= at + Math.max(0, n - 1) && k < lines.length; k++) { const own = TEST_TITLE_RE.exec(lines[k]!); if (own) break; if (lines[k]!.trim() === "") continue; for (let j = k - 1; j >= 0; j--) { const m = TEST_TITLE_RE.exec(lines[j]!); if (m) { if (ind(lines[k]!) > ind(lines[j]!)) out.add(m[2]!); break; } } }
      if (n === 0) for (let j = Math.min(at, lines.length - 1); j >= 0; j--) { const m = TEST_TITLE_RE.exec(lines[j]!); if (m) { out.add(m[2]!); break; } } // a pure deletion edits the case it sat in
      continue;
    }
    if (l.startsWith("+") && !l.startsWith("+++")) { const m = TEST_TITLE_RE.exec(l.slice(1)); if (m) out.add(m[2]!); }
  }
  return [...out];
}
const dedupeTests = (tests: TestRef[]): TestRef[] => [...new Map(tests.map((t) => [`${t.runner}:${t.path}`, t] as const)).values()];
export { changedFiles } from "../../util/check_result.ts"; // one owner: check_result.ts (diffFiles builds on it)
interface RunOpts {
  path?: string; // PATH override, tests only, so "missing tool" never depends on the host
  stdin?: string;
  protect?: boolean; // FC-02: Wall or task-relevant check, never harness-owned
  timeoutMs?: number; group?: boolean; // per-attempt timeout override; defaults to CHECK_TIMEOUT_MS. group: own process group, killed whole on abort, timeout and close (the in-session Stop hook)
  interpreter?: Interpreter; // E-98a: recorded on the resulting VerifyCheck as-is
  cwd?: string; // FC-01: directory the check runs in (the owning package); defaults to ctx.repoDir
  wall?: ReadonlySet<string>; // FC-23: repo-relative Wall files; a static check failing only inside them is harness-owned
  opaque?: boolean; // C-C4b-c: held-out check, its event and public record carry no id, message or output
  kind?: "test" | "static"; // FC-16: "test" (default) needs a parsed executed count n>0 to pass; "static" (lint, typecheck, selector) is decided by exit code
  changedTest?: boolean; // G5 LINE-FALLBACK: the test file this check runs is one the change edited or added
  report?: string; // VERIFY-PLAN V5: a Loki-owned file the runner writes its machine-readable report to
}
export { ran, skipped } from "../../util/check_result.ts"; // FC-16: the one shared count parser and classifier live in check_result.ts
export { testConfigChanged } from "../../features/runner_config.ts"; // D86 FC-09r: the one runner-config registry lives in features/
/** `cut` means the timeout or the stage's AbortSignal killed the child: never read as "fail" and
 *  never retried (a hung check must not burn 2x its timeout). `out` is a 64 KB tail, unread when cut. The result comes from exit + timeout, never pipe EOF (an orphaned grandchild may hold the pipes). */
type OnceResult = { ok: boolean; missing: boolean; cut: boolean; out: string; spawnTool?: string; silent?: boolean };
export async function runOnce(cmd: string, args: string[], cwd: string, signal: AbortSignal, opts: RunOpts): Promise<OnceResult> {
  if (!Bun.which(cmd, { PATH: opts.path ?? process.env["PATH"] ?? "" })) return { ok: false, missing: true, cut: false, out: "" };
  const end = harnessCmdBegin(); // G2: the env guard deletes only when its own command ran alone
  try { return await runOnceSpawn(cmd, args, cwd, signal, opts); } finally { end(); }
}
async function runOnceSpawn(cmd: string, args: string[], cwd: string, signal: AbortSignal, opts: RunOpts): Promise<OnceResult> {
  const tmo = opts.timeoutMs ?? checkTimeoutMs(), silence = new AbortController(); let silent = false, lastByte = Date.now();
  const timeout = Number.isFinite(tmo) ? AbortSignal.timeout(Math.max(0, tmo)) : silence.signal; // AbortSignal.timeout(Infinity) throws in Bun: no limit is the silence guard alone
  const quiet = Number.isFinite(tmo) ? undefined : setInterval(() => { if (Date.now() - lastByte >= cmdSilenceS() * 1000) { silent = true; silence.abort(); } }, Math.min(30_000, Math.max(50, cmdSilenceS() * 250)));
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: opts.group ? undefined : AbortSignal.any([signal, timeout]), ...(opts.group ? { detached: true } : {}),
    env: opts.path ? { ...plainTestEnv(), PATH: opts.path } : plainTestEnv(), // FC-69
  });
  if (!opts.group) { const hard = (): void => { const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, KILL_AFTER_MS); void proc.exited.finally(() => clearTimeout(t)); }; const any = AbortSignal.any([signal, timeout]); if (any.aborted) hard(); else any.addEventListener("abort", hard, { once: true }); } // TIMEOUT-WAIT (dev4 aiohttp: a 60 s timeout cost 150 to 160 s)
  const killGroup = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } }; if (opts.group) { AbortSignal.any([signal, timeout]).addEventListener("abort", killGroup, { once: true }); if (signal.aborted || timeout.aborted) killGroup(); } let tail = ""; const keep = goJsonStream(cmd, args) ? GO_JSON_KEEP : 65536, rs = [proc.stdout, proc.stderr].map((s) => s.getReader()); // a go test -json stream is parsed whole (a head-truncated stream reads as torn and never counts), so it keeps far more than the 64 KB tail
  const pumps = rs.map(async (r) => { const d = new TextDecoder(); for (;;) { const c = await r.read().catch(() => ({ done: true, value: undefined })); if (c.done) return; lastByte = Date.now(); tail += d.decode(c.value, { stream: true }); if (tail.length > keep * 2) tail = tail.slice(-keep); } });
  const exitCode = await proc.exited; if (quiet) clearInterval(quiet);
  await Promise.race([Promise.all(pumps), new Promise((r) => setTimeout(r, 300))]); rs.forEach((r) => r.cancel().catch(() => {}));
  if (opts.group) killGroup(); const cut = timeout.aborted || signal.aborted;
  const out = cut ? "" : stripAnsi(tail.slice(-keep)), spawnTool = exitCode !== 0 && !cut ? spawnFailedTool(out, exitCode) : null; // SPAWN-NOT-RUN: a tool that could not start is a missing tool, never a code failure
  return { ok: exitCode === 0 && !cut, missing: spawnTool !== null, cut, out, ...(spawnTool ? { spawnTool } : {}), ...(silent ? { silent } : {}) }; // FC-69
}
/** Runs one check with a single retry: fail-then-pass is "flaky", not "fail". A missing tool, a  timed-out/aborted run, or a run that executed 0 tests is recorded once as not_run and never retried. */
export async function runCheck(
  ctx: RunContext, name: string, cmd: string, args: string[], signal: AbortSignal,
  checks: VerifyCheck[], opts: RunOpts = {},
): Promise<VerifyCheck> {
  const started = Date.now();
  const cmdStr = [cmd, ...args].join(" ");
  const kind = opts.kind ?? "test";
  const cwd = opts.cwd ?? ctx.repoDir;
  const one = async (a: Awaited<ReturnType<typeof runOnce>>) => {
    let c: ReturnType<typeof classifyCheck> & { owner?: "harness"; load_external?: string[] } = await corroboratePass(classifyCheck({ kind, ok: a.ok, cut: a.cut, missing: a.missing, out: a.out, ...goRunner(cmd, args), path: /\.[cm]?[jt]s$/.test(args[args.length - 1] ?? "") ? args[args.length - 1] : undefined }), a.out, cmd, args, { cwd, env: opts.path ? { ...plainTestEnv(), PATH: opts.path } : plainTestEnv(), signal });
    if (c.result === "not_run" && c.reason === UNMEASURED_REASON && opts.changedTest) { const fb = lineVerdict(a.out, a.ok, name.slice(name.indexOf(":") + 1), name.slice(0, Math.max(0, name.indexOf(":")))); if (fb) c = fb; } // G5 LINE-FALLBACK: never unmeasured on the change's own test file
    const hl = kind === "test" && !a.ok && !a.cut && !a.missing ? await harnessLoad({ repoDir: ctx.repoDir, baseSha: ctx.baseSha, skip: installOwned(ctx.repoDir, ctx.outputs?.().intake?.install_created), out: a.out, cmd, args, signal, cwd, protect: opts.protect, ...(opts.path ? { env: { PATH: opts.path } } : {}) }) : undefined, lr = hl?.reason; // FC-02: only kind "test"; lint/tsc/selector (kind "static") never reach it
    if (lr) c = { result: "not_run", reason: lr, owner: "harness", ...(hl!.external.length ? { load_external: hl!.external } : {}) }; // UNRUNNABLE-EXTERNAL: the modules both sides miss
    if (!lr && kind === "static" && !a.ok && !a.cut && !a.missing && opts.wall?.size && wallOwnedFailure(a.out, cwd, ctx.repoDir, opts.wall)) c = { result: "not_run", reason: WALL_COMPILE_REASON, owner: "harness" }; // FC-23: never a fix round on a read-only Wall file // harness-owned load error: never retried, never a fix round
    const reason = a.missing ? (a.spawnTool ? `${a.spawnTool} could not be started (not installed)${installHint(a.spawnTool)}` : `${cmd} not found on PATH${installHint(cmd)}`) : a.cut ? (signal.aborted ? "aborted" : a.silent ? `stopped after ${cmdSilenceS()}s with no output` : `timed out after ${(opts.timeoutMs ?? checkTimeoutMs()) / 1000}s`) : c.reason;
    return { ...c, ...(reason ? { reason } : {}) };
  };
  const rep = kind === "test" && !opts.opaque && structuredResultsMode() !== "off" ? reportSource(cmd, args) : null, repDir = rep ? mkdtempSync(join(tmpdir(), "loki-report-")) : null, repFile = repDir ? join(repDir, "report") : null; // VERIFY-PLAN V5: cmdStr above stays the original command
  const withRep = (w: boolean): string[] => (w && repFile ? [...args, ...(reportArgs(cmd, args, repFile) ?? [])] : args);
  const runAll = async (w: boolean) => {
  const once = (): ReturnType<typeof runOnce> => kind === "static" ? guardEnv(ctx.repoDir, name, () => runOnce(cmd, args, cwd, signal, opts), ctx.runDir) : runOnce(cmd, withRep(w), cwd, signal, opts); // G2: a command Loki chose never leaves the environment changed
  let attempt = await once();
  let c = await one(attempt);
  let result: VerifyCheck["result"] = c.result;
  if (c.result === "fail") {
    attempt = await once();
    c = await one(attempt);
    result = c.result === "not_run" ? "not_run" : c.result === "pass" ? "flaky" : "fail";
  }
  return { attempt, c, result };
  };
  let st: Structured | null = null;
  try {
  let { attempt, c, result } = await runAll(repFile !== null);
  if (repFile && result !== "pass" && !attempt.cut && !attempt.missing && readReport(repFile, rep!) === null) { // V5: the runner rejected the report options: the same sequence, flaky retry included, with the original arguments
    ({ attempt, c, result } = await runAll(false));
    st = { report_unsupported: true };
  }
  const reason = c.reason;
  const anchor = result === "fail" ? firstFileLineAnchor(attempt.out.slice(-65536)) : null;
  const check: VerifyCheck = { name, cmd: cmdStr, result, duration_s: (Date.now() - started) / 1000, ...(result === "fail" ? { first_error: firstError(attempt.out), ids: failIds(attempt.out), ...(anchor ? { anchor } : {}) } : result === "pass" && kind === "test" ? { n: c.n ?? 0, sk: skipped(attempt.out) } : {}), ...(reason ? { reason } : {}), ...(attempt.missing ? { skip_code: "tool_not_on_path" as const } : {}), ...(c.owner ? { owner: "harness" as const } : {}), ...(opts.interpreter ? { interpreter: opts.interpreter } : {}), ...(c.count === LINE_FALLBACK_COUNT ? { count: c.count } : {}),
    ...(result === "not_run" && c.owner === "harness" && c.load_external?.length ? { load_external: c.load_external, load_note: harnessNote(reason, name) } : {}), // UNRUNNABLE-EXTERNAL: the line verify lists for this check below
  };
  if (repFile && !st) { const tr = readReport(repFile, rep!); if (tr) st = { source: tr.source, run: tr.run, failed: tr.failed, skipped: tr.skipped, text_run: check.n ?? c.n ?? ran(attempt.out) ?? null, text_failed: check.ids?.length ?? null, agrees: (check.n ?? c.n ?? ran(attempt.out) ?? -1) === tr.run && (check.result !== "fail" || (check.ids?.length ?? -1) === tr.failed) }; }
  if (st) structured.set(check, st);
  if (result === "fail" && !opts.opaque && !isHold(check)) { { const cs = crashSignature(attempt.out); if (cs) crashSigs.set(check, cs); } excerpts.set(check, failureExcerpt(attempt.out, ctx.repoDir)); failOuts.set(check, attempt.out); failTails.set(check, wallTailOf(attempt.out, ctx.repoDir)); headErrors.set(check, errorsById(attempt.out)); if (kind === "test" && !check.ids?.length) noIdOut.set(check, attempt.out); }
  if (result === "fail" && kind === "static" && name.startsWith("lint:tsc")) tscOut.set(check, attempt.out);
  checks.push(check); if (opts.opaque && check.result !== "pass" && check.reason) recordHoldoutTriage(ctx.runDir, { check: name, result: check.result, reason: check.reason }); // C-C4b-c-b: real reason stays out of the event below
  ctx.emit("test.result", "verify", opts.opaque ? { ...pubHold(check) } : { ...check, ...unmeasuredTail(check, attempt.out) }); // UNMEASURED-TAIL: the event only, never the receipt
  return check;
  } finally { if (repDir) rmSync(repDir, { recursive: true, force: true }); }
}

// L027: one vitest process per package for all its selected files, instead of one process per file. FireLater#24: a change to a shared module
// selected about 45 frontend page tests; one process each took 150 s of a verify that then hit its limit twice, while the whole frontend suite in
// one process took 11 s. A batched file is reported as the text vitest prints for that file alone, so every shared parser (ran, skipped, failIds,
// firstError, failureExcerpt) reads it exactly as a per-file run. A file the batch cannot vouch for (no report, a load or collect error, zero
// executed tests) runs alone through runCheck as before. LOKI_E10_VERIFY_BATCH=0 turns batching off.
export const verifyBatchOn = (env: NodeJS.ProcessEnv = process.env): boolean => env["LOKI_E10_VERIFY_BATCH"] !== "0";
const BATCH_MIN = 2;
const UNHANDLED_RE = /Unhandled (?:Errors?|Rejection)\b/;
const batchTimeoutMs = (files: number): number => defaultBudgetsOn() ? Math.max(CHECK_TIMEOUT_MS, Math.min(300_000, files * 5_000)) : Infinity;
interface VitestAssertion { status?: unknown; title?: unknown; ancestorTitles?: unknown; failureMessages?: unknown }
type FileRun = { ok: boolean; out: string };
/** A plain per-file vitest command (check_result.ts runnerCmd): `npx --no-install vitest run <file>`; anything else (a repo test command) is never batched. */
const vitestFile = (t: TestRef, c: { cmd: string; args: string[] }): boolean => t.runner === "vitest" && c.cmd === "npx" && c.args.length === 4 && c.args[0] === "--no-install" && c.args[1] === "vitest" && c.args[2] === "run";
/** One file's assertion results rendered as vitest's default reporter prints that file run alone (non-TTY). */
export function vitestFileText(rel: string, asserts: VitestAssertion[]): FileRun {
  const st = (a: VitestAssertion): string => String(a.status ?? ""), path = (a: VitestAssertion): string => [...(Array.isArray(a.ancestorTitles) ? a.ancestorTitles.map(String) : []), String(a.title ?? "")].join(" > ");
  const failed = asserts.filter((a) => st(a) === "failed"), passed = asserts.filter((a) => st(a) === "passed").length, skippedN = asserts.length - failed.length - passed;
  const lines = [` ${failed.length ? "❯" : "✓"} ${rel} (${asserts.length} tests${failed.length ? ` | ${failed.length} failed` : ""}${skippedN ? ` | ${skippedN} skipped` : ""}) 0ms`]; // the duration vitest prints: firstError strips it, so the stall signature is byte-equal to a per-file run's
  for (const a of asserts) if (st(a) === "passed" || st(a) === "failed") lines.push(`   ${st(a) === "failed" ? "×" : "✓"} ${String(a.title ?? "")} 0ms`);
  lines.push("");
  for (const a of failed) lines.push(` FAIL  ${rel} > ${path(a)}`, ...(Array.isArray(a.failureMessages) ? a.failureMessages.map((m) => String(m).slice(0, 4000)) : []), "");
  const parts = [failed.length ? `${failed.length} failed` : "", passed ? `${passed} passed` : "", skippedN ? `${skippedN} skipped` : ""].filter(Boolean).join(" | ");
  lines.push(` Test Files  ${failed.length ? "1 failed" : "1 passed"} (1)`, `      Tests  ${parts} (${asserts.length})`);
  return { ok: failed.length === 0, out: lines.join("\n") };
}
/** One `vitest run` of `rels` (paths as vitest takes them from `cwd`) with the JSON reporter writing to a Loki-owned temp file. Per-file results keyed
 *  by the rel given. A pass needs the file's own status "passed"; a file with no assertion results, a suite-level error, or status "failed" with
 *  every assertion passed (a describe-level hook that throws) is left out, and the caller runs it alone. Null (vouch for nothing) when the run gave
 *  no readable report (cut by its timeout or the stage, tool missing, malformed JSON), printed an unhandled error, or exited nonzero with no failed file. */
export async function vitestBatch(cwd: string, rels: string[], signal: AbortSignal, opts: { timeoutMs?: number; path?: string } = {}): Promise<Map<string, FileRun> | null> {
  const dir = mkdtempSync(join(tmpdir(), "loki-vbatch-")), file = join(dir, "report.json");
  try {
    // The default reporter beside the JSON one: an unhandled error or rejection is printed there and nowhere in the JSON (vitest 2.1.9, 4.0.16, 4.1.12, 5.1.0).
    const r = await runOnce("npx", ["--no-install", "vitest", "run", "--reporter=json", "--reporter=default", `--outputFile.json=${file}`, ...rels], cwd, signal, { timeoutMs: opts.timeoutMs ?? batchTimeoutMs(rels.length), group: true, ...(opts.path ? { path: opts.path } : {}) });
    if (r.cut || r.missing || !existsSync(file) || UNHANDLED_RE.test(r.out)) return null; // an unhandled error belongs to no file: the batch vouches for nothing
    const rep = JSON.parse(readFileSync(file, "utf8")) as { testResults?: { name?: unknown; status?: unknown; message?: unknown; assertionResults?: unknown }[] };
    const tests = rep.testResults ?? [], failedFile = (tr: (typeof tests)[number]): boolean => tr.status === "failed";
    if (!r.ok && !tests.some(failedFile)) return null; // a nonzero exit no file's status explains
    const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } }, byAbs = new Map<string, string>();
    for (const rel of rels) for (const p of [resolve(cwd, rel), real(resolve(cwd, rel))]) byAbs.set(p, rel);
    const out = new Map<string, FileRun>();
    for (const tr of tests) {
      const rel = byAbs.get(String(tr.name ?? "")), asserts = Array.isArray(tr.assertionResults) ? (tr.assertionResults as VitestAssertion[]) : [], f = rel ? vitestFileText(rel, asserts) : null;
      if (!rel || !f || asserts.length === 0 || (typeof tr.message === "string" && tr.message.trim() !== "")) continue; // a load or collect error: run alone
      if (f.ok ? tr.status === "passed" : failedFile(tr)) out.set(rel, f); // a failed file with every assertion passed (a hook that throws) runs alone
    }
    return out;
  } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** The batched form of runCheck for vitest files grouped by package: one run, then one batched rerun of the files that failed (fail-then-pass is
 *  "flaky", as in runCheck). Records and emits a check only for a file the batch vouches for: a pass with n > 0, or a fail on both runs that is not
 *  a runner load error. Returns the checks keyed by check name; every other file is left for runCheck. */
async function runVitestBatches(ctx: RunContext, tests: TestRef[], api: ProjectApi | null, signal: AbortSignal, onCheck: (c: VerifyCheck) => void): Promise<Map<string, VerifyCheck>> {
  const got = new Map<string, VerifyCheck>(), groups = new Map<string, { t: TestRef; tc: ReturnType<typeof commandFor> }[]>();
  for (const t of tests) { const tc = commandFor(t, ctx.repoDir, api); if (vitestFile(t, tc)) groups.set(tc.cwd, [...(groups.get(tc.cwd) ?? []), { t, tc }]); }
  for (const [cwd, g] of groups) {
    if (g.length < BATCH_MIN || signal.aborted) continue;
    const rel = (x: { tc: { args: string[] } }): string => x.tc.args[x.tc.args.length - 1]!, t0 = Date.now();
    const first = await vitestBatch(cwd, g.map(rel), signal);
    if (!first) continue;
    const classify = (f: FileRun): ReturnType<typeof classifyCheck> => classifyCheck({ kind: "test", ok: f.ok, cut: false, missing: false, out: f.out });
    const failing = g.filter((x) => { const f = first.get(rel(x)); return f !== undefined && classify(f).result === "fail" && classifyRunnerOutput(f.out).kind !== "load_error"; });
    const second = failing.length && !signal.aborted ? await vitestBatch(cwd, failing.map(rel), signal) : null;
    const share = (Date.now() - t0) / 1000 / g.length;
    for (const x of g) {
      const a = first.get(rel(x)); if (!a) continue;
      const ca = classify(a), b = ca.result === "fail" && failing.includes(x) ? second?.get(rel(x)) : undefined, cb = b ? classify(b) : null;
      const result: VerifyCheck["result"] | null = ca.result === "pass" && (ca.n ?? 0) > 0 ? "pass" : cb?.result === "pass" ? "flaky" : cb?.result === "fail" ? "fail" : null;
      if (!result) continue; // not vouched for: runCheck runs it alone
      const outText = b?.out ?? a.out, anchor = result === "fail" ? firstFileLineAnchor(outText) : null;
      const check: VerifyCheck = { name: testCheckName(x.t), cmd: x.tc.argv.join(" "), result, duration_s: share, ...(result === "fail" ? { first_error: firstError(outText), ids: failIds(outText), ...(anchor ? { anchor } : {}) } : result === "pass" ? { n: ca.n ?? 0, sk: skipped(a.out) } : {}) };
      if (result === "fail") { { const cs = crashSignature(outText); if (cs) crashSigs.set(check, cs); } excerpts.set(check, failureExcerpt(outText, ctx.repoDir)); failOuts.set(check, outText); failTails.set(check, wallTailOf(outText, ctx.repoDir)); headErrors.set(check, errorsById(outText)); }
      got.set(check.name, check); ctx.emit("test.result", "verify", { ...check }); onCheck(check);
    }
  }
  return got;
}
// SPEED-GO-BATCH: one `go test -json -run ^(union)$ <pkg>` per package instead of one per file. Each per-file run compiles and links the same package
// test binary and is then corroborated (a -count=1 -coverprofile rerun plus go list and go tool cover), so 27 files in one package paid 27 builds and
// 27 corroborations (L-Haiku-v131 cli-2418: 35 s of targeted go runs). The batch vouches only for a whole package that passes AND survives the same
// corroboratePass a per-file run needs (Wall, task-named and edited files are never batched: their per-file run is the fail-then-pass proof); any failure, torn stream or refused corroboration leaves every file of that package to runCheck, as before.
// LOKI_E10_GO_BATCH=0 (or LOKI_E10_VERIFY_BATCH=0) turns it off.
export const goBatchOn = (env: NodeJS.ProcessEnv = process.env): boolean => verifyBatchOn(env) && env["LOKI_E10_GO_BATCH"] !== "0";
/** A plain per-file go command (check_result.ts runnerCmd): `go test -json -run ^(names)$ <pkg>`; a repo test command or a whole-package run is never batched. */
const goFileCmd = (t: TestRef, c: { cmd: string; args: string[] }): boolean => t.runner === "go" && c.cmd === "go" && c.args.length === 5 && c.args[0] === "test" && c.args[1] === "-json" && c.args[2] === "-run" && /^\^\([A-Za-z0-9_|]+\)\$$/.test(c.args[3]!);
/** Only an untouched go test file joins a batch: the Wall, task-named (`targets`) and edited (`changed`) files keep their own per-file run, which is the fail-then-pass proof. */
export const goBatchable = (t: TestRef, targets: ReadonlySet<string>, changed: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean => goBatchOn(env) && t.runner === "go" && !targets.has(testCheckName(t)) && !changed.includes(t.path);
/** One file's share of a batched go -json stream: package-level events plus the events of its own top-level tests (and their subtests). */
export function goFileStream(out: string, names: ReadonlySet<string>): string {
  return out.split("\n").filter((l) => {
    if (!l.startsWith("{")) return l.trim() === "" || /^go: /.test(l);
    try { const e = JSON.parse(l) as { Test?: unknown }; if (typeof e.Test !== "string") return true; const top = e.Test.split("/")[0]!; return names.has(top); } catch { return true; } // an unparseable line stays, so the per-file stream reads torn exactly as the batch would
  }).join("\n");
}
export async function runGoBatches(ctx: RunContext, tests: TestRef[], api: ProjectApi | null, signal: AbortSignal, onCheck: (c: VerifyCheck) => void): Promise<Map<string, VerifyCheck>> {
  const got = new Map<string, VerifyCheck>(), groups = new Map<string, { t: TestRef; tc: ReturnType<typeof commandFor>; names: string[] }[]>();
  for (const t of tests) { const tc = commandFor(t, ctx.repoDir, api); if (!goFileCmd(t, tc)) continue; const k = `${tc.cwd}\0${tc.args[4]}`; groups.set(k, [...(groups.get(k) ?? []), { t, tc, names: tc.args[3]!.slice(2, -2).split("|") }]); }
  for (const g of groups.values()) {
    if (g.length < BATCH_MIN || signal.aborted) continue;
    const cwd = g[0]!.tc.cwd, union = [...new Set(g.flatMap((x) => x.names))], args = ["test", "-json", "-run", `^(${union.join("|")})$`, g[0]!.tc.args[4]!], t0 = Date.now();
    const a = await runOnce("go", args, cwd, signal, { timeoutMs: batchTimeoutMs(g.length) });
    const c = await corroboratePass(classifyCheck({ kind: "test", ok: a.ok, cut: a.cut, missing: a.missing, out: a.out, runner: "go" }), a.out, "go", args, { cwd, env: plainTestEnv(), signal });
    if (c.result !== "pass") continue; // red, torn or uncorroborated: every file runs alone, so a failure is judged exactly as today
    const share = (Date.now() - t0) / 1000 / g.length;
    for (const x of g) {
      const own = goFileStream(a.out, new Set(x.names)), cf = classifyCheck({ kind: "test", ok: true, out: own, runner: "go" });
      if (cf.result !== "pass" || (cf.n ?? 0) === 0) continue; // a file whose tests did not all run and pass in the corroborated batch runs alone
      const check: VerifyCheck = { name: testCheckName(x.t), cmd: x.tc.argv.join(" "), result: "pass", duration_s: share, n: cf.n ?? 0, sk: skipped(own) };
      got.set(check.name, check); ctx.emit("test.result", "verify", { ...check }); onCheck(check);
    }
  }
  return got;
}
/** Selected tests that exercise a symbol the diff declares or changes (check_result.ts changedSymbols) run first, so a stage stopped at its limit
 *  has run the tests most likely to catch this change. Order is otherwise kept. */
/** The symbols the diff declares or changes in its non-test code files (check_result.ts changedSymbols), 3 characters or more; [] when none or git fails. */
function diffSymbols(ctx: RunContext, changed: string[]): string[] {
  const code = changed.filter((f) => CODE_EXT.test(f) && !isTestFile(f));
  if (code.length === 0) return [];
  try { return changedSymbols(safeGit(ctx.repoDir, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", ctx.baseSha, "--", ...code], { timeout: 20000 }), (p) => readFileSync(join(ctx.repoDir, p), "utf8")).filter((n) => n.length >= 3); } catch { return []; }
}
function changedSymbolsFirst(ctx: RunContext, tests: TestRef[], changed: string[]): TestRef[] {
  if (tests.length < 2) return tests;
  const names = diffSymbols(ctx, changed);
  if (names.length === 0) return tests;
  const re = new RegExp(`\\b(?:${names.map((n) => escapeRegex(n)).join("|")})\\b`);
  const hits = tests.filter((t) => { try { return re.test(readFileSync(join(ctx.repoDir, t.path), "utf8")); } catch { return false; } });
  return [...hits, ...tests.filter((t) => !hits.includes(t))];
}
/** A failing check the next fix round is given: not pre-existing, not held out, and not known red failing the same way as on base (a known-red check
 *  failing with a different error on head is something the change did, so it is fix-round input). */
/** UNCAUSED LOKI_E10_UNCAUSED_NO_FIX (default on, =0 opts out): a red check the diff cannot have caused never feeds a fix round (dev2: axios spent 2 rounds on http-adapter
 *  port clashes and a docs tsc error after a change to .d.ts files, docs and one test). It stays a failing check: the verdict is unchanged, only the round is not spent.
 *  "Cannot have caused", fail-safe: no failing id or diagnostic names a changed file, and (a test or suite) the diff changes no file that runs (only docs, type declarations,
 *  test files and changelog fragments) or (a lint) every diagnostic sits in an unchanged file and names no symbol the diff changed. Wall, targeted and base-green-now-red
 *  checks are never uncaused (the caller's independent set). Fire marker: verify records uncaused_reds. */
export const uncausedOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_UNCAUSED_NO_FIX"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
const LINT_CONFIG = /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|biome\.jsonc?|\.?ruff\.toml|pyproject\.toml|setup\.cfg|mypy\.ini|\.flake8|tox\.ini|package\.json|\.golangci\.ya?ml|clippy\.toml|Cargo\.toml)$/;
const INERT_FILE = /\.(?:md|mdx|rst|txt|adoc)$|\.d\.[cm]?ts$|(?:^|\/)(?:changelog\.d|changes|newsfragments|\.changeset)\/|(?:^|\/)(?:CHANGELOG|HISTORY|NEWS)[^/]*$/i;
export function uncausedRed(c: { name: string; ids?: string[] }, changed: readonly string[], symbols: readonly string[], excerpt: string): boolean {
  const names = (t: string): boolean => changed.some((f) => t.includes(f) || t.includes(basename(f)));
  if ((c.ids ?? []).some(names) || names(c.name)) return false;
  if (c.name.startsWith("lint:")) {
    const files = [...excerpt.matchAll(/^([\w./@-]+\.\w+)[(:]\d+/gm)].map((m) => m[1]!);
    return files.length > 0 && !files.some((f) => changed.includes(f)) && !changed.some((f) => LINT_CONFIG.test(f)) && !symbols.some((sym) => sym.length > 2 && new RegExp(`\\b${escapeRegex(sym)}\\b`).test(excerpt)); // a changed linter or compiler config can raise errors in any file
  }
  return changed.length > 0 && changed.every((f) => INERT_FILE.test(f) || isTestFile(f));
}
/** LINT-OWN (playwright#44124: Haiku, 4 of 4 asks, 0 of 159 tests broken, sealed FAILED on two unused imports its own change added): a style lint (eslint, ruff,
 *  shellcheck) or type check (tsc) red is the change's own when it feeds a fix round (red, not on base: excuseLint and the tsc base checks already moved a
 *  base-present one to the pre-existing set) and at least one of its diagnostics sits in a file the change touched (not uncaused). Both are independent checks
 *  (they pass the Haiku fix gate, so the round gets the exact lines). Only a style lint is recorded as own_lint, which seal holds at PARTIAL when it is the run's
 *  only red; a type error or a shell syntax error (tsc, bash -n) that survives the rounds is a real defect and stays FAILED. */
export const OWN_LINT = /^lint:(?:eslint|ruff|shellcheck)(?::|$)/, OWN_TYPECHECK = /^lint:(?:tsc|bash-n)(?::|$)/;
/** INDEP-GATE LOKI_E10_HAIKU_INDEP_FIX (default on, =0 opts out): a Haiku run gets no fix round unless an independent check failed (dev2: rounds ran on 11 of 20
 *  Loki-Haiku runs and flipped none of the losses). */
export const haikuIndepFixOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_HAIKU_INDEP_FIX"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
/** FIX-GATE: the Haiku gate's reading of one verify result, the one predicate machine.ts acts on and the reason verify records as fix_gate in its stage.completed
 *  event (playwright#44124: why no round opened could not be read from the record). `models` holds the implement and run model names. "closed: ..." means no
 *  fix round opens on this verify; the machine's own stops (cap, fatal provider error) are recorded separately. */
export function fixGateOf(v: { independent_fail?: unknown; independent_reds?: unknown } | undefined, models: string, failing = true, env: NodeJS.ProcessEnv = process.env): string {
  if (!failing) return "none: no failing check feeds a fix round";
  const reds = Array.isArray(v?.independent_reds) ? (v!.independent_reds as unknown[]).map(String) : [];
  if (!/haiku/i.test(models)) return "open: not a Haiku run";
  if (!haikuIndepFixOn(env)) return "open: LOKI_E10_HAIKU_INDEP_FIX=0";
  return v?.independent_fail === false ? "closed: haiku: no independent check failed (LOKI_E10_HAIKU_INDEP_FIX)" : `open: independent check failed${reds.length ? `: ${reds.slice(0, 5).join(", ")}` : ""}`;
}
export const ownLintOf = (c: { name: string; result: string; ids?: string[] }, pre: { names: string[]; knownRed: string[]; sameError: string[] }, changed: readonly string[], symbols: readonly string[], excerpt: string, re: RegExp = OWN_LINT): boolean =>
  re.test(c.name) && feedsFixRound(c, pre) && !uncausedRed(c, changed, symbols, excerpt);
export const feedsFixRound = (c: { name: string; result: string }, pre: { names: string[]; knownRed: string[]; sameError: string[] }): boolean => c.result === "fail" && !pre.names.includes(c.name) && !pre.sameError.includes(c.name) && !isHoldoutCheck(c.name);
type Counts = { run: number; skipped: number };
type BaseSubtraction = { ids: string[]; names: string[]; knownRed: string[]; sameError: string[]; quiet: string[]; shapeDiffers: string[]; compared: string[]; silent: Record<string, number>; fresh: Record<string, number>; baseLoad: Record<string, string[]>; weak: string[]; zero: string[]; cnt: Record<string, { b: Counts; h: Counts }>; envCrash: { name: string; sig: string }[] }; // compared: failing untouched checks whose base rerun passed or parsed a failing id (it ran their tests; one that lost its dependencies, was cut or never ran is not in it); quiet: in sameError on the fl24 second chance (text differs by noise, names nothing changed); shapeDiffers: known red whose head error has another shape than its base rerun's (the change altered the failure)
/** The go -json stream carries a package-level pass event and no package-level fail. */
export function goPackagePassed(out: string): boolean {
  let pass = false;
  for (const l of out.split("\n")) { if (!l.startsWith("{")) continue; try { const e = JSON.parse(l) as { Test?: unknown; Action?: string }; if (typeof e.Test === "string") continue; if (e.Action === "fail") return false; if (e.Action === "pass") pass = true; } catch { return false; } }
  return pass;
}
/** One file's stream shows every named top-level test passed and nothing failed. */
export function goStreamGreen(own: string, names: readonly string[]): boolean {
  const passed = new Set<string>();
  for (const l of own.split("\n")) { if (!l.startsWith("{")) continue; try { const e = JSON.parse(l) as { Test?: unknown; Action?: string }; if (e.Action === "fail") return false; if (e.Action === "pass" && typeof e.Test === "string" && !e.Test.includes("/")) passed.add(e.Test); } catch { return false; } }
  return names.length > 0 && names.every((n) => passed.has(n));
}
// SPEED-GO-BATCH on base: the go files of one package that need a base rerun (relevant passes for counts, untouched red files for ids) run in one go test per package;
// only a file whose tests all ran and passed in a passing package result is taken from it, every other file reruns alone.
// A cut or missing run leaves every file to the caller's per-file loop. The fail-then-pass proof itself is seal.ts failThenPass, which this never feeds.
async function baseGoBatch(items: { c: VerifyCheck; t: TestRef; bc: ReturnType<typeof commandFor> }[], signal: AbortSignal, record: (c: VerifyCheck, b: { ok: boolean; cut?: boolean; out: string }) => void): Promise<void> {
  if (!goBatchOn()) return;
  const byPkg = new Map<string, typeof items>();
  for (const x of items) if (goFileCmd(x.t, x.bc)) { const k = `${x.bc.cwd}\0${x.bc.args[4]}`; byPkg.set(k, [...(byPkg.get(k) ?? []), x]); }
  for (const g of byPkg.values()) {
    if (g.length < BATCH_MIN || signal.aborted) continue;
    const names = g.map((x) => x.bc.args[3]!.slice(2, -2).split("|")), args = ["test", "-json", "-run", `^(${[...new Set(names.flat())].join("|")})$`, g[0]!.bc.args[4]!];
    const a = await runOnce("go", args, g[0]!.bc.cwd, signal, { timeoutMs: batchTimeoutMs(g.length) });
    if (a.cut || a.missing) continue;
    const pkgPass = goPackagePassed(a.out); // a red, panicked or torn package result trusts no file of it: every file reruns alone
    g.forEach((x, i) => { const own = goFileStream(a.out, new Set(names[i])); if (pkgPass && goStreamGreen(own, names[i]!)) record(x.c, { ok: true, out: own }); }); // only a fully green file is taken from the batch: a red file's verdict may depend on a sibling (package-global state, order), so it reruns alone
  }
}
/** A-112: a test check red on head, in a file the diff did not touch, whose every failing id is also red on a pristine detached base  worktree (never a reset of the implement tree, D42 (2)) is  pre_red: ids go to NOT PROVEN,  seal skips it in the verdict, the check
 *  stays  "fail" and in the fix loop unless the TARGET progressed: a passing Wall test, or a relevant test (`rel`: impacted  tests of the task-named  files, the lean-path Wall stand-in)  that failed on base, now passes and ran no fewer tests (absent or skipped is
 *  not green). Relevant checks  are never pre_red. Base  reruns get no node_modules or .venv: a dependency-only failure yields no ids (failIds needs  the count covered).  A-115: a relevant check that passes with more skipped or deselected tests than  base is `weak`:
 *  no progress, and the caller lists it in  NOT PROVEN (a skipped target is not a fixed target). Weak also  means it ran FEWER tests than base (pytest.exit, xfail, a deleted test):  every relevant pass is compared with its base run, and xfailed counts as skipped,
 *  never passed.  FC-ZERO-ON-BASE + FC-REPO-SKIPPED-TEST-DOWNGRADES:  an untouched, non-Wall, non-holdout check  (relevant ones included) that ran zero tests and also runs zero on base (`zeroOk`: no test config edit; zeroOnBase withholds when the linked dependency
 *  dirs can see head,  depsSeeHead, and, for intake's lazy record, when envChangedSince finds the environment changed since intake) is  out.zero; seal keeps it in the receipt as repo_skipped and out of the verdict.  ponytail: bun/go/cargo/npm yield no ids and no skip count, so they are never subtracted or judged weak. */
/** BASE-MEMO (FireLater#24 s3, LOKI_E10_BASE_MEMO default on, =0 reruns base every verify): the base commit never changes inside a run, so a base result for one
 *  command (its cwd and args relative to the base worktree, and whether the head's dependency dirs were linked) is kept in the run dir and reused by every later
 *  verify of the same run (FireLater#24 s3: a re-verify stopped at its 120 s limit after a 3-minute gap past its targeted tests; the cause of that gap is not measured,
 *  the same 22 base files batched alone take 8 s, so this is a saving on repeated base runs, not the whole fix).
 *  Only a finished run is kept (never a cut, aborted or missing-tool one); the file is bound to the base sha, so another base reads nothing. */
export const baseMemoOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_BASE_MEMO"] ?? "").trim());
type BaseMemo = { get: (key: string) => FileRun | undefined; put: (key: string, r: FileRun) => void; save: () => void; key: (dir: string, bc: { cmd: string; args: string[]; cwd: string }, deps: boolean) => string };
export function baseMemo(runDir: string, baseSha: string, on = baseMemoOn()): BaseMemo {
  const file = join(runDir, "base-runs.json"); let runs: Record<string, FileRun> = {}, dirty = false;
  if (on) try { const m = JSON.parse(readFileSync(file, "utf8")) as { base?: unknown; runs?: Record<string, FileRun> }; if (m.base === baseSha && m.runs && typeof m.runs === "object") runs = m.runs; } catch { /* first verify of the run */ }
  return {
    key: (dir, bc, deps) => JSON.stringify([bc.cmd, bc.args.map((a) => a.split(dir).join("<base>")), relative(dir, bc.cwd), deps]),
    get: (k) => (on ? runs[k] : undefined),
    put: (k, r) => { if (!on) return; runs[k] = { ok: r.ok, out: r.out.length > 65536 ? r.out.slice(-65536) : r.out }; dirty = true; },
    save: () => { if (on && dirty) try { atomicWriteText(file, JSON.stringify({ base: baseSha, runs })); } catch { /* best effort: the next verify reruns base */ } },
  };
}
export async function subtractBase(
  ctx: RunContext, api: ProjectApi | null, checks: VerifyCheck[], tests: TestRef[], changed: string[],
  wall: Set<string>, rel: Set<string>, signal: AbortSignal, zeroOk = true, zeroIntake: ZeroGate = zeroGate(null), dep: ReadonlySet<string> = new Set(), own: ReadonlySet<string> = rel, symbols: readonly string[] = [],
): Promise<BaseSubtraction> {
  const out: BaseSubtraction = { ids: [], names: [], knownRed: [], sameError: [], quiet: [], shapeDiffers: [], compared: [], silent: {}, fresh: {}, baseLoad: {}, weak: [], zero: [], cnt: {}, envCrash: [] };
  const pairs = checks.flatMap((c) => {
    const t = tests.find((x) => testCheckName(x) === c.name);
    return t ? [{ c, t }] : [];
  });
  const un = pairs.filter(({ t }) => !changed.includes(t.path));
  const sus = pairs.filter(({ c }) => rel.has(c.name) && c.result === "pass");
  const crash = baseCrashEnvOn() ? pairs.filter(({ c }) => c.result === "fail" && !c.ids?.length && crashSigs.has(c)) : []; // BCE: own and untouched alike
  const zc = zeroOk ? un.filter(({ c, t }) => c.result === "not_run" && !c.owner && (c.reason ?? "").startsWith(NO_TESTS_REASON) && !wall.has(c.name) && !isHoldoutCheck(c.name) && !changed.includes(t.path) && zeroIntake.has(c.name)) : []; if (!(un.some(({ c }) => c.result === "fail" && c.ids?.length) || sus.length || zc.length || crash.length) || signal.aborted) return out;
  const dir = mkdtempSync(join(tmpdir(), "e10-base-"));
  const git = (args: string[]): void => { safeGit(ctx.repoDir, args, { stdio: "ignore", repoDrivers: true }); }; // worktree add checks out base content
  const memo = baseMemo(ctx.runDir ?? "", ctx.baseSha, !!ctx.runDir && baseMemoOn()); // a context with no run dir (unit callers) keeps no memo
  const once = async (bc: { cmd: string; args: string[]; cwd: string }, deps: boolean): Promise<{ ok: boolean; cut?: boolean; out: string }> => {
    const k = memo.key(dir, bc, deps), hit = memo.get(k); if (hit) return hit;
    const r = await runOnce(bc.cmd, bc.args, bc.cwd, signal, {}); if (!r.cut && !r.missing && !signal.aborted) memo.put(k, r); return r;
  };
  try {
    git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, ctx.baseSha]);
    const base = new Map<VerifyCheck, { red: string[]; n: number; sk: number; out: string; live: boolean }>();
    const record = (c: VerifyCheck, b: { ok: boolean; cut?: boolean; out: string }): void => { const red = !b.ok && !b.cut ? failIds(b.out) : []; base.set(c, { red, n: ran(b.out) ?? summaryPassFailCount(b.out), sk: skipped(b.out), out: b.cut ? "" : b.out, live: (b.ok && !b.cut) || red.length > 0 }); };
    // Relevant passes first, on a base without dependencies (their counts are compared as before). Only failing untouched checks need a base run
    // after that: a passing one's base result is never read.
    await baseGoBatch(sus.map(({ c, t }) => ({ c, t, bc: commandFor(t, dir, api) })), signal, record);
    for (const { c, t } of sus) { if (base.has(c)) continue; const bc = commandFor(t, dir, api); record(c, await once(bc, false)); }
    const red = un.filter(({ c }) => c.result === "fail" && c.ids?.length && !base.has(c));
    // A suite that needs its dependencies (a vitest package with its own node_modules) yields no ids on a bare base, so its pre-existing failures
    // could never be told apart from new ones (FireLater#24: 23 page tests red on base were fed to the fix rounds). The head's dependency dirs are
    // linked in only when no dependency manifest that can affect that package changed (BASE-LINK-SCOPE) and baseDepsLinker's guards hold (fail closed otherwise); vitest files run batched per package.
    const blocked = (cwd: string): boolean => manifestBlocksBaseLink(changed, relative(dir, cwd) || ".", (f) => MANIFESTS.test(f)); // BASE-LINK-SCOPE: only for the packages a changed manifest can affect
    const link0 = baseDepsLinker(dir, ctx.repoDir, zeroIntake), link = (cwd: string): boolean => !blocked(cwd) && link0(cwd);
    const cmds = red.map((p) => ({ ...p, bc: commandFor(p.t, dir, api) }));
    for (const bc of new Set(cmds.map((x) => x.bc.cwd))) link(bc);
    const linkedAt = (cwd: string): boolean => !blocked(cwd); // the memo key: whether this cwd's run was allowed the head's dependency dirs
    for (const x of cmds) { const hit = memo.get(memo.key(dir, x.bc, linkedAt(x.bc.cwd))); if (hit) record(x.c, hit); } // BASE-MEMO: an earlier verify of this run already ran it on this base
    if (verifyBatchOn() && !signal.aborted) {
      const byCwd = new Map<string, typeof cmds>();
      for (const x of cmds) if (!base.has(x.c) && vitestFile(x.t, x.bc)) byCwd.set(x.bc.cwd, [...(byCwd.get(x.bc.cwd) ?? []), x]);
      for (const [cwd, g] of byCwd) {
        if (g.length < BATCH_MIN || signal.aborted) continue;
        const res = await vitestBatch(cwd, g.map((x) => x.bc.args[3]!), signal);
        for (const x of g) { const f = res?.get(x.bc.args[3]!); if (f) { record(x.c, f); if (!signal.aborted) memo.put(memo.key(dir, x.bc, linkedAt(x.bc.cwd)), f); } }
      }
    }
    await baseGoBatch(cmds.filter((x) => !base.has(x.c)).map((x) => ({ c: x.c, t: x.t, bc: x.bc })), signal, record);
    for (const { c, bc } of cmds) if (!base.has(c) && !signal.aborted) record(c, await once(bc, linkedAt(bc.cwd)));
    for (const { c, t } of crash) { // BCE: the same command on base, deps linked as for a red check
      if (signal.aborted) break;
      link(dir); link(commandFor(t, dir, api).cwd); const bc = commandFor(t, dir, api); // deps (the head's .venv or node_modules) linked first, so the command resolves the same interpreter
      const b = await runOnce(bc.cmd, bc.args, bc.cwd, signal, {}), sig = b.ok || b.cut ? null : crashSignature(b.out);
      if (sig && sig === crashSigs.get(c)) out.envCrash.push({ name: c.name, sig });
    }
    out.zero = await zeroOnBase(zc.map(({ c, t }) => ({ name: c.name, ...commandFor(t, dir, api) })), dir, ctx.repoDir, (r) => runOnce(r.cmd, r.args, r.cwd, signal, {}), (n) => ctx.emit("test.skipped_on_base", "verify", { note: `skipped on base: ${n}`, check: n }), zeroIntake);
    out.weak = sus
      .filter(({ c }) => (c.sk ?? 0) > base.get(c)!.sk || (c.n ?? 0) < base.get(c)!.n)
      .map(({ c }) => c.name);
    for (const { c } of sus) {
      out.cnt[c.name] = { b: { run: base.get(c)!.n, skipped: base.get(c)!.sk }, h: { run: c.n ?? 0, skipped: c.sk ?? 0 } };
    }
    // A-115b: sus includes an EDITED relevant file (its base-red ids now pass; the caller's `weakened test:` note keeps it PARTIAL)
    const progress = checks.some((c) => wall.has(c.name) && c.result === "pass")
      || sus.some(({ c }) => !out.weak.includes(c.name) && base.get(c)!.red.length > 0 && (c.n ?? 0) >= base.get(c)!.n);
    {
      for (const { c } of un) {
        if (c.result === "fail" && c.ids?.length && base.get(c)?.live) out.compared.push(c.name); // the base rerun ran this check's tests: what it showed decides, never the intake profile's ids alone
        if (c.result === "fail" && c.ids?.length && base.get(c)?.live) out.fresh[c.name] = comparableIds(c.ids).filter((i) => !base.get(c)!.red.includes(i)).length; // EXOGENOUS-RED: the failing ids its base rerun did not show red
        { const le = c.result === "fail" && base.has(c) ? loadErrors(base.get(c)!.out) : []; if (le.length) out.baseLoad[c.name] = le; } // EXOGENOUS-RED: a base rerun that could not load a module is not a comparison
        if (own.has(c.name) || c.result !== "fail" || !c.ids?.length || !comparableIds(c.ids).every((i) => base.get(c)?.red.includes(i))) continue;
        out.knownRed.push(c.name); // red on base by every failing id
        const sf = sameFailures(headErrors.get(c) ?? "", base.get(c)!.out, c.ids, { lines: failOuts.has(c) ? changeLines(failOuts.get(c)!, changedForLines(ctx.repoDir, ctx.baseSha, changed), symbols, CHANGE_LINES_MAX, PER_FILE_CUT_BYTES) : null, failed: failOuts.has(c) ? failedCount(failOuts.get(c)!) : null }, { lines: changeLines(base.get(c)!.out, changedForLines(ctx.repoDir, ctx.baseSha, changed), symbols, CHANGE_LINES_MAX, PER_FILE_CUT_BYTES), failed: failedCount(base.get(c)!.out) }); /* a per-file output is the last 64 KiB of the run on both sides: at that size it was cut */ // SILENT-IDS: ids with no error line on either side are compared by the lines naming the change
        if (sf.same) { out.sameError.push(c.name); if (sf.silent) out.silent[c.name] = sf.silent; } // and failing the same way: never fix-round input, and a delivery may excuse it as pre-existing; a different error feeds the fix round
        else if (noiseOnlyErrors(headErrors.get(c) ?? "", base.get(c)!.out, comparableIds(c.ids), changed, symbols)) { out.sameError.push(c.name); out.quiet.push(c.name); }
        else if ((headErrors.get(c)?.size ?? 0) > 0 && errorsById(base.get(c)!.out).size > 0) out.shapeDiffers.push(c.name); // fl24: both runs printed errors and they differ in shape: never evidence for a fix round's pre-existing claim // fl24: the text differs only by noise (same error shapes: numbers, quoted values, paths) and no failure names a changed file or symbol: the same treatment, listed NOT PROVEN by the caller
        if (progress || dep.has(c.name)) { // RX-3: a dependent-only check needs no progress proof
          out.names.push(c.name);
          out.ids.push(...c.ids);
        }
      }
    }
  } catch { /* base unavailable: checks stay failing */ } finally {
    memo.save();
    try { git(["worktree", "remove", "--force", dir]); } catch { /* pruned below */ }
    rmSync(dir, { recursive: true, force: true });
    try { git(["worktree", "prune"]); } catch { /* best effort */ }
  }
  return out;
}

// ponytail: existence of our own selector script is a strong enough marker that repoDir IS the loki-mode repo; a build target repo will not carry it.
function isLokiModeRepo(repoDir: string): boolean { return existsSync(join(repoDir, "scripts", "select-tests.sh")); }
const ESLINT_CONFIGS = [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];
/** ENGINE.md section 4's named tool per language: bash -n + shellcheck for shell, tsc + eslint  (when configured) for TS/JS, ruff for Python. Every named tool that applies to the changed set  gets
 *  a check entry: a missing tool is not_run, never silently absent (section 9 NOT PROVEN). */
/** TEN-QUALITY-03: a failed ruff/shellcheck/eslint check whose every diagnostic is also on the base content (git show, fed on stdin, same per-check timeout) is pre-existing. */
const excuseLint = (ctx: RunContext, signal: AbortSignal, c: VerifyCheck, tool: StaticTool, cmd: string, prefix: string[], cwd: string, rel: string[], opts: RunOpts): Promise<boolean> => c.result !== "fail" || signal.aborted ? Promise.resolve(false) : staticPreExisting(tool, prefix, rel, { run: async (a, stdin) => { if (signal.aborted) return null; const r = await runOnce(cmd, a, cwd, AbortSignal.any([signal, (Number.isFinite(opts.timeoutMs ?? checkTimeoutMs()) ? AbortSignal.timeout(opts.timeoutMs ?? checkTimeoutMs()) : new AbortController().signal)]), { ...opts, ...(stdin !== undefined ? { stdin } : {}) }); return r.missing || r.cut ? null : r; }, base: (f) => { try { return safeGit(ctx.repoDir, ["show", `${ctx.baseSha}:${relative(ctx.repoDir, join(cwd, f))}`], { stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } } });
/** tsc's unused-declaration diagnostics (noUnusedLocals/Parameters): decided by one file's own text, so an edit elsewhere never causes one. */
const TSC_LOCAL = new Set(["TS6133", "TS6138", "TS6192", "TS6196", "TS6198", "TS6199", "TS6205"]);
const TSC_DIAG = /^(\S.*?)(?:\(\d+,\d+\)|:\d+:\d+)\s*(?::|-)\s*error (TS\d+)/gm;
/** A failed `tsc --noEmit` whose every diagnostic is an unused-declaration error in a file the change neither touched nor the task named, with no tsconfig edited, AND the same file and code
 *  appear in `baseOut` (the same tsc run on the base snapshot): pre-existing, never fix-round input (zod runs spent 180 s rounds editing untouched test and bench files to quiet them). A change that
 *  pulls an untouched file into the program (an import, an include glob, an alias) is blamed because base was green for it. Fail-closed: no base output, an unparsed error line, a type error of any other
 *  code, a tail cut at its cap, a diagnostic in a touched or named file, or any tsconfig in the change keeps the check blocking. `pkgRel` is the package dir relative to the repo root (tsc paths are cwd-relative). */
export function tscUntouchedLocal(out: string, pkgRel: string, keep: ReadonlySet<string>, changed: readonly string[], baseOut: string | null): boolean {
  const keys = tscLocalKeys(out, pkgRel, keep, changed);
  if (keys === null || baseOut === null) return false;
  const base = new Set([...baseOut.matchAll(TSC_DIAG)].map((m) => `${m[1]!.trim()}|${m[2]}`));
  return keys.every((k) => base.has(k));
}
/** The "file|code" of every diagnostic when the whole output has the excusable shape (see tscUntouchedLocal, minus the base comparison); null otherwise. */
function tscLocalKeys(out: string, pkgRel: string, keep: ReadonlySet<string>, changed: readonly string[]): string[] | null {
  if (out.length >= 60000 || changed.some((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f))) return null;
  const found = [...out.matchAll(TSC_DIAG)];
  if (found.length === 0 || found.length !== (out.match(/error TS\d+/g) ?? []).length) return null;
  return found.every((m) => TSC_LOCAL.has(m[2]!) && !keep.has(join(pkgRel === "." ? "" : pkgRel, m[1]!.trim()))) ? found.map((m) => `${m[1]!.trim()}|${m[2]}`) : null;
}
/** LINT-UNTOUCHED (acc-174, LOKI_E10_LINT_UNTOUCHED default off, =1 opts in): a failed project-wide `tsc --noEmit` whose every diagnostic sits in a file the change
 *  neither touched nor the task named, with no compiler or linter config changed, no changed symbol named anywhere in the output, AND every diagnostic line present
 *  verbatim in `baseOut` (the same tsc run on the base snapshot, tscOnBase) is not the change's own error: it is disclosed, never a cap (dev2: router's lint:tsc red in
 *  scripts/benchmarks/bundle-size/analyze.mjs, immutable's TS8010 in type-definitions/flow-tests). The base comparison is what makes it sound: a changed signature can
 *  break an untouched importer with a message that names only types (TS2345), and that line is not on base. Fail-closed: no base output, an unparsed error line or a
 *  tail cut at its cap keeps the check blocking. Only tsc lints the whole project; eslint, ruff and shellcheck run on the changed files and keep capping. */
export const LINT_UNTOUCHED_NOTE = "lint red only in files the change did not touch (disclosed, not blocking)";
export const lintUntouchedOn = (env: NodeJS.ProcessEnv = process.env): boolean => { const v = (env["LOKI_E10_LINT_UNTOUCHED"] ?? "").trim(); return /^(1|on|true|yes)$/i.test(v) || (v === "" && baseOnDemandOn(env)); }; // RW-01: on by default (opencode#63152: lint:tsc:packages/cli red in files the change did not touch decided FAILED); =0 opts out, as does LOKI_E10_BASE_ON_DEMAND=0 unless =1 is set here
/** STALE-GENERATED: a failed `tsc --noEmit` is not the change's error when every diagnostic is TS2307 (cannot find module) in a file git ignores, and the module it
 *  names exists nowhere in the tree: a build output such as .next/types that still points at a page from another branch or an earlier build. Disclosed, never
 *  blocking. Any other diagnostic in an ignored file (Next reports real page-props errors there), a module that does exist, an unparsed error line, a cut tail
 *  or one diagnostic in a tracked or new source file keeps the check blocking. */
function tscOnlyIgnored(repoDir: string, cwd: string, out: string): boolean {
  if (!out || out.length >= 60000) return false;
  const lines = out.split("\n").filter((l) => /error TS\d+/.test(l)); if (lines.length === 0) return false;
  try {
    return lines.every((l) => {
      const m = /^(\S.*?)(?:\(\d+,\d+\)|:\d+:\d+)\s*(?::|-)\s*error TS2307: Cannot find module '([^']+)'/.exec(l.trim()); if (!m) return false;
      const file = join(cwd, m[1]!.trim()), mod = m[2]!; if (!mod.startsWith(".")) return false;
      try { safeGit(repoDir, ["check-ignore", "-q", "--", file]); } catch { return false; }
      const target = join(dirname(file), mod).replace(/\.(js|mjs|cjs|jsx)$/, "");
      return ![target, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"].map((e) => target + e), ...["index.ts", "index.tsx", "index.js"].map((e) => join(target, e))].some((t) => { try { return statSync(t).isFile(); } catch { return false; } });
    });
  } catch { return false; }
}
const tscLines = (out: string): string[] => out.split("\n").map((l) => l.trim()).filter((l) => /error TS\d+/.test(l));
/** The half of tscUntouchedOnly that needs no base run: the whole output parses, no config changed, no diagnostic in a touched file, no changed symbol named. */
function tscUntouchedShape(out: string, pkgRel: string, touched: ReadonlySet<string>, symbols: readonly string[]): boolean {
  if (out.length >= 60000 || [...touched].some((f) => LINT_CONFIG.test(f))) return false;
  const found = [...out.matchAll(TSC_DIAG)];
  if (found.length === 0 || found.length !== (out.match(/error TS\d+/g) ?? []).length) return false;
  if (found.some((m) => touched.has(join(pkgRel === "." ? "" : pkgRel, m[1]!.trim())))) return false;
  return !symbols.some((sym) => sym.length > 2 && new RegExp(`\\b${escapeRegex(sym)}\\b`).test(out));
}
export function tscUntouchedOnly(out: string, pkgRel: string, touched: ReadonlySet<string>, symbols: readonly string[], baseOut: string | null): boolean {
  if (baseOut === null || !tscUntouchedShape(out, pkgRel, touched, symbols)) return false;
  const base = new Set(tscLines(baseOut));
  return tscLines(out).every((l) => base.has(l));
}
/** The same `tsc --noEmit` on a pristine detached base worktree with the head's dependency dirs linked (the package's and the repo root's); null when base cannot be checked (fail closed). */
async function tscOnBase(ctx: RunContext, groupCwd: string, signal: AbortSignal, opts: RunOpts, shared?: { dir: string; link: (cwd: string) => boolean } | null): Promise<string | null> {
  if (signal.aborted) return null;
  if (shared !== undefined) { // RW-01: verify's one base worktree, whose link also serves an installed workspace (baseDepsView); null: no base tree, fail closed
    if (!shared) return null;
    try {
      const cwd = join(shared.dir, relative(ctx.repoDir, groupCwd));
      if (!existsSync(join(cwd, "tsconfig.json")) || !shared.link(cwd)) return null;
      if (cwd !== shared.dir) shared.link(shared.dir);
      const r = await runOnce("npx", ["--no-install", "tsc", "--noEmit", "-p", "."], cwd, AbortSignal.any([signal, (Number.isFinite(opts.timeoutMs ?? checkTimeoutMs()) ? AbortSignal.timeout(opts.timeoutMs ?? checkTimeoutMs()) : new AbortController().signal)]), { ...opts });
      return r.missing || r.cut ? null : r.out;
    } catch { return null; }
  }
  const dir = mkdtempSync(join(tmpdir(), "e10-basetsc-")), git = (args: string[]): void => { safeGit(ctx.repoDir, args, { stdio: "ignore", repoDrivers: true }); };
  try {
    git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, ctx.baseSha]);
    const cwd = join(dir, relative(ctx.repoDir, groupCwd)), link = baseDepsLinker(dir, ctx.repoDir);
    if (!existsSync(join(cwd, "tsconfig.json")) || !link(cwd)) return null;
    if (cwd !== dir) link(dir);
    const r = await runOnce("npx", ["--no-install", "tsc", "--noEmit", "-p", "."], cwd, AbortSignal.any([signal, (Number.isFinite(opts.timeoutMs ?? checkTimeoutMs()) ? AbortSignal.timeout(opts.timeoutMs ?? checkTimeoutMs()) : new AbortController().signal)]), { ...opts });
    return r.missing || r.cut ? null : r.out;
  } catch { return null; } finally {
    try { git(["worktree", "remove", "--force", dir]); } catch { /* pruned below */ }
    rmSync(dir, { recursive: true, force: true });
    try { git(["worktree", "prune"]); } catch { /* best effort */ }
  }
}
/** LINT-MISSING-DISCLOSE (LOKI_E10_LINT_MISSING_DISCLOSE, default on, =0 opts out): the other ways to start a linter the first command could not start, in order:
 *  `uvx <tool>` (uv's tool runner, no global install) and the repo's own virtualenv `python -m <tool>`. [] when off or none applies. */
export const lintMissingDiscloseOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_LINT_MISSING_DISCLOSE"] ?? "").trim());
export function lintFallbacks(repoDir: string, tool: string, env: NodeJS.ProcessEnv = process.env): [string, string[]][] {
  return lintMissingDiscloseOn(env) ? toolFallbacks(repoDir, tool, env) : []; // util/check_result.ts: the one fallback list, shared with the commit-stage formatter
}
export async function runLintChecks(
  ctx: RunContext, changed: string[], signal: AbortSignal, checks: VerifyCheck[], opts: RunOpts & { api?: ProjectApi | null; keep?: ReadonlySet<string>; untouched?: string[]; base?: () => { dir: string; link: (cwd: string) => boolean } | null } = {},
): Promise<string[]> {
  const { api, keep, untouched, base, ...runOpts } = opts; opts = runOpts; const pre: string[] = []; // check names whose static diagnostics are all pre-existing
  const py = changed.filter((f) => f.endsWith(".py"));
  const [ruffCmd, interpreter, uvPre] = py.length ? resolveTool(ctx.repoDir, "ruff", "ruff") : ["ruff", "system", []] as ReturnType<typeof resolveTool>; // E-98a: same project-first resolution as pytest
  if (py.length && (interpreter !== "system" || Bun.which("ruff", { PATH: process.env["PATH"] ?? "" }) || projectDeclaresRuff(ctx.repoDir))) { // FC-LINT-TOOL-NEVER-USED-BY-PROJECT: a repo that neither declares ruff nor has one installed has no lint to run
    const first: VerifyCheck[] = []; let c = await runCheck(ctx, "lint:ruff", ruffCmd, [...uvPre, "check", "--output-format=concise", ...py], signal, first, { ...opts, interpreter, kind: "static" }), lintCmd = ruffCmd, lintPre: string[] = uvPre;
    for (const [cmd, pre0] of c.result === "not_run" && c.skip_code === "tool_not_on_path" ? lintFallbacks(ctx.repoDir, "ruff") : []) { // LINT-MISSING-DISCLOSE: the ways the repo's own tooling runs ruff without a global install
      const alt: VerifyCheck[] = [], a = await runCheck(ctx, "lint:ruff", cmd, [...pre0, "check", "--output-format=concise", ...py], signal, alt, { ...opts, kind: "static" });
      if (!(a.result === "not_run" && a.skip_code === "tool_not_on_path")) { c = a; first.splice(0, first.length, ...alt); lintCmd = cmd; lintPre = pre0; break; }
    }
    checks.push(...first);
    if (await excuseLint(ctx, signal, c, "ruff", lintCmd, [...lintPre, "check"], ctx.repoDir, py, opts)) pre.push(c.name);
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
    if (existsSync(join(g.cwd, "tsconfig.json"))) { const c = await runCheck(ctx, `lint:tsc${sfx}`, "npx", ["--no-install", "tsc", "--noEmit", "-p", "."], signal, checks, { ...co, kind: "static" }); if (c.result === "fail" && tscOnlyIgnored(ctx.repoDir, g.cwd, tscOut.get(c) ?? "")) pre.push(c.name); else if (c.result === "fail" && keep && tscLocalKeys(tscOut.get(c) ?? "", g.root, keep, [...keep]) && tscUntouchedLocal(tscOut.get(c) ?? "", g.root, keep, [...keep], await tscOnBase(ctx, g.cwd, signal, co, base ? base() : undefined))) pre.push(c.name); else if (c.result === "fail" && keep && untouched && lintUntouchedOn()) { const syms = diffSymbols(ctx, [...keep]), o = tscOut.get(c) ?? ""; if (tscUntouchedShape(o, g.root, keep, syms) && tscUntouchedOnly(o, g.root, keep, syms, await tscOnBase(ctx, g.cwd, signal, co, base ? base() : undefined))) untouched.push(c.name); } }
    if (ESLINT_CONFIGS.some((f) => existsSync(join(g.cwd, f)))) { const c = await runCheck(ctx, `lint:eslint${sfx}`, "npx", ["--no-install", "eslint", ...g.rel], signal, checks, { ...co, kind: "static" }); if (await excuseLint(ctx, signal, c, "eslint", "npx", ["--no-install", "eslint"], g.cwd, g.rel, co)) pre.push(c.name); }
  }
  return pre;
}
/** RW-01: one detached worktree of the base commit per verify, created on first use (the on-demand suite base runs and the no-id comparison share it)
 *  and always removed. `link` links the head's dependency dirs into a directory of it under baseDepsLinker's guards, or builds baseDepsView's node_modules when the only objection is a workspace's own member links (false: nothing linked, fail closed);
 *  no link at all when the change edits a dependency manifest. */
interface BaseTree { get(changed: readonly string[], gate: ZeroGate): string | null; link(cwd: string): boolean; members(): { members: number; refused: string[] }; dispose(): void }
function baseTree(ctx: RunContext): BaseTree {
  let dir: string | null | undefined, linker: ((cwd: string) => boolean) | null = null, view: ((cwd: string) => boolean) | null = null, scopeBlocked: (cwd: string) => boolean = () => true;
  let mem: { members: number; refused: string[] } | null = null; // BASE-TREE-MEMBERS: settled once per base tree
  const git = (args: string[]): void => { safeGit(ctx.repoDir, args, { stdio: "ignore", repoDrivers: true }); };
  return {
    get(changed, gate) {
      if (dir !== undefined) return dir;
      const d = mkdtempSync(join(tmpdir(), "e10-base-"));
      // The gate here asks about the dependency dirs alone (as depsAsIntake does), not every ignored file: this worktree holds the base commit's tracked files and
      // nothing ignored, whatever happened to an ignored file in the checkout since intake, so only a changed node_modules or .venv can make its run not a base run.
      gate = gate.ignored ? { ...gate, ignored: [] } : gate;
      try { git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", d, ctx.baseSha]); dir = d; linker = baseDepsLinker(d, ctx.repoDir, gate); view = baseDepsView(d, ctx.repoDir, gate); scopeBlocked = (cwd: string): boolean => manifestBlocksBaseLink(changed, relative(d, cwd) || ".", (f) => MANIFESTS.test(f)); } catch { rmSync(d, { recursive: true, force: true }); dir = null; }
      return dir;
    },
    link: (cwd) => (linker && view && !scopeBlocked(cwd) ? linker(cwd) || view(cwd) : false), // a workspace whose packages link to each other gets a node_modules view whose member links point at base (baseDepsView)
    members() { // BASE-TREE-MEMBERS (base_guard.ts linkWorkspaceMembers): every workspace member with dependencies in the checkout gets them in the base tree
      if (mem) return mem;
      if (!dir || !linker || !view) return { members: 0, refused: [] };
      let manifests: string[] = []; try { manifests = safeGit(ctx.repoDir, ["ls-files", "-z", "--", "package.json", "*/package.json"]).split("\0").filter(Boolean); } catch { /* no list: no member is linked */ }
      const l = linker, v = view;
      mem = linkWorkspaceMembers(dir, ctx.repoDir, (cwd) => !scopeBlocked(cwd) && (l(cwd) || v(cwd)), manifests); // BASE-LINK-SCOPE applies to members too
      return mem;
    },
    dispose() {
      if (!dir) return;
      try { git(["worktree", "remove", "--force", dir]); } catch { /* pruned below */ }
      rmSync(dir, { recursive: true, force: true });
      try { git(["worktree", "prune"]); } catch { /* best effort */ }
      dir = null;
    },
  };
}
/** SUITE-CARRY: a quick re-verify (after a fix round) runs no full suite, so a suite the earlier complete verify named "not run: full suite: <name> (...)" is still
 *  unproven. Without the carry the receipt kept only the bare deferred "full suite" and lost which suite never ran (run-safety scope limit, failing under load when
 *  the verify limit landed before any package suite started and a pre-red test then drew a fix round). */
export const unrunSuitesCarried = (prior: unknown, ran: readonly { name: string; result?: unknown }[] = []): string[] => {
  // A suite this verify ran to a pass or fail (a quick verify on the settle path does run the full suite) is no longer "not run": its carried line is dropped (Fable's review of 53dabb6d8).
  const done = new Set(ran.filter((c) => c.result === "pass" || c.result === "fail").map((c) => c.name));
  return Array.isArray(prior) ? prior.map(String).filter((n) => n.startsWith("not run: full suite: ") && !done.has(n.slice("not run: ".length).replace(/ \(.*$/, ""))) : [];
};
export const BASE_NOT_MEASURED = "not measured on base (its dependency directories link into this checkout, a dependency manifest changed, or the environment changed since intake), so its failures cannot be compared";
/** VERIFY-PLAN V3: the observed Wall's tests, run once at the end of a complete verify: each sealed copy is put at its path, run alone with the
 *  runner it was sealed with, classified like any test check, and removed. Never a VerifyCheck: nothing here reaches the label, fix rounds or cascade. */
/** VERIFY-PLAN V4: what one boot comparison means. boot/http are the appProbe check results ("pass" | "fail" | "not_run" | "n/a"). */
export interface BootSummary { boot: string; http: string; reason: string | null }
export interface BootOutcome { hold: boolean; check: { name: "app boot"; cmd: string; result: "fail"; duration_s: number; reason: string } | null; observe: { rule: "LOKI_E10_E2E_BOOT"; would_label: "FAILED"; detail: string } | null; disclosure: string | null }
export function bootOutcome(head: BootSummary | null, base: BootSummary | null, mode: "off" | "observe" | "enforce", duration_s = 0): BootOutcome {
  if (mode === "off") return { hold: false, check: null, observe: null, disclosure: null };
  const hold = head?.boot === "fail" && base?.boot === "pass";
  const check = hold && mode === "enforce" ? { name: "app boot" as const, cmd: "autonomy/app-runner.sh", result: "fail" as const, duration_s, reason: "the app boots on the base commit and does not boot with the change" } : null;
  const observe = hold && mode === "observe" ? { rule: "LOKI_E10_E2E_BOOT" as const, would_label: "FAILED" as const, detail: "the app boots on the base commit and not with the change" } : null;
  const disclosure = !head || head.boot === "n/a" || head.boot === "not_run" ? `not run end to end: ${head?.reason ?? "no app was detected"} (disclosed, does not cap)`
    : head.boot === "pass" && base?.boot === "pass" && (head.http === "pass" || head.http === "n/a") && (base.http === "pass" || base.http === "n/a") ? "ran end to end: the app booted and answered (head and base) (disclosed, does not cap)"
    : `ran end to end: head boot ${head.boot}, base boot ${base?.boot ?? "not run"} (disclosed, does not cap)`;
  return { hold, check, observe, disclosure };
}
const bootSummary = (r: { checks: { name: string; result: string; reason?: string }[] }): BootSummary => { const b = r.checks.find((c) => c.name === "app boot"), h = r.checks.find((c) => c.name === "http probe"); return { boot: b?.result ?? "not_run", http: h?.result ?? "not_run", reason: b && b.result !== "pass" ? (b.reason ?? null) : null }; };
/** VERIFY-PLAN V8: the flaky checks a base run may quarantine: a test check (not the Wall, holdout or a task-named test) whose file the change did not edit. */
export const flakyCandidates = <C extends { name: string; result: string }>(checks: readonly C[], o: { wall: ReadonlySet<string>; target: ReadonlySet<string>; changed: readonly string[]; testNames: ReadonlySet<string>; hold: (c: C) => boolean }): C[] =>
  checks.filter((c) => c.result === "flaky" && !o.wall.has(c.name) && !o.hold(c) && !o.target.has(c.name) && !o.changed.includes(c.name.slice(c.name.indexOf(":") + 1)) && o.testNames.has(c.name));
/** VERIFY-PLAN V8: a flaky candidate's command run up to three times on the base tree, classified like any test check. Stops before any run once the
 *  deadline is inside SUITE_MARGIN_MS (the NO-ID block's guard); null when no run was made. */
export async function flakyOnBase(run: () => Promise<{ ok: boolean; cut: boolean; missing: boolean; out: string }>, deadline: number | undefined, now: () => number = Date.now): Promise<{ pass: number; fail: number; not_run: number } | null> {
  const r = { pass: 0, fail: 0, not_run: 0 }; let ran = 0;
  for (let i = 0; i < 3; i++) {
    if (deadline !== undefined && now() > deadline - SUITE_MARGIN_MS) break;
    const a = await run(); ran++;
    const k = classifyCheck({ kind: "test", ok: a.ok, cut: a.cut, missing: a.missing, out: a.out });
    if (k.result === "pass") r.pass++; else if (k.result === "fail") r.fail++; else r.not_run++;
  }
  return ran ? r : null;
}
export async function runObservedWall(ctx: RunContext, signal: AbortSignal, api: ProjectApi | null): Promise<{ files: { path: string; result: "pass" | "fail" | "not_run"; n?: number; reason?: string }[] } | undefined> {
  const obs = (ctx.outputs().wall as { observe_files?: unknown } | undefined)?.observe_files, list = Array.isArray(obs) ? (obs as { path: string; runner?: string }[]) : [];
  if (!list.length) return undefined;
  const runners = (await ctx.tests.detect(ctx.repoDir)).runners, out: { path: string; result: "pass" | "fail" | "not_run"; n?: number; reason?: string }[] = [];
  for (const f of list) {
    if (signal.aborted) break;
    const rel = isAbsolute(f.path) ? relative(ctx.repoDir, f.path) : f.path, abs = join(ctx.repoDir, rel), sealed = sealedWallCopy(ctx.runDir, f.path);
    if (!existsSync(sealed)) { out.push({ path: rel, result: "not_run", reason: "sealed copy missing" }); continue; }
    const runner = (f.runner as RunnerName | undefined) ?? guessRunner(basename(rel), runners, rel);
    if (!runner) { out.push({ path: rel, result: "not_run", reason: NO_RUNNER_REASON }); continue; }
    try {
      mkdirSync(dirname(abs), { recursive: true }); copyFileSync(sealed, abs);
      const tc = commandFor({ runner, path: rel }, ctx.repoDir, api), a = await runOnce(tc.cmd, tc.args, tc.cwd, signal, { group: true });
      const k = classifyCheck({ kind: "test", ok: a.ok, cut: a.cut, missing: a.missing, out: a.out, ...goRunner(tc.cmd, tc.args) });
      const result = k.result === "pass" || k.result === "fail" ? k.result : "not_run";
      out.push({ path: rel, result, ...(typeof k.n === "number" ? { n: k.n } : {}), ...(k.reason ? { reason: k.reason } : {}) });
    } finally { rmSync(abs, { force: true }); }
  }
  return { files: out };
}
export const verifyStage: Stage = {
  name: "verify",
  targetS: STAGE_BUDGETS.verify.targetS,
  limitS: STAGE_BUDGETS.verify.limitS,
  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> { const bt = baseTree(ctx); try { return await runVerify(ctx, signal, bt); } finally { bt.dispose(); } },
};
async function runVerify(ctx: RunContext, signal: AbortSignal, bt: BaseTree): Promise<StageResult> {
  // EXOGENOUS-RED: the installed packages gone since intake, read here, before verify runs its first command, so it shows what the session removed and
  // never what a verify command (an install, a suite that syncs to its lock) removed. Keyed by package dir ("." for the root).
  const goneAtStart = new Map<string, string>();
  if (exogenousRedOn()) { try { const deps0 = zeroGate((ctx.outputs().intake as { zero_baseline?: unknown } | undefined)?.zero_baseline).deps; for (const d of new Set(Object.keys(deps0 ?? {}).map((k) => dirname(k)))) { const g = depsGoneSince(ctx.repoDir, d === "." ? ctx.repoDir : join(ctx.repoDir, d), deps0); if (g) goneAtStart.set(d, g); } } catch { /* no listing: nothing is blamed on a gone package */ } }
  {
    let changed: string[]; const ownWall = ((ctx.outputs().wall?.files as { path: string }[] | undefined) ?? []).map((f) => f.path), live = <T extends string | { path: string }>(l: T[]): T[] => withoutStaleWall(l, ownWall, ctx.repoDir); // FC-WALL-LOCATION-BLIND: a loki_wall_* file this run's Wall did not install is invisible to changed, risk and the test map
    try {
      changed = live(changedFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created)));
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
    let risk = (() => { try { const r = classifyRisk(live(diffFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created)))); recordRisk(ctx.repoDir, r); return r; } catch { return null; } })(); // RISKTIER: artifact-based tier, recorded; deferred checks are never a pass
    const checks: VerifyCheck[] = [];
    const api = loadProjectApi(ctx.repoDir); // FC-01: null (repo-root behavior) unless the model has a package below the root
    const map0 = await ctx.tests.detect(ctx.repoDir), map = { ...map0, tests: live(map0.tests) };
    const impacted = ctx.tests.impacted(map, changed);
    const changedTestFiles = map.tests.filter((t) => changed.includes(t.path));
    const wall = (ctx.outputs().wall as WallOutput | undefined) ?? {};
    // E-56: wall.ts seals files under an absolute targetDir; normalize to repo-relative so an absolute Wall path still matches and runs in fast verify.
    const wallPaths = new Set((wall.files ?? []).map((f) => (isAbsolute(f.path) ? relative(ctx.repoDir, f.path) : f.path)));
    // A-114: the relevant tests of the task-named files are always selected, whatever the diff touches.
    const intake = ctx.outputs().intake as { task?: string; repomap_ref?: string; deps_not_proven?: string[] } | undefined, repoMap = loadRepoMap(intake?.repomap_ref), named = namedFiles(intake?.task ?? "", repoMap), relevant = ctx.tests.impacted(map, named);
    const recorded = new Map((wall.files ?? []).flatMap((f) => (f.runner ? [[isAbsolute(f.path) ? relative(ctx.repoDir, f.path) : f.path, f.runner] as const] : []))); // D122: the runner the Wall recorded for each sealed file; verify never re-detects it after implement
    // FC-WALL-FILE-NOT-DISCOVERED-BY-RUNNER: run every sealed Wall path, never only those the runner's discovery lists (loki_wall_x.py is not a pytest-discovered name). No project runner: a Wall-sealed file runs with Loki's bun (harness), as before.
    const wallTests = [...wallPaths].flatMap((p): TestRef[] => { const rec = recorded.get(p), found = map.tests.find((t) => t.path === p && (!rec || t.runner === rec)); if (found) return [found]; const runner = rec ?? guessRunner(basename(p), map.runners, p); return runner && (runner !== "bun" || map.runners.includes("bun") || /[._](?:test|spec)\.[cm]?[jt]sx?$/.test(p)) ? [{ runner, path: p }] : []; }); // harness: `bun test <name>` skips any name bun does not discover as a test (*.test, *_test, *.spec, *_spec)
    const dep = dependentTests(ctx.repoDir, map, changed, [...impacted, ...changedTestFiles, ...wallTests, ...relevant]), depNames = new Set(dep.tests.map(testCheckName)); // RX-3
    const tests0 = failedFirst(dedupeTests([...wallTests, ...relevant, ...changedTestFiles, ...changedSymbolsFirst(ctx, impacted, changed), ...dep.tests]),(ctx.outputs().verify as { checks?: Array<{ name?: unknown; result?: unknown }> } | undefined)?.checks); // TEN-SPEED-07; the Wall and task-named tests that prove the task run first, so a stage stopped at its limit has already run them
    const tests = tests0.length === 0 ? [...mochaTargets(ctx.repoDir, changed), ...avaTargets(ctx.repoDir, changed)] : tests0; // R5 LOKI_E10_MOCHA_TARGETED: nothing selected in a repo that declares mocha: each changed file's own mocha test file (testmap.ts mochaTargets)
    const own = ownByPathOn() ? ownTests(relevant, named, changed) : relevant; // OWN-BY-PATH: the relevant tests that are the task's own; the rest stay selected (A-114) but are excusable like any untouched test
    const hashes = fileHashes(ctx.repoDir, changed), qs = quickScope(ctx.outputs(), hashes), keep = new Set([...(qs?.blocking ?? []), ...[...wallTests, ...own].map(testCheckName)]);
    const sinceTests = qs ? [...ctx.tests.impacted(map, qs.since), ...map.tests.filter((t) => qs.since.includes(t.path))] : [], split = qs ? quickSplit(tests, keep, sinceTests) : { first: tests, rest: [] };
    // The evidence so far, published after every check: a verify stopped at its limit or the cap keeps the checks that ran (machine.ts), never "no tests executed". wall_passed follows the final rule below: false on any failure, true only when every Wall and holdout check ran and passed.
    const done: VerifyCheck[] = [], wallNames0 = new Set(wallTests.map(testCheckName)), targets0 = new Set([...wallTests, ...own].map(testCheckName)), wallDropped0 = [...wallPaths].filter((p) => !wallTests.some((t) => t.path === p));
    let holdN: number | null = wall.holdout_dir ? null : 0; // held-out Wall checks to run; null until they are staged
    let partialPre: { names: string[]; ids: string[] } = { names: [], ids: [] }; // RW-01: the base attribution so far, so a verify stopped at its limit keeps it (a check excused before the stop is not read as a failure)
    const deadline = (ctx as { verifyDeadlineMs?: number }).verifyDeadlineMs; // RW-01: when the machine stops this stage (limit or cap); absent for a caller outside the machine
    const publish = (): void => {
      if (!ctx.partial) return;
      const ran = checks.length ? checks : done, w = ran.filter((c) => wallNames0.has(c.name) || isHold(c)), allRan = holdN !== null && ran.filter(isHold).length >= holdN && wallTests.every((t) => ran.some((c) => c.name === testCheckName(t)));
      const wp = w.some((c) => c.result === "fail") ? false : w.length > 0 && allRan && wallDropped0.length === 0 && w.every((c) => c.result === "pass") ? true : undefined;
      ctx.partial("verify", { checks: ran.map((c) => (isHold(c) ? pubHold(c) : c)), flaky: ran.filter((c) => c.result === "flaky").map((c) => (isHold(c) ? "holdout" : c.name)), ...(wp === undefined ? {} : { wall_passed: wp }), changed_files: changed, ...(partialPre.names.length ? { pre_red_checks: partialPre.names, pre_red: partialPre.ids } : {}), not_proven: wallDropped0.map((p) => `Wall test not executed: ${p}: ${NO_RUNNER_REASON}`), target_checks: ran.filter((c) => c.result === "pass" && (targets0.has(c.name) || isHold(c))).map((c) => (isHold(c) ? "holdout" : c.name)), risk });
    };
    const scopedOut = scopedOutOf(map); // FC-22: audit trail for package-scoped selection (LOKI_E10_SCOPE=1)
    if (scopedOut.length) ctx.emit("test.scoped_out", "verify", { tests: scopedOut });
    // TEN-SPEED-18: LOKI_E10_VERIFY_JOBS bounds concurrent test processes; mapPool keeps the selected (failed-first) order whatever order they finish in
    // L027: within each list, Wall tests and non-vitest tests run alone and first; then the task-named vitest files batched per package, then the other
    // vitest files batched per package (a stage stopped at its limit has run the Wall and task-named tests); a file a batch does not vouch for runs alone last.
    const batchable = (t: TestRef): boolean => verifyBatchOn() && t.runner === "vitest" && !wallNames0.has(testCheckName(t));
    // TIMEOUT-CARRY (dev4 aiohttp, LOKI_E10_TIMEOUT_CARRY default on, =0 reruns): an untouched, non-Wall, non-task test file that timed out in an earlier verify of
    // this run is not run again; its not_run result is carried with the earlier reason (aiohttp's tests/test_proxy_functional.py cost about 160 s in every verify).
    const runTests = async (all: TestRef[]): Promise<void> => {
      const byName = new Map<string, VerifyCheck[]>();
      for (const c of carriedTimeouts((ctx.outputs().verify?.checks ?? []) as VerifyCheck[], all, changed, new Set([...wallNames0, ...targets0]))) { byName.set(c.name, [c]); done.push(c); ctx.emit("test.result", "verify", { ...c }); }
      const list = all.filter((t) => !byName.has(testCheckName(t)));
      const alone = async (l: TestRef[]): Promise<void> => { (await mapPool(l, verifyJobs(), async (t) => { const tc = commandFor(t, ctx.repoDir, api), slot: VerifyCheck[] = []; await runCheck(ctx, testCheckName(t), tc.cmd, tc.args, signal, slot, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), protect: [...wallTests, ...relevant].includes(t), changedTest: changed.includes(t.path), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) }); done.push(...slot); publish(); return slot; }, () => signal.aborted)).forEach((sl, i) => { if (sl) byName.set(testCheckName(l[i]!), sl); }); };
      const goPart = (t: TestRef): boolean => goBatchable(t, targets0, changed); // Wall, task-named and edited go test files keep their own per-file run (the fail-then-pass proof); only untouched files batch
      await alone(list.filter((t) => !batchable(t) && !goPart(t)));
      const goB = await runGoBatches(ctx, list.filter(goPart), api, signal, (c) => { done.push(c); publish(); });
      for (const [n, c] of goB) byName.set(n, [c]);
      await alone(list.filter((t) => goPart(t) && !goB.has(testCheckName(t))));
      for (const part of [list.filter((t) => batchable(t) && targets0.has(testCheckName(t))), list.filter((t) => batchable(t) && !targets0.has(testCheckName(t)))]) {
        for (const [n, c] of await runVitestBatches(ctx, part, api, signal, (c) => { done.push(c); publish(); })) byName.set(n, [c]);
      }
      await alone(list.filter((t) => batchable(t) && !byName.has(testCheckName(t))));
      checks.push(...all.flatMap((t) => byName.get(testCheckName(t)) ?? [])); // the selected order, whichever way each check ran
    };
    await runTests(split.first);
    const zgEnv = zeroGate((ctx.outputs().intake as { zero_baseline?: unknown } | undefined)?.zero_baseline), envAsIntake = (rel: string): boolean => { // C and D read the intake profile, which stands for base only while the environment is as intake left it (a deleted or added package changes what runs): fail closed otherwise
      if (zgEnv.sinceMs === undefined) return false; const root = api?.packageRootOf(rel) ?? ".";
      return [...new Set([root, "."])].every((d) => !envChangedSince(ctx.repoDir, d === "." ? ctx.repoDir : join(ctx.repoDir, d), zgEnv.sinceMs!, zgEnv.ignored ?? null, zgEnv.deps));
    };
    // The same question for the dependency dirs alone (node_modules, .venv and their package listing; no other ignored file), once per package root: the
    // gate for reading a suite baseline by id when the base rerun gave nothing to compare. A deleted or added package can break a test that has no parsed id.
    const depsSeen = new Map<string, boolean>(), depsAsIntake = (rel: string): boolean => {
      if (zgEnv.sinceMs === undefined) return false;
      return [...new Set([api?.packageRootOf(rel) ?? ".", "."])].every((d) => { if (!depsSeen.has(d)) depsSeen.set(d, !envChangedSince(ctx.repoDir, d === "." ? ctx.repoDir : join(ctx.repoDir, d), zgEnv.sinceMs!, [], zgEnv.deps)); return depsSeen.get(d)!; });
    };
    const zg0 = zeroGate((ctx.outputs().intake as { zero_baseline?: unknown } | undefined)?.zero_baseline);
    // RW-01 BASE-ON-DEMAND: the base record of one full-suite command, measured now on the base worktree (intake no longer measures a multi-package repository)
    const suiteSpecs: SuiteSpec[] = (() => { try { return baseOnDemandOn() ? fullSuiteSpecs(ctx.repoDir, map.runners) : []; } catch { return []; } })(), baseUnmeasured = new Set<string>();
    const headRerun: { check: string; passed_on_rerun: string[]; count: number }[] = [];
    let baseMemberNote: string | null = null; // BASE-TREE-MEMBERS: disclosed on the receipt's baseline line
    const ensureBase = async (spec: { name: string; cmd: string; cwd: string; run: string }): Promise<void> => {
      if (!baseOnDemandOn() || signal.aborted) return;
      const tmo = Math.floor(suiteTimeoutFor(deadline, Date.now()) / 1000); if (tmo < 1) return;
      const dir = bt.get(changed, zg0); if (!dir) return;
      const cwd = join(dir, spec.cwd), linked = bt.link(cwd) && (cwd === dir || bt.link(dir));
      if (linked) { const m = bt.members(); if (m.refused.length) baseMemberNote = `base tree: ${m.refused.length} of ${m.members} workspace member(s) could not be given their dependencies, so a base run that imports them is not the checkout's run: ${m.refused.slice(0, 6).join(", ")}`; }
      if (!linked && [spec.cwd, "."].some((d) => ["node_modules", ".venv"].some((x) => existsSync(join(ctx.repoDir, d, x))))) { baseUnmeasured.add(`${spec.name} (\`${spec.cmd}\`) ${BASE_NOT_MEASURED}`); return; } // a base run without the dependencies it needs measures nothing, and would leave a record a later run reads
      await baselineSuiteOnDemand(ctx.repoDir, ctx.baseSha, spec, dir, asyncShellRunner(signal), tmo, () => signal.aborted);
    };
    for (const c of checks) { // RW-01: touchedRedOnBase (below) reads the owning package's suite record for an edited test file that is red: measured now
      const rel = c.name.slice(c.name.indexOf(":") + 1); if (c.result !== "fail" || !changed.includes(rel) || wallNames0.has(c.name) || isHold(c)) continue;
      const tcw = api?.packageOf(rel)?.commands.test?.cwd, spec = tcw === undefined ? undefined : suiteSpecs.find((sp) => sp.cwd === tcw);
      if (spec) await ensureBase(spec);
    }
    const touchedRed = new Set(checks.filter((c) => { const rel = c.name.slice(c.name.indexOf(":") + 1); return c.result === "fail" && changed.includes(rel) && !wallNames0.has(c.name) && !isHold(c) && envAsIntake(rel) && touchedRedOnBase(ctx.repoDir, ctx.baseSha, { ids: c.ids, errors: headErrors.get(c) }, editedTestTitles(ctx.repoDir, ctx.baseSha, rel)); }).map((c) => c.name)); // TOUCHED-BASE-RED: before decisive, so an edited base-red file does not force a quick verify
    const decisive = qs !== null && checks.some((c) => c.result === "fail" && !touchedRed.has(c.name) && (keep.has(c.name) || changed.includes(c.name.slice(c.name.indexOf(":") + 1)))); // a blocking, Wall, task-named or touched test is never excused as pre-existing red
    if (!decisive) await runTests(split.rest);
    const complete = !decisive; // L025: the full suite and the secret scan run in every complete verify, never in a quick one
    const pg = ((ctx.outputs().verify?.failures_grouped ?? []) as { signature: string }[]).map((g) => g.signature), fs = (x: string): boolean => x.startsWith("full suite") || x.startsWith("lint:"), failSigs = (l: { name: string; result: string; first_error?: string; ids?: string[] }[]): string[] => [...new Set(l.filter((c) => c.result === "fail" && !fs(c.name) && !isHoldoutCheck(c.name)).map((c) => failureSignature(c)))].sort(), same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
    const settle = decisive && pg.some((x) => x.startsWith("full suite")) && same(failSigs((ctx.outputs().verify?.checks ?? []) as { name: string; result: string; first_error?: string; ids?: string[] }[]), failSigs(checks.filter((c) => !isHold(c)))); /* compared on every failing check of the last verify, not only those it fed to the fix round: a base-red check excused then still fails now, and must not keep the full suite from rerunning (FireLater#21: a dynamic-import test the change broke was lost from the final verify) */ // L025: the same targeted failures as last time decide a stall only once the suite is known: rerun it (no model session) rather than carry it
    const hold = wall.holdout_dir ? stageHoldout(wall.holdout_dir, ctx.repoDir) : null; if (hold && !hold.missing.length) holdN = hold.tests.length; // P12-05: held-out Wall tests, copied in under neutral names for this run only, blocking (protect), named holdout:N internally and "holdout" in every record that leaves this stage
    try { for (const [i, h] of (hold?.tests ?? []).entries()) { if (signal.aborted) break; const t = h as TestRef, tc = commandFor(t, ctx.repoDir, api); await runCheck(ctx, `holdout:${i + 1}`, tc.cmd, tc.args, signal, checks, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), protect: true, opaque: true, ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) }); publish(); } } finally { hold?.cleanup(); }
    if (hold?.missing.length) { for (const m of hold.missing) recordHoldoutTriage(ctx.runDir, { check: "holdout:store", result: "not_run", reason: m }); const k: VerifyCheck = { name: "holdout:store", cmd: "holdout", result: "not_run", duration_s: 0, reason: "holdout store unavailable", owner: "harness" }; checks.push(k); ctx.emit("test.result", "verify", { ...pubHold(k) }); } // C-C4b-c: a store failure is a harness/infrastructure failure (not_run, no fix round), never a test failure the fixer sees; the missing-file text stays out of the log
    const targetNames = new Set([...[...wallTests, ...own].map(testCheckName), ...checks.filter(isHold).map((c) => c.name)]); // FC-21b: Wall and task-named tests, the proof a limit-stopped run needs
    const cfgChanged = [...new Set([...testConfigChanged(ctx.repoDir, ctx.baseSha, changed), ...hiddenConfigChanged(ctx.repoDir, ctx.outputs().intake?.hidden_cfg)])]; // FC-21b: also feeds uncovered_changed; SEAL-CONFTEST-01: ignored configs added or changed since intake count too
    // FireLater#21: a relevant test that is not the task's own (collateral: it only imports or mocks a named file) gets the base comparison any untouched test gets (known red, same error).
    const collateral = new Set((ownByPathOn() ? relevant.filter((t) => !own.includes(t)) : collateralTests(relevant, named)).map(testCheckName)), ownRel = new Set([...relevant.map(testCheckName)].filter((n) => !collateral.has(n)));
    const symbols = checks.some((c) => c.result === "fail") ? diffSymbols(ctx, changed) : []; // fl24: a failure naming one of these is never excused on differing text
    const preRed = await subtractBase(ctx, api, checks, tests, changed, new Set(wallTests.map(testCheckName)), new Set(relevant.map(testCheckName)), signal, cfgChanged.length === 0, zeroGate((ctx.outputs().intake as { zero_baseline?: unknown } | undefined)?.zero_baseline), depNames, ownRel, symbols);
    for (const e of preRed.envCrash) { const c = checks.find((x) => x.name === e.name && x.result === "fail"); if (c) { c.result = "not_run"; c.reason = `${BCE_REASON} (${e.sig})`; } } // BCE: environment, not the change
    const noIdNotes: string[] = [];
    const noIdCompared: string[] = []; // VERIFY-PLAN V2: a no-id failing test whose identical base command did not fail the same way (the change broke how it starts)
    const noIdGroups: { note: string; names: string[] }[] = []; // UNRUNNABLE-CHECK: which checks each NO-ID line stands for
    { // RW-01 NO-ID: a failing test check with no parsed id, compared with the identical command on base
      const cand = baseOnDemandOn() ? checks.filter((c) => c.result === "fail" && !c.ids?.length && noIdOut.has(c) && !isHold(c) && tests.some((t) => testCheckName(t) === c.name)) : [];
      const dir = cand.length && !signal.aborted ? bt.get(changed, zg0) : null, byLine = new Map<string, string[]>();
      const sub = (x: string): string => (dir ? x.split(ctx.repoDir).join(dir) : x);
      for (const c of cand) {
        if (!dir || signal.aborted || (deadline !== undefined && Date.now() > deadline - SUITE_MARGIN_MS)) break;
        const t = tests.find((x) => testCheckName(x) === c.name)!, tc = commandFor(t, ctx.repoDir, api), head = noIdOut.get(c)!;
        const cwd = sub(tc.cwd); bt.link(cwd); if (cwd !== dir) bt.link(dir); bt.members();
        // the identical command: the same tool, with the checkout's paths mapped to the base worktree. A tool that lives in the checkout and is absent on base (a .venv
        // the linker refused) is never run from the checkout: its environment can import the changed sources, so the check stays a failure.
        const cmd = sub(tc.cmd);
        if (isAbsolute(cmd) && !existsSync(cmd)) continue;
        const b = await runOnce(cmd, tc.args.map(sub), cwd, signal, {});
        if (!b.cut && !b.missing && !sameFailureLines(head, b, changed, symbols, ctx.repoDir, dir)) noIdCompared.push(c.name);
        if (b.cut || b.missing || !sameFailureLines(head, b, changed, symbols, ctx.repoDir, dir)) continue;
        const line = failureLines(rootless(stripAnsi(head), [ctx.repoDir])).find((l) => /error|No module named|not found|cannot|failed/i.test(l)) ?? failureLines(rootless(stripAnsi(head), [ctx.repoDir]))[0] ?? "";
        c.result = "not_run"; c.reason = `${NO_ID_BASE_REASON} (${line.slice(0, 160)})`; delete c.first_error; delete c.ids; delete c.anchor;
        byLine.set(line, [...(byLine.get(line) ?? []), c.name]);
      }
      for (const [line, names] of byLine) noIdNotes.push(`${NO_ID_BASE_REASON} (${line.slice(0, 160)}): ${names.length} check(s), first ${names[0]}`);
      for (const [line, names] of byLine) noIdGroups.push({ note: `${NO_ID_BASE_REASON} (${line.slice(0, 160)}): ${names.length} check(s), first ${names[0]}`, names });
    }
    // VERIFY-PLAN V8 (LOKI_E10_FLAKY_QUARANTINE, off by default): a flaky test the change did not touch is run three times on the base tree; one pass and one
    // fail there quarantines it in this repository's list. The list is per-repo state, never the label (seal reads it only under the knob).
    const flakyQ = ruleMode("LOKI_E10_FLAKY_QUARANTINE", "off"), quarantined: string[] = [], flakyBase: Record<string, { pass: number; fail: number; not_run: number }> = {};
    if (flakyQ !== "off" && !signal.aborted) {
      const qDir = repoCacheDir(repoKey(null, ctx.repoDir)), q = readQuarantine(qDir), added: Record<string, string> = {};
      const cands = flakyCandidates(checks, { wall: wallNames0, target: targetNames, changed, testNames: new Set(tests.map(testCheckName)), hold: isHold });
      let qdir: string | null | undefined;
      for (const c of cands) {
        if (q[c.name]) { quarantined.push(c.name); continue; } // already quarantined for this repo: never retried until green
        if (signal.aborted) break;
        if (qdir === undefined) qdir = bt.get(changed, zg0);
        if (!qdir) break;
        const d = qdir, sub = (x: string): string => x.split(ctx.repoDir).join(d), t = tests.find((x) => testCheckName(x) === c.name)!, tc = commandFor(t, ctx.repoDir, api);
        const cwd = sub(tc.cwd); bt.link(cwd); if (cwd !== d) bt.link(d);
        const cmd = sub(tc.cmd);
        if (isAbsolute(cmd) && !existsSync(cmd)) continue; // a tool that lives in the checkout and is absent on base: not quarantined
        const r = await flakyOnBase(() => runOnce(cmd, tc.args.map(sub), cwd, signal, {}), deadline);
        if (!r) break; // the deadline guard: no base run past the stage's margin
        flakyBase[c.name] = r;
        if (r.pass >= 1 && r.fail >= 1) { quarantined.push(c.name); added[c.name] = `${r.pass} pass, ${r.fail} fail of 3 on the base commit`; }
      }
      try { writeQuarantine(qDir, pruneQuarantine(q, checks.filter((c) => c.result === "pass").map((c) => c.name), checks.filter((c) => c.result === "flaky").map((c) => c.name), added, ctx.runId)); } catch { /* best effort: per-repo state */ }
    }
    for (const c of checks) { // RW-01: collateralOnBaseline and attribute (below) read the owning package's suite record for a check its base rerun showed failing the same way, or gave nothing to compare: measured now
      if (c.result !== "fail" || preRed.names.includes(c.name) || targetNames.has(c.name) || changed.includes(c.name.slice(c.name.indexOf(":") + 1)) || (preRed.compared.includes(c.name) && !preRed.sameError.includes(c.name))) continue;
      const t = tests.find((x) => testCheckName(x) === c.name), tcw = t ? api?.packageOf(t.path)?.commands.test?.cwd : undefined, spec = tcw === undefined ? undefined : suiteSpecs.find((sp) => sp.cwd === tcw);
      if (spec) await ensureBase(spec);
    }
    // A collateral check red on base failing the same way feeds the first fix round (it could be the bug the task describes); after a fix round left it failing
    // the same way it is pre-existing: not blocking, and named with COLLATERAL_RED, which caps VERIFIED.
    const fixRounds = Number((ctx.outputs().fix as { round?: unknown } | undefined)?.round ?? 0) || 0, collateralSame = preRed.sameError.filter((n) => collateral.has(n) && !preRed.names.includes(n));
    const collateralBase = checks.filter((c) => c.result === "fail" && collateral.has(c.name) && !preRed.names.includes(c.name) && envAsIntake(c.name.slice(c.name.indexOf(":") + 1)) && collateralOnBaseline(ctx.repoDir, ctx.baseSha, c.name.slice(c.name.indexOf(":") + 1), { ids: c.ids, errors: headErrors.get(c) }, changed, coveredStem(c.name.slice(c.name.indexOf(":") + 1)))).map((c) => c.name); // COLLATERAL-BASELINE: unedited, ids and errors equal the intake baseline (also beside a changed paired source): pre-existing now, no cap, no fix round
    if (collateralBase.length) { preRed.names.push(...collateralBase); preRed.ids.push(...checks.filter((c) => collateralBase.includes(c.name)).flatMap((c) => c.ids ?? [])); }
    const collateralRed = fixRounds >= 1 ? collateralSame.filter((n) => !collateralBase.includes(n)) : [];
    if (collateralRed.length) { preRed.names.push(...collateralRed); preRed.ids.push(...checks.filter((c) => collateralRed.includes(c.name)).flatMap((c) => c.ids ?? [])); }
    const touchedExcused = [...touchedRed].filter((n) => !preRed.names.includes(n) && checks.some((c) => c.name === n && c.result === "fail")); // TOUCHED-BASE-RED: excused like any base-red check, and disclosed on the baseline line (never a cap: every failing id and error equals base)
    if (touchedExcused.length) { preRed.names.push(...touchedExcused); preRed.ids.push(...checks.filter((c) => touchedExcused.includes(c.name)).flatMap((c) => c.ids ?? [])); }
    // REPOMEM: a failing, untouched, non-target test whose every id was already red in the intake baseline (same base commit) is pre-existing: never blocks. Anything else that fails is introduced and always blocks.
    // A package's own suite baseline is consulted for a check the base rerun showed failing the same way (sameErrors) and, for one whose base rerun gave nothing to compare
    // (it lost its dependencies: the environment gate; FireLater#24), only when its head error lines (`errors`) equal the ones the suite recorded on base, while the dependency
    // dirs themselves are as intake left them (depsAsIntake). Matching ids alone never excuse: a check the rerun did run, and showed passing, red by other ids or red with
    // another error (attribute's `rerun`), or one whose error differs from the suite's record, blocks; with a dependency dir changed the suite is not read at all.
    const suiteOf = (name: string): string | undefined => { const t = tests.find((x) => testCheckName(x) === name), pkg = t ? api?.packageOf(t.path) : null; return pkg?.commands.test ? `full suite: ${pkg.name}` : undefined; };
    const attr = attribute(ctx.repoDir, ctx.baseSha, checks.filter((c) => c.result === "fail" && !preRed.names.includes(c.name)).map((c) => ({ name: c.name, ids: c.ids, eligible: !targetNames.has(c.name) && !changed.includes(c.name.slice(c.name.indexOf(":") + 1)), ...(suiteOf(c.name) && (preRed.compared.includes(c.name) || depsAsIntake(c.name.slice(c.name.indexOf(":") + 1))) ? { suite: suiteOf(c.name)!, ...(headErrors.get(c) ? { errors: headErrors.get(c)! } : {}), ...(preRed.sameError.includes(c.name) ? { rerun: "same" as const } : preRed.compared.includes(c.name) ? { rerun: "differs" as const } : {}) } : {}) })));
    attr.introducedChecks = [...new Set(attr.introducedChecks.map((n) => (isHoldoutCheck(n) ? "holdout" : n)))]; preRed.names.push(...attr.preExistingChecks); preRed.ids.push(...attr.preExistingIds);
    partialPre = { names: [...preRed.names], ids: [...preRed.ids] }; publish();
    const lintUntouchedNames: string[] = []; // LINT-UNTOUCHED: filled by runLintChecks below
    if (!signal.aborted) {
      // Lint/typecheck of changed files only (ENGINE.md section 4's named tool per language).
      const lintUntouched = lintUntouchedNames;
      const lintPre = await runLintChecks(ctx, complete || [...(qs?.blocking ?? [])].some((n) => n.startsWith("lint:")) ? changed : changed.filter((f) => qs?.since.includes(f)), signal, checks, { api, wall: wallPaths, keep: new Set([...changed, ...named]), untouched: lintUntouched, ...(baseOnDemandOn() ? { base: () => { const d = bt.get(changed, zg0); return d ? { dir: d, link: bt.link } : null; } } : {}) }); // L025: a quick verify lints only what changed since, unless a lint check blocked last time
      preRed.names.push(...lintPre); // TEN-QUALITY-03: the same pre-existing path tests use
      if (lintPre.length) attr.line = [attr.line, `baseline: ${lintPre.join(", ")} static diagnostics already on base (not blocking)`].filter(Boolean).join("; ");
      preRed.names.push(...lintUntouched); // LINT-UNTOUCHED: disclosed on the baseline line, never a cap or fix-round input
      if (lintUntouched.length) attr.line = [attr.line, `${LINT_UNTOUCHED_NOTE}: ${lintUntouched.join(", ")}`].filter(Boolean).join("; ");
      // Self-hosting only: also run the repo's own fast-gate selector (section 4).
      if (isLokiModeRepo(ctx.repoDir)) {
        await runCheck(ctx, "select-tests", "bash", ["scripts/select-tests.sh", "--files", "-", "--run"], signal, checks, {
          kind: "static", // the selector reruns tests whose counts are not parsed here; per-file test checks carry the proof
          stdin: changed.join("\n") + "\n",
        });
      }
    }
    // VERIFY-PLAN V10 (LOKI_E10_CHECKLIST, observe by default): the base commit's .loki-checklist.json, items fired by this diff. forbid_added items read the
    // added lines only (features/checklist.ts addedLines: the diff, or every line of a file the base commit does not hold); cmd items run only with the knob set explicitly, and a failing one is run once in the base tree under the NO-ID block's guards.
    let cl: ChecklistResult[] = [], clProblem: string | undefined;
    if (checklistMode() !== "off" && complete && !signal.aborted) {
      const rc = readChecklist(ctx.repoDir, ctx.baseSha); clProblem = rc.problem;
      const added = new Map<string, { lines: string[]; nos: number[] }>(), addedOf = (f: string): { lines: string[]; nos: number[] } => {
        let a = added.get(f);
        if (!a) { a = addedLines(ctx.repoDir, ctx.baseSha, f); added.set(f, a); }
        return a;
      };
      const fired = firedItems(rc.items, changed, (f) => addedOf(f).lines);
      if (fired.length) cl = await runChecklist(fired, (f) => addedOf(f).lines, { cmdOn: checklistCmdOn(), changed, lineNo: (f, i) => addedOf(f).nos[i], run: (cmd) => runOnce("bash", ["-c", cmd], ctx.repoDir, signal, {}),
        runBase: async (cmd) => { if (signal.aborted || (deadline !== undefined && Date.now() > deadline - SUITE_MARGIN_MS)) return null; const dir = bt.get(changed, zg0); if (!dir) return null; bt.link(dir); return runOnce("bash", ["-c", cmd], dir, signal, {}); } });
      if (checklistMode() === "enforce") for (const r of cl.filter((x) => x.result === "fail")) { const k: VerifyCheck = { name: "checklist", cmd: ".loki-checklist.json", result: "fail", duration_s: 0, reason: `${r.id}: ${r.detail}` }; checks.push(k); }
    }
    // VERIFY-PLAN V4 (LOKI_E10_E2E_BOOT, off by default): boot the app on the change and on the base tree before the seal (the post-seal app runner, deep.ts runAppBoot).
    let endToEnd: { head: BootSummary; base: BootSummary | null; outcome: BootOutcome } | undefined;
    { const bootMode = ruleMode("LOKI_E10_E2E_BOOT", "off");
      if (bootMode !== "off" && complete && !signal.aborted) {
        const t0 = Date.now(), { appProbe } = await import("../../util/app_probe.ts");
        const head = bootSummary(await appProbe(ctx.repoDir, join(ctx.repoDir, ".loki")));
        const bdir = deadline !== undefined && Date.now() > deadline - SUITE_MARGIN_MS ? null : bt.get(changed, zg0); if (bdir) bt.link(bdir);
        const base = bdir && !signal.aborted ? bootSummary(await appProbe(bdir, join(bdir, ".loki"))) : null;
        const outcome = bootOutcome(head, base, bootMode, (Date.now() - t0) / 1000);
        endToEnd = { head, base, outcome };
        if (outcome.check) checks.push({ ...outcome.check });
      } }
    const notExcused: string[] = []; const fullSeen: DeepCheck[] = []; const fullNotProven = new Set<string>(); // no-runner entries are dropped at not_proven: nothing ran, and the risk record keeps the full test command deferred
    const fullErr = new Map<string, Record<string, string[]>>(); // fl24: each full suite's head error lines, for baseRedById below
    const ranDeeper: string[] = []; // selected deeper checks verify executed (pass or fail); markExecuted rebuilds the deferred list from all of them
    // NTF LOKI_E10_NO_TEST_FALLBACK (default on, =0 opts out): a low-tier verify that executed no test at all (ink: lint:tsc only; tera: cargo maps no test file) runs the repo's own
    // test command for the packages that own the changed files, through the same full-suite path and its base attribution. Nothing executable there stays NOT PROVEN ("no tests executed").
    const ntf = noTestFallbackOn() && risk?.tier === "low" && !checks.some((c) => !c.name.startsWith("lint:") && (c.result === "pass" || c.result === "fail"));
    // G6 relief (FULL-SUITE-FINAL-ONLY, FULL-SUITE-REUSE; low tier only): defer the suite while a check that feeds the fix round is red, and reuse the previous
    // verify's result for a suite whose key (fullSuiteKey) is unchanged. full_suite_runs is carried across quick and deferred verifies.
    const deferSuite = !!risk && complete && !signal.aborted && deferFullSuite({ tier: risk.tier, ntf, settle, checks, touchedRed, keep, changed });
    const reuseOn = fullSuiteReuseOn() && risk?.tier === "low", prevVerify = ctx.outputs().verify as Record<string, unknown> | undefined, prevRuns = reuseOn ? suiteRunsOf(prevVerify?.["full_suite_runs"]) : [];
    const ranRuns: FullSuiteRun[] = [], askedKeys = new Map<string, { cwd: string; key: string }>();
    const reuse = (s: { name: string; cmd: string; cwd: string }): DeepCheck | null => {
      let key: string;
      try { key = fullSuiteKey({ baseSha: ctx.baseSha, ...s, hashes: fileHashes(ctx.repoDir, changedFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created))), deps: depStamp(ctx.repoDir, s.cwd) }); } catch { return null; } // read now, before the suite runs: the key describes the tree it runs on; unknown diff: no key, no record, no reuse
      askedKeys.set(`${s.name}\0${s.cmd}`, { cwd: s.cwd, key });
      return reusableRun(prevVerify, s, key);
    };
    if (risk && (risk.tier !== "low" || ntf || lowTierFullSuiteOn()) && !signal.aborted && (complete || settle) && !deferSuite) { // RISKTIER: medium and high run the detected full test command (deep.ts runner table); the reviewer and council stay recorded as not run
      const { runFullSuite } = await import("./deep.ts"); // lazy: deep.ts imports this module
      const full: Parameters<typeof runFullSuite>[3] = [];
      await runFullSuite(ctx, signal, { ...(reuseOn ? { reuse } : {}), changed, symbols, ...(ntf && risk?.tier === "low" && !lowTierFullSuiteOn() ? { ownedOnly: true } : {}), ...(baseOnDemandOn() ? { scope: true, suiteTimeoutMs: () => suiteTimeoutFor(deadline, Date.now()), ensureBase } : {}), targetPassed: checks.some((c) => targetNames.has(c.name) && c.result === "pass" && hasExecutedProof([c])), wallBaseRed: wallRedOnBaseOf(ctx.outputs().wall?.base_run), proofFiles: wallProofOf(checks, [...wallTests.map((t) => ({ name: testCheckName(t), path: t.path })), ...(hold?.tests ?? []).map((h, i) => ({ name: `holdout:${i + 1}`, path: (h as TestRef).path }))]) }, full, fullNotProven);
      for (const c of full) { const a = askedKeys.get(`${c.name}\0${c.cmd}`); if (reuseOn && a && !c.reused) ranRuns.push({ name: c.name, cmd: c.cmd, cwd: a.cwd, key: a.key, check: structuredClone(c) }); } // FULL-SUITE-REUSE: recorded before HEAD-RERUN below edits the checks in place
      for (const c of full) { const k: VerifyCheck = { name: c.name, cmd: c.cmd, result: c.result as VerifyCheck["result"], duration_s: c.duration_s, ...(c.reason ? { reason: c.reason } : {}), ...(c.count ? { count: c.count } : {}), ...(c.result === "fail" ? { ...(c.ids ? { ids: c.ids } : {}), ...(c.first_error ? { first_error: c.first_error } : {}) } : {}),
        ...(c.load_external?.length && c.load_note ? { load_external: c.load_external, load_note: c.load_note } : {}), // UNRUNNABLE-EXTERNAL
        ...(c.reused ? { reused: true, ...(c.reused_key ? { reused_key: c.reused_key } : {}) } : {}), // FULL-SUITE-REUSE: on the check, never in not_proven
      }; suites.add(k); checks.push(k); ctx.emit("test.result", "verify", { ...k }); if (c.excerpt) excerpts.set(k, c.excerpt); } // P12-01: full-suite checks leave the same test.result evidence per-file checks do
      for (const c of full) if (c.errors) fullErr.set(c.name, c.errors);
      fullSeen.push(...full); // EXOGENOUS-RED reads them after every excuse is settled
      for (const c of full) { const spec = c.result === "fail" ? suiteSpecs.find((sp) => sp.name === c.name && sp.cmd === c.cmd) : undefined; if (spec) await ensureBase(spec); } // RW-01: only a suite red on head is measured on base
      // HEAD-RERUN (G1): a failing id that the base run did not show counts against the change only when it fails again. One rerun of the same command on head
      // per suite; an id that passes there is dropped from the check and disclosed. A per-file check already has this (runCheck's one retry). closed-set-2
      // hm155462: 1 of 469 failing ids was head-only and passed on the rerun.
      for (const c of full) {
        if (c.result !== "fail" || !c.ids?.length || signal.aborted || !headRerunOn()) continue;
        const spec = suiteSpecs.find((sp) => sp.name === c.name && sp.cmd === c.cmd), red = spec ? baseRedIds(ctx.repoDir, ctx.baseSha, c.cmd) : null; if (!spec || !red) continue;
        const only = comparableIds(c.ids).filter((i) => !red.has(i)); if (only.length === 0) continue;
        const tmo = suiteTimeoutFor(deadline, Date.now()); if (tmo < 1000) continue;
        const r = await asyncShellRunner(signal)(spec.run, join(ctx.repoDir, spec.cwd), tmo); if (r.timedOut || r.missing || signal.aborted) continue; // a cut rerun says nothing: the ids stay
        const passed = passedOnRerun(only, r, c.executed); if (passed.length === 0) continue; // dropped only on positive evidence that the id ran and passed (repo_profile.ts passedOnRerun)
        const drop = new Set(passed); c.ids = c.ids.filter((i) => !drop.has(i)); if (c.errors) c.errors = Object.fromEntries(Object.entries(c.errors).filter(([k]) => !drop.has(k)));
        headRerun.push({ check: c.name, passed_on_rerun: passed.slice(0, 50), count: passed.length });
        const k = checks.find((x) => x.name === c.name && suites.has(x)); if (k) k.ids = c.ids;
        if (r.code === 0 && c.ids.length === 0) { c.result = "pass"; if (k) { k.result = "flaky"; delete k.ids; delete k.first_error; } } // the whole command passed the second time and nothing else was red: fail-then-pass, as a per-file check reads
        ctx.emit("test.head_rerun" as never, "verify", { check: c.name, head_only: only.length, passed_on_rerun: passed.length });
      }
      if (baseOnDemandOn() && ctx.runDir) writeBaselineRecord(ctx.repoDir, ctx.runDir); // baseline.json follows what was measured on demand
      for (const n of baseUnmeasured) fullNotProven.add(n);
      const blockedIds = checks.filter((c) => c.result === "fail" && !suites.has(c) && !preRed.names.includes(c.name)).flatMap((c) => c.ids ?? []);
      const shown = new Set(checks.filter((c) => touchedExcused.includes(c.name)).flatMap((c) => c.ids ?? [])), fa = attributeFullSuite(ctx.repoDir, ctx.baseSha, full, blockedIds, changed, symbols, shown); preRed.names.push(...fa.preExistingChecks); preRed.ids.push(...fa.preExistingIds); attr.introducedChecks.push(...fa.introducedChecks); attr.line = [attr.line, fa.line].filter(Boolean).join("; ") || null; notExcused.push(...whyFullSuiteNotExcused(ctx.repoDir, ctx.baseSha, full, changed, fa.preExistingChecks, blockedIds, shown)); // REPOMEM: same attribution for the full suite
      if (full.some((c) => c.result === "pass" || c.result === "fail")) { ranDeeper.push("full test command", "full suite"); risk = markExecuted(risk, ranDeeper); recordRisk(ctx.repoDir, risk); }
      // A full-suite failure whose every failing id is one a same-error base-red check or a Wall check already reports adds nothing a fix round could act on.
      const known = new Set(checks.filter((c) => c.result === "fail" && (preRed.sameError.includes(c.name) || wallNames0.has(c.name))).flatMap((c) => c.ids ?? []));
      for (const c of full) if (c.result === "fail" && c.ids?.length && !c.unhandled?.length /* an Unhandled Errors block names no id, so ids alone never cover it */ && comparableIds(c.ids).every((i) => known.has(i)) && !preRed.names.includes(c.name)) { preRed.knownRed.push(c.name); preRed.sameError.push(c.name); }
    }
    // fl24: the still-failing test checks every id of which is red on base by id alone, with no failure naming the change: the evidence machine.ts needs before a fix
    // round's "these failures pre-exist on base" stop is treated as pre-existing red instead of a spec conflict. It excuses nothing here.
    const baseRed = baseRedById(ctx.repoDir, ctx.baseSha, checks.filter((c) => c.result === "fail" && !preRed.names.includes(c.name) && !isHold(c) && (suites.has(c) || tests.some((t) => testCheckName(t) === c.name))).map((c) => ({ name: c.name, ...(c.ids ? { ids: c.ids } : {}), ...(suites.has(c) ? { cmd: c.cmd } : {}), ...((fullErr.get(c.name) ?? headErrors.get(c)) ? { errors: fullErr.get(c.name) ?? headErrors.get(c)! } : {}), ...(suiteOf(c.name) ? { suite: suiteOf(c.name)! } : {}), eligible: suites.has(c) || (!targetNames.has(c.name) && !changed.includes(c.name.slice(c.name.indexOf(":") + 1))) })), preRed.knownRed.filter((n) => !preRed.shapeDiffers.includes(n)), changed, symbols, preRed.shapeDiffers);
    if (risk && risk.tier === "high" && !signal.aborted && complete) { // PR-FIRST-4: the high tier's security scan runs here, before seal, so a receipt never leaves it to the post-PR deep stage (spawned only after VERIFIED). A fail blocks VERIFIED, a not_run (scanner missing or broken) caps at PARTIAL; only a pass or fail is credited
      const { runSecretScan } = await import("./deep.ts");
      const sec: Parameters<typeof runSecretScan>[3] = [];
      await runSecretScan(ctx, changed, { scanAddedSince: ctx.baseSha }, sec, fullNotProven); // added lines only: a match already on base (FireLater config/index.ts) never fails the run
      for (const c of sec) { const k: VerifyCheck = { name: c.name, cmd: c.cmd, result: c.result as VerifyCheck["result"], duration_s: c.duration_s, ...(c.reason ? { reason: c.reason } : {}), ...(c.secret_matches ? { secret_matches: c.secret_matches } : {}) }; checks.push(k); ctx.emit("test.result", "verify", { ...k }); }
      if (sec.some((c) => c.result === "pass" || c.result === "fail")) { ranDeeper.push(SECURITY_SCAN); risk = markExecuted(risk, ranDeeper); recordRisk(ctx.repoDir, risk); }
    }
    const wallObs = complete && !signal.aborted && wallMode() === "observe" ? await runObservedWall(ctx, signal, api) : undefined; // VERIFY-PLAN V3: last, recorded only
    const covered = (f: string): boolean => [...ctx.tests.impacted(map, [f]), ...(tests === tests0 ? [] : [...mochaTargets(ctx.repoDir, [f]), ...avaTargets(ctx.repoDir, [f])])].some((t) => checks.some((c) => c.name === testCheckName(t) && hasExecutedProof([c])));
    const uncoveredChanged = changed.filter((f) => CODE_EXT.test(f) && !isTestFile(f) && !wallPaths.has(f) && !cfgChanged.includes(f) && !covered(f)); // FC-21b: changed code no passing impacted check ran; seal denies VERIFIED after a limit
    const flaky = checks.filter((c) => c.result === "flaky").map((c) => (isHold(c) ? "holdout" : c.name)).concat(headRerun.map((h) => `${h.check}: ${h.count} test(s) failed once on the change and passed when the same command was run again (first: ${h.passed_on_rerun[0]}); not counted against the change`)); // HEAD-RERUN: disclosed with the flaky checks
    // ponytail: real clustering is failures.ts, which depends on this stage; a naive 1:1 placeholder keeps the section-4 output key populated until that slice lands.
    // UNCAUSED + INDEP: which reds a fix round may act on. independent = the Wall, a targeted test the diff touches (a changed test file, a test impacted by a changed file, the task's own)
    // or a full-suite failure absent from the base profile (base green, now red). uncaused = a red the diff cannot have caused: see uncausedRed.
    const ownLintNames = checks.filter((c) => ownLintOf(c, preRed, changed, symbols, excerpts.get(c) ?? "")).map((c) => c.name), ownTypeNames = checks.filter((c) => ownLintOf(c, preRed, changed, symbols, excerpts.get(c) ?? "", OWN_TYPECHECK)).map((c) => c.name); // LINT-OWN: the change's own style lint and type check reds in files it changed
    const indepNames = new Set([...wallNames0, ...[...changedTestFiles, ...impacted, ...own].map(testCheckName), ...attr.introducedChecks, ...ownLintNames, ...ownTypeNames]);
    // EXOGENOUS-RED: one record per failing check the run did not write and nothing excused (a full suite, or an untouched per-file test), read by seal's unattributedRed.
    const exoAttr: Record<string, ExogenousAttribution> = {};
    if (exogenousRedOn()) {
      const namesChange = lineNamesChange(changed), testsChanged = changed.some((f) => isTestFile(f)); // a record is never carried from an earlier verify: every check here was run by this one, and a stale record could hold a check this verify saw fail in a new way
      const named = (text: string): boolean => text.split("\n").some(namesChange);
      // A package intake listed that was gone when this verify started is the session's doing; the base tree gets no dependencies after that, so no base run can show it: blame the change.
      const gone = (cwd: string): string | null => goneAtStart.get(cwd === "" ? "." : cwd) ?? goneAtStart.get(".") ?? null;
      const withGone = <T extends Pick<ExogenousAttribution, "state" | "fresh" | "evidence">>(a: T, cwd: string): T => { const g = a.state === "compared" ? null : gone(cwd); return g ? { ...a, state: "compared", fresh: Math.max(1, a.fresh), evidence: `an installed package present at intake is gone (${g}), so the run changed what this check loads` } : a; };
      for (const c of fullSeen) {
        if (c.result !== "fail" || preRed.names.includes(c.name)) continue;
        exoAttr[c.name] = { ...withGone(exogenousState(ctx.repoDir, ctx.baseSha, c, testsChanged), suiteSpecs.find((sp) => sp.name === c.name)?.cwd ?? "."), names_changed: c.names_changed ?? named(c.excerpt ?? "") }; // names_changed: read from the suite's whole output where the check was built
      }
      for (const c of checks) {
        const t = tests.find((x) => testCheckName(x) === c.name);
        if (!t || c.result !== "fail" || !c.ids?.length || preRed.names.includes(c.name) || targetNames.has(c.name) || wallNames0.has(c.name) || isHold(c) || changed.includes(t.path) || exoAttr[c.name]) continue; // a Wall, holdout or task-named test is the change's own, and a file that printed no failing id got no base rerun (a broken import looks like this): no record, so each stays FAILED
        const bl = preRed.baseLoad[c.name] ?? [], hl = loadErrors(failOuts.get(c) ?? ""), hmods = new Set(hl.map(loadErrorModule)), bmods = new Set(bl.map(loadErrorModule));
        const baseOnly = bl.find((l) => !hmods.has(loadErrorModule(l))), headOnly = hl.find((l) => !bmods.has(loadErrorModule(l)));
        const cmp = preRed.compared.includes(c.name), fresh = preRed.fresh[c.name] ?? 0;
        const st: Pick<ExogenousAttribution, "state" | "fresh" | "evidence"> = baseOnly ? { state: "not comparable", fresh: 0, evidence: `the base run could not load a module the head run loaded: ${baseOnly}` }
          : headOnly && cmp ? { state: "compared", fresh: Math.max(1, fresh), evidence: `the head run could not load a module the base run loaded: ${headOnly}` }
          : headOnly ? { state: "not started", fresh: 0, evidence: `its base rerun ran none of its tests, so nothing shows the base loaded what head could not: ${headOnly}` }
          : cmp ? { state: "compared", fresh, evidence: fresh ? `${fresh} failing id(s) not red on base` : "every failing id is red on base" }
          : { state: "not started", fresh: 0, evidence: "its base rerun ran none of its tests" };
        exoAttr[c.name] = { ...withGone(st, api?.packageRootOf(t.path) ?? "."), names_changed: named(failOuts.get(c) ?? excerpts.get(c) ?? "") }; // the whole output of this verify's own run of the check, not the kept excerpt
      }
    }
    const exoHeld = Object.entries(exoAttr).filter(([, a]) => holdsPartial(a)).map(([n, a]) => exogenousHeldLine(n, a));
    // UNRUNNABLE-CHECK (repo_profile.ts couldNotRun; founder decision 2026-11-20): the checks that could not run on either side. A full suite held by its record
    // whose base and head runs show the same start failure, and a test file already sealed not_run because it fails the same way with the change removed or
    // crashes the same way on base. Kept only when no changed file is in the check's package and nothing it printed names a changed file. Seal decides the rest.
    const pkgOf = (f: string): string => { const r = api?.packageRootOf(f) ?? "."; return r === "" ? "." : r; };
    const unrunSuite = new Set(unrunnableCheckOn() ? unrunnableSuites(ctx.repoDir, ctx.baseSha, fullSeen) : []);
    const changedStems = changed.map((f) => f.replace(/\.[^./]+$/, "").split("/").pop() ?? "").filter((x) => x.length > 1), namesAChange = (text: string): boolean => { const n = lineNamesChange(changed); return text.split("\n").some(n) || changedStems.some((x) => new RegExp(`(?<![\\w$])${escapeRegex(x)}(?![\\w$])`).test(text)); };
    const unrunCands: { name: string; pkg: string; namesChanged: boolean; external?: boolean }[] = [
      ...fullSeen.filter((c) => unrunSuite.has(c.name) && !!exoAttr[c.name] && holdsPartial(exoAttr[c.name]!)).map((c) => ({ name: c.name, pkg: pkgOf(`${suiteSpecs.find((sp) => sp.name === c.name)?.cwd ?? "."}/x`), namesChanged: exoAttr[c.name]!.names_changed })),
      ...checks.filter((c) => c.result === "not_run" && typeof c.reason === "string" && (c.reason.startsWith(NO_ID_BASE_REASON) || c.reason.startsWith(BCE_REASON)) && tests.some((t) => testCheckName(t) === c.name)).map((c) => ({ name: c.name, pkg: pkgOf(tests.find((t) => testCheckName(t) === c.name)!.path), namesChanged: c.reason!.startsWith(BCE_REASON) && namesAChange(c.reason!) })),
    ];
    // An install step whose own tool is not on this machine (missingTool): it ran at intake, on the base commit, and the machine is the same for the change.
    const depsCap = unrunnableCheckOn() ? unusedInstallNotes(intake?.deps_not_proven ?? [], api, changed, checks.map((c) => c.name), ctx.repoDir).cap : [];
    const installCands = ((Array.isArray((intake as Record<string, unknown> | undefined)?.["deps_install"]) ? (intake as Record<string, unknown>)["deps_install"] : []) as Record<string, unknown>[]).filter((c) => c.result === "not_run" && typeof c.name === "string" && typeof c.reason === "string" && depsCap.includes(`${c.reason} (${c.name}; harness-owned)`) && missingTool(c.reason, String(c.cmd ?? "")) !== null)
      .map((c) => ({ name: String(c.name), pkg: pkgOf(`${String(c.name).slice("install:".length)}/x`), namesChanged: namesAChange(String(c.reason)), note: `${String(c.reason)} (${String(c.name)}; harness-owned)` }));
    unrunCands.push(...installCands);
    const externalCands = externalUnrunCands(checks, (n) => { const t = tests.find((x) => testCheckName(x) === n); return t ? pkgOf(t.path) : pkgOf(`${suiteSpecs.find((sp) => sp.name === n)?.cwd ?? "."}/x`); }); // UNRUNNABLE-EXTERNAL: kept by couldNotRun even in a touched package
    unrunCands.push(...externalCands);
    const couldNot = couldNotRun(unrunCands, changed, pkgOf), couldNotIf = couldNotRunIfProved(unrunCands, changed, pkgOf, isTestFile), couldAll = [...couldNot, ...Object.keys(couldNotIf)];
    const couldNotNotes = [
      ...couldAll.filter((n) => !!exoAttr[n]).map((n) => exogenousHeldLine(n, exoAttr[n]!)),
      ...preRed.envCrash.filter((e) => couldAll.includes(e.name)).map((e) => `${e.name}: ${BCE_REASON} (${e.sig})`),
      ...noIdGroups.filter((g) => g.names.every((n) => couldAll.includes(n))).map((g) => g.note),
      ...installCands.filter((c) => couldAll.includes(c.name)).map((c) => c.note),
      ...externalCouldNotNotes(externalCands, couldAll), // UNRUNNABLE-EXTERNAL: the load lines that held the label for these checks
    ];
    const couldNotOut = couldAll.length ? { could_not_run: couldNot, ...(Object.keys(couldNotIf).length ? { could_not_run_if_proved: couldNotIf } : {}), could_not_run_notes: couldNotNotes } : {};
    const uncaused = uncausedOn() ? checks.filter((c) => feedsFixRound(c, preRed) && !indepNames.has(c.name) && uncausedRed(c, changed, symbols, excerpts.get(c) ?? "")).map((c) => c.name) : [];
    const independentFail = checks.some((c) => c.result === "fail" && indepNames.has(c.name) && !preRed.names.includes(c.name)), independentReds = checks.filter((c) => c.result === "fail" && indepNames.has(c.name) && !preRed.names.includes(c.name)).map((c) => c.name);
    const { groups: failuresGrouped, names: blockingNames } = briefGroups(checks.filter((c) => !uncaused.includes(c.name)).filter((c) => feedsFixRound(c, preRed) || (fixRounds === 0 && collateralSame.includes(c.name) && !collateralBase.includes(c.name))), (c) => excerpts.get(c) ?? "", (c) => suites.has(c), EXCERPT_TOTAL_CAP, qs && !complete ? { prev: ctx.outputs().verify, ran: new Set(checks.map((c) => c.name)) } : undefined); // known red failing the same way as on base (or a full suite repeating those and Wall ids) never feeds a fix round; a different error does; TEN-QUALITY-01: sample = rerun cmd + redacted excerpt, 6 KB across all groups
    const pub = checks.map((c) => (isHold(c) ? pubHold(c) : c)), holdoutFailed = checks.filter((c) => c.result === "fail" && isHold(c) && !preRed.names.includes(c.name)).length; // C-C4b-c: pub leaves this stage, holdoutFailed (C-C4b) is the only form in which a held-out failure reaches the fix stage
    // E-98a/E-115: a check that ran (not_run has its own NOT PROVEN entry at seal) on a system interpreter/ruff. A-115: test configuration edits and relevant checks with more skips than base are listed, which makes the verdict PARTIAL at seal.
    const inBase = (f: string): boolean => { try { safeGit(ctx.repoDir, ["cat-file", "-e", `${ctx.baseSha}:${f}`], { stdio: "ignore" }); return true; } catch { return false; } };
    const testCounts: Record<string, unknown> = {}; const modifiedRel = relevant.filter((t) => changed.includes(t.path) && inBase(t.path)).flatMap((t) => { const k = preRed.cnt[testCheckName(t)]; if (k) testCounts[t.path] = k; return [...(testFileWeakened(ctx.repoDir, ctx.baseSha, null, t.path, "M", intake?.task ?? "") ? [`weakened test: ${t.path}`] : []), ...(assertDeltaNotes(ctx.repoDir, ctx.baseSha, null, t.path, intake?.task ?? "", k?.b, k?.h) ?? [])]; }); // a relevant test file edited: listed as weakened only when it loses an assertion or case or gains a skip (EXP-0001: an added case is kept); a changed assertion value is always listed
    const weakened = [...modifiedRel, ...cfgChanged.map((f) => `test configuration changed: ${f}`), ...preRed.weak.map((n) => `skipped or fewer tests than base: ${n}`), ...collateralRed.map((n) => `${COLLATERAL_RED}: ${n}`), ...preRed.quiet.filter((n) => preRed.names.includes(n)).map((n) => `${QUIET_RED}: ${n}`)];
    const fullChecks = checks.filter((c) => c.name.startsWith("full suite")), fullSuiteRan = fullChecks.length > 0 && fullChecks.every((c) => c.result === "pass" || c.result === "fail") && ![...fullNotProven].some((n) => n.includes(" not run: no changed file is in this package")); // the importers of a changed file that the 20-file cap left out still ran when the whole suite ran: its failures are compared with base per id, so the dropped-files note no longer caps the label (a Haiku run with every acceptance line met was PARTIAL on it alone)
    const depsNotes0 = withGuideNotes(unusedInstallNotes(intake?.deps_not_proven ?? [], api, changed, checks.map((c) => c.name), ctx.repoDir, checks), ctx.repoDir); // an install failure no check or changed file depends on is disclosed (n/a), never a cap
    const depsNotes = { ...depsNotes0, na: [...depsNotes0.na, ...lokiVenvNotes(intake), ...lokiEnvNotes(ctx.repoDir)] }; // G2: what Loki's own commands did to the environment, informational
    const notProven = [...(complete ? [] : [QUICK_ONLY_NOTE, ...unrunSuitesCarried(ctx.outputs().verify?.not_proven, checks)]), ...exoHeld, ...preRed.envCrash.map((e) => `${e.name}: ${BCE_REASON} (${e.sig})`), ...noIdNotes, ...venvSkipNotes(ctx.repoDir), ...weakened, ...hiddenEdits(ctx.repoDir), ...ignoreRuleChanges(ctx.repoDir, (intake as { ignore_snapshot?: unknown } | undefined)?.ignore_snapshot, ctx.baseSha), ...dependentNotes(dep).filter((n) => !(fullSuiteRan && n.startsWith("reverse-dependent tests dropped"))), ...depsNotes.cap, ...pub.filter((c) => c.name === "holdout" && c.result !== "pass").map((c) => (c.result === "not_run" ? "holdout not executed" : "holdout check failed")), ...[...fullNotProven].filter((n) => !naNote(n)), ...pub.filter((c) => c.owner === "harness" && c.name !== "holdout").map((c) => harnessNote(c.reason, c.name)), ...new Set(checks.filter((c) => c.interpreter === "system" && c.result !== "not_run").map((c) => (c.name.startsWith("lint:") ? "lint ran on the system ruff" : "tests ran on the system interpreter")))];
    const wallDropped = [...wallPaths].filter((p) => !wallTests.some((t) => t.path === p)); // FC-WALL-FILE-WITHOUT-RUNNER-SILENTLY-DROPPED: sealed, but no runner of this repo can run it
    notProven.push(...wallDropped.map((p) => `Wall test not executed: ${p}: ${NO_RUNNER_REASON}`));
    if (deferSuite) notProven.push(FULL_SUITE_DEFERRED_NOTE); // FULL-SUITE-FINAL-ONLY: caps this verify, so it can never back VERIFIED
    if (ctx.runDir) writeCheckFailureTails(ctx.runDir, checks.filter((c) => c.result === "fail" && !isHold(c) && !preRed.names.includes(c.name) && failTails.has(c)).map((c) => ({ name: c.name, out: failTails.get(c)! }))); // CHECK-FAILURE-TAILS
    const wallNames = new Set(wallTests.map(testCheckName)), wallRun = checks.filter((c) => wallNames.has(c.name) || isHold(c)), wallFailTail = writeWallFailureTail(ctx.runDir, checks.filter((c) => wallNames.has(c.name) && c.result === "fail" && !isHold(c) && !preRed.names.includes(c.name)).map((c) => ({ name: c.name, out: failTails.get(c) ?? "" }))), wallPassed = wallRun.some((c) => c.result === "fail") ? false : wallRun.length > 0 && wallDropped.length === 0 && wallRun.every((c) => c.result === "pass") ? true : undefined; // the receipt's wall.passed: false on any failure, true only when every Wall and holdout check ran and passed, unset otherwise
    await settleNrd(ctx); // SPEED-NRD-OVERLAP: the differential implement started has run beside these checks; its group joins this verify's
    { const sl = Object.entries(preRed.silent).filter(([n]) => preRed.names.includes(n)).map(([n, k]) => `${k} test(s) of ${n} ${SILENT_IDS_NOTE}`); if (sl.length) attr.line = [attr.line, ...sl].filter(Boolean).join("; "); } // SILENT-IDS disclosure (the receipt's baseline line)
    if (baseMemberNote) attr.line = [attr.line, baseMemberNote].filter(Boolean).join("; "); // BASE-TREE-MEMBERS disclosure (the receipt's baseline line)
    if (touchedExcused.length) attr.line = [attr.line, ...touchedExcused.map((n) => `${TOUCHED_RED}: ${n}`)].filter(Boolean).join("; ") || null; // TOUCHED-BASE-RED disclosure (the receipt's baseline line)
    return { status: "completed", data: { checks: pub, flaky, verify_scope: complete ? "complete" : "quick", ...(headRerun.length ? { head_rerun: headRerun } : {}), ...couldNotOut, ...(preRed.compared.length ? { base_compared: [...new Set(preRed.compared)] } : {}), ...(ntf ? { no_test_fallback: true } : {}), ...(uncaused.length ? { uncaused_reds: uncaused } : {}), ...(lintUntouchedNames.length ? { lint_untouched: lintUntouchedNames } : {}), ...(ownLintNames.length ? { own_lint: ownLintNames } : {}), independent_fail: independentFail, ...(independentReds.length ? { independent_reds: independentReds } : {}), fix_gate: fixGateOf({ independent_fail: independentFail, independent_reds: independentReds }, `${String(ctx.outputs().implement?.model ?? "")} ${ctx.model}`, failuresGrouped.length > 0), file_hashes: hashes, blocking_checks: blockingNames, ...(wallFailTail ? { wall_failure_tail: wallFailTail } : {}), ...(wallPassed === undefined ? {} : { wall_passed: wallPassed }), failures_grouped: [...failuresGrouped, ...nrdGroupsFor(ctx.outputs().implement, fixRounds)], holdout_failed: holdoutFailed, changed_files: changed, ...(depNames.size ? { dependent_checks: [...depNames] } : {}), not_proven: notProven, ...(fullNotProven.size || depsNotes.na.length ? { not_applicable: [...[...fullNotProven].filter(naNote).map(naText), ...depsNotes.na] } : {}), pre_red: preRed.ids, pre_red_checks: preRed.names, ...(notExcused.length ? { not_excused: notExcused } : {}), ...(Object.keys(exoAttr).length ? { exogenous_attribution: exoAttr } : {}), ...(preRed.knownRed.length ? { known_red_checks: preRed.knownRed } : {}), ...(preRed.sameError.length ? { known_red_same_error: preRed.sameError } : {}), ...(baseRed.length ? { base_red_checks: baseRed } : {}), skipped_on_base: preRed.zero, ...(collateralSame.length && fixRounds === 0 ? { collateral_same_error: collateralSame } : {}), ...(attr.line ? { baseline_line: attr.line, introduced_checks: attr.introducedChecks } : {}), test_counts: testCounts, uncovered_changed: uncoveredChanged, target_checks: checks.filter((c) => c.result === "pass" && targetNames.has(c.name)).map((c) => (isHold(c) ? "holdout" : c.name)), risk,
      ...(structuredResultsMode() !== "off" ? { structured_results: structuredSummary(checks) } : {}), // VERIFY-PLAN V5 observe: never read by the label
      own_checks: [...new Set([...targetNames].map((n) => (isHoldoutCheck(n) ? "holdout" : n)))], // VERIFY-PLAN V2: the Wall and task-named test checks, whatever their result
      ...(noIdCompared.length ? { no_id_compared: noIdCompared } : {}), // VERIFY-PLAN V2
      ...(wallObs ? { wall_observe: wallObs } : {}), // VERIFY-PLAN V3: the observed Wall's results, never a check
      ...(quarantined.length ? { flaky_quarantine: quarantined, flaky_base: flakyBase } : {}), // VERIFY-PLAN V8
      ...(cl.length || clProblem ? { checklist: cl, ...(clProblem ? { checklist_problem: clProblem } : {}) } : {}), // VERIFY-PLAN V10
      ...(endToEnd ? { end_to_end: endToEnd } : {}), // VERIFY-PLAN V4
      ...(deferSuite ? { full_suite_deferred: true } : {}), // FULL-SUITE-FINAL-ONLY
      ...(reuseOn ? { full_suite_runs: nextSuiteRuns(prevRuns, ranRuns) } : {}), // FULL-SUITE-REUSE: carried forward through a verify that ran no suite
    } };
  }
}
export const stage = verifyStage;
