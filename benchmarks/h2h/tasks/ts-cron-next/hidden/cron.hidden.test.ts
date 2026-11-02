import { expect, test } from "bun:test";
import { CronError, nextRun } from "../src/cron";

const at = (iso: string) => new Date(iso);
const next = (expr: string, from: string) => nextRun(expr, at(from)).toISOString();

test("steps from *, strictly after from, seconds dropped", () => {
  expect(next("*/15 * * * *", "2024-01-01T10:07:30.000Z")).toBe("2024-01-01T10:15:00.000Z");
  expect(next("*/15 * * * *", "2024-01-01T10:15:00.000Z")).toBe("2024-01-01T10:30:00.000Z");
  expect(next("*/15 * * * *", "2024-01-01T10:14:59.999Z")).toBe("2024-01-01T10:15:00.000Z");
  expect(next("* * * * *", "2024-01-01T10:15:59.000Z")).toBe("2024-01-01T10:16:00.000Z");
});

test("lists, ranges and steps from a range", () => {
  expect(next("5,35 9-17 * * *", "2024-01-01T12:10:00Z")).toBe("2024-01-01T12:35:00.000Z");
  expect(next("5,35 9-17 * * *", "2024-01-01T17:40:00Z")).toBe("2024-01-02T09:05:00.000Z");
  expect(next("10-50/20 * * * *", "2024-01-01T10:31:00Z")).toBe("2024-01-01T10:50:00.000Z");
  expect(next("10-50/20 * * * *", "2024-01-01T10:51:00Z")).toBe("2024-01-01T11:10:00.000Z");
  expect(next("0 1-10/4 * * *", "2024-01-01T05:00:00Z")).toBe("2024-01-01T09:00:00.000Z");
});

test("month and year rollover", () => {
  expect(next("0 0 1 * *", "2024-01-31T12:00:00Z")).toBe("2024-02-01T00:00:00.000Z");
  expect(next("0 0 31 * *", "2024-04-01T00:00:00Z")).toBe("2024-05-31T00:00:00.000Z");
  expect(next("30 23 31 12 *", "2024-12-31T23:30:00Z")).toBe("2025-12-31T23:30:00.000Z");
  expect(next("0 0 1 1 *", "2024-06-01T00:00:00Z")).toBe("2025-01-01T00:00:00.000Z");
});

test("Feb 29 only in leap years", () => {
  expect(next("0 12 29 2 *", "2025-03-01T00:00:00Z")).toBe("2028-02-29T12:00:00.000Z");
  expect(next("0 12 29 2 *", "2024-02-28T00:00:00Z")).toBe("2024-02-29T12:00:00.000Z");
  // 2100 is not a leap year, and 2104 is more than 5 years away.
  expect(() => nextRun("0 12 29 2 *", at("2096-03-01T00:00:00Z"))).toThrow(CronError);
});

test("Sunday is 0 or 7, names are case-insensitive", () => {
  expect(next("0 9 * * 7", "2024-01-03T00:00:00Z")).toBe("2024-01-07T09:00:00.000Z");
  expect(next("0 9 * * 0", "2024-01-03T00:00:00Z")).toBe("2024-01-07T09:00:00.000Z");
  expect(next("0 9 * * 5-7", "2024-01-06T10:00:00Z")).toBe("2024-01-07T09:00:00.000Z");
  expect(next("0 0 1 jan,Jul *", "2024-02-01T00:00:00Z")).toBe("2024-07-01T00:00:00.000Z");
  expect(next("0 8 * * MON-FRI", "2024-01-05T09:00:00Z")).toBe("2024-01-08T08:00:00.000Z");
  expect(next("0 9 * * sun", "2024-01-03T00:00:00Z")).toBe("2024-01-07T09:00:00.000Z");
});

test("day-of-month OR day-of-week only when both are restricted", () => {
  expect(next("0 0 13 * 5", "2024-01-01T00:00:00Z")).toBe("2024-01-05T00:00:00.000Z");
  expect(next("0 0 13 * 5", "2024-01-12T01:00:00Z")).toBe("2024-01-13T00:00:00.000Z");
  expect(next("0 0 1 2 1", "2024-01-15T00:00:00Z")).toBe("2024-02-01T00:00:00.000Z");
  expect(next("0 0 1 2 1", "2024-02-01T01:00:00Z")).toBe("2024-02-05T00:00:00.000Z");
  expect(next("0 0 13 * *", "2024-01-01T00:00:00Z")).toBe("2024-01-13T00:00:00.000Z");
  expect(next("0 0 * * 5", "2024-01-06T00:00:00Z")).toBe("2024-01-12T00:00:00.000Z");
  expect(next("0 0 * 3 1", "2024-01-01T00:00:00Z")).toBe("2024-03-04T00:00:00.000Z");
});

