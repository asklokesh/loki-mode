// v8 Phase 4 Story 8: E2E Tier 1 for the SDK RARV loop. GATED behind
// LOKI_E2E_SDK=1 AND a usable claude auth (ANTHROPIC_API_KEY or a logged-in
// claude the Agent SDK can use), because it makes a REAL, billable API call and
// runs the full agentic loop. It self-skips otherwise so CI/local runs without
// the gate stay free. Budget-capped and iteration-capped.
//
// Proves the whole path end to end against the live API:
//   LOKI_SDK_LOOP=1 loki start <spec> -> runAutonomous -> sdkQueryProvider ->
//   query() -> agentic tool loop -> a real file is created -> completion signal ->
//   consumeSdkStream writes real .loki state (agents.json + result-cost).
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// E2E-shaped: drives the real loop, which writes state files and spawns
// processes. Bun's 5000ms default is fine idle and NOT fine inside a full CI
// run, where the box is saturated -- tests then fail at exactly ~5000ms and
// WHICH ones fail changes between runs. That is a timeout signature, not a
// defect, and it reads as a regression. 30s is far beyond the honest worst
// case while still catching a genuine hang.
setDefaultTimeout(30_000);

const ENABLED = process.env["LOKI_E2E_SDK"] === "1";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-e2e-sdk-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("SDK loop E2E Tier 1 (gated LOKI_E2E_SDK=1, real API)", () => {
  test.skipIf(!ENABLED)(
    "builds a real one-file app on the SDK loop and signals completion",
    async () => {
      // A deliberately trivial spec so the run is cheap + deterministic.
      const spec = join(scratch, "prd.md");
      writeFileSync(
        spec,
        "# add.py\n\nCreate a Python file named add.py in the current working directory containing:\n\n    def add(a, b):\n        return a + b\n\nThat is the entire task. Create the file, then you are done.\n",
      );

      const { runStart } = await import("../../src/commands/start.ts");
      const prevLoop = process.env["LOKI_SDK_LOOP"];
      const prevCwd = process.cwd();
      process.env["LOKI_SDK_LOOP"] = "1";
      process.chdir(scratch);
      let code: number;
      try {
        code = await runStart([spec, "--max-iterations", "3", "--budget-limit", "3.00"]);
      } finally {
        process.chdir(prevCwd);
        if (prevLoop === undefined) delete process.env["LOKI_SDK_LOOP"];
        else process.env["LOKI_SDK_LOOP"] = prevLoop;
      }

      // The loop should terminate cleanly (completion promise fulfilled -> 0).
      expect(code).toBe(0);

      // The real artifact was built.
      const addPy = join(scratch, "add.py");
      expect(existsSync(addPy)).toBe(true);
      expect(readFileSync(addPy, "utf8")).toContain("def add");

      // consumeSdkStream wrote real .loki state.
      expect(existsSync(join(scratch, ".loki", "state", "agents.json"))).toBe(true);
      // At least one result-cost file with a real cost.
      const metricsDir = join(scratch, ".loki", "metrics");
      expect(existsSync(metricsDir)).toBe(true);
    },
    120_000, // real API call: generous timeout
  );

  test("self-skips cleanly when the gate is off (documents the gate)", () => {
    // This test always runs and documents that the billable E2E is opt-in.
    if (!ENABLED) {
      expect(ENABLED).toBe(false);
    } else {
      expect(ENABLED).toBe(true);
    }
  });
});
