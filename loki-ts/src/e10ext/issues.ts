// E-127 (D41 item 5): list open issues for a label or milestone as pure data. Data only (D42):
// no stages/, Seal, verify or Wall imports. Reuses fetch_issue.ts's Execer; args go as an array,
// never through a shell string, so label text cannot inject.
import { defaultExec, type Execer } from "../engine10/fetch_issue.ts";

export const MAX_ISSUES = 50;

export interface IssueSummary {
  ref: string; // owner/repo#N, the form fetchIssue() accepts
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export interface IssueQuery {
  repo: string;
  label?: string;
  milestone?: string;
  limit: number;
}

/** Lists open issues. Throws on a bad query or malformed gh output; never returns partial data. */
export function fetchIssues(q: IssueQuery, execer: Execer = defaultExec): IssueSummary[] {
  if (!/^[\w][\w.-]*\/[\w][\w.-]*$/.test(q.repo) || q.repo.split("/").some((s) => s.includes(".."))) throw new Error(`fetchIssues: invalid repo "${q.repo}"`);
  if (!Number.isInteger(q.limit) || q.limit < 1) throw new Error(`fetchIssues: invalid limit ${q.limit}`);
  const limit = Math.min(q.limit, MAX_ISSUES);
  for (const [k, v] of [["label", q.label], ["milestone", q.milestone]]) {
    if (v && v.startsWith("-")) throw new Error(`fetchIssues: invalid ${k} "${v}"`);
  }
  const args = ["issue", "list", "--repo", q.repo];
  if (q.label) args.push(`--label=${q.label}`);
  if (q.milestone) args.push(`--milestone=${q.milestone}`);
  args.push("--state", "open", "--limit", String(limit), "--json", "number,title,body,labels,url");

  let raw: unknown;
  try {
    raw = JSON.parse(execer("gh", args));
  } catch (e) {
    throw new Error(`fetchIssues: gh output is not valid JSON or gh failed: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error("fetchIssues: expected a JSON array from gh");
  return raw.map((r, i): IssueSummary => {
    const x = r as Record<string, unknown> | null;
    const labels = x?.labels;
    if (
      !x || !Number.isInteger(x.number) || typeof x.title !== "string" || typeof x.url !== "string"
      || !(x.body === undefined || x.body === null || typeof x.body === "string")
      || !Array.isArray(labels) || !labels.every((l) => typeof (l as { name?: unknown })?.name === "string")
    ) throw new Error(`fetchIssues: malformed issue at index ${i}`);
    const number = x.number as number;
    return {
      ref: `${q.repo}#${number}`, number, title: x.title, body: (x.body as string | null) ?? "",
      labels: labels.map((l) => (l as { name: string }).name), url: x.url,
    };
  });
}