test("L and LW in day-of-month", () => {
  expect(next("0 0 L * *", "2024-01-31T00:00:00Z")).toBe("2024-02-29T00:00:00.000Z");
  expect(next("0 0 L * *", "2023-02-01T00:00:00Z")).toBe("2023-02-28T00:00:00.000Z");
  expect(next("30 12 L 4,6 *", "2024-05-01T00:00:00Z")).toBe("2024-06-30T12:30:00.000Z");
  // March 31 2024 is a Sunday, Aug 31 2024 a Saturday, June 30 2024 a Sunday.
  expect(next("0 0 LW * *", "2024-03-01T00:00:00Z")).toBe("2024-03-29T00:00:00.000Z");
  expect(next("0 0 LW * *", "2024-03-29T00:00:00Z")).toBe("2024-04-30T00:00:00.000Z");
  expect(next("0 0 LW 8 *", "2024-01-01T00:00:00Z")).toBe("2024-08-30T00:00:00.000Z");
  expect(next("0 0 lw 6 *", "2024-01-01T00:00:00Z")).toBe("2024-06-28T00:00:00.000Z");
});

test("nW is the nearest weekday without leaving the month", () => {
  expect(next("0 0 15W * *", "2024-05-01T00:00:00Z")).toBe("2024-05-15T00:00:00.000Z");
  expect(next("0 0 15W * *", "2024-06-01T00:00:00Z")).toBe("2024-06-14T00:00:00.000Z");
  expect(next("0 0 15W * *", "2024-06-14T00:00:00Z")).toBe("2024-07-15T00:00:00.000Z");
  expect(next("0 0 15W * *", "2024-09-01T00:00:00Z")).toBe("2024-09-16T00:00:00.000Z");
  expect(next("0 0 1W 6 *", "2024-01-01T00:00:00Z")).toBe("2024-06-03T00:00:00.000Z");
  expect(next("0 0 1W 9 *", "2024-01-01T00:00:00Z")).toBe("2024-09-02T00:00:00.000Z");
  expect(next("0 0 31W 3 *", "2024-01-01T00:00:00Z")).toBe("2024-03-29T00:00:00.000Z");
  expect(next("0 0 30W 6 *", "2024-01-01T00:00:00Z")).toBe("2024-06-28T00:00:00.000Z");
  expect(next("0 0 31W * *", "2024-04-01T00:00:00Z")).toBe("2024-05-31T00:00:00.000Z");
});

test("nL in day-of-week is the last such weekday of the month", () => {
  expect(next("0 0 * * 5L", "2024-01-01T00:00:00Z")).toBe("2024-01-26T00:00:00.000Z");
  expect(next("0 0 * * 5L", "2024-01-26T00:00:00Z")).toBe("2024-02-23T00:00:00.000Z");
  expect(next("0 0 * * 7L", "2024-03-01T00:00:00Z")).toBe("2024-03-31T00:00:00.000Z");
  expect(next("0 0 * * 0L", "2024-03-01T00:00:00Z")).toBe("2024-03-31T00:00:00.000Z");
  expect(next("0 0 * * friL", "2024-01-01T00:00:00Z")).toBe("2024-01-26T00:00:00.000Z");
});

test("n#k in day-of-week is the k-th such weekday, skipping months without one", () => {
  expect(next("0 0 * * 5#3", "2024-01-01T00:00:00Z")).toBe("2024-01-19T00:00:00.000Z");
  expect(next("0 0 * * FRI#3", "2024-01-01T00:00:00Z")).toBe("2024-01-19T00:00:00.000Z");
  expect(next("0 0 * * 7#1", "2024-01-01T00:00:00Z")).toBe("2024-01-07T00:00:00.000Z");
  expect(next("0 0 * * 1#5", "2024-01-01T00:00:00Z")).toBe("2024-01-29T00:00:00.000Z");
  expect(next("0 0 * * 1#5", "2024-01-30T00:00:00Z")).toBe("2024-04-29T00:00:00.000Z");
  expect(next("0 0 * * 1#1,5L", "2024-01-02T00:00:00Z")).toBe("2024-01-26T00:00:00.000Z");
});

test("specials follow the OR rule like any restricted field", () => {
  // last day of the month OR any Monday
  expect(next("0 0 L * 1", "2024-01-27T00:00:00Z")).toBe("2024-01-29T00:00:00.000Z");
  expect(next("0 0 L * 1", "2024-01-29T00:00:00Z")).toBe("2024-01-31T00:00:00.000Z");
  // weekday nearest the 15th OR the first Friday
  expect(next("0 0 15W * 5#1", "2024-06-01T00:00:00Z")).toBe("2024-06-07T00:00:00.000Z");
  expect(next("0 0 15W * 5#1", "2024-06-07T00:00:00Z")).toBe("2024-06-14T00:00:00.000Z");
  // day-of-month is *, so only the last Friday of February counts
  expect(next("0 0 * 2 5L", "2024-01-01T00:00:00Z")).toBe("2024-02-23T00:00:00.000Z");
});

