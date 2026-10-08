// select: walk-all-src
// FC-25 guard: every git spawn in loki-ts/src, bin/ and autonomy/ (JS/TS) goes through util/safe_git.ts
// (safeGit, safeGitSpawn, safeGitRun). There is NO allowlist: "this file only runs in the worker" was the
// reasoning that let project_model/gather.ts run git ls-files in the supervisor holding the real token,
// so a core.fsmonitor plant fired 4 times with it (moat P9 [planted], 2026-10-08). safe_git.ts is the
// mechanism itself, not an exemption.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DIRS = ["loki-ts/src", "bin", "autonomy"].map((d) => join(ROOT, d));
const MECHANISM = "loki-ts/src/util/safe_git.ts";

// A spawn helper called with "git" (or a shell string starting with git), Bun.spawn(["git", ...]),
// an argv array literal starting with "git", or an indirect `const GIT = "git"`.
const PATTERNS: RegExp[] = [
  /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|run|runAsync|sh)\s*\(\s*["'`]git(?:["'`]|\s)/,
  /\bBun\.spawn(?:Sync)?\s*\(\s*(?:\{\s*cmd\s*:\s*)?\[\s*["'`]git["'`]/,
  /\[\s*["'`]git["'`]\s*,/,
  /\b(?:const|let|var)\s+\w+\s*=\s*["'`]git["'`]\s*[;\n]/,
];
// Only safe_git.ts may build the hardened argv or env: safeGitArgs/safeGitEnv handed to a raw spawn or to
// util/shell.ts run() (which MERGES opts.env over process.env) did not strip the token (preflight, xreview).
const LEAK = /\b(?:safeGitEnv|safeGitArgs)\b/;

function walk(d: string, out: string[] = []): string[] {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n === "dist") continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:ts|js|mjs|cjs)$/.test(p)) out.push(p);
  }
  return out;
}

// Drop whole-line comments; keep everything else so a call split over lines still matches.
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n");

function rawGitSites(text: string): string[] {
  return PATTERNS.flatMap((re) => {
    const m = new RegExp(re.source, "g");
    return [...text.matchAll(m)].map((x) => x[0].replace(/\s+/g, " "));
  });
}

test("no raw git spawn in loki-ts/src, bin/ or autonomy/ outside safe_git.ts (no allowlist)", () => {
  const hits: string[] = [];
  for (const f of DIRS.flatMap((d) => walk(d))) {
    const rel = relative(ROOT, f);
    if (rel === MECHANISM) continue;
    for (const s of rawGitSites(code(f))) hits.push(`${rel}: ${s}`);
  }
  expect(hits).toEqual([]);
});

test("safeGitEnv and safeGitArgs are not used outside safe_git.ts", () => {
  const hits = DIRS.flatMap((d) => walk(d))
    .filter((f) => relative(ROOT, f) !== MECHANISM && LEAK.test(code(f)))
    .map((f) => relative(ROOT, f));
  expect(hits).toEqual([]);
});

test("the matcher catches every raw form and ignores a tool-name list", () => {
  for (const s of [
    `execFileSync("git", ["ls-files", "-z"], { env: process.env })`,
    `execFileSync(\n  "git",\n  ["status"])`,
    `spawnSync('git', args)`,
    `execSync(\`git status --porcelain\`)`,
    `exec("git diff")`,
    `await run(["git", "diff"])`,
    `Bun.spawn(["git", "archive"])`,
    `Bun.spawn({ cmd: ["git", "rev-parse"] })`,
    `const GIT = "git";`,
  ]) expect(rawGitSites(s).length).toBeGreaterThan(0);
  for (const s of [
    `for (const t of ["node", "python3", "jq", "git", "curl"]) {}`,
    `key = "git";`,
    `safeGit(repoDir, ["ls-files", "-z"])`,
    `const msg = "not a git repo";`,
  ]) expect(rawGitSites(s)).toEqual([]);
});
