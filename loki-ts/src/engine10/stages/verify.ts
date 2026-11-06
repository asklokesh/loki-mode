// E-09 Fast verify (ENGINE.md 4 "Fast verify", 16 E-09). Runs impacted + changed test files + Wall tests, plus lint/typecheck of changed files, each under one per-check timeout. A missing tool is NOT PROVEN ("not_run"), never a failure; a failing check gets one rerun,
// fail-then-pass is "flaky". An empty diff with the already_done marker seals ALREADY_SATISFIED; without it, FAILED (ENGINE.md 2). Reaches testmap.ts/ machine.ts only through RunContext's `tests: TestMapProvider`, injected as a fake in tests, never imported here.
import { installHint } from "../../util/stack_tools.ts";
import { atomicWriteText } from "../../util/atomic.ts"; import { redactSecrets } from "../../util/redact.ts";
import { installOwned, projectDeclaresRuff, unusedInstallNotes } from "../../project_model/install.ts"; import { nrdGroupsFor } from "../../features/no_regression.ts";
import { scopedOutOf } from "../../project_model/scope.ts";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path"; import { MANIFESTS } from "../../contrib/wall_snapshot.ts"; import { classifyRunnerOutput } from "../../runner/runner_errors.ts";
import { hiddenConfigChanged, testConfigChanged } from "../../features/runner_config.ts"; import { assertDeltaNotes } from "../../e10ext/assert_delta.ts"; import { failIds } from "../failures.ts";
import { failedFirst, QUICK_ONLY_NOTE, quickScope, quickSplit } from "../../e10ext/select.ts"; import { dependentNotes, dependentTests } from "../../features/dependents.ts"; import { harnessLoadReason } from "../../runner/load_owner.ts";
import { loadRepoMap, namedFiles } from "../sizing.ts";
import { guessRunner, isTestFile } from "../testmap.ts"; import { coveredStem } from "../../util/test_file_text.ts"; import { comparableIds, errorsById, sameErrors } from "../failures.ts"; export { errorsById, sameErrors } from "../failures.ts";
import { goJsonStream, GO_JSON_KEEP, withoutStaleWall, failureExcerpt, EXCERPT_TOTAL_CAP, changedFiles, hiddenEdits, ignoreRuleChanges, classifyCheck, corroboratePass, classifyRisk, mapPool, verifyJobs, diffFiles, markExecuted, recordRisk, plainTestEnv, stripAnsi, goRunner, hasExecutedProof, ran, skipped, summaryPassFailCount, SECURITY_SCAN, fileHashes, briefGroups, failureSignature } from "../../util/check_result.ts";
import { WALL_COMPILE_REASON, wallOwnedFailure } from "../../util/wall_owned.ts"; import { isHoldoutCheck, recordHoldoutTriage, stageHoldout } from "../../util/holdout.ts";
import { type ImplementExit, type RunContext, type RunnerName, type Stage, type StageResult, type TestRef, STAGE_BUDGETS } from "../types.ts";
import type { ProjectApi } from "../../project_model/api.ts"; import { groupByPackage, loadProjectApi } from "../../project_model/resolve.ts";
import { safeGit } from "../../util/safe_git.ts"; import { testFileWeakened } from "../../util/test_guard.ts"; import { baseDepsLinker, zeroGate, zeroOnBase, type ZeroGate } from "../../util/base_guard.ts"; import { attribute, attributeFullSuite, staticPreExisting, whyFullSuiteNotExcused, type StaticTool } from "../../runner/repo_profile.ts";
const CHECK_TIMEOUT_MS = 60_000; // ENGINE.md 16 E-09: "60s limit" per check; limitS (120s) is the stage's outer bound
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
  owner?: "harness"; skip_code?: SkipCode; /* machine-readable twin of the "<cmd> not found on PATH" reason */ // FC-02: the runner could not load or collect; not_run, never a code failure
}
export { runnerCmd, commandFor, firstError } from "../../util/check_result.ts"; // one owner: check_result.ts (test invocation resolver and failure-line normalizer)
import { type SkipCode, changedSymbols, firstFileLineAnchor, runnerCmd, commandFor, firstError, resolveTool, NO_TESTS_REASON, NO_RUNNER_REASON, CODE_FILE_EXT as CODE_EXT } from "../../util/check_result.ts"; import { naNote, naText, wallRedOnBaseOf, wallProofOf } from "../../project_model/package_suite.ts";
/** TEN-QUALITY-01: stage-local failure excerpts keyed by check object; never on VerifyCheck, never emitted, never set for a held-out check. */
const excerpts = new WeakMap<object, string>();
export const checkExcerpt = (c: VerifyCheck): string => excerpts.get(c) ?? ""; // the patch protocol's repair digest (features/patch_protocol.ts)
const suites = new WeakSet<object>(); // L005: full-suite checks, whose signature also carries the failing ids
const failTails = new WeakMap<object, string>(); // WALL-FAILOUT: redacted tail of a failed check's output, read only by writeWallFailureTail
const tscOut = new WeakMap<object, string>(); // a failed lint:tsc check's whole output tail, read only by tscUntouchedLocal
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
export const COLLATERAL_RED = "relevant test already failing on base, still failing the same tests (it imports a file the task names; capped, not blocking)";
export function collateralTests(relevant: TestRef[], named: string[]): TestRef[] {
  const stems = new Set(named.flatMap((f) => { const s = basename(f).replace(/\.[^.]+$/, ""); return /^(index|__init__|mod)$/.test(s) && f.includes("/") ? [s, basename(f.slice(0, f.lastIndexOf("/")))] : [s]; }));
  return relevant.filter((t) => !named.includes(t.path) && !stems.has(coveredStem(t.path)));
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
}
export { ran, skipped } from "../../util/check_result.ts"; // FC-16: the one shared count parser and classifier live in check_result.ts
export { testConfigChanged } from "../../features/runner_config.ts"; // D86 FC-09r: the one runner-config registry lives in features/
/** `cut` means the timeout or the stage's AbortSignal killed the child: never read as "fail" and
 *  never retried (a hung check must not burn 2x its timeout). `out` is a 64 KB tail, unread when cut. The result comes from exit + timeout, never pipe EOF (an orphaned grandchild may hold the pipes). */
