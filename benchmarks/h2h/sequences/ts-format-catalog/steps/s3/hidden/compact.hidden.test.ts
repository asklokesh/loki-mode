import { expect, test } from "bun:test";
import { formatCompact } from "../src/format";
import { formatterNamed } from "../src/catalog";

test("values", () => {
  const want: [number, string][] = [[950, "950"], [0, "0"], [999.4, "999"], [1000, "1K"], [1200, "1.2K"], [15300, "15.3K"],
    [2500000, "2.5M"], [7000000000, "7B"], [-1200, "-1.2K"], [-5, "-5"], [1240000, "1.2M"]];
  for (const [n, s] of want) expect(formatCompact(n)).toBe(s);
});

test("non-numbers throw TypeError", () => {
  for (const bad of ["1", NaN, Infinity, undefined]) expect(() => formatCompact(bad as never)).toThrow(TypeError);
});

test("in the catalog", () => {
  expect(formatterNamed("formatCompact")?.fn).toBe(formatCompact);
});
