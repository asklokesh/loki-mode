// E-11 (TS half): PR stage (ENGINE.md sections 4, 6, 7). Runs in the SUPERVISOR (P0), never the worker: the only stage touching GitHub credentials, only through the credentialed push child engine10-push.sh (P4); no LLM, no untrusted text read here. Supervisor calls
// runPr after the worker exits, passing pinnedOrigin (section 6). push-pr prints a "reused" or "created" marker line before the PR URL; `existing` is true/false from it, and null when the script printed none (local origin, older script).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proveTable } from "./prove.ts";
import { type PushArgs, type RunContext, type Stage, type StageResult, type Verdict, pushArgv } from "../types.ts";
import { renderBrief, reviewerBriefEnabled } from "../../util/reviewer_brief.ts";
import { hooks } from "../hooks.ts";
import { renderReviewerBody } from "../../e10ext/reviewer_body.ts";
import { withSealRoute } from "../../runner/router/route_block.ts"; import { aiMarkerLine, applyPrTemplate, draftReason, readPrTemplate, receiptProof, withAiMarker } from "../pr_body.ts"; import { evidenceSection } from "../../features/visual_evidence.ts"; import { beforeAfterBlock } from "../../integrations/before_after.ts";
import { intentSection } from "../../util/intent_card.ts";
import { specPrLine } from "../../util/spec_file.ts"; import { triagePrLine } from "../../features/triage.ts";
import { REPO_ROOT } from "../../util/paths.ts";
import { type PrScope, prScope, prScopeLine, prTargetRef } from "../../util/base_guard.ts";
import { diffAgainstBase, safeGit } from "../../util/safe_git.ts"; import { collapseNotProven, pushErrLine } from "../../util/term_width.ts";
import { parseSliceHead, sealAccuracyOfFile, stackBase, stackSection } from "../../util/run_outputs.ts"; import { publishFallback } from "../../util/engine_origin.ts";
import { postReceiptComment, renderReceiptComment } from "../../util/receipt_surface.ts";
import { buildPassport } from "../../util/receipt_bundle.ts";
import { lokiYamlTexts, yamlKey } from "../../util/yaml_key.ts"; import { idempotencyKey, runOnce } from "../../util/outbox.ts";
import { failedCheckNames } from "../../util/failure_memory.ts";
import { conflictReasonOf, readEvents } from "../events.ts"; import { eventsRelPath } from "../../util/engine_origin.ts"; import type { EventEnvelope } from "../types.ts";
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
/** RECEIPT-STATUS: the commit status loki/receipt on `sha`, through the push script with the same pinned origin and token scoping as push-pr.
 *  False when it was not set (a GitLab origin, a sha that is not 40 hex, or a failed call). Never throws. */
