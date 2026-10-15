// REQTRACE: requirement-to-check map. Fixture PRD and spec; contract in docs/contracts/requirements.md.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { formatRunSummary, withNextLine } from "../../src/util/run_summary.ts";
import { SPEC_MARKER, renderSpec } from "../../src/util/spec_file.ts";
import {
  fromChecklist, fromPrdText, fromSpecText, mapRequirements, readRequirementsMap, renderRequirementsMap,
  writeFromChecklist, writeFromEngine10, type RanCheck,
} from "../../src/util/requirements_map.ts";

const PRD = [
  "# Todo app",
  "",
  "- Users can create a todo item with a title",
  "- Users can delete a todo item from the list",
  "- Todo items persist across a page reload",
  "",
].join("\n");

let dir = "", loki = "", runDir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-reqtrace-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, env: { PATH: process.env.PATH ?? "" } });
  loki = join(dir, ".loki"); runDir = join(loki, "runs", "e10-x");
  mkdirSync(runDir, { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ev = (name: string, result: string, cmd = ""): { type: string; data: Record<string, unknown> } => ({ type: "test.result", data: { name, result, cmd } });
const mapPath = (): string => join(loki, "state", "requirements-map.json");

describe("requirements map", () => {
  it("heuristic mapping: PRD units matched to a passing check by shared words", () => {
    const m = writeFromEngine10(dir, loki, runDir, PRD, [ev("bun:tests/todo_create_delete.test.ts", "pass", "bun test create delete todo item")]);
    expect(m).not.toBeNull();
    const disk = JSON.parse(readFileSync(mapPath(), "utf8"));
    expect(Object.keys(disk).sort()).toEqual(["requirements", "revision", "version"]);
    expect(disk.version).toBe(1);
    const byText = (t: string) => disk.requirements.find((r: { text: string }) => r.text.includes(t));
    expect(byText("create a todo item").status).toBe("covered");
    expect(byText("create a todo item").method).toBe("heuristic");
    expect(byText("create a todo item").checks).toEqual(["bun:tests/todo_create_delete.test.ts"]);
    expect(byText("persist across").status).toBe("uncovered");
  });

  it("explicit mapping: spec criterion linked by [check: id] counts only when that check passed", () => {
    writeFileSync(join(runDir, "spec.snapshot.md"), renderSpec("todo app", { intent: "todo list", criteria: ["Create works [check: bun:a.test.ts]", "Delete works [check: bun:b.test.ts]", "Reload keeps items [check: bun:missing.test.ts]"] }));
    const m = writeFromEngine10(dir, loki, runDir, "todo app", [ev("bun:a.test.ts", "pass"), ev("bun:b.test.ts", "fail")])!;
    expect(m.requirements.map((r) => [r.id, r.status, r.method, r.checks])).toEqual([
      ["R1", "covered", "explicit", ["bun:a.test.ts"]],
      ["R2", "uncovered", "explicit", []],
      ["R3", "uncovered", "explicit", []],
    ]);
    expect(m.requirements[0]!.text).toBe("Create works");
  });

  it("flaky or not_run checks never cover a requirement", () => {
    const reqs = fromSpecText(renderSpec("t", { intent: "i", criteria: ["Create works [check: c1, c2]"] }))!;
    const ran: RanCheck[] = [{ id: "c1", label: "", passed: false }, { id: "c2", label: "", passed: false }];
    expect(mapRequirements(reqs, ran, "abc").requirements[0]!.status).toBe("uncovered");
  });

  it("no PRD: a one-line brief writes no file and does not crash", () => {
    expect(writeFromEngine10(dir, loki, runDir, "fix the typo in the header", [ev("bun:a.test.ts", "pass")])).toBeNull();
    expect(existsSync(mapPath())).toBe(false);
    expect(writeFromEngine10(dir, loki, runDir, null, [])).toBeNull();
    expect(existsSync(mapPath())).toBe(false);
    expect(fromSpecText("not a spec")).toBeNull();
    expect(fromPrdText("short")).toBeNull();
  });

  it("checklist source: items are explicit requirements, only passed verification covers", () => {
    mkdirSync(join(loki, "checklist"), { recursive: true });
    writeFileSync(join(loki, "checklist", "checklist.json"), JSON.stringify({ categories: [{ items: [
      { id: "a1", title: "Login page exists", verification: [{ type: "file_exists", passed: true }] },
      { id: "a2", title: "Logout works", verification: [{ type: "tests_pass", passed: false }] },
      { id: "a3", title: "Pending item", verification: [{ type: "command", passed: null }] },
      { id: "a4", title: "No check item", verification: [] },
    ] }] }));
    expect(fromChecklist(loki)?.reqs.length).toBe(4);
    const m = writeFromChecklist(dir, loki)!;
    expect(m.requirements.map((r) => r.status)).toEqual(["covered", "uncovered", "uncovered", "uncovered"]);
    expect(m.requirements.every((r) => r.method === "explicit")).toBe(true);
    expect(m.requirements[0]!.checks).toEqual(["a1:file_exists:1"]);
    expect(readRequirementsMap(loki)?.requirements.length).toBe(4);
    expect(renderRequirementsMap(m)).toContain("1/4 covered");
  });

  it("no checklist: nothing written", () => {
    expect(writeFromChecklist(dir, loki)).toBeNull();
    expect(existsSync(mapPath())).toBe(false);
  });

  it("run summary names uncovered requirements within the 8 line cap", () => {
    const ui = { result: "verified" as const, filesChanged: 2, costUsd: 0.1, elapsedS: 5, next: "loki diff", uncovered: 2 };
    expect(formatRunSummary(ui)).toContain("2 requirements uncovered, see: loki plan --requirements");
    const six = "a\nb\nc\nd\ne\nf\n";
    const out = withNextLine(six, ui);
    expect(out.trimEnd().split("\n").length).toBeLessThanOrEqual(8);
    expect(out).toContain("requirements uncovered");
    const seven = withNextLine("a\nb\nc\nd\ne\nf\ng\n", ui);
    expect(seven.trimEnd().split("\n").length).toBe(7);
    expect(withNextLine(six, { ...ui, uncovered: 0 })).not.toContain("uncovered");
  });

  it("spec marker constant stays the parser's first line", () => {
    expect(renderSpec("t", { intent: "i", criteria: ["c"] }).split("\n")[0]).toBe(SPEC_MARKER);
  });
});
