import { describe, expect, test } from "bun:test";
import { parseResetText, type UsageWindow } from "../src/util/usage_window.ts";

const NY = "America/New_York";
const utc = (s: string): number => Date.parse(s) / 1000;

describe("parseResetText", () => {
  test("month day at time with explicit zone (governor fixture)", () => {
    const now = utc("2026-09-30T12:00:00Z");
    // Oct 1 3:20am EDT = 07:20Z
    expect(parseResetText("Oct 1 at 3:20am (America/New_York)", now, "UTC")).toBe(
      utc("2026-10-01T07:20:00Z"),
    );
  });

  test("month day at hour-only time uses the fallback tz (governor fixture)", () => {
    const now = utc("2026-10-01T00:00:00Z");
    // Oct 7 1pm EDT = 17:00Z
    expect(parseResetText("Oct 7 at 1pm", now, NY)).toBe(utc("2026-10-07T17:00:00Z"));
  });

  test("bare time resolves to the next occurrence (rate-limit fixture)", () => {
    const now = utc("2026-10-08T10:00:00Z"); // 06:00 EDT
    expect(parseResetText("4am", now, NY)).toBe(utc("2026-10-09T08:00:00Z"));
    const early = utc("2026-10-08T05:00:00Z"); // 01:00 EDT
    expect(parseResetText("4am", early, NY)).toBe(utc("2026-10-08T08:00:00Z"));
  });

  test("DST fall back: Nov 1 2026 1am is ambiguous, later Nov 2 resolves at EST", () => {
    const now = utc("2026-10-30T00:00:00Z");
    expect(parseResetText("Nov 2 at 3am", now, NY)).toBe(utc("2026-11-02T08:00:00Z"));
    expect(parseResetText("Oct 31 at 3am", now, NY)).toBe(utc("2026-10-31T07:00:00Z"));
  });

  test("DST spring forward: Mar 8 2026 2:30am does not exist, resolves forward", () => {
    const now = utc("2026-03-01T00:00:00Z");
    const got = parseResetText("Mar 8 at 2:30am", now, NY);
    expect(got).not.toBeNull();
    // 2:30 EST-equivalent = 07:30Z = 3:30 EDT
    expect(got).toBe(utc("2026-03-08T07:30:00Z"));
    expect(parseResetText("Mar 8 at 4am", now, NY)).toBe(utc("2026-03-08T08:00:00Z"));
  });

  test("across the boundary the same wall time maps to different offsets", () => {
    const now = utc("2026-03-01T00:00:00Z");
    const before = parseResetText("Mar 7 at 9am", now, NY) as number;
    const after = parseResetText("Mar 9 at 9am", now, NY) as number;
    expect(before).toBe(utc("2026-03-07T14:00:00Z"));
    expect(after).toBe(utc("2026-03-09T13:00:00Z"));
  });

  test("past month-day rolls to next year", () => {
    const now = utc("2026-10-08T00:00:00Z");
    expect(parseResetText("Oct 1 at 3:20am (UTC)", now, "UTC")).toBe(utc("2027-10-01T03:20:00Z"));
  });

  test("12am and 12pm", () => {
    const now = utc("2026-06-01T00:00:00Z");
    expect(parseResetText("Jun 5 at 12am", now, "UTC")).toBe(utc("2026-06-05T00:00:00Z"));
    expect(parseResetText("Jun 5 at 12pm", now, "UTC")).toBe(utc("2026-06-05T12:00:00Z"));
  });

  test("no hardcoded weekday: the same text gives the same answer for any weekday", () => {
    const a = parseResetText("Oct 7 at 1pm", utc("2026-10-01T00:00:00Z"), "UTC");
    const b = parseResetText("Oct 7 at 1pm", utc("2026-10-02T00:00:00Z"), "UTC");
    expect(a).toBe(utc("2026-10-07T13:00:00Z"));
    expect(b).toBe(a);
  });

  test("unparseable returns null, never now+5h", () => {
    const now = utc("2026-10-08T00:00:00Z");
    for (const bad of ["", "soon", "Oct 32 at 3am", "Foo 1 at 3am", "13pm", "3:75am", "Oct 1 at 3am (Not/AZone)", "resets"]) {
      expect(parseResetText(bad, now, "UTC")).toBeNull();
    }
    expect(parseResetText(undefined as unknown as string, now, "UTC")).toBeNull();
    expect(parseResetText("4am", now, "Not/AZone")).toBeNull();
    expect(parseResetText("4am", Number.NaN, "UTC")).toBeNull();
  });

  test("Feb 30 is rejected", () => {
    expect(parseResetText("Feb 30 at 1am", utc("2026-01-01T00:00:00Z"), "UTC")).toBeNull();
  });
});

describe("UsageWindow", () => {
  test("type shape", () => {
    const w: UsageWindow = { kind: "session", used_pct: 12, resets_at: null };
    expect(w.resets_at).toBeNull();
  });
});
