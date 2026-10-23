// FC-FAILED-RUN-LEAVES-EMPTY-BRANCH-CHECKED-OUT: real git repos, no provider.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBranch, restoreAfterRun } from "../../src/e10ext/stop_restore.ts";

const dirs: string[] = [];
const g = (d: string, ...a: string[]): string => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" }).trim();
function repo(): { d: string; base: string } {
  const d = mkdtempSync(join(tmpdir(), "br-")); dirs.push(d);
  g(d, "init", "-q", "-b", "main"); g(d, "config", "user.email", "t@t"); g(d, "config", "user.name", "t");
  writeFileSync(join(d, "a.txt"), "a\n"); g(d, "add", "a.txt"); g(d, "commit", "-q", "-m", "init");
  return { d, base: g(d, "rev-parse", "HEAD") };
}
const branches = (d: string): string[] => g(d, "branch", "--format=%(refname:short)").split("\n").sort();
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("restoreAfterRun", () => {
  test("failed run with zero commits: back on main, empty loki branch deleted", () => {
    const { d, base } = repo(); g(d, "checkout", "-q", "-b", "loki/r1");
    restoreAfterRun(d, "main", "loki/r1", base, true);
    expect(currentBranch(d)).toBe("main"); expect(branches(d)).toEqual(["main"]);
  });
  test("failed run that committed: back on main, branch and commit kept", () => {
    const { d, base } = repo(); g(d, "checkout", "-q", "-b", "loki/r2");
    writeFileSync(join(d, "b.txt"), "b\n"); g(d, "add", "b.txt"); g(d, "commit", "-q", "-m", "work");
    restoreAfterRun(d, "main", "loki/r2", base, true);
    expect(currentBranch(d)).toBe("main"); expect(branches(d)).toEqual(["loki/r2", "main"]);
  });
  test("successful run with commits stays on the run branch", () => {
    const { d, base } = repo(); g(d, "checkout", "-q", "-b", "loki/r3");
    writeFileSync(join(d, "b.txt"), "b\n"); g(d, "add", "b.txt"); g(d, "commit", "-q", "-m", "work");
    restoreAfterRun(d, "main", "loki/r3", base, false);
    expect(currentBranch(d)).toBe("loki/r3"); expect(branches(d)).toEqual(["loki/r3", "main"]);
  });
  test("successful run that committed nothing: restored and deleted", () => {
    const { d, base } = repo(); g(d, "checkout", "-q", "-b", "loki/r4");
    restoreAfterRun(d, "main", "loki/r4", base, false);
    expect(currentBranch(d)).toBe("main"); expect(branches(d)).toEqual(["main"]);
  });
  test("dirty tracked tree: stays put, branch kept", () => {
    const { d, base } = repo(); g(d, "checkout", "-q", "-b", "loki/r5"); writeFileSync(join(d, "a.txt"), "changed\n");
    restoreAfterRun(d, "main", "loki/r5", base, true);
    expect(currentBranch(d)).toBe("loki/r5"); expect(branches(d)).toEqual(["loki/r5", "main"]);
  });
  test("unknown base never deletes", () => {
    const { d } = repo(); g(d, "checkout", "-q", "-b", "loki/r6");
    restoreAfterRun(d, "main", "loki/r6", null, true);
    expect(currentBranch(d)).toBe("main"); expect(branches(d)).toEqual(["loki/r6", "main"]);
  });
});
