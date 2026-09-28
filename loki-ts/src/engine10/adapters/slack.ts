// loki-ts/src/engine10/adapters/slack.ts -- E-28 Slack notify adapter (ENGINE.md section 13/16).
// Posts the 5-line summary (output.ts) to LOKI_SLACK_WEBHOOK_URL.
// ponytail: Adapter interface copied verbatim from ENGINE.md section 13, predates adapters/types.ts.
// RunSummary resolves to output.ts's SummaryInput (what produces the posted summary); unused
// NormalizedIssue/PrRequest are left as `unknown`. Switch this import to "./types.ts" at merge.
import { formatSummary, type SummaryInput } from "../output.ts";
type RunSummary = SummaryInput;
type NormalizedIssue = unknown;
type PrRequest = unknown;
export interface Adapter {
  name: "github" | "gitlab" | "jira" | "slack";
  matches?(ref: string): boolean;
  fetchIssue?(ref: string): Promise<NormalizedIssue>;
  openPr?(req: PrRequest): Promise<{ url: string; draft: boolean }>;
  notify?(summary: RunSummary): Promise<void>;
}
/** webhookUrl defaults to LOKI_SLACK_WEBHOOK_URL (section 13); unset or empty means no call. */
export function createSlackAdapter(
  webhookUrl: string | undefined = process.env.LOKI_SLACK_WEBHOOK_URL,
): Adapter {
  return {
    name: "slack",
    async notify(summary: RunSummary): Promise<void> {
      if (!webhookUrl) return;
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: formatSummary(summary) }),
      });
    },
  };
}
