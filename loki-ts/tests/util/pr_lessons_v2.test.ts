import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatLessonList, formatLessonsForBrief, lessonsPath, loadLessons, retrieveLessons, type Lesson } from "../../src/util/pr_lessons.ts";

const dirs: string[] = [];
const saved = { d: process.env["LOKI_PR_LESSON_DEMOTE"], n: process.env["LOKI_NO_PR_LESSONS"] };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of [["LOKI_PR_LESSON_DEMOTE", saved.d], ["LOKI_NO_PR_LESSONS", saved.n]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const lesson = (id: string, verdicts: Array<string | null>): Lesson => ({
  id, text: `Validate the pagination cursor ${id}`,
  source: { pr: "o/r#7", pr_url: "https://github.com/o/r/pull/7", comment_url: `https://github.com/o/r/pull/7#${id}`, kind: "review_comment", author: "rev" },
  learned_at: "2026-10-01T00:00:00Z",
  uses: verdicts.map((v, i) => ({ run_id: `${id}-r${i}`, verdict: v, at: "2026-10-02T00:00:00Z" })),
});
const seed = (ls: Lesson[]): string => {
  const d = mkdtempSync(join(tmpdir(), "f3-lessons-")); dirs.push(d);
  mkdirSync(dirname(lessonsPath(d)), { recursive: true });
  writeFileSync(lessonsPath(d), JSON.stringify({ version: 1, lessons: ls }));
  return d;
};
const TASK = "fix the pagination cursor";

describe("pr lessons v2 demotion", () => {
  it("drops a lesson with 3 verdict-bearing uses, all FAILED", () => {
    const d = seed([lesson("bad", ["FAILED", "FAILED", "FAILED"])]);
    expect(retrieveLessons(d, TASK)).toEqual([]);
  });
  it("keeps a lesson with 2 FAILED uses", () => {
    const d = seed([lesson("ok", ["FAILED", "FAILED"])]);
    expect(retrieveLessons(d, TASK).map((l) => l.id)).toEqual(["ok"]);
  });
  it("does not count null-verdict uses toward the threshold", () => {
    const d = seed([lesson("pend", ["FAILED", "FAILED", null, null])]);
    expect(retrieveLessons(d, TASK).map((l) => l.id)).toEqual(["pend"]);
  });
  it("keeps a lesson that contributed to any VERIFIED run", () => {
    const d = seed([lesson("mix", ["FAILED", "PARTIAL", "VERIFIED", "FAILED"])]);
    expect(retrieveLessons(d, TASK).length).toBe(1);
  });
  it("PARTIAL and FAILED only history with 3 uses is demoted", () => {
    const d = seed([lesson("part", ["PARTIAL", "PARTIAL", "FAILED"])]);
    expect(retrieveLessons(d, TASK)).toEqual([]);
  });
  it("list shows the VERIFIED ratio and tags demoted lessons without deleting them", () => {
    const d = seed([lesson("good", ["VERIFIED", "VERIFIED", "FAILED"]), lesson("bad", ["FAILED", "FAILED", "FAILED"])]);
    const out = formatLessonList(loadLessons(d));
    expect(out).toContain("VERIFIED 2/3");
    expect(out).toContain("VERIFIED 0/3");
    expect(out.match(/demoted/g)?.length).toBe(1);
    expect(out.split("\n").find((l) => l.includes("VERIFIED 0/3"))).toContain("demoted");
    expect(loadLessons(d).length).toBe(2);
  });
  it("LOKI_PR_LESSON_DEMOTE=0 restores v1 retrieval", () => {
    const d = seed([lesson("bad", ["FAILED", "FAILED", "FAILED"])]);
    process.env["LOKI_PR_LESSON_DEMOTE"] = "0";
    expect(retrieveLessons(d, TASK).map((l) => l.id)).toEqual(["bad"]);
  });
  it("LOKI_NO_PR_LESSONS=1 still returns []", () => {
    const d = seed([lesson("ok", [])]);
    process.env["LOKI_NO_PR_LESSONS"] = "1";
    expect(retrieveLessons(d, TASK)).toEqual([]);
  });
  it("lesson text and the untrusted fence are unchanged", () => {
    const d = seed([lesson("ok", ["VERIFIED"])]);
    const ls = retrieveLessons(d, TASK);
    expect(ls[0]!.text).toBe("Validate the pagination cursor ok");
    const b = formatLessonsForBrief(ls);
    expect(b).toContain("<untrusted-pr-lessons>");
    expect(b).toContain("</untrusted-pr-lessons>");
    expect(b).toContain("UNTRUSTED DATA");
  });
});
