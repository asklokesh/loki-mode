// FC-25: a git call from the token-holding supervisor must never run a core.fsmonitor plant in the agent's repo.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunCapS } from "../../src/util/run_cap.ts";
import { tokenFreeEnv, safeGit } from "../../src/util/safe_git.ts";
import { listRepoFiles } from "../../src/engine10/repomap.ts";
import { restoreBranch } from "../../src/e10ext/stop_restore.ts";

let root: string, repo: string, runDir: string, hit: string;
const CANARY = "ghp_fc25canary";
const g = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fc25-trusted-git-"));
  repo = join(root, "repo"); runDir = join(root, "run"); hit = join(root, "hit.txt");
  mkdirSync(repo); mkdirSync(runDir);
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "a.txt"); g("commit", "-qm", "init");
  const rec = join(root, "rec.sh");
  writeFileSync(rec, `#!/bin/sh\necho "fired token=$GH_TOKEN" >> "${hit}"\nexit 0\n`); chmodSync(rec, 0o755);
  g("config", "core.fsmonitor", rec);
  g("branch", "other");
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
const fired = (): boolean => existsSync(hit);
const reset = (): void => { rmSync(hit, { force: true }); };

test("control: the plant fires on a plain git ls-files", () => {
  reset(); execFileSync("git", ["ls-files"], { cwd: repo, env: { ...process.env, GH_TOKEN: CANARY, GIT_CONFIG_GLOBAL: "/dev/null" } });
  expect(fired()).toBe(true); reset();
});
test("resolveRunCapS never runs the fsmonitor plant", () => {
  reset(); resolveRunCapS(repo, false, { ...process.env, GH_TOKEN: CANARY });
  expect(fired() ? readFileSync(hit, "utf8") : "").toBe("");
});
test("repomap, restoreBranch and the cap never fire the plant with the canary in process.env", () => {
  reset(); const saved = process.env.GH_TOKEN; process.env.GH_TOKEN = CANARY;
  try { resolveRunCapS(repo, false); listRepoFiles(repo); restoreBranch(repo, "other"); } finally { if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved; }
  expect(fired()).toBe(false);
});
test("safeGit strips the token family and SSH_AUTH_SOCK from the child env", () => {
  const e = tokenFreeEnv({ GH_TOKEN: "a", GITHUB_TOKEN: "b", GH_ENTERPRISE_TOKEN: "c", GITHUB_ENTERPRISE_TOKEN: "d", SSH_AUTH_SOCK: "e", KEEP: "1" });
  expect(e).toEqual({ KEEP: "1" });
  reset(); safeGit(repo, ["ls-files"]); expect(fired()).toBe(false);
});
