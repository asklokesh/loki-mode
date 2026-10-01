// D51-A4: Slack notifications for the v10 engine (PR opened, BLOCKED, finished). One entry point.
// Payload shape mirrors autonomy/notify.sh _notify_slack (attachment: color, "Loki Mode: <title>", fields, footer).
// Webhook URL comes from the env var named by LOKI_SLACK_WEBHOOK_ENV (default LOKI_SLACK_WEBHOOK_URL); it is never logged.
export type SlackEvent = "pr_opened" | "blocked" | "finished";
export interface SlackFields { repo?: string; issue?: string; prUrl?: string; outcome?: string; question?: string; cost?: string; time?: string; summary?: string }
const COLORS: Record<SlackEvent, string> = { finished: "#36a64f", pr_opened: "#2eb886", blocked: "#ff9800" };

export function slackPayload(event: SlackEvent, f: SlackFields): { text: string; attachments: unknown[] } {
  const title = { pr_opened: "PR opened", blocked: "Run BLOCKED", finished: "Run finished" }[event];
  const fields: [string, string][] = [["Event", event]];
  if (event !== "finished") fields.push(["Repo", f.repo || "unknown"], ["Issue", f.issue || "none"]);
  if (event === "pr_opened") fields.push(["PR", f.prUrl ?? "none"], ["Outcome", f.outcome ?? ""]);
  if (event === "blocked") fields.push(["Question", f.question ?? ""]);
  if (event === "finished") fields.push(["Outcome", f.outcome ?? ""], ["Cost", f.cost ?? "not measured"], ["Time", f.time ?? ""]);
  const text = f.summary ?? (event === "pr_opened" ? `${title}: ${f.prUrl} (${f.outcome})` : `${title}: ${f.question}`);
  return { text, attachments: [{ color: COLORS[event], title: `Loki Mode: ${title}`, text, fields: fields.map(([title, value]) => ({ title, value, short: true })), footer: "Loki Mode", ts: Math.floor(Date.now() / 1000) }] };
}

/** Never throws; no webhook means no call. A failure prints only the error text with the URL scrubbed. */
export async function notifyEvent(env: NodeJS.ProcessEnv, event: SlackEvent, f: SlackFields): Promise<void> {
  const url = env[env.LOKI_SLACK_WEBHOOK_ENV || "LOKI_SLACK_WEBHOOK_URL"];
  if (!url) return;
  const send = async () => {
    try { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(slackPayload(event, f)) }); }
    catch (e) { process.stderr.write(`engine10: slack notify failed: ${String((e as Error)?.message ?? e).split(url).join("[redacted]")}\n`); }
  };
  await Promise.race([send(), new Promise<void>((r) => setTimeout(r, Number(env.LOKI_E10_NOTIFY_TIMEOUT_MS) || 5000).unref())]);
}
