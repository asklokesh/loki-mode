import { describe, expect, test } from "bun:test";
import { classifyOutage, nextProvider, withFailover, type FailoverRecord } from "../../src/runner/provider_failover.ts";
import type { SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

describe("classifyOutage", () => {
  test("rate limit text with a failing exit is rate_limit", () => {
    const c = classifyOutage("boot\nError: 429 Too Many Requests\n", 1, false);
    expect(c?.reason).toBe("rate_limit");
    expect(c?.evidence).toBe("Error: 429 Too Many Requests");
  });
  test("outage text with a failing exit is outage", () => {
    expect(classifyOutage("API Error: overloaded_error", 1, false)?.reason).toBe("outage");
    expect(classifyOutage("connect ECONNREFUSED 1.2.3.4:443", 2, false)?.reason).toBe("outage");
  });
  test("rate limit wins over outage on the same line", () => {
    expect(classifyOutage("rate limit; service unavailable", 1, false)?.reason).toBe("rate_limit");
  });
  test("exit 137 with no provider text is null", () => {
    expect(classifyOutage("Killed", 137, false)).toBeNull();
  });
  test("exit 137 with outage text still classifies when not killed by us", () => {
    expect(classifyOutage("503 service unavailable", 137, false)?.reason).toBe("outage");
  });
  test("killed, clean exit and null exit are never an outage", () => {
    expect(classifyOutage("429 rate limit", 1, true)).toBeNull();
    expect(classifyOutage("429 rate limit", 0, false)).toBeNull();
    expect(classifyOutage("429 rate limit", null, false)).toBeNull();
  });
  test("code failure text is null", () => {
    expect(classifyOutage("TypeError: x is not a function", 1, false)).toBeNull();
    expect(classifyOutage("", 1, false)).toBeNull();
  });
  test("evidence is capped at 300 chars", () => {
    const c = classifyOutage("rate limit " + "x".repeat(500), 1, false);
    expect(c?.evidence.length).toBe(300);
  });
});

describe("nextProvider", () => {
  const all = () => true;
  test("default loader order skips current", () => {
    expect(nextProvider("claude", {}, all)).toBe("cline");
    expect(nextProvider("cline", {}, all)).toBe("claude");
  });
  test("skips providers that are not installed", () => {
    expect(nextProvider("claude", {}, (p) => p === "aider")).toBe("aider");
  });
  test("none installed returns null", () => {
    expect(nextProvider("claude", {}, () => false)).toBeNull();
  });
  test("env list honored in order, case-insensitive, deprecated gemini never chosen", () => {
    expect(nextProvider("claude", { LOKI_FAILOVER_PROVIDERS: "Gemini, Codex ,aider" }, all)).toBe("codex");
    expect(nextProvider("claude", { LOKI_FAILOVER_PROVIDERS: "gemini,bogus" }, all)).toBeNull();
  });
});

describe("withFailover", () => {
  const res = (exit: number, stderrTail: string): SessionResult => ({ exit, killed: false, stderrTail }) as unknown as SessionResult;
  const opts = (stage: string): SessionRunOptions => ({ stage, signal: new AbortController().signal }) as unknown as SessionRunOptions;
  test("rate limit on claude retries once on next provider", async () => {
    const recs: FailoverRecord[] = [];
    const used: string[] = [];
    const r = withFailover({
      provider: "claude",
      base: { run: async () => res(1, "429 too many requests") } as SessionRunner,
      makeRunner: (p) => ({ run: async () => { used.push(p); return res(0, ""); } }) as SessionRunner,
      env: {},
      installed: () => true,
      onFailover: (x) => recs.push(x),
    });
    const out = await r.run(opts("develop"));
    expect(out.exit).toBe(0);
    expect(used).toEqual(["cline"]);
    expect(recs[0]).toMatchObject({ from: "claude", to: "cline", reason: "rate_limit" });
  });
  test("verify stage never fails over", async () => {
    const recs: FailoverRecord[] = [];
    const r = withFailover({
      provider: "claude",
      base: { run: async () => res(1, "429 too many requests") } as SessionRunner,
      makeRunner: () => { throw new Error("must not run"); },
      env: {},
      installed: () => true,
      onFailover: (x) => recs.push(x),
    });
    expect((await r.run(opts("verify"))).exit).toBe(1);
    expect(recs).toEqual([]);
  });
});
