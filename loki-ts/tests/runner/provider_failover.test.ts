import { describe, expect, test } from "bun:test";
import { classifyOutage, nextProvider, withFailover, type FailoverRecord } from "../../src/runner/provider_failover.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

describe("claude 5-hour usage limit wording", () => {
  test("a 5-hour limit line with a failing exit is a rate_limit wait", () => {
    expect(classifyOutage("You've hit your 5-hour limit. Resets 3pm.\n", 1, false)?.reason).toBe("rate_limit");
  });
  test("the 5-hour wording is not matched with a clean exit or a wider phrase", () => {
    expect(classifyOutage("5-hour limit", 0, false)).toBeNull();
    expect(classifyOutage("the 5-hour build finished", 1, false)).toBeNull();
  });
});

// The bash loop mirrors the same wording and the empty-output cause: extract the functions from run.sh and run them for real.
const RUN_SH = resolve(import.meta.dir, "../../../autonomy/run.sh");
function bash(fn: string, body: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "loki-compat-"));
  try {
    const f = join(dir, "out.log");
    writeFileSync(f, content);
    const script = `eval "$(sed -n '/^${fn}() {/,/^}/p' '${RUN_SH}')"\n${body}`;
    return spawnSync("bash", ["-c", script, "x", f], { encoding: "utf8" }).stdout.trim();
  } finally {
    rmSync(dir, { recursive: true });
  }
}
describe("run.sh mirrors", () => {
  test("is_rate_limited treats the 5-hour limit line as a usage-limit wait", () => {
    const body = 'is_rate_limited "$1" && echo yes || echo no';
    expect(bash("is_rate_limited", body, "building\nYou've hit your 5-hour limit\n")).toBe("yes");
    expect(bash("is_rate_limited", body, "Added a 5-hour cache TTL.\n")).toBe("no");
  });
  test("an empty output from a failed provider start is named provider_empty_output, not unknown", () => {
    const body = 'detect_rate_limit() { echo 0; }\n_loki_classify_iteration_error "$1" 0';
    expect(bash("_loki_classify_iteration_error", body, "")).toBe("provider_empty_output");
    expect(bash("_loki_classify_iteration_error", body, "some output\n")).toBe("unknown");
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
