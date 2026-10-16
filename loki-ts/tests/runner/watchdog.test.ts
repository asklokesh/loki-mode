import { describe, expect, it } from "bun:test";
import { createWatchdog, stallThresholdS, DEFAULT_STALL_S } from "../../src/runner/watchdog.ts";

describe("watchdog progress classes", () => {
  it("classifies progressing, idle, stalled with a fake clock and fires stall once", () => {
    let t = 0;
    const w = createWatchdog(() => t, 300);
    expect(w.tick(10, "a").cls).toBe("progressing");
    t = 60_000; expect(w.tick(20, "b").cls).toBe("progressing");
    t = 200_000; expect(w.tick(20, "b").cls).toBe("idle");
    t = 400_000;
    const s = w.tick(20, "b");
    expect(s.cls).toBe("stalled"); expect(s.stalledNow).toBe(true);
    t = 500_000; expect(w.tick(20, "b").stalledNow).toBe(false);
    t = 510_000; expect(w.tick(20, "c").cls).toBe("progressing");
  });
  it("output with an unchanged diff is looping, then stalls", () => {
    let t = 0;
    const w = createWatchdog(() => t, 300);
    w.tick(1, "x");
    const cls: string[] = [];
    for (let i = 2; i <= 12; i++) { t += 40_000; cls.push(w.tick(i, "x").cls); }
    expect(cls).toContain("looping");
    expect(cls[cls.length - 1]).toBe("stalled");
  });
  it("threshold env: default below 1800, override, junk falls back", () => {
    expect(DEFAULT_STALL_S).toBeLessThan(1800);
    expect(stallThresholdS(undefined)).toBe(DEFAULT_STALL_S);
    expect(stallThresholdS("60")).toBe(60);
    expect(stallThresholdS("abc")).toBe(DEFAULT_STALL_S);
  });
});
