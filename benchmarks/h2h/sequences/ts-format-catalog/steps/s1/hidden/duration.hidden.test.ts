import { expect, test } from "bun:test";
import { formatDuration } from "../src/format";
import { formatterNamed } from "../src/catalog";

test("values", () => {
  expect(formatDuration(3723)).toBe("1h 02m 03s");
  expect(formatDuration(125)).toBe("2m 05s");
  expect(formatDuration(45)).toBe("45s");
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(3600)).toBe("1h 00m 00s");
  expect(formatDuration(59.9)).toBe("59s");
  expect(formatDuration(90061)).toBe("25h 01m 01s");
});

test("negative throws RangeError", () => {
  expect(() => formatDuration(-1)).toThrow(RangeError);
  expect(() => formatDuration(-1)).toThrow("seconds must be non-negative");
});

test("non-numbers throw TypeError", () => {
  for (const bad of ["1", NaN, Infinity, undefined]) expect(() => formatDuration(bad as never)).toThrow(TypeError);
});

test("in the catalog", () => {
  expect(formatterNamed("formatDuration")?.fn).toBe(formatDuration);
});
