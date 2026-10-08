import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forecastLine,
  printForecast,
  readingFromGovernorJson,
  readWindowDeltas,
  recordWindowDelta,
} from "../src/engine10/forecast.ts";
import { runQueue } from "../src/commands/queue.ts";

const mk = (): string => mkdtempSync(join(tmpdir(), "loki-forecast-"));
const writeQueue = (dir: string, items: { ref: string; added_at: string }[]): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "issue-queue.json"), JSON.stringify({ items }));
};
const R = { session_pct: 40, week_pct: 12 };

describe("forecastLine", () => {
  test("stub governor JSON plus history gives the expected line", () => {
    const rep = { measured: { status: "ok", session_pct: 40, week_pct: 12 } };
    const hist = [{ session: 2, week: 1 }, { session: 4, week: 1 }, { session: 3, week: 2 }];
    expect(forecastLine(readingFromGovernorJson(rep), hist, { env: {}, width: 200 })).toBe(
      "forecast: ~2-4% of session window, ~1-2% of week (basis: 3 past runs; session 40% used, week 12% used)",
    );
  });

  test("no reading prints unmeasured and no percent forecast", () => {
    const line = forecastLine(readingFromGovernorJson({ measured: { status: "error" } }), [], { env: {}, width: 200 });
    expect(line).toContain("unmeasured");
    expect(line).not.toMatch(/~\d/);
  });

  test("reading but too little history stays unmeasured", () => {
    const line = forecastLine(R, [{ session: 5, week: 5 }], { env: {}, width: 200 });
    expect(line).toContain("unmeasured");
    expect(line).not.toMatch(/~\d/);
  });

  test("LOKI_FORECAST=0 prints nothing", () => {
    expect(forecastLine(R, [], { env: { LOKI_FORECAST: "0" } })).toBeNull();
  });

  test("stays within a narrow terminal width", () => {
    const hist = [{ session: 2, week: 1 }, { session: 4, week: 1 }, { session: 3, week: 2 }];
    expect(forecastLine(R, hist, { env: {}, width: 40 })!.length).toBeLessThanOrEqual(40);
  });
});

describe("history", () => {
  test("record then read; cache-hit zero and negative deltas are not recorded", () => {
    const dir = mk();
    try {
      expect(recordWindowDelta(dir, R, { session_pct: 43, week_pct: 13 })).toBe(true);
      expect(recordWindowDelta(dir, R, R)).toBe(false);
      expect(recordWindowDelta(dir, R, { session_pct: 5, week_pct: 13 })).toBe(false);
      expect(recordWindowDelta(dir, null, R)).toBe(false);
      expect(readWindowDeltas(dir)).toEqual([{ session: 3, week: 1 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("forecast is never written into a receipt or proof", async () => {
    const dir = mk();
    try {
      let out = "";
      await printForecast(dir, async () => R, (s) => (out += s), {});
      expect(out).toContain("forecast:");
      expect(existsSync(join(dir, "runs"))).toBe(false);
      expect(existsSync(join(dir, "proofs"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a throwing reader never throws out of printForecast", async () => {
    await printForecast(mk(), async () => { throw new Error("boom"); }, () => {}, {});
  });
});

describe("queue run call site", () => {
  test("prints the forecast once, runs every item, and does not block", async () => {
    const dir = mk();
    try {
      writeQueue(dir, [{ ref: "a/b#1", added_at: "t" }, { ref: "a/b#2", added_at: "t" }]);
      let out = "";
      let calls = 0;
      const rc = await runQueue(["run", "--no-pr"], {
        lokiDir: dir,
        governor: async () => ({ ok: true, hold: false, reason: "ok", usage: R }),
        runner: async () => { calls++; return { rc: 0, output: "", verdict: "VERIFIED" }; },
        out: () => {},
        err: (s) => (out += s),
      });
      expect(rc).toBe(0);
      expect(calls).toBe(2);
      expect(out.match(/^forecast:/gm)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("forecast line absent when LOKI_FORECAST=0", async () => {
    const dir = mk();
    const prev = process.env["LOKI_FORECAST"];
    process.env["LOKI_FORECAST"] = "0";
    try {
      writeQueue(dir, [{ ref: "a/b#1", added_at: "t" }]);
      let out = "";
      await runQueue(["run"], {
        lokiDir: dir,
        governor: async () => ({ ok: true, hold: false, reason: "ok", usage: R }),
        runner: async () => ({ rc: 0, output: "" }),
        out: () => {},
        err: (s) => (out += s),
      });
      expect(out).not.toContain("forecast:");
    } finally {
      if (prev === undefined) delete process.env["LOKI_FORECAST"]; else process.env["LOKI_FORECAST"] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
