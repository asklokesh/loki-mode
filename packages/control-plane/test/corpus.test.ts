// CP-00 Wall check: EXPECTED.json equals a fresh fold() over each committed corpus file.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildExpected } from "./fixtures/generate.ts";

const FIX = join(import.meta.dir, "fixtures");
const expected = JSON.parse(readFileSync(join(FIX, "EXPECTED.json"), "utf8"));

test("EXPECTED.json equals a fresh fold() over every committed run", () => {
  expect(buildExpected(join(FIX, "runs"))).toEqual(expected);
});

test("corpus covers every required outcome", () => {
  const r = expected.runs;
  expect(readdirSync(join(FIX, "runs")).length).toBe(expected.run_count);
  expect(r["verified"].verdict).toBe("VERIFIED");
  expect(r["partial"].verdict).toBe("PARTIAL");
  expect(r["failed"].verdict).toBe("FAILED");
  expect(r["blocked"].verdict).toBe("SPEC_CONFLICT");
  expect(r["cap-hit"].cap_hit).toBe(true);
  expect(r["tampered"].tampered).toBe(true);
  expect(r["unpriced"].cost_usd).toBeNull();
  expect(r["verified-pr"].pr_url).not.toBeNull();
});
