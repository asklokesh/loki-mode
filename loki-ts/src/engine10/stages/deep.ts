// loki-ts/src/engine10/stages/deep.ts -- E-23 Deep verify (ENGINE.md section 4). Runs after Seal + PR: full suite, app-boot probe, secret scan; reports via engine10-push.sh (comment + addendum + status). A refused or unavailable check is NOT PROVEN, never red; only a failing full suite (minus failures already red on base) or a secret match is failure. Rule of Two: assertWorkerEnv asserts no real GitHub token, since the deep worker runs repo code. L003: no model session here; the run's one review is seal's pre-seal xreview, whose verdict and cost reach the receipt.
import { installOwned } from "../../project_model/install.ts";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appProbe, type AppProbeResult } from "../../util/app_probe.ts";
import { secureScanChanged } from "../../util/secure_scan.ts";
import { postDeepResults } from "../../util/receipt_surface.ts";
import { run } from "../../util/shell.ts";
import { harnessLoadReason } from "../../runner/load_owner.ts";
import { assertWorkerEnv } from "../worker.ts";
import { canonicalJson, sha256, signReceipt } from "./seal.ts";
import { changedFiles } from "./verify.ts";
import { NA_PREFIX, naNote, naText, runPackageSuites, suiteEnv } from "../../project_model/package_suite.ts";
import { classifyCheck, corroboratePass, failureExcerpt, fullSuiteCmd, goRunner, NO_TESTS_REASON, stripAnsi } from "../../util/check_result.ts"; import { failIds } from "../failures.ts"; import { attributeFullSuite, suiteEmptyOnBase } from "../../runner/repo_profile.ts";
import { DEEP_CAP_S, type ReceiptCheck, type RunContext, type RunnerName, type SessionRunner, type Stage, type StageResult, STAGE_BUDGETS } from "../types.ts";
import { safeGitRun } from "../../util/safe_git.ts"; import { REPO_ROOT } from "../../util/paths.ts";
import { DEFAULT_PUSH_SH, SHA_RE } from "./pr.ts";
/** RunContext plus the value this stage needs that E-03 will eventually  inject (same local-extension pattern pr.ts's PrContext already uses). */
export type DeepContext = RunContext & {
  pinnedOrigin?: string;
};
/** ReceiptCheck (types.ts) plus a `reason` field the contract does not carry,  the same disclosed-extra-field pattern testmap.ts's EngineTestMap and  verify.ts's VerifyCheck already use. */
export interface DeepCheck extends ReceiptCheck {
  reason?: string; ids?: string[]; excerpt?: string; base_red?: boolean; // base_red: a full-suite fail whose every failing id already failed on base (repo-profile suites), never a red status; excerpt: redacted failure text for the fix brief; ids: failing test ids of the real run (failIds), read by verify's baseline attribution
}
export interface DeepOptions {
  pushScriptPath?: string;
  secretScanShPath?: string;
  appProbe?: (repoDir: string, lokiDir: string) => Promise<AppProbeResult>; // TEN-GATES-06: defaults to util/app_probe.ts appProbe (boots via app-runner.sh, always stops)
  secureScanPath?: string; // secure-scan.py override, tests only
  changed?: string[]; proofFiles?: string[]; wallBaseRed?: boolean; targetPassed?: boolean; /* a Wall or task-named check already passed with n>0 */ // FC-SEAL-NA-AS-UNPROVEN: the diff and the Wall verdict decide whether a package without tests is N/A
  scanAddedSince?: string; // PR-FIRST-4 (verify only): scan just the lines added since this commit, and the path of a file new since it, so a match already on base never fails the run
  fullSuiteTimeoutMs?: number;
  path?: string; // PATH override, tests only, so "missing tool" never depends on the host
  env?: NodeJS.ProcessEnv; // for assertWorkerEnv; defaults to process.env
  pushExtraEnv?: Record<string, string>; // merged into the push child's env, tests only (e.g. a stub's own log path)
}
export const DEFAULT_SECRET_SCAN_SH = join(REPO_ROOT, "autonomy/lib/secret-scan.sh"); // HONEST-VERIFIED: a fixed depth from import.meta.url pointed outside the package in the dist bundle, so the security scan never ran there (NOT PROVEN on every high-risk run)
const FULL_SUITE_TIMEOUT_MS = 300_000; // 5 min per runner; deep's own stage limit (2700s) is the outer bound
/** One check per detected runner, run to completion (no retry: flaky-rerun  is a fast-verify concept, ENGINE.md never asks for it in deep verify). */
export async function runFullSuite(ctx: RunContext, signal: AbortSignal, opts: DeepOptions, checks: DeepCheck[], notProven: Set<string>): Promise<void> {
  if (await runPackageSuites(ctx.repoDir, signal, { path: opts.path, timeoutMs: opts.fullSuiteTimeoutMs ?? FULL_SUITE_TIMEOUT_MS, baseSha: ctx.baseSha, skip: installOwned(ctx.repoDir, ctx.outputs().intake?.install_created), changed: opts.changed, proofFiles: opts.proofFiles, wallBaseRed: opts.wallBaseRed, targetPassed: opts.targetPassed }, checks, notProven)) return;
  const map = await ctx.tests.detect(ctx.repoDir);
  if (map.runners.length === 0) {
    notProven.add("full suite (no test runner detected)");
    return;
  }
  for (const runner of map.runners) {
    const spec = fullSuiteCmd(runner, ctx.repoDir);
    const name = `full suite: ${runner}`;
    if (!Bun.which(spec.cmd, opts.path ? { PATH: opts.path } : undefined)) {
      checks.push({ name, cmd: [spec.cmd, ...spec.args].join(" "), result: "not_run", duration_s: 0 });
      notProven.add(`not run: ${name}`);
      continue;
    }
    const started = Date.now();
    const r = await run([spec.cmd, ...spec.args], {
      cwd: ctx.repoDir,
      timeoutMs: opts.fullSuiteTimeoutMs ?? FULL_SUITE_TIMEOUT_MS,
      env: suiteEnv(opts.path),
    });
    const durationS = (Date.now() - started) / 1000;
    if (signal.aborted) {
      checks.push({ name, cmd: [spec.cmd, ...spec.args].join(" "), result: "not_run", duration_s: durationS });
      notProven.add(`not run: ${name} (aborted)`);
      continue;
    }
    const out = stripAnsi(`${r.stdout}\n${r.stderr}`), lr = r.exitCode === 0 ? undefined : await harnessLoadReason({ repoDir: ctx.repoDir, baseSha: ctx.baseSha, skip: installOwned(ctx.repoDir, ctx.outputs().intake?.install_created), out, cmd: spec.cmd, args: spec.args, signal, ...(opts.path ? { env: { PATH: opts.path } } : {}) });
    if (lr) { checks.push({ name, cmd: [spec.cmd, ...spec.args].join(" "), result: "not_run", duration_s: durationS }); notProven.add(`${lr} (${name}; harness-owned)`); continue; } // FC-02: harness-owned, never a code failure
    const cls = await corroboratePass(classifyCheck({ kind: "test", ok: r.exitCode === 0, out, ...goRunner(spec.cmd, spec.args) }), out, spec.cmd, spec.args, { cwd: ctx.repoDir, env: suiteEnv(opts.path), signal });
    if (cls.result === "not_run" && r.exitCode === 0 && opts.targetPassed === true && suiteEmptyOnBase(ctx.repoDir, ctx.baseSha, [spec.cmd, ...spec.args].join(" "), [spec.cmd, ...spec.args].join(" "), cls, out)) { notProven.add(`${NA_PREFIX}${name} (ran 0 tests on base and head; the Wall or a task-named check passed with executed tests)`); continue; } // a full suite that discovers nothing is a disclosed note, not a gate, once a target check proved the change
    checks.push({ name, cmd: [spec.cmd, ...spec.args].join(" "), result: cls.result, duration_s: durationS, ...(cls.result === "fail" ? { ids: failIds(out), excerpt: failureExcerpt(out, ctx.repoDir) } : {}) }); // FC-16: exit 0 with no executed tests is not a pass
    if (cls.result === "not_run") notProven.add(`not run: ${name} (${cls.reason ?? NO_TESTS_REASON})`);
  }
}
/** ENGINE.md section 4 app boot: util/app_probe.ts boots via autonomy/app-runner.sh, probes health and always stops the PID it  recorded. Its checks land as-is; a not_run (no app, missing runtime, throw) is NOT PROVEN, never fail and never pass. */
async function runAppBoot(ctx: RunContext, opts: DeepOptions, checks: DeepCheck[], notProven: Set<string>): Promise<void> {
  let r: AppProbeResult;
  try { r = await (opts.appProbe ?? appProbe)(ctx.repoDir, join(ctx.repoDir, ".loki")); } catch (err) { r = { checks: [{ name: "app boot", cmd: "autonomy/app-runner.sh", result: "not_run", duration_s: 0, reason: `app probe threw: ${(err as Error).message}` }], pid: null, url: null }; }
  if (!r.checks.some((c) => c.name === "app boot")) notProven.add("not run: app boot (app probe reported no result)");
  for (const c of r.checks) { if (c.result === "n/a") { notProven.add(`${NA_PREFIX}${c.name} (${c.reason ?? "not applicable"})`); continue; } checks.push(c as DeepCheck); if (c.result === "not_run") notProven.add(`not run: ${c.name} (${c.reason ?? "no reason given"})`); }
}
/** One "security scan" check over the changed files: secret-scan.sh's two matchers (sourced, never edited) plus secure-scan.py.  A secret hit or a HIGH secure-scan finding is fail; else a missing or broken scanner is not_run (NOT PROVEN), never pass. */
export async function runSecretScan(ctx: RunContext, changed: string[], opts: DeepOptions, checks: DeepCheck[], notProven: Set<string>): Promise<void> {
  const scriptPath = opts.secretScanShPath ?? DEFAULT_SECRET_SCAN_SH, name = "security scan", cmd = "secret-scan.sh + secure-scan.py";
  if (!existsSync(scriptPath)) { checks.push({ name, cmd, result: "not_run", duration_s: 0 }); notProven.add(`not run: ${name} (secret-scan.sh not found)`); return; }
  if (changed.length === 0) { checks.push({ name, cmd, result: "pass", duration_s: 0 }); return; }
  const inline = 'script="$1"; mode="$2"; shift 2; . "$script" || exit 3; hit=0; for f in "$@"; do if { [ "$mode" != path ] && _commit_scan_secret_file "$f"; } || { [ "$mode" != content ] && _commit_path_looks_secret "$f"; }; then printf "%s\\n" "$f"; hit=1; fi; done; exit "$hit"';
  // Every scan runs on repo-relative names (from repoDir, or from the added-lines copy), so a parent directory such as
  // /home/u/credential-service/ never reaches the path heuristic.  A killed scan (null exit) is -1, never a clean 0 or 1.
  const started = Date.now(), gaps: string[] = [], reasons: string[] = [], outs: { code: number; hits: string[] }[] = [];
  const scan = async (mode: string, cwd: string, files: string[]): Promise<void> => {
    if (!files.length) return;
    const s = await run(["bash", "-c", inline, "_", scriptPath, mode, ...files], { cwd, timeoutMs: 30_000 });
    outs.push({ code: s.exitCode ?? -1, hits: s.stdout.split("\n").map((l) => l.trim()).filter(Boolean) });
  };
  let sec: Awaited<ReturnType<typeof secureScanChanged>>;
  if (opts.scanAddedSince) {
    const base = opts.scanAddedSince, root = mkdtempSync(join(tmpdir(), "loki-verify-secscan-")), fresh: string[] = [], copied: string[] = [], unread: string[] = [];
    try {
      for (const f of changed) {
        if (!existsSync(join(ctx.repoDir, f))) continue; // deleted: nothing added
        const atBase = (await safeGitRun(ctx.repoDir, ["cat-file", "-e", `${base}:${f}`], { timeoutMs: 10_000 })).exitCode === 0;
        let added: string | null = null;
        if (atBase) {
          // --text: a modified binary shows its added bytes, never a bare "Binary files differ" that reads as nothing added.
          const d = await safeGitRun(ctx.repoDir, ["diff", "--no-color", "--text", "--no-renames", "-U0", base, "--", f], { timeoutMs: 20_000 });
          if (d.exitCode !== 0) { unread.push(f); continue; } // a failed or killed diff is unread, never an empty (clean) file
          added = d.stdout.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
          if (!added) continue; // nothing added to this file
        } else fresh.push(f);
        mkdirSync(dirname(join(root, f)), { recursive: true });
        if (added === null) copyFileSync(join(ctx.repoDir, f), join(root, f)); else writeFileSync(join(root, f), added + "\n");
        copied.push(f);
      }
      if (unread.length > 0) gaps.push(`added lines could not be read: ${unread.join(", ")}`);
      await scan("content", root, copied);
      await scan("path", ctx.repoDir, fresh);
      sec = await secureScanChanged(root, copied, opts.secureScanPath);
    } finally { rmSync(root, { recursive: true, force: true }); }
  } else {
    await scan("both", ctx.repoDir, changed);
    sec = await secureScanChanged(ctx.repoDir, changed, opts.secureScanPath);
  }
  // A hit printed before a scan died is still a hit; any exit outside 0 / 1-with-hits / 3 means the scan did not finish.
  const hits = [...new Set(outs.filter((o) => o.code !== 3).flatMap((o) => o.hits))], high = sec.findings.filter((f) => String(f.severity).toUpperCase() === "HIGH");
  if (outs.some((o) => o.code === 3)) gaps.push("secret-scan.sh failed to load");
  for (const o of outs) if (o.code !== 0 && o.code !== 3 && !(o.code === 1 && o.hits.length > 0)) gaps.push(`secret scan did not finish (exit ${o.code})`);
  if (!sec.ok) gaps.push(sec.error ?? "secure-scan failed");
  if (hits.length > 0) reasons.push(`secret match: ${hits.join(", ")}`);
  if (high.length > 0) reasons.push(`secure-scan: ${high.map((f) => `${f.rule}: ${f.file}:${f.line}`).join(", ")}`);
  const result = reasons.length > 0 ? "fail" : gaps.length > 0 ? "not_run" : "pass";
  checks.push({ name, cmd, result, duration_s: (Date.now() - started) / 1000, ...(result === "pass" ? {} : { reason: (result === "fail" ? reasons : gaps).join("; ") }) });
  if (result === "not_run") notProven.add(`not run: ${name} (${gaps.join("; ")})`);
}
export async function runDeep(ctx: DeepContext, signal: AbortSignal, opts: DeepOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before deep verify started" };
  try { assertWorkerEnv(opts.env ?? process.env); } catch (err) { return { status: "failed", data: {}, reason: (err as Error).message }; }
  let changed: string[];
  try { changed = changedFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created)); } catch (err) { return { status: "failed", data: {}, reason: `git diff against base failed: ${(err as Error).message}` }; }
  const checks: DeepCheck[] = [];
  const notProven = new Set<string>();
  await runFullSuite(ctx, signal, { ...opts, changed }, checks, notProven);
  const fa = attributeFullSuite(ctx.repoDir, ctx.baseSha, checks, [], changed); // L003: the same base attribution verify uses, so a suite already red on base never marks the PR red
  for (const c of checks) if (fa.preExistingChecks.includes(c.name)) Object.assign(c, { base_red: true, reason: `every failing test id already failed on base ${ctx.baseSha.slice(0, 12)}` });
  await runAppBoot(ctx, opts, checks, notProven);
  await runSecretScan(ctx, changed, opts, checks, notProven);
  const statusState: "success" | "failure" = checks.some((c) => c.result === "fail" && !c.base_red) ? "failure" : "success";
  const notProvenList = [...notProven].filter((n) => !naNote(n)), notApplicable = [...notProven].filter(naNote).map(naText);
  const seal = ctx.outputs().seal as { receipt_sha256?: string } | undefined;
  const addendumBody = {
    schema: "loki.v10.receipt-addendum/1" as const,
    run_id: ctx.runId,
    base_receipt_sha256: seal?.receipt_sha256 ?? null,
    checks,
    not_proven: notProvenList, ...(notApplicable.length ? { not_applicable: notApplicable } : {}),
    status_state: statusState,
  };
  const addendumSha256 = sha256(canonicalJson(addendumBody));
  const sig = signReceipt(`${ctx.runId}-deep`, addendumSha256);
  const addendum = { ...addendumBody, addendum_sha256: addendumSha256, verification: { jwt: sig.jwt, kid: sig.kid } };
  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(join(ctx.runDir, "receipt-addendum-1.json"), JSON.stringify(addendum, null, 2) + "\n");
  const headSha = (await safeGitRun(ctx.repoDir, ["rev-parse", "HEAD"], { timeoutMs: 10_000 })).stdout.trim();
  const pushNotProven = await postDeepResults({
    scriptPath: opts.pushScriptPath ?? DEFAULT_PUSH_SH, extraEnv: opts.pushExtraEnv, pinnedOrigin: ctx.pinnedOrigin, prUrl: (ctx.outputs().pr as { pr_url?: string } | undefined)?.pr_url,
    headSha: SHA_RE.test(headSha) ? headSha : "", repoDir: ctx.repoDir, runDir: ctx.runDir, checks, notProven: notProvenList, statusState,
  });
  const allNotProven = [...notProvenList, ...pushNotProven];
  ctx.emit("deep.completed", "deep", { checks, status_state: statusState, addendum_sha256: addendumSha256 });
  return { status: "completed", data: { checks, addendum_sha256: addendumSha256, status_state: statusState, not_proven: allNotProven, ...(notApplicable.length ? { not_applicable: notApplicable } : {}) } };
}
export const deepStage: Stage = {
  name: "deep",
  ...STAGE_BUDGETS.deep,
  run: (ctx, signal) => runDeep(ctx as DeepContext, signal),
};
export const stage = deepStage;
/** `engine10 deep-worker <run-id> <provider> <model> <origin>`: the detached post-PR deep verify the supervisor spawns (origin is appended at spawn time). Stage outputs and base sha come from the run's event log; events go nowhere (the child's stdio is ignored and only the supervisor writes events.jsonl), results are posted by runDeep. Exit 0 once a verdict was posted or recorded, 1 when deep verify failed to run, 2 on bad args. */
export async function deepWorker(args: string[], deps: { opts?: DeepOptions } = {}): Promise<number> {
  const [runId, provider = "claude", model = "", origin = ""] = args;
  if (!runId) { process.stderr.write("engine10 deep-worker: missing run id\n"); return 2; }
  const repoDir = process.cwd(), lokiRoot = join(repoDir, ".loki"), runDir = join(lokiRoot, "runs", runId);
  const { readEvents } = await import("../events.ts"), { eventsRelPath } = await import("../../util/engine_origin.ts"), { outputsFromEvents } = await import("../../util/run_outputs.ts");
  let outputs: ReturnType<typeof outputsFromEvents>;
  try { outputs = outputsFromEvents(readEvents(join(repoDir, eventsRelPath(runId)))); } catch (err) { process.stderr.write(`engine10 deep-worker: cannot read run events: ${(err as Error).message}\n`); return 1; }
  const baseSha = outputs["intake"]?.["base_sha"];
  if (typeof baseSha !== "string" || !baseSha) { process.stderr.write("engine10 deep-worker: run has no recorded base sha\n"); return 1; }
  const resolved = model || (await import("../session.ts")).resolveModel(provider);
  const sessions: SessionRunner = { run: () => Promise.reject(new Error("deep verify starts no model session (L003)")) }; // its cost could never reach the sealed receipt
  // ctx.model is the run's own model passed through (a DeepContext field, not a session option object); built without a conditional spread so the never-below-raw guard does not read it as a session pin.
  const pinned = origin ? { pinnedOrigin: origin } : {};
  const ctx: DeepContext = {
    runId, repoDir, runDir, baseSha, branch: `loki/${runId}`, provider, model: resolved, deep: true, capS: DEEP_CAP_S,
    emit: () => {}, sessions, failovers: () => [],
    tests: new (await import("../testmap.ts")).RealTestMapProvider(),
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() }, outputs: () => outputs as never,
    ...pinned,
  };
  const ac = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => ac.abort());
  const r = await runDeep(ctx, ac.signal, { ...deps.opts }); process.stderr.write((await import("../../util/base_guard.ts")).finishDeferredRun(repoDir, runId)); // the run-end cleanup the supervisor deferred while this ran
  if (r.status !== "completed") { process.stderr.write(`engine10 deep-worker: ${r.reason ?? r.status}\n`); return 1; }
  return 0;
}
