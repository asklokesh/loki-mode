// GitHub receipt comment. The PR body already carries the same facts (e10ext/reviewer_body.ts).
// This is the short comment a reviewer sees without opening the body. No new receipt format.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pushArgv } from "../engine10/types.ts";
import { run } from "./shell.ts";

export interface ReceiptCommentInput {
  verdict: string;
  draft: boolean;
  draftReason: string | null;
  notProven: readonly string[];
  receiptSha256: string | null;
  runId: string;
  /** Wall-on-the-old-tree line from seal, when mutation proof ran. Absent on older callers. */
  mutationProof?: string | null;
}

/** The last lines of a run. Same facts as the receipt: verdict, money, time, checks the harness ran, fail-to-pass, hash. A null dollar amount is "not measured", never $0. */
export function renderProofCard(i: {
  verdict: string;
  usd: number | null;
  wallS: number;
  checks: number;
  mutationProof: string | null;
  sha: string | null;
  tampered?: boolean;
}): string {
  const verdict = i.tampered ? "TAMPERED" : i.verdict;
  const cost = i.usd == null ? "cost not measured" : `$${i.usd.toFixed(2)}`;
  const secs = Number.isFinite(i.wallS) && i.wallS >= 0 ? Math.round(i.wallS) : 0;
  const n = Number.isFinite(i.checks) && i.checks > 0 ? Math.floor(i.checks) : 0;
  const proof = i.mutationProof ?? "fail-to-pass: no proof line on the receipt";
  const sha = i.sha ? `sha256:${i.sha}` : "receipt not sealed";
  return [`LOKI ${verdict}`, `${cost} in ${secs}s, ${n} checks run outside the model`, proof, sha].join("\n");
}

/** Structured PR comment: outcome, receipt hash, verify command, PROVEN vs NOT PROVEN. */
export function renderReceiptComment(i: ReceiptCommentInput): string {
  const proven = i.verdict === "VERIFIED" && !i.draft
    ? "PROVEN: sealed verdict VERIFIED"
    : `PROVEN: no verified claim (verdict ${i.verdict})`;
  const items = i.notProven.length > 0 ? i.notProven.map((p) => `- ${p}`) : ["- none"];
  return [
    "<!-- loki-receipt -->",
    "## Loki receipt",
    `- Outcome: ${i.verdict}${i.draft ? ` (DRAFT${i.draftReason ? `: ${i.draftReason}` : ""})` : ""}`,
    `- Receipt: ${i.receiptSha256 ? `sha256:${i.receiptSha256}` : "not sealed"}`,
    `- Verify: \`loki verify ${i.runId}\``,
    `- ${proven}`,
    ...(i.mutationProof ? [`- Proof: ${i.mutationProof}`] : []),
    "## NOT PROVEN",
    ...items,
    "",
  ].join("\n");
}

/** GitHub PR number from a push-pr URL. Local and GitLab URLs return null (no comment). */
export function prNumberFromUrl(url: string): string | null {
  const m = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)$/.exec(url);
  return m?.[1] ?? null;
}

/**
 * Upsert the receipt comment through engine10-push.sh issue-comment --update, keyed on the
 * <!-- loki-receipt --> marker, so a re-run or resume on the same PR edits one comment.
 * Returns null when there is nothing to post or the post succeeded.
 * Returns a NOT PROVEN line (with the exit status and first stderr line) when the post failed. Never throws.
 */
export function postReceiptComment(a: {
  scriptPath: string;
  env: NodeJS.ProcessEnv;
  runDir: string;
  url: string;
  comment: string;
  timeoutMs: number;
}): string | null {
  const num = prNumberFromUrl(a.url);
  if (!num) return null;
  try {
    const file = join(a.runDir, "receipt-comment.md");
    writeFileSync(file, a.comment, "utf8");
    const r = spawnSync("bash", [a.scriptPath, "issue-comment", "--update", `#${num}`, file], {
      env: a.env,
      encoding: "utf8",
      timeout: a.timeoutMs,
      killSignal: "SIGKILL",
    });
    if (r.status === 0) return null;
    const why = (r.stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 160);
    return `receipt comment not posted (exit ${r.status ?? r.signal ?? "unknown"}${why ? `: ${why}` : ""})`;
  } catch {
    return "receipt comment not posted";
  }
}

/** PR number at the end of a push-pr URL (any host). Looser than prNumberFromUrl on purpose: the deep-verify comment accepts a non-github URL. */
const PR_NUMBER_RE = /\/pull\/(\d+)$/;
type CommentCheck = { name: string; result: string; reason?: string };

export function buildDeepCommentBody(checks: CommentCheck[], notProven: string[], statusState: "success" | "failure"): string {
  const lines = [`## Loki deep verify: ${statusState}`, "", "### Checks"];
  lines.push(...(checks.length ? checks.map((c) => `- ${c.result}: ${c.name}${c.reason ? ` (${c.reason})` : ""}`) : ["- none"]));
  lines.push("", "### NOT PROVEN", ...(notProven.length ? notProven.map((n) => `- ${n}`) : ["- none"]));
  return `${lines.join("\n")}\n`;
}

/** Post the deep-verify comment and commit status through engine10-push.sh. headSha is "" when HEAD did not resolve to a full sha. Returns NOT PROVEN lines for each failed post. */
export async function postDeepResults(a: {
  scriptPath: string; extraEnv?: Record<string, string>; pinnedOrigin?: string; prUrl?: string; headSha: string;
  repoDir: string; runDir: string; checks: CommentCheck[]; notProven: string[]; statusState: "success" | "failure";
}): Promise<string[]> {
  const out: string[] = [];
  if (!a.pinnedOrigin) {
    out.push("push refused: no pinned origin (Rule of Two)");
    return out;
  }
  const env = { ...process.env, ...a.extraEnv, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: a.pinnedOrigin };
  const prNumber = a.prUrl ? PR_NUMBER_RE.exec(a.prUrl)?.[1] : undefined;
  if (prNumber) {
    mkdirSync(a.runDir, { recursive: true });
    const bodyFile = join(a.runDir, "deep-comment.md");
    writeFileSync(bodyFile, buildDeepCommentBody(a.checks, a.notProven, a.statusState), "utf8");
    // engine10-push.sh takes `comment <pr-number> <body-file>`; pushArgv "comment" does not match that contract
    const commentResult = await run(["bash", a.scriptPath, "comment", prNumber, bodyFile], { cwd: a.repoDir, env, timeoutMs: 30_000 });
    if (commentResult.exitCode !== 0) out.push(`deep comment not posted (engine10-push.sh exit ${commentResult.exitCode})`);
  } else {
    out.push("deep comment not posted (no PR number)");
  }
  if (a.headSha) {
    const statusResult = await run(["bash", a.scriptPath, ...pushArgv({ cmd: "status", sha: a.headSha, state: a.statusState, description: `Loki 10 deep verify: ${a.statusState}` })], { cwd: a.repoDir, env, timeoutMs: 30_000 });
    if (statusResult.exitCode !== 0) out.push(`loki/deep-verify status not set (engine10-push.sh exit ${statusResult.exitCode})`);
  } else {
    out.push("loki/deep-verify status not set (HEAD sha not resolvable)");
  }
  return out;
}
