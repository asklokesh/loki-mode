import { describe, expect, it } from "bun:test";
import { createWatchdog, stallKillS, stallThresholdS, DEFAULT_STALL_S } from "../../src/runner/watchdog.ts";

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
  it("output with an unchanged diff is labelled looping but never stalls while output grows", () => {
    let t = 0;
    const w = createWatchdog(() => t, 300);
    w.tick(1, "x");
    const cls: string[] = [];
    for (let i = 2; i <= 40; i++) { t += 40_000; cls.push(w.tick(i, "x").cls); }
    expect(cls).toContain("looping");
    expect(cls).not.toContain("stalled");
  });
  it("a silent static session still stalls after streamed output stops", () => {
    let t = 0;
    const w = createWatchdog(() => t, 300);
    w.tick(1, "x");
    for (let i = 2; i <= 8; i++) { t += 40_000; w.tick(i, "x"); }
    t += 100_000; expect(w.tick(8, "x").cls).not.toBe("stalled");
    t += 250_000; const s = w.tick(8, "x");
    expect(s.cls).toBe("stalled"); expect(s.stalledNow).toBe(true);
  });
  it("threshold env: default below 1800, override, junk falls back", () => {
    expect(DEFAULT_STALL_S).toBeLessThan(1800);
    expect(stallThresholdS(undefined)).toBe(DEFAULT_STALL_S);
    expect(stallThresholdS("60")).toBe(60);
    expect(stallThresholdS("abc")).toBe(DEFAULT_STALL_S);
  });
  it("stallKillS: unset, blank, junk, negative, zero and Infinity are 0 (off); a positive number passes", () => {
    for (const v of [undefined, "", "abc", "-5", "0", "Infinity"]) expect(stallKillS(v)).toBe(0);
    expect(stallKillS("5")).toBe(5);
  });
  it("invalid stall env warns", () => {
    const orig = process.stderr.write.bind(process.stderr);
    const out: string[] = [];
    (process.stderr as any).write = (c: any) => { out.push(String(c)); return true; };
    const prevS = process.env["LOKI_E10_STALL_S"], prevK = process.env["LOKI_E10_STALL_KILL_S"];
    try {
      process.env["LOKI_E10_STALL_S"] = "junk-val";
      process.env["LOKI_E10_STALL_KILL_S"] = "-7";
      expect(stallThresholdS()).toBe(DEFAULT_STALL_S);
      expect(stallThresholdS()).toBe(DEFAULT_STALL_S);
      expect(stallKillS()).toBe(0);
      expect(out.length).toBe(2);
      expect(out[0]).toContain("LOKI_E10_STALL_S");
      expect(out[0]).toContain("junk-val");
      expect(out[1]).toContain("LOKI_E10_STALL_KILL_S");
      expect(out[1]).toContain("-7");
      out.length = 0;
      process.env["LOKI_E10_STALL_S"] = "60";
      process.env["LOKI_E10_STALL_KILL_S"] = "";
      expect(stallThresholdS()).toBe(60);
      expect(stallKillS()).toBe(0);
      expect(out.length).toBe(0);
    } finally {
      (process.stderr as any).write = orig;
      if (prevS === undefined) delete process.env["LOKI_E10_STALL_S"]; else process.env["LOKI_E10_STALL_S"] = prevS;
      if (prevK === undefined) delete process.env["LOKI_E10_STALL_KILL_S"]; else process.env["LOKI_E10_STALL_KILL_S"] = prevK;
    }
  });
});
