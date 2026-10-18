// GitHub receipt comment. The PR body already carries the same facts (e10ext/reviewer_body.ts).
// This is the short comment a reviewer sees without opening the body. No new receipt format.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
  const proof = i.mutationProof ?? "fail-to-pass: not recorded";
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
    `- Receipt: ${i.receiptSha256 ? `sha256:${i.receiptSha256}` : "not recorded"}`,
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
 * Post the receipt comment through engine10-push.sh comment.
 * Returns null when there is nothing to post or the post succeeded.
 * Returns a NOT PROVEN line when the post failed. Never throws.
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
    const r = spawnSync("bash", [a.scriptPath, "comment", num, file], {
      env: a.env,
      encoding: "utf8",
      timeout: a.timeoutMs,
      killSignal: "SIGKILL",
    });
    return r.status === 0 ? null : "receipt comment not posted";
  } catch {
    return "receipt comment not posted";
  }
}
