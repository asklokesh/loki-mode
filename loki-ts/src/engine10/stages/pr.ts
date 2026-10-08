// E-11 (TS half): PR stage (ENGINE.md sections 4, 6, 7). Runs in the SUPERVISOR (P0), never the
// worker: the only stage touching GitHub credentials, only through the credentialed push child
// engine10-push.sh (P4); no LLM, no untrusted text read here. Supervisor calls runPr after the
// worker exits, passing pinnedOrigin (section 6). Contract gap: pushArgv ends push-pr in "1"/"0"
// while the script takes "--draft" (translated below); it cannot say whether the PR already
// existed, so `existing` is null, never fabricated.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushArgs, RunContext, Stage, StageResult, Verdict } from "../types.ts";
import { pushArgv } from "../types.ts";
import { renderBrief, reviewerBriefEnabled } from "../../util/reviewer_brief.ts";
import { renderReviewerBody } from "../../e10ext/reviewer_body.ts";
import { withSealRoute } from "../../runner/router/route_block.ts"; import { draftReason } from "../pr_body.ts"; import { evidenceSection } from "../../features/visual_evidence.ts"; import { beforeAfterBlock } from "../../integrations/before_after.ts";
import { intentSection } from "../../util/intent_card.ts";
import { specPrLine } from "../../util/spec_file.ts";
import { REPO_ROOT } from "../../util/paths.ts";
import { safeGit } from "../../util/safe_git.ts";
import { yamlKey } from "../../util/yaml_key.ts";
/** B7: who opens the PR. LOKI_PR_AUTHOR beats loki.yaml pr.author; anything but "bot" is "me". */
export function resolvePrAuthor(repoDir: string, environ: NodeJS.ProcessEnv = process.env): "me" | "bot" {
  let v: string | null = (environ.LOKI_PR_AUTHOR ?? "").trim() || null;
  if (v === null) {
    for (const f of ["loki.yaml", "loki.yml"]) {
      const p = join(repoDir, f);
      if (!existsSync(p)) continue;
      try { v = yamlKey(readFileSync(p, "utf8"), "pr", "author"); } catch { /* unreadable */ }
      break;
    }
  }
  return (v ?? "").toLowerCase() === "bot" ? "bot" : "me";
}
/** RunContext plus the pinned origin and the cap signal from the supervisor. */
export type PrContext = RunContext & {
  /** remote.origin.url, read once by the supervisor before any provider ran. */
  pinnedOrigin?: string;
  /** True once the global cap (machine.ts) has fired for this run. */
  capHit?(): boolean;
};
export interface PrOptions {
  /** Injectable for tests; defaults to the real script next to this checkout. */
  pushScriptPath?: string;
}
export const DEFAULT_PUSH_SH = join(REPO_ROOT, "autonomy/lib/engine10-push.sh");
const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
function lastNonEmptyLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? "";
}
/** pushArgv's push-pr shape ends "...,"1"|"0"". engine10-push.sh instead
 *  wants only an optional literal "--draft" (4 or 5 total args). Translate
 *  rather than edit either file (see the contract-gap note above). */