test("aliases", () => {
  expect(next("@hourly", "2024-01-01T10:07:00Z")).toBe("2024-01-01T11:00:00.000Z");
  expect(next("@daily", "2024-01-01T10:07:00Z")).toBe("2024-01-02T00:00:00.000Z");
  expect(next("@Daily", "2024-01-01T10:07:00Z")).toBe("2024-01-02T00:00:00.000Z");
  expect(next("@weekly", "2024-01-03T00:00:00Z")).toBe("2024-01-07T00:00:00.000Z");
  expect(next("@monthly", "2024-01-15T00:00:00Z")).toBe("2024-02-01T00:00:00.000Z");
  expect(next("@yearly", "2024-06-01T00:00:00Z")).toBe("2025-01-01T00:00:00.000Z");
  expect(next("@annually", "2024-06-01T00:00:00Z")).toBe("2025-01-01T00:00:00.000Z");
});

test("invalid expressions throw CronError", () => {
  const bad = [
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "*/x * * * *",
    "5/15 * * * *",
    "5-1 * * * *",
    "1,,2 * * * *",
    "* * * FOO *",
    "* * * * JAN",
    "MON * * * *",
    "@reboot",
    "@daily 5",
    "0 0 0W * *",
    "0 0 32W * *",
    "0 0 W * *",
    "0 0 1-5W * *",
    "0 0 L/2 * *",
    "0 0 5L * *",
    "0 0 * * LW",
    "0 0 * * L",
    "0 0 * * 5W",
    "0 0 * * 5#0",
    "0 0 * * 5#6",
    "0 0 * * 8#1",
    "L 0 * * *",
  ];
  for (const expr of bad) {
    expect(() => nextRun(expr, at("2024-01-01T00:00:00Z"))).toThrow(CronError);
  }
});

test("rare schedules stay fast: 3000 calls in under 2 seconds", () => {
  const exprs = ["0 0 29 2 1", "59 23 31 12 5L", "0 0 LW 2 *", "30 4 15W * 1#5", "0 0 29 2 *"];
  const base = Date.UTC(2000, 0, 1);
  const fromFor = (i: number) => new Date(base + i * 17519 * 60000 + ((i * 7919) % 60000));
  // spot checks of single calls from the same sequence
  expect(nextRun(exprs[0], fromFor(0)).toISOString()).toBe("2000-02-07T00:00:00.000Z");
  expect(nextRun(exprs[1], fromFor(1)).toISOString()).toBe("2000-12-29T23:59:00.000Z");
  expect(nextRun(exprs[2], fromFor(2)).toISOString()).toBe("2000-02-29T00:00:00.000Z");
  expect(nextRun(exprs[3], fromFor(3)).toISOString()).toBe("2000-02-15T04:30:00.000Z");
  expect(nextRun(exprs[2], fromFor(2997)).toISOString()).toBe("2100-02-26T00:00:00.000Z");
  expect(nextRun(exprs[4], fromFor(2999)).toISOString()).toBe("2104-02-29T00:00:00.000Z");

  let sumMinutes = 0;
  let errors = 0;
  const t0 = performance.now();
  for (let i = 0; i < 3000; i++) {
    try {
      sumMinutes += nextRun(exprs[i % 5], fromFor(i)).getTime() / 60000;
    } catch (e) {
      if (!(e instanceof CronError)) throw e;
      errors++;
    }
  }
  const ms = performance.now() - t0;
  expect(errors).toBe(18);
  expect(sumMinutes).toBe(126016040280);
  expect(ms).toBeLessThan(2000);
});

test("impossible dates throw CronError; from is not modified", () => {
  expect(() => nextRun("0 0 30 2 *", at("2024-01-01T00:00:00Z"))).toThrow(CronError);
  expect(() => nextRun("0 0 31 4,6 *", at("2024-01-01T00:00:00Z"))).toThrow(CronError);
  expect(() => nextRun("0 0 31W 2 *", at("2024-01-01T00:00:00Z"))).toThrow(CronError);
  const from = at("2024-01-01T10:07:30.500Z");
  nextRun("*/15 * * * *", from);
  expect(from.toISOString()).toBe("2024-01-01T10:07:30.500Z");
  let caught: unknown;
  try {
    nextRun("bad", from);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toBeInstanceOf(CronError);
});
