// E-10: commit and Seal (docs/v10/ENGINE.md sections 4, 9). Writes receipt.json and receipt.md, computes receipt_sha256, and signs natively with node:crypto Ed25519 (A-121; no python, no
// `cryptography`). The key is the A-120 local key, created on first use. An empty token means UNSIGNED, never presented as attested.
import { wallDropped } from "../../util/wall_owned.ts";
import { sanitizeReason } from "../../util/redact.ts";
import { specReceiptBlock } from "../../util/spec_file.ts"; import { staleAtSeal, staleReason } from "../../util/steer.ts"; import { seededCorpusBlock, intentRevisionsBlock, sealAccuracyBlock } from "../../util/run_outputs.ts";
import { createHash } from "node:crypto"; import { unitSpecReceiptBlock } from "../../features/speed/unit_mode.ts";
import { chmodSync, existsSync, readdirSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path"; import { aiTrailers } from "../pr_body.ts";
import { mutationEnabled, mutationProof, mutationStrict } from "../../util/mutation_proof.ts";
import { RealBaseTestRunner } from "./wall.ts";
import { assertDeltaNotes } from "../../e10ext/assert_delta.ts"; import { runnerConfigNotes } from "../../features/runner_config.ts";
import { discardIfSatisfied } from "../../e10ext/discard.ts";
import { dropSet, formatChanged, parseStaged } from "../../e10ext/commit_filter.ts";
import { flagOutsideScope } from "../../e10ext/scope.ts";
import { canonicalJson, collectToolchain, kidOf, loadSigningKey, signReceipt } from "../../util/receipt_signer.ts";
import { appendReceiptFact, recordRunVerdict } from "../../util/pr_lessons.ts";
import { sealEvidence } from "../../features/visual_evidence.ts";
import { isTestFile } from "../testmap.ts";
import { crossReview, minVerdict, modelReviewRan, reviewExtraLimitS, reviewReceipt } from "./xreview.ts";
import { STAGE_BUDGETS, type RunnerName, type Obj, type Receipt, type ReceiptCheck, type RunContext, type Stage, type StageName, type StageResult, type Verdict } from "../types.ts";
import { buildRouteBlock, routeNotProven, routePrLine, routeReceiptLines } from "../../runner/router/route_block.ts";
import { loadRouteRecord } from "../../runner/router/route_record.ts";
import { ranModel, receiptBlock, recordRun } from "../../runner/router/cost_preview.ts";
import { routerEnabled } from "../../runner/router/flag.ts";
import { liveArchivedCosts, sumResultCosts, UNMETERED } from "../cost.ts";
import { checkProvenance, checkResultLabel, SKIPPED_BY_REPO, publishableWall, publishWall, wallChild, deepGaps, hasExecutedProof, hasExogenousProof, changedSymbols, symbolGap, isExecutedProof, CODE_FILE_EXT, NO_TESTS_REASON, type ProvenanceCtx, UNCONFIRMED_REASON, UNMEASURED_REASON } from "../../util/check_result.ts";
import { type ContractSnapshot, sealContract } from "../../features/contract.ts";
import { capGroupVerdict, sealGroup } from "../../features/speed/seal_group.ts";
import { readDeclared, supplyGuard, supplyVerdict } from "../../supply/supply_guard.ts";
import { hooks } from "../hooks.ts";
import { atomicWriteText } from "../../util/atomic.ts";
import { collapseNotProven } from "../../util/term_width.ts";
import { type SafeGitKeep, safeGitRun } from "../../util/safe_git.ts"; import { addedSymlinkNotes, splitDeclaredAdvisories } from "../../util/base_guard.ts"; import { readPlanScope } from "../../util/run_cap.ts";

export const SIGNING_UNAVAILABLE = "receipt signing unavailable (no usable signing key: invalid key or unwritable ~/.loki/keys)", AGENT_ONLY_REASON = "only agent-authored tests executed (no agent-independent proof)", WALL_GREEN_ON_BASE_REASON = "Wall green on base: no Wall test discriminates the change"; // TEN-GATES-02

const EXCLUDE_LOKI = ":(exclude).loki";
export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
export const EXTERNAL_MODEL_LABEL = "external (no Loki implement session)", EXTERNAL_DIFF_NOT_ISOLATED = "Wall author not filesystem-isolated from the external diff", EXTERNAL_NO_WALL = "external diff sealed with no Wall file that ran; the only checks are the repo's existing tests"; // CW-12 B2/B3
const externalRun = (o: Partial<Record<StageName, Record<string, unknown>>>): boolean => o.implement?.exit === "external";
export const LEAN_NO_SYMBOL = "no passing check references a changed symbol and no Wall file ran";
/** FC-LEAN-VERIFIED-WITHOUT-CHANGED-SYMBOL: with no Wall file that ran (and no already-satisfied claim), the changed code is exercised only if a passing pre-existing test source names a symbol the diff declares or modifies. Returns the unreferenced symbols; empty when a Wall ran, the run is external (its own rule), the diff has no non-test code file, or a test references one. */
async function leanSymbolGap(ctx: RunContext, o: Partial<Record<StageName, Obj>>, rawDiff: string[], head: string, vraw: Obj[]): Promise<string[]> {
  if (externalRun(o) || (Array.isArray(o.wall?.files) && o.wall.files.length > 0) || o.intake?.already_satisfied === true || o.implement?.exit === "already_done") return [];
  const code: string[] = [];
  for (let i = 0; i + 1 < rawDiff.length; i += 2) { const st = rawDiff[i]!.trim().split(" ").pop() ?? "", f = rawDiff[i + 1]!; if (st !== "D" && CODE_FILE_EXT.test(f) && !isTestFile(f)) code.push(f); }
  if (code.length === 0) return [];
  const d = await safeGitRun(ctx.repoDir, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", ctx.baseSha, head, "--", ...code], { timeoutMs: 20000 });
  if (d.exitCode !== 0) return [];
  const sources: string[] = [];
  for (const c of vraw) if (isExecutedProof(c as { result?: unknown; n?: unknown })) { const n = String(c.name ?? ""), p = n.slice(n.indexOf(":") + 1); if (n.includes(":") && isTestFile(p)) try { sources.push(readFileSync(join(ctx.repoDir, p), "utf8")); } catch { /* unreadable test: contributes no reference */ } }
  return symbolGap(changedSymbols(d.stdout), sources);
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
async function git(ctx: RunContext, args: string[], keep: SafeGitKeep = {}): Promise<{ out: string; code: number }> {
  const r = await safeGitRun(ctx.repoDir, args, { timeoutMs: 20000, ...keep });
  return { out: r.stdout, code: r.exitCode };
}

/** MARK-1: the receipt path relative to the repo, for the Loki-Receipt trailer; falls back to the standard run location. */
const receiptRel = (ctx: RunContext): string => { const r = relative(ctx.repoDir, join(ctx.runDir, "receipt.json")); return r.startsWith("..") || isAbsolute(r) ? `.loki/runs/${ctx.runId}/receipt.json` : r; };

/** Section 4 Commit: `git add -A` minus .loki/, Wall files and stray lockfiles, commit `loki: <title>` with a Loki-Run trailer. An empty diff commits nothing (head stays at base). */
export const commitStage: Stage = {
  name: "commit",
  ...STAGE_BUDGETS.commit,
  async run(ctx: RunContext): Promise<StageResult> {
    // A-104/G2: stage all, unstage .loki/, Wall files (sealed under runDir/wall) and a NEW lockfile with no manifest change in its own directory (judged against baseSha).
    if (!ctx.baseSha || (await git(ctx, ["rev-parse", "--verify", "-q", `${ctx.baseSha}^{commit}`])).code !== 0) return { status: "failed", data: {}, reason: "base commit not resolvable" }; // A-104b r2: fail closed, every later reset and diff is judged against the base
    if ((await git(ctx, ["add", "-A", "--", "."], { repoDrivers: true })).code !== 0) return { status: "failed", data: {}, reason: "git add failed" };
    const sd = await git(ctx, ["diff", "--cached", "--name-status", "--no-renames", "-z", ctx.baseSha]); if (sd.code !== 0) return { status: "failed", data: {}, reason: "git diff against base failed" };
    const staged = parseStaged(sd.out);
    const drop = dropSet(ctx.repoDir, staged, ctx.outputs().intake?.preexisting_dirty, process.env, ctx.outputs().intake?.install_created, ctx.outputs().intake?.preexisting_untracked_blobs);
    const sat = await discardIfSatisfied((a) => git(ctx, a), ctx.baseSha, ctx.outputs(), staged, new Set(drop.filter(({ st }) => st === "L").map(({ f }) => f)), ctx.repoDir); if (sat) return sat; // D50-F1
    if (drop.length > 0 && (await git(ctx, ["--literal-pathspecs", "reset", "-q", ctx.baseSha, "--", ...drop.map(({ f }) => f)])).code !== 0) return { status: "failed", data: {}, reason: "git reset failed" }; // A-104b: reset to the run base (not HEAD) so a path committed in implement leaves the diff too; literal, so ":(top)x" is a filename
    const dropped = new Set(drop.map(({ f }) => f)), fmt = formatChanged(ctx.repoDir, staged, dropped); // TEN-QUALITY-16: only the run's own kept files
    if (fmt.length > 0) await git(ctx, ["--literal-pathspecs", "add", "--", ...fmt], { repoDrivers: true }); // re-stage what the repo's formatter rewrote
    const notes = flagOutsideScope(ctx.outputs(), staged.filter(({ f }) => !dropped.has(f))); // D76: advisory, nothing is reverted
    if ((await git(ctx, ["diff", "--cached", "--quiet"])).code === 0) return { status: "completed", data: { committed: false, scope_notes: notes } };
    const title = (str(ctx.outputs().intake?.title) ?? `run ${ctx.runId}`).split("\n")[0]!.slice(0, 72);
    const c = await git(ctx, ["commit", "-q", "-m", `loki: ${title}`, "-m", [`Loki-Run: ${ctx.runId}`, ...aiTrailers({ runId: ctx.runId, provider: ctx.provider, model: externalRun(ctx.outputs()) ? EXTERNAL_MODEL_LABEL : ctx.model, receiptRel: receiptRel(ctx) })].join("\n")], { repoDrivers: true, userHooks: true });
    if (c.code !== 0) return { status: "failed", data: {}, reason: "git commit failed" };
    return { status: "completed", data: { committed: true, head_sha: (await git(ctx, ["rev-parse", "HEAD"])).out.trim(), scope_notes: notes } };
  },
};

// Stage outputs read by seal. Only keys in the ENGINE.md section 4 table (plus duration_s from section 5) are trusted; any other key seal reads puts a "not recorded" entry on NOT PROVEN when absent, so a producer cannot silently shape the receipt.
export const wallGreenOnBaseOf = (o: Partial<Record<StageName, Obj>>): boolean => { const b = (o.wall?.base_run ?? {}) as Obj; return typeof b.pass === "number" && b.pass > 0 && b.fail === 0 && (typeof b.not_run === "number" ? b.not_run : 0) === 0; }; // D42 (3)/B1 (r2): green only with real passes, no failure, no not_run; shared by seal, wall.ts runWall
export function verdictOf(o: Partial<Record<StageName, Obj>>, checks: ReceiptCheck[], emptyDiff: boolean, verifyNotProven: boolean, wallGreenOnBase: boolean, proof: boolean, targetProof = false, uncovered: string[] = [], leanGap: string[] = []): Verdict {
  const exit = o.implement?.exit, wd = wallDropped(o as never).length > 0;
  // FC-16: no success verdict without a Loki-executed check with n>0 and a pass; otherwise PARTIAL (NOT PROVEN, "no tests executed").
  if (o.commit?.failed !== true && strs(o.commit?.not_proven).length === 0 && (o.intake?.already_satisfied === true || exit === "already_done")) return (proof || wallGreenOnBase) && o.wall?.reproduction_green_on_base !== true ? "ALREADY_SATISFIED" : "PARTIAL"; // FC-VACUOUS-WALL-GREEN: a Wall green on base proves a claim, never makes the claim itself; GAME10-08b: recorded runtime evidence the Wall did not reproduce is never "already satisfied"
  if (exit === "spec_conflict") return "SPEC_CONFLICT"; if (o.commit?.failed === true || strs(o.commit?.not_proven).length > 0) return "FAILED"; // r3: an unrestored user file is never a clean verdict; A-104b r2: a failed commit never seals VERIFIED
  // Section 2: an empty diff without the LOKI_ALREADY_DONE marker is FAILED, never VERIFIED.
  if (emptyDiff) return "FAILED";
  // FC-21b (1): a limit-killed implement is VERIFIED only when the harness itself ran every check green, a Wall or task-named test passed with n>0 (targetProof), and the limit was recorded.
  if (exit === "killed") return typeof o.implement?.limit_s === "number" && targetProof && uncovered.length === 0 && proof && !wallGreenOnBase && !verifyNotProven && !wd && checks.length > 0 && checks.every((c) => c.result === "pass") ? "VERIFIED" : "PARTIAL";
  if (typeof o.implement?.limit_s === "number") return "PARTIAL"; // A1: a limit that did not kill the session (an error or a throw) is never a clean verdict
  if (checks.some((c) => c.result === "fail")) return "FAILED";
  // E-98a B1: verify's own NOT PROVEN (e.g. a system interpreter) downgrades too -- never a silent VERIFIED.
  if (exit === "external" && !(Array.isArray(o.wall?.files) && o.wall.files.length > 0)) return "PARTIAL"; // FC-EXTERNAL-SEAL-WITHOUT-WALL-VERIFIED: an external diff has no watched implement session, so with no Wall file that ran it is never VERIFIED
  if (leanGap.length > 0) return "PARTIAL"; // FC-LEAN-VERIFIED-WITHOUT-CHANGED-SYMBOL: no Wall file ran and no passing check references a changed symbol, so nothing exercised the change
  if (wd || exit === "killed" || checks.length === 0 || checks.some((c) => c.result !== "pass") || verifyNotProven || !proof || wallGreenOnBase) return "PARTIAL"; // FC-VACUOUS-WALL-GREEN: a Wall green on base discriminates nothing, so a changed tree is never VERIFIED on it
  return "VERIFIED";
}

/** FC-21b: verify's target_checks (Wall and task-named relevant tests) names a test that ran n>0 and passed; read from verify's raw checks, never from prose. */
export function targetProofOf(v: Obj | undefined): boolean {
  const names = new Set(strs(v?.target_checks)), raw = Array.isArray(v?.checks) ? (v.checks as Obj[]) : [];
  return raw.some((c) => names.has(String(c.name)) && hasExecutedProof([c]));
}

function checksOf(v: unknown, pc: ProvenanceCtx, preRed: readonly string[] = [], repoSkipped: readonly string[] = []): ReceiptCheck[] { // TEN-GATES-02: each check carries who authored its evidence (additive key)
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is Obj => !!c && typeof c === "object").map((c) => ({
    name: String(c.name ?? ""),
    cmd: String(c.cmd ?? ""),
    result: c.result === "pass" || c.result === "fail" ? c.result : "not_run",
    duration_s: typeof c.duration_s === "number" ? c.duration_s : 0, provenance: checkProvenance(String(c.name ?? ""), pc), ...(typeof c.n === "number" ? { n: c.n } : {}), ...(typeof c.count === "string" ? { count: c.count } : {}), ...(c.result === "fail" && preRed.includes(String(c.name ?? "")) ? { pre_red: true as const } : {}), ...(c.result !== "pass" && c.result !== "fail" && repoSkipped.includes(String(c.name ?? "")) ? { repo_skipped: true as const } : {}), // pre_red (FC-PR-BODY-PUBLIC-HYGIENE); n: TEN-GATES-03-F1 verify --require-exogenous counts only executed proof (n > 0); additive like provenance
  }));
}

export function renderReceiptMd(r: Receipt): string {
  const sig = r.verification.jwt ? `SIGNED (kid ${r.verification.kid})` : "UNSIGNED", ln = (c: ReceiptCheck): string => `- ${checkResultLabel(c.result, c.pre_red === true, c.repo_skipped === true)}: ${c.name} (\`${c.cmd}\`, ${c.duration_s}s)`, sec = (h: string, cs: ReceiptCheck[]): string[] => [h, ...(cs.length ? cs.map(ln) : ["- none"])], indep = (c: ReceiptCheck): boolean => c.provenance === "exogenous" || c.provenance === "independent"; // TEN-GATES-02: a receipt without provenance keeps the single Checks section
  // E-69: never $0.00 for an unpriced run; "partial" when some but not all sessions were priced.
  const usd = r.cost.usd !== null
    ? `$${r.cost.usd.toFixed(4)}`
    : r.cost.measured_sessions > 0
      ? `partial: $${r.cost.partial_usd.toFixed(4)} for ${r.cost.measured_sessions} of ${r.cost.total_sessions} sessions`
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

export const sealStage: Stage = {
  name: "seal",
  ...STAGE_BUDGETS.seal,
  extraLimitS: (c) => reviewExtraLimitS(c), // lazy: xreview and seal import each other transitively
  async run(ctx: RunContext, signal?: AbortSignal): Promise<StageResult> {
    const o = ctx.outputs(), stale = staleAtSeal(ctx.repoDir, ctx); if (stale.length) return { status: "failed", data: { stale_wall_revisions: stale.map((r) => r.rev) }, reason: staleReason(stale) };
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
    // A-119: any edit, delete or rename (--no-renames shows D plus A) of a pre-existing test file is NOT VERIFIED, same as verify's own notes.
    const rawDiff = diffOk ? diff.stdout.split("\0").filter(Boolean) : [], pctx: ProvenanceCtx = { addedFiles: rawDiff.flatMap((m, i) => (i % 2 === 0 && m.trim().split(" ").pop() === "A" && rawDiff[i + 1] ? [rawDiff[i + 1]!] : [])), wallFiles: Array.isArray(o.wall?.files) ? (o.wall.files as Obj[]).map((f) => String(f.path)) : [], modifiedFiles: rawDiff.flatMap((m, i) => (i % 2 === 0 && m.trim().split(" ").pop() !== "A" && rawDiff[i + 1] && isTestFile(rawDiff[i + 1]!) ? [rawDiff[i + 1]!] : [])) }, checks = checksOf(o.verify?.checks, pctx, preRedChecks, repoSkipped); // TEN-GATES-02: A = added in this run
    const weakTests: string[] = [];
    for (let i = 0; i + 1 < rawDiff.length; i += 2) if ((rawDiff[i]!.trim().split(" ").pop() ?? "") !== "A" && isTestFile(rawDiff[i + 1]!)) weakTests.push(rawDiff[i + 1]!);
    const rcNotes = diffOk ? [...runnerConfigNotes(ctx.repoDir, ctx.baseSha, head, rawDiff.filter((_, i) => i % 2 === 1), signal), ...addedSymlinkNotes(rawDiff, str(o.plan?.plan))] : []; // D86 FC-09: runner config or a file it loads changed
    // Class C: an advisory for a change the plan declared, or a link a passing Wall requires, is disclosed (suffix below), never a cap; any undeclared change keeps capping.
    const vraw = Array.isArray(o.verify?.checks) ? (o.verify.checks as Obj[]) : []; const decl = splitDeclaredAdvisories([...rcNotes, ...verifyNotProven], { repoDir: ctx.repoDir, runDir: ctx.runDir, baseSha: ctx.baseSha, rawDiff, planFiles: readPlanScope(ctx.runDir), wallPaths: wallRel, wallPassedN: o.verify?.wall_passed === true && vraw.some((c) => c.result === "pass" && typeof c.n === "number" && c.n > 0 && wallRel.some((w) => String(c.name).endsWith(`:${w}`) || String(c.name).includes(w))) });
    const disclosedSet = new Set(decl.disclosed), capRc = rcNotes.filter((n) => !disclosedSet.has(n)), capVerify = verifyNotProven.filter((n) => !disclosedSet.has(n)); const DECLARED_SUFFIX = " (declared by the plan or required by the passing Wall; disclosed, does not cap)";
    const grp = sealGroup(ctx.runDir, receiptSha256 as never); // D61-13: inert without group/manifest.json
    const executed = hasExecutedProof(vraw), proof = process.env["LOKI_EXOGENOUS_PROOF"] === "0" ? executed : hasExogenousProof(vraw, pctx); // FC-16: executed n>0 pass from verify's raw checks (a Wall green on base proves only a claim, inside verdictOf); TEN-GATES-02 (D104): that pass must be agent-independent (LOKI_EXOGENOUS_PROOF=0 opts out)
    const uncoveredAfterLimit = o.implement?.exit === "killed" ? strs(o.verify?.uncovered_changed) : []; // FC-21b: changed code no passing impacted check covered; limit path only
    const leanGap = diffOk ? await leanSymbolGap(ctx, o, rawDiff, head, vraw) : []; // FC-LEAN-VERIFIED-WITHOUT-CHANGED-SYMBOL
    const verdict0 = capGroupVerdict(verdictOf(o, checks.filter((c) => !(c.result === "fail" && preRedChecks.includes(c.name)) && c.repo_skipped !== true), !diffOk || diff.stdout === "", capVerify.length > 0 || weakTests.length > 0 || capRc.length > 0, wallGreenOnBase, proof, targetProofOf(o.verify), uncoveredAfterLimit, leanGap), grp);

    // T10: supply-chain guard. A nonexistent new dependency blocks VERIFIED (a too-new one only warns unless LOKI_SUPPLY_MIN_AGE_DAYS is set); an unreachable registry only records NOT PROVEN.
    const supply = await supplyGuard(ctx.repoDir, rawDiff.filter((_, i) => i % 2 === 1), readDeclared(ctx.repoDir), process.env);
    const verdict1: Verdict = supplyVerdict(verdict0, supply);
    const xr = await crossReview(ctx, verdict1, head, signal), verdict2 = minVerdict(verdict1, xr); // B4: opt-in second-provider review, downgrade only
    // T2: mutation proof always runs after VERIFIED. "no" (Wall passed without the fix) warns; it downgrades to PARTIAL only with LOKI_MUTATION_STRICT=1 AND a plan-declared behavior change (never a harness heuristic). "yes" and inconclusive never change the verdict.
    const mp = verdict2 === "VERIFIED" && mutationEnabled() ? mutationProof({ repoDir: ctx.repoDir, baseSha: ctx.baseSha, runDir: ctx.runDir, wallFiles: Array.isArray(o.wall?.files) ? (o.wall.files as { path: string }[]) : [], checks: Array.isArray(o.verify?.checks) ? (o.verify.checks as { name: string }[]) : [], runner: (ms: number) => new RealBaseTestRunner(undefined, ms) }) : null;
    const verdict3: Verdict = (mp?.outcome === "no" && mutationStrict() && o.plan?.behavior_change === true) ? "PARTIAL" : verdict2; // FC-69: a Wall test that did not execute is disclosed (not_proven), never a verdict downgrade (CTO ruling; D95 THIN)
    const deepG = deepGaps(o.verify?.risk, vraw, Array.isArray(o.deep?.checks) ? (o.deep.checks as Obj[]) : [], modelReviewRan(xr)), notProven = new Set<string>([...deepG.notProven, ...supply.notProven, ...grp.notProven, ...(xr?.notes ?? []), ...reviewReceipt(ctx.provider, xr).notProven]);
    const wp = verdict3 === "VERIFIED" ? publishableWall(ctx.repoDir, ctx.runDir, o) : { files: [], notes: [] }; for (const n of wp.notes) notProven.add(n); // FC-VERIFIED-PR-WITHOUT-ITS-TEST: only on VERIFIED, after the receipt's head, tree and diff are fixed
    const wallPub0 = wp.files.length > 0 ? await publishWall(g(ctx), ctx.runId, ctx.repoDir, wp.files, wallDone) : false; if (wp.files.length > 0 && !wallPub0) notProven.add("Wall tests not published (child commit failed or committed bytes differ from the sealed copy)");
    // #238: the Wall proof counts only at the committed path: re-run each published file where the tree holds it, with the runner that owns it. A failure there is NOT PROVEN, named by path, and the verdict is PARTIAL.
    const reproved = wallPub0 ? new RealBaseTestRunner().runEach(ctx.repoDir, wp.files.map((f) => ({ runner: f.runner as RunnerName, path: f.rel })), 2) : null, reprovedBad = reproved ? (await reproved).flatMap((r, i) => (r.pass === 1 ? [] : [wp.files[i]!.rel])) : [];
    for (const rel of reprovedBad) notProven.add(`Wall test fails at its committed path: ${rel}`);
    if (reprovedBad.length > 0 && !wallDone) { await g(ctx)(["update-ref", "HEAD", "HEAD^"]); await g(ctx)(["read-tree", "HEAD"]); } // drop the child: nothing unproven is published
    const wallPub = wallPub0 && reprovedBad.length === 0, verdict: Verdict = reprovedBad.length > 0 ? "PARTIAL" : verdict3;
    if (wallGreenOnBase && verdict === "PARTIAL" && o.intake?.already_satisfied !== true && o.implement?.exit !== "already_done") notProven.add(WALL_GREEN_ON_BASE_REASON);
    if (!proof && !(wallGreenOnBase && verdict === "ALREADY_SATISFIED") && (verdict === "PARTIAL" || verdict === "VERIFIED" || verdict === "ALREADY_SATISFIED")) { const vc = vraw; notProven.add(executed ? AGENT_ONLY_REASON : vc.length > 0 && vc.every((c) => c.n !== 0 && String(c.reason ?? "").startsWith(UNMEASURED_REASON)) ? UNMEASURED_REASON : vc.length > 0 && vc.every((c) => c.n !== 0 && String(c.reason ?? "").startsWith(UNCONFIRMED_REASON)) ? UNCONFIRMED_REASON : NO_TESTS_REASON); } // an unparsed count is never reported as "no tests executed"
    if (wallNotRun > 0) notProven.add(`wall base run not_run: ${wallNotRun}`);
    for (const n of [...strs(o.wall?.not_proven), ...wallDropped(o as never)]) notProven.add(n); // TEN-COST-09: a skipped Wall is disclosed, never read as passed
    for (const d of Array.isArray(o.wall?.discarded) ? (o.wall!.discarded as Obj[]) : []) notProven.add(`wall test discarded: ${String(d.file)} (${String(d.reason)})`); // FC-23
    for (const d of Array.isArray(o.wall?.not_run_files) ? (o.wall!.not_run_files as Obj[]) : []) notProven.add(`Wall test not executed: ${String(d.file)}: ${String(d.reason)}`); // FC-69: never silent, on the receipt and the console NOT PROVEN line
    if (wallNotRun > 0 && ![...notProven].some((n) => n.startsWith("Wall test not executed:") || n.startsWith("wall test discarded:")) && !(Array.isArray(o.wall?.discarded) && (o.wall!.discarded as unknown[]).length > 0)) notProven.add(`Wall test not executed: ${wallNotRun} file(s), no reason recorded`);
    if (wallNotRun > 0) { // A-103b: wall.ts keeps each sealed copy under runDir/wall; a copy absent from wall.files was discarded (class not_run: no real base result)
      try { const kept = new Set((Array.isArray(o.wall?.files) ? (o.wall!.files as Obj[]) : []).map((f) => basename(String(f.path)))); for (const n of readdirSync(join(ctx.runDir, "wall")).sort()) if (!kept.has(n)) notProven.add(`wall test discarded: ${n} (not_run)`); } catch { /* no sealed wall dir: count line only */ }
    }
    if (!diffOk) notProven.add("diff not computed (git diff-tree failed)");
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
    if (verdict !== "VERIFIED") for (const f of uncoveredAfterLimit) notProven.add(`changed, untested after limit: ${f}`);
    for (const c of checks) if (c.result === "not_run" && c.repo_skipped !== true) notProven.add(`not run: ${c.name}`); for (const n of repoSkipped) notProven.add(`${SKIPPED_BY_REPO}: ${n}`); // FC-ZERO-ON-BASE: zero on the pristine base too, file untouched: one informational line
    for (const f of strs(o.verify?.flaky)) notProven.add(`flaky test: ${f}`);
    for (const n of verifyNotProven) if (!dropped.has(n)) notProven.add(disclosedSet.has(n) ? n + DECLARED_SUFFIX : n);
    for (const n of rcNotes) notProven.add(disclosedSet.has(n) ? n + DECLARED_SUFFIX : n);
    for (const n of [...strs(o.commit?.not_proven), ...strs(o.commit?.scope_notes)]) notProven.add(n); // D58: scope_notes = edits flagged outside stated scope (never reverted) or scope undetermined; separate key so they never force FAILED
    for (const id of strs(o.verify?.pre_red)) notProven.add(`pre red: ${id}`); // A-112: listed, never downgrades (not via verifyNotProven)
    if (typeof o.verify?.baseline_line === "string" && strs(o.verify?.pre_red).length) notProven.add(o.verify.baseline_line); // REPOMEM: the one-line pre-existing vs introduced split; listed only when a baseline failure was excused, never downgrades
    if (leanGap.length > 0) notProven.add(`${LEAN_NO_SYMBOL}: ${leanGap.join(", ")}`);
    if (externalRun(o) && !(Array.isArray(o.wall?.files) && o.wall.files.length > 0)) notProven.add(EXTERNAL_NO_WALL); // FC-EXTERNAL-SEAL-WITHOUT-WALL-VERIFIED
    if (externalRun(o)) notProven.add(EXTERNAL_DIFF_NOT_ISOLATED); // CW-12 B2: the Wall author runs on disk beside the external diff until cw01 confinement covers it
    for (const t of strs(o.implement?.tests_reverted)) notProven.add(`reverted test edit: ${t}`);
    if (ctx.provider !== "claude") notProven.add("kill blocking not enforced");
    // Section 7: model_override_applied lives on run.started, which outputs() never carries.
    if (process.env["LOKI_MODEL_OVERRIDE"]?.trim() && ctx.provider !== "claude") notProven.add("model override not applied");
    const source = o.intake?.source;
    if (source !== "text" && source !== "issue") notProven.add("task source not recorded by intake");
    // Keys below are outside the section 4 table: absent means NOT PROVEN, never a default claim.
    const repo = str(o.intake?.repo);
    if (mp?.outcome === "no") notProven.add(`Wall tests passed without the fix (mutation proof)${verdict !== verdict2 ? "; verdict downgraded to PARTIAL (LOKI_MUTATION_STRICT=1, declared behavior change)" : ""}`);
    if (repo === null) notProven.add(o.intake && "repo" in o.intake ? "repo identity unknown: the repo has no origin remote (run: git remote add origin <url>)" : "repo not recorded by intake"); // intake wrote repo:null for a repo with no origin; absent means intake never recorded it
    if (typeof o.intake?.resumed !== "boolean") notProven.add("resume state not recorded by intake");

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
      verdict, ...(typeof o.implement?.limit_s === "number" ? { implement_limit: { limit_s: o.implement.limit_s, elapsed_s: typeof o.implement.elapsed_s === "number" ? o.implement.elapsed_s : 0, ...(o.implement.stop_cause === "max_turns" ? { stop_cause: "max_turns" as const, owner: "harness" as const } : {}) } } : {}), ...(grp.section ? { group: grp.section } : {}), ...(ctx.failovers && ctx.failovers().length > 0 ? { failover: ctx.failovers() } : {}),
      ...(str(o.implement?.spec_conflict_reason) !== null
        ? { spec_conflict_reason: sanitizeReason(str(o.implement?.spec_conflict_reason)!) }
        : {}),
      evidence: strs(o.intake?.evidence), ...(o.intake?.preexisting_dirty ? { pre_existing_dirty: Object.keys(o.intake.preexisting_dirty as object) } : {}),
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
      ...(externalRun(o) ? { implement: { exit: "external" as const, patch_sha256: str(o.implement?.patch_sha256) ?? "" } } : {}),
      resumed: o.intake?.resumed === true,
      events_sha256: sha256(existsSync(eventsPath) ? readFileSync(eventsPath) : ""),
      ...(await sealEvidence(ctx.repoDir, ctx.runDir, o, notProven, signal, ctx.emit)),
      log_seal: true, toolchain: collectToolchain(), // TEN-GATES-22: tool versions that ran the checks, absent tools null; covered by receipt_sha256
      ...receiptBlock(process.env, cost.usd, cost.unmetered === true, totalS),
      ...(reviewReceipt(ctx.provider, xr).review ? { review: reviewReceipt(ctx.provider, xr).review } : {}),
      ...(mp ? { mutation_proof: mp.line, mutation_outcome: mp.outcome } : {}),
      ...(routeBlock ? { route: routeBlock } : {}),
      ...(supply.block ? { supply: supply.block } : {}),
      ...specReceiptBlock(process.env), ...unitSpecReceiptBlock(process.env), ...intentRevisionsBlock(ctx.intentRevisions), ...seededCorpusBlock(), ...sealAccuracyBlock(rawDiff.filter((_, i) => i % 2 === 1), checks, ctx.model), // GAME10-03
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
    const data = { ...(wallPub ? { wall_published: { files: wp.files.map((f) => f.rel), cmds: [...new Set(wp.files.map((f) => f.cmd))] } } : {}), receipt_path: path, receipt_sha256: hash, signed, kid: sig.kid, verdict, not_proven: receipt.not_proven, ...(mp ? { mutation_line: mp.line } : {}), ...(routeBlock ? { route_line: routePrLine(routeBlock) } : {}) };
    try { recordRunVerdict(ctx.repoDir, ctx.runId, verdict); } catch { /* memory is best-effort */ }
    // v11.7 LESSONS: after the receipt files are final, outside the receipt body (receipt_sha256 is unchanged). Cited only when signed.
    if (process.env["LOKI_AUTO_LEARN_PR"] !== "0") { try { appendReceiptFact(ctx.repoDir, { runId: ctx.runId, verdict, receiptSha256: signed ? hash : null, title: str(ctx.outputs().intake?.title) ?? `run ${ctx.runId}`, headSha: receipt.head_sha }); } catch { /* memory is best-effort */ } }
    ctx.emit("receipt.sealed", "seal", { path, receipt_sha256: hash, signed, kid: sig.kid, verdict, not_proven: receipt.not_proven, ...(routeBlock ? { route_line: routePrLine(routeBlock) } : {}) });
    return { status: "completed", data: { ...data, summary: `${verdict} receipt ${hash.slice(0, 12)} ${signed ? `SIGNED kid ${sig.kid}` : "UNSIGNED"}` } };
  },
};
export const stage = sealStage;
