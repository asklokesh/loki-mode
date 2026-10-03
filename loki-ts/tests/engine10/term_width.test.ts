// FC-10 / L7: one terminal width helper; a pty with no size must not truncate the live line.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { terminalWidth } from "../../src/util/term_width.ts";
import { LiveLine } from "../../src/e10ext/liveline.ts";

describe("terminalWidth (FC-10)", () => {
  test("undefined, 0, 20, NaN fall back to 80", () => {
    for (const c of [undefined, 0, 20, NaN]) expect(terminalWidth({ columns: c }, {})).toBe(80);
  });
  test("honours a real size >= 40", () => {
    expect(terminalWidth({ columns: 40 }, {})).toBe(40);
    expect(terminalWidth({ columns: 132 }, { COLUMNS: "100" })).toBe(132);
  });
  test("uses a valid COLUMNS when columns is unusable, ignores junk", () => {
    expect(terminalWidth({ columns: 0 }, { COLUMNS: "120" })).toBe(120);
    expect(terminalWidth({ columns: undefined }, { COLUMNS: "abc" })).toBe(80);
    expect(terminalWidth({ columns: undefined }, { COLUMNS: "0" })).toBe(80);
  });
});

describe("live line with no tty size", () => {
  for (const columns of [undefined, 0, 20]) {
    test(`columns=${String(columns)} renders the full stage text`, () => {
      const out: string[] = [];
      const l = new LiveLine({ tty: true, write: (s) => out.push(s), now: () => 1_000_000, columns: columns as number | undefined, graceS: 3 });
      l.onEvent({ type: "stage.started", stage: "implement", data: {} });
      expect(out.at(-1)).toContain("[implement] implementing");
    });
  }
});

describe("guard: no raw width reads outside the helper", () => {
  test("src has no .columns read except util/term_width.ts", () => {
    const root = join(import.meta.dir, "../../src");
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(n) || p.endsWith("util/term_width.ts")) continue;
        readFileSync(p, "utf8").split("\n").forEach((ln, i) => {
          if (/(stdout|stderr|process\.std\w+)\.columns|\bgetWindowSize\b/.test(ln) && !/^\s*\/\//.test(ln)) bad.push(`${p}:${i + 1}`);
        });
      }
    };
    walk(root);
    expect(bad).toEqual([]);
  });
});
