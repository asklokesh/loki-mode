import { expect, test } from "bun:test";
import { parseDuration } from "../src/duration";
import { loadJob } from "../src/job";

test("seconds", () => {
  expect(parseDuration("90s")).toBe(90_000);
});

test("hours", () => {
  expect(parseDuration("2h")).toBe(7_200_000);
});

test("loadJob converts the timeout", () => {
  expect(loadJob({ name: "nightly", timeout: "5m" }).timeoutMs).toBe(300_000);
});
