// B4: opt-in cross-lab review between verify and seal. A second provider reads the committed diff read-only and may only DOWNGRADE the verdict (flag adds NOT PROVEN, block caps at PARTIAL). Off
// unless loki.yaml `review:`, LOKI_REVIEW_PROVIDER or LOKI_XVENDOR_DEFAULT is set; a medium- or high-tier run with none of these reviews with its own CLI (LOKI_REVIEW_PROVIDER=off|none opts out). L003: this is the run's only review session.
import { join } from "node:path";
import { asProvider, isOff, loadReviewStageAgent, reviewCli, reviewProvider, xvendorDefault, type ReviewProvider } from "../../council/role_agents.ts";
export { reviewProvider, xvendorDefault, type ReviewProvider } from "../../council/role_agents.ts"; // re-exported: callers and tests import the review provider pick from here
import { run } from "../../util/shell.ts";
import { withChildLedger } from "../../util/child_ledger.ts";
import { claudeFlagSupported, ensureClaudeHelpCache, leanReviewerFlags, REVIEW_ALLOWLIST_NO_GIT, REVIEW_GUARD_DENYLIST } from "../../providers/claude_flags.ts";
import { ignoredPaths, safeGitRun } from "../../util/safe_git.ts"; export { ignoredPaths }; import { acceptanceLines, acceptancePromptBlock, issueAcceptanceCapOn, issueAcceptanceOf } from "../../util/intent_card.ts";
import { readRiskRecord } from "../../util/run_summary.ts"; import { capWhole, reviewFlagLines } from "../../util/reviewer_brief.ts";
import { writeReviewerCost } from "../../providers/provider_cost.ts"; import { consultCallFor, type ConsultCall } from "../../features/opus_consult.ts";
import { fastTierModel } from "../../runner/model_downgrades.ts";
import { capToSessionPin } from "../../runner/model_rank.ts";
import { PROVIDER_DEFAULT_MODEL } from "../../util/claude_model.ts";
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
const MAX_NOTES = 5; // the review reads the same diff the acceptance check does (lineCheckDiff, LINE_CHECK_DIFF_MAX): cut at 60,000 characters it never saw the frontend half of a 99,370-character change and reported "no frontend component or page is in the diff" for a UI that was there
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
  const differs = modelReviewRan(xr) && xr.provider !== builder && builder === "claude"; // a review that did not run is not cross-vendor evidence
  return { review: { provider: xr?.provider ?? null, vendor_differs: differs, ran: reviewRanWording(xr), ...(xr?.reviewer_model ? { reviewer_model: xr.reviewer_model } : {}), ...obs }, notProven: differs ? [] : ["judge shares builder vendor or none configured"] };
}
/** Read-only argv: claude gets the shared read-only inspect allowlist and mutation denylist (FC-XREVIEW-BLIND-TOOLS: a blanket Bash deny left it reviewing blind). */
export function reviewArgv(p: ReviewProvider, prompt: string, env: NodeJS.ProcessEnv = process.env, model?: string, flagSupported: (f: string) => boolean = (f) => claudeFlagSupported(f)): string[] {
  const cli = reviewCli(p, env);
  return [cli, "-p", prompt, ...(model ? ["--model", model] : []), "--allowedTools", REVIEW_ALLOWLIST_NO_GIT, "--disallowedTools", REVIEW_GUARD_DENYLIST, "--permission-mode", "dontAsk", ...leanReviewerFlags({ env, flagSupported, settingSources: "", tools: "Read,Grep,Glob,Bash" }), "--output-format", "json"];
}
/** OC-AGENTS: a configured reviewer or council agent (see council/role_agents.ts) supplies the reviewer persona, its provider and, for a claude judge, its model. None configured: null, behavior unchanged. */
/** FC-XREVIEW-BLIND-TOOLS: tell the reviewer its limits so a sandbox limit is never raised as a concern about the work. */
export const REVIEW_TOOLS_NOTE = "Your tools are Read, Grep, Glob and a read-only shell (cat, ls, grep, rg, find, head, tail, wc). No git commands are available; the diff is in this prompt. You cannot edit files or run project code or tests, so trace behaviour by reading the code. If a tool fails or you could not inspect something, say so plainly in your reasons.";
export function configuredReviewer(repoDir: string, env: NodeJS.ProcessEnv = process.env): { prompt: string; model: string; provider: ReviewProvider | null } | null {
  const a = loadReviewStageAgent(repoDir, env); if (!a) return null;
  return { prompt: a.prompt, model: a.provider === "claude" ? a.model : "", provider: asProvider(a.provider) };
}
const clean = (s: string): string => capWhole(s.replace(/[\x00-\x1f\x7f`]+/g, " "), 600); // FC-PR-BODY-PUBLIC-HYGIENE: whole up to 600 characters, then a word-boundary cut and an ellipsis
/** F3 UNMET cap: a reviewer reason that says an asked-for line is unmet (intent_card.ts asks for `- UNMET: <line>`; markdown bold allowed), and the note it becomes.
 *  seal.ts adds every such note to its open notes, which caps VERIFIED at PARTIAL. Levels, when the review runs and its prompt are unchanged. */
const UNMET_REASON_RE = /^\s*\**UNMET\b/;
export const isUnmetNote = (note: string): boolean => /^cross-review \w+ \([^)]*\):\s*\**UNMET\b/.test(note);
/** First line `VERDICT: PASS|FLAG|BLOCK`, then `- reason` lines. Anything else is not_run (never PASS). */
export function parseReview(p: ReviewProvider, out: string): CrossReview {
  if (p === "claude") { try { const j = JSON.parse(out) as { result?: unknown }; out = typeof j?.result === "string" ? j.result : ""; } catch { out = ""; } } // claude runs with --output-format json: the verdict is the result text; anything else is not_run
  const m = /^\s*VERDICT:\s*(PASS|FLAG|BLOCK)\b/im.exec(out);
  if (!m) return { provider: p, level: "not_run", notes: [`cross-review not run: ${p} returned no VERDICT line`] };
  const level = m[1]!.toLowerCase() as ReviewLevel;
  const all = reviewFlagLines(out.slice(m.index + m[0].length)).map(clean).filter(Boolean), unmet = (r: string): boolean => UNMET_REASON_RE.test(r);
  const reasons = [...all.filter(unmet), ...all.filter((r) => !unmet(r))].slice(0, MAX_NOTES); // F3: UNMET reasons first, so the cap of 5 never cuts one
  const notes = level === "pass" ? [] : (reasons.length ? reasons : ["no reason given"]).map((r) => `cross-review ${level} (${p}): ${r}`);
  return { provider: p, level, notes };
}
/** Rule 6 (h2h 2026-11-01, 115 Loki runs): the unconfigured same-vendor review changed no verdict and was 74% of Loki-on-Haiku spend. It stays on by default for the high tier (auth, crypto, payments, migrations, CI, public API: no ready PR there without a review) and is opt-in for medium (LOKI_REVIEW_DEFAULT=1). A configured reviewer (loki.yaml review:, LOKI_REVIEW_PROVIDER, a reviewer agent) always runs. */
export const reviewDefaultOn = (tier: string, env: NodeJS.ProcessEnv = process.env): boolean => tier === "high" || (tier === "medium" && env["LOKI_REVIEW_DEFAULT"] === "1");
// Review time box: 300s (real claude reviews often exceed 60s); LOKI_E10_REVIEW_BOX_S overrides (tests). Seal's limit grows by it when a review is planned.
export const reviewBoxS = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env["LOKI_E10_REVIEW_BOX_S"]); return n > 0 ? n : 300; };
function pickReviewer(ctx: RunContext, agent: ReturnType<typeof configuredReviewer>): { p: ReviewProvider | null; dflt: boolean } {
  const p = reviewProvider(ctx.repoDir, process.env, ctx.provider) ?? agent?.provider ?? null; if (p) return { p, dflt: false };
  const ok = reviewDefaultOn(String(readRiskRecord(ctx.repoDir, ctx.startedAtMs ?? 0)?.tier)) && !isOff(process.env["LOKI_REVIEW_PROVIDER"]) && ctx.provider === "claude"; // FC-MEDIUM-REVIEWER-UNCREDITED + L003: with nothing configured, high (and medium with LOKI_REVIEW_DEFAULT=1) runs the run's own CLI as the one reviewer; otherwise "one reviewer" stays on NOT PROVEN (never credited); LOKI_REVIEW_PROVIDER=off|none opts out
  return { p: ok ? (ctx.provider as ReviewProvider) : null, dflt: ok };
}
// Box clamped to the time left before the run backstop (minus 25s: seal tail + margin, 30s: diff/help-cache); below MIN_REVIEW_S (a claude review cannot finish sooner) no review runs.
const MIN_REVIEW_S = 30, roomS = (ctx: RunContext): number => backstopS(ctx.capS ?? Infinity) - (ctx.startedAtMs === undefined ? 0 : (ctx.clock?.now() ?? Date.now()) - ctx.startedAtMs) / 1000 - 55, boxFor = (ctx: RunContext): number => Math.min(reviewBoxS(), roomS(ctx));
export const reviewExtraLimitS = (ctx: RunContext): number => (pickReviewer(ctx, configuredReviewer(ctx.repoDir)).p && roomS(ctx) >= MIN_REVIEW_S ? boxFor(ctx) + 30 : 0);
// Q1 ISSUE-ACCEPTANCE line check: ONE tool-less, single-turn call (features/opus_consult.ts consultCallFor: no tools, strict MCP config) on an issue run
// with an acceptance list, before the seal cap. Input: the numbered verbatim lines, the diff (capped at LINE_CHECK_DIFF_MAX characters; lockfile,
// snapshot and generated-file sections are cut first, then the tail), the changed files, verify's checks by name and result, and the implement
// session's final reply. Output per line: `MET <n>: <evidence>` or `UNMET <n>: <reason>`; anything else for a line is not addressed.
export const LINE_CHECK_HEAD = "Loki acceptance line check.";
export const LINE_CHECK_SYSTEM = "You check a code change against an issue's acceptance lines. You have no tools: read only what is below. Answer for every numbered line, one line each, nothing else.";
export const LINE_CHECK_DIFF_MAX = 240_000; // a 9-item feature diff ran to 127K characters; at 60K the check never saw the UI half
const CUT_FIRST = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.snap$|(^|\/)__snapshots__\/|(^|\/)(dist|build|generated)\/|\.min\.(js|css)$|\.generated\./;
/** The diff for the check: whole file sections, the cut-first ones dropped before anything else, then the rest cut at `max` characters. */
export function lineCheckDiff(diff: string, max = LINE_CHECK_DIFF_MAX): { text: string; cut: string[]; truncated: boolean } {
  const parts = diff.split(/(?=^diff --git )/m), cut: string[] = [];
  const kept = parts.filter((p) => { const m = /^diff --git a\/(\S+)/.exec(p); if (m && CUT_FIRST.test(m[1]!)) { cut.push(m[1]!); return false; } return true; }).join("");
  return { text: kept.slice(0, max), cut, truncated: kept.length > max };
}
export function lineCheckPrompt(asks: string[], diff: string, files: string[], checks: { name: string; result: string }[], reply: string, facts: string[] = []): string {
  return [LINE_CHECK_HEAD, "The issue's acceptance lines (verbatim):", ...asks.map((a, i) => `${i + 1}. ${a}`),
    "For every number write exactly one line: `MET <n>: <evidence>` when the change delivers that line, or `UNMET <n>: <reason>` when it does not. A MET with no evidence counts as not delivered.",
    "What counts as evidence. A line that asks for behavior (a feature, an endpoint, a page, a fix, performance) is MET only when both hold: the diff contains the code for it, and it was exercised: either a check in the list below passes that covers it, or the session's reply shows the command or request it ran against the running product and what came back. Code that was written but never run is `UNMET <n>: not proved by running`. A line that asks for a page or other user interface is MET when its page or component is in the diff, its own tests pass in the check list, and the requests it sends (the exact paths in the client code) were proved against the running product; say in the evidence that no browser was used. A line that asks only for documentation or for tests needs the file in the diff (and, for tests, a passing check that ran them). When the facts below include Loki's own re-run of the proof script, only that run counts as proof from running: a behavior line is MET only if that run's real output shows it proved (and the script really sends the request or runs the command for it), or a passing check covers it; what the reply says about its own earlier runs is not evidence. A claim in the reply with no command and result beside it is never evidence. If the diff changes how records are created or stored (a migration, a new column, a new table) and nothing shows a new record being created through the product's own code after the change, the lines that depend on it are UNMET.",
    ...(facts.length ? [`Facts recorded by Loki itself (not by the session):\n${facts.join("\n")}`] : []),
    `Changed files:\n${files.join("\n") || "(none)"}`, `Checks run by verify (name: result):\n${checks.map((c) => `${c.name}: ${c.result}`).join("\n") || "(none)"}`,
    `The implement session's final reply:\n${reply.slice(-16000) || "(none)"}`, "```diff", diff, "```"].join("\n\n");
}
/** The per-line answers, or null when no line parses. A MET with an empty evidence phrase is not counted as met. */
export function parseLineCheck(text: string | null, n: number): { met: number[]; unmet: number[]; evidence: Record<string, string>; reasons: Record<string, string> } | null {
  if (!text) return null;
  const met: number[] = [], unmet: number[] = [], evidence: Record<string, string> = {}, reasons: Record<string, string> = {};
  for (const l of text.split("\n")) {
    const x = /^\s*(?:[-*+]\s+)?\**(UNMET|MET)\**\s+(\d{1,3})\s*[:.-]?\s*(.*)$/i.exec(l); if (!x) continue;
    const k = Number(x[2]), why = x[3]!.replace(/[\x00-\x1f\x7f`]+/g, " ").trim().slice(0, 300); if (k < 1 || k > n || unmet.includes(k)) continue; // a number answered twice: an UNMET wins (the model corrected itself), so the label fails closed
    if (x[1]!.toUpperCase() === "MET" && why) { if (!met.includes(k)) { met.push(k); evidence[String(k)] = why; } } else { const i = met.indexOf(k); if (i >= 0) { met.splice(i, 1); delete evidence[String(k)]; } unmet.push(k); reasons[String(k)] = why || "MET with no evidence"; }
  }
  return met.length + unmet.length ? { met: met.sort((a, b) => a - b), unmet: unmet.sort((a, b) => a - b), evidence, reasons } : null;
}
export interface LineCheckRecord { model: string; outcome: string; usd: number | null; calls: number; input_chars: number; diff_cut: string[]; diff_truncated: boolean; marks?: { met: number[]; unmet: number[] }; evidence?: Record<string, string>; reasons?: Record<string, string>; not_reviewed?: string }
let lineCheckOverride: ConsultCall | null = null;
/** TEST SEAM: replace the line check call. Production code must never call this. */
export function __setLineCheckCallForTests(c: ConsultCall | null): void { lineCheckOverride = c; }
export const lineCheckModel = (ctxModel: string | undefined, env: NodeJS.ProcessEnv = process.env): string => (env["LOKI_E10_ISSUE_ACCEPTANCE_MODEL"] ?? "").trim() || (ctxModel && /^claude-/.test(ctxModel) ? ctxModel : ctxModel && /^(opus|sonnet|haiku)$/.test(ctxModel) ? `claude-${ctxModel}-5-5` : "claude-sonnet-5-5"); // the label judge runs on the run's own model (an alias is mapped), never silently on a weaker one
/** Runs the check once, and once more when no line parses; a call that cannot run or still parses nothing records not_reviewed (the seal caps on it). */
export async function issueLineCheck(ctx: RunContext, asks: string[], head: string, checks: { name: string; result: string }[], reply: string, facts: string[] = []): Promise<LineCheckRecord> {
  const model = lineCheckModel(ctx.model);
  const d = await safeGitRun(ctx.repoDir, ["diff", "--no-color", ctx.baseSha, head, "--", ".", ":(exclude).loki"], { timeoutMs: 20000 }).catch(() => null);
  const n = await safeGitRun(ctx.repoDir, ["diff", "--name-only", ctx.baseSha, head, "--", ".", ":(exclude).loki"], { timeoutMs: 20000 }).catch(() => null);
  if (!d || d.exitCode !== 0) return { model, outcome: "no_diff", usd: null, calls: 0, input_chars: 0, diff_cut: [], diff_truncated: false, not_reviewed: "the diff could not be read" };
  const cd = lineCheckDiff(d.stdout), prompt = lineCheckPrompt(asks, cd.text, (n?.stdout ?? "").split("\n").filter(Boolean), checks, reply, facts);
  const call = lineCheckOverride ?? consultCallFor(model, join(ctx.repoDir, ".loki"), process.env, 120_000, { maxTokens: 2500, thinking: "off" });
  let usd: number | null = null, calls = 0, outcome = "failed", parsed: ReturnType<typeof parseLineCheck> = null;
  for (let i = 0; i < 2 && !parsed; i++) {
    let r: { text: string | null; usd: number | null; outcome: string }; try { r = await call(LINE_CHECK_SYSTEM, prompt, "issue-acceptance"); } catch { r = { text: null, usd: null, outcome: "transport" }; }
    calls++; outcome = r.outcome; if (typeof r.usd === "number") usd = (usd ?? 0) + r.usd; parsed = parseLineCheck(r.text, asks.length);
  }
  const base = { model, outcome, usd, calls, input_chars: LINE_CHECK_SYSTEM.length + prompt.length, diff_cut: cd.cut, diff_truncated: cd.truncated };
  return parsed ? { ...base, marks: { met: parsed.met, unmet: parsed.unmet }, evidence: parsed.evidence, reasons: parsed.reasons } : { ...base, not_reviewed: outcome === "ok" ? "the check returned no answer for any line" : `the check call did not complete (${outcome})` };
}
/** One list for every judge: the issue's own acceptance lines when the issue has them (and the check is on), else the plan card's lines. */
const reviewAcceptance = (ctx: RunContext): string[] => { const o = ctx.outputs?.() ?? {}, il = issueAcceptanceCapOn() ? issueAcceptanceOf(o.intake) : []; return il.length ? il : acceptanceLines(o.plan); };
/** What verify already ran, so a reviewer with no tools never marks a line unmet only because it could not run the tests itself. */
const reviewChecksBlock = (ctx: RunContext): string[] => { const cs = (ctx.outputs?.() ?? {}).verify?.checks; const rows = Array.isArray(cs) ? (cs as Record<string, unknown>[]).map((c) => `${String(c.name)}: ${String(c.result)}`).slice(0, 200) : []; return rows.length ? ["", "Checks the harness already ran on this change (name: result). Do not flag a line only because you could not run a test yourself; use these results:", ...rows] : []; };
/** Runs the reviewer when enabled. Null when off. A missing CLI, a failure or a timeout is not_run with a NOT PROVEN note, never PASS. */
/** REVIEW-THEN-FIX (LOKI_E10_REVIEW_FIX, default on, =0 opts out): the same independent review, run once DURING an issue run's implement stage, so a
 *  reproduced defect is handed back to the session while it can still fix it. At the seal the review can only downgrade: a run with every acceptance item
 *  met was sealed PARTIAL on two defects the reviewer found (a documented quoted-phrase search rejected by input validation, a documented date filter that
 *  did nothing) that the session would have fixed in minutes. */
export const reviewFixOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_REVIEW_FIX"] ?? "").trim());
export async function crossReview(ctx: RunContext, verdict: Verdict, head: string, signal?: AbortSignal, early = false): Promise<CrossReview | null> {
  // early: no risk record exists yet (verify writes it), so the reviewer is the configured one, else the run's own CLI; `head` is a tree of the uncommitted change
  const agent = configuredReviewer(ctx.repoDir), picked = pickReviewer(ctx, agent), earlyP = early && !picked.p && ctx.provider === "claude" && !isOff(process.env["LOKI_REVIEW_PROVIDER"]) ? (ctx.provider as ReviewProvider) : null;
  const p = picked.p ?? earlyP, dflt = picked.p ? picked.dflt : earlyP !== null; if (!p) return null; // a configured reviewer/council agent turns the default review on
  if (verdict !== "VERIFIED" && verdict !== "ALREADY_SATISFIED") return null; // nothing a review could downgrade
  const tier = early ? "high" : readRiskRecord(ctx.repoDir, ctx.startedAtMs ?? 0)?.tier, medium = tier === "medium";
  let hy: string[] = [], hyOk = false, hyNote = ""; // medium: the deterministic hygiene scan of files the run added (no model call); it can only add a flag, never lift a verdict
  if (medium) { const a = await safeGitRun(ctx.repoDir, ["diff", "--no-color", "--name-only", "-z", "--diff-filter=A", ctx.baseSha, head, "--", ".", ":(exclude).loki"], { timeoutMs: 20000 }).catch(() => null); if (a && a.exitCode === 0) { hyOk = true; const added = a.stdout.split("\0").filter(Boolean); const box = Number(process.env["LOKI_E10_HYGIENE_BOX_MS"]), ig = await ignoredPaths(ctx.repoDir, added, box > 0 ? box : 20000); if (ig) hy = hygieneFindings(added, ig); else { hy = hygieneFindings(added, new Set()); hyOk = false; hyNote = "hygiene scan unavailable (git check-ignore did not complete): NOT PROVEN that run-added files are free of ignored or build artifacts"; } } }
  const pin = medium && p === "claude" ? fastTierModel(process.env) : dflt && p === "claude" && ctx.model && ctx.model !== PROVIDER_DEFAULT_MODEL ? capToSessionPin(ctx.model) : undefined; // medium reviews on the fast tier (same mapping as the plan session); the unconfigured high-tier default review runs on the run's own model, never above a LOKI_SESSION_MODEL pin (a Haiku run reviews on Haiku); the provider-default label is a record, never a --model value (the CLI rejects it and the review exited 1), so a default-model run omits --model; an agent-configured model wins (agent?.model || pin, so an empty one falls back to the pin)
  const tag = <T extends CrossReview>(r: T): T => {
    const modelRan = r.level !== "not_run", level = hy.length && (r.level === "pass" || r.level === "not_run") ? "flag" : r.level;
    return { ...r, level, notes: hyNote ? [...r.notes, hyNote] : r.notes, ...(hy.length ? { hygiene: hy } : {}), reviewed_by: modelRan ? "model" : hyOk ? "deterministic" : "none", ...(modelRan && p === "claude" && (agent?.model || pin) ? { reviewer_model: (agent?.model || pin)! } : {}), ...(dflt ? { same_vendor_default: true } : {}) };
  };
  if (tier === "low") return tag({ provider: p, level: "not_run", notes: [`cross-review skipped: low risk (${p} not run)`] }); // COST-4: low risk records the skip, never a pass
  if (roomS(ctx) < MIN_REVIEW_S) return tag({ provider: p, level: "not_run", notes: [`cross-review not run: insufficient run time for ${p}`] });
  const d = await safeGitRun(ctx.repoDir, ["diff", "--no-color", ctx.baseSha, head, "--", ".", ":(exclude).loki"], { timeoutMs: 20000 }).catch(() => null);
  if (!d || d.exitCode !== 0) return tag({ provider: p, level: "not_run", notes: [`cross-review not run: diff unavailable for ${p}`] });
  const rd = lineCheckDiff(d.stdout), changedList = [...d.stdout.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]!).slice(0, 80).join(", ");
  const prompt = [agent ? `${agent.prompt}\nReview ONLY the diff below. Do not modify files.` : "You are an independent code reviewer. Review ONLY the diff below for correctness bugs, spec violations and missing tests. Do not modify files.",
    REVIEW_TOOLS_NOTE,
    "Reply with a first line exactly `VERDICT: PASS`, `VERDICT: FLAG` (concerns) or `VERDICT: BLOCK` (a reproduced defect), then one `- reason` line per concern.", ...acceptancePromptBlock(reviewAcceptance(ctx)), ...reviewChecksBlock(ctx), ...(rd.truncated || rd.cut.length ? [`The diff below is NOT the whole change: ${rd.truncated ? "it is cut at its end" : "it is complete except for the files named next"}${rd.cut.length ? `; lockfile, snapshot and generated files are left out (${rd.cut.slice(0, 8).join(", ")})` : ""}. Every changed file is listed here; read any you need with your tools before saying something is missing: ${changedList}`] : []), "", "```diff", rd.text, "```"].join("\n");
  try {
    if (p === "claude") await ensureClaudeHelpCache();
    const r = await withChildLedger(run, join(ctx.repoDir, ".loki"), "xreview")(reviewArgv(p, prompt, process.env, p === "claude" ? agent?.model || pin : undefined), { cwd: ctx.repoDir, timeoutMs: boxFor(ctx) * 1000, group: true, signal });
    const costId = `${ctx.runId}-xreview-${p}${early ? "-early" : ""}`; // the reviewer's own result-cost file, so seal's cost read includes it
    writeReviewerCost(join(ctx.repoDir, ".loki"), costId, { reviewer: `xreview-${p}`, provider: p, model: p === "claude" ? agent?.model || pin : undefined, stdout: r.stdout, stderr: r.stderr });
    if (r.exitCode !== 0) return { ...tag({ provider: p, level: "not_run", notes: [`cross-review not run: ${p} exited ${r.exitCode}`] }), cost_iteration: costId };
    return { ...tag(parseReview(p, r.stdout)), cost_iteration: costId };
  } catch { return tag({ provider: p, level: "not_run", notes: [`cross-review not run: ${p} CLI unavailable`] }); }
}
