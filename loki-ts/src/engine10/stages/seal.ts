// E-10: commit and Seal (docs/v10/ENGINE.md sections 4, 9). Writes receipt.json and receipt.md, computes receipt_sha256, and signs natively with node:crypto Ed25519 (A-121; no python, no
// `cryptography`). The key is the A-120 local key, created on first use. An empty token means UNSIGNED, never presented as attested.
import { loadProjectApi } from "../../project_model/resolve.ts";
import { isOff } from "../../council/role_agents.ts";
import { roleModelsReceiptBlock } from "../../util/claude_model.ts";
import { capFenceVerdict, fenceNotes, readFenceRecord } from "../../util/config_fence.ts";
import { sanitizeReason } from "../../util/redact.ts";
import { acceptanceLines, FRESH_INSTALL_ASK, issueAcceptanceCapOn, issueAcceptanceOf, issueAcceptanceStatus, notAddressedNotes } from "../../util/intent_card.ts"; import { specReceiptBlock } from "../../util/spec_file.ts"; import { triageReceiptBlock } from "../../features/triage.ts"; import { staleAtSeal, staleReason } from "../../util/steer.ts"; import { seededCorpusBlock, intentRevisionsBlock, sealAccuracyBlock } from "../../util/run_outputs.ts"; import { contextCoverageBlock } from "../../util/context_pack.ts";
import { createHash } from "node:crypto"; import { execFileSync } from "node:child_process"; import { unitSpecReceiptBlock } from "../../features/speed/unit_mode.ts";
import { chmodSync, existsSync, readdirSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path"; import { aiTrailers } from "../pr_body.ts";
import { mutationEnabled, mutationProof, mutationStrict, type ProofBefore } from "../../util/mutation_proof.ts";
import { RealBaseTestRunner, loadTaskText } from "./wall.ts"; import { defectPinEdits, defectPinNote, pinDroppedNotes, pinnedUpdateNotes, weakenExcuse, type PinnedTestUpdate } from "../../util/test_guard.ts";
import { assertDeltaNotes } from "../../e10ext/assert_delta.ts"; import { runnerConfigNotes } from "../../features/runner_config.ts";
import { discardIfSatisfied } from "../../e10ext/discard.ts";
import { buildArtifactNotes, dropSet, formatChangedRecord, guardRegenDrops, needDropNote, needDrops, parseStaged, regenDropNote, regenDrops, regenKeptNote } from "../../e10ext/commit_filter.ts";
import { releaseRefsReceiptBlock, type SelfReviewRecord, selfReviewReceiptBlock, turnGuardNote } from "../../features/self_review.ts";
import { crossPackageTestEdits, crossPackageTestNote, flagOutsideScope, outsideScope, scopeTestDropEnabled } from "../../e10ext/scope.ts";
import { canonicalJson, collectToolchain, kidOf, loadSigningKey, signReceipt } from "../../util/receipt_signer.ts";
import { appendReceiptFact, recordRunVerdict } from "../../util/pr_lessons.ts"; import { getVersion } from "../../version.ts";
import { sealEvidence } from "../../features/visual_evidence.ts";
import { isTestFile } from "../testmap.ts"; import { EXEC_SPEC_TELEMETRY_FILE } from "../../features/exec_spec.ts";
import { crossReview, issueLineCheck, isUnmetNote, minVerdict, modelReviewRan, reviewExtraLimitS, reviewReceipt } from "./xreview.ts";
import { cascadeV0On } from "../../util/wall_knobs.ts";
import { STAGE_BUDGETS, type RunnerName, type Obj, type PushRefusal, type Receipt, type ReceiptCheck, type RunContext, type Stage, type StageName, type StageResult, type TestRef, type Verdict } from "../types.ts";
import { buildRouteBlock, routeNotProven, routePrLine, routeReceiptLines } from "../../runner/router/route_block.ts";
import { loadRouteRecord } from "../../runner/router/route_record.ts";
import { ranModel, receiptBlock, recordRun } from "../../runner/router/cost_preview.ts";
import { routerEnabled } from "../../runner/router/flag.ts";
import { liveArchivedCosts, sumResultCosts, UNMETERED } from "../cost.ts";
import { sealedWallDir, checkProvenance, checkResultLabel, SKIPPED_BY_REPO, publishableWall, publishWall, commitWallEnabled, wallChild, deepGaps, hasExecutedProof, hasExogenousProof, changedSymbols, symbolGap, addedPublicFunctions, API_FILE_EXT, exercisedViaCallers, callerFiles, notApiFile, identifierSet, moduleToken, isExecutedProof, CODE_FILE_EXT, reportedErrors, type ReportedErrors, NO_TESTS_REASON, type ProvenanceCtx, UNCONFIRMED_REASON, UNMEASURED_REASON } from "../../util/check_result.ts";
import { type ContractSnapshot, sealContract } from "../../features/contract.ts";
import { capGroupVerdict, sealGroup } from "../../features/speed/seal_group.ts";
import { readDeclared, supplyGuard, supplyVerdict } from "../../supply/supply_guard.ts";
import { hooks } from "../hooks.ts"; import { partialCostText } from "../output.ts"; import { LOKI_OWN_LEAD, verifiedReceiptBlock, type CapReason } from "../closure.ts";
import { atomicWriteText } from "../../util/atomic.ts";
import { patchReceipt } from "../../features/patch_protocol.ts";
import { collapseNotProven } from "../../util/term_width.ts";
import { consultNotes, neverStopNotes } from "../../features/opus_consult.ts"; import { namedUnchangedNote, namedUnchangedOf, unfinishedNotes } from "../../util/conflict_resume.ts"; import { envCardReceiptBlock, neededServices } from "../../util/stack_tools.ts"; import { updateRepoCard } from "../../e10ext/repomemory.ts"; import { PROOF_SCRIPT, baseFacts, fallbackLines, noOwnProofNotes, proofBaseCapOn, proofBaseOn, proofFacts, proofOnBase, proofRerunOn, proofRerunS, provesNothing, provesNothingReason, rerunProof, ruleStatus, unusedNewFileNote, unusedNewFiles } from "../proof_rerun.ts"; import { issueRunBrief } from "../types.ts"; import { proveDisclosures, proveNotes, proveReceiptBlock } from "./prove.ts";
import { tournamentReceiptBlock } from "../../features/tournament.ts"; import { attemptsReceiptBlock } from "../../features/attempts.ts"; import { nrdReceiptBlock, settleNrd } from "../../features/no_regression.ts";
import { commitHookBypassOn, type SafeGitKeep, safeGit, safeGitRun } from "../../util/safe_git.ts"; import { addedSymlinkNotes, capLateRecovery, recoverRunWork, sealPrScope, splitDeclaredAdvisories, unverifiedRecovered, workRecoveryNotes } from "../../util/base_guard.ts"; import { readPlanScope } from "../../util/run_cap.ts"; import { toolchainDropNotes } from "../../util/lock_ecosystems.ts"; import { conventionsBlock, fragmentNoticeLine, misplacedNamedNotes, releaseNoteSkipBlock } from "../../project_model/conventions.ts"; import { declaresPythonEnv } from "../../util/python.ts"; import { testFileWeakened } from "../../util/test_guard.ts";
import { exogenousRedOn, holdsPartial, type ExogenousAttribution } from "../../runner/repo_profile.ts"; // EXOGENOUS-RED
const SYSTEM_INTERP = "tests ran on the system interpreter", SYSTEM_INTERP_SUFFIX = " (the repo declares no Python dependencies, so this is its interpreter; informational, does not cap)"; // verify.ts writes the note

export const SIGNING_UNAVAILABLE = "receipt signing unavailable (no usable signing key: invalid key or unwritable ~/.loki/keys)", AGENT_ONLY_REASON = "only agent-authored tests executed (no agent-independent proof)", WALL_GREEN_ON_BASE_REASON = "Wall green on base: no Wall test discriminates the change"; // TEN-GATES-02

const EXCLUDE_LOKI = ":(exclude).loki";
export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
export const EXTERNAL_MODEL_LABEL = "external (no Loki implement session)", EXTERNAL_DIFF_NOT_ISOLATED = "Wall author not filesystem-isolated from the external diff", EXTERNAL_NO_WALL = "external diff sealed with no Wall file that ran; the only checks are the repo's existing tests"; // CW-12 B2/B3
const externalRun = (o: Partial<Record<StageName, Record<string, unknown>>>): boolean => o.implement?.exit === "external";
/** LINT-MISSING-DISCLOSE: lint checks (lint:*) that read not_run because their tool could not be started by any means verify tried (skip_code tool_not_on_path). Off with
 *  LOKI_E10_LINT_MISSING_DISCLOSE=0. A linter that ran and reported violations is a failed check and is never in this list; neither is a test runner that is missing. */
export const LINT_MISSING_NOTE = "linter not installed, not run (disclosed, does not cap)";
export function missingLintChecks(vraw: readonly Obj[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (/^(0|off|false|no)$/i.test((env["LOKI_E10_LINT_MISSING_DISCLOSE"] ?? "").trim())) return [];
  return vraw.filter((c) => String(c.name ?? "").startsWith("lint:") && c.result === "not_run" && c.skip_code === "tool_not_on_path").map((c) => String(c.name));
}
export const LEAN_NO_SYMBOL = "no passing check references a changed symbol and no Wall file ran";
export const NO_FAIL_THEN_PASS = "no test shown to fail on the base commit and pass on the change";
/** Wall-off verdict (EVAL-2026-11-05-3): an agent-authored or edited test is proof only when the HARNESS shows it fails on the base commit with the head's test bytes and passes on the change (util/mutation_proof.ts, the same base-worktree run T2 uses). An edited file's own base version must be green on the base first, so a pre-existing red file never reads as discriminating. */
/** The symbols the diff declares or modifies in non-test code files (the lean rule and the fail-then-pass relevance rule share it). */
async function codeSymbols(ctx: RunContext, rawDiff: string[], head: string): Promise<{ all: string[]; onBase: Set<string> }> {
  const code: string[] = [];
  for (let i = 0; i + 1 < rawDiff.length; i += 2) { const st = rawDiff[i]!.trim().split(" ").pop() ?? "", f = rawDiff[i + 1]!; if (st !== "D" && CODE_FILE_EXT.test(f) && !isTestFile(f)) code.push(f); }
  const onBase = new Set<string>(); if (code.length === 0) return { all: [], onBase };
  for (let i = 0; i + 1 < rawDiff.length; i += 2) { const f = rawDiff[i + 1]!; if (code.includes(f) && (rawDiff[i]!.trim().split(" ").pop() ?? "") !== "A") { const b = await safeGitRun(ctx.repoDir, ["show", `${ctx.baseSha}:${f}`], { timeoutMs: 20000 }); if (b.exitCode === 0) for (const id of identifierSet(b.stdout)) onBase.add(id); } }
  const d = await safeGitRun(ctx.repoDir, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", ctx.baseSha, head, "--", ...code], { timeoutMs: 20000 });
  return { all: d.exitCode === 0 ? changedSymbols(d.stdout, (p) => readFileSync(join(ctx.repoDir, p), "utf8")) : [], onBase }; // ENCLOSING-DECL: the committed head is the worktree here
}
/** The fail-then-pass base runner. Every file it runs already passed on the head under this same interpreter, so a base assertion failure under it is a like-for-like difference: trustSystem is on even when the repo declares a Python environment (4 of 4 more-itertools runs read inconclusive without it). */
/** PROOF-PROJECT-API (LOKI_E10_PROOF_PROJECT_API, default on, =0 opts out): the fail-then-pass proof runs each test with the real repo's Project Model. RealBaseTestRunner
 *  otherwise reads the model from the temporary base worktree, which has no .loki/, so in a multi-package repo a frontend vitest file ran from the repo root
 *  (no vitest there) and the proof read "inconclusive (the Wall command did not execute to a result)". Package roots are repo-relative, so they hold in the worktree. */
export const proofProjectApiOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_PROOF_PROJECT_API"] ?? "").trim());
export const baseProofRunner = (ms: number, reported: ReportedErrors = { observed: [], wanted: [] }, repoDir?: string): RealBaseTestRunner => new RealBaseTestRunner(repoDir && proofProjectApiOn() ? loadProjectApi(repoDir) : undefined, ms, {}, true, reported); // PROOF-PROJECT-API: the Project Model of the real repo (the base worktree has no .loki/), so a package's test runs in its package dir; // reported: the errors the issue quotes (reportedErrors), a base failure raising exactly one counts like an assertion
async function failThenPass(ctx: RunContext, vraw: Obj[], pctx: ProvenanceCtx, head: string, cs: { all: string[]; onBase: Set<string> }, task: string, rewritten: ReadonlySet<string> = new Set()): Promise<{ ok: boolean; line: string; files: string[]; before?: ProofBefore[] }> {
  const files = [...new Set(vraw.filter((c) => isExecutedProof(c as { result?: unknown; n?: unknown }) && checkProvenance(String(c.name ?? ""), pctx) === "agent_authored").map((c) => String(c.name).slice(String(c.name).indexOf(":") + 1)))];
  if (files.length === 0) return { ok: false, line: "", files: [] };
  const mp = await mutationProof({ repoDir: ctx.repoDir, baseSha: ctx.baseSha, runDir: ctx.runDir, wallFiles: files.map((path) => ({ path })), checks: vraw as { name: string }[], runner: (ms: number) => baseProofRunner(ms, reportedErrors(task), ctx.repoDir), headSha: head, requireAssertion: true, baseMustPass: files.filter((f) => pctx.modifiedFiles?.includes(f)) });
  const symbols = cs.all.filter((s) => cs.onBase.has(s) || new RegExp(`(?<![\\w$])${s.replace(/[$]/g, "\\$")}(?![\\w$])`).test(task)); // a symbol the base already has (a modified one), or one the task itself asks to add: a test that only names a function the change invented proves nothing about the change
  const read = (p: string): string => { try { return execFileSync("git", ["-C", ctx.repoDir, "show", `${head}:${p}`], { encoding: "utf8", maxBuffer: 16 << 20, timeout: 20_000 }); } catch { return ""; } };
  const failed = (mp.outcome === "yes" ? mp.failed ?? [] : []).filter((f) => symbolGap(symbols, [read(f)]).length === 0); // an assertion failure on base, in a file that names a symbol this change declares or modifies
  const proofFiles = failed.filter((f) => !rewritten.has(f)), before = (mp.before ?? []).filter((b) => proofFiles.includes(b.file)); // AWE-2: output lines only for the files that are the proof
  return { ok: proofFiles.length > 0, line: failed.length > 0 ? `${mp.line} (${failed.join(", ")})` : mp.line, files: failed, ...(before.length ? { before } : {}) }; // E4: a test file whose pinned assertion was rewritten fails on the base, which shows the pin was real, but it is never the proof itself
}
export const UNEXERCISED_PUBLIC = "no agent-independent passing test calls these added public functions";
/** The receipt's exec_spec block from <runDir>/exec-spec.json (features/exec_spec.ts): the stage's seconds and its generator session's dollars, so a scored run can weigh what the spec cost. */
function execSpecBlock(ctx: RunContext): { exec_spec?: { status: string; seconds: number; binding: number; usd: number | null } } {
  let t: Obj; try { t = JSON.parse(readFileSync(join(ctx.runDir, EXEC_SPEC_TELEMETRY_FILE), "utf8")) as Obj; } catch { return {}; }
  const id = str(t.iteration_id), c = id ? ctx.cost.read(ctx.repoDir, [id]) : null; // a session generator is read by its iteration id; toolLessCall priced its own call
  const usd = typeof t.usd === "number" ? t.usd : c && !c.unmetered && (c.measuredCount ?? 1) > 0 ? c.usd : null;
  return { exec_spec: { status: String(t.status ?? ""), seconds: typeof t.seconds === "number" ? t.seconds : 0, binding: typeof t.binding === "number" ? t.binding : 0, usd } };
}
export const SPEC_SITE_UNCOVERED = "named site without a binding case (no agent-independent passing test names it)";
/** Exec spec (features/exec_spec.ts): a sealed spec proves only the sites its binding cases name. A site caps the run below VERIFIED only when
 *  all hold: the spec sealed a binding case; the issue names the site in a defect or request sentence (capSites; a passing mention never
 *  caps); the diff did not touch it (`changed`); and no passing test that is neither agent-authored nor the spec file names it. So fixing one
 *  defective site while another stays untouched never reads VERIFIED on the spec alone. */
export function specSiteGap(o: Partial<Record<StageName, Obj>>, vraw: Obj[], pctx: ProvenanceCtx, read: (p: string) => string, changed: string[]): string[] {
  const es = (o.wall?.exec_spec ?? {}) as Obj, touched = new Set(changed), sites = es.status === "sealed" ? strs(es.uncovered_sites).filter((x) => !touched.has(x)) : [];
  if (sites.length === 0) return [];
  const wall = new Set(((o.wall?.files as { path: string }[] | undefined) ?? []).map((f) => String(f.path)));
  const sources = vraw.filter((c) => isExecutedProof(c as { result?: unknown; n?: unknown }) && checkProvenance(String(c.name ?? ""), pctx) !== "agent_authored").map((c) => { const n = String(c.name ?? ""); return n.includes(":") && !n.startsWith("full suite:") ? n.slice(n.indexOf(":") + 1) : null; }).filter((p): p is string => p !== null && isTestFile(p) && ![...wall].some((w) => w === p || w.endsWith(`/${p}`))).map(read);
  return symbolGap(sites, sources);
}
/** The two symbol rules, from one read of the diff and the passing checks.
 *  lean (FC-LEAN-VERIFIED-WITHOUT-CHANGED-SYMBOL): with no Wall file that ran, the changed code is exercised only if a passing test source names a symbol the diff declares or modifies; the unreferenced symbols, or [].
 *  pub (HONEST-VERIFIED-2): every public function the run ADDS (util/check_result.ts addedPublicFunctions) must be named, directly or through a covered caller, by an agent-independent passing test: a Wall file that passed, a test file the run did not touch (a full-suite pass that counted tests contributes every untouched test file), Tests the implementer wrote or edited never clear it. Off by default; LOKI_E10_PUBLIC_GAP=1 turns it on.
 *  Both are [] for an external run (its own rule) and an already-satisfied claim. */
const CALLER_SCAN = 3000, CALLER_MAX_BYTES = 200_000;
async function symbolGaps(ctx: RunContext, o: Partial<Record<StageName, Obj>>, rawDiff: string[], head: string, vraw: Obj[], wallOff: { pctx: ProvenanceCtx; ftp: () => Promise<boolean> } | null = null): Promise<{ lean: string[]; pub: string[] }> {
  const none = { lean: [], pub: [] };
  if (externalRun(o) || o.intake?.already_satisfied === true || o.implement?.exit === "already_done") return none;
  const touched = new Set<string>(), code: string[] = [], added: string[] = [];
  for (let i = 0; i + 1 < rawDiff.length; i += 2) { const st = rawDiff[i]!.trim().split(" ").pop() ?? "", f = rawDiff[i + 1]!; touched.add(f); if (st !== "D" && (CODE_FILE_EXT.test(f) || API_FILE_EXT.test(f)) && !isTestFile(f)) code.push(f); if (st === "A") added.push(f); }
  if (code.length === 0) return none;
  const read = (p: string): string => { try { return readFileSync(join(ctx.repoDir, p), "utf8"); } catch { return ""; } };
  const executed = vraw.filter((c) => isExecutedProof(c as { result?: unknown; n?: unknown })), testOf = (c: Obj): string | null => { const n = String(c.name ?? ""), p = n.slice(n.indexOf(":") + 1); return n.includes(":") && !n.startsWith("full suite:") && isTestFile(p) ? p : null; };
  const allSources = (wallOff ? executed.filter((c) => checkProvenance(String(c.name ?? ""), wallOff.pctx) !== "agent_authored") : executed).map(testOf).filter((p): p is string => p !== null).map(read); // Wall off: a test the run wrote or edited names the symbol trivially, so it counts only through the fail-then-pass proof below
  const ranWall = Array.isArray(o.wall?.files) && o.wall.files.length > 0, leanFiles = code.filter((f) => CODE_FILE_EXT.test(f));
  let lean: string[] = [];
  if (!ranWall && leanFiles.length) { const d = await safeGitRun(ctx.repoDir, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", ctx.baseSha, head, "--", ...leanFiles], { timeoutMs: 20000 }); if (d.exitCode === 0) lean = symbolGap(changedSymbols(d.stdout, read), allSources); if (lean.length > 0 && wallOff && await wallOff.ftp()) lean = []; }
  if (process.env["LOKI_E10_PUBLIC_GAP"] !== "1") return { lean, pub: [] }; // off by default: the span lines of a file with multi-line docstrings or template literals shift against the stripped text (follow-up task)
  const files = code.filter((f) => API_FILE_EXT.test(f)).map((path) => ({ path, src: read(path) }));
  const fns: string[] = [];
  for (const f of files) { const base = added.includes(f.path) ? "" : (await safeGitRun(ctx.repoDir, ["show", `${ctx.baseSha}:${f.path}`], { timeoutMs: 20000 })); const b = typeof base === "string" ? base : base.exitCode === 0 ? base.stdout : null; if (b !== null) fns.push(...addedPublicFunctions(f.path, f.src, b)); }
  if (fns.length === 0) return { lean, pub: [] };
  const wall = new Set(((o.wall?.files as { path: string }[] | undefined) ?? []).map((f) => (isAbsolute(f.path) ? relative(ctx.repoDir, f.path) : f.path)));
  const paths = new Set(executed.map(testOf).filter((p): p is string => p !== null && (wall.has(p) || !touched.has(p))));
  const ls = await safeGitRun(ctx.repoDir, ["ls-files", "-z"], { timeoutMs: 20000 }), tracked = ls.exitCode === 0 ? ls.stdout.split("\0").filter((t) => t && !touched.has(t)) : [];
  if (executed.some((c) => String(c.name ?? "").startsWith("full suite:"))) for (const t of tracked) if (isTestFile(t)) paths.add(t);
  const texts = [...paths].map(read), idents = texts.map((t) => identifierSet(t)), imports = texts.map((t) => identifierSet(t, true)), named = new Set(fns.filter((f) => idents.some((st) => st.has(f))));
  const pending = [...new Set(fns)].filter((f) => !named.has(f));
  if (pending.length === 0) return { lean, pub: [] };
  // Untouched callers of the changed files (bounded: CALLER_SCAN files of at most CALLER_MAX_BYTES each), so coverage through code the run did not edit counts.
  const candidates = tracked.filter((t) => !notApiFile(t)).slice(0, CALLER_SCAN).map((path) => ({ path, src: read(path) })).filter((f) => f.src.length <= CALLER_MAX_BYTES && !notApiFile(f.path, f.src));
  // A function of a changed file is seeded by a test naming it; a function of an untouched caller only by a test that also names its module (a test calling subprocess.run( does not exercise an unrelated run() elsewhere).
  const changedPaths = new Set(files.map((f) => f.path)), seed = (name: string, path: string): boolean => idents.some((st, i) => st.has(name) && (changedPaths.has(path) || imports[i]!.has(moduleToken(path))));
  return { lean, pub: exercisedViaCallers(pending, seed, [...files, ...callerFiles(files, candidates)]) };
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

/** sha256 over the canonical receipt with `verification` AND `receipt_sha256` removed (the hash cannot contain itself). */
export function receiptSha256(r: Omit<Receipt, "receipt_sha256" | "verification"> & Partial<Receipt>): string {
  const { verification: _v, receipt_sha256: _h, ...body } = r;
  return sha256(canonicalJson(body));
}

export { canonicalJson, kidOf, loadSigningKey, signReceipt }; // moved to util/receipt_signer.ts (core line budget)

// Worker side (token withheld, the agent already has exec): the seal add keeps the repo's content drivers, and the seal commit also keeps the user's hooks and commit signing, so pre-commit scanners
// and "require signed commits" still apply. safeGitRun strips the token from the env either way.
const g = (ctx: RunContext) => (a: string[]): Promise<{ out: string; code: number }> => git(ctx, a);
async function git(ctx: RunContext, args: string[], keep: SafeGitKeep = {}, timeoutMs = 20000): Promise<{ out: string; code: number; err: string }> {
  const r = await safeGitRun(ctx.repoDir, args, { timeoutMs, ...keep });
  return { out: r.stdout, code: r.exitCode, err: String(r.stderr ?? "") };
}
/** COMMIT-HOOK-BYPASS (LOKI_E10_COMMIT_HOOK_BYPASS, default on, =0 opts out): a repo's own commit hooks (commitlint on the message, lint-staged, a
 *  prepare-commit-msg prompt) are written for people, and one a run's build installed (msw: `pnpm run build` ran simple-git-hooks, then commitlint
 *  rejected "loki: ...") must never fail the delivery. When the commit with the user's hooks fails, the index and the staged files go back to the
 *  verified tree and the commit is retried once with hooks off (signing kept). A pass on that retry proves a hook was the cause, and the receipt says so. */
/** The last few non-empty lines of a git error, for the receipt (bounded, one line). */
export const gitErrorLine = (err: string): string => err.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4).join(" | ").slice(0, 400) || "no error output";
export const hookBypassNote = (err: string): string => `the repo's own commit hook rejected Loki's commit (${gitErrorLine(err)}); committed with hooks off, signing kept (LOKI_E10_COMMIT_HOOK_BYPASS)`;

/** MARK-1: the receipt path relative to the repo, for the Loki-Receipt trailer; falls back to the standard run location. */
const receiptRel = (ctx: RunContext): string => { const r = relative(ctx.repoDir, join(ctx.runDir, "receipt.json")); return r.startsWith("..") || isAbsolute(r) ? `.loki/runs/${ctx.runId}/receipt.json` : r; };

/** acc-170 guard: reruns the targeted tests verify passed (never a full suite or lint; at most 6, about 20 s in all) on the current tree. True when one fails,
 *  or when none of them could run to a result (fail safe: the caller then keeps what it was about to drop); false when none exist. */
const REGEN_GUARD_MAX = 6, REGEN_GUARD_MS = 20_000;
export function targetedBreak(ctx: RunContext, runner: (ms: number) => { run(dir: string, files: TestRef[]): { pass: number; fail: number } } = (ms) => new RealBaseTestRunner(undefined, ms)): boolean {
  const checks = (Array.isArray(ctx.outputs().verify?.checks) ? (ctx.outputs().verify!.checks as Obj[]) : []).filter((c) => c.result === "pass" && typeof c.name === "string" && /^[a-z]+:[^ ]/.test(c.name as string) && !/^(?:lint|full suite|typecheck|build|holdout|patch|turn):/.test(c.name as string));
  const refs = [...new Map(checks.map((c) => { const n = String(c.name), i = n.indexOf(":"); return [n.slice(i + 1), { runner: n.slice(0, i) as RunnerName, path: n.slice(i + 1) }] as const; })).values()].slice(0, REGEN_GUARD_MAX);
  if (!refs.length) return false;
  const t0 = Date.now(); let ran = 0;
  for (const r of refs) { const left = REGEN_GUARD_MS - (Date.now() - t0); if (left < 1000) break; const x = runner(left).run(ctx.repoDir, [r]); if (x.fail > 0) return true; if (x.pass > 0) ran++; }
  return ran === 0;
}
/** Section 4 Commit: `git add -A` minus .loki/, Wall files and stray lockfiles, commit `loki: <title>` with a Loki-Run trailer. An empty diff commits nothing (head stays at base). */
/** Z2: the receipt block of the tests implement updated to the issue's stated behavior; {} (key omitted, hash unchanged) when none. */
const pinnedUpdatesOf = (implement: Obj | undefined): PinnedTestUpdate[] => (Array.isArray(implement?.pinned_test_updates) ? (implement!.pinned_test_updates as PinnedTestUpdate[]) : []);
export const pinnedUpdatesBlock = (implement: Obj | undefined): { pinned_test_updates?: PinnedTestUpdate[] } => { const xs = pinnedUpdatesOf(implement); return xs.length ? { pinned_test_updates: xs } : {}; };
export const commitStage: Stage = {
  name: "commit",
  ...STAGE_BUDGETS.commit,
  async run(ctx: RunContext): Promise<StageResult> {
    // A-104/G2: stage all, unstage .loki/, Wall files (sealed under runDir/wall) and a NEW lockfile with no manifest change in its own directory (judged against baseSha).
    if (!ctx.baseSha || (await git(ctx, ["rev-parse", "--verify", "-q", `${ctx.baseSha}^{commit}`])).code !== 0) return { status: "failed", data: {}, reason: "base commit not resolvable" }; // A-104b r2: fail closed, every later reset and diff is judged against the base
    // WORK-RECOVERY: before anything decides there is nothing to commit, the run's own work that is not on the tree comes back: the checkout returns to the run
    // branch when a session left it elsewhere, and a stash entry a session made on the run branch is restored (util/base_guard.ts). Never the user's: see recoverRunWork.
    const rec = recoverRunWork({ repoDir: ctx.repoDir, runDir: ctx.runDir, branch: ctx.branch, stage: "commit", where: "commit", moveBranch: true });
    if (rec.recovered.length > 0) ctx.emit("work.recovered" as never, "commit", { files: rec.recovered.reduce((n, x) => n + x.files, 0), stashes: rec.recovered.map((x) => x.sha), from: "stash", when: "commit" });
    if (rec.kept.length > 0) ctx.emit("work.kept" as never, "commit", { stashes: rec.kept.map((x) => ({ ref: x.sha, reason: x.reason })) });
    if (rec.moved) ctx.emit("work.branch" as never, "commit", { note: rec.moved });
    const unverified = unverifiedRecovered(ctx.runDir, ctx.repoDir, ctx.outputs().verify), late = unverified.length > 0 ? { work_unverified: unverified } : {}; // LATE-RECOVERY: read before the formatter can rewrite a restored file; seal holds the label at PARTIAL (capLateRecovery)
    if ((await git(ctx, ["add", "-A", "--", "."], { repoDrivers: true })).code !== 0) return { status: "failed", data: {}, reason: "git add failed" };
    const sd = await git(ctx, ["diff", "--cached", "--name-status", "--no-renames", "-z", ctx.baseSha]); if (sd.code !== 0) return { status: "failed", data: {}, reason: "git diff against base failed" };
    const staged = parseStaged(sd.out);
    const drop0 = dropSet(ctx.repoDir, staged, ctx.outputs().intake?.preexisting_dirty, process.env, ctx.outputs().intake?.install_created, ctx.outputs().intake?.preexisting_untracked_blobs, ctx.baseSha, str(ctx.outputs().intake?.task) ?? undefined);
    const regen0 = regenDrops(ctx.runDir, staged.filter(({ f }) => !drop0.some((d) => d.f === f)), str(ctx.outputs().intake?.task) ?? "", (f) => { try { return safeGit(ctx.repoDir, ["diff", "--no-color", "-U0", ctx.baseSha!, "--", f]).split("\n").filter((l) => /^[+-](?![+-]{2})/.test(l)); } catch { return []; } }); // RD
    const regenG = guardRegenDrops(ctx.repoDir, ctx.baseSha, regen0, () => targetedBreak(ctx)), regen = regenG.dropped; // acc-170: the picked paths go to base on disk, the targeted tests rerun, and a path a test needs is restored and kept
    const rest = staged.filter(({ f }) => !drop0.some((d) => d.f === f) && !regen.some((d) => d.f === f));
    const need = needDrops(rest, str(ctx.outputs().intake?.task) ?? "", (f) => { let base: string | null = null, head: string | null = null; try { base = safeGit(ctx.repoDir, ["show", `${ctx.baseSha}:./${f}`], { maxBuffer: 64 << 20 }); } catch { /* new on this run */ } try { head = readFileSync(join(ctx.repoDir, f), "utf8"); } catch { /* gone */ } return { base, head }; }, (() => { try { return outsideScope(ctx.outputs(), rest); } catch { return null; } })()); // DN
    const drop = [...drop0, ...regen, ...need];
    const sat = await discardIfSatisfied((a) => git(ctx, a), ctx.baseSha, ctx.outputs(), staged, new Set(drop.filter(({ st }) => st === "L").map(({ f }) => f)), ctx.repoDir); if (sat) return sat; // D50-F1
    if (drop.length > 0 && (await git(ctx, ["--literal-pathspecs", "reset", "-q", ctx.baseSha, "--", ...drop.map(({ f }) => f)])).code !== 0) return { status: "failed", data: {}, reason: "git reset failed" }; // A-104b: reset to the run base (not HEAD) so a path committed in implement leaves the diff too; literal, so ":(top)x" is a filename
    // J3 LOKI_E10_SCOPE_TEST_DROP: a test-only edit in a package the change does not touch goes back to base (index and tree), with a NOT PROVEN note; source files are never touched
    const xpkg = scopeTestDropEnabled() ? crossPackageTestEdits(ctx.repoDir, staged.filter(({ f }) => !drop.some((d) => d.f === f)), str(ctx.outputs().intake?.task) ?? "", (await git(ctx, ["ls-files", "-z"])).out.split("\0").filter(Boolean), (() => { try { return readFileSync(join(ctx.runDir, PROOF_SCRIPT), "utf8"); } catch { return ""; } })()) : []; // F2: the kept proof script; a test it names is never reset
    if (xpkg.length > 0) {
      if ((await git(ctx, ["--literal-pathspecs", "reset", "-q", ctx.baseSha, "--", ...xpkg])).code !== 0) return { status: "failed", data: {}, reason: "git reset failed" };
      const mod = xpkg.filter((f) => staged.find((x) => x.f === f)?.st === "M"); if (mod.length > 0) await git(ctx, ["--literal-pathspecs", "checkout", "-q", ctx.baseSha, "--", ...mod]);
      for (const f of xpkg) if (staged.find((x) => x.f === f)?.st === "A") { try { rmSync(join(ctx.repoDir, f)); } catch { /* already gone */ } }
    }
    const dropped = new Set([...drop.map(({ f }) => f), ...xpkg]), fmtRec = formatChangedRecord(ctx.repoDir, staged, dropped, process.env, ctx.baseSha), fmt = fmtRec.formatted; // TEN-QUALITY-16: only the run's own kept files; J1: the resolved binary, base-clean files only, recorded
    if (fmt.length > 0) await git(ctx, ["--literal-pathspecs", "add", "--", ...fmt], { repoDrivers: true }); // re-stage what the repo's formatter rewrote
    const notes = [...xpkg.map(crossPackageTestNote), ...flagOutsideScope(ctx.outputs(), staged.filter(({ f }) => !dropped.has(f)), ctx.runDir, ctx.repoDir), ...toolchainDropNotes(ctx.repoDir, drop.filter(({ st }) => st === "A").map(({ f }) => f), ctx.baseSha), ...buildArtifactNotes(ctx.repoDir, drop.filter(({ st }) => st === "A").map(({ f }) => f), ctx.baseSha, str(ctx.outputs().intake?.task) ?? undefined), ...regen.map(({ f }) => regenDropNote(f)), ...regenG.kept.map(({ f }) => regenKeptNote(f)), ...need.map(needDropNote), ...workRecoveryNotes(ctx.runDir, ctx.repoDir, unverified)]; // WORK-RECOVERY: what was restored, what was kept and where it is // D76: advisory, nothing is reverted
    const format = fmtRec.records.length ? { format: fmtRec.records } : {};
    if ((await git(ctx, ["diff", "--cached", "--quiet"])).code === 0) return { status: "completed", data: { committed: false, scope_notes: notes, ...late, ...format } };
    const title = (str(ctx.outputs().intake?.title) ?? `run ${ctx.runId}`).split("\n")[0]!.slice(0, 72);
    const msg = ["-m", `loki: ${title}`, "-m", [`Loki-Run: ${ctx.runId}`, ...aiTrailers({ runId: ctx.runId, provider: ctx.provider, model: externalRun(ctx.outputs()) ? EXTERNAL_MODEL_LABEL : ctx.model, receiptRel: receiptRel(ctx) })].join("\n")];
    const verified = (await git(ctx, ["write-tree"])).out.trim(), kept = staged.filter(({ f, st }) => !dropped.has(f) && st !== "D").map(({ f }) => f); // the tree verify judged, before any hook can restage it
    const c = await git(ctx, ["commit", "-q", ...msg], { repoDrivers: true, userHooks: true }, 120000); // a repo pre-commit hook (lint-staged) can take longer than 20 s
    let hookNote: string[] = [];
    if (c.code !== 0 && commitHookBypassOn() && /^[0-9a-f]{40,64}$/.test(verified)) {
      await git(ctx, ["read-tree", verified]); // a hook that ran a formatter and restaged leaves the index changed: put the verified tree back
      for (let i = 0; i < kept.length; i += 200) await git(ctx, ["checkout-index", "-f", "--", ...kept.slice(i, i + 200)], { repoDrivers: true }); // and the run's own files in the tree, never a dropped (user) file
      const c2 = await git(ctx, ["-c", "core.hooksPath=/dev/null", "commit", "-q", ...msg], { repoDrivers: true, userHooks: true });
      if (c2.code !== 0) return { status: "failed", data: { commit_error: gitErrorLine(c2.err || c.err) }, reason: "git commit failed" };
      hookNote = [hookBypassNote(c.err)];
    } else if (c.code !== 0) return { status: "failed", data: { commit_error: gitErrorLine(c.err) }, reason: "git commit failed" };
    return { status: "completed", data: { committed: true, head_sha: (await git(ctx, ["rev-parse", "HEAD"])).out.trim(), scope_notes: [...notes, ...hookNote], ...(hookNote.length ? { hooks_bypassed: true } : {}), ...late, ...format } };
  },
};

// Stage outputs read by seal. Only keys in the ENGINE.md section 4 table (plus duration_s from section 5) are trusted; any other key seal reads puts a "not recorded" entry on NOT PROVEN when absent, so a producer cannot silently shape the receipt.
export const wallGreenOnBaseOf = (o: Partial<Record<StageName, Obj>>): boolean => { const b = (o.wall?.base_run ?? {}) as Obj; return typeof b.pass === "number" && b.pass > 0 && b.fail === 0 && (typeof b.not_run === "number" ? b.not_run : 0) === 0; }; // D42 (3)/B1 (r2): green only with real passes, no failure, no not_run; shared by seal, wall.ts runWall
/** BACKSTOP-SEAL: set by the supervisor's seal pass after a backstop kill (supervisor.ts). */
export const sealOnlyPass = (env: NodeJS.ProcessEnv = process.env): boolean => env["LOKI_E10_SEAL_ONLY"] === "1";
export const TIME_RAN_OUT_NOTE = "time ran out: the run was stopped at its time limit before it finished; this receipt seals the tree as it was then";
/** SECRET-PUSH: the push refusal when the final verify's security scan failed on a secret match (an added line, or a file named like a secret file):
 *  that change must not leave the machine until a person reviewed it. Fail-safe: a failed scan that recorded no secret_matches refuses too;
 *  a scan failed only by a secure-scan HIGH finding (secret_matches []) does not. Null when nothing refuses. */
export function secretPushRefusal(verify: Obj | undefined, runId: string): PushRefusal | null {
  const c = (Array.isArray(verify?.checks) ? (verify.checks as Obj[]) : []).find((x) => x?.name === "security scan" && x?.result === "fail");
  if (!c) return null;
  const m = Array.isArray(c.secret_matches) ? (c.secret_matches as unknown[]).filter((x): x is string => typeof x === "string" && x !== "") : null;
  if (m !== null && m.length === 0 && (c.secret_matches as unknown[]).length === 0) return null;
  return { check: "security scan", matches: m && m.length ? m : ["(where it matched was not recorded)"], command: `git push -u origin loki/${runId}` };
}
/** SECRET-PUSH: the one line a refused push prints (and the receipt's NOT PROVEN entry). */
export const secretPushLine = (r: PushRefusal): string => `not pushed: the ${r.check} matched a secret at ${r.matches.join(", ")}; review it, then push by hand: ${r.command}`;
/** LIMIT-NOT-FAILED (hm155462 on 11.158.0: both Loki arms sealed FAILED on a passing change because verify reached its 900 s limit): a verify Loki itself
 *  stopped (its time limit or the run cap) never attributed its red tests to the change or to the base, so a failing pre-existing repo test (exogenous
 *  provenance, a runner check) is unattributed: it holds the label at PARTIAL, never FAILED. A failing Wall, holdout, or test the run wrote or edited, and a
 *  failing lint, typecheck or scan, are the change's own and stay FAILED. */
export function unattributedRed(o: Partial<Record<StageName, Obj>>, c: Pick<ReceiptCheck, "name" | "provenance">): boolean {
  const cut = o.verify?.stopped_at === "limit" || o.verify?.stopped_at === "cap", head = c.name.split(":")[0]!;
  if (c.provenance !== "exogenous" || !c.name.includes(":") || /^(lint|typecheck|holdout|select-tests|build|patch|turn)$/.test(head)) return false;
  // EXOGENOUS-RED (repo_profile.ts exogenousState): verify's record for this check says whether the failure is attributed to the change. With no record the
  // old rule stands: unattributed only when verify itself was stopped. Off (LOKI_E10_EXOGENOUS_RED=0) reads no record.
  const a = exogenousRedOn() ? (o.verify?.exogenous_attribution as Record<string, ExogenousAttribution> | undefined)?.[c.name] : undefined;
  return a ? holdsPartial(a) : cut;
}
/** ALREADY-DONE-SHOWN (FireLater#24 on 11.162.0): a run whose implement session found the work already done (or whose intake found it already satisfied),
 *  whose verify agreed and whose commit changed nothing seals ALREADY_SATISFIED only on Loki's own evidence: its own re-run of the session's kept proof script on
 *  the unchanged tree passed (exit 0, at least one line proved, none failed). verify runs no check on that path, so before this the label could only be PARTIAL
 *  "no tests to run". The session's word alone never labels it. */
export const alreadyDoneClaimed = (o: Partial<Record<StageName, Obj>>): boolean => (o.implement?.exit === "already_done" || o.intake?.already_satisfied === true) && o.verify?.already_satisfied === true && o.commit?.failed !== true;
export const alreadyDoneShown = (o: Partial<Record<StageName, Obj>>, run: { refused?: string; exit: number | null; proved: number; failed: number } | null): boolean =>
  alreadyDoneClaimed(o) && !!run && !run.refused && run.exit === 0 && run.proved > 0 && run.failed === 0;
/** ADS-LINES (Fable review of 11.167.0): the re-run alone is not enough. A session-written proof with 1 proved step and 10 acceptance lines sealed ALREADY_SATISFIED.
 *  The run must have acceptance lines (the issue's own, or the plan's for a prose issue), and that same re-run must meet every required one by the rule seal already
 *  uses for an issue run (ruleStatus: a proved check for the line and no failed one). With no acceptance lines the run stays PARTIAL, as before. */
/** ADS-REAL: on the already-done path a line counts as met only when at least one of its passing steps ran something of the repository's (proof_rerun.ts
 *  realStep: a loki_http request the app answered, or a loki_cmd naming the repository's runner or one of its paths). One `true` per line no longer meets them. */
/*  The fresh-install line Loki adds (FRESH_INSTALL_ASK) is about the app installing and answering: it counts as having a real step when the same re-run has at
 *  least one passing loki_http request anywhere, since its own checks read what the installed app left behind (FireLater#24: a registered tenant, migrated tables). */
export const alreadyRealLines = <T extends { line: string; status: string; reason?: string }>(st: T[], run: { lines: Record<string, { real?: number; http?: number }> }): T[] => {
  const answered = Object.values(run.lines).some((l) => (l.http ?? 0) > 0);
  return st.map((x, i) => (x.status === "met" && !((run.lines[String(i + 1)]?.real ?? 0) > 0) && !(x.line === FRESH_INSTALL_ASK && answered) ? { ...x, status: "unmet", reason: x.line === FRESH_INSTALL_ASK ? "the fresh-install line has no passing step that ran repository code and no request the app answered in this re-run" : "no passing step for this line ran repository code (only shell builtins or commands outside the repository)" } : x));
};
export const alreadyLinesMet = (st: { status: string; optional?: true }[]): boolean => st.some((x) => x.status === "met") && st.every((x) => x.status === "met" || x.optional === true);
export const alreadyDoneNotShownNote = (run: { refused?: string; exit: number | null; proved: number; failed: number } | null): string =>
  `already done claimed; Loki's own re-run of the kept proof script did not show it (${!run ? "no proof script was kept" : run.refused ? `not run: ${run.refused}` : `exit ${run.exit === null ? "none" : run.exit}, ${run.proved} proved, ${run.failed} failed`})`;
export const alreadyLinesNote = (st: { line: string; status: string; optional?: true }[]): string => {
  const req = st.filter((x) => !x.optional), met = req.filter((x) => x.status === "met").length, first = req.find((x) => x.status !== "met");
  return st.length === 0 ? "already done claimed; Loki's own re-run of the kept proof script passed, but the run has no acceptance lines to check it against" : `already done claimed; Loki's own re-run of the kept proof script met ${met} of ${req.length} acceptance line(s)${first ? `; first unmet: ${first.line.slice(0, 160)}` : ""}`;
};
export function verdictOf(o: Partial<Record<StageName, Obj>>, checks: ReceiptCheck[], emptyDiff: boolean, verifyNotProven: boolean, wallGreenOnBase: boolean, proof: boolean, targetProof = false, uncovered: string[] = [], leanGap: string[] = [], copyGap: string[] = [], clauseGap: string[] = []): Verdict {
  const exit = o.implement?.exit;
  // FC-16: no success verdict without a Loki-executed check with n>0 and a pass; otherwise PARTIAL (NOT PROVEN, "no tests executed").
  if (o.commit?.failed !== true && strs(o.commit?.not_proven).length === 0 && (o.intake?.already_satisfied === true || exit === "already_done")) return (proof || wallGreenOnBase) && o.wall?.reproduction_green_on_base !== true ? "ALREADY_SATISFIED" : "PARTIAL"; // FC-VACUOUS-WALL-GREEN: a Wall green on base proves a claim, never makes the claim itself; GAME10-08b: recorded runtime evidence the Wall did not reproduce is never "already satisfied"
  if (exit === "spec_conflict") return "SPEC_CONFLICT"; if (o.commit?.failed === true || strs(o.commit?.not_proven).length > 0) return "FAILED"; // r3: an unrestored user file is never a clean verdict; A-104b r2: a failed commit never seals VERIFIED
  // Section 2: an empty diff without the LOKI_ALREADY_DONE marker is FAILED, never VERIFIED.
  if (emptyDiff) return "FAILED";
  // FC-21b (1): a limit-killed implement is VERIFIED only when the harness itself ran every check green, a Wall or task-named test passed with n>0 (targetProof), and the limit was recorded.
  if (exit === "killed") return typeof o.implement?.limit_s === "number" && targetProof && uncovered.length === 0 && copyGap.length === 0 && clauseGap.length === 0 && proof && !wallGreenOnBase && !verifyNotProven && checks.length > 0 && checks.every((c) => c.result === "pass") ? "VERIFIED" : "PARTIAL";
  if (typeof o.implement?.limit_s === "number") return "PARTIAL"; // A1: a limit that did not kill the session (an error or a throw) is never a clean verdict
  if (checks.some((c) => c.result === "fail" && !unattributedRed(o, c))) return "FAILED";
  // E-98a B1: verify's own NOT PROVEN (e.g. a system interpreter) downgrades too -- never a silent VERIFIED.
  if (exit === "external" && !(Array.isArray(o.wall?.files) && o.wall.files.length > 0)) return "PARTIAL"; // FC-EXTERNAL-SEAL-WITHOUT-WALL-VERIFIED: an external diff has no watched implement session, so with no Wall file that ran it is never VERIFIED
  if (copyGap.length > 0 || clauseGap.length > 0) return "PARTIAL"; // FALSEVER-SEALCOPY: a Wall file whose sealed copy is missing or not the sealed bytes cannot be shown to be what ran; FALSEVER-CLAUSE: a spec acceptance clause no passing sealed Wall file proves (a marker plus an assertion) is likewise never VERIFIED
  if (leanGap.length > 0) return "PARTIAL"; // FC-LEAN-VERIFIED-WITHOUT-CHANGED-SYMBOL (no Wall file ran and no passing check references a changed symbol) and HONEST-VERIFIED-2 (an added public function no agent-independent passing test names): nothing independent exercised the change
  if (exit === "killed" || checks.length === 0 || checks.some((c) => c.result !== "pass") || verifyNotProven || !proof || wallGreenOnBase) return "PARTIAL"; // FC-VACUOUS-WALL-GREEN: a Wall green on base discriminates nothing, so a changed tree is never VERIFIED on it
  return "VERIFIED";
}

/** FALSEVER-OPEN-DECISION (LOKI_E10_OPEN_DECISION_CAP, default on, =0 opts out): NOT PROVEN lines for what the run decided without the issue deciding it.
 *  An intake assumption (an either/or the vote or the model picked), a no-regression change the issue does not decide (advisory), and a differential that did not run or complete. */
/** An intake open-choice line the run settled itself: no evidence picked an option, or the precedent vote did. A choice the task, a maintainer or an existing test settles, and any other assumption (a brief's defaults), is not one. */
export const runPickedChoice = (a: string): boolean => /^Open choice: .* -> (?:no evidence picks one|implement option \d+: .*Evidence \((?:precedent|none)\))/s.test(a);
export function openDecisionNotes(o: Partial<Record<StageName, Obj>>, env: NodeJS.ProcessEnv = process.env): string[] {
  if (["0", "off", "false", "no"].includes((env.LOKI_E10_OPEN_DECISION_CAP ?? "").trim().toLowerCase())) return [];
  const nrd = ((o.implement?.no_regression as { receipt?: unknown } | undefined)?.receipt), lines = Array.isArray(nrd) ? nrd.map(String) : [];
  return [...strs(o.intake?.assumptions).filter(runPickedChoice).map((a) => `open choice the issue does not decide, picked by the run: ${a}`),
    ...lines.filter((l) => l.startsWith("advisory:")).map((l) => `behavior change the issue does not decide: ${l.slice("advisory:".length).trim()}`),
    ...lines.filter((l) => l.startsWith("NOT PROVEN:"))];
}

/** FC-21b: verify's target_checks (Wall and task-named relevant tests) names a test that ran n>0 and passed; read from verify's raw checks, never from prose. */
export function targetProofOf(v: Obj | undefined): boolean {
  const names = new Set(strs(v?.target_checks)), raw = Array.isArray(v?.checks) ? (v.checks as Obj[]) : [];
  return raw.some((c) => names.has(String(c.name)) && hasExecutedProof([c]));
}

/** SCAN-WHY: a failed security scan keeps where it matched and why on the receipt (the F0 oc58562 replays read "security scan: fail" with nothing else; the
 *  locations were only in events.jsonl and push_refused). File:line and rule names only, never the matched text, as deep.ts records them. */
export const scanWhy = (c: Obj): { secret_matches?: string[]; reason?: string } => c.name !== "security scan" || c.result !== "fail" ? {} : {
  ...(Array.isArray(c.secret_matches) ? { secret_matches: (c.secret_matches as unknown[]).filter((x): x is string => typeof x === "string") } : {}),
  ...(typeof c.reason === "string" && c.reason ? { reason: c.reason } : {}),
};
function checksOf(v: unknown, pc: ProvenanceCtx, preRed: readonly string[] = [], repoSkipped: readonly string[] = []): ReceiptCheck[] { // TEN-GATES-02: each check carries who authored its evidence (additive key)
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is Obj => !!c && typeof c === "object").map((c) => ({
    name: String(c.name ?? ""),
    cmd: String(c.cmd ?? ""),
    result: c.result === "pass" || (c.result === "fail" && c.owner !== "harness") ? c.result : "not_run", // never-worse-than-raw floor: a gate that failed for a harness reason is not a code failure; it seals not_run (PARTIAL), never FAILED
    duration_s: typeof c.duration_s === "number" ? c.duration_s : 0, ...(c.owner === "harness" && c.result !== "pass" ? { owner: "harness" as const } : {}), provenance: checkProvenance(String(c.name ?? ""), pc), ...(typeof c.n === "number" ? { n: c.n } : {}), ...(typeof c.count === "string" ? { count: c.count } : {}), ...(c.result === "fail" && preRed.includes(String(c.name ?? "")) ? { pre_red: true as const } : {}), ...(c.result !== "pass" && c.result !== "fail" && repoSkipped.includes(String(c.name ?? "")) ? { repo_skipped: true as const } : {}), ...scanWhy(c), // pre_red (FC-PR-BODY-PUBLIC-HYGIENE); n: TEN-GATES-03-F1 verify --require-exogenous counts only executed proof (n > 0); additive like provenance
  }));
}

export function renderReceiptMd(r: Receipt): string {
  const sig = r.verification.jwt ? `SIGNED (kid ${r.verification.kid})` : "UNSIGNED", ln = (c: ReceiptCheck): string => `- ${checkResultLabel(c.result, c.pre_red === true, c.repo_skipped === true)}: ${c.name} (\`${c.cmd}\`, ${c.duration_s}s)`, sec = (h: string, cs: ReceiptCheck[]): string[] => [h, ...(cs.length ? cs.map(ln) : ["- none"])], indep = (c: ReceiptCheck): boolean => c.provenance === "exogenous" || c.provenance === "independent"; // TEN-GATES-02: a receipt without provenance keeps the single Checks section
  // E-69: never $0.00 for an unpriced run; "partial" when some but not all sessions were priced.
  const usd = r.cost.usd !== null
    ? `$${r.cost.usd.toFixed(4)}`
    : r.cost.measured_sessions > 0
      ? partialCostText(r.cost.partial_usd, r.cost.measured_sessions, r.cost.total_sessions)
      : "not measured";
  return [
    `## Loki receipt: ${r.verdict}`,
    "",
    ...(r.verdict === "SPEC_CONFLICT" && r.spec_conflict_reason ? [`- Reason: \`${r.spec_conflict_reason}\``] : []),
    `- Run: ${r.run_id}`,
    `- Base: ${r.base_sha}  Head: ${r.head_sha}`,
    `- receipt_sha256: ${r.receipt_sha256}`,
    `- Signature: ${sig}`,
    `- Provider: ${r.provider} (${r.model})  Cost: ${usd}  Wall: ${r.time.wall_s}s (stages)  Total to seal: ${hooks.time?.reconciled(r.time) ?? "NOT RECORDED"}${(hooks.time?.reconciled(r.time) ?? null) === null ? "" : "s"}`,
    ...(r.cost.tokens_measured ? [`- Tokens: partial: ${r.cost.input_tokens} input / ${r.cost.output_tokens} output for ${r.cost.tokens_measured.k} of ${r.cost.tokens_measured.n} sessions`] : []),
    ...(r.mutation_proof ? [`- ${r.mutation_proof}`] : []),
    ...(r.tournament?.length ? ["", "### Candidate tournament", ...r.tournament.map((l) => `- ${sanitizeReason(l)}`)] : []),
    ...(r.attempts?.length ? ["", "### Implement attempts", ...r.attempts.map((l) => `- ${sanitizeReason(l)}`)] : []),
    ...(r.no_regression?.length ? ["", "### No-regression differential", ...r.no_regression.map((l) => `- ${sanitizeReason(l)}`)] : []),
    ...(r.route ? routeReceiptLines(r.route) : []), // R1-15: only when the router is on
    "",
    ...(r.checks.some((c) => c.provenance !== undefined) ? [...sec("### Agent-independent checks", r.checks.filter(indep)), "", ...sec("### Agent-authored / advisory checks", r.checks.filter((c) => !indep(c)))] : sec("### Checks", r.checks)),
    "",
    ...(r.evidence.length ? ["### Evidence (already-satisfied)", ...r.evidence.map((e) => `- ${e}`), ""] : []),
    "### NOT PROVEN",
    ...collapseNotProven(r.not_proven).map((n) => `- ${sanitizeReason(n)}`), ...(r.not_applicable?.length ? ["", "### N/A (not applicable, or not selected by risk tier)", ...r.not_applicable.map((n) => `- ${sanitizeReason(n)}`)] : []),
    "",
  ].join("\n");
}

/** E5: the harness session stops (implement, then each fix round) for the receipt. */
export const sessionCaps = (o: Partial<Record<string, Obj>>): string[] => [...(typeof o.implement?.session_cap === "string" ? [`implement: ${o.implement.session_cap}`] : []), ...strs(o.fix?.session_caps)];
export const sealStage: Stage = {
  name: "seal",
  ...STAGE_BUDGETS.seal,
  extraLimitS: (c) => reviewExtraLimitS(c) + (proofRerunOn() && existsSync(join(c.runDir, PROOF_SCRIPT)) ? proofRerunS() + 60 + (proofBaseOn() ? proofRerunS() + 240 : 0) : 0) + 260, // lazy: xreview and seal import each other transitively; plus Loki's own proof re-run and the acceptance line check (two calls at most)
  async run(ctx: RunContext, signal?: AbortSignal): Promise<StageResult> { const ev = await evaluateSeal(ctx, signal); return "failed" in ev ? ev.failed : ev.publish(); },
};
/** RW-03: what evaluateSeal hands back. `verdict` is the label before publish (publish can only lower it: a Wall test that fails at its committed path);
 *  `reasons` are the structured kinds that held it below VERIFIED; `notProven` the open lines known at that point (the receipt's full list, disclosures
 *  included, is assembled at publish). `publish` runs once: the Wall child commit and its re-run, the repo card, the receipt files and signature, the run
 *  history row, the lesson records, the sealed hook and receipt.sealed. Calling evaluateSeal again without publishing writes none of those. */
export interface SealEvaluation { verdict: Verdict; reasons: CapReason[]; notProven: string[]; publish(): Promise<StageResult> }
export async function evaluateSeal(ctx: RunContext, signal?: AbortSignal): Promise<{ failed: StageResult } | SealEvaluation> {
    await settleNrd(ctx); // SPEED-NRD-OVERLAP: a run that skipped verify still records the differential implement started before the verdict reads it
    const o = ctx.outputs(), stale = staleAtSeal(ctx.repoDir, ctx); if (stale.length) return { failed: { status: "failed", data: { stale_wall_revisions: stale.map((r) => r.rev) }, reason: staleReason(stale) } };
    const top = (await git(ctx, ["rev-parse", "HEAD"])).out.trim(), wallDone = await wallChild(g(ctx), ctx.runId, ctx.repoDir, o.wall?.files); // FC-VERIFIED-PR-WITHOUT-ITS-TEST: a re-seal after the Wall child commit binds the product head again
    const head = wallDone ? (await git(ctx, ["rev-parse", "HEAD^"])).out.trim() : top;
    const tree = (await git(ctx, ["rev-parse", `${head}^{tree}`])).out.trim();
    // Plumbing, so repo/global config (diff.noprefix, color, textconv, ext diff, quotepath) cannot change the hash. A verifier recomputes it with exactly: git diff-tree -r -z --raw --no-renames --no-abbrev -O/dev/null <base> <head> -- . ':(exclude).loki'
    const diff = await safeGitRun(ctx.repoDir, ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", "-O/dev/null", ctx.baseSha, head, "--", ".", EXCLUDE_LOKI], { timeoutMs: 20000 });
    const diffOk = diff.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(head);
    const verifyNotProven = strs(o.verify?.not_proven); // E-98a B1: a section 4 key, trusted like checks/flaky below
    // D42 (3)/B1 (r2): not_run must never seal ALREADY_SATISFIED, same weight as a real base-tree failure.
    const base = (o.wall?.base_run ?? {}) as Obj;
    const wallNotRun = typeof base.not_run === "number" ? base.not_run : 0;
    const wallGreenOnBase = wallGreenOnBaseOf(o);
    // An uncomputable diff is treated like an empty one: nothing is proven changed.
    const preRedChecks = strs(o.verify?.pre_red_checks).filter((n) => n !== "holdout" && !n.startsWith("holdout:")); // A-112: recorded as fail, skipped by the verdict; a held-out Wall check is never excused as pre-existing red
    const wallRel = (Array.isArray(o.wall?.files) ? (o.wall.files as Obj[]) : []).map((f) => String(f.path)), repoSkipped = strs(o.verify?.skipped_on_base).filter((n) => !wallRel.some((w) => w === n.slice(n.indexOf(":") + 1) || w.endsWith(`/${n.slice(n.indexOf(":") + 1)}`))); // FC-REPO-SKIPPED-TEST-DOWNGRADES: verify measured zero tests on base and head for an untouched file; a Wall file is never excused, even if listed
    // A-119 (EXP-0001): a delete, rename (--no-renames shows D plus A) or weakening edit of a pre-existing test file is NOT VERIFIED; an added case is not.
    const rawDiff = diffOk ? diff.stdout.split("\0").filter(Boolean) : [], pctx: ProvenanceCtx = { addedFiles: rawDiff.flatMap((m, i) => (i % 2 === 0 && m.trim().split(" ").pop() === "A" && rawDiff[i + 1] ? [rawDiff[i + 1]!] : [])), wallFiles: Array.isArray(o.wall?.files) ? (o.wall.files as Obj[]).map((f) => String(f.path)) : [], modifiedFiles: rawDiff.flatMap((m, i) => (i % 2 === 0 && m.trim().split(" ").pop() !== "A" && rawDiff[i + 1] && isTestFile(rawDiff[i + 1]!) ? [rawDiff[i + 1]!] : [])) }, checks = checksOf(o.verify?.checks, pctx, preRedChecks, repoSkipped); // TEN-GATES-02: A = added in this run
    const weakTests: string[] = [];
    for (let i = 0; i + 1 < rawDiff.length; i += 2) { const st = rawDiff[i]!.trim().split(" ").pop() ?? ""; if (st !== "A" && isTestFile(rawDiff[i + 1]!) && testFileWeakened(ctx.repoDir, ctx.baseSha, head, rawDiff[i + 1]!, st, loadTaskText(ctx, str(o.intake?.task) ?? undefined))) weakTests.push(rawDiff[i + 1]!); } // an edit that only adds cases or tightens assertions is kept and uncapped (EXP-0001)
    const rcNotes = diffOk ? [...runnerConfigNotes(ctx.repoDir, ctx.baseSha, head, rawDiff.filter((_, i) => i % 2 === 1), signal), ...addedSymlinkNotes(rawDiff, str(o.plan?.plan)), ...misplacedNamedNotes(str(o.intake?.task) ?? "", rawDiff, ctx.repoDir, head)] : []; // D86 FC-09: runner config or a file it loads changed
    // Class C: an advisory for a change the plan declared, or a link a passing Wall requires, is disclosed (suffix below), never a cap; any undeclared change keeps capping.
    const vraw = Array.isArray(o.verify?.checks) ? (o.verify.checks as Obj[]) : []; const decl = splitDeclaredAdvisories([...rcNotes, ...verifyNotProven], { repoDir: ctx.repoDir, runDir: ctx.runDir, baseSha: ctx.baseSha, rawDiff, planFiles: readPlanScope(ctx.runDir), wallPaths: wallRel, task: str(o.intake?.task) ?? "", head, wallPassedN: o.verify?.wall_passed === true && vraw.some((c) => c.result === "pass" && typeof c.n === "number" && c.n > 0 && wallRel.some((w) => String(c.name).endsWith(`:${w}`) || String(c.name).includes(w))) });
    const sysInfo = verifyNotProven.includes(SYSTEM_INTERP) && !declaresPythonEnv(ctx.repoDir, head) ? SYSTEM_INTERP : null; // HONEST-VERIFIED: no dependency manifest means the system interpreter is the project's own, so a pass on it is a pass (informational, never a cap)
    const disclosedSet = new Set(decl.disclosed), capRc = rcNotes.filter((n) => !disclosedSet.has(n)), capVerify = verifyNotProven.filter((n) => !disclosedSet.has(n) && n !== sysInfo); const DECLARED_SUFFIX = " (declared by the plan or required by the passing Wall; disclosed, does not cap)";
    const grp = sealGroup(ctx.runDir, receiptSha256 as never); // D61-13: inert without group/manifest.json
    const lintGone = missingLintChecks(Array.isArray(o.verify?.checks) ? (o.verify.checks as Obj[]) : []); // LINT-MISSING-DISCLOSE: a linter that could not be started by any means is disclosed, never a cap
    // RAN-IN-THE-PROOF: a test file this change ADDED that verify ran with zero tests (it is gated on an environment the proof script sets, such as a live
    // server) and that the kept proof script names. Loki's own proof run executes it, and that run must pass for any acceptance item to count, so the
    // zero-test result in verify is disclosed, not a cap. A run with every item met was held at PARTIAL on one such file.
    const proofText = (() => { try { return readFileSync(join(ctx.runDir, PROOF_SCRIPT), "utf8"); } catch { return ""; } })();
    const proofOnly = proofText ? checks.filter((c) => { if (c.result !== "not_run") return false; const f = c.name.slice(c.name.indexOf(":") + 1), b = f.slice(f.lastIndexOf("/") + 1); return b.length > 5 && pctx.addedFiles.some((a) => a === f || a.endsWith(`/${f}`)) && proofText.includes(b); }).map((c) => c.name) : [];
    const live = checks.filter((c) => !(c.result === "fail" && preRedChecks.includes(c.name)) && c.repo_skipped !== true && !lintGone.includes(c.name) && !proofOnly.includes(c.name)), executed = hasExecutedProof(vraw), strictProof = process.env["LOKI_EXOGENOUS_PROOF"] !== "0", noWall = !(Array.isArray(o.wall?.files) && o.wall.files.length > 0);
    const ftpGate = strictProof && noWall && diffOk && !externalRun(o) && o.intake?.already_satisfied !== true && o.implement?.exit !== "already_done" && weakTests.length === 0 && !live.some((c) => c.result === "fail") && mutationEnabled(); // only a run that could still read VERIFIED pays for the base-tree runs; a check red on the base too (pre_red) is not this change failing, exactly as verdictOf reads it (FireLater#24 s1: a red frontend suite on base shut this gate, so the new backend tests never earned their fail-then-pass proof and a clean slice read PARTIAL)
    // E4 defect pin: a pure value replacement of an existing assertion that pins the wrong value the issue reports is listed as "value change (defect pin)", not weakened. It never counts as proof (an edited pre-existing test is agent-authored).
    const pinEdits = diffOk ? rawDiff.flatMap((m, i) => { const st = m.trim().split(" ").pop() ?? ""; const f = rawDiff[i + 1]; return i % 2 === 0 && st === "M" && f && isTestFile(f) && !weakTests.includes(f) ? defectPinEdits(ctx.repoDir, ctx.baseSha, head, f, loadTaskText(ctx, str(o.intake?.task) ?? undefined)) : []; }) : [];
    const pinFiles = new Set(pinEdits.map((e) => e.file));
    let ftpMemo: Promise<{ ok: boolean; line: string; files: string[]; before?: ProofBefore[] }> | null = null; const ftp = (): Promise<{ ok: boolean; line: string; files: string[]; before?: ProofBefore[] }> => (ftpMemo ??= codeSymbols(ctx, rawDiff, head).then((cs) => failThenPass(ctx, vraw, pctx, head, cs, loadTaskText(ctx, str(o.intake?.task) ?? undefined), pinFiles)));
    const listed = issueAcceptanceCapOn() ? issueAcceptanceOf(o.intake) : [], fromPlan = issueAcceptanceCapOn() && listed.length === 0 && issueRunBrief(ctx.provider, o.intake?.source, process.env) ? fallbackLines(o.plan, o.intake).lines : []; // an issue written in prose has no checklist: the plan's own acceptance lines stand in, so the same check, proof re-run and table apply; the receipt says which list was used
    const issueOwn = listed.length ? listed : fromPlan, needs = issueOwn.length ? (() => { try { return neededServices(ctx.repoDir); } catch { return []; } })() : []; // ISSUE-ACCEPTANCE (on by default, LOKI_E10_ISSUE_ACCEPTANCE=0 opts out): the issue's own lines decide the label
    const issueAsks = issueOwn.length && needs.length ? [...issueOwn, FRESH_INSTALL_ASK] : issueOwn; // a repository that needs a database gets one more required line: the change works on a fresh install (the false VERIFIED of 2026-11-16 broke new-tenant creation and no diff reader could see it)
    const alreadyRun = alreadyDoneClaimed(o) && (!diffOk || diff.stdout === "") ? await rerunProof(ctx.repoDir, ctx.runDir, signal) : null, alreadyLines = alreadyRun ? alreadyRealLines(ruleStatus(issueAsks, alreadyRun, null), alreadyRun) : [], alreadyOk = alreadyDoneShown(o, alreadyRun) && alreadyLinesMet(alreadyLines); // ALREADY-DONE-SHOWN: Loki's own re-run on the unchanged tree
    const exoProof = hasExogenousProof(vraw, pctx), proof = alreadyOk || (!strictProof ? executed : !noWall ? exoProof : exoProof || (ftpGate && (await ftp()).ok)); // FC-16: executed n>0 pass from verify's raw checks (a Wall green on base proves only a claim, inside verdictOf); TEN-GATES-02 (D104): that pass must be agent-independent (LOKI_EXOGENOUS_PROOF=0 opts out)
    const pinLift = !isOff(process.env["LOKI_E10_DEFECT_PIN"]); // on by default, =0 opts out: lifts the cap only for the exact pinned file:line of a pure value replacement; the rewritten file never counts as proof and the receipt note is always on
    const pinDropped = pinDroppedNotes(verifyNotProven, pinEdits, pinLift);
    const uncoveredAfterLimit = o.implement?.exit === "killed" ? strs(o.verify?.uncovered_changed) : []; // FC-21b: changed code no passing impacted check covered; limit path only
    const { lean: leanGap, pub: pubGap } = diffOk ? await symbolGaps(ctx, o, rawDiff, head, vraw, strictProof && noWall ? { pctx, ftp: async () => ftpGate && (await ftp()).ok } : null) : { lean: [], pub: [] }; // FC-LEAN-VERIFIED-WITHOUT-CHANGED-SYMBOL; HONEST-VERIFIED-2
    const specGap = strs(((o.wall?.exec_spec ?? {}) as Obj).uncovered_sites).length && diffOk ? specSiteGap(o, vraw, pctx, (p) => { try { return readFileSync(join(ctx.repoDir, p), "utf8"); } catch { return ""; } }, (await codeSymbols(ctx, rawDiff, head)).all) : []; // exec spec: a defective named site no binding case covers and the diff left alone
    const wpAll = publishableWall(ctx.repoDir, ctx.runDir, o, process.env, loadTaskText(ctx, str(o.intake?.task) ?? undefined)); // pure read of the sealed copies; publishing still happens only on VERIFIED
    // LINT-OWN: a run whose only red checks are lint errors its own change introduced (verify's own_lint), with a passing test and no other red, is held at PARTIAL
    // with each lint line in NOT PROVEN: verdictOf reads those checks as not passed (never VERIFIED) instead of failed (never FAILED on a change every test passes).
    const ownLint = new Set(strs(o.verify?.own_lint)), openLint = live.filter((c) => c.result === "fail" && ownLint.has(c.name));
    const lintOnly = openLint.length > 0 && live.every((c) => c.result !== "fail" || ownLint.has(c.name)) && live.some((c) => c.result === "pass" && !c.name.startsWith("lint:"));
    const liveV = lintOnly ? live.map((c) => (openLint.includes(c) ? { ...c, result: "not_run" as const } : c)) : live;
    const lintOpenNotes = lintOnly ? openLint.map((c) => `lint error the change introduced, still failing after the fix rounds: ${c.name}: ${String(((Array.isArray(o.verify?.checks) ? (o.verify!.checks as Obj[]) : []).find((x) => x.name === c.name)?.first_error) ?? "see the check output").slice(0, 200)} (every test passed; the label is held at PARTIAL)`) : [];
    const verdict0 = capGroupVerdict(verdictOf(o, liveV, !diffOk || diff.stdout === "", capVerify.some((n) => !pinDropped.has(n)) || weakTests.length > 0 || capRc.length > 0, wallGreenOnBase, proof, targetProofOf(o.verify), uncoveredAfterLimit, [...leanGap, ...pubGap, ...specGap], wpAll.notes, wpAll.clauseGap), grp);

    // T10: supply-chain guard. A nonexistent new dependency blocks VERIFIED (a too-new one only warns unless LOKI_SUPPLY_MIN_AGE_DAYS is set); an unreachable registry only records NOT PROVEN.
    const supply = await supplyGuard(ctx.repoDir, rawDiff.filter((_, i) => i % 2 === 1), readDeclared(ctx.repoDir), process.env);
    const verdict1: Verdict = sealOnlyPass() && verdict0 === "VERIFIED" ? "PARTIAL" : supplyVerdict(verdict0, supply); // BACKSTOP-SEAL: a tree sealed after a time-limit kill is never VERIFIED
    const xr = await crossReview(ctx, verdict1, head, signal), verdict2 = minVerdict(verdict1, xr); // B4: opt-in second-provider review, downgrade only
    // T2: mutation proof always runs after VERIFIED. "no" (Wall passed without the fix) warns; it downgrades to PARTIAL only with LOKI_MUTATION_STRICT=1 AND a plan-declared behavior change (never a harness heuristic). "yes" and inconclusive never change the verdict.
    const mp0 = verdict2 === "VERIFIED" && mutationEnabled() ? await mutationProof({ repoDir: ctx.repoDir, baseSha: ctx.baseSha, runDir: ctx.runDir, wallFiles: Array.isArray(o.wall?.files) ? (o.wall.files as { path: string }[]) : [], checks: Array.isArray(o.verify?.checks) ? (o.verify.checks as { name: string }[]) : [], runner: (ms: number) => new RealBaseTestRunner(proofProjectApiOn() ? loadProjectApi(ctx.repoDir) : undefined, ms) }) : null; // PROOF-PROJECT-API
    const ftpRes = await (ftpMemo as Promise<{ ok: boolean; line: string; files: string[]; before?: ProofBefore[] }> | null), mp = ftpRes?.ok && verdict2 === "VERIFIED" && noWall ? { outcome: "yes" as const, line: ftpRes.line, ...(ftpRes.before ? { before: ftpRes.before } : {}) } : mp0; // Wall off: the fail-then-pass run is the receipt's proof line
    const fenceRec = fenceNotes(readFenceRecord(ctx.runDir), executed); // E1: what the config write fence restored, and any allowlist a spec conflict earned (caps below VERIFIED)
    const arbCap = Array.isArray(o.wall?.arbitrated) && (o.wall!.arbitrated as unknown[]).length > 0 && (verdict2 === "VERIFIED" || verdict2 === "ALREADY_SATISFIED"), mutCap = mp?.outcome === "no" && mutationStrict() && o.plan?.behavior_change === true, verdict3a: Verdict = capLateRecovery(capFenceVerdict(mutCap || arbCap ? "PARTIAL" : verdict2, fenceRec), strs(o.commit?.work_unverified)); // an arbitrated replacement passed only syntactic validators and two referees, so it never carries a success verdict; FC-69: a Wall test that did not execute is disclosed (not_proven), never a verdict downgrade (CTO ruling; D95 THIN)
    const namedOpen = namedUnchangedOf(ctx.repoDir, ctx.baseSha, o.implement); // R2 LOKI_E10_NAMED_SITES: named sites the final diff leaves unchanged; an unexplained one caps VERIFIED below
    const stoppedByHarness = (((o.implement?.scratch_cleanup as Obj | undefined)?.stopped ?? []) as Obj[]).map((p) => `${String(p.name)}${p.port ? ` on port ${String(p.port)}` : ""}`);
    const lineFacts = issueAsks.length ? [...(needs.length ? [`This repository needs: ${needs.join(", ")}.`] : []), stoppedByHarness.length ? `Processes this run started that Loki found still running and stopped after the session: ${[...new Set(stoppedByHarness)].join(", ")}.` : "Loki found no process of this run still running after the session (the session may have stopped its own, or started none).", `The implement session ended: ${String(o.implement?.exit ?? "unknown")}.`, ...(Array.isArray(o.fix?.fix_rounds) && (o.fix!.fix_rounds as unknown[]).length ? [`After the session's own proof, ${(o.fix!.fix_rounds as unknown[]).length} fix round(s) changed the code again; a result the reply shows from before those rounds does not prove the lines the fix touched.`] : [])] : [];
    const proofRun = alreadyRun ?? (issueAsks.length && diffOk && diff.stdout !== "" ? await rerunProof(ctx.repoDir, ctx.runDir, signal) : null); if (issueAsks.length) lineFacts.push(...proofFacts(ctx.runDir, proofRun, true)); // REPO CARD: what this run verified is kept for the next run in this repository (e10ext/repomemory.ts) // PROOF RE-RUN: Loki runs the session's proof script itself, after every fix round, so the evidence is a fact the harness holds
    const proofBase = issueAsks.length && proofRun && !alreadyRun ? await proofOnBase(ctx.repoDir, ctx.runDir, ctx.baseSha, proofRun, signal) : null, baseEmpty = provesNothing(issueAsks, proofRun, proofBase); lineFacts.push(...baseFacts(issueAsks, proofRun, proofBase)); // PROVES THE CHANGE: the same script against the base commit (the implement loop's result is reused when the script did not change); a line whose passing checks all pass there too is told to the reviewer and disclosed, and is not met under LOKI_E10_PROOF_BASE_CAP=1
    const baseNotes = !proofBase ? [] : !proofBase.available ? [`proof not compared with the base commit: ${proofBase.why ?? "not available"} (disclosed, does not cap: Loki could not show that these checks fail without the change)`] : proofBaseCapOn() ? [] : baseEmpty.map((n) => `acceptance line ${n} (${issueAsks[n - 1]!.slice(0, 80)}): ${provesNothingReason(proofBase, n)} (disclosed, does not cap; LOKI_E10_PROOF_BASE_CAP=1 makes it a cap)`);
    const lineCheck = issueAsks.length && diffOk && diff.stdout !== "" && (verdict3a === "VERIFIED" || verdict3a === "PARTIAL") ? await issueLineCheck(ctx, issueAsks, head, (Array.isArray(o.verify?.checks) ? (o.verify!.checks as Obj[]) : []).map((c) => ({ name: String(c.name), result: String(c.result) })), typeof o.implement?.final_reply === "string" ? o.implement.final_reply : "", lineFacts) : null; // runs on PARTIAL too, so every pull request shows each line's status
    const byRule = issueAsks.length && proofRun ? ruleStatus(issueAsks, proofRun, proofBaseCapOn() ? proofBase : null) : null, advisory = issueAsks.length ? issueAcceptanceStatus(issueAsks, lineCheck?.marks, lineCheck?.evidence, lineCheck?.reasons) : null; // FIXED RULE: when Loki ran the proof itself, a line is met by count (a passing check of Loki's own helper for its number, none failing); the model's reading is a note beside it, never the verdict
    const issueSt = byRule ? byRule.map((r, i) => ({ ...r, ...(advisory && advisory[i]!.status === "unmet" && r.status === "met" ? { note: `reviewer note: ${advisory[i]!.reason ?? ""}`.slice(0, 300) } : {}) })) : advisory, issueNotes = !issueSt || verdict3a !== "VERIFIED" ? [] : !byRule && lineCheck?.not_reviewed ? [`acceptance not reviewed: ${lineCheck.not_reviewed}`] : notAddressedNotes(issueSt as never);
    const allLinesMet = !!issueSt && (byRule ? true : !!lineCheck && !lineCheck.not_reviewed) && notAddressedNotes(issueSt as never).length === 0, unfinished = unfinishedNotes(o.implement); // with an acceptance list, the list decides: work the session left undone outside it (an optional item) is disclosed, never a cap
    const proofNotes = proofRun && proofRun.exit !== 0 ? [`Loki's own re-run of the session's proof script did not pass (exit ${proofRun.exit === null ? "none" : proofRun.exit}, ${proofRun.failed} FAILED line(s))`] : [];
    // ---- RW-02 ONE ROAD (lane rw-02, one line): a text task with its own acceptance list and no run of Loki's own is held below VERIFIED (proof_rerun.ts noOwnProofNotes) ----
    proofNotes.push(...noOwnProofNotes(o.intake?.source, listed.length, proofRun));
    // ---- end RW-02 ----
    // TWO READERS: the count decides, with one exception. A check can pass for a line it does not prove (an API response counted for "build the UI"): when the
    // acceptance check and the independent review, two separate readings, both find the same line not delivered, the label is held and both reasons are shown.
    // One reader alone stays a note, because a single reading varied from run to run on the same evidence.
    // NO SECOND READER: when the acceptance check did not answer (its reply was cut, or the call failed), nothing contradicts the independent review, so its
    // UNMET holds the label too. A run sealed VERIFIED with two UNMET lines from the review while the acceptance check had returned "truncated" twice.
    const noSecond = !!lineCheck?.not_reviewed;
    const twoReaders = (xr?.notes ?? []).filter(isUnmetNote).filter((n) => noSecond || issueAsks.some((line, i) => advisory?.[i]?.status === "unmet" && n.toLowerCase().includes(line.toLowerCase().slice(0, 60)))).map((n) => noSecond ? `${n} (the acceptance check did not answer, ${lineCheck!.not_reviewed}, so nothing contradicts the review and the count does not carry this line)` : `${n} (the acceptance check also reads this line as not delivered: two readers agree, so the count does not carry it)`);
    const unusedNotes = issueAsks.length ? (await unusedNewFiles(ctx.repoDir, ctx.baseSha, head)).map(unusedNewFileNote) : []; // an issue run only: a new source file nothing names is work a user cannot reach, whatever its own tests say
    const prScopeSeal = sealPrScope(ctx.repoDir, o.intake, ctx.baseSha, head); // PR-BASE (util/base_guard.ts): what a pull request into the recorded target would hold against what this receipt measured; one open note, a cap toward PARTIAL only
    const openNotes = [...prScopeSeal.notes, ...issueNotes, ...proofNotes, ...neverStopNotes(o.implement), ...(allLinesMet ? [] : unfinished), ...proveNotes(ctx.provider, o, process.env, ctx.runDir), ...(allLinesMet && proofRun?.exit === 0 ? twoReaders : (xr?.notes ?? []).filter(isUnmetNote)), ...openDecisionNotes(o), /* one judge for the acceptance lines: when every line is met on evidence from Loki's own passing re-run, a reviewer UNMET (it reads the diff only and cannot see that run) is disclosed on the receipt, not a cap */ ...namedOpen.filter((s) => s.why === null).map(namedUnchangedNote)], verdict3: Verdict = openNotes.length > 0 && verdict3a === "VERIFIED" ? "PARTIAL" : verdict3a; // FALSEVER-OPEN-DECISION: an open either/or the run picked itself, or a behavior change or regression check the run could not settle, is never VERIFIED
    const deepG = deepGaps(o.verify?.risk, vraw, Array.isArray(o.deep?.checks) ? (o.deep.checks as Obj[]) : [], modelReviewRan(xr)), notProven = new Set<string>([...(sealOnlyPass() ? [TIME_RAN_OUT_NOTE] : []), ...deepG.notProven, ...supply.notProven, ...grp.notProven, ...(xr?.notes ?? []), ...reviewReceipt(ctx.provider, xr).notProven, ...openNotes]);
    const reasons: CapReason[] = [], rz = (kind: string, xs: readonly string[]): void => { for (const d of xs) reasons.push({ kind, detail: d }); }; // RW-03: read-only, from the values the verdict above was computed from
    rz("check fails", live.filter((c) => c.result === "fail").map((c) => c.name)); rz("check not run", live.filter((c) => c.result === "not_run").map((c) => c.name)); rz("verify not proven", capVerify.filter((n) => !pinDropped.has(n))); rz("weakened test", weakTests); rz("runner config", capRc);
    if (!proof) rz("no agent-independent proof", [executed ? AGENT_ONLY_REASON : NO_TESTS_REASON]); if (ftpRes && !ftpRes.ok) rz("no fail-then-pass test", [ftpRes.line]); if (wallGreenOnBase) rz("Wall green on base", [WALL_GREEN_ON_BASE_REASON]);
    rz("changed symbol not referenced", leanGap); rz("public function not exercised", pubGap); rz("spec site uncovered", specGap); rz("Wall copy or clause", [...wpAll.notes, ...wpAll.clauseGap]); rz(xr?.level === "block" ? "review block" : "review note", xr?.notes ?? []); rz("open note", openNotes);
    const publish = async (): Promise<StageResult> => {
    { const cu = issueAsks.length ? updateRepoCard({ repoDir: ctx.repoDir, runId: ctx.runId, baseSha: ctx.baseSha, headSha: head, script: (() => { try { return readFileSync(join(ctx.runDir, PROOF_SCRIPT), "utf8"); } catch { return null; } })(), proof: proofRun, checks: (Array.isArray(o.verify?.checks) ? (o.verify!.checks as Obj[]) : []).map((c) => ({ name: String(c.name), cmd: String(c.cmd ?? ""), result: String(c.result) })), needs }) : null; if (cu) ctx.emit("repo.card", "seal", { when: "written", wrote: cu.wrote, facts: cu.facts, setup: cu.setup, ...(cu.why ? { why: cu.why } : {}) }); } // REPO CARD: written at publish, once per run
    const wp = verdict3 === "VERIFIED" && commitWallEnabled() ? wpAll : { files: [], notes: wpAll.notes }, wallKept = verdict3 === "VERIFIED" && !commitWallEnabled() ? wpAll.files : []; // J2: off by default, the sealed copy, its hash and the rerun command stay in the run dir and the receipt for (const n of wp.notes) notProven.add(n); if (verdict3 === "PARTIAL") for (const n of wpAll.clauseGap) notProven.add(n); // FC-VERIFIED-PR-WITHOUT-ITS-TEST: only on VERIFIED, after the receipt's head, tree and diff are fixed
    const wallPub0 = wp.files.length > 0 ? await publishWall(g(ctx), ctx.runId, ctx.repoDir, wp.files, wallDone) : false; if (wp.files.length > 0 && !wallPub0) notProven.add("Wall tests not published (child commit failed or committed bytes differ from the sealed copy)");
    // #238: the Wall proof counts only at the committed path: re-run each published file where the tree holds it, with the runner that owns it. A failure there is NOT PROVEN, named by path, and the verdict is PARTIAL.
    const reproved = wallPub0 ? new RealBaseTestRunner().runEach(ctx.repoDir, wp.files.map((f) => ({ runner: f.runner as RunnerName, path: f.rel })), 2, true) : null, reprovedBad = reproved ? (await reproved).flatMap((r, i) => (r.pass === 1 ? [] : [wp.files[i]!.rel])) : [];
    for (const rel of reprovedBad) { notProven.add(`Wall test fails at its committed path: ${rel}`); reasons.push({ kind: "Wall test fails at its committed path", detail: rel }); } // held_by names this hold too: it is the one publish adds
    if (reprovedBad.length > 0 && !wallDone) { await g(ctx)(["update-ref", "HEAD", "HEAD^"]); await g(ctx)(["read-tree", "HEAD"]); } // drop the child: nothing unproven is published
    const wallPub = wallPub0 && reprovedBad.length === 0, verdict: Verdict = reprovedBad.length > 0 ? "PARTIAL" : verdict3;
    { const sx = o.implement?.sysedit as Obj | undefined, sites = (Array.isArray(sx?.rewrites) ? (sx!.rewrites as Obj[]) : []).map((r) => `${String(r.file)}:${String(r.line)}`); if (sites.length) notProven.add(`completed by rule, no model (LOKI_E10_SYSEDIT; a failing check now passes): ${sites.join(", ")}`); } // a disclosure of lines the run did not write itself, never an input to the verdict
    for (const n of unusedNotes) notProven.add(n);
    for (const n of baseNotes) notProven.add(n);
    if (allLinesMet) for (const n of unfinished) notProven.add(`${n} (outside the issue's acceptance lines, every one of which is met; disclosed, does not cap)`);
    for (const n of proveDisclosures(o)) notProven.add(n); // Q1 PROVE: the tree put back after the prover or its scripts touched it; a disclosure, never a cap
    for (const n of consultNotes(ctx.runDir)) notProven.add(n); // LOKI_E10_OPUS_CONSULT: what each consult cost and said, a disclosure only (the verdict is already decided)
    if (verdict === "VERIFIED") for (const n of wpAll.weak) notProven.add(n); // WALL-ASSERT-STRENGTH: a disclosure on the final VERIFIED verdict only, never an input to it
    if (wallGreenOnBase && verdict === "PARTIAL" && o.intake?.already_satisfied !== true && o.implement?.exit !== "already_done") notProven.add(WALL_GREEN_ON_BASE_REASON);
    if (alreadyDoneClaimed(o) && !alreadyOk && verdict === "PARTIAL") notProven.add(alreadyDoneShown(o, alreadyRun) ? alreadyLinesNote(alreadyLines) : alreadyDoneNotShownNote(alreadyRun)); // ALREADY-DONE-SHOWN: why a run that found the work done is held
    if (!proof && !(wallGreenOnBase && verdict === "ALREADY_SATISFIED") && (verdict === "PARTIAL" || verdict === "VERIFIED" || verdict === "ALREADY_SATISFIED")) { const vc = vraw; notProven.add(executed ? AGENT_ONLY_REASON : vc.length > 0 && vc.every((c) => c.n !== 0 && String(c.reason ?? "").startsWith(UNMEASURED_REASON)) ? UNMEASURED_REASON : vc.length > 0 && vc.every((c) => c.n !== 0 && String(c.reason ?? "").startsWith(UNCONFIRMED_REASON)) ? UNCONFIRMED_REASON : NO_TESTS_REASON); } // an unparsed count is never reported as "no tests executed"
    if (ftpRes && !ftpRes.ok && verdict === "PARTIAL") notProven.add(`${NO_FAIL_THEN_PASS}${ftpRes.line ? `: ${ftpRes.line}` : ""}`); // only when the harness actually ran it and nothing discriminated
    if (wallNotRun > 0) notProven.add(`wall base run not_run: ${wallNotRun}`);
    for (const n of strs(o.wall?.not_proven)) notProven.add(n);
    for (const n of strs(o.fix?.not_proven)) notProven.add(n); // E5: a fix session the harness stopped
    if (typeof o.verify?.wall_failure_tail === "string" && o.verify.wall_passed === false) { const tailFile = basename(o.verify.wall_failure_tail), rel = relative(ctx.repoDir, join(ctx.runDir, tailFile)); notProven.add(`Wall failure output kept: ${rel.startsWith("..") || isAbsolute(rel) ? `.loki/runs/${ctx.runId}/${tailFile}` : rel}`); } // WALL-FAILOUT: names the file only, repo-relative (this line reaches the public PR body); the verdict is already decided
    for (const x of Array.isArray(o.wall?.arbitrated) ? (o.wall!.arbitrated as Obj[]) : []) notProven.add(`Wall assertion arbitrated (${x.kind === "legacy" ? "legacy re-author, no referees, no validation" : "spec clause, two referees"}): ${String(x.check)} test ${String(x.test)}: old assertion ${JSON.stringify(x.old_assertion)} replaced by ${JSON.stringify(x.new_assertion)}; spec quote ${JSON.stringify(x.spec_quote)}${arbCap ? "; verdict capped at PARTIAL" : ""}`); // listed here and capped at PARTIAL above (verdict3): a replacement test body is validated syntactically, not per-test against the base // TEN-COST-09: a skipped Wall is disclosed, never read as passed
    for (const d of Array.isArray(o.wall?.discarded) ? (o.wall!.discarded as Obj[]) : []) notProven.add(`wall test discarded: ${String(d.file)} (${String(d.reason)})`); // FC-23
    for (const d of Array.isArray(o.wall?.not_run_files) ? (o.wall!.not_run_files as Obj[]) : []) notProven.add(`Wall test not executed: ${String(d.file)}: ${String(d.reason)}`); // FC-69: never silent, on the receipt and the console NOT PROVEN line
    if (wallNotRun > 0 && ![...notProven].some((n) => n.startsWith("Wall test not executed:") || n.startsWith("wall test discarded:")) && !(Array.isArray(o.wall?.discarded) && (o.wall!.discarded as unknown[]).length > 0)) notProven.add(`Wall test not executed: ${wallNotRun} file(s), no reason recorded`);
    if (wallNotRun > 0) { // A-103b: wall.ts keeps each sealed copy under runDir/wall; a copy absent from wall.files was discarded (class not_run: no real base result)
      try { const kept = new Set((Array.isArray(o.wall?.files) ? (o.wall!.files as Obj[]) : []).map((f) => basename(String(f.path)))); for (const n of readdirSync(sealedWallDir(ctx.runDir)).sort()) if (!kept.has(n)) notProven.add(`wall test discarded: ${n} (not_run)`); } catch { /* no sealed wall dir: count line only */ }
    }
    if (!diffOk) notProven.add(`${LOKI_OWN_LEAD}diff not computed (git diff-tree failed)`); // RW-03: wording only, the verdict rule is unchanged
    // E-55: any status other than A means the path existed at base_sha (M, D, or T typechange, e.g. a symlink).
    // D50-F2r3: re-run the classifier on the COMMITTED blob (clean filters run at commit) with verify's counts; any mismatch drops verify's labels, "weakened test" stays.
    const dropped = new Set<string>(); const tcs = (o.verify as Obj | undefined)?.["test_counts"] as Obj | undefined;
    const cnt = (x: unknown): { run: number; skipped: number } | undefined => { const c = x as Obj | undefined; return c && typeof c.run === "number" && typeof c.skipped === "number" ? { run: c.run, skipped: c.skipped } : undefined; };
    for (const t of weakTests) {
      notProven.add(`weakened test: ${t}`);
      const vl = verifyNotProven.filter((v) => v.startsWith(`assertion value changed (not shown to be required by the task): ${t}:`)); if (!vl.length) continue;
      const tc = tcs?.[t] as Obj | undefined; const mine = assertDeltaNotes(ctx.repoDir, ctx.baseSha, head, t, str(o.intake?.task) ?? "", cnt(tc?.b), cnt(tc?.h));
      if (!mine || mine.length !== vl.length || mine.some((n) => !vl.includes(n))) for (const v of vl) dropped.add(v);
    }
    for (let i = 0; i + 1 < rawDiff.length; i += 2) { const st = rawDiff[i]!.trim().split(" ").pop() ?? "", f = rawDiff[i + 1]!; if (st === "M" && isTestFile(f) && !weakTests.includes(f)) { const why = weakenExcuse(ctx.repoDir, ctx.baseSha, head, f, loadTaskText(ctx, str(o.intake?.task) ?? undefined)); if (why) notProven.add(`edited test kept uncapped (${why}): ${f}`); } } // FL24-WEAK: an excuse is always on the receipt, never silent
    for (const e of pinEdits) notProven.add(defectPinNote(e));
    for (const v of pinDropped) dropped.add(v);
    if (verdict !== "VERIFIED") for (const f of uncoveredAfterLimit) notProven.add(`changed, untested after limit: ${f}`);
    for (const c of checks) if (c.result === "not_run" && c.repo_skipped !== true) notProven.add(lintGone.includes(c.name) ? `${LINT_MISSING_NOTE}: ${c.name}` : proofOnly.includes(c.name) ? `ran no test in verify, runs in the proof script (a new test gated on the proof's environment; disclosed, does not cap): ${c.name}` : `not run: ${c.name}`); for (const n of repoSkipped) notProven.add(`${SKIPPED_BY_REPO}: ${n}`); // FC-ZERO-ON-BASE: zero on the pristine base too, file untouched: one informational line
    for (const f of strs(o.verify?.flaky)) notProven.add(`flaky test: ${f}`);
    for (const n of verifyNotProven) if (!dropped.has(n)) notProven.add(disclosedSet.has(n) ? n + DECLARED_SUFFIX : n === sysInfo ? n + SYSTEM_INTERP_SUFFIX : n);
    for (const n of rcNotes) notProven.add(disclosedSet.has(n) ? n + DECLARED_SUFFIX : n); for (const n of decl.extra ?? []) notProven.add(n);
    for (const n of fenceRec.notProven) notProven.add(n);
    for (const n of pinnedUpdateNotes(pinnedUpdatesOf(o.implement))) notProven.add(n); // Z2: a reported test update the harness could not check
    for (const n of [...strs(o.commit?.not_proven), ...strs(o.commit?.scope_notes), ...(o.commit?.failed === true ? [`${LOKI_OWN_LEAD}git commit failed: ${str(o.commit?.commit_error) ?? "no error recorded"}`] : [])]) notProven.add(n); // D58: scope_notes = edits flagged outside stated scope (never reverted) or scope undetermined; separate key so they never force FAILED
    for (const id of strs(o.verify?.pre_red)) notProven.add(`pre red: ${id}`); // A-112: listed, never downgrades (not via verifyNotProven)
    if (typeof o.verify?.baseline_line === "string" && strs(o.verify?.pre_red).length) notProven.add(o.verify.baseline_line); // REPOMEM: the one-line pre-existing vs introduced split; listed only when a baseline failure was excused, never downgrades
    for (const n of lintOpenNotes) notProven.add(n); // LINT-OWN
    for (const n of strs(o.verify?.lint_untouched)) notProven.add(`lint red only in files the change did not touch (disclosed, not blocking): ${n}`); // LINT-UNTOUCHED: never silent
    for (const n of strs(o.verify?.not_excused)) notProven.add(n); // why a failing full-suite check was not excused as pre-existing; the check already blocks, this only names the rule
    if (leanGap.length > 0) notProven.add(`${LEAN_NO_SYMBOL}: ${leanGap.join(", ")}`);
    if (pubGap.length > 0) notProven.add(`${UNEXERCISED_PUBLIC}: ${pubGap.join(", ")}`);
    if (specGap.length > 0) notProven.add(`${SPEC_SITE_UNCOVERED}: ${specGap.join(", ")}`);
    if (externalRun(o) && !(Array.isArray(o.wall?.files) && o.wall.files.length > 0)) notProven.add(EXTERNAL_NO_WALL); // FC-EXTERNAL-SEAL-WITHOUT-WALL-VERIFIED
    if (externalRun(o)) notProven.add(EXTERNAL_DIFF_NOT_ISOLATED); // CW-12 B2: the Wall author runs on disk beside the external diff until cw01 confinement covers it
    for (const t of strs(o.implement?.tests_reverted)) notProven.add(`reverted test edit: ${t}`);
    for (const n of turnGuardNote((o.implement?.self_review as SelfReviewRecord | undefined)?.turn_guard)) notProven.add(n); // TG: a review turn taken back for breaking a test that passed before it
    { const sc = o.implement?.scaffold as { path?: unknown } | undefined; if (typeof sc?.path === "string") notProven.add(fragmentNoticeLine(sc.path)); } // L3 fragment writer: a disclosure, never a verdict input
    if (ctx.provider !== "claude") notProven.add("kill blocking not enforced");
    // Section 7: model_override_applied lives on run.started, which outputs() never carries.
    if (process.env["LOKI_MODEL_OVERRIDE"]?.trim() && ctx.provider !== "claude") notProven.add("model override not applied");
    const source = o.intake?.source;
    if (source !== "text" && source !== "issue") notProven.add("task source not recorded by intake");
    // Keys below are outside the section 4 table: absent means NOT PROVEN, never a default claim.
    const repo = str(o.intake?.repo);
    if (mp?.outcome === "no") notProven.add(`Wall tests passed without the fix (mutation proof)${mutCap ? "; verdict downgraded to PARTIAL (LOKI_MUTATION_STRICT=1, declared behavior change)" : ""}`);
    if (repo === null) notProven.add(o.intake && "repo" in o.intake ? "repo identity unknown: the repo has no origin remote (run: git remote add origin <url>)" : "repo not recorded by intake"); // intake wrote repo:null for a repo with no origin; absent means intake never recorded it
    if (typeof o.intake?.resumed !== "boolean") notProven.add("resume state not recorded by intake");
    const pushRefused = secretPushRefusal(o.verify, ctx.runId); if (pushRefused) notProven.add(secretPushLine(pushRefused)); // SECRET-PUSH: the receipt says why the branch stays local

    const stages: Partial<Record<StageName, number>> = {};
    for (const [s, d] of Object.entries(o)) if (typeof d?.duration_s === "number") stages[s as StageName] = d.duration_s;
    const T = hooks.time, time = T ? T.build(ctx, stages, T.firstEventMs(join(ctx.runDir, "events.jsonl"))) : { wall_s: Object.values(stages).reduce((a, b) => a + (b ?? 0), 0), stages }, totalS = T?.reconciled(time) ?? null;
    const iterIds = [...new Set([...Object.values(o).flatMap((d) => [...strs(d?.iteration_ids), ...strs([d?.iteration_id])]), ...(ctx.sessionIds?.() ?? []), ...(xr?.cost_iteration ? [xr.cost_iteration] : [])])]; // a killed or failed stage's data is dropped by the machine, so its sessions come from the launch record
    if (iterIds.length === 0) notProven.add("cost not measured (no iteration ids recorded)");
    const cost = ctx.cost.read(ctx.repoDir, iterIds);
    if (cost.unmetered) notProven.add("cost unmetered (CLI invoker; recorded as 0)");
    // ponytail: events.jsonl is supervisor-written and may lag the worker; the supervisor re-hashes at receipt.sealed if exactness matters
    const eventsPath = join(ctx.runDir, "events.jsonl");
    const wallFiles = Array.isArray(o.wall?.files) ? (o.wall.files as { path: string; sha256: string }[]) : [];
    const wallPassed = typeof o.verify?.wall_passed === "boolean" ? o.verify.wall_passed : null;
    if (wallFiles.length > 0 && wallPassed === null) notProven.add("wall result not recorded by verify");

    // R1-15: router route block. Null (key omitted, hash stable) unless LOKI_ROUTER is on. Route facts come from the implement output when R1-11 records them; token telemetry from the R1-08 result-cost fields (the cost reader's own `router`, else the files).
    const routeBlock = buildRouteBlock(process.env, ctx.provider, (o.implement?.route ?? o.plan?.route_record ?? (routerEnabled(process.env) ? loadRouteRecord(ctx.runDir) : undefined)) as Record<string, unknown> | undefined,
      (cost as { router?: Record<string, number> }).router ?? (routerEnabled(process.env) ? sumResultCosts(join(ctx.repoDir, ".loki"), liveArchivedCosts(join(ctx.repoDir, ".loki"), iterIds, UNMETERED)).router : undefined), ctx.model);
    if (routeBlock) for (const l of routeNotProven(routeBlock)) notProven.add(l);

    const body: Omit<Receipt, "receipt_sha256" | "verification"> = {
      schema: "loki.v10.receipt/1",
      run_id: ctx.runId,
      task: { source: source === "issue" ? "issue" : "text", sha256: str(o.intake?.task_sha256) ?? "" },
      repo: repo ?? "",
      base_sha: ctx.baseSha,
      head_sha: head,
      tree,
      diff_sha256: sha256(diffOk ? diff.stdout : ""),
      wall: { files: wallFiles.map((f) => ({ path: String(f.path), sha256: String(f.sha256) })), passed: wallPassed, ...(typeof o.wall?.manifest_sha256 === "string" && /^[0-9a-f]{64}$/.test(o.wall.manifest_sha256) ? { manifest_sha256: o.wall.manifest_sha256 } : {}) },
      checks,
      not_proven: [],
      ...(verdict !== "VERIFIED" && reasons.length ? { held_by: reasons.map((r) => ({ kind: r.kind, detail: r.detail })) } : {}), // F0: the structured holds that kept the verdict below VERIFIED, as evaluateSeal computed them (absent on a VERIFIED receipt)
      verdict, ...(patchReceipt(o.implement?.patch) ? { patch: patchReceipt(o.implement?.patch)! } : {}), ...(sessionCaps(o).length ? { session_caps: sessionCaps(o) } : {}), ...(typeof o.implement?.limit_s === "number" ? { implement_limit: { limit_s: o.implement.limit_s, elapsed_s: typeof o.implement.elapsed_s === "number" ? o.implement.elapsed_s : 0, ...(o.implement.stop_cause === "max_turns" ? { stop_cause: "max_turns" as const, owner: "harness" as const } : {}) } } : {}), ...(grp.section ? { group: grp.section } : {}), ...(ctx.failovers && ctx.failovers().length > 0 ? { failover: ctx.failovers() } : {}),
      ...(str(o.implement?.spec_conflict_reason) !== null
        ? { spec_conflict_reason: sanitizeReason(str(o.implement?.spec_conflict_reason)!) }
        : {}),
      ...prScopeSeal.receipt, // PR-BASE: target ref, merge base, the pull request's file count and the measured file count, one line (key absent outside PR mode)
      evidence: strs(o.intake?.evidence), ...(strs(o.intake?.assumptions).length > 0 ? { assumptions: strs(o.intake?.assumptions) } : {}),...(o.intake?.preexisting_dirty ? { pre_existing_dirty: Object.keys(o.intake.preexisting_dirty as object) } : {}),
      ...execSpecBlock(ctx),
      cost: {
        usd: cost.usd, input_tokens: cost.inputTokens, output_tokens: cost.outputTokens,
        ...(cost.tokensMeasured && cost.tokensMeasured.k < cost.tokensMeasured.n ? { tokens_measured: cost.tokensMeasured } : {}),
        ...(typeof cost.cacheReadTokens === "number" && cost.cacheReadSeen !== false ? { cache_read_tokens: cost.cacheReadTokens } : {}), ...(typeof cost.cacheCreationTokens === "number" && cost.cacheCreationSeen !== false ? { cache_creation_tokens: cost.cacheCreationTokens } : {}), ...(typeof cost.durationMs === "number" ? { sdk_duration_ms: cost.durationMs } : {}), ...(cost.records ?? {}),
        measured_sessions: cost.measuredCount ?? 0, total_sessions: cost.totalCount ?? 0, partial_usd: cost.partialUsd ?? 0,
        ...(cost.unmetered ? { source: "cli-invoker-unmetered" } : {}), ...(cost.children ? { children: cost.children } : {}),
        ...(Array.isArray(o.fix?.fix_rounds) ? { fix_rounds: o.fix.fix_rounds } : {}), // MW-2: engine-recorded per-round fix_resume + cache_read_tokens, never read from a transcript
      },
      time,
      provider: ctx.provider,
      model: externalRun(o) ? EXTERNAL_MODEL_LABEL : ctx.model, // CW-12 B3: no Loki session wrote this code, so no implementing model is named
      ...(strs(o.wall?.iteration_ids).length ? { wall_oracle: { cost_usd: ctx.cost.read(ctx.repoDir, strs(o.wall?.iteration_ids)).usd, duration_s: typeof o.wall?.duration_s === "number" ? o.wall.duration_s : null } } : {}), // CASCADE-V0: the oracle's own price and time, per run
      ...(cascadeV0On() ? { cascade: (() => { const c = ((o.implement?.attempts ?? {}) as Obj).cascade as Obj | undefined; return c ? { fired: true, from: str(c.from) ?? null, to: str(c.to) ?? null } : { fired: false }; })() } : {}), // CASCADE-V0: whether it escalated, from which model to which
      ...(!externalRun(o) && /^(explicit|default|provider)$/.test(process.env.LOKI_SESSION_MODEL_SOURCE ?? "") ? { model_source: process.env.LOKI_SESSION_MODEL_SOURCE as "explicit" | "default" | "provider" } : {}), // acc-156: who chose the model (explicit flag or env, Loki's default, or the CLI's own default)
      ...(!externalRun(o) ? roleModelsReceiptBlock() : {}), // ROLE-MODELS: { models_by_role } only when a role is set (util/claude_model.ts), so a run with no role keeps its receipt bytes
      ...(externalRun(o) ? { implement: { exit: "external" as const, patch_sha256: str(o.implement?.patch_sha256) ?? "" } } : {}),
      resumed: o.intake?.resumed === true,
      events_sha256: sha256(existsSync(eventsPath) ? readFileSync(eventsPath) : ""),
      ...(await sealEvidence(ctx.repoDir, ctx.runDir, o, notProven, signal, ctx.emit)),
      log_seal: true, toolchain: collectToolchain(), loki_version: getVersion(), // TEN-GATES-22: tool versions that ran the checks, absent tools null; covered by receipt_sha256. loki_version keys the replay of an identical rerun (util/pr_lessons.ts knownVerdict)
      ...receiptBlock(process.env, cost.usd, cost.unmetered === true, totalS),
      ...(reviewReceipt(ctx.provider, xr).review ? { review: reviewReceipt(ctx.provider, xr).review } : {}),
      ...(mp ? { mutation_proof: mp.line, mutation_outcome: mp.outcome, ...(mp.outcome === "yes" && mp.before?.length ? { mutation_before: mp.before } : {}) } : {}), ...conventionsBlock(o), // AWE-2/AWE-3: display-only keys, omitted when absent so other receipts stay byte-stable; verdictOf never reads them
      ...(routeBlock ? { route: routeBlock } : {}), ...(pushRefused ? { push_refused: pushRefused } : {}),
      ...(supply.block ? { supply: supply.block } : {}), ...verifiedReceiptBlock(), // RW-03: present only under LOKI_VERIFIED=1, so every other receipt is byte-stable
      ...pinnedUpdatesBlock(o.implement), ...releaseNoteSkipBlock(o.implement), ...selfReviewReceiptBlock(o.implement), ...releaseRefsReceiptBlock(o.implement), ...(o.implement?.scratch_cleanup ? { scratch_cleanup: o.implement.scratch_cleanup } : {}), ...(issueSt ? { issue_acceptance: issueSt, issue_acceptance_source: listed.length ? "issue" : fallbackLines(o.plan, o.intake).source, issue_acceptance_judge: byRule ? "count of Loki-run checks" : "model reading (no proof run)" } : {}), ...(proofRun ? { proof_rerun: { exit: proofRun.exit, seconds: proofRun.seconds, proved: proofRun.proved, failed: proofRun.failed, stopped: proofRun.stopped, left: proofRun.left, script_chars: proofRun.script_chars, tail: proofRun.tail.slice(-2000) } } : {}), ...(proofBase ? { proof_base: { available: proofBase.available, ...(proofBase.why ? { why: proofBase.why } : {}), seconds: proofBase.seconds, ...(proofBase.cached ? { cached: true } : {}), base_checks: proofBase.base_checks, base_proved: proofBase.base_proved, passing: proofBase.head_proved, also_pass_on_base: proofBase.same_total, lines_with_no_check_of_the_change: baseEmpty, cap: proofBaseCapOn() } } : {}), ...(lineCheck ? { issue_acceptance_check: { model: lineCheck.model, outcome: lineCheck.outcome, usd: lineCheck.usd, calls: lineCheck.calls, input_chars: lineCheck.input_chars, diff_cut: lineCheck.diff_cut, diff_truncated: lineCheck.diff_truncated } } : {}), ...(namedOpen.length ? { named_unchanged: namedOpen.map((s) => ({ symbol: s.symbol, path: s.path, line: s.line, reason: s.why })) } : {}), ...specReceiptBlock(process.env), ...triageReceiptBlock(o.intake), ...unitSpecReceiptBlock(process.env), ...intentRevisionsBlock(ctx.intentRevisions), ...seededCorpusBlock(), ...sealAccuracyBlock(rawDiff.filter((_, i) => i % 2 === 1), checks, ctx.model), ...contextCoverageBlock(o.implement, rawDiff, ctx.repoDir), ...tournamentReceiptBlock(o.implement), ...attemptsReceiptBlock(o.implement), ...nrdReceiptBlock(o.implement), ...envCardReceiptBlock(ctx.runDir), ...proveReceiptBlock(o), // Q1 ENV CARD and PROVE: each only when built // GAME10-03; L022 context recall and precision
    };

    for (const l of sealContract(ctx.repoDir, body, rawDiff, checks, process.env, o.intake?.contract_snapshot as ContractSnapshot | undefined)) notProven.add(l); // D65-SPEC: additive receipt.contract, LOKI_CONTRACT=1 only
    // Sign first so a failed key lands in NOT PROVEN before hashing.
    body.not_proven = [...notProven]; const na = [...new Set([...deepG.notSelected, ...strs(o.verify?.not_applicable)])]; if (na.length) body.not_applicable = na;
    let hash = receiptSha256(body);
    const sig = signReceipt(ctx.runId, hash);
    if (!sig.jwt) {
      body.not_proven = [...notProven, SIGNING_UNAVAILABLE];
      hash = receiptSha256(body);
    }
    const receipt: Receipt = { ...body, receipt_sha256: hash, verification: { jwt: sig.jwt, kid: sig.kid } };

    mkdirSync(ctx.runDir, { recursive: true });
    const path = join(ctx.runDir, "receipt.json");
    atomicWriteText(path, JSON.stringify(receipt, null, 2) + "\n"); // temp + rename: a kill mid-write never leaves a truncated receipt
    atomicWriteText(join(ctx.runDir, "receipt.md"), renderReceiptMd(receipt));

    recordRun(process.env, ctx.repoDir, ranModel(o.implement, ctx.model, o.fix), verdict, cost.usd, cost.unmetered === true, totalS); try { hooks.sealed?.(ctx.runDir, JSON.parse(JSON.stringify(receipt), (_k, v) => (v && typeof v === "object" ? Object.freeze(v) : v))); } catch (e) { process.stderr.write(`ai-bom skipped: ${(e as Error).message}\n`); }
    const signed = sig.jwt !== null;
    const data = { ...(wallPub ? { wall_published: { files: wp.files.map((f) => f.rel), cmds: [...new Set(wp.files.map((f) => f.cmd))] } } : {}), ...(wallKept.length ? { wall_kept: { files: wallKept.map((f) => f.rel), sha256: wallKept.map((f) => createHash("sha256").update(f.bytes).digest("hex")), cmds: [...new Set(wallKept.map((f) => f.cmd))], sealed_dir: sealedWallDir(ctx.runDir) } } : {}), receipt_path: path, receipt_sha256: hash, signed, kid: sig.kid, verdict, not_proven: receipt.not_proven, ...(issueSt ? { issue_acceptance: issueSt.map((s, i) => ({ line: s.line, status: s.status, checks: proofRun?.lines[String(i + 1)]?.proved ?? 0, ...("reason" in s && s.reason ? { reason: s.reason } : {}) })), issue_acceptance_source: listed.length ? "issue" : fallbackLines(o.plan, o.intake).source } : {}), ...(receipt.context ? { context: receipt.context } : {}), ...(mp ? { mutation_line: mp.line } : {}), ...(routeBlock ? { route_line: routePrLine(routeBlock) } : {}) };
    try { recordRunVerdict(ctx.repoDir, ctx.runId, verdict); } catch { /* memory is best-effort */ }
    // v11.7 LESSONS: after the receipt files are final, outside the receipt body (receipt_sha256 is unchanged). Cited only when signed.
    if (process.env["LOKI_AUTO_LEARN_PR"] !== "0") { try { appendReceiptFact(ctx.repoDir, { runId: ctx.runId, verdict, receiptSha256: signed ? hash : null, title: str(ctx.outputs().intake?.title) ?? `run ${ctx.runId}`, headSha: receipt.head_sha, receipt, task: str(o.intake?.task) }); } catch { /* memory is best-effort */ } }
    ctx.emit("receipt.sealed", "seal", { path, receipt_sha256: hash, signed, kid: sig.kid, verdict, not_proven: receipt.not_proven, ...(routeBlock ? { route_line: routePrLine(routeBlock) } : {}) });
    return { status: "completed", data: { ...data, summary: `${verdict} receipt ${hash.slice(0, 12)} ${signed ? `SIGNED kid ${sig.kid}` : "UNSIGNED"}` } };
    };
    return { verdict: verdict3, reasons, notProven: [...notProven], publish };
}
export const stage = sealStage;
