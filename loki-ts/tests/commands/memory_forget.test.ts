import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/util/shell.ts";
import { lessonsPath, loadLessons, removeLesson, type Lesson } from "../../src/util/pr_lessons.ts";

const CLI = resolve(import.meta.dir, "..", "..", "src", "cli.ts");

const mk = (id: string, text: string, uses: Lesson["uses"] = []): Lesson => ({
  id, text,
  source: { pr: "o/r#1", pr_url: "https://github.com/o/r/pull/1", comment_url: `https://github.com/o/r/pull/1#${id}`, kind: "review_comment", author: "a" },
  learned_at: "2026-10-08T00:00:00.000Z", uses,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-forget-"));
  mkdirSync(join(dir, ".loki", "memory", "semantic"), { recursive: true });
  const ls = [
    mk("prl-aaa", "first lesson"),
    mk("prl-bbb", "second lesson", [
      { run_id: "r1", verdict: "VERIFIED", at: "t" },
      { run_id: "r2", verdict: "FAILED", at: "t" },
      { run_id: "r3", verdict: null, at: "t" },
    ]),
  ];
  writeFileSync(lessonsPath(dir), JSON.stringify({ version: 1, lessons: ls }, null, 2) + "\n");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const loki = (args: string[]) => run(["bun", CLI, ...args], { cwd: dir, env: { ...process.env, LOKI_NO_BROWSER: "1" } });

describe("memory forget", () => {
  it("removes exactly that lesson and prints its text", async () => {
    const r = await loki(["memory", "forget", "prl-aaa"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("first lesson");
    expect(loadLessons(dir).map((l) => l.id)).toEqual(["prl-bbb"]);
  });

  it("unknown id exits 1 with 'no such lesson' and leaves the file untouched", async () => {
    const before = readFileSync(lessonsPath(dir), "utf-8");
    const r = await loki(["memory", "forget", "prl-zzz"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no such lesson");
    expect(readFileSync(lessonsPath(dir), "utf-8")).toBe(before);
  });

  it("without an id prints usage and exits 2", async () => {
    const r = await loki(["memory", "forget"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Usage: loki memory forget");
  });

  it("removeLesson leaves no temp file and the result parses", () => {
    expect(removeLesson(dir, "prl-aaa")?.id).toBe("prl-aaa");
    expect(removeLesson(dir, "prl-aaa")).toBeNull();
    expect(JSON.parse(readFileSync(lessonsPath(dir), "utf-8")).lessons).toHaveLength(1);
  });
});

describe("memory lessons --json", () => {
  it("prints valid JSON with id, text, source, uses and verified ratio", async () => {
    const r = await loki(["memory", "lessons", "--json"]);
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toHaveLength(2);
    expect(j[0]).toMatchObject({ id: "prl-aaa", text: "first lesson", uses: 0, verified_ratio: null });
    expect(j[1]).toMatchObject({ id: "prl-bbb", uses: 3, verified_ratio: 0.5 });
    expect(j[1].source.pr).toBe("o/r#1");
  });
});
