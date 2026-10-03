// FC-19: the implement brief is the full job; only trust rules remain.
import { describe, expect, test } from "bun:test";
import { FIXED_RULES } from "../../src/e10ext/context.ts";
import { LEAN_PREFIX, STAGE_PREFIX } from "../../src/features/lean_prefix.ts";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import { buildPlanBrief } from "../../src/engine10/stages/plan.ts";
import { buildWallBrief } from "../../src/engine10/stages/wall.ts";

const BANNED = [/smallest/i, /stage of a larger run/i, /touch only/i, /only the files/i, /run only/i, /never run the full/i, /only the tests it names/i, /named below\.$/m];
describe("FC-19 full-job brief", () => {
  const brief = buildImplementBrief("migrate all routes", null, ["a.test.ts"], "");
  for (const re of BANNED) {
    test(`no limiting phrase ${re}`, () => {
      for (const t of [FIXED_RULES, LEAN_PREFIX, STAGE_PREFIX, brief]) expect(t).not.toMatch(re);
    });
  }
  test("trust rules remain", () => {
    expect(FIXED_RULES).toContain("Wall tests are read-only");
    expect(FIXED_RULES).toContain("never edit or delete an existing one");
    expect(FIXED_RULES).toContain("Never kill processes");
    expect(FIXED_RULES).toContain("Do not commit or push");
  });
  test("states the full job and allows the full suite", () => {
    expect(FIXED_RULES).toContain("complete task");
    expect(FIXED_RULES).toContain("full suite");
    expect(brief).toContain("a starting hint, not a limit");
  });
  test("prefix stays a constant over 200 bytes", () => { expect(STAGE_PREFIX.length).toBeGreaterThan(200); });
  test("plan and Wall briefs carry no full-job wording, and the shared prefixes are role-neutral", () => {
    const FULL_JOB = [/complete task/i, /senior engineer/i, /full suite/i, /starting hints?/i, /any file/i];
    process.env["LOKI_SPEED"] = "1";
    for (const b of [buildPlanBrief("t", ["a.ts"], "/tmp/p.md"), buildWallBrief("t", "a.ts", [])]) for (const re of FULL_JOB) expect(b).not.toMatch(re);
    for (const p of [STAGE_PREFIX, LEAN_PREFIX]) for (const re of FULL_JOB) expect(p).not.toMatch(re);
    expect(buildPlanBrief("t", [], "/tmp/p.md")).toContain("Do not edit any other file. Do not run tests.");
    expect(FIXED_RULES).toMatch(/complete task/);
  });
});