function toPushShellArgs(args: PushArgs): string[] {
  const built = pushArgv(args);
  const flag = built.pop();
  if (flag === "1") built.push("--draft");
  return built;
}
function briefSection(ctx: PrContext): string {
  if (!reviewerBriefEnabled()) return "";
  const o = ctx.outputs();
  const base = String((o.intake as { base_sha?: unknown } | undefined)?.base_sha ?? ctx.baseSha ?? "");
  try { return "\n" + renderBrief({ repoDir: ctx.repoDir, baseSha: base, plan: (o.plan as { plan?: string } | undefined)?.plan ?? null }); } catch { return ""; }
}
export async function runPr(ctx: PrContext, signal: AbortSignal, opts: PrOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before pr started" };
  const pinnedOrigin = ctx.pinnedOrigin;
  if (!pinnedOrigin) {
    return { status: "failed", data: {}, reason: "no pinned origin: refusing to push (Rule of Two)" };
  }
  const seal = (ctx.outputs().seal ?? {}) as { verdict?: Verdict; not_proven?: string[]; receipt_path?: string; receipt_sha256?: string; signed?: boolean; route_line?: string; mutation_line?: string };
  const verdict = seal.verdict ?? "PARTIAL"; // fail-safe: an unknown verdict is never treated as VERIFIED
  const notProven = [...(seal.not_proven ?? [])];
  const capHit = ctx.capHit?.() ?? false;
  const draft = verdict !== "VERIFIED" || capHit;
  mkdirSync(ctx.runDir, { recursive: true });
  const bodyFile = join(ctx.runDir, "pr-body.md");
  const beforeAfter = await beforeAfterBlock(ctx.repoDir, ctx.runDir, ((ctx.outputs().verify?.["changed_files"] ?? []) as unknown[]).map(String), ctx.baseSha, { signal });
  writeFileSync(bodyFile, withSealRoute(renderReviewerBody({ verdict, draftReason: draftReason(verdict, capHit), notProven, receiptPath: seal.receipt_path ?? null, receiptSha256: seal.receipt_sha256 ?? null, signed: typeof seal.signed === "boolean" ? seal.signed : null, runId: ctx.runId, outputs: ctx.outputs() }), process.env, seal) + intentSection(ctx.outputs().plan) + specPrLine(process.env) + evidenceSection(seal.receipt_path) + briefSection(ctx) + beforeAfter + (seal.mutation_line ? `\n${seal.mutation_line}\n` : ""), "utf8");
  const title = `Loki 10: ${verdict} (${ctx.runId})`;
  const pushShellArgs = toPushShellArgs({ cmd: "push-pr", repoDir: ctx.repoDir, branch: ctx.branch, title, bodyFile, draft });
  const scriptPath = opts.pushScriptPath ?? DEFAULT_PUSH_SH;
  const env: NodeJS.ProcessEnv = { ...process.env, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: pinnedOrigin };
  if (resolvePrAuthor(ctx.repoDir) === "bot") {
    const botToken = process.env.LOKI_PR_BOT_TOKEN;
    if (botToken) env.GH_TOKEN = botToken; // child env only; never logged
    else process.stderr.write("loki: pr.author is bot but LOKI_PR_BOT_TOKEN is not set; opening the PR as me\n");
  }
  const pushResult = spawnSync("bash", [scriptPath, ...pushShellArgs], { env, encoding: "utf8" });
  if (pushResult.status !== 0) {
    return { status: "failed", data: {}, reason: `engine10-push.sh push-pr failed (exit ${pushResult.status}): ${(pushResult.stderr ?? "").trim()}` };
  }
  const url = lastNonEmptyLine(pushResult.stdout ?? "");
  // E-41: for a local bare origin (the eval harness) push-pr prints exactly
  // local://<pinned origin>#<branch>; accepted only for an absolute, colon-free pin.
  const localOk = pinnedOrigin.startsWith("/") && !pinnedOrigin.includes(":") && url === `local://${pinnedOrigin}#${ctx.branch}`;
  if (!localOk && !PR_URL_RE.test(url)) {
    return { status: "failed", data: {}, reason: `engine10-push.sh push-pr printed no valid PR URL (got: ${url || "(empty)"})` };
  }
  // Unknown, not fabricated: see the contract-gap note above.
  const existing: boolean | null = null;
  ctx.emit("pr.opened", "pr", { url, draft, existing });
  const headSha = safeGit(ctx.repoDir, ["rev-parse", "HEAD"]).trim();
  const notProvenOut: string[] = [];
  if (localOk) {
    // A local bare origin (the eval harness) has no commit status API.
    notProvenOut.push("commit status loki/deep-verify not set (local origin)");
  } else if (SHA_RE.test(headSha)) {
    const statusShellArgs = pushArgv({ cmd: "status", sha: headSha, state: "pending", description: "Loki 10 deep verify pending" });
    const statusResult = spawnSync("bash", [scriptPath, ...statusShellArgs], { env, encoding: "utf8" });
    // Non-fatal: the PR is already open. A failed status call is recorded, not a red PR stage.
    if (statusResult.status !== 0) notProvenOut.push("commit status loki/deep-verify not set");
  } else {
    notProvenOut.push("commit status loki/deep-verify not set (HEAD sha not resolvable)");
  }
  await (await import("../../integrations/writeback.ts")).writeBack({ verdict, prUrl: url, receiptSha256: seal.receipt_sha256 ?? null, task: String((ctx.outputs().intake as { task?: unknown } | undefined)?.task ?? "") }); // B6: opt-in, never throws
  return { status: "completed", data: { pr_url: url, draft, existing, ...(notProvenOut.length ? { not_proven: notProvenOut } : {}) } };
}
export const stage: Stage = {
  name: "pr",
  targetS: 15,
  limitS: 60,
  run: (ctx, signal) => runPr(ctx as PrContext, signal),
};
