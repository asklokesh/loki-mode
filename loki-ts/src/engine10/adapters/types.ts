// loki-ts/src/engine10/adapters/types.ts -- E-25 adapter interface (ENGINE.md section 13). One
// adapter per external issue tracker / VCS host / notifier, behind `name` plus four optional
// methods; github.ts implements it. PrRequest/PrResult/RunSummary are local (types.ts declares
// none), the same local-extension pattern stages/pr.ts's PrContext uses for its own contract gap.
import type { NormalizedIssue } from "../fetch_issue.ts";
import type { Verdict } from "../types.ts";
export type { NormalizedIssue };
/** Argv-shaped request for an adapter's openPr: every field becomes one argv
 *  element to the credentialed push script, never a shell string. */
export interface PrRequest {
  repoDir: string;
  branch: string;
  title: string;
  bodyFile: string;
  draft: boolean;
}
export interface PrResult {
  url: string;
  draft: boolean;
}
/** The same facts output.ts's 5-line summary (E-13) renders, for slack.ts (E-28). */
export interface RunSummary {
  runId: string;
  verdict: Verdict;
  prUrl: string | null;
  notProven: string[];
}
export interface Adapter {
  name: "github" | "gitlab" | "jira" | "slack";
  /** Cheap, synchronous, no LLM: does this ref belong to this adapter? */
  matches?(ref: string): boolean;
  fetchIssue?(ref: string): Promise<NormalizedIssue>;
  openPr?(req: PrRequest): Promise<PrResult>;
  notify?(summary: RunSummary): Promise<void>;
}
