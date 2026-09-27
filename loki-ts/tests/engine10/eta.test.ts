// E-20: ETA (docs/v10/ENGINE.md section 16). estimate() matches output.ts's
// EtaEstimator type exactly: it is the module output.ts's estimateEtaS()
// dynamically imports from "./eta.ts".
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimate, loadHistory, record, reset, saveHistory } from "../../src/engine10/eta.ts";

describe("estimate", () => {
  beforeEach(() => reset());

  test("null target yields no estimate (section 4: deep's target is unbounded)", () => {
    expect(estimate(null, 30)).toBeNull();
  });

  test("first run: no history yet, uses the raw stage target", () => {
    expect(estimate(180, 60)).toBe(120);
  });

  test("never negative, even once elapsed passes the target", () => {
    expect(estimate(60, 500)).toBe(0);
  });

  test("cached history: a stage that runs over target raises later estimates", () => {
    // implement stage: target 180s, actually took 360s (2x overrun).
    record(180, 360);
    // Next call blends in that learned 2x ratio instead of the raw target.
    expect(estimate(180, 60)).toBe(300); // (180 * 2) - 60
  });

  test("cached history averages across multiple recorded stages", () => {
    record(60, 60); // ratio 1
    record(60, 120); // ratio 2
    // average ratio 1.5
    expect(estimate(100, 0)).toBe(150);
  });

  test("record ignores a null or non-positive target and a negative duration", () => {
    record(null, 999);
    record(0, 999);
    record(-5, 999);
    record(60, -1);
    expect(estimate(180, 60)).toBe(120); // still first-run behavior
  });
});

describe("loadHistory / saveHistory (cross-run persistence, section 13)", () => {
  let dir: string;

  beforeEach(() => {
    reset();
    dir = mkdtempSync(join(tmpdir(), "e10-eta-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a fresh dir has no history: first run uses the raw target", () => {
    loadHistory(dir); // no eta.json yet
    expect(estimate(180, 60)).toBe(120);
  });

  test("history saved by one process is used by the next", () => {
    record(180, 360); // that run's implement stage took 2x its target
    saveHistory(dir);

    reset(); // simulate a fresh process with no in-memory history
    loadHistory(dir);
    expect(estimate(180, 60)).toBe(300); // (180 * 2) - 60
  });

  test("a corrupt eta.json is ignored, not thrown", () => {
    writeFileSync(join(dir, "eta.json"), "{not json");
    loadHistory(dir);
    expect(estimate(180, 60)).toBe(120);
  });
});
