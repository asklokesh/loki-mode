// B4: opt-in cross-lab review between verify and seal. A second provider reads the committed diff
// read-only and may only DOWNGRADE the verdict (flag adds NOT PROVEN, block caps at PARTIAL).
// Off unless loki.yaml `review:`, LOKI_REVIEW_PROVIDER or LOKI_XVENDOR_DEFAULT is set; a medium-tier run with none of these reviews with its own CLI (LOKI_REVIEW_PROVIDER=off|none opts out).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReviewStageAgent } from "../../council/role_agents.ts";
import { run } from "../../util/shell.ts";
import { withChildLedger } from "../../util/child_ledger.ts";
import { claudeFlagSupported, ensureClaudeHelpCache, leanReviewerFlags } from "../../providers/claude_flags.ts";
import { safeGitRun } from "../../util/safe_git.ts"; import { acceptanceLines, acceptancePromptBlock } from "../../util/intent_card.ts";
import { readRiskRecord } from "../../util/run_summary.ts";
import { backstopS, type RunContext, type Verdict } from "../types.ts";
export type ReviewProvider = "codex" | "claude";
export type ReviewLevel = "pass" | "flag" | "block" | "not_run";
export interface CrossReview { provider: ReviewProvider; level: ReviewLevel; notes: string[]; same_vendor_default?: boolean; }
const RANK: Record<Verdict, number> = { FAILED: 0, SPEC_CONFLICT: 0, PARTIAL: 1, ALREADY_SATISFIED: 2, VERIFIED: 2 };
const MAX_DIFF = 60_000, MAX_NOTES = 5;
/** The never-upgrade rule: returns the lower of the verdict and the review's ceiling. A review can only lower a verdict. */
export function minVerdict(verdict: Verdict, review: CrossReview | null): Verdict {
  const ceiling: Verdict = review?.level === "block" ? "PARTIAL" : verdict;
  return RANK[ceiling] < RANK[verdict] ? ceiling : verdict;
}
const asProvider = (v: string | undefined): ReviewProvider | null => { const s = v?.trim().toLowerCase(); return s === "codex" || s === "claude" ? s : null; }; const isOff = (v: string | undefined): boolean => /^(off|none|false|0)$/i.test(v?.trim() ?? "");
/** Explicit setting: env wins over loki.yaml top-level `review:`. A provider, "off", or undefined (nothing set). */
function explicitReview(repoDir: string, env: NodeJS.ProcessEnv): ReviewProvider | "off" | undefined {
  const flag = xvendorDefault(env); // explicit off is only meaningful (and only honoured) with the flag on; off keeps the pre-XV-1 behaviour
  const ev = env["LOKI_REVIEW_PROVIDER"], e = asProvider(ev); if (e) return e; if (flag && isOff(ev)) return "off";
  for (const f of ["loki.yaml", "loki.yml"]) {
    const p = join(repoDir, f); if (!existsSync(p)) continue;
    try { const m = /^review:[ \t]*["']?([A-Za-z]+)["']?[ \t]*(?:#.*)?$/m.exec(readFileSync(p, "utf8")); const v = asProvider(m?.[1]); if (v) return v; if (flag && isOff(m?.[1])) return "off"; } catch { /* unreadable: nothing set */ }
  }
  return undefined;
}
/** XV-1 flag: LOKI_XVENDOR_DEFAULT=1 turns on the other-vendor default. Off keeps the opt-in behaviour. */
export const xvendorDefault = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes|on)$/i.test(env["LOKI_XVENDOR_DEFAULT"]?.trim() ?? "");
/** The CLI for a provider is on PATH (same resolution as engine10/preflight.ts: LOKI_<NAME>_CLI override, else the provider name). */
export const reviewCli = (p: ReviewProvider, env: NodeJS.ProcessEnv = process.env): string => env[`LOKI_${p.toUpperCase()}_CLI`]?.trim() || p;
export function vendorAvailable(p: ReviewProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  const cli = reviewCli(p, env);
  return !!Bun.which(cli, { PATH: env["PATH"] ?? process.env["PATH"] ?? "" });
}
/** Explicit setting always wins (including `off`). With LOKI_XVENDOR_DEFAULT=1 and nothing set, the other vendor than the builder when its CLI is installed. Else null (off). */
export function reviewProvider(repoDir: string, env: NodeJS.ProcessEnv = process.env, builder?: string): ReviewProvider | null {
  const x = explicitReview(repoDir, env); if (x) return x === "off" ? null : x;
  if (!xvendorDefault(env)) return null;
  const other: ReviewProvider | null = builder === "claude" ? "codex" : builder === "codex" ? "claude" : null;
  return other && vendorAvailable(other, env) ? other : null;
}
/** Receipt review block plus the NOT PROVEN line, only when the flag is on. vendor_differs compares the judge to the builder. */
export function reviewReceipt(builder: string, xr: CrossReview | null, env: NodeJS.ProcessEnv = process.env): { review?: { provider: string | null; vendor_differs: boolean; same_vendor?: boolean; defaulted?: boolean; level?: ReviewLevel }; notProven: string[] } {
  if (xr?.same_vendor_default && !xvendorDefault(env)) return { review: { provider: xr.provider, vendor_differs: false, same_vendor: true, defaulted: true, level: xr.level }, notProven: [] }; // medium default review: same-vendor, disclosed on the receipt
  if (!xvendorDefault(env)) return { notProven: [] };
  const differs = !!xr && xr.level !== "not_run" && xr.provider !== builder && (builder === "claude" || builder === "codex"); // a review that did not run is not cross-vendor evidence
  return { review: { provider: xr?.provider ?? null, vendor_differs: differs }, notProven: differs ? [] : ["judge shares builder vendor or none configured"] };
}
/** Read-only argv: codex runs in its read-only sandbox; claude gets read tools only with writers and shell denied. */
export function reviewArgv(p: ReviewProvider, prompt: string, env: NodeJS.ProcessEnv = process.env, model?: string, flagSupported: (f: string) => boolean = (f) => claudeFlagSupported(f)): string[] {
  const cli = reviewCli(p, env);
  return p === "codex"
    ? [cli, "exec", "--sandbox", "read-only", prompt]
    : [cli, "-p", prompt, ...(model ? ["--model", model] : []), "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Write,Edit,NotebookEdit,Bash", ...leanReviewerFlags({ env, flagSupported }), "--output-format", "json"];
}
/** OC-AGENTS: a configured reviewer or council agent (see council/role_agents.ts) supplies the reviewer persona, its provider and, for a claude judge, its model. None configured: null, behavior unchanged. */
export function configuredReviewer(repoDir: string, env: NodeJS.ProcessEnv = process.env): { prompt: string; model: string; provider: ReviewProvider | null } | null {
  const a = loadReviewStageAgent(repoDir, env); if (!a) return null;
  return { prompt: a.prompt, model: a.provider === "claude" ? a.model : "", provider: asProvider(a.provider) };
}
const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f`]+/g, " ").trim().slice(0, 300);
/** First line `VERDICT: PASS|FLAG|BLOCK`, then `- reason` lines. Anything else is not_run (never PASS). */
export function parseReview(p: ReviewProvider, out: string): CrossReview {
  if (p === "claude") { try { const j = JSON.parse(out) as { result?: unknown }; out = typeof j?.result === "string" ? j.result : ""; } catch { out = ""; } } // claude runs with --output-format json: the verdict is the result text; anything else is not_run
  const m = /^\s*VERDICT:\s*(PASS|FLAG|BLOCK)\b/im.exec(out);
  if (!m) return { provider: p, level: "not_run", notes: [`cross-review not run: ${p} returned no VERDICT line`] };
  const level = m[1]!.toLowerCase() as ReviewLevel;
  const reasons = out.slice(m.index + m[0].length).split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "")).filter((l) => l.trim() !== "").map(clean).filter(Boolean).slice(0, MAX_NOTES);
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
  const agent = configuredReviewer(ctx.repoDir), { p, dflt } = pickReviewer(ctx, agent); if (!p) return null; const tag = <T extends CrossReview>(r: T): T => (dflt ? { ...r, same_vendor_default: true } : r); // a configured reviewer/council agent turns the default review on
  if (verdict !== "VERIFIED" && verdict !== "ALREADY_SATISFIED") return null; // nothing a review could downgrade
  if (readRiskRecord(ctx.repoDir, ctx.startedAtMs ?? 0)?.tier === "low") return tag({ provider: p, level: "not_run", notes: [`cross-review skipped: low risk (${p} not run)`] }); // COST-4: low risk records the skip, never a pass
  if (roomS(ctx) < MIN_REVIEW_S) return tag({ provider: p, level: "not_run", notes: [`cross-review not run: insufficient run time for ${p}`] });
  const d = await safeGitRun(ctx.repoDir, ["diff", "--no-color", ctx.baseSha, head, "--", ".", ":(exclude).loki"], { timeoutMs: 20000 }).catch(() => null);
  if (!d || d.exitCode !== 0) return tag({ provider: p, level: "not_run", notes: [`cross-review not run: diff unavailable for ${p}`] });
  const prompt = [agent ? `${agent.prompt}\nReview ONLY the diff below. Do not modify files.` : "You are an independent code reviewer. Review ONLY the diff below for correctness bugs, spec violations and missing tests. Do not modify files.",
    "Reply with a first line exactly `VERDICT: PASS`, `VERDICT: FLAG` (concerns) or `VERDICT: BLOCK` (a reproduced defect), then one `- reason` line per concern.", ...acceptancePromptBlock(acceptanceLines((ctx.outputs?.() ?? {}).plan)), "", "```diff", d.stdout.slice(0, MAX_DIFF), "```"].join("\n");
  try {
    if (p === "claude") await ensureClaudeHelpCache();
    const r = await withChildLedger(run, join(ctx.repoDir, ".loki"), "xreview")(reviewArgv(p, prompt, process.env, p === "claude" ? agent?.model : undefined), { cwd: ctx.repoDir, timeoutMs: boxFor(ctx) * 1000, group: true, signal });
    if (r.exitCode !== 0) return tag({ provider: p, level: "not_run", notes: [`cross-review not run: ${p} exited ${r.exitCode}`] });
    return tag(parseReview(p, r.stdout));
  } catch {
    return tag({ provider: p, level: "not_run", notes: [`cross-review not run: ${p} CLI unavailable`] });
  }
}
