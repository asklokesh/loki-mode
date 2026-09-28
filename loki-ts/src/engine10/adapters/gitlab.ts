// loki-ts/src/engine10/adapters/gitlab.ts -- E-26 GitLab adapter (ENGINE.md section 13). Issue in
// wraps fetch_gitlab_issue through fetch_issue.ts; MR out runs engine10-push-gitlab.sh (argv only,
// never a shell string), which refuses any origin that is not a literal gitlab.com URL. Runs only
// in credentialed deterministic processes (P1 fetch, P4 push).
import { spawnSync } from "node:child_process";
import { fetchIssue, type Execer, type NormalizedIssue } from "../fetch_issue.ts";
import type { PushArgs } from "../types.ts";
// ponytail: local copy of the section 13 Adapter interface; switch to adapters/types.ts at merge.
export type PrRequest = Omit<Extract<PushArgs, { cmd: "push-pr" }>, "cmd">;
export type RunSummary = Record<string, unknown>;
export interface Adapter {
  name: "github" | "gitlab" | "jira" | "slack";
  matches?(ref: string): boolean;
  fetchIssue?(ref: string): Promise<NormalizedIssue>;
  openPr?(req: PrRequest): Promise<{ url: string; draft: boolean }>;
  notify?(summary: RunSummary): Promise<void>;
}
export type PushRunner = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
export const PUSH_GITLAB_SH = new URL("../../../../autonomy/lib/engine10-push-gitlab.sh", import.meta.url).pathname;
const defaultRunner: PushRunner = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
};
export interface GitlabAdapterOptions {
  /** The origin P0 pinned before any provider ran; the push child re-checks it. */
  pinnedOrigin?: string;
  exec?: Execer;
  run?: PushRunner;
}
export function gitlabAdapter(opts: GitlabAdapterOptions = {}): Adapter {
  return {
    name: "gitlab",
    matches: (ref) => /^https?:\/\/gitlab\.[^/]+\/.+\/-\/issues\/\d+$/.test(ref),
    async fetchIssue(ref) {
      const issue = fetchIssue(ref, opts.exec);
      if (issue.provider !== "gitlab") throw new Error(`gitlab adapter: ref resolved to provider ${issue.provider}`);
      return issue;
    },
    async openPr(req) {
      if (!opts.pinnedOrigin) throw new Error("gitlab adapter: no pinned origin; refusing to push");
      const args = [PUSH_GITLAB_SH, "push-mr", req.repoDir, req.branch, req.title, req.bodyFile, ...(req.draft ? ["--draft"] : [])];
      const env = { ...process.env, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: opts.pinnedOrigin };
      const r = (opts.run ?? defaultRunner)("bash", args, env);
      const url = r.stdout.trim().split("\n").pop() ?? "";
      if (r.status !== 0 || !url.startsWith("https://gitlab.com/")) {
        throw new Error(`gitlab adapter: push-mr failed (rc=${r.status}): ${r.stderr.trim()}`);
      }
      return { url, draft: req.draft };
    },
  };
}