export async function runOnce(cmd: string, args: string[], cwd: string, signal: AbortSignal, opts: RunOpts): Promise<{ ok: boolean; missing: boolean; cut: boolean; out: string }> {
  if (!Bun.which(cmd, { PATH: opts.path ?? process.env["PATH"] ?? "" })) return { ok: false, missing: true, cut: false, out: "" };
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS);
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: opts.group ? undefined : AbortSignal.any([signal, timeout]), ...(opts.group ? { detached: true } : {}),
    env: opts.path ? { ...plainTestEnv(), PATH: opts.path } : plainTestEnv(), // FC-69
  });
  const killGroup = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } }; if (opts.group) { AbortSignal.any([signal, timeout]).addEventListener("abort", killGroup, { once: true }); if (signal.aborted || timeout.aborted) killGroup(); } let tail = ""; const keep = goJsonStream(cmd, args) ? GO_JSON_KEEP : 65536, rs = [proc.stdout, proc.stderr].map((s) => s.getReader()); // a go test -json stream is parsed whole (a head-truncated stream reads as torn and never counts), so it keeps far more than the 64 KB tail
  const pumps = rs.map(async (r) => { const d = new TextDecoder(); for (;;) { const c = await r.read().catch(() => ({ done: true, value: undefined })); if (c.done) return; tail += d.decode(c.value, { stream: true }); if (tail.length > keep * 2) tail = tail.slice(-keep); } });
  const exitCode = await proc.exited;
  await Promise.race([Promise.all(pumps), new Promise((r) => setTimeout(r, 300))]); rs.forEach((r) => r.cancel().catch(() => {}));
  if (opts.group) killGroup(); const cut = timeout.aborted || signal.aborted;
  return { ok: exitCode === 0 && !cut, missing: false, cut, out: cut ? "" : stripAnsi(tail.slice(-keep)) }; // FC-69
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
    let c: ReturnType<typeof classifyCheck> & { owner?: "harness" } = await corroboratePass(classifyCheck({ kind, ok: a.ok, cut: a.cut, missing: a.missing, out: a.out, ...goRunner(cmd, args), path: /\.[cm]?[jt]s$/.test(args[args.length - 1] ?? "") ? args[args.length - 1] : undefined }), a.out, cmd, args, { cwd, env: opts.path ? { ...plainTestEnv(), PATH: opts.path } : plainTestEnv(), signal });
    const lr = kind === "test" && !a.ok && !a.cut && !a.missing ? await harnessLoadReason({ repoDir: ctx.repoDir, baseSha: ctx.baseSha, skip: installOwned(ctx.repoDir, ctx.outputs?.().intake?.install_created), out: a.out, cmd, args, signal, cwd, protect: opts.protect, ...(opts.path ? { env: { PATH: opts.path } } : {}) }) : undefined; // FC-02: only kind "test"; lint/tsc/selector (kind "static") never reach it
    if (lr) c = { result: "not_run", reason: lr, owner: "harness" };
    if (!lr && kind === "static" && !a.ok && !a.cut && !a.missing && opts.wall?.size && wallOwnedFailure(a.out, cwd, ctx.repoDir, opts.wall)) c = { result: "not_run", reason: WALL_COMPILE_REASON, owner: "harness" }; // FC-23: never a fix round on a read-only Wall file // harness-owned load error: never retried, never a fix round
    const reason = a.missing ? `${cmd} not found on PATH${installHint(cmd)}` : a.cut ? (signal.aborted ? "aborted" : `timed out after ${(opts.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000}s`) : c.reason;
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
  const anchor = result === "fail" ? firstFileLineAnchor(attempt.out.slice(-65536)) : null;
  const check: VerifyCheck = { name, cmd: cmdStr, result, duration_s: (Date.now() - started) / 1000, ...(result === "fail" ? { first_error: firstError(attempt.out), ids: failIds(attempt.out), ...(anchor ? { anchor } : {}) } : result === "pass" && kind === "test" ? { n: c.n ?? 0, sk: skipped(attempt.out) } : {}), ...(reason ? { reason } : {}), ...(attempt.missing ? { skip_code: "tool_not_on_path" as const } : {}), ...(c.owner ? { owner: "harness" as const } : {}), ...(opts.interpreter ? { interpreter: opts.interpreter } : {}) };
  if (result === "fail" && !opts.opaque && !isHold(check)) { excerpts.set(check, failureExcerpt(attempt.out, ctx.repoDir)); failTails.set(check, wallTailOf(attempt.out, ctx.repoDir)); headErrors.set(check, errorsById(attempt.out)); }
  if (result === "fail" && kind === "static" && name.startsWith("lint:tsc")) tscOut.set(check, attempt.out);
  checks.push(check); if (opts.opaque && check.result !== "pass" && check.reason) recordHoldoutTriage(ctx.runDir, { check: name, result: check.result, reason: check.reason }); // C-C4b-c-b: real reason stays out of the event below
  ctx.emit("test.result", "verify", opts.opaque ? { ...pubHold(check) } : { ...check });
  return check;
}

