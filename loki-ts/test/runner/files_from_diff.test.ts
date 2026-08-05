// RUN-25 iter 19 (Wave C #2): filesFromDiff derives the changed-file list from a
// full `git diff`'s `diff --git a/X b/X` headers, so code_review no longer runs a
// SECOND `git diff --name-only` spawn. This test proves byte-PARITY with the real
// `git diff --name-only` across add / modify / delete / rename / spaced-path
// cases (rename must report the b/ destination, matching --name-only), by driving
// a real throwaway git repo -- so the optimization cannot silently change which
// files the reviewer sees.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesFromDiff } from "../../src/runner/quality_gates.ts";

let repo: string;
function git(args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "loki-fdiff-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("filesFromDiff: byte-parity with git diff --name-only", () => {
  test("add / modify / delete / rename / spaced-path all match --name-only", () => {
    // initial commit
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "keep.ts"), "a\n");
    writeFileSync(join(repo, "mod.ts"), "old\n");
    writeFileSync(join(repo, "del.ts"), "d\n");
    writeFileSync(join(repo, "rename-src.ts"), "r1\n");
    writeFileSync(join(repo, "with space.ts"), "x\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);

    // a change of every kind, staged
    writeFileSync(join(repo, "mod.ts"), "new\n");
    writeFileSync(join(repo, "added.ts"), "b\n");
    rmSync(join(repo, "del.ts"));
    git(["mv", "rename-src.ts", "rename-dst.ts"]);
    writeFileSync(join(repo, "with space.ts"), "x\ny\n");
    git(["add", "-A"]);

    const nameOnly = git(["diff", "--name-only", "--cached"]).trim().split("\n").sort();
    const fullDiff = git(["diff", "--cached"]);
    const derived = filesFromDiff(fullDiff).trim().split("\n").sort();

    expect(derived).toEqual(nameOnly);
    // spot-check the interesting cases are present
    expect(derived).toContain("with space.ts");
    expect(derived).toContain("rename-dst.ts"); // rename reports the b/ destination
    expect(derived).not.toContain("rename-src.ts");
  });

  test("empty diff -> empty file list", () => {
    expect(filesFromDiff("")).toBe("");
    expect(filesFromDiff("no headers here\njust text")).toBe("");
  });

  test("dedups a file that appears in multiple headers is not a concern (git emits one header/file)", () => {
    // sanity: two distinct files -> two names, order preserved.
    const diff = "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.ts b/y.ts\n@@ -1 +1 @@\n-c\n+d\n";
    expect(filesFromDiff(diff)).toBe("x.ts\ny.ts\n");
  });
});
