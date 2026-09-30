// S41-10: the implement/fix brief's repo context. Replaces the first 200 repo paths with up to 20
// relevant files (plan relevant_files, else keyword selection over the tree-keyed cached map), their
// impacted tests with one exact command each, and E-126 repo memory's verified command. Data only, no
// verdict logic (D42). plan.ts/verify.ts are stages, so core passes selectRelevantFiles and runnerCmd in.
import { readRepoMapCache, repoCacheDir, repoKey } from "../engine10/cache.ts";
import type { RepoMap } from "../engine10/repomap.ts";
import { loadRepoMap } from "../engine10/sizing.ts";
import type { RunContext, TestMap, TestRef } from "../engine10/types.ts";
import { readVerifiedCommand } from "./repomemory.ts";

export interface ContextDeps {
  select: (task: string, map: RepoMap, max: number) => string[];
  cmd: (t: TestRef, repoDir: string) => [string, string[], unknown?];
}

const MAX_FILES = 20;
const MAX_TESTS = 10;

export function briefContext(ctx: RunContext, d: ContextDeps): string {
  const o = ctx.outputs();
  const tree = o.intake?.tree as string | undefined;
  const task = (o.intake?.task as string | undefined) ?? "";
  const map = (tree ? readRepoMapCache(repoCacheDir(repoKey(null, ctx.repoDir)), tree) : null) ?? loadRepoMap(o.intake?.repomap_ref as string | undefined);
  const planned = o.plan?.relevant_files as string[] | undefined;
  const files = (planned?.length ? planned : map ? d.select(task, map, MAX_FILES) : []).slice(0, MAX_FILES);
  const tm = o.intake?.testmap as TestMap | undefined;
  const refs = tm && files.length ? ctx.tests.impacted(tm, files).slice(0, MAX_TESTS) : [];
  const rel = (p: string): string => (p.startsWith(`${ctx.repoDir}/`) ? p.slice(ctx.repoDir.length + 1) : p);
  const cmds = refs.map((t) => { const [c, a] = d.cmd(t, ctx.repoDir); return [rel(c), ...a].join(" "); });
  const verified = readVerifiedCommand(repoCacheDir(repoKey(null, ctx.repoDir)));
  return [
    files.length ? `Relevant files:\n${files.join("\n")}` : "",
    cmds.length ? `Impacted test commands:\n${cmds.join("\n")}` : "",
    verified ? `Last verified test command: ${verified}` : "",
  ].filter(Boolean).join("\n\n");
}
