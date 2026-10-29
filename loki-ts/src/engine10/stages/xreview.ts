// B4: opt-in cross-lab review between verify and seal. A second provider reads the committed diff read-only and may only DOWNGRADE the verdict (flag adds NOT PROVEN, block caps at PARTIAL). Off
// unless loki.yaml `review:`, LOKI_REVIEW_PROVIDER or LOKI_XVENDOR_DEFAULT is set; a medium-tier run with none of these reviews with its own CLI (LOKI_REVIEW_PROVIDER=off|none opts out).
import { join } from "node:path";
import { asProvider, isOff, loadReviewStageAgent, reviewCli, reviewProvider, xvendorDefault, type ReviewProvider } from "../../council/role_agents.ts";
export { reviewProvider, xvendorDefault, type ReviewProvider } from "../../council/role_agents.ts"; // re-exported: callers and tests import the review provider pick from here
import { run } from "../../util/shell.ts";
import { withChildLedger } from "../../util/child_ledger.ts";
import { claudeFlagSupported, ensureClaudeHelpCache, leanReviewerFlags, REVIEW_ALLOWLIST_NO_GIT, REVIEW_GUARD_DENYLIST } from "../../providers/claude_flags.ts";
import { ignoredPaths, safeGitRun } from "../../util/safe_git.ts"; export { ignoredPaths }; import { acceptanceLines, acceptancePromptBlock } from "../../util/intent_card.ts";
import { readRiskRecord } from "../../util/run_summary.ts"; import { capWhole, reviewFlagLines } from "../../util/reviewer_brief.ts";
import { writeReviewerCost } from "../../providers/provider_cost.ts";
import { fastTierModel } from "../../runner/model_downgrades.ts";
import { backstopS, type RunContext, type Verdict } from "../types.ts";
export type ReviewLevel = "pass" | "flag" | "block" | "not_run";
export type ReviewedBy = "model" | "deterministic" | "none";
export interface CrossReview { provider: ReviewProvider; level: ReviewLevel; notes: string[]; same_vendor_default?: boolean; hygiene?: string[]; reviewed_by?: ReviewedBy; reviewer_model?: string; cost_iteration?: string; }
/** True only when a model reviewer really returned a verdict; a deterministic-only result never credits "one reviewer". */
export const modelReviewRan = (xr: CrossReview | null | undefined): xr is CrossReview => !!xr && xr.level !== "not_run" && xr.reviewed_by !== "deterministic" && xr.reviewed_by !== "none"; // a hygiene flag can lift level off not_run with no model call (reviewed_by none)
// Compiled or bytecode cache files by extension or dir (generic across stacks). Any other run-added path counts only when the repo's own ignore rules ignore it (it was force-added); legit source such as src/build/index.ts never counts.
const COMPILED_PATHS: RegExp[] = [/(^|\/)__pycache__\//, /\.py[co]$/, /\.class$/, /\.(o|obj)$/];
/** Deterministic hygiene check over paths ADDED by the run (so artifacts already tracked never count). `ignored` = the subset the repo's ignore rules ignore. No model call. */
export const hygieneFindings = (paths: string[], ignored: ReadonlySet<string> = new Set()): string[] => paths.filter((f) => !f.startsWith(".loki/") && (COMPILED_PATHS.some((re) => re.test(f)) || ignored.has(f)));
const RANK: Record<Verdict, number> = { FAILED: 0, SPEC_CONFLICT: 0, PARTIAL: 1, ALREADY_SATISFIED: 2, VERIFIED: 2 };
const MAX_DIFF = 60_000, MAX_NOTES = 5;
/** The never-upgrade rule: returns the lower of the verdict and the review's ceiling. A review can only lower a verdict. */
export function minVerdict(verdict: Verdict, review: CrossReview | null): Verdict {
  const ceiling: Verdict = review?.level === "block" ? "PARTIAL" : verdict;
  return RANK[ceiling] < RANK[verdict] ? ceiling : verdict;
}
/** Exactly what review ran, for the receipt: a model verdict (fast-tier when pinned), the deterministic check alone, or none. */
export const reviewRanWording = (xr: CrossReview | null | undefined): string => (modelReviewRan(xr) ? (xr.reviewer_model ? `reviewer (${xr.reviewer_model})` : "reviewer") : (xr as CrossReview | null | undefined)?.reviewed_by === "deterministic" ? "deterministic check" : "none"); // the guard's false branch narrows xr to never, so the cast restores the real type
/** Receipt review block plus the NOT PROVEN line, only when the flag is on. vendor_differs compares the judge to the builder. */
export function reviewReceipt(builder: string, xr: CrossReview | null, env: NodeJS.ProcessEnv = process.env): { review?: { provider: string | null; vendor_differs: boolean; same_vendor?: boolean; defaulted?: boolean; level?: ReviewLevel; ran?: string; reviewer_model?: string; observations?: string[] }; notProven: string[] } {
  const obs = xr?.hygiene?.length ? { observations: xr.hygiene.map((f) => `committed build or cache artifact: ${f}`) } : {}; // an observation, never a not-proven claim
  if (xr?.same_vendor_default && !xvendorDefault(env)) return { review: { provider: xr.provider, vendor_differs: false, same_vendor: true, defaulted: true, level: xr.level, ran: reviewRanWording(xr), ...obs }, notProven: [] }; // medium default review: same-vendor, disclosed on the receipt
  if (!xvendorDefault(env)) return xr ? { review: { provider: xr.provider, vendor_differs: false, level: xr.level, ran: reviewRanWording(xr), ...obs }, notProven: [] } : { notProven: [] };
  const differs = modelReviewRan(xr) && xr.provider !== builder && (builder === "claude" || builder === "codex"); // a review that did not run is not cross-vendor evidence
  return { review: { provider: xr?.provider ?? null, vendor_differs: differs, ran: reviewRanWording(xr), ...(xr?.reviewer_model ? { reviewer_model: xr.reviewer_model } : {}), ...obs }, notProven: differs ? [] : ["judge shares builder vendor or none configured"] };
}
/** Read-only argv: codex runs in its read-only sandbox; claude gets the shared read-only inspect allowlist and mutation denylist (FC-XREVIEW-BLIND-TOOLS: a blanket Bash deny left it reviewing blind). */
export function reviewArgv(p: ReviewProvider, prompt: string, env: NodeJS.ProcessEnv = process.env, model?: string, flagSupported: (f: string) => boolean = (f) => claudeFlagSupported(f)): string[] {
  const cli = reviewCli(p, env);
  return p === "codex"
    ? [cli, "exec", "--sandbox", "read-only", prompt]
    : [cli, "-p", prompt, ...(model ? ["--model", model] : []), "--allowedTools", REVIEW_ALLOWLIST_NO_GIT, "--disallowedTools", REVIEW_GUARD_DENYLIST, "--permission-mode", "dontAsk", ...leanReviewerFlags({ env, flagSupported, settingSources: "", tools: "Read,Grep,Glob,Bash" }), "--output-format", "json"];
}
/** OC-AGENTS: a configured reviewer or council agent (see council/role_agents.ts) supplies the reviewer persona, its provider and, for a claude judge, its model. None configured: null, behavior unchanged. */
/** FC-XREVIEW-BLIND-TOOLS: tell the reviewer its limits so a sandbox limit is never raised as a concern about the work. */
export const REVIEW_TOOLS_NOTE = "Your tools are Read, Grep, Glob and a read-only shell (cat, ls, grep, rg, find, head, tail, wc). No git commands are available; the diff is in this prompt. You cannot edit files or run project code or tests, so trace behaviour by reading the code. If a tool fails or you could not inspect something, say so plainly in your reasons.";
export function configuredReviewer(repoDir: string, env: NodeJS.ProcessEnv = process.env): { prompt: string; model: string; provider: ReviewProvider | null } | null {
  const a = loadReviewStageAgent(repoDir, env); if (!a) return null;
  return { prompt: a.prompt, model: a.provider === "claude" ? a.model : "", provider: asProvider(a.provider) };
}
const clean = (s: string): string => capWhole(s.replace(/[\x00-\x1f\x7f`]+/g, " "), 600); // FC-PR-BODY-PUBLIC-HYGIENE: whole up to 600 characters, then a word-boundary cut and an ellipsis
/** First line `VERDICT: PASS|FLAG|BLOCK`, then `- reason` lines. Anything else is not_run (never PASS). */
export function parseReview(p: ReviewProvider, out: string): CrossReview {
  if (p === "claude") { try { const j = JSON.parse(out) as { result?: unknown }; out = typeof j?.result === "string" ? j.result : ""; } catch { out = ""; } } // claude runs with --output-format json: the verdict is the result text; anything else is not_run
  const m = /^\s*VERDICT:\s*(PASS|FLAG|BLOCK)\b/im.exec(out);
  if (!m) return { provider: p, level: "not_run", notes: [`cross-review not run: ${p} returned no VERDICT line`] };
  const level = m[1]!.toLowerCase() as ReviewLevel;
  const reasons = reviewFlagLines(out.slice(m.index + m[0].length)).map(clean).filter(Boolean).slice(0, MAX_NOTES);
  const notes = level === "pass" ? [] : (reasons.length ? reasons : ["no reason given"]).map((r) => `cross-review ${level} (${p}): ${r}`);
  return { provider: p, level, notes };
}
// Review time box: 300s (real claude reviews often exceed 60s); LOKI_E10_REVIEW_BOX_S overrides (tests). Seal's limit grows by it when a review is planned.
export const reviewBoxS = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env["LOKI_E10_REVIEW_BOX_S"]); return n > 0 ? n : 300; };
function pickReviewer(ctx: RunContext, agent: ReturnType<typeof configuredReviewer>): { p: ReviewProvider | null; dflt: boolean } {
  const p = reviewProvider(ctx.repoDir, process.env, ctx.provider) ?? agent?.provider ?? null; if (p) return { p, dflt: false };
  const ok = !isOff(process.env["LOKI_REVIEW_PROVIDER"]) && (ctx.provider === "claude" || ctx.provider === "codex") && readRiskRecord(ctx.repoDir, ctx.startedAtMs ?? 0)?.tier === "medium"; // FC-MEDIUM-REVIEWER-UNCREDITED: medium promises "one reviewer", so with nothing configured run the run's own CLI (same vendor); LOKI_REVIEW_PROVIDER=off|none opts out
  return { p: ok ? (ctx.provider as ReviewProvider) : null, dflt: ok };
}
// Box clamped to the time left before the run backstop (minus 25s: seal tail + margin, 30s: diff/help-cache); below MIN_REVIEW_S (a claude review cannot finish sooner) no review runs.
const MIN_REVIEW_S = 30, roomS = (ctx: RunContext): number => backstopS(ctx.capS ?? Infinity) - (ctx.startedAtMs === undefined ? 0 : (ctx.clock?.now() ?? Date.now()) - ctx.startedAtMs) / 1000 - 55, boxFor = (ctx: RunContext): number => Math.min(reviewBoxS(), roomS(ctx));
export const reviewExtraLimitS = (ctx: RunContext): number => (pickReviewer(ctx, configuredReviewer(ctx.repoDir)).p && roomS(ctx) >= MIN_REVIEW_S ? boxFor(ctx) + 30 : 0);
/** Runs the reviewer when enabled. Null when off. A missing CLI, a failure or a timeout is not_run with a NOT PROVEN note, never PASS. */
export async function crossReview(ctx: RunContext, verdict: Verdict, head: string, signal?: AbortSignal): Promise<CrossReview | null> {
  const agent = configuredReviewer(ctx.repoDir), { p, dflt } = pickReviewer(ctx, agent); if (!p) return null; // a configured reviewer/council agent turns the default review on
  if (verdict !== "VERIFIED" && verdict !== "ALREADY_SATISFIED") return null; // nothing a review could downgrade
  const tier = readRiskRecord(ctx.repoDir, ctx.startedAtMs ?? 0)?.tier, medium = tier === "medium";
  let hy: string[] = [], hyOk = false, hyNote = ""; // medium: the deterministic hygiene scan of files the run added (no model call); it can only add a flag, never lift a verdict
  if (medium) { const a = await safeGitRun(ctx.repoDir, ["diff", "--no-color", "--name-only", "-z", "--diff-filter=A", ctx.baseSha, head, "--", ".", ":(exclude).loki"], { timeoutMs: 20000 }).catch(() => null); if (a && a.exitCode === 0) { hyOk = true; const added = a.stdout.split("\0").filter(Boolean); const box = Number(process.env["LOKI_E10_HYGIENE_BOX_MS"]), ig = await ignoredPaths(ctx.repoDir, added, box > 0 ? box : 20000); if (ig) hy = hygieneFindings(added, ig); else { hy = hygieneFindings(added, new Set()); hyOk = false; hyNote = "hygiene scan unavailable (git check-ignore did not complete): NOT PROVEN that run-added files are free of ignored or build artifacts"; } } }
  const pin = medium && p === "claude" ? fastTierModel(process.env) : undefined; // medium reviews on the fast tier (same mapping as the plan session); an agent-configured model wins (agent?.model || pin, so an empty one falls back to the pin); high and low are unchanged
  const tag = <T extends CrossReview>(r: T): T => {
    const modelRan = r.level !== "not_run", level = hy.length && (r.level === "pass" || r.level === "not_run") ? "flag" : r.level;
    return { ...r, level, notes: hyNote ? [...r.notes, hyNote] : r.notes, ...(hy.length ? { hygiene: hy } : {}), reviewed_by: modelRan ? "model" : hyOk ? "deterministic" : "none", ...(modelRan && p === "claude" && (agent?.model || pin) ? { reviewer_model: (agent?.model || pin)! } : {}), ...(dflt ? { same_vendor_default: true } : {}) };
  };
  if (tier === "low") return tag({ provider: p, level: "not_run", notes: [`cross-review skipped: low risk (${p} not run)`] }); // COST-4: low risk records the skip, never a pass
  if (roomS(ctx) < MIN_REVIEW_S) return tag({ provider: p, level: "not_run", notes: [`cross-review not run: insufficient run time for ${p}`] });
  const d = await safeGitRun(ctx.repoDir, ["diff", "--no-color", ctx.baseSha, head, "--", ".", ":(exclude).loki"], { timeoutMs: 20000 }).catch(() => null);
  if (!d || d.exitCode !== 0) return tag({ provider: p, level: "not_run", notes: [`cross-review not run: diff unavailable for ${p}`] });
  const prompt = [agent ? `${agent.prompt}\nReview ONLY the diff below. Do not modify files.` : "You are an independent code reviewer. Review ONLY the diff below for correctness bugs, spec violations and missing tests. Do not modify files.",
    REVIEW_TOOLS_NOTE,
    "Reply with a first line exactly `VERDICT: PASS`, `VERDICT: FLAG` (concerns) or `VERDICT: BLOCK` (a reproduced defect), then one `- reason` line per concern.", ...acceptancePromptBlock(acceptanceLines((ctx.outputs?.() ?? {}).plan)), "", "```diff", d.stdout.slice(0, MAX_DIFF), "```"].join("\n");
  try {
    if (p === "claude") await ensureClaudeHelpCache();
    const r = await withChildLedger(run, join(ctx.repoDir, ".loki"), "xreview")(reviewArgv(p, prompt, process.env, p === "claude" ? agent?.model || pin : undefined), { cwd: ctx.repoDir, timeoutMs: boxFor(ctx) * 1000, group: true, signal });
    const costId = `${ctx.runId}-xreview-${p}`; // the reviewer's own result-cost file, so seal's cost read includes it
    writeReviewerCost(join(ctx.repoDir, ".loki"), costId, { reviewer: `xreview-${p}`, provider: p, model: p === "claude" ? agent?.model || pin : undefined, stdout: r.stdout, stderr: r.stderr });
    if (r.exitCode !== 0) return { ...tag({ provider: p, level: "not_run", notes: [`cross-review not run: ${p} exited ${r.exitCode}`] }), cost_iteration: costId };
    return { ...tag(parseReview(p, r.stdout)), cost_iteration: costId };
  } catch { return tag({ provider: p, level: "not_run", notes: [`cross-review not run: ${p} CLI unavailable`] }); }
}
