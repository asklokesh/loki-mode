// FC-41/132-B1: patch-producing git through safeGit returns patches (no "external diff died") while a repo-chosen
// diff.external or gitattributes diff driver still never runs.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeGit, safeGitArgs } from "../../src/util/safe_git.ts";

let root: string, repo: string, extHit: string, drvHit: string;
const g = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
const script = (hit: string, name: string): string => {
  const p = join(root, name); writeFileSync(p, `#!/bin/sh\necho fired >> "${hit}"\nexit 0\n`); chmodSync(p, 0o755); return p;
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fc25-extdiff-"));
  repo = join(root, "repo"); extHit = join(root, "ext-hit.txt"); drvHit = join(root, "drv-hit.txt");
  mkdirSync(repo);
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n"); writeFileSync(join(repo, "b.bin"), "x\n");
  writeFileSync(join(repo, ".gitattributes"), "b.bin diff=evil\n");
  g("add", "."); g("commit", "-qm", "init");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); g("commit", "-qam", "second");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n"); writeFileSync(join(repo, "b.bin"), "y\n");
  g("config", "diff.external", script(extHit, "ext.sh"));
  g("config", "diff.evil.command", script(drvHit, "drv.sh"));
  g("config", "diff.evil.textconv", script(drvHit, "tc.sh"));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

test("diff returns the patch", () => {
  const out = safeGit(repo, ["diff"]);
  expect(out).toContain("+three");
  expect(out).not.toContain("external diff died");
});
test("log -p and show return patches", () => {
  expect(safeGit(repo, ["log", "-p", "-1", "HEAD"])).toContain("+two");
  expect(safeGit(repo, ["show", "HEAD"])).toContain("+two");
});
test("an explicit --no-ext-diff is not duplicated", () => {
  const argv = safeGitArgs(["diff", "--no-ext-diff"]);
  expect(argv.filter((a) => a === "--no-ext-diff").length).toBe(1);
});
test("--ext-diff and --textconv from a caller are dropped", () => {
  const argv = safeGitArgs(["diff", "--ext-diff", "--textconv"]);
  expect(argv).not.toContain("--ext-diff");
  expect(argv).not.toContain("--textconv");
});
test("diff --stat and --name-only output is unchanged", () => {
  expect(safeGit(repo, ["diff", "--name-only"]).split("\n").filter(Boolean).sort()).toEqual(["a.txt", "b.bin"]);
  expect(safeGit(repo, ["diff", "--stat"])).toContain("a.txt");
  expect(safeGit(repo, ["diff", "--stat"])).toBe(g("diff", "--no-ext-diff", "--no-textconv", "--stat"));
});
test("repo-config diff.external and gitattributes diff driver canaries never run", () => {
  safeGit(repo, ["diff"]); safeGit(repo, ["log", "-p", "-2"]); safeGit(repo, ["show", "HEAD"]);
  expect(existsSync(extHit)).toBe(false);
  expect(existsSync(drvHit)).toBe(false);
});
