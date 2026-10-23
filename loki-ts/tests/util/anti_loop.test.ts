import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repeatedNoopFix, treeFingerprint } from "../../src/util/anti_loop.ts";

describe("repeatedNoopFix", () => {
  test("a completed round that left the tree unchanged is a no-op loop", () => {
    expect(repeatedNoopFix({ tree_before: "abc", tree_after: "abc" })).toBe(true);
  });
  test("a changed tree, a killed session, a missing output or a missing fingerprint is not a loop", () => {
    expect(repeatedNoopFix(undefined)).toBe(false);
    expect(repeatedNoopFix({ tree_before: "abc", tree_after: "abd" })).toBe(false);
    expect(repeatedNoopFix({ tree_before: "abc", tree_after: "abc", killed: true })).toBe(false);
    expect(repeatedNoopFix({ tree_before: null, tree_after: null })).toBe(false);
    expect(repeatedNoopFix({ diff_stat: " a.js | 1 +", signatures: "sig" })).toBe(false);
  });
});

describe("treeFingerprint", () => {
  test("two different edits with the same diff stat hash differently; an untracked file counts; .loki does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "anti-loop-"));
    // Run from a hook, an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE would point every git call at the caller's repo.
    const ISOLATE = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"] as const;
    const saved = ISOLATE.map((k) => [k, process.env[k]] as const);
    for (const k of ISOLATE) delete process.env[k];
    try {
      const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "pipe", env: process.env });
      git("init", "-q");
      writeFileSync(join(dir, "a.js"), "export const x = 1;\n");
      git("add", "a.js"); git("commit", "-q", "-m", "base");
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", env: process.env }).trim();
      const clean = treeFingerprint(dir, base);
      expect(clean).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(dir, "a.js"), "export const x = 2;\n");
      const two = treeFingerprint(dir, base);
      writeFileSync(join(dir, "a.js"), "export const x = 3;\n");
      const three = treeFingerprint(dir, base);
      expect(two).not.toBe(three); // same `1 file changed, 1 insertion, 1 deletion` stat
      expect(treeFingerprint(dir, base)).toBe(three);
      writeFileSync(join(dir, "new.js"), "1\n");
      const withNew = treeFingerprint(dir, base);
      expect(withNew).not.toBe(three);
      execFileSync("mkdir", ["-p", join(dir, ".loki")]);
      writeFileSync(join(dir, ".loki", "state.json"), "{}");
      expect(treeFingerprint(dir, base)).toBe(withNew);
      expect(treeFingerprint(join(dir, "missing"), base)).toBeNull();
      execFileSync("ln", ["-s", join(dir, "gone"), join(dir, "dangling")]); // untracked but unreadable: null, never a stable sentinel
      expect(treeFingerprint(dir, base)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  });
});
