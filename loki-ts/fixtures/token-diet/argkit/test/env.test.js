import { test } from "node:test";
import assert from "node:assert/strict";
import { fromEnv } from "../src/env.js";

test("env values are coerced by type", () => {
  const v = fromEnv([{ name: "level", type: "number" }, { name: "dry_run" }], { ARGKIT_LEVEL: "4", ARGKIT_DRY_RUN: "yes" });
  assert.deepEqual(v, { level: 4, "dry-run": true });
});
