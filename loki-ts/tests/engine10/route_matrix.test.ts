// Semantic L1 guard for ROUTER-1 (primary): behavior across the route-record x run-model x failure-kind matrix.
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { matrixViolations } from "./route_matrix_lib.ts";

const SRC = join(import.meta.dir, "../../src");

describe("L1 semantic route matrix", () => {
  it("the shipped source never starts a session below the run model without a valid Opus route record", async () => {
    expect(await matrixViolations(SRC)).toEqual([]);
  }, 120_000);
});
