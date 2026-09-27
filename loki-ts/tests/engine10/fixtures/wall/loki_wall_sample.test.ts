// Fixture: a Wall test the (fake) Wall author session "writes" into its
// isolated temp dir. Content is never executed by wall.test.ts itself (the
// base-tree run is a fake BaseTestRunner there); this just gives wall.test.ts
// real bytes to copy, hash and seal.
import { describe, expect, test } from "bun:test";

describe("loki_wall_sample", () => {
  test("the feature behaves as the task describes", () => {
    expect(1 + 1).toBe(2);
  });
});
