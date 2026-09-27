// loki-ts/src/engine10/adapters/index.ts
//
// E-25: adapter registry (docs/v10/ENGINE.md section 13). gitlab, jira and
// slack register themselves here in later slices (E-26/E-27/E-28); this
// slice registers github only.
import { githubAdapter, makeGithubAdapter } from "./github.ts";
import type { Adapter } from "./types.ts";

export const adapters: Adapter[] = [githubAdapter];

/** First registered adapter whose matches() accepts ref, or null when none does. */
export function matchAdapter(ref: string): Adapter | null {
  for (const adapter of adapters) {
    if (adapter.matches?.(ref)) return adapter;
  }
  return null;
}

export type { Adapter, PrRequest, PrResult, RunSummary } from "./types.ts";
export { githubAdapter, makeGithubAdapter };
