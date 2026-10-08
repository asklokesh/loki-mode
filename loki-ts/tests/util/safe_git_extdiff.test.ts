// SAFEGIT-EXTDIFF: safeGit blanks diff.external, which made every patch-producing call die with "external diff died".
// The fix injects --no-ext-diff/--no-textconv centrally; a user-configured external diff must still never run.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeGit } from "../../src/util/safe_git.ts";

let root: string, repo: string, hit: string;
const g = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "safegit-extdiff-"));
  repo = join(root, "repo"); hit = join(root, "hit.txt"); mkdirSync(repo);
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n"); g("add", "a.txt"); g("commit", "-qm", "init");
  writeFileSync(join(repo, "a.txt"), "two\n"); g("commit", "-qam", "second");
  writeFileSync(join(repo, "a.txt"), "three\n");
  const marker = join(root, "ext.sh");
  writeFileSync(marker, `#!/bin/sh\necho fired >> "${hit}"\nexit 0\n`); chmodSync(marker, 0o755);
  g("config", "diff.external", marker);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test("control: the configured external diff fires on a plain git diff", () => {
  rmSync(hit, { force: true }); g("diff"); expect(existsSync(hit)).toBe(true); rmSync(hit, { force: true });
});
test("safeGit diff, show -p and log -p return a real patch and never run the external diff", () => {
  rmSync(hit, { force: true });
  expect(safeGit(repo, ["diff"])).toContain("+three");
  expect(safeGit(repo, ["diff", "HEAD~1", "HEAD"])).toContain("+two");
  expect(safeGit(repo, ["show", "-p", "HEAD"])).toContain("+two");
  expect(safeGit(repo, ["log", "-p", "-1"])).toContain("+two");
  expect(existsSync(hit)).toBe(false);
});
test("a caller-supplied --ext-diff cannot re-enable it", () => {
  rmSync(hit, { force: true });
  expect(safeGit(repo, ["diff", "--ext-diff"])).toContain("+three");
  expect(existsSync(hit)).toBe(false);
});
test("a GIT_EXTERNAL_DIFF in the caller env never runs", () => {
  rmSync(hit, { force: true });
  expect(safeGit(repo, ["diff"], { env: { ...process.env, GIT_EXTERNAL_DIFF: join(root, "ext.sh") } })).toContain("+three");
  expect(existsSync(hit)).toBe(false);
});
