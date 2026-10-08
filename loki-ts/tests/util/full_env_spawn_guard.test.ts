// select: walk-all-src
// FC-40 guard (D91 finding class 5): a child process spawned with the full parent env hands the real GH_TOKEN, GITHUB_TOKEN and
// SSH_AUTH_SOCK to whatever the child runs. In loki-ts/src every spawn call site (Bun.spawn, spawn, spawnSync, execFile*,
// execSync) must either pass an explicit env that is not a bare process.env copy, or the file must be allowlisted with a reason in
// guard-allowlists/full-env-spawn.txt. Agent children must use tokenFreeEnv / withholdGithubTokens (util/safe_git.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SRC, walk, rel, isComment, loadAllowlist, checkCounts } from "./_guard_lib.ts";

export const CALL = /\b(Bun\.spawn(Sync)?|spawn(Sync)?|execFile(Sync)?|execSync|exec)\s*\(/;
const SAFE = /tokenFreeEnv|withholdGithubTokens|safeGit|workerEnv|cleanEnv|sanitizedEnv/;

// Returns the call-site windows (call line plus following lines up to 14) in a source text.
export function violatingCalls(src: string): number[] {
  const lines = src.split("\n");
  const bad: number[] = [];
  lines.forEach((l, i) => {
    if (isComment(l) || !CALL.test(l) || /\.exec\(|RegExp|\bre\.exec/.test(l) || /^\s*(export\s+)?(async\s+)?function\b/.test(l)) return;
    const win = lines.slice(i, i + 15).join("\n");
    const hasEnv = /\benv\b/.test(win);
    const bareParent = /env:\s*process\.env\b(?!\s*\))|\.\.\.process\.env/.test(win) && !SAFE.test(win);
    if (!hasEnv || bareParent) bad.push(i + 1);
  });
  return bad;
}

test("no child spawn inherits or copies the full parent env unless allowlisted", () => {
  const counts: Record<string, number> = {};
  for (const f of walk(SRC)) {
    const n = violatingCalls(readFileSync(f, "utf8")).length;
    if (n > 0) counts[rel(f)] = n;
  }
  expect(checkCounts(counts, loadAllowlist("full-env-spawn.txt"))).toEqual({ unlisted: [], mismatched: [], noReason: [] });
});

test("the detector flags a planted full-env spawn and accepts a token-free one", () => {
  expect(violatingCalls('Bun.spawn({ cmd: ["x"] });').length).toBe(1);
  expect(violatingCalls('Bun.spawn({ cmd: ["x"], env: { ...process.env } });').length).toBe(1);
  expect(violatingCalls('Bun.spawn({ cmd: ["x"], env: tokenFreeEnv(process.env) });').length).toBe(0);
});
