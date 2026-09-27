// loki-ts/src/engine10/adapters/slack.ts
//
// E-28: Slack notify adapter (docs/v10/ENGINE.md section 16, section 13).
// Posts the 5-line summary (E-13, output.ts) to LOKI_SLACK_WEBHOOK_URL.
//
// ponytail: adapters/types.ts (E-25) is not on main yet, so the Adapter
// interface below is copied verbatim from ENGINE.md section 13. RunSummary
// (never defined in ENGINE.md) is resolved to output.ts's SummaryInput,
// which is what already produces the 5-line summary this adapter posts.
// NormalizedIssue and PrRequest (also undefined, and unused by this file)
// are left as `unknown`. Switch this import to "./types.ts" at merge.
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
