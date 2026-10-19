// select: walk-all-src
// FC-40 guard (D91 finding class 5): a child process spawned with the full parent env hands the real GH_TOKEN, GITHUB_TOKEN and
// SSH_AUTH_SOCK to whatever the child runs. In loki-ts/src every spawn call site (Bun.spawn, spawn, spawnSync, execFile*,
// execSync) must either pass an explicit env that is not a bare process.env copy, or the file must be allowlisted with a reason in
// guard-allowlists/full-env-spawn.txt. Agent children must use tokenFreeEnv / withholdGithubTokens (util/safe_git.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SRC, walk, rel, isComment, loadAllowlist, checkCounts } from "./_guard_lib.ts";

export const CALL = /\b(Bun\.spawn(Sync)?|spawn(Sync)?|execFile(Sync)?|execSync|exec)\s*\(/;
// FC-87: plainTestEnv filters the token family and SSH_AUTH_SOCK from its base (util/check_result.ts), so it is token-free.
const SAFE = /plainTestEnv|tokenFreeEnv|withholdGithubTokens|safeGit|workerEnv|cleanEnv|sanitizedEnv/;

// Returns the call-site windows (call line plus following lines up to 14) in a source text.
export function violatingCalls(src: string): number[] {
  const lines = src.split("\n");
  const bad: number[] = [];
  lines.forEach((l, i) => {
    if (isComment(l) || !CALL.test(l) || /\.exec\(|RegExp|\bre\.exec/.test(l) || /^\s*(export\s+)?(async\s+)?function\b/.test(l)) return;
    let end = i + 15; // FC-87: a window stops at the next call line, so a later call's safe helper cannot excuse this one
    for (let j = i + 1; j < end && j < lines.length; j++) if (!isComment(lines[j]!) && CALL.test(lines[j]!)) { end = j; break; }
    const win = lines.slice(i, end).join("\n");
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
  // FC-87: plainTestEnv is token-free; a raw parent copy is still caught.
  expect(violatingCalls('Bun.spawn({ cmd: ["x"], env: plainTestEnv() });').length).toBe(0);
  expect(violatingCalls('spawnSync("x", [], { env: { ...plainTestEnv(), A: "1" } });').length).toBe(0);
  expect(violatingCalls('Bun.spawn({ cmd: ["x"], env: process.env });').length).toBe(1);
  expect(violatingCalls('spawnSync("x", [], { env: { ...process.env, A: "1" } });').length).toBe(1);
});

// FC-REVIEWER-GIT-CONFIG-EXEC: reviewerGitEnv returns its base plus git hardening, so a reviewer spawn that spreads it inherits whatever the
// base held. A call with no base argument, or a reviewer spawn whose base is not token-free, would hide a full-env spawn from the guard above.
export function reviewerEnvViolations(src: string): string[] {
  const bad: string[] = [];
  for (const line of src.split("\n")) {
    if (isComment(line)) continue;
    const m = /reviewerGitEnv\(([^\n]*)/.exec(line);
    if (!m) continue;
    const args = m[1]!;
    if (/^\s*\)/.test(args)) bad.push("no base argument");
    else if (!/tokenFreeEnv\(/.test(args) && !/process\.env\s*\)/.test(args)) bad.push(`base not token-free: ${args.slice(0, 60)}`);
  }
  return bad;
}
test("every reviewerGitEnv call passes a base; the spawning reviewers pass a token-free one", () => {
  const all: string[] = [];
  for (const f of walk(SRC)) {
    if (f.endsWith("util/safe_git.ts")) continue;
    const src = readFileSync(f, "utf8");
    for (const v of reviewerEnvViolations(src)) all.push(`${rel(f)}: ${v}`);
    if (/council\/voter_agents\.ts$|runner\/quality_gates\.ts$/.test(f) && /reviewerGitEnv\(/.test(src) && !/reviewerGitEnv\([^\n]*tokenFreeEnv\(/.test(src)) all.push(`${rel(f)}: reviewer spawn base is not tokenFreeEnv`);
  }
  expect(all).toEqual([]);
});
test("the reviewerGitEnv detector flags a bare call and accepts a token-free one", () => {
  expect(reviewerEnvViolations("env: { ...reviewerGitEnv() }").length).toBe(1);
  expect(reviewerEnvViolations("reviewerGitEnv(cwd, tokenFreeEnv(process.env))").length).toBe(0);
  expect(reviewerEnvViolations("reviewerGitEnv(cwd, { ...process.env, X: 1 })").length).toBe(1);
});
