// loki-ts/src/engine10/stages/deep.ts -- E-23 Deep verify (ENGINE.md section 4). Runs after Seal
// + PR: full suite, app-boot probe, council, secret scan; reports via engine10-push.sh (comment +
// addendum + status). A refused or unavailable check is NOT PROVEN, never red; only a failing full
// suite or a secret match is failure. Rule of Two: assertWorkerEnv asserts no real GitHub token,
// since the deep worker runs repo code and reads untrusted diffs. Council goes through the
// injectable CouncilRunner; unwired, it is NOT PROVEN, never passing.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverProjectGraph } from "../../project_graph.ts";
import { run } from "../../util/shell.ts";
import { classifyRunnerOutput } from "../../runner/runner_errors.ts";
import { assertWorkerEnv } from "../worker.ts";
import { canonicalJson, sha256, signReceipt } from "./seal.ts";
import { changedFiles } from "./verify.ts";
import type { PushArgs, ReceiptCheck, RunContext, RunnerName, Stage, StageResult } from "../types.ts";
import { pushArgv, STAGE_BUDGETS } from "../types.ts";
/** RunContext plus the value this stage needs that E-03 will eventually
 *  inject (same local-extension pattern pr.ts's PrContext already uses). */
export type DeepContext = RunContext & {
  pinnedOrigin?: string;
};
export interface CouncilInput {
  runId: string;
  diff: string;
  files: string[];
}
export interface CouncilOutcome {
  findings: unknown[];
}
/** Implemented by whoever next owns RunnerContext construction (see the
 *  contract-gap note above). Tests inject a fake; production has none by
 *  default, so council is NOT PROVEN until one is wired. */
export interface CouncilRunner {
  run(input: CouncilInput, signal: AbortSignal): Promise<CouncilOutcome>;
}
/** ReceiptCheck (types.ts) plus a `reason` field the contract does not carry,
 *  the same disclosed-extra-field pattern testmap.ts's EngineTestMap and
 *  verify.ts's VerifyCheck already use. */
export interface DeepCheck extends ReceiptCheck {
  reason?: string;
}
export interface DeepOptions {
  pushScriptPath?: string;
  secretScanShPath?: string;
  discoverGraph?: (repoDir: string) => { members: string[] } | null;
  council?: CouncilRunner;
  maxCouncilDiffBytes?: number;
  fullSuiteTimeoutMs?: number;
  path?: string; // PATH override, tests only, so "missing tool" never depends on the host
  env?: NodeJS.ProcessEnv; // for assertWorkerEnv; defaults to process.env
  pushExtraEnv?: Record<string, string>; // merged into the push child's env, tests only (e.g. a stub's own log path)
}
export const DEFAULT_PUSH_SH = new URL("../../../../autonomy/lib/engine10-push.sh", import.meta.url).pathname;
export const DEFAULT_SECRET_SCAN_SH = new URL("../../../../autonomy/lib/secret-scan.sh", import.meta.url).pathname;
const MAX_COUNCIL_DIFF_BYTES = 400_000; // ENGINE.md section 2 cause 4: a 431361-byte context was refused
const FULL_SUITE_TIMEOUT_MS = 300_000; // 5 min per runner; deep's own stage limit (2700s) is the outer bound
const PR_NUMBER_RE = /\/pull\/(\d+)$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const FULL_SUITE_CMD: Record<RunnerName, { cmd: string; args: string[] }> = {
  pytest: { cmd: "python", args: ["-m", "pytest", "-q"] },
  vitest: { cmd: "npx", args: ["vitest", "run"] },
  jest: { cmd: "npx", args: ["jest"] },
  bun: { cmd: "bun", args: ["test"] },
  node: { cmd: "node", args: ["--test"] },
  npm: { cmd: "npm", args: ["test", "--silent"] },
  go: { cmd: "go", args: ["test", "./..."] },
  cargo: { cmd: "cargo", args: ["test"] },
};
/** One check per detected runner, run to completion (no retry: flaky-rerun
 *  is a fast-verify concept, ENGINE.md never asks for it in deep verify). */
