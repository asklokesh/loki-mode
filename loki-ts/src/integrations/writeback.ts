// B6: opt-in Jira / Linear write-back. After a PR opens, post ONE comment with the receipt verdict, the PR URL and the receipt sha256.
// Off unless the env config is complete (no network call otherwise). Failures warn on stderr and never change a verdict or exit code. Tokens are never logged.
export interface WritebackInput {
  verdict: string;
  prUrl: string | null;
  receiptSha256: string | null;
  task: string;
}
type Env = Record<string, string | undefined>;
const KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/;
const TIMEOUT_MS = 10_000;

/** Issue key: LOKI_WRITEBACK_ISSUE (the --issue value) first, else the first KEY-123 reference in the brief. */
export function issueKeyOf(task: string, env: Env = process.env): string | null {
  return (env.LOKI_WRITEBACK_ISSUE ?? "").match(KEY_RE)?.[0] ?? task.match(KEY_RE)?.[0] ?? null;
}
export function commentText(i: WritebackInput): string {
  return [`Loki outcome: ${i.verdict}`, `PR: ${i.prUrl ?? "none"}`, `Receipt sha256: ${i.receiptSha256 ?? "unavailable"}`].join("\n");
}
async function post(url: string, init: RequestInit, label: string): Promise<void> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) process.stderr.write(`writeback: ${label} comment failed (HTTP ${r.status})\n`);
  } catch (e) {
    process.stderr.write(`writeback: ${label} comment failed (${(e as Error).name})\n`);
  }
}
/** Never throws. No-op (no network) unless Jira or Linear config is complete and an issue key is found. */
export async function writeBack(i: WritebackInput, env: Env = process.env): Promise<void> {
  try {
    const { LOKI_JIRA_URL: jira, LOKI_JIRA_TOKEN: jt, LOKI_JIRA_EMAIL: je, LOKI_LINEAR_TOKEN: lt } = env;
    if (!((jira && jt && je) || lt)) return;
    const key = issueKeyOf(i.task, env);
    if (!key) return;
    const text = commentText(i);
    if (jira && jt && je) {
      const body = { body: { type: "doc", version: 1, content: text.split("\n").map((l) => ({ type: "paragraph", content: [{ type: "text", text: l }] })) } };
      await post(`${jira.replace(/\/+$/, "")}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Basic ${Buffer.from(`${je}:${jt}`).toString("base64")}` },
        body: JSON.stringify(body),
      }, "Jira");
    }
    if (lt) {
      const query = "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }";
      await post(env.LOKI_LINEAR_URL ?? "https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: lt },
        body: JSON.stringify({ query, variables: { issueId: key, body: text } }),
      }, "Linear");
    }
  } catch {
    process.stderr.write("writeback: skipped (unexpected error)\n");
  }
}
