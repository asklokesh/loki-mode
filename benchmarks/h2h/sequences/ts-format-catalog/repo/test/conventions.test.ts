// Repo conventions every exported function in src/format.ts must follow.
import { expect, test } from "bun:test";
import * as format from "../src/format";
import { FORMATTERS } from "../src/catalog";

const exported = Object.entries(format).filter(([, v]) => typeof v === "function") as [string, (...a: unknown[]) => string][];

for (const [name, fn] of exported) {
  test(`${name} is in the catalog with a passing example`, () => {
    const entry = FORMATTERS.find((f) => f.name === name);
    if (!entry) throw new Error(`add ${name} to FORMATTERS in src/catalog.ts with one example`);
    expect(entry.fn).toBe(fn as never);
    expect(entry.fn(entry.example[0])).toBe(entry.example[1]);
  });
  test(`${name} rejects a non-number first argument with TypeError`, () => {
    for (const bad of ["1", NaN, Infinity, undefined]) expect(() => fn(bad)).toThrow(TypeError);
  });
}
