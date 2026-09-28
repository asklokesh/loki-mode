// loki-ts/tests/e10ext/treeswap.test.ts
//
// S41-12 wall check (docs/v10/SCORECARD-PLAN.md, docs/v10/DECISIONS.md D42(1)).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXCLUDES,
  TreeSwapUnsafePathError,
  applyDiff,
  cleanupAttempt,
  resetToBase,
  snapshotDiff,
  swapAttemptIntoWorkingTree,
} from "../../src/e10ext/treeswap.ts";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `treeswap-${prefix}-`));
  dirs.push(d);
  return d;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function initRepo(root: string): void {
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "treeswap@example.invalid"]);
  git(root, ["config", "user.name", "treeswap"]);
}

function commitAll(root: string, msg: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", msg]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

// A primary repo with a base commit (a.txt, b/c.txt, plus a gitignored file
// and a non-ignored venv/ dir), and a linked "attempt" worktree at the same
// base SHA, mutated directly on disk (as an agent would).
function makeFixture() {
  const primary = tmp("primary");
  initRepo(primary);
  write(primary, "a.txt", "orig-a");
  write(primary, "b/c.txt", "orig-c");
  write(primary, "venv/lib.txt", "orig-venv"); // NOT gitignored: exclude must still apply
  write(primary, ".gitignore", "ignored.txt\n");
  write(primary, "ignored.txt", "orig-ignored");
  const base = commitAll(primary, "base");

  const attemptsDir = join(primary, ".loki", "runs", "run1", "attempts");
  mkdirSync(attemptsDir, { recursive: true });
  const attempt = join(attemptsDir, "a");
  git(primary, ["worktree", "add", "-q", attempt, base]);

  return { primary, base, attempt, runDir: join(primary, ".loki", "runs", "run1") };
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* best effort */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("treeswap round trip (S41-12 wall check)", () => {
  test("resetToBase leaves git status clean; applyDiff restores byte for byte", () => {
    const { primary, base, attempt } = makeFixture();

    // Attempt mutates a.txt (modify), adds new.txt (untracked), deletes b/c.txt.
    write(attempt, "a.txt", "attempt-a");
    write(attempt, "new.txt", "attempt-new");
    rmSync(join(attempt, "b", "c.txt"));

    // Primary drifts too, so resetToBase has real work to do.
    write(primary, "a.txt", "drifted-a");
    write(primary, "stray.txt", "stray");

    const diff = snapshotDiff(attempt, base);

    resetToBase(primary, base);
    const status = git(primary, ["status", "--porcelain", "--", ".", ...DEFAULT_EXCLUDES.map((e) => `:(exclude)${e}`)]);
    expect(status.trim()).toBe("");
    expect(readFileSync(join(primary, "venv", "lib.txt"), "utf8")).toBe("orig-venv");
    expect(readFileSync(join(primary, "ignored.txt"), "utf8")).toBe("orig-ignored");

    applyDiff(primary, diff);
    expect(readFileSync(join(primary, "a.txt"), "utf8")).toBe("attempt-a");
    expect(readFileSync(join(primary, "new.txt"), "utf8")).toBe("attempt-new");
    expect(existsSync(join(primary, "b", "c.txt"))).toBe(false);
    // excluded paths untouched by the whole round trip
    expect(readFileSync(join(primary, "venv", "lib.txt"), "utf8")).toBe("orig-venv");
  });

  test("a mutation that skips untracked files goes red", () => {
    const { primary, base, attempt } = makeFixture();
    write(attempt, "new.txt", "attempt-new");
    const diff = snapshotDiff(attempt, base);
    expect(diff.some((e) => e.path === "new.txt")).toBe(true);
    resetToBase(primary, base);
    applyDiff(primary, diff);
    expect(readFileSync(join(primary, "new.txt"), "utf8")).toBe("attempt-new");
  });
});

describe("swapAttemptIntoWorkingTree", () => {
  test("a successful swap leaves the working tree byte-identical to the chosen attempt", () => {
    const { primary, base, attempt } = makeFixture();
    write(attempt, "a.txt", "winner-a");
    write(attempt, "b/c.txt", "winner-c");
    write(attempt, "new.txt", "winner-new");

    swapAttemptIntoWorkingTree({ primaryRoot: primary, attemptRoot: attempt, base });

    for (const rel of ["a.txt", "b/c.txt", "new.txt"]) {
      expect(readFileSync(join(primary, rel))).toEqual(readFileSync(join(attempt, rel)));
    }
    expect(readFileSync(join(primary, "venv", "lib.txt"), "utf8")).toBe("orig-venv");
  });

  test("a failure mid-swap leaves the original tree intact", () => {
    const { primary, base, attempt } = makeFixture();
    write(attempt, "a.txt", "winner-a");
    write(attempt, "b/c.txt", "winner-c");

    const before = {
      a: readFileSync(join(primary, "a.txt")),
      c: readFileSync(join(primary, "b", "c.txt")),
      status: git(primary, ["status", "--porcelain"]),
    };

    // b/ becomes unwritable so the write of b/c.txt fails after a.txt has
    // already been written: a genuine partial-write, not a pre-check reject.
    chmodSync(join(primary, "b"), 0o555);
    try {
      expect(() => swapAttemptIntoWorkingTree({ primaryRoot: primary, attemptRoot: attempt, base })).toThrow();
    } finally {
      chmodSync(join(primary, "b"), 0o755);
    }

    expect(readFileSync(join(primary, "a.txt"))).toEqual(before.a);
    expect(readFileSync(join(primary, "b", "c.txt"))).toEqual(before.c);
    expect(git(primary, ["status", "--porcelain"])).toBe(before.status);
  });

  test("a symlink escaping the tree root is refused", () => {
    const { primary, base, attempt } = makeFixture();
    symlinkSync("../../../etc/evil", join(attempt, "escape"));

    expect(() => swapAttemptIntoWorkingTree({ primaryRoot: primary, attemptRoot: attempt, base })).toThrow(
      TreeSwapUnsafePathError,
    );
    expect(existsSync(join(primary, "escape"))).toBe(false);
    expect(readFileSync(join(primary, "a.txt"), "utf8")).toBe("orig-a");
  });

  test("write-then-delete-through-a-new-symlink is refused, not just the read side", () => {
    const { primary, base, attempt } = makeFixture();
    // Replace tracked dir b/ with a symlink that escapes, and (in the same
    // diff) delete a path under the old b/ - if writes ran before deletes,
    // or the write-side check were skipped, the delete would follow the
    // fresh symlink out of the tree.
    rmSync(join(attempt, "b"), { recursive: true, force: true });
    symlinkSync("../../outside", join(attempt, "b"));

    expect(() => snapshotDiff(attempt, base)).toThrow(TreeSwapUnsafePathError);
    expect(lstatSync(join(primary, "b")).isDirectory()).toBe(true);
  });
});

describe("cleanupAttempt", () => {
  test("deletes only the loser's own directory", () => {
    const { primary, base, runDir } = makeFixture();
    const attemptsDir = join(runDir, "attempts");
    const loser = join(attemptsDir, "b");
    git(primary, ["worktree", "add", "-q", "--detach", loser, base]);
    const sentinelInRun = join(runDir, "sentinel.txt");
    writeFileSync(sentinelInRun, "keep");
    const winnerAttempt = join(attemptsDir, "a");
    writeFileSync(join(winnerAttempt, "keep.txt"), "keep");

    cleanupAttempt(primary, runDir, loser);

    expect(existsSync(loser)).toBe(false);
    expect(existsSync(winnerAttempt)).toBe(true);
    expect(readFileSync(join(winnerAttempt, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(sentinelInRun, "utf8")).toBe("keep");
    // git's worktree registration for the removed attempt is gone too
    const list = git(primary, ["worktree", "list"]);
    expect(list).not.toContain(loser);
  });

  test("refuses a path that is not a direct child of <runDir>/attempts", () => {
    const { primary, runDir } = makeFixture();
    expect(() => cleanupAttempt(primary, runDir, runDir)).toThrow(TreeSwapUnsafePathError);
    // exists on disk, but two levels below attemptsRoot: not a direct child
    expect(() => cleanupAttempt(primary, runDir, join(runDir, "attempts", "a", ".git"))).toThrow();
  });

  test("refuses a symlinked attempt directory and never deletes its target", () => {
    const { primary, runDir } = makeFixture();
    const outside = tmp("outside-target");
    writeFileSync(join(outside, "keep.txt"), "keep");
    const attemptsDir = join(runDir, "attempts");
    const link = join(attemptsDir, "evil-link");
    symlinkSync(outside, link);

    expect(() => cleanupAttempt(primary, runDir, link)).toThrow(TreeSwapUnsafePathError);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});
