import { expect, test } from "bun:test";
import { formatBytes, formatPercent } from "../src/format";
import { formatterNamed } from "../src/catalog";

test("formatBytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(-2048)).toBe("-2.0 KB");
});

test("formatPercent", () => {
  expect(formatPercent(0.256)).toBe("25.6%");
});

test("catalog lookup", () => {
  expect(formatterNamed("formatBytes")?.fn(1024)).toBe("1.0 KB");
  expect(formatterNamed("nope")).toBeUndefined();
});
