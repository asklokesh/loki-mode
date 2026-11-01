// util/test_guard.ts -- test files that existed at the run base are read-only for implement and fix sessions, like the Wall tests:
// an edit or deletion is restored after the session unless the task names that file or asks to change tests. New test files are kept.
// Lives in util, not beside restoreReadOnly in engine10/stages/implement.ts, to keep the engine10 core line budget.
import { basename } from "node:path";
import { isTestFile } from "./test_file_text.ts";
import { safeGit } from "./safe_git.ts";

// "update the tests", "fix the failing unit tests", "change existing test cases"; "add tests" is new files and never counts.
const CHANGE_TESTS = /\b(?:update|change|fix|modify|edit|rewrite|adjust|correct|repair|refactor|amend|migrate|rework|remove|delete)\s+(?:(?:the|existing|failing|broken|old|outdated|stale|current|affected|related|unit|e2e|integration|snapshot|these|those|all|any|its|our)\s+){0,3}(?:tests?|specs?|test\s+(?:files?|cases?|suites?)|assertions?|snapshots?)\b/i;
const TESTS_WRONG = /\b(?:tests?|specs?|assertions?)\s+(?:is|are)\s+(?:wrong|outdated|stale|incorrect|obsolete|out of date)\b/i;

/** True when the task names this test file (repo path or file name) or asks to change tests. */
export function taskAllowsTestEdit(task: string, rel: string): boolean {
  return task.includes(rel) || task.includes(basename(rel)) || CHANGE_TESTS.test(task) || TESTS_WRONG.test(task);
}

/** Restores every test file that existed at baseSha and that the session modified or deleted, unless the task allows the edit or the
 *  file was dirty at intake (the user's own work). Returns the repo-relative paths restored. Never throws: an unreadable tree restores nothing. */
export function restoreBaseTests(repoDir: string, baseSha: string, intake: Record<string, unknown> | undefined): string[] {
  const task = typeof intake?.task === "string" ? intake.task : "", dirty = (intake?.preexisting_dirty ?? {}) as Record<string, string>;
  if (!baseSha) return [];
  try {
    const touched = safeGit(repoDir, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", "--diff-filter=DMT", baseSha, "--"])
      .split("\0").filter((f) => f && !f.startsWith(".loki/") && isTestFile(f) && !Object.hasOwn(dirty, f) && !taskAllowsTestEdit(task, f));
    if (!touched.length) return [];
    safeGit(repoDir, ["restore", `--source=${baseSha}`, "--worktree", "--", ...touched.map((f) => `:(literal)${f}`)], { repoDrivers: true }); // worktree only: the index is untouched; literal, so "[id]" is a directory name
    return touched;
  } catch { return []; }
}
