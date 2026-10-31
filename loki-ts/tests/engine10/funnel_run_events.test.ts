// AN-05: the run_finished pairs come from receipt.json only through an allowlist.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFinishedArgs } from "../../src/util/funnel.ts";

let cwd = "";
const savedLokiDir = process.env["LOKI_DIR"];
beforeEach(() => {
  delete process.env["LOKI_DIR"];
  cwd = mkdtempSync(join(tmpdir(), "an05-"));
});
afterEach(() => {
  if (savedLokiDir !== undefined) process.env["LOKI_DIR"] = savedLokiDir;
  rmSync(cwd, { recursive: true, force: true });
});
function receipt(body: Record<string, unknown>): void {
  const d = join(cwd, ".loki", "runs", "e10-20260101T000000-aaaa");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "receipt.json"), JSON.stringify(body));
}

describe("AN-05 runFinishedArgs", () => {
  for (const v of ["VERIFIED", "PARTIAL", "ALREADY_SATISFIED", "SPEC_CONFLICT", "FAILED"]) {
    test(`receipt verdict ${v} is the reported verdict`, () => {
      receipt({ verdict: v, time: { wall_s: 10, stages: { wall: 3, implement: 5.4 } }, cost: { fix_rounds: [{}, {}, {}] } });
      expect(runFinishedArgs(1, cwd)).toEqual([v, "duration_s=10", "stage_s_wall=3", "stage_s_implement=5", "fix_rounds=3", "exit_code=1"]);
    });
  }
  test("no receipt is INTERRUPTED, and exit 4 without one is BLOCKED", () => {
    expect(runFinishedArgs(1, cwd)).toEqual(["INTERRUPTED", "exit_code=1"]);
    expect(runFinishedArgs(4, cwd)).toEqual(["BLOCKED", "exit_code=4"]);
  });
  test("a receipt older than this run is not this run's receipt", () => {
    receipt({ verdict: "VERIFIED" });
    expect(runFinishedArgs(0, cwd, Date.now() + 60_000)[0]).toBe("INTERRUPTED");
  });
  test("an out-of-enum verdict and injected extra keys never reach the pairs", () => {
    receipt({ verdict: "/Users/x/secret", repo: "/Users/x/repo", spec_conflict_reason: "secret text", time: { wall_s: 5, stages: { "wall+implement": 4, "/etc/passwd": 9 } } });
    expect(runFinishedArgs(1, cwd)).toEqual(["INTERRUPTED", "exit_code=1"]);
    receipt({ verdict: "FAILED", repo: "/Users/x/repo", spec_conflict_reason: "secret text", time: { wall_s: 5, stages: { "wall+implement": 4, "/etc/passwd": 9 } } });
    const out = runFinishedArgs(1, cwd);
    expect(out).toEqual(["FAILED", "duration_s=5", "exit_code=1"]);
    expect(JSON.stringify(out)).not.toContain("secret");
  });
  test("the Wall failure-tail NOT PROVEN line never reaches the pairs", () => {
    receipt({ verdict: "FAILED", not_proven: ["Wall failure output kept: /Users/x/.loki/runs/r1/wall-failure-tail.txt"], wall: { tail: "AssertionError secret" } });
    const out = runFinishedArgs(1, cwd);
    expect(out).toEqual(["FAILED", "exit_code=1"]);
    expect(out.join(" ")).not.toContain("wall-failure-tail");
  });
  test("a corrupt receipt is INTERRUPTED, never a throw", () => {
    const d = join(cwd, ".loki", "runs", "e10-20260101T000000-aaaa");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "receipt.json"), "{not json");
    expect(runFinishedArgs(1, cwd)[0]).toBe("INTERRUPTED");
  });
});
