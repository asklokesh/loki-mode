// B4: opt-in cross-lab review between verify and seal. A second provider reads the committed diff
// read-only and may only DOWNGRADE the verdict (flag adds NOT PROVEN, block caps at PARTIAL).
// Off unless loki.yaml `review: codex|claude` or LOKI_REVIEW_PROVIDER is set.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../util/shell.ts";
import { safeGitRun } from "../../util/safe_git.ts";
import type { RunContext, Verdict } from "../types.ts";

export type ReviewProvider = "codex" | "claude";
export type ReviewLevel = "pass" | "flag" | "block" | "not_run";
export interface CrossReview { provider: ReviewProvider; level: ReviewLevel; notes: string[]; }

const RANK: Record<Verdict, number> = { FAILED: 0, SPEC_CONFLICT: 0, PARTIAL: 1, ALREADY_SATISFIED: 2, VERIFIED: 2 };
const TIMEOUT_MS = 300_000, MAX_DIFF = 60_000, MAX_NOTES = 5;

/** The never-upgrade rule: returns the lower of the verdict and the review's ceiling. A review can only lower a verdict. */
export function minVerdict(verdict: Verdict, review: CrossReview | null): Verdict {
  const ceiling: Verdict = review?.level === "block" ? "PARTIAL" : verdict;
  return RANK[ceiling] < RANK[verdict] ? ceiling : verdict;
}

const asProvider = (v: string | undefined): ReviewProvider | null => { const s = v?.trim().toLowerCase(); return s === "codex" || s === "claude" ? s : null; };
const isOff = (v: string | undefined): boolean => /^(off|none|false|0)$/i.test(v?.trim() ?? "");

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
export function reviewReceipt(builder: string, xr: CrossReview | null, env: NodeJS.ProcessEnv = process.env): { review?: { provider: string | null; vendor_differs: boolean }; notProven: string[] } {
  if (!xvendorDefault(env)) return { notProven: [] };
  const differs = !!xr && xr.level !== "not_run" && xr.provider !== builder && (builder === "claude" || builder === "codex"); // a review that did not run is not cross-vendor evidence
  return { review: { provider: xr?.provider ?? null, vendor_differs: differs }, notProven: differs ? [] : ["judge shares builder vendor or none configured"] };
}

/** Read-only argv: codex runs in its read-only sandbox; claude gets read tools only with writers and shell denied. */
export function reviewArgv(p: ReviewProvider, prompt: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const cli = reviewCli(p, env);
  return p === "codex"
    ? [cli, "exec", "--sandbox", "read-only", prompt]
    : [cli, "-p", prompt, "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Write,Edit,NotebookEdit,Bash"];
}

const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f`]+/g, " ").trim().slice(0, 300);

/** First line `VERDICT: PASS|FLAG|BLOCK`, then `- reason` lines. Anything else is not_run (never PASS). */
export function parseReview(p: ReviewProvider, out: string): CrossReview {
  const m = /^\s*VERDICT:\s*(PASS|FLAG|BLOCK)\b/im.exec(out);
  if (!m) return { provider: p, level: "not_run", notes: [`cross-review not run: ${p} returned no VERDICT line`] };
  const level = m[1]!.toLowerCase() as ReviewLevel;
  const reasons = out.slice(m.index + m[0].length).split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "")).filter((l) => l.trim() !== "").map(clean).filter(Boolean).slice(0, MAX_NOTES);
  const notes = level === "pass" ? [] : (reasons.length ? reasons : ["no reason given"]).map((r) => `cross-review ${level} (${p}): ${r}`);
  return { provider: p, level, notes };
}

/** Runs the reviewer when enabled. Null when off. A missing CLI, a failure or a timeout is not_run with a NOT PROVEN note, never PASS. */
export async function crossReview(ctx: RunContext, verdict: Verdict, head: string): Promise<CrossReview | null> {
  const p = reviewProvider(ctx.repoDir, process.env, ctx.provider); if (!p) return null;
  if (verdict !== "VERIFIED" && verdict !== "ALREADY_SATISFIED") return null; // nothing a review could downgrade
  const d = await safeGitRun(ctx.repoDir, ["diff", "--no-color", ctx.baseSha, head, "--", ".", ":(exclude).loki"], { timeoutMs: 20000 }).catch(() => null);
  if (!d || d.exitCode !== 0) return { provider: p, level: "not_run", notes: [`cross-review not run: diff unavailable for ${p}`] };
  const prompt = ["You are an independent code reviewer. Review ONLY the diff below for correctness bugs, spec violations and missing tests. Do not modify files.",
    "Reply with a first line exactly `VERDICT: PASS`, `VERDICT: FLAG` (concerns) or `VERDICT: BLOCK` (a reproduced defect), then one `- reason` line per concern.", "", "```diff", d.stdout.slice(0, MAX_DIFF), "```"].join("\n");
  try {
    const r = await run(reviewArgv(p, prompt), { cwd: ctx.repoDir, timeoutMs: TIMEOUT_MS });
    if (r.exitCode !== 0) return { provider: p, level: "not_run", notes: [`cross-review not run: ${p} exited ${r.exitCode}`] };
    return parseReview(p, r.stdout);
  } catch {
    return { provider: p, level: "not_run", notes: [`cross-review not run: ${p} CLI unavailable`] };
  }
}