async function runFullSuite(ctx: RunContext, signal: AbortSignal, opts: DeepOptions, checks: DeepCheck[], notProven: Set<string>): Promise<void> {
  const map = await ctx.tests.detect(ctx.repoDir);
  if (map.runners.length === 0) {
    notProven.add("full suite (no test runner detected)");
    return;
  }
  for (const runner of map.runners) {
    const spec = FULL_SUITE_CMD[runner];
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
      ...(opts.path ? { env: { PATH: opts.path } } : {}),
    });
    const durationS = (Date.now() - started) / 1000;
    if (signal.aborted) {
      checks.push({ name, cmd: [spec.cmd, ...spec.args].join(" "), result: "not_run", duration_s: durationS });
      notProven.add(`not run: ${name} (aborted)`);
      continue;
    }
    const loadErr = r.exitCode === 0 ? null : classifyRunnerOutput(`${r.stdout}\n${r.stderr}`); if (loadErr?.kind === "load_error") { checks.push({ name, cmd: [spec.cmd, ...spec.args].join(" "), result: "not_run", duration_s: durationS }); notProven.add(`${loadErr.reason} (${name}; harness-owned)`); continue; } // FC-02: harness-owned, never a code failure
    checks.push({ name, cmd: [spec.cmd, ...spec.args].join(" "), result: r.exitCode === 0 ? "pass" : "fail", duration_s: durationS });
  }
}
/** ENGINE.md section 4: "app boot (via project_graph.ts discoverProjectGraph)".
 *  discoverProjectGraph only tells us whether a `.loki/app.json` manifest
 *  exists; it never starts anything. Actually booting the app (the legacy
 *  docker-compose path, autonomy/app-runner.sh, ENGINE.md section 2 cause 1)
 *  is out of this slice's file set. */
function runAppBoot(ctx: RunContext, opts: DeepOptions, checks: DeepCheck[], notProven: Set<string>): void {
  const discover = opts.discoverGraph ?? discoverProjectGraph;
  let graph: { members: string[] } | null = null;
  try {
    graph = discover(ctx.repoDir);
  } catch {
    graph = null;
  }
  // ponytail: real boot (docker compose up + health check) belongs to a slice
  // that owns autonomy/app-runner.sh's TS-callable surface; add it there.
  checks.push({
    name: "app boot",
    cmd: "project_graph.ts discoverProjectGraph",
    result: "not_run",
    duration_s: 0,
  });
  notProven.add(graph ? `app boot not run (app graph discovered, ${graph.members.length} member(s))` : "app boot not run (no app graph discovered)");
}
async function runCouncilCheck(
  ctx: RunContext, changed: string[], baseSha: string, signal: AbortSignal, opts: DeepOptions, checks: DeepCheck[], notProven: Set<string>,
): Promise<void> {
  const codeFiles = changed.filter((f) => !f.endsWith(".md")); // "generated docs excluded" (ENGINE.md section 4)
  if (codeFiles.length === 0) {
    notProven.add("council (no non-doc changes to review)");
    return;
  }
  if (!opts.council) {
    notProven.add("council (not wired: see the contract-gap note in stages/deep.ts)");
    return;
  }
  const diffResult = await run(["git", "diff", "--no-color", baseSha, "HEAD", "--", ...codeFiles], { cwd: ctx.repoDir, timeoutMs: 20_000 });
  const diff = diffResult.exitCode === 0 ? diffResult.stdout : "";
  const maxBytes = opts.maxCouncilDiffBytes ?? MAX_COUNCIL_DIFF_BYTES;
  if (Buffer.byteLength(diff, "utf8") > maxBytes) {
    notProven.add("council (context oversized, refused)");
    return;
  }
  const started = Date.now();
  try {
    const outcome = await opts.council.run({ runId: ctx.runId, diff, files: codeFiles }, signal);
    checks.push({ name: "council", cmd: "dispatchClaudeAgents", result: "pass", duration_s: (Date.now() - started) / 1000 });
    void outcome; // findings are informational for this slice; council blocking policy is not part of E-23's contract
  } catch (err) {
    notProven.add(`council (refused: ${(err as Error).message})`);
  }
}
/** Sources autonomy/lib/secret-scan.sh (never edited, only sourced -- the
 *  same reuse style engine10-push.sh already uses for run.sh) and runs its
 *  two matchers over every changed file. A match on either is a hit. */
