// E-11 (TS half): PR stage (ENGINE.md sections 4, 6, 7). Runs in the SUPERVISOR (P0), never the worker: the only stage touching GitHub credentials, only through the credentialed push child engine10-push.sh (P4); no LLM, no untrusted text read here. Supervisor calls
// runPr after the worker exits, passing pinnedOrigin (section 6). push-pr prints a "reused" or "created" marker line before the PR URL; `existing` is true/false from it, and null when the script printed none (local origin, older script).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PushArgs, type RunContext, type Stage, type StageResult, type Verdict, pushArgv } from "../types.ts";
import { renderBrief, reviewerBriefEnabled } from "../../util/reviewer_brief.ts";
import { hooks } from "../hooks.ts";
import { renderReviewerBody } from "../../e10ext/reviewer_body.ts";
import { withSealRoute } from "../../runner/router/route_block.ts"; import { aiMarkerLine, applyPrTemplate, draftReason, readPrTemplate, receiptProof, withAiMarker } from "../pr_body.ts"; import { evidenceSection } from "../../features/visual_evidence.ts"; import { beforeAfterBlock } from "../../integrations/before_after.ts";
import { intentSection } from "../../util/intent_card.ts";
import { specPrLine } from "../../util/spec_file.ts";
import { REPO_ROOT } from "../../util/paths.ts";
import { safeGit } from "../../util/safe_git.ts"; import { collapseNotProven, pushErrLine } from "../../util/term_width.ts";
import { stackBase, stackSection } from "../../util/run_outputs.ts"; import { publishFallback } from "../../util/engine_origin.ts";
import { postReceiptComment, renderReceiptComment } from "../../util/receipt_surface.ts";
import { lokiYamlTexts, yamlKey } from "../../util/yaml_key.ts"; import { idempotencyKey, runOnce } from "../../util/outbox.ts";
/** B7: who opens the PR. LOKI_PR_AUTHOR beats loki.yaml pr.author; anything but "bot" is "me". */
export function resolvePrAuthor(repoDir: string, environ: NodeJS.ProcessEnv = process.env): "me" | "bot" {
  let v: string | null = (environ.LOKI_PR_AUTHOR ?? "").trim() || null;
  if (v === null) { const t = lokiYamlTexts(repoDir)[0]; if (t !== undefined) v = yamlKey(t, "pr", "author"); } // the first file only, even if the key is absent
  return (v ?? "").toLowerCase() === "bot" ? "bot" : "me";
}
/** RunContext plus the pinned origin and the cap signal from the supervisor. */
export type PrContext = RunContext & {
  /** remote.origin.url, read once by the supervisor before any provider ran. */
  pinnedOrigin?: string;
  /** True once the global cap (machine.ts) has fired for this run. */
  capHit?(): boolean;
  /** Review handoff markdown (util/run_summary.ts handoffSection); appended to the PR body. */
  handoffMd?: string;
  /** Policy require_approval: open as a draft. Carried on the context, never process.env. */
  draft?: boolean;
};
export interface PrOptions {
  /** Injectable for tests; defaults to the real script next to this checkout. */
  onSpawnEnv?: (env: NodeJS.ProcessEnv) => void; // GAME10-05a: receives the exact env object the push script is spawned with
  pushScriptPath?: string; gitlabPushScriptPath?: string; // the GitLab twin (TEN-ADOPTION-09), same injection rule
}
export const DEFAULT_PUSH_SH = join(REPO_ROOT, "autonomy/lib/engine10-push.sh");
export const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
export const DEFAULT_PUSH_GITLAB_SH = join(REPO_ROOT, "autonomy/lib/engine10-push-gitlab.sh"); export const MR_URL_RE = /^https:\/\/gitlab\.com\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/-\/merge_requests\/\d+$/; export const isGitlabOrigin = (o: string): boolean => /^(?:https:\/\/gitlab\.com\/|git@gitlab\.com:|ssh:\/\/git@gitlab\.com\/)/i.test(o); // TEN-ADOPTION-09: a literal gitlab.com pinned origin routes to engine10-push-gitlab.sh push-mr (the script re-validates the URL), whose MR URL must match MR_URL_RE.
export const SHA_RE = /^[0-9a-f]{40}$/;
function lastNonEmptyLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0); return lines[lines.length - 1] ?? "";
}
/** pushArgv's push-pr shape ends "...,"1"|"0"". engine10-push.sh instead wants only an optional literal "--draft" (4 or 5 total args). Translate rather than edit either file (see the header note). */
export function toPushShellArgs(args: PushArgs): string[] {
  const built = pushArgv(args);
  const flag = built.pop(); if (flag === "1") built.push("--draft");
  return built;
}
/** TEN-STABILITY-50: every push/pr-ready/status child is bounded so one hung script cannot block the run. LOKI_PR_PUSH_TIMEOUT_MS overrides (default 50s, inside the 60s stage limit). */
export function prChildTimeoutMs(environ: NodeJS.ProcessEnv = process.env): number { const n = Number(environ.LOKI_PR_PUSH_TIMEOUT_MS); return Number.isFinite(n) && n >= 100 ? Math.floor(n) : 50_000; }
function spawnBounded(args: string[], env: NodeJS.ProcessEnv) { return spawnSync("bash", args, { env, encoding: "utf8", timeout: prChildTimeoutMs(), killSignal: "SIGKILL" }); }
function failReason(script: string, mode: string, r: ReturnType<typeof spawnBounded>): string { const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"; return timedOut ? `${script} ${mode} timed out after ${prChildTimeoutMs()}ms (hung script killed)` : r.status === 4 && mode === "push-pr" && pushErrLine(r.stderr ?? "").startsWith("fork-only: ") ? pushErrLine(r.stderr ?? "") : `${script} ${mode} failed (exit ${r.status}): ${pushErrLine(r.stderr ?? "")}`; }
function pushEnv(repoDir: string, pinnedOrigin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: pinnedOrigin };
  if (resolvePrAuthor(repoDir) === "bot") {
    const botToken = process.env.LOKI_PR_BOT_TOKEN; if (botToken) env.GH_TOKEN = botToken; // child env only; never logged
    else process.stderr.write("loki: pr.author is bot but LOKI_PR_BOT_TOKEN is not set; opening the PR as me\n");
  }
  return env;
}
/** The one credentialed push-pr call (env, bot token, spawn, URL check incl. E-41 local://); stage and modernize ship share it. */
export type PushPrResult = { ok: true; url: string; existing: boolean | null; localOk: boolean } | { ok: false; reason: string };
export function runPushPr(a: { repoDir: string; branch: string; title: string; bodyFile: string; draft: boolean; pinnedOrigin: string; base?: string | null; scriptPath?: string; gitlabScriptPath?: string; env?: NodeJS.ProcessEnv }): PushPrResult {
  if (isGitlabOrigin(a.pinnedOrigin)) return runPushMr(a); const args = [...toPushShellArgs({ cmd: "push-pr", repoDir: a.repoDir, branch: a.branch, title: a.title, bodyFile: a.bodyFile, draft: a.draft }), ...(a.base ? ["--base", a.base] : [])];
  const env = a.env ?? pushEnv(a.repoDir, a.pinnedOrigin);
  const r = spawnBounded([a.scriptPath ?? DEFAULT_PUSH_SH, ...args], env);
  if (r.status !== 0) return { ok: false, reason: failReason("engine10-push.sh", "push-pr", r) };
  const url = lastNonEmptyLine(r.stdout ?? ""), markers = (r.stdout ?? "").split("\n").map((l) => l.trim());
  // E-41: for a local bare origin (the eval harness) push-pr prints exactly local://<pinned origin>#<branch>; accepted only for an absolute, colon-free pin.
  const localOk = a.pinnedOrigin.startsWith("/") && !a.pinnedOrigin.includes(":") && url === `local://${a.pinnedOrigin}#${a.branch}`;
  if (!localOk && !PR_URL_RE.test(url)) return { ok: false, reason: `engine10-push.sh push-pr printed no valid PR URL (got: ${url || "(empty)"})` };
  return { ok: true, url, localOk, existing: markers.includes("reused") ? true : markers.includes("created") ? false : null }; // null = unknown, never fabricated
}
function runPushMr(a: Parameters<typeof runPushPr>[0]): PushPrResult { if (a.base) return { ok: false, reason: "engine10-push-gitlab.sh push-mr has no --base: refusing a stacked push to a gitlab.com origin" }; const r = spawnBounded([a.gitlabScriptPath ?? DEFAULT_PUSH_GITLAB_SH, "push-mr", a.repoDir, a.branch, a.title, a.bodyFile, ...(a.draft ? ["--draft"] : [])], a.env ?? pushEnv(a.repoDir, a.pinnedOrigin)); if (r.status !== 0) return { ok: false, reason: failReason("engine10-push-gitlab.sh", "push-mr", r) }; const url = lastNonEmptyLine(r.stdout ?? ""); return MR_URL_RE.test(url) ? { ok: true, url, localOk: false, existing: null } : { ok: false, reason: `engine10-push-gitlab.sh push-mr printed no valid MR URL (got: ${url || "(empty)"})` }; } // TEN-ADOPTION-09: runPushPr's GitLab twin. push-mr has no --base (refused, never dropped) and prints only the MR URL, so existing stays null (never fabricated).
/** M-21 N3: replace a reused PR's body and mark it ready through engine10-push.sh pr-ready (same pinned origin and token scoping as push-pr). */
export function runPrReady(a: { repoDir: string; branch: string; bodyFile: string; url: string; pinnedOrigin: string; scriptPath?: string; env?: NodeJS.ProcessEnv }): { ok: true } | { ok: false; reason: string } {
  const env = a.env ?? pushEnv(a.repoDir, a.pinnedOrigin);
  const r = spawnBounded([a.scriptPath ?? DEFAULT_PUSH_SH, "pr-ready", a.repoDir, a.branch, a.bodyFile, a.url], env);
  if (r.status !== 0) return { ok: false, reason: failReason("engine10-push.sh", "pr-ready", r) };
  return { ok: true };
}
function briefSection(ctx: PrContext): string {
  if (!reviewerBriefEnabled()) return "";
  const o = ctx.outputs();
  const base = String((o.intake as { base_sha?: unknown } | undefined)?.base_sha ?? ctx.baseSha ?? "");
  try { return "\n" + renderBrief({ repoDir: ctx.repoDir, baseSha: base, plan: (o.plan as { plan?: string } | undefined)?.plan ?? null, facts: hooks.briefFacts?.(ctx.outputs(), ctx.runId, ctx.runDir) }); } catch { return ""; }
}
/** MASS-1: name the issue this run worked, so GitHub links the PR and `loki issues run` reruns find it. Only a strict  owner/repo and an integer number from the supervisor-fetched issue.json reach the body; VERIFIED closes on merge. */
export function issueLink(runDir: string, verdict: Verdict): string {
  try {
    const i = JSON.parse(readFileSync(join(runDir, "issue.json"), "utf8")) as { repo?: unknown; number?: unknown };
    const ok = typeof i.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(i.repo) && Number.isInteger(i.number) && (i.number as number) > 0;
    return ok ? `\n${verdict === "VERIFIED" ? "Closes" : "Refs"} ${i.repo as string}#${i.number as number}\n` : "";
  } catch { return ""; }
}
export async function runPr(ctx: PrContext, signal: AbortSignal, opts: PrOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before pr started" };
  const pinnedOrigin = ctx.pinnedOrigin;
  if (!pinnedOrigin) return { status: "failed", data: {}, reason: "no pinned origin: refusing to push (Rule of Two)" };
  const seal = (ctx.outputs().seal ?? {}) as { verdict?: Verdict; not_proven?: string[]; receipt_path?: string; receipt_sha256?: string; signed?: boolean; route_line?: string; mutation_line?: string };
  const verdict = seal.verdict ?? "PARTIAL"; // fail-safe: an unknown verdict is never treated as VERIFIED
  const notProven = collapseNotProven(seal.not_proven ?? []); // FC-OUTCOME-FLOOD: display only; receipt.json keeps the full list
  const capHit = ctx.capHit?.() ?? false;
  const draft = verdict !== "VERIFIED" || capHit || process.env.LOKI_PR_DRAFT === "1" || (ctx as PrContext).draft === true; // MASS-1: `loki issues run --draft` asks for drafts only; it never un-drafts
  const base = stackBase(process.env);
  if (base === null) return { status: "failed", data: {}, reason: "LOKI_PR_BASE is not a valid branch name: refusing to push" };
  mkdirSync(ctx.runDir, { recursive: true });
  const link = issueLink(ctx.runDir, verdict);
  const bodyFile = join(ctx.runDir, "pr-body.md");
  const beforeAfter = await beforeAfterBlock(ctx.repoDir, ctx.runDir, ((ctx.outputs().verify?.["changed_files"] ?? []) as unknown[]).map(String), ctx.baseSha, { signal });
  const reviewerBody = renderReviewerBody({ verdict, draftReason: draftReason(verdict, capHit), notProven, receiptPath: seal.receipt_path ?? null, receiptSha256: seal.receipt_sha256 ?? null, signed: typeof seal.signed === "boolean" ? seal.signed : null, runId: ctx.runId, outputs: ctx.outputs() });
  const tpl = readPrTemplate(ctx.repoDir), shaped = tpl === null ? reviewerBody : applyPrTemplate(reviewerBody, tpl, receiptProof(verdict, ctx.outputs(), seal.receipt_sha256 ?? null)); // no template: today's body, byte-identical
  writeFileSync(bodyFile, withAiMarker(withSealRoute(shaped, process.env, seal), aiMarkerLine({ runId: ctx.runId, provider: ctx.provider, model: ctx.model })) + intentSection(ctx.outputs().plan) + specPrLine(process.env) + evidenceSection(seal.receipt_path) + briefSection(ctx) + beforeAfter + (seal.mutation_line ? `\n${seal.mutation_line}\n` : "") + link + stackSection(process.env, base, link !== "") + (ctx.handoffMd ?? ""), "utf8");
  const title = `Loki 10: ${verdict} (${ctx.runId})`;
  const scriptPath = opts.pushScriptPath ?? DEFAULT_PUSH_SH;
  const env = pushEnv(ctx.repoDir, pinnedOrigin); opts.onSpawnEnv?.(env);
  const pr = runOnce({ dir: ctx.runDir, key: idempotencyKey("pr", ctx.runId, ctx.branch), keep: (r) => r.ok, post: () => runPushPr({ repoDir: ctx.repoDir, branch: ctx.branch, title, bodyFile, draft, pinnedOrigin, base, scriptPath, gitlabScriptPath: opts.gitlabPushScriptPath, env }) }); // P12-36: push-pr reuses an existing PR, so a pending replay is duplicate-safe
  if (!pr.ok) return { status: "failed", data: {}, reason: pr.reason + publishFallback(ctx.runDir, ctx.branch, base) };
  const { url, localOk, existing } = pr;
  ctx.emit("pr.opened", "pr", { url, draft, existing });
  const headSha = safeGit(ctx.repoDir, ["rev-parse", "HEAD"]).trim();
  const notProvenOut: string[] = [];
  if (localOk) {
    // A local bare origin (the eval harness) has no commit status API.
    notProvenOut.push("commit status loki/deep-verify not set (local origin)");
  } else if (isGitlabOrigin(pinnedOrigin)) { notProvenOut.push("commit status loki/deep-verify not set (gitlab origin)"); } else if (SHA_RE.test(headSha)) { // engine10-push-gitlab.sh has no status mode; a GitLab sha never reaches the GitHub status call
    const statusShellArgs = pushArgv({ cmd: "status", sha: headSha, state: "pending", description: "Loki 10 deep verify pending" });
    const statusResult = spawnBounded([scriptPath, ...statusShellArgs], env);
    // Non-fatal: the PR is already open. A failed status call is recorded, not a red PR stage.
    if (statusResult.status !== 0) notProvenOut.push("commit status loki/deep-verify not set");
  } else {
    notProvenOut.push("commit status loki/deep-verify not set (HEAD sha not resolvable)");
  }
  const receiptComment = renderReceiptComment({
    verdict, draft, draftReason: draftReason(verdict, capHit), notProven: [...notProven, ...notProvenOut],
    receiptSha256: seal.receipt_sha256 ?? null, runId: ctx.runId, mutationProof: seal.mutation_line ?? null,
  }); // the same items as the PR body (no new exposure), plus this stage's own commit-status misses
  const commentMiss = postReceiptComment({ scriptPath, env, runDir: ctx.runDir, url, timeoutMs: prChildTimeoutMs(), comment: receiptComment });
  if (commentMiss) notProvenOut.push(commentMiss);
  await (await import("../../integrations/writeback.ts")).writeBack({ phase: "done", verdict, prUrl: url, receiptSha256: seal.receipt_sha256 ?? null, task: String((ctx.outputs().intake as { task?: unknown } | undefined)?.task ?? "") }); // B6: opt-in, never throws
  return { status: "completed", data: { pr_url: url, draft, existing, ...(notProvenOut.length ? { not_proven: notProvenOut } : {}) } };
}
export const stage: Stage = {
  name: "pr", targetS: 15, limitS: 60, run: (ctx, signal) => runPr(ctx as PrContext, signal),
};
