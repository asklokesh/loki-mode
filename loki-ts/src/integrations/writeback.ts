// B6: opt-in Jira / Linear write-back. One shared call serves every intake origin and phase (started, blocked, done, failed): a comment with the outcome,
// plus an optional status move on done (LOKI_JIRA_DONE_TRANSITION id, LOKI_LINEAR_DONE_STATE state id).
// Off unless the env config is complete (no network call otherwise). Failures warn on stderr and never change a verdict or exit code. Tokens are never logged.
export type WritebackPhase = "started" | "blocked" | "done" | "failed";
export interface WritebackInput {
  verdict: string;
  prUrl: string | null;
  receiptSha256: string | null;
  task: string;
  phase?: WritebackPhase;
  reason?: string;
  origin?: { kind: "jira" | "linear" | "github"; ref: string };
}
type Env = Record<string, string | undefined>;
const KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/;
const TIMEOUT_MS = 10_000;

/** Issue key: the origin ref, then LOKI_WRITEBACK_ISSUE, else (legacy opt-in only, see writeBack) the first KEY-123 reference in the brief. */
export function issueKeyOf(task: string, env: Env = process.env, origin?: WritebackInput["origin"], useTask = true): string | null {
  return (origin?.ref ?? "").match(KEY_RE)?.[0] ?? (env.LOKI_WRITEBACK_ISSUE ?? "").match(KEY_RE)?.[0] ?? (useTask ? task.match(KEY_RE)?.[0] ?? null : null);
}
export function commentText(i: WritebackInput): string {
  const phase = i.phase ?? "done";
  const reason = i.reason ? `Reason: ${i.reason}` : null;
  if (phase === "started") return "Loki started work on this issue.";
  if (phase === "blocked") return ["Loki is blocked and needs input.", reason].filter(Boolean).join("\n");
  if (phase === "failed") return ["Loki run failed without a PR.", reason].filter(Boolean).join("\n");
  return [`Loki outcome: ${i.verdict}`, `PR: ${i.prUrl ?? "none"}`, `Receipt sha256: ${i.receiptSha256 ?? "unavailable"}`].join("\n");
}
async function post(url: string, init: RequestInit, label: string, what = "comment"): Promise<void> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) process.stderr.write(`writeback: ${label} ${what} failed (HTTP ${r.status})\n`);
  } catch (e) {
    process.stderr.write(`writeback: ${label} ${what} failed (${(e as Error).name})\n`);
  }
}
/** Never throws. No-op (no network) unless Jira or Linear config is complete and an issue key is found. Intake credentials (JIRA_*, LINEAR_API_KEY) also enable it, but only for an explicit origin/LOKI_WRITEBACK_ISSUE key. */
export async function writeBack(i: WritebackInput, env: Env = process.env): Promise<void> {
  try {
    const jira = env.LOKI_JIRA_URL ?? env.JIRA_BASE_URL, jt = env.LOKI_JIRA_TOKEN ?? env.JIRA_API_TOKEN, je = env.LOKI_JIRA_EMAIL ?? env.JIRA_EMAIL;
    const lt = env.LOKI_LINEAR_TOKEN ?? env.LINEAR_API_KEY;
    const jiraOn = !!(jira && jt && je), linearOn = !!lt;
    if (!jiraOn && !linearOn) return;
    const legacy = !!(env.LOKI_JIRA_URL && env.LOKI_JIRA_TOKEN && env.LOKI_JIRA_EMAIL) || !!env.LOKI_LINEAR_TOKEN;
    const key = issueKeyOf(i.task, env, i.origin, legacy);
    if (!key) return;
    const kind = i.origin?.kind;
    const text = commentText(i);
    const done = (i.phase ?? "done") === "done";
    if (jiraOn && kind !== "linear" && kind !== "github") {
      const base = `${jira!.replace(/\/+$/, "")}/rest/api/3/issue/${encodeURIComponent(key)}`;
      const headers = { "content-type": "application/json", accept: "application/json", authorization: `Basic ${Buffer.from(`${je}:${jt}`).toString("base64")}` };
      const body = { body: { type: "doc", version: 1, content: text.split("\n").map((l) => ({ type: "paragraph", content: [{ type: "text", text: l }] })) } };
      await post(`${base}/comment`, { method: "POST", headers, body: JSON.stringify(body) }, "Jira");
      if (done && env.LOKI_JIRA_DONE_TRANSITION) {
        await post(`${base}/transitions`, { method: "POST", headers, body: JSON.stringify({ transition: { id: env.LOKI_JIRA_DONE_TRANSITION } }) }, "Jira", "transition");
      }
    }
    if (linearOn && kind !== "jira" && kind !== "github") {
      const url = env.LOKI_LINEAR_URL ?? "https://api.linear.app/graphql";
      const headers = { "content-type": "application/json", authorization: lt! };
      const query = "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }";
      await post(url, { method: "POST", headers, body: JSON.stringify({ query, variables: { issueId: key, body: text } }) }, "Linear");
      if (done && env.LOKI_LINEAR_DONE_STATE) {
        const q = "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }";
        await post(url, { method: "POST", headers, body: JSON.stringify({ query: q, variables: { id: key, stateId: env.LOKI_LINEAR_DONE_STATE } }) }, "Linear", "state change");
      }
    }
  } catch {
    process.stderr.write("writeback: skipped (unexpected error)\n");
  }
}
