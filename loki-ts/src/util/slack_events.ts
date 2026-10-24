// D51-A4: Slack notifications for the v10 engine (PR opened, BLOCKED, finished). One entry point.
// Payload mirrors autonomy/notify.sh _notify_slack. The webhook URL comes from the env var named by LOKI_SLACK_WEBHOOK_ENV (default LOKI_SLACK_WEBHOOK_URL) and is never logged.
export type SlackEvent = "pr_opened" | "blocked" | "finished" | "budget" | "stuck";
export interface SlackFields { repo?: string; issue?: string; prUrl?: string; outcome?: string; question?: string; cost?: string; time?: string; summary?: string; receipt?: string; stage?: string; lastEventAt?: string; action?: string }
const COLORS: Record<SlackEvent, string> = { finished: "#36a64f", budget: "#ff9800", pr_opened: "#2eb886", blocked: "#ff9800", stuck: "#ff9800" };

export function slackPayload(event: SlackEvent, f: SlackFields): { text: string; attachments: unknown[] } {
  const title = { pr_opened: "PR opened", blocked: "Run BLOCKED", finished: "Run finished", budget: "Budget", stuck: "Run silent" }[event];
  const fields: [string, string][] = [["Event", event]];
  if (event === "stuck") fields.push(["Stage", f.stage ?? "unknown"], ["Last event", f.lastEventAt ?? ""], ["Suggested action", f.action ?? ""]);
  if (event !== "finished" && event !== "stuck") fields.push(["Repo", f.repo || "unknown"], ["Issue", f.issue || "none"]);
  if (event === "pr_opened") fields.push(["PR", f.prUrl ?? "none"], ["Outcome", f.outcome ?? ""]);
  if (event === "blocked") fields.push(["Question", f.question ?? ""]);
  if (event === "budget") fields.push(["Spent", f.cost ?? "not measured"], ["Cap", f.question ?? ""]);
  if (event === "finished") fields.push(["Outcome", f.outcome ?? ""], ["Cost", f.cost ?? "not measured"], ["Time", f.time ?? ""], ["Receipt", f.receipt || "(unattested)"]);
  const rcpt = event === "finished" ? `\nreceipt ${f.receipt || "(unattested)"}` : "";
  const text = (f.summary ?? (event === "budget" ? `${title}: ${f.cost}` : event === "stuck" ? `${title}: no event since ${f.lastEventAt} (last stage ${f.stage}). ${f.action}` : event === "pr_opened" ? `${title}: ${f.prUrl} (${f.outcome})` : `${title}: ${f.question}`)) + rcpt;
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
  await Promise.race([send(), new Promise<void>((r) => setTimeout(r, notifyTimeoutMs(env)).unref())]);
}

/** Only a finite positive value is honored; negative, zero, NaN or junk fall back to 5000. */
function notifyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.LOKI_E10_NOTIFY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

export const STUCK_MIN_DEFAULT = 15;
/** LOKI_STUCK_MIN: minutes of event silence before one alert. Only a finite positive value is honored; 0, negative or junk fall back to 15. */
export function stuckMinutes(env: NodeJS.ProcessEnv): number {
  const n = Number(env.LOKI_STUCK_MIN);
  return Number.isFinite(n) && n > 0 ? n : STUCK_MIN_DEFAULT;
}
export const STUCK_ACTION = "check `loki status` and the run log; if the provider session hung, stop the run and resume it";

export interface StuckWatch { event(stage: string, atMs: number): void; tick(nowMs: number): void }
/** Alerts once per silence: a new event re-arms the latch. The notifier and clock are injected. */
export function createStuckWatch(thresholdMin: number, startMs: number, notify: (f: SlackFields) => void): StuckWatch {
  let last = { stage: "start", at: startMs }, fired = false;
  return {
    event(stage, atMs) { last = { stage, at: atMs }; fired = false; },
    tick(nowMs) {
      if (fired || nowMs - last.at < thresholdMin * 60_000) return;
      fired = true;
      notify({ stage: last.stage, lastEventAt: new Date(last.at).toISOString(), action: STUCK_ACTION });
    },
  };
}