export function runReceiptStatus(a: { repoDir: string; sha: string; state: "success" | "failure"; description: string; pinnedOrigin: string; scriptPath?: string; env?: NodeJS.ProcessEnv }): boolean {
  if (isGitlabOrigin(a.pinnedOrigin) || !SHA_RE.test(a.sha)) return false;
  try { return spawnBounded([a.scriptPath ?? DEFAULT_PUSH_SH, ...pushArgv({ cmd: "status", sha: a.sha, state: a.state, description: a.description.slice(0, 140), context: "loki/receipt" })], a.env ?? pushEnv(a.repoDir, a.pinnedOrigin)).status === 0; } catch { return false; }
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
/** FireLater#21: the PR title says what changed: the slice title with its epic reference "(#21 s2)", else the issue title "(#24)", else the task's
 *  first line; the outcome once, as a "[PARTIAL]" prefix, or "[FAILED: <first failing check> +N]" (a VERIFIED PR carries none); never the run id (it is in the body and the branch). Clipped
 *  at a word boundary to TITLE_MAX characters. Task and issue text are untrusted: one line, control characters dropped. */
const TITLE_MAX = 100;
/** FAILED-PR: the "[FAILED: ...]" title label: the first failing blocking check (clipped to 40 characters) and how many more fail. */
export function failedLabel(failing: readonly string[]): string {
  const first = (failing[0] ?? "").replace(/[\u0000-\u001f\u007f\[\]]+/g, " ").replace(/\s+/g, " ").trim(), cut = first.length > 40 ? `${first.slice(0, 37)}...` : first;
  return cut ? `[FAILED: ${cut}${failing.length > 1 ? ` +${failing.length - 1}` : ""}] ` : "[FAILED] ";
}
export function prTitle(verdict: Verdict, runDir: string, task: string, failing: readonly string[] = []): string {
  const one = (t: string): string => t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const first = one(task.split("\n").find((l) => l.trim() !== "") ?? "").replace(/^#+\s*/, ""), slice = parseSliceHead(first);
  let what = slice?.title ?? "", ref = slice ? ` (#${slice.n} ${slice.id})` : "";
  if (!slice) {
    try { const i = JSON.parse(readFileSync(join(runDir, "issue.json"), "utf8")) as { title?: unknown; number?: unknown }; if (typeof i.title === "string" && one(i.title)) { what = one(i.title); ref = Number.isInteger(i.number) && (i.number as number) > 0 ? ` (#${i.number as number})` : ""; } } catch { /* a text task has no issue.json */ }
    if (!what) what = first;
  }
  const head = verdict === "PARTIAL" ? "[PARTIAL] " : verdict === "FAILED" ? failedLabel(failing) : verdict === "SPEC_CONFLICT" ? "[NEEDS ANSWER] " : "", room = TITLE_MAX - head.length - ref.length;
  if (!what) return `${head}Loki change${ref}`;
  const cps = Array.from(what), cut = cps.length <= room ? what : ((short) => `${short.replace(/\s+\S*$/, "") || short}...`)(cps.slice(0, room - 3).join("")); // code points: a surrogate pair is never split
  return `${head}${cut}${ref}`;
}
/** The label a person can act on without reading the code, and its GitHub label name and color. */
export const LOKI_LABELS = { safe: { name: "loki: safe to merge", color: "0E8A16", description: "Loki checked every acceptance line of the issue by running the change" }, needs: { name: "loki: needs you", color: "D93F0B", description: "Loki could not prove every acceptance line; the pull request says which" } } as const;
/** The label for a verdict: only a VERIFIED run is ever green; a failed, blocked, partial or unfinished run is "needs you". */
export const lokiLabelFor = (verdict: string): (typeof LOKI_LABELS)["safe" | "needs"] => (verdict === "VERIFIED" ? LOKI_LABELS.safe : LOKI_LABELS.needs);
/** DELIVER-WHAT-EXISTS: the honest state a draft leads with when the run did not finish. A blocked run: the one question and the command that answers it,
 *  then what is done and what is open. A run with no sealed receipt: that it stopped, why, that nothing is proven, and the command to go on. "" for every other
 *  run (a sealed FAILED or PARTIAL run keeps its own head; stopSection adds why it stopped). */
export interface RunState { verdict: Verdict; sealed: boolean; runId: string; question: string | null; reason: string; next: string; done: string[]; open: string[] }
export function stateHead(s: RunState): string {
  const clip = (r: string, n = 160): string => { const t = r.replace(/[\r\n]+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
  const list = (xs: string[], none: string): string[] => (xs.filter((x) => x.trim() !== "").length ? [...xs.filter((x) => x.trim() !== "").slice(0, 10).map((x) => `- ${clip(x)}`), ...(xs.length > 10 ? [`- (+${xs.length - 10} more)`] : [])] : [`- ${none}`]);
  if (s.verdict === "SPEC_CONFLICT") return ["## Loki needs one answer", clip(s.question ?? (s.reason || "see the receipt"), 600), "", "Answer it with:", "", `loki answer ${s.runId} --text "<your decision>"`, "",
    "The run then continues on this branch from where it stopped. Opened as a draft so the work that exists is visible; it is not ready to merge.", "",
    "## What is done", ...list(s.done, "nothing is recorded"), "", "## What is open", "- the question above", ...list(s.open, "nothing else is recorded").filter((l) => l !== "- nothing else is recorded"), ""].join("\n") + "\n";
  if (s.verdict === "FAILED" && !s.sealed) return ["## This run stopped before it finished", `Why it stopped: ${clip(s.reason || "the engine ended before sealing a receipt", 400)}.`,
    "No receipt was sealed, so nothing in this change is proven. Opened as a draft so the work that exists is not lost; it is not ready to merge.", "", "To continue, run the task again (a stopped run without a receipt cannot be resumed; this branch keeps what it had written):", "", s.next, "",
    "## What is done", ...list(s.done, "nothing is recorded"), "", "## What is open", ...list(s.open, "everything: no check result was sealed"), ""].join("\n") + "\n";
  return "";
}
/** Why a sealed run that is not VERIFIED stopped at the cost or time cap, and how to go on; "" when no cap was hit. Placed after the run's own head. */
export function stopSection(verdict: Verdict, sealed: boolean, capHit: boolean, next: string): string {
  return sealed && capHit && verdict !== "VERIFIED" && verdict !== "ALREADY_SATISFIED" ? ["## Why the run stopped", "cost/time cap reached: the stages that had not run by then did not run.", "", `To continue: ${next}`, ""].join("\n") + "\n" : "";
}
/** The first thing in the pull request: Loki's label, then each of the issue's own acceptance lines as met or not, with the evidence. "" when the receipt has no acceptance record. */
export function acceptanceHead(verdict: Verdict, receipt: Record<string, unknown> | null): string {
  const rows = Array.isArray(receipt?.["issue_acceptance"]) ? (receipt!["issue_acceptance"] as { line?: unknown; status?: unknown; evidence?: unknown; reason?: unknown; optional?: unknown; note?: unknown; by?: unknown; disputed?: unknown }[]) : [];
  if (rows.length === 0) return "";
  const clip = (s: unknown): string => { const t = String(s ?? "").replace(/[\r\n|]+/g, " ").trim(); return t.length > 220 ? `${t.slice(0, 217)}...` : t; };
  const metRows = rows.filter((r) => r.status === "met"), met = metRows.length, safe = verdict === "VERIFIED", dis = metRows.filter((r) => r.disputed === true).length, und = metRows.filter((r) => r.disputed !== true), ch = und.filter((r) => r.by === "change").length, bf = und.filter((r) => r.by === "before").length, plain = met - dis - ch - bf, open = rows.length - met;
  const headline = dis > 0 ? [`${met - dis} of ${rows.length} acceptance lines ${met - dis === 1 ? "is" : "are"} met and undisputed`, ...(ch ? [`${ch} met by this change`] : []), ...(bf ? [`${bf} already met before it`] : []), ...(ch + bf > 0 && plain ? [`${plain} met, not compared with the code before the change`] : []), `${dis} disputed by the reviewer`, ...(open ? [`${open} not met (each says why)`] : [])].join("; ") + "." : ch + bf === 0 ? (safe ? `Every acceptance line is met (${met} of ${rows.length}), each with what proved it.` : `${met} of ${rows.length} acceptance lines are met. The ones that are not say why.`) : [`${ch} of ${rows.length} acceptance lines ${ch === 1 ? "is" : "are"} met by this change`, ...(bf ? [`${bf} already met before it`] : []), ...(plain ? [`${plain} met, not compared with the code before the change`] : []), ...(open ? [`${open} not met (each says why)`] : [])].join("; ") + ".";
  return [`## Loki: ${safe ? "safe to merge" : "needs you"}`, headline, "", receipt?.["issue_acceptance_source"] === "plan" ? "| Acceptance line (written by Loki from the issue, which has no checklist) | Status | Evidence or reason |" : "| Acceptance line (the issue's own words) | Status | Evidence or reason |", "|---|---|---|",
    ...rows.map((r) => `| ${clip(r.line)} | ${r.status === "met" ? (r.disputed === true ? "met by Loki's checks; the reviewer says not met" : r.by === "change" ? "met by this change" : r.by === "before" ? "already met before this change" : "met") : r.optional === true ? "optional, not done" : r.status === "unmet" ? "NOT MET" : "not checked"} | ${clip(r.status === "met" ? `${String(r.evidence ?? "")}${r.note ? ` (${String(r.note)})` : ""}` : r.reason ?? (r.status === "not_checked" ? "the check gave no answer for this line" : ""))} |`), ""].join("\n") + "\n";
}
/** What the reviewer found, in the reviewer's words (receipt review.findings): at most 12, then how many more the receipt holds. "" when there is none. */
export function reviewFindingsSection(receipt: Record<string, unknown> | null): string {
  const f = (receipt?.["review"] as { findings?: unknown } | undefined)?.findings, list = Array.isArray(f) ? f.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  if (list.length === 0) return "";
  return ["## What the reviewer found", ...list.slice(0, 12).map((r) => `- ${r.replace(/[\r\n]+/g, " ").trim()}`), ...(list.length > 12 ? [`- (+${list.length - 12} more in the receipt)`] : []), ""].join("\n") + "\n";
}
/** Puts Loki's label on the pull request and on the issue it works (created if the repository lacks it; the other label removed). Best effort: a miss is returned as a note, never a failed stage. */
export function applyLokiLabel(a: { verdict: Verdict; url: string; runDir: string; env: NodeJS.ProcessEnv; timeoutMs: number }): string | null {
  const repo = /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(a.url)?.[1]; if (!repo) return null; // GitHub pull requests only
  const want = lokiLabelFor(a.verdict), drop = want === LOKI_LABELS.safe ? LOKI_LABELS.needs : LOKI_LABELS.safe;
  const gh = (args: string[]): boolean => { try { return spawnSync("gh", args, { env: a.env, encoding: "utf8", timeout: a.timeoutMs, killSignal: "SIGKILL" }).status === 0; } catch { return false; } };
  for (const l of [LOKI_LABELS.safe, LOKI_LABELS.needs]) gh(["label", "create", l.name, "--repo", repo, "--color", l.color, "--description", l.description, "--force"]);
  const onPr = gh(["pr", "edit", a.url, "--add-label", want.name]); gh(["pr", "edit", a.url, "--remove-label", drop.name]);
  let issue: number | null = null; try { const i = JSON.parse(readFileSync(join(a.runDir, "issue.json"), "utf8")) as { repo?: unknown; number?: unknown }; if (i.repo === repo && Number.isInteger(i.number)) issue = i.number as number; } catch { /* a text goal has no issue */ }
  if (issue !== null) { gh(["issue", "edit", String(issue), "--repo", repo, "--add-label", want.name]); gh(["issue", "edit", String(issue), "--repo", repo, "--remove-label", drop.name]); }
  return onPr ? null : `label "${want.name}" not set on the pull request`;
}
/** PR-FIRST-1: a PARTIAL PR leads with what is unproven (first 10 reasons plus the total), above the reviewer body. Empty for every other verdict.
 *  Q1 PROVE: when the receipt carries a prove record (issue runs on claude), its table (ask, command, result) comes first in this same section, on a
 *  VERIFIED PR too, where it is the section's only content. No prove record: the section is byte-identical to before. */
export function partialHead(verdict: Verdict, notProven: string[], prove?: unknown): string {
  const np = verdict === "PARTIAL" ? notProven.filter((r) => r.trim() !== "") : [], table = verdict === "PARTIAL" || verdict === "VERIFIED" ? proveTable(prove) : [];
  if (np.length === 0 && table.length === 0) return "";
  const clip = (r: string): string => (r.length > 160 ? `${r.slice(0, 157)}...` : r);
  if (np.length === 0) return [`## Proven by running`, `Each ask the issue makes was run by a script a separate session wrote, against a fresh environment built by the repository's own setup path:`, ...table].join("\n") + "\n";
  return [`## Not proven`, `This run sealed PARTIAL: ${np.length} thing${np.length === 1 ? " is" : "s are"} not proven. Opened as a draft so the work is reviewable.`, ...(table.length ? ["", ...table] : []), ...np.slice(0, 10).map((r) => `- ${clip(r)}`), ...(np.length > 10 ? [`- (+${np.length - 10} more, total ${np.length}; the full list is in the receipt)`] : []), ""].join("\n") + "\n";
}
/** FAILED-PR: a FAILED PR leads with the blocking checks that still fail and what is unproven, above the reviewer body. Empty for every other verdict. */
export function failedHead(verdict: Verdict, failing: readonly string[], notProven: string[]): string {
  if (verdict !== "FAILED") return "";
  const clip = (r: string): string => (r.length > 160 ? `${r.slice(0, 157)}...` : r), np = notProven.filter((r) => r.trim() !== "");
  const why = failing.length ? `${failing.length} blocking check${failing.length === 1 ? " still fails" : "s still fail"}` : "the run did not prove the change";
  return [`## Failing checks`, `This run sealed FAILED: ${why}. Opened as a draft so the committed work is visible; it is not ready to merge until these pass.`, ...failing.slice(0, 10).map((c) => `- ${clip(c)}`), ...(failing.length > 10 ? [`- (+${failing.length - 10} more)`] : []), "",
    ...(np.length ? [`## Not proven`, ...np.slice(0, 10).map((r) => `- ${clip(r)}`), ...(np.length > 10 ? [`- (+${np.length - 10} more, total ${np.length}; the full list is in the receipt)`] : []), ""] : [])].join("\n") + "\n";
}
/** PR-BASE rule 2, the check before a pull request is opened, never skipped: the files and commits it would hold against its target must be the
 *  ones the run measured (util/base_guard.ts prScope; the target is fetched first). The seal makes the same measurement and holds its own label,
 *  so this is the backstop for what changed between the seal and the push (the target moved, a commit was added): a pull request that would merge
 *  anything else is never opened green. It opens as a draft with the reason first, and, when the receipt carries the seal's own measurement (pr_base), says the receipt was sealed before that. */
export function prScopeGate(ctx: PrContext, sealed: Verdict, sealedNotes: readonly string[], sealMeasured: boolean): { verdict: Verdict; notProven: string[]; line: string; scope: PrScope } {
  const b = stackBase(process.env), o = ctx.outputs();
  const baseSha = String((o.intake as { base_sha?: unknown } | undefined)?.base_sha ?? ctx.baseSha ?? "");
  const scope = prScope(ctx.repoDir, { target: b === null ? null : prTargetRef(ctx.repoDir, b), baseSha, head: `refs/heads/${ctx.branch}` }); // the branch the push sends, whatever the checkout is on
  const line = `\n${prScopeLine(scope)}\n`;
  if (scope.ok) return { verdict: sealed, notProven: [], line, scope };
  const capped = sealed === "VERIFIED", after = capped && sealMeasured; // after: the receipt holds pr_base, so the seal measured a match and the difference appeared afterwards; without it the seal never measured
  const reason = after ? `${scope.reason!}; the receipt was sealed before the target or the branch changed, so the label is not carried and this is a draft` : scope.reason!;
  return { verdict: capped ? "PARTIAL" : sealed, notProven: sealedNotes.includes(scope.reason!) ? [] : [reason], line: after ? `${line}The receipt was sealed before the pull request's target or branch changed: its label describes ${scope.measured_files ?? "an unknown number of"} files, not what this pull request would merge.\n` : line, scope };
}
export async function runPr(ctx: PrContext, signal: AbortSignal, opts: PrOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before pr started" };
  const pinnedOrigin = ctx.pinnedOrigin;
  if (!pinnedOrigin) return { status: "failed", data: {}, reason: "no pinned origin: refusing to push (Rule of Two)" };
  const seal = (ctx.outputs().seal ?? {}) as { verdict?: Verdict; not_proven?: string[]; receipt_path?: string; receipt_sha256?: string; signed?: boolean; route_line?: string; mutation_line?: string };
  const scopeGate = prScopeGate(ctx, seal.verdict ?? "PARTIAL", seal.not_proven ?? [], (() => { try { return !!seal.receipt_path && "pr_base" in (JSON.parse(readFileSync(seal.receipt_path, "utf8")) as object); } catch { return false; } })()); // PR-BASE: the one call of the pre-open check; an unknown verdict is never treated as VERIFIED (fail-safe)
  const verdict = scopeGate.verdict;
  const notProven = collapseNotProven([...scopeGate.notProven, ...(seal.not_proven ?? [])]); // FC-OUTCOME-FLOOD: display only; receipt.json keeps the full list
  const capHit = ctx.capHit?.() ?? false;
  const draft = verdict !== "VERIFIED" || capHit || process.env.LOKI_PR_DRAFT === "1" || (ctx as PrContext).draft === true; // MASS-1: `loki issues run --draft` asks for drafts only; it never un-drafts
  const base = stackBase(process.env);
  if (base === null) return { status: "failed", data: {}, reason: "LOKI_PR_BASE is not a valid branch name: refusing to push" };
  { // EMPTY-PUSH: never push a branch that changes nothing against the run's base (FireLater#24 on 11.162.0 pushed one, then gh pr create failed); unknown goes on
    const b0 = (ctx.outputs().intake as { base_sha?: unknown } | undefined)?.base_sha, runBase = typeof b0 === "string" && /^[0-9a-f]{40,64}$/.test(b0) ? b0 : typeof ctx.baseSha === "string" && /^[0-9a-f]{40,64}$/.test(ctx.baseSha) ? ctx.baseSha : null;
    if (runBase && diffAgainstBase(ctx.repoDir, runBase, `refs/heads/${ctx.branch}`) === false) return { status: "skipped", data: {}, reason: `nothing to push: ${ctx.branch} has no change against the base ${runBase.slice(0, 12)}` };
  }
  mkdirSync(ctx.runDir, { recursive: true });
  const link = issueLink(ctx.runDir, verdict);
  const bodyFile = join(ctx.runDir, "pr-body.md");
  const beforeAfter = await beforeAfterBlock(ctx.repoDir, ctx.runDir, ((ctx.outputs().verify?.["changed_files"] ?? []) as unknown[]).map(String), ctx.baseSha, { signal });
  const vo = ctx.outputs().verify as { checks?: unknown; pre_red_checks?: unknown } | undefined, failing = verdict === "FAILED" ? failedCheckNames(vo?.checks, Array.isArray(vo?.pre_red_checks) ? (vo.pre_red_checks as unknown[]).map(String) : []) : []; // FAILED-PR: the final verify's blocking failures
  const sealedReceipt = (() => { try { return seal.receipt_path ? JSON.parse(readFileSync(seal.receipt_path, "utf8")) as Record<string, unknown> : null; } catch { return null; } })();
  // DELIVER-WHAT-EXISTS: a blocked run and a run with no sealed receipt lead with their state; a sealed run that hit the cap says why it stopped after its own head
  const sealedOk = typeof seal.receipt_sha256 === "string" && seal.receipt_sha256 !== "", runEvents = ((): EventEnvelope[] => { try { return readEvents(join(ctx.repoDir, eventsRelPath(ctx.runId))); } catch { return []; } })();
  const intakeOut = ctx.outputs().intake as { base_sha?: unknown } | undefined, baseOf = typeof intakeOut?.base_sha === "string" && SHA_RE.test(intakeOut.base_sha) ? intakeOut.base_sha : null;
  const stat = ((): string => { try { return baseOf ? safeGit(ctx.repoDir, ["diff", "--shortstat", baseOf, "HEAD", "--", ".", ":(exclude).loki"]).trim() : ""; } catch { return ""; } })();
  const vchecks = (Array.isArray(vo?.checks) ? (vo.checks as { result?: unknown }[]) : []), vpass = vchecks.filter((c) => c.result === "pass").length, vfail = vchecks.filter((c) => c.result === "fail").length;
  const issueRef = ((): string | null => { try { const i = JSON.parse(readFileSync(join(ctx.runDir, "issue.json"), "utf8")) as { repo?: unknown; number?: unknown }; return typeof i.repo === "string" && Number.isInteger(i.number) ? `${i.repo}#${i.number as number}` : null; } catch { return null; } })();
  const rerun = issueRef ? `loki start ${issueRef}` : 'loki start "<the same task>"';
  const lead = stateHead({ verdict, sealed: sealedOk, runId: ctx.runId, question: conflictReasonOf(runEvents) ?? null,
    reason: sealedOk ? "" : notProven.find((n) => /backstop|killed|no receipt|not sealed/i.test(n)) ?? "the engine ended before sealing a receipt", next: rerun,
    done: [stat ? `${stat}, committed on ${ctx.branch}` : `the change is committed on ${ctx.branch}`, vchecks.length ? `checks Loki ran${sealedOk ? "" : " before the stop"}: ${vpass} passed, ${vfail} failed` : "no check result is recorded"],
    open: [...(sealedOk ? [] : failedCheckNames(vo?.checks, Array.isArray(vo?.pre_red_checks) ? (vo.pre_red_checks as unknown[]).map(String) : []).map((c) => `failing when the run stopped: ${c}`)), ...notProven] });
  const stopNote = stopSection(verdict, sealedOk, capHit, `if the cost cap was hit, loki start --max-cost <higher>, then ${rerun}; if the time cap, ${rerun} with more time`);
  const reviewerBody = lead + acceptanceHead(verdict, sealedReceipt) + partialHead(verdict, notProven, sealedReceipt?.["prove"]) + (lead ? "" : failedHead(verdict, failing, notProven)) + reviewFindingsSection(sealedReceipt) + stopNote + renderReviewerBody({ verdict, draftReason: draftReason(verdict, capHit), notProven, receiptPath: seal.receipt_path ?? null, receiptSha256: seal.receipt_sha256 ?? null, signed: typeof seal.signed === "boolean" ? seal.signed : null, runId: ctx.runId, outputs: ctx.outputs(), sealAccuracy: sealAccuracyOfFile(seal.receipt_path ?? null), receipt: sealedReceipt }); // AWE-3: proof, conventions and cost sections read the sealed receipt
  const tpl = readPrTemplate(ctx.repoDir), shaped = tpl === null ? reviewerBody : applyPrTemplate(reviewerBody, tpl, receiptProof(verdict, ctx.outputs(), seal.receipt_sha256 ?? null)); // no template: today's body, byte-identical
  writeFileSync(bodyFile, withAiMarker(withSealRoute(shaped, process.env, seal), aiMarkerLine({ runId: ctx.runId, provider: ctx.provider, model: ctx.model })) + intentSection(ctx.outputs().plan) + specPrLine(process.env) + triagePrLine(ctx.outputs().intake) + scopeGate.line +evidenceSection(seal.receipt_path) + briefSection(ctx) + beforeAfter + (seal.mutation_line ? `\n${seal.mutation_line}\n` : "") + link + stackSection(process.env, base, link !== "", ctx.repoDir) + (ctx.handoffMd ?? ""), "utf8");
  const title = prTitle(verdict, ctx.runDir, String((ctx.outputs().intake as { task?: unknown } | undefined)?.task ?? ""), failing); // PR-FIRST-1 prefix, FireLater#21 wording, FAILED-PR check label
  const scriptPath = opts.pushScriptPath ?? DEFAULT_PUSH_SH;
  const env = pushEnv(ctx.repoDir, pinnedOrigin); opts.onSpawnEnv?.(env);
  const pr = runOnce({ dir: ctx.runDir, key: idempotencyKey("pr", ctx.runId, ctx.branch), keep: (r) => r.ok, post: () => runPushPr({ repoDir: ctx.repoDir, branch: ctx.branch, title, bodyFile, draft, pinnedOrigin, base, scriptPath, gitlabScriptPath: opts.gitlabPushScriptPath, env }) }); // P12-36: push-pr reuses an existing PR, so a pending replay is duplicate-safe
  if (!pr.ok) return { status: "failed", data: {}, reason: pr.reason + publishFallback(ctx.runDir, ctx.branch, base) };
  const { url, localOk, existing } = pr;
  ctx.emit("pr.opened", "pr", { url, draft, existing });
  const headSha = safeGit(ctx.repoDir, ["rev-parse", "HEAD"]).trim();
  const notProvenOut: string[] = [];
  if (verdict === "FAILED" || verdict === "SPEC_CONFLICT") {
    notProvenOut.push(`commit status loki/deep-verify not set (a ${verdict === "FAILED" ? "FAILED" : "blocked"} run gets no deep verify)`); // FAILED-PR: never a pending status nothing will ever resolve
  } else if (localOk) {
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
  if (!localOk && !isGitlabOrigin(pinnedOrigin) && SHA_RE.test(headSha)) { // RECEIPT-STATUS: the sealed verdict as a commit status on this head, so a branch rule can require it; a later push by anyone has none
    const green = verdict === "VERIFIED" && !draft, sha12 = (seal.receipt_sha256 ?? "").slice(0, 12);
    if (!runReceiptStatus({ repoDir: ctx.repoDir, sha: headSha, state: green ? "success" : "failure", description: `Loki run ${verdict}${sha12 ? `, receipt sha256:${sha12}` : ""}`, pinnedOrigin, scriptPath, env })) notProvenOut.push("commit status loki/receipt not set"); // non-fatal, as the deep-verify status above
  }
  const receiptComment = renderReceiptComment({
    verdict, draft, draftReason: draftReason(verdict, capHit), notProven: [...notProven, ...notProvenOut],
    receiptSha256: seal.receipt_sha256 ?? null, runId: ctx.runId, mutationProof: seal.mutation_line ?? null,
    passport: await buildPassport(ctx.runDir),
  }); // the same items as the PR body (no new exposure), plus this stage's own commit-status misses
  if (!localOk && !isGitlabOrigin(pinnedOrigin) && process.env["LOKI_PR_LABEL"] !== "0") { const miss = applyLokiLabel({ verdict, url, runDir: ctx.runDir, env, timeoutMs: prChildTimeoutMs() }); if (miss) notProvenOut.push(miss); } // the green or red label on the pull request and the issue; LOKI_PR_LABEL=0 opts out
  const commentMiss = postReceiptComment({ scriptPath, env, runDir: ctx.runDir, url, timeoutMs: prChildTimeoutMs(), comment: receiptComment });
  if (commentMiss) notProvenOut.push(commentMiss);
  if (verdict !== "SPEC_CONFLICT") await (await import("../../integrations/writeback.ts")).writeBack({ phase: verdict === "FAILED" ? "failed" : "done", ...(verdict === "FAILED" ? { reason: `failing: ${failing.join(", ") || "see the receipt"}` } : {}), verdict, prUrl: url, receiptSha256: seal.receipt_sha256 ?? null, task: String((ctx.outputs().intake as { task?: unknown } | undefined)?.task ?? "") }); // B6: opt-in, never throws
  if (scopeGate.notProven.length) notProvenOut.unshift(...scopeGate.notProven); // PR-BASE: the run's own not-proven list and console carry the reason too
  return { status: "completed", data: { pr_url: url, draft, existing, pr_scope: scopeGate.scope, ...(notProvenOut.length ? { not_proven: notProvenOut } : {}) } };
}
export const stage: Stage = {
  name: "pr", targetS: 15, limitS: 60, run: (ctx, signal) => runPr(ctx as PrContext, signal),
};
