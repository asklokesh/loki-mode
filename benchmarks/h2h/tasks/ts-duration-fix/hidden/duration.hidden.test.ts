import { expect, test } from "bun:test";
import { parseDuration } from "../src/duration";
import { loadJob } from "../src/job";

test("single units", () => {
  expect(parseDuration("90s")).toBe(90_000);
  expect(parseDuration("3d")).toBe(3 * 86_400_000);
  expect(parseDuration("250ms")).toBe(250);
  expect(parseDuration("7m")).toBe(420_000);
});

test("compound values add up", () => {
  expect(parseDuration("1h30m")).toBe(5_400_000);
  expect(parseDuration("2d4h")).toBe(2 * 86_400_000 + 4 * 3_600_000);
  expect(parseDuration("1m30s")).toBe(90_000);
  expect(parseDuration("1h30m15s500ms")).toBe(3_600_000 + 1_800_000 + 15_000 + 500);
});

test("ms is not minutes inside a compound", () => {
  expect(parseDuration("1s250ms")).toBe(1_250);
  expect(parseDuration("2m5ms")).toBe(120_005);
});

test("whitespace around and between segments", () => {
  expect(parseDuration("  1h 30m ")).toBe(5_400_000);
  expect(parseDuration("1h  15s")).toBe(3_615_000);
});

test("invalid input throws", () => {
  for (const bad of ["", "   ", "10", "10mx", "5w", "h", "1h30", "abc"]) {
    expect(() => parseDuration(bad)).toThrow();
  }
});

test("loadJob uses the fixed parser", () => {
  const job = loadJob({ name: "sync", timeout: "1h30m", retryDelay: "1s500ms" });
  expect(job.timeoutMs).toBe(5_400_000);
  expect(job.retryDelayMs).toBe(1_500);
});