async function runSecretScan(ctx: RunContext, changed: string[], opts: DeepOptions, checks: DeepCheck[], notProven: Set<string>): Promise<void> {
  const scriptPath = opts.secretScanShPath ?? DEFAULT_SECRET_SCAN_SH;
  const name = "security scan";
  if (!existsSync(scriptPath)) {
    checks.push({ name, cmd: "secret-scan.sh", result: "not_run", duration_s: 0 });
    notProven.add(`not run: ${name} (secret-scan.sh not found)`);
    return;
  }
  if (changed.length === 0) {
    checks.push({ name, cmd: "secret-scan.sh", result: "pass", duration_s: 0 });
    return;
  }
  const inline = 'script="$1"; shift; . "$script" || exit 3; hit=0; for f in "$@"; do if _commit_scan_secret_file "$f" || _commit_path_looks_secret "$f"; then printf "%s\\n" "$f"; hit=1; fi; done; exit "$hit"';
  const started = Date.now();
  const r = await run(["bash", "-c", inline, "_", scriptPath, ...changed.map((f) => join(ctx.repoDir, f))], { cwd: ctx.repoDir, timeoutMs: 30_000 });
  const durationS = (Date.now() - started) / 1000;
  if (r.exitCode === 3) {
    checks.push({ name, cmd: "secret-scan.sh", result: "not_run", duration_s: durationS });
    notProven.add(`not run: ${name} (secret-scan.sh failed to load)`);
    return;
  }
  const hits = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  checks.push({
    name,
    cmd: "secret-scan.sh",
    result: hits.length > 0 ? "fail" : "pass",
    duration_s: durationS,
    ...(hits.length > 0 ? { reason: `secret match: ${hits.join(", ")}` } : {}),
  });
}
/** engine10-push.sh's real `comment` usage is `comment <pr-number> <body-file>`
 *  (see the contract-gap note above) -- built here rather than through
 *  pushArgv, whose "comment" case does not match the script. */