// L027: one vitest process per package for all its selected files, instead of one process per file. FireLater#24: a change to a shared module
// selected about 45 frontend page tests; one process each took 150 s of a verify that then hit its limit twice, while the whole frontend suite in
// one process took 11 s. A batched file is reported as the text vitest prints for that file alone, so every shared parser (ran, skipped, failIds,
// firstError, failureExcerpt) reads it exactly as a per-file run. A file the batch cannot vouch for (no report, a load or collect error, zero
// executed tests) runs alone through runCheck as before. LOKI_E10_VERIFY_BATCH=0 turns batching off.
export const verifyBatchOn = (env: NodeJS.ProcessEnv = process.env): boolean => env["LOKI_E10_VERIFY_BATCH"] !== "0";
const BATCH_MIN = 2;
const UNHANDLED_RE = /Unhandled (?:Errors?|Rejection)\b/;
const batchTimeoutMs = (files: number): number => Math.max(CHECK_TIMEOUT_MS, Math.min(300_000, files * 5_000));
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
      if (result === "fail") { excerpts.set(check, failureExcerpt(outText, ctx.repoDir)); failTails.set(check, wallTailOf(outText, ctx.repoDir)); headErrors.set(check, errorsById(outText)); }
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
function changedSymbolsFirst(ctx: RunContext, tests: TestRef[], changed: string[]): TestRef[] {
  const code = changed.filter((f) => CODE_EXT.test(f) && !isTestFile(f));
  if (code.length === 0 || tests.length < 2) return tests;
  let names: string[] = [];
  try { names = changedSymbols(safeGit(ctx.repoDir, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", ctx.baseSha, "--", ...code], { timeout: 20000 })).filter((n) => n.length >= 3); } catch { return tests; }
  if (names.length === 0) return tests;
  const re = new RegExp(`\\b(?:${names.map((n) => n.replace(/[$]/g, "\\$")).join("|")})\\b`);
  const hits = tests.filter((t) => { try { return re.test(readFileSync(join(ctx.repoDir, t.path), "utf8")); } catch { return false; } });
  return [...hits, ...tests.filter((t) => !hits.includes(t))];
}
/** A failing check the next fix round is given: not pre-existing, not held out, and not known red failing the same way as on base (a known-red check
 *  failing with a different error on head is something the change did, so it is fix-round input). */
export const feedsFixRound = (c: { name: string; result: string }, pre: { names: string[]; knownRed: string[]; sameError: string[] }): boolean => c.result === "fail" && !pre.names.includes(c.name) && !pre.sameError.includes(c.name) && !isHoldoutCheck(c.name);
type Counts = { run: number; skipped: number };
type BaseSubtraction = { ids: string[]; names: string[]; knownRed: string[]; sameError: string[]; weak: string[]; zero: string[]; cnt: Record<string, { b: Counts; h: Counts }> };
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
export async function subtractBase(
  ctx: RunContext, api: ProjectApi | null, checks: VerifyCheck[], tests: TestRef[], changed: string[],
  wall: Set<string>, rel: Set<string>, signal: AbortSignal, zeroOk = true, zeroIntake: ZeroGate = zeroGate(null), dep: ReadonlySet<string> = new Set(), own: ReadonlySet<string> = rel,
): Promise<BaseSubtraction> {
  const out: BaseSubtraction = { ids: [], names: [], knownRed: [], sameError: [], weak: [], zero: [], cnt: {} };
  const pairs = checks.flatMap((c) => {
    const t = tests.find((x) => testCheckName(x) === c.name);
    return t ? [{ c, t }] : [];
  });
  const un = pairs.filter(({ t }) => !changed.includes(t.path));
  const sus = pairs.filter(({ c }) => rel.has(c.name) && c.result === "pass");
  const zc = zeroOk ? un.filter(({ c, t }) => c.result === "not_run" && !c.owner && (c.reason ?? "").startsWith(NO_TESTS_REASON) && !wall.has(c.name) && !isHoldoutCheck(c.name) && !changed.includes(t.path) && zeroIntake.has(c.name)) : []; if (!(un.some(({ c }) => c.result === "fail" && c.ids?.length) || sus.length || zc.length) || signal.aborted) return out;
  const dir = mkdtempSync(join(tmpdir(), "e10-base-"));
  const git = (args: string[]): void => { safeGit(ctx.repoDir, args, { stdio: "ignore", repoDrivers: true }); }; // worktree add checks out base content
  try {
    git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, ctx.baseSha]);
    const base = new Map<VerifyCheck, { red: string[]; n: number; sk: number; out: string }>();
    const record = (c: VerifyCheck, b: { ok: boolean; cut?: boolean; out: string }): void => { base.set(c, { red: !b.ok && !b.cut ? failIds(b.out) : [], n: ran(b.out) ?? summaryPassFailCount(b.out), sk: skipped(b.out), out: b.cut ? "" : b.out }); };
    // Relevant passes first, on a base without dependencies (their counts are compared as before). Only failing untouched checks need a base run
    // after that: a passing one's base result is never read.
    await baseGoBatch(sus.map(({ c, t }) => ({ c, t, bc: commandFor(t, dir, api) })), signal, record);
    for (const { c, t } of sus) { if (base.has(c)) continue; const bc = commandFor(t, dir, api); record(c, await runOnce(bc.cmd, bc.args, bc.cwd, signal, {})); }
    const red = un.filter(({ c }) => c.result === "fail" && c.ids?.length && !base.has(c));
    // A suite that needs its dependencies (a vitest package with its own node_modules) yields no ids on a bare base, so its pre-existing failures
    // could never be told apart from new ones (FireLater#24: 23 page tests red on base were fed to the fix rounds). The head's dependency dirs are
    // linked in only when no dependency manifest changed and baseDepsLinker's guards hold (fail closed otherwise); vitest files run batched per package.
    const link = changed.some((f) => MANIFESTS.test(f)) ? null : baseDepsLinker(dir, ctx.repoDir, zeroIntake);
    const cmds = red.map((p) => ({ ...p, bc: commandFor(p.t, dir, api) }));
    for (const bc of new Set(cmds.map((x) => x.bc.cwd))) link?.(bc);
    if (verifyBatchOn() && !signal.aborted) {
      const byCwd = new Map<string, typeof cmds>();
      for (const x of cmds) if (vitestFile(x.t, x.bc)) byCwd.set(x.bc.cwd, [...(byCwd.get(x.bc.cwd) ?? []), x]);
      for (const [cwd, g] of byCwd) {
        if (g.length < BATCH_MIN || signal.aborted) continue;
        const res = await vitestBatch(cwd, g.map((x) => x.bc.args[3]!), signal);
        for (const x of g) { const f = res?.get(x.bc.args[3]!); if (f) record(x.c, f); }
      }
    }
    await baseGoBatch(cmds.map((x) => ({ c: x.c, t: x.t, bc: x.bc })), signal, record);
    for (const { c, bc } of cmds) if (!base.has(c) && !signal.aborted) record(c, await runOnce(bc.cmd, bc.args, bc.cwd, signal, {}));
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
        if (own.has(c.name) || c.result !== "fail" || !c.ids?.length || !comparableIds(c.ids).every((i) => base.get(c)?.red.includes(i))) continue;
        out.knownRed.push(c.name); // red on base by every failing id
        if (sameErrors(headErrors.get(c) ?? "", base.get(c)!.out, c.ids)) out.sameError.push(c.name); // and failing the same way: never fix-round input, and a delivery may excuse it as pre-existing; a different error feeds the fix round
        if (progress || dep.has(c.name)) { // RX-3: a dependent-only check needs no progress proof
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

// ponytail: existence of our own selector script is a strong enough marker that repoDir IS the loki-mode repo; a build target repo will not carry it.
function isLokiModeRepo(repoDir: string): boolean { return existsSync(join(repoDir, "scripts", "select-tests.sh")); }
const ESLINT_CONFIGS = [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];
/** ENGINE.md section 4's named tool per language: bash -n + shellcheck for shell, tsc + eslint  (when configured) for TS/JS, ruff for Python. Every named tool that applies to the changed set  gets
 *  a check entry: a missing tool is not_run, never silently absent (section 9 NOT PROVEN). */
/** TEN-QUALITY-03: a failed ruff/shellcheck/eslint check whose every diagnostic is also on the base content (git show, fed on stdin, same per-check timeout) is pre-existing. */
const excuseLint = (ctx: RunContext, signal: AbortSignal, c: VerifyCheck, tool: StaticTool, cmd: string, prefix: string[], cwd: string, rel: string[], opts: RunOpts): Promise<boolean> => c.result !== "fail" || signal.aborted ? Promise.resolve(false) : staticPreExisting(tool, prefix, rel, { run: async (a, stdin) => { if (signal.aborted) return null; const r = await runOnce(cmd, a, cwd, AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS)]), { ...opts, ...(stdin !== undefined ? { stdin } : {}) }); return r.missing || r.cut ? null : r; }, base: (f) => { try { return safeGit(ctx.repoDir, ["show", `${ctx.baseSha}:${relative(ctx.repoDir, join(cwd, f))}`], { stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } } });
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
/** The same `tsc --noEmit` on a pristine detached base worktree with the head's dependency dirs linked (the package's and the repo root's); null when base cannot be checked (fail closed). */
async function tscOnBase(ctx: RunContext, groupCwd: string, signal: AbortSignal, opts: RunOpts): Promise<string | null> {
  if (signal.aborted) return null;
  const dir = mkdtempSync(join(tmpdir(), "e10-basetsc-")), git = (args: string[]): void => { safeGit(ctx.repoDir, args, { stdio: "ignore", repoDrivers: true }); };
  try {
    git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, ctx.baseSha]);
    const cwd = join(dir, relative(ctx.repoDir, groupCwd)), link = baseDepsLinker(dir, ctx.repoDir);
    if (!existsSync(join(cwd, "tsconfig.json")) || !link(cwd)) return null;
    if (cwd !== dir) link(dir);
    const r = await runOnce("npx", ["--no-install", "tsc", "--noEmit", "-p", "."], cwd, AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS)]), { ...opts });
    return r.missing || r.cut ? null : r.out;
  } catch { return null; } finally {
    try { git(["worktree", "remove", "--force", dir]); } catch { /* pruned below */ }
    rmSync(dir, { recursive: true, force: true });
    try { git(["worktree", "prune"]); } catch { /* best effort */ }
  }
}
export async function runLintChecks(
  ctx: RunContext, changed: string[], signal: AbortSignal, checks: VerifyCheck[], opts: RunOpts & { api?: ProjectApi | null; keep?: ReadonlySet<string> } = {},
): Promise<string[]> {
  const { api, keep, ...runOpts } = opts; opts = runOpts; const pre: string[] = []; // check names whose static diagnostics are all pre-existing
  const py = changed.filter((f) => f.endsWith(".py"));
  const [ruffCmd, interpreter, uvPre] = py.length ? resolveTool(ctx.repoDir, "ruff", "ruff") : ["ruff", "system", []] as ReturnType<typeof resolveTool>; // E-98a: same project-first resolution as pytest
  if (py.length && (interpreter !== "system" || Bun.which("ruff", { PATH: process.env["PATH"] ?? "" }) || projectDeclaresRuff(ctx.repoDir))) { // FC-LINT-TOOL-NEVER-USED-BY-PROJECT: a repo that neither declares ruff nor has one installed has no lint to run
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
    if (existsSync(join(g.cwd, "tsconfig.json"))) { const c = await runCheck(ctx, `lint:tsc${sfx}`, "npx", ["--no-install", "tsc", "--noEmit", "-p", "."], signal, checks, { ...co, kind: "static" }); if (c.result === "fail" && keep && tscLocalKeys(tscOut.get(c) ?? "", g.root, keep, [...keep]) && tscUntouchedLocal(tscOut.get(c) ?? "", g.root, keep, [...keep], await tscOnBase(ctx, g.cwd, signal, co))) pre.push(c.name); }
    if (ESLINT_CONFIGS.some((f) => existsSync(join(g.cwd, f)))) { const c = await runCheck(ctx, `lint:eslint${sfx}`, "npx", ["--no-install", "eslint", ...g.rel], signal, checks, { ...co, kind: "static" }); if (await excuseLint(ctx, signal, c, "eslint", "npx", ["--no-install", "eslint"], g.cwd, g.rel, co)) pre.push(c.name); }
  }
  return pre;
}
export const verifyStage: Stage = {
  name: "verify",
  targetS: STAGE_BUDGETS.verify.targetS,
  limitS: STAGE_BUDGETS.verify.limitS,
  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
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
    const tests = failedFirst(dedupeTests([...wallTests, ...relevant, ...changedTestFiles, ...changedSymbolsFirst(ctx, impacted, changed), ...dep.tests]),(ctx.outputs().verify as { checks?: Array<{ name?: unknown; result?: unknown }> } | undefined)?.checks); // TEN-SPEED-07; the Wall and task-named tests that prove the task run first, so a stage stopped at its limit has already run them
    const hashes = fileHashes(ctx.repoDir, changed), qs = quickScope(ctx.outputs(), hashes), keep = new Set([...(qs?.blocking ?? []), ...[...wallTests, ...relevant].map(testCheckName)]);
    const sinceTests = qs ? [...ctx.tests.impacted(map, qs.since), ...map.tests.filter((t) => qs.since.includes(t.path))] : [], split = qs ? quickSplit(tests, keep, sinceTests) : { first: tests, rest: [] };
    // The evidence so far, published after every check: a verify stopped at its limit or the cap keeps the checks that ran (machine.ts), never "no tests executed". wall_passed follows the final rule below: false on any failure, true only when every Wall and holdout check ran and passed.
    const done: VerifyCheck[] = [], wallNames0 = new Set(wallTests.map(testCheckName)), targets0 = new Set([...wallTests, ...relevant].map(testCheckName)), wallDropped0 = [...wallPaths].filter((p) => !wallTests.some((t) => t.path === p));
    let holdN: number | null = wall.holdout_dir ? null : 0; // held-out Wall checks to run; null until they are staged
    const publish = (): void => {
      if (!ctx.partial) return;
      const ran = checks.length ? checks : done, w = ran.filter((c) => wallNames0.has(c.name) || isHold(c)), allRan = holdN !== null && ran.filter(isHold).length >= holdN && wallTests.every((t) => ran.some((c) => c.name === testCheckName(t)));
      const wp = w.some((c) => c.result === "fail") ? false : w.length > 0 && allRan && wallDropped0.length === 0 && w.every((c) => c.result === "pass") ? true : undefined;
      ctx.partial("verify", { checks: ran.map((c) => (isHold(c) ? pubHold(c) : c)), flaky: ran.filter((c) => c.result === "flaky").map((c) => (isHold(c) ? "holdout" : c.name)), ...(wp === undefined ? {} : { wall_passed: wp }), changed_files: changed, not_proven: wallDropped0.map((p) => `Wall test not executed: ${p}: ${NO_RUNNER_REASON}`), target_checks: ran.filter((c) => c.result === "pass" && (targets0.has(c.name) || isHold(c))).map((c) => (isHold(c) ? "holdout" : c.name)), risk });
    };
    const scopedOut = scopedOutOf(map); // FC-22: audit trail for package-scoped selection (LOKI_E10_SCOPE=1)
    if (scopedOut.length) ctx.emit("test.scoped_out", "verify", { tests: scopedOut });
    // TEN-SPEED-18: LOKI_E10_VERIFY_JOBS bounds concurrent test processes; mapPool keeps the selected (failed-first) order whatever order they finish in
    // L027: within each list, Wall tests and non-vitest tests run alone and first; then the task-named vitest files batched per package, then the other
    // vitest files batched per package (a stage stopped at its limit has run the Wall and task-named tests); a file a batch does not vouch for runs alone last.
    const batchable = (t: TestRef): boolean => verifyBatchOn() && t.runner === "vitest" && !wallNames0.has(testCheckName(t));
    const runTests = async (list: TestRef[]): Promise<void> => {
      const byName = new Map<string, VerifyCheck[]>();
      const alone = async (l: TestRef[]): Promise<void> => { (await mapPool(l, verifyJobs(), async (t) => { const tc = commandFor(t, ctx.repoDir, api), slot: VerifyCheck[] = []; await runCheck(ctx, testCheckName(t), tc.cmd, tc.args, signal, slot, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), protect: [...wallTests, ...relevant].includes(t), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) }); done.push(...slot); publish(); return slot; }, () => signal.aborted)).forEach((sl, i) => { if (sl) byName.set(testCheckName(l[i]!), sl); }); };
      const goPart = (t: TestRef): boolean => goBatchable(t, targets0, changed); // Wall, task-named and edited go test files keep their own per-file run (the fail-then-pass proof); only untouched files batch
      await alone(list.filter((t) => !batchable(t) && !goPart(t)));
      const goB = await runGoBatches(ctx, list.filter(goPart), api, signal, (c) => { done.push(c); publish(); });
      for (const [n, c] of goB) byName.set(n, [c]);
      await alone(list.filter((t) => goPart(t) && !goB.has(testCheckName(t))));
      for (const part of [list.filter((t) => batchable(t) && targets0.has(testCheckName(t))), list.filter((t) => batchable(t) && !targets0.has(testCheckName(t)))]) {
        for (const [n, c] of await runVitestBatches(ctx, part, api, signal, (c) => { done.push(c); publish(); })) byName.set(n, [c]);
      }
      await alone(list.filter((t) => batchable(t) && !byName.has(testCheckName(t))));
      checks.push(...list.flatMap((t) => byName.get(testCheckName(t)) ?? [])); // the selected order, whichever way each check ran
    };
    await runTests(split.first);
    const decisive = qs !== null && checks.some((c) => c.result === "fail" && (keep.has(c.name) || changed.includes(c.name.slice(c.name.indexOf(":") + 1)))); // a blocking, Wall, task-named or touched test is never excused as pre-existing red
    if (!decisive) await runTests(split.rest);
    const complete = !decisive; // L025: the full suite and the secret scan run in every complete verify, never in a quick one
    const pg = ((ctx.outputs().verify?.failures_grouped ?? []) as { signature: string }[]).map((g) => g.signature), fs = (x: string): boolean => x.startsWith("full suite") || x.startsWith("lint:"), failSigs = (l: { name: string; result: string; first_error?: string; ids?: string[] }[]): string[] => [...new Set(l.filter((c) => c.result === "fail" && !fs(c.name) && !isHoldoutCheck(c.name)).map((c) => failureSignature(c)))].sort(), same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
    const settle = decisive && pg.some((x) => x.startsWith("full suite")) && same(failSigs((ctx.outputs().verify?.checks ?? []) as { name: string; result: string; first_error?: string; ids?: string[] }[]), failSigs(checks.filter((c) => !isHold(c)))); /* compared on every failing check of the last verify, not only those it fed to the fix round: a base-red check excused then still fails now, and must not keep the full suite from rerunning (FireLater#21: a dynamic-import test the change broke was lost from the final verify) */ // L025: the same targeted failures as last time decide a stall only once the suite is known: rerun it (no model session) rather than carry it
    const hold = wall.holdout_dir ? stageHoldout(wall.holdout_dir, ctx.repoDir) : null; if (hold && !hold.missing.length) holdN = hold.tests.length; // P12-05: held-out Wall tests, copied in under neutral names for this run only, blocking (protect), named holdout:N internally and "holdout" in every record that leaves this stage
    try { for (const [i, h] of (hold?.tests ?? []).entries()) { if (signal.aborted) break; const t = h as TestRef, tc = commandFor(t, ctx.repoDir, api); await runCheck(ctx, `holdout:${i + 1}`, tc.cmd, tc.args, signal, checks, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), protect: true, opaque: true, ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) }); publish(); } } finally { hold?.cleanup(); }
    if (hold?.missing.length) { for (const m of hold.missing) recordHoldoutTriage(ctx.runDir, { check: "holdout:store", result: "not_run", reason: m }); const k: VerifyCheck = { name: "holdout:store", cmd: "holdout", result: "not_run", duration_s: 0, reason: "holdout store unavailable", owner: "harness" }; checks.push(k); ctx.emit("test.result", "verify", { ...pubHold(k) }); } // C-C4b-c: a store failure is a harness/infrastructure failure (not_run, no fix round), never a test failure the fixer sees; the missing-file text stays out of the log
    const targetNames = new Set([...[...wallTests, ...relevant].map(testCheckName), ...checks.filter(isHold).map((c) => c.name)]); // FC-21b: Wall and task-named tests, the proof a limit-stopped run needs
    const cfgChanged = [...new Set([...testConfigChanged(ctx.repoDir, ctx.baseSha, changed), ...hiddenConfigChanged(ctx.repoDir, ctx.outputs().intake?.hidden_cfg)])]; // FC-21b: also feeds uncovered_changed; SEAL-CONFTEST-01: ignored configs added or changed since intake count too
    // FireLater#21: a relevant test that is not the task's own (collateral: it only imports or mocks a named file) gets the base comparison any untouched test gets (known red, same error).
    const collateral = new Set(collateralTests(relevant, named).map(testCheckName)), ownRel = new Set([...relevant.map(testCheckName)].filter((n) => !collateral.has(n)));
    const preRed = await subtractBase(ctx, api, checks, tests, changed, new Set(wallTests.map(testCheckName)), new Set(relevant.map(testCheckName)), signal, cfgChanged.length === 0, zeroGate((ctx.outputs().intake as { zero_baseline?: unknown } | undefined)?.zero_baseline), depNames, ownRel);
    // A collateral check red on base failing the same way feeds the first fix round (it could be the bug the task describes); after a fix round left it failing
    // the same way it is pre-existing: not blocking, and named with COLLATERAL_RED, which caps VERIFIED.
    const fixRounds = Number((ctx.outputs().fix as { round?: unknown } | undefined)?.round ?? 0) || 0, collateralSame = preRed.sameError.filter((n) => collateral.has(n) && !preRed.names.includes(n));
    const collateralRed = fixRounds >= 1 ? collateralSame : [];
    if (collateralRed.length) { preRed.names.push(...collateralRed); preRed.ids.push(...checks.filter((c) => collateralRed.includes(c.name)).flatMap((c) => c.ids ?? [])); }
    // REPOMEM: a failing, untouched, non-target test whose every id was already red in the intake baseline (same base commit) is pre-existing: never blocks. Anything else that fails is introduced and always blocks.
    // A package's own suite baseline is consulted only for a check the base run showed failing the same way (sameErrors): matching ids alone never excuse a changed error.
    const suiteOf = (name: string): string | undefined => { const t = tests.find((x) => testCheckName(x) === name), pkg = t ? api?.packageOf(t.path) : null; return pkg?.commands.test ? `full suite: ${pkg.name}` : undefined; };
    const attr = attribute(ctx.repoDir, ctx.baseSha, checks.filter((c) => c.result === "fail" && !preRed.names.includes(c.name)).map((c) => ({ name: c.name, ids: c.ids, eligible: !targetNames.has(c.name) && !changed.includes(c.name.slice(c.name.indexOf(":") + 1)), ...(suiteOf(c.name) && preRed.sameError.includes(c.name) ? { suite: suiteOf(c.name)! } : {}) })));
    attr.introducedChecks = [...new Set(attr.introducedChecks.map((n) => (isHoldoutCheck(n) ? "holdout" : n)))]; preRed.names.push(...attr.preExistingChecks); preRed.ids.push(...attr.preExistingIds);
    if (!signal.aborted) {
      // Lint/typecheck of changed files only (ENGINE.md section 4's named tool per language).
      const lintPre = await runLintChecks(ctx, complete || [...(qs?.blocking ?? [])].some((n) => n.startsWith("lint:")) ? changed : changed.filter((f) => qs?.since.includes(f)), signal, checks, { api, wall: wallPaths, keep: new Set([...changed, ...named]) }); // L025: a quick verify lints only what changed since, unless a lint check blocked last time
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
    const notExcused: string[] = []; const fullNotProven = new Set<string>(); // no-runner entries are dropped at not_proven: nothing ran, and the risk record keeps the full test command deferred
    const ranDeeper: string[] = []; // selected deeper checks verify executed (pass or fail); markExecuted rebuilds the deferred list from all of them
    if (risk && risk.tier !== "low" && !signal.aborted && (complete || settle)) { // RISKTIER: medium and high run the detected full test command (deep.ts runner table); the reviewer and council stay recorded as not run
      const { runFullSuite } = await import("./deep.ts"); // lazy: deep.ts imports this module
      const full: Parameters<typeof runFullSuite>[3] = [];
      await runFullSuite(ctx, signal, { changed, targetPassed: checks.some((c) => targetNames.has(c.name) && c.result === "pass" && hasExecutedProof([c])), wallBaseRed: wallRedOnBaseOf(ctx.outputs().wall?.base_run), proofFiles: wallProofOf(checks, [...wallTests.map((t) => ({ name: testCheckName(t), path: t.path })), ...(hold?.tests ?? []).map((h, i) => ({ name: `holdout:${i + 1}`, path: (h as TestRef).path }))]) }, full, fullNotProven);
      for (const c of full) { const k: VerifyCheck = { name: c.name, cmd: c.cmd, result: c.result as VerifyCheck["result"], duration_s: c.duration_s, ...(c.reason ? { reason: c.reason } : {}), ...(c.count ? { count: c.count } : {}), ...(c.result === "fail" ? { ...(c.ids ? { ids: c.ids } : {}), ...(c.first_error ? { first_error: c.first_error } : {}) } : {}) }; suites.add(k); checks.push(k); ctx.emit("test.result", "verify", { ...k }); if (c.excerpt) excerpts.set(k, c.excerpt); } // P12-01: full-suite checks leave the same test.result evidence per-file checks do
      const fa = attributeFullSuite(ctx.repoDir, ctx.baseSha, full, checks.filter((c) => c.result === "fail" && !suites.has(c) && !preRed.names.includes(c.name)).flatMap((c) => c.ids ?? []), changed); preRed.names.push(...fa.preExistingChecks); preRed.ids.push(...fa.preExistingIds); attr.introducedChecks.push(...fa.introducedChecks); attr.line = [attr.line, fa.line].filter(Boolean).join("; ") || null; notExcused.push(...whyFullSuiteNotExcused(ctx.repoDir, ctx.baseSha, full, changed, fa.preExistingChecks)); // REPOMEM: same attribution for the full suite
      if (full.some((c) => c.result === "pass" || c.result === "fail")) { ranDeeper.push("full test command", "full suite"); risk = markExecuted(risk, ranDeeper); recordRisk(ctx.repoDir, risk); }
      // A full-suite failure whose every failing id is one a same-error base-red check or a Wall check already reports adds nothing a fix round could act on.
      const known = new Set(checks.filter((c) => c.result === "fail" && (preRed.sameError.includes(c.name) || wallNames0.has(c.name))).flatMap((c) => c.ids ?? []));
      for (const c of full) if (c.result === "fail" && c.ids?.length && !c.unhandled?.length /* an Unhandled Errors block names no id, so ids alone never cover it */ && comparableIds(c.ids).every((i) => known.has(i)) && !preRed.names.includes(c.name)) { preRed.knownRed.push(c.name); preRed.sameError.push(c.name); }
    }
    if (risk && risk.tier === "high" && !signal.aborted && complete) { // PR-FIRST-4: the high tier's security scan runs here, before seal, so a receipt never leaves it to the post-PR deep stage (spawned only after VERIFIED). A fail blocks VERIFIED, a not_run (scanner missing or broken) caps at PARTIAL; only a pass or fail is credited
      const { runSecretScan } = await import("./deep.ts");
      const sec: Parameters<typeof runSecretScan>[3] = [];
      await runSecretScan(ctx, changed, { scanAddedSince: ctx.baseSha }, sec, fullNotProven); // added lines only: a match already on base (FireLater config/index.ts) never fails the run
      for (const c of sec) { const k: VerifyCheck = { name: c.name, cmd: c.cmd, result: c.result as VerifyCheck["result"], duration_s: c.duration_s, ...(c.reason ? { reason: c.reason } : {}) }; checks.push(k); ctx.emit("test.result", "verify", { ...k }); }
      if (sec.some((c) => c.result === "pass" || c.result === "fail")) { ranDeeper.push(SECURITY_SCAN); risk = markExecuted(risk, ranDeeper); recordRisk(ctx.repoDir, risk); }
    }
    const covered = (f: string): boolean => ctx.tests.impacted(map, [f]).some((t) => checks.some((c) => c.name === testCheckName(t) && hasExecutedProof([c])));
    const uncoveredChanged = changed.filter((f) => CODE_EXT.test(f) && !isTestFile(f) && !wallPaths.has(f) && !cfgChanged.includes(f) && !covered(f)); // FC-21b: changed code no passing impacted check ran; seal denies VERIFIED after a limit
    const flaky = checks.filter((c) => c.result === "flaky").map((c) => (isHold(c) ? "holdout" : c.name));
    // ponytail: real clustering is failures.ts, which depends on this stage; a naive 1:1 placeholder keeps the section-4 output key populated until that slice lands.
    const { groups: failuresGrouped, names: blockingNames } = briefGroups(checks.filter((c) => feedsFixRound(c, preRed) || (fixRounds === 0 && collateralSame.includes(c.name))), (c) => excerpts.get(c) ?? "", (c) => suites.has(c), EXCERPT_TOTAL_CAP, qs && !complete ? { prev: ctx.outputs().verify, ran: new Set(checks.map((c) => c.name)) } : undefined); // known red failing the same way as on base (or a full suite repeating those and Wall ids) never feeds a fix round; a different error does; TEN-QUALITY-01: sample = rerun cmd + redacted excerpt, 6 KB across all groups
    const pub = checks.map((c) => (isHold(c) ? pubHold(c) : c)), holdoutFailed = checks.filter((c) => c.result === "fail" && isHold(c) && !preRed.names.includes(c.name)).length; // C-C4b-c: pub leaves this stage, holdoutFailed (C-C4b) is the only form in which a held-out failure reaches the fix stage
    // E-98a/E-115: a check that ran (not_run has its own NOT PROVEN entry at seal) on a system interpreter/ruff. A-115: test configuration edits and relevant checks with more skips than base are listed, which makes the verdict PARTIAL at seal.
    const inBase = (f: string): boolean => { try { safeGit(ctx.repoDir, ["cat-file", "-e", `${ctx.baseSha}:${f}`], { stdio: "ignore" }); return true; } catch { return false; } };
    const testCounts: Record<string, unknown> = {}; const modifiedRel = relevant.filter((t) => changed.includes(t.path) && inBase(t.path)).flatMap((t) => { const k = preRed.cnt[testCheckName(t)]; if (k) testCounts[t.path] = k; return [...(testFileWeakened(ctx.repoDir, ctx.baseSha, null, t.path, "M") ? [`weakened test: ${t.path}`] : []), ...(assertDeltaNotes(ctx.repoDir, ctx.baseSha, null, t.path, intake?.task ?? "", k?.b, k?.h) ?? [])]; }); // a relevant test file edited: listed as weakened only when it loses an assertion or case or gains a skip (EXP-0001: an added case is kept); a changed assertion value is always listed
    const weakened = [...modifiedRel, ...cfgChanged.map((f) => `test configuration changed: ${f}`), ...preRed.weak.map((n) => `skipped or fewer tests than base: ${n}`), ...collateralRed.map((n) => `${COLLATERAL_RED}: ${n}`)];
    const depsNotes = unusedInstallNotes(intake?.deps_not_proven ?? [], api, changed, checks.map((c) => c.name), ctx.repoDir); // an install failure no check or changed file depends on is disclosed (n/a), never a cap
    const notProven = [...(complete ? [] : [QUICK_ONLY_NOTE]), ...weakened, ...hiddenEdits(ctx.repoDir), ...ignoreRuleChanges(ctx.repoDir, (intake as { ignore_snapshot?: unknown } | undefined)?.ignore_snapshot, ctx.baseSha), ...dependentNotes(dep), ...depsNotes.cap, ...pub.filter((c) => c.name === "holdout" && c.result !== "pass").map((c) => (c.result === "not_run" ? "holdout not executed" : "holdout check failed")), ...[...fullNotProven].filter((n) => !naNote(n)), ...pub.filter((c) => c.owner === "harness" && c.name !== "holdout").map((c) => `${c.reason} (${c.name}; harness-owned, no fix rounds)`), ...new Set(checks.filter((c) => c.interpreter === "system" && c.result !== "not_run").map((c) => (c.name.startsWith("lint:") ? "lint ran on the system ruff" : "tests ran on the system interpreter")))];
    const wallDropped = [...wallPaths].filter((p) => !wallTests.some((t) => t.path === p)); // FC-WALL-FILE-WITHOUT-RUNNER-SILENTLY-DROPPED: sealed, but no runner of this repo can run it
    notProven.push(...wallDropped.map((p) => `Wall test not executed: ${p}: ${NO_RUNNER_REASON}`));
    const wallNames = new Set(wallTests.map(testCheckName)), wallRun = checks.filter((c) => wallNames.has(c.name) || isHold(c)), wallFailTail = writeWallFailureTail(ctx.runDir, checks.filter((c) => wallNames.has(c.name) && c.result === "fail" && !isHold(c) && !preRed.names.includes(c.name)).map((c) => ({ name: c.name, out: failTails.get(c) ?? "" }))), wallPassed = wallRun.some((c) => c.result === "fail") ? false : wallRun.length > 0 && wallDropped.length === 0 && wallRun.every((c) => c.result === "pass") ? true : undefined; // the receipt's wall.passed: false on any failure, true only when every Wall and holdout check ran and passed, unset otherwise
    return { status: "completed", data: { checks: pub, flaky, verify_scope: complete ? "complete" : "quick", file_hashes: hashes, blocking_checks: blockingNames, ...(wallFailTail ? { wall_failure_tail: wallFailTail } : {}), ...(wallPassed === undefined ? {} : { wall_passed: wallPassed }), failures_grouped: [...failuresGrouped, ...nrdGroupsFor(ctx.outputs().implement, fixRounds)], holdout_failed: holdoutFailed, changed_files: changed, ...(depNames.size ? { dependent_checks: [...depNames] } : {}), not_proven: notProven, ...(fullNotProven.size || depsNotes.na.length ? { not_applicable: [...[...fullNotProven].filter(naNote).map(naText), ...depsNotes.na] } : {}), pre_red: preRed.ids, pre_red_checks: preRed.names, ...(notExcused.length ? { not_excused: notExcused } : {}), ...(preRed.knownRed.length ? { known_red_checks: preRed.knownRed } : {}), ...(preRed.sameError.length ? { known_red_same_error: preRed.sameError } : {}), skipped_on_base: preRed.zero, ...(collateralSame.length && fixRounds === 0 ? { collateral_same_error: collateralSame } : {}), ...(attr.line ? { baseline_line: attr.line, introduced_checks: attr.introducedChecks } : {}), test_counts: testCounts, uncovered_changed: uncoveredChanged, target_checks: checks.filter((c) => c.result === "pass" && targetNames.has(c.name)).map((c) => (isHold(c) ? "holdout" : c.name)), risk } };
  },
};
export const stage = verifyStage;