function commentArgv(prNumber: string, bodyFile: string): string[] {
  return ["comment", prNumber, bodyFile];
}
function buildCommentBody(checks: DeepCheck[], notProven: string[], statusState: "success" | "failure"): string {
  const lines = [`## Loki deep verify: ${statusState}`, "", "### Checks"];
  lines.push(...(checks.length ? checks.map((c) => `- ${c.result}: ${c.name}${c.reason ? ` (${c.reason})` : ""}`) : ["- none"]));
  lines.push("", "### NOT PROVEN", ...(notProven.length ? notProven.map((n) => `- ${n}`) : ["- none"]));
  return `${lines.join("\n")}\n`;
}
async function postResults(
  ctx: DeepContext, opts: DeepOptions, checks: DeepCheck[], notProven: string[], statusState: "success" | "failure",
): Promise<string[]> {
  const out: string[] = [];
  const pinnedOrigin = ctx.pinnedOrigin;
  if (!pinnedOrigin) {
    out.push("push refused: no pinned origin (Rule of Two)");
    return out;
  }
  const scriptPath = opts.pushScriptPath ?? DEFAULT_PUSH_SH;
  const env = { ...process.env, ...opts.pushExtraEnv, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: pinnedOrigin };
  const prUrl = (ctx.outputs().pr as { pr_url?: string } | undefined)?.pr_url;
  const prNumber = prUrl ? PR_NUMBER_RE.exec(prUrl)?.[1] : undefined;
  if (prNumber) {
    mkdirSync(ctx.runDir, { recursive: true });
    const bodyFile = join(ctx.runDir, "deep-comment.md");
    writeFileSync(bodyFile, buildCommentBody(checks, notProven, statusState), "utf8");
    const commentResult = await run(["bash", scriptPath, ...commentArgv(prNumber, bodyFile)], { cwd: ctx.repoDir, env, timeoutMs: 30_000 });
    if (commentResult.exitCode !== 0) out.push(`deep comment not posted (engine10-push.sh exit ${commentResult.exitCode})`);
  } else {
    out.push("deep comment not posted (no PR number)");
  }
  const headSha = (await run(["git", "rev-parse", "HEAD"], { cwd: ctx.repoDir, timeoutMs: 10_000 })).stdout.trim();
  if (SHA_RE.test(headSha)) {
    const statusArgs: PushArgs = { cmd: "status", sha: headSha, state: statusState, description: `Loki 10 deep verify: ${statusState}` };
    const statusResult = await run(["bash", scriptPath, ...pushArgv(statusArgs)], { cwd: ctx.repoDir, env, timeoutMs: 30_000 });
    if (statusResult.exitCode !== 0) out.push(`loki/deep-verify status not set (engine10-push.sh exit ${statusResult.exitCode})`);
  } else {
    out.push("loki/deep-verify status not set (HEAD sha not resolvable)");
  }
  return out;
}
export async function runDeep(ctx: DeepContext, signal: AbortSignal, opts: DeepOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before deep verify started" };
  try {
    assertWorkerEnv(opts.env ?? process.env);
  } catch (err) {
    return { status: "failed", data: {}, reason: (err as Error).message };
  }
  let changed: string[];
  try {
    changed = changedFiles(ctx.repoDir, ctx.baseSha);
  } catch (err) {
    return { status: "failed", data: {}, reason: `git diff against base failed: ${(err as Error).message}` };
  }
  const checks: DeepCheck[] = [];
  const notProven = new Set<string>();
  await runFullSuite(ctx, signal, opts, checks, notProven);
  runAppBoot(ctx, opts, checks, notProven);
  await runCouncilCheck(ctx, changed, ctx.baseSha, signal, opts, checks, notProven);
  await runSecretScan(ctx, changed, opts, checks, notProven);
  const statusState: "success" | "failure" = checks.some((c) => c.result === "fail") ? "failure" : "success";
  const notProvenList = [...notProven];
  const seal = ctx.outputs().seal as { receipt_sha256?: string } | undefined;
  const addendumBody = {
    schema: "loki.v10.receipt-addendum/1" as const,
    run_id: ctx.runId,
    base_receipt_sha256: seal?.receipt_sha256 ?? null,
    checks,
    not_proven: notProvenList,
    status_state: statusState,
  };
  const addendumSha256 = sha256(canonicalJson(addendumBody));
  const sig = signReceipt(`${ctx.runId}-deep`, addendumSha256);
  const addendum = { ...addendumBody, addendum_sha256: addendumSha256, verification: { jwt: sig.jwt, kid: sig.kid } };
  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(join(ctx.runDir, "receipt-addendum-1.json"), JSON.stringify(addendum, null, 2) + "\n");
  const pushNotProven = await postResults(ctx, opts, checks, notProvenList, statusState);
  const allNotProven = [...notProvenList, ...pushNotProven];
  ctx.emit("deep.completed", "deep", { checks, status_state: statusState, addendum_sha256: addendumSha256 });
  return { status: "completed", data: { checks, addendum_sha256: addendumSha256, status_state: statusState, not_proven: allNotProven } };
}
export const deepStage: Stage = {
  name: "deep",
  ...STAGE_BUDGETS.deep,
  run: (ctx, signal) => runDeep(ctx as DeepContext, signal),
};
export const stage = deepStage;
