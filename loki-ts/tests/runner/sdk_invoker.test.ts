// v8 Phase 1: sdk_invoker judge-path contract tests. No billable API call --
// these assert the fail-closed behavior (the load-bearing safety property) and
// the availability probe. A live smoke test (real API) lives behind an env gate.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cliLedger, parsePosInt, runInternalSdkJudge, runInternalSdkText } from "../../src/commands/internal_sdk_judge.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeJson, judgeText, noteJudgeUsage, sdkJudgeAvailable, __resetSdkClientForTests } from "../../src/runner/sdk_invoker.ts";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["done", "incomplete", "inconclusive"] } },
} as const;

const savedKey = process.env["ANTHROPIC_API_KEY"];
afterEach(() => {
  if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedKey;
  __resetSdkClientForTests();
});
// The client is a process-lifetime singleton (correct in production: a key can
// be injected late). Under a test runner every file shares one process, so a
// SIBLING file that sets ANTHROPIC_API_KEY leaves a live client behind and this
// file's `delete process.env[...]` no longer makes the probe honest. Reset
// before each case so the clean-process assumption actually holds.
beforeEach(() => {
  __resetSdkClientForTests();
});

describe("sdk_invoker judge path (fail-closed)", () => {
  test("no API key -> not available, judgeJson returns null (never throws)", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    // availability probe is honest
    expect(sdkJudgeAvailable()).toBe(false);
    // and the call fails closed to null rather than throwing
    const r = await judgeJson({
      prompt: "irrelevant",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "claude-haiku-4-5",
      effort: "low",
    });
    expect(r).toBeNull();
  });

  // Live smoke: only runs when explicitly enabled AND a key exists. Proves the
  // real bridge end-to-end (one prompt -> one schema-constrained JSON object).
  const liveEnabled = process.env["LOKI_SDK_LIVE_TEST"] === "1" && !!savedKey;
  test.skipIf(!liveEnabled)("LIVE: returns a schema-conforming verdict object", async () => {
    const r = await judgeJson({
      prompt: "Return a JSON object with verdict set to inconclusive.",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "claude-haiku-4-5",
      effort: "low",
    });
    expect(r).not.toBeNull();
    expect(["done", "incomplete", "inconclusive"]).toContain(String(r!["verdict"]));
  });
});

// parsePosInt is the C3 fix (council review): a bare `Number(v) || undefined`
// treated `--timeout-ms 0` as unset. This locks the intended semantics -- honor
// an explicit positive, fall back only on absent/invalid/non-positive.
describe("parsePosInt (CLI numeric-arg fallback, council C3)", () => {
  test.each([
    ["absent -> undefined", undefined, undefined],
    ["explicit positive -> value", "180000", 180000],
    ["zero -> undefined (the bug that was fixed)", "0", undefined],
    ["negative -> undefined", "-5", undefined],
    ["non-numeric -> undefined", "abc", undefined],
    ["empty string -> undefined (Number('')===0)", "", undefined],
    ["float positive -> value (Number keeps it)", "1.5", 1.5],
    ["whitespace-wrapped positive -> value (Number trims)", " 42 ", 42],
    ["Infinity token -> undefined (not finite)", "Infinity", undefined],
  ])("%s", (_label, input, expected) => {
    expect(parsePosInt(input as string | undefined)).toBe(expected as number | undefined);
  });
});

describe("COST-WALL noteJudgeUsage ledger", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "loki-cw-sdk-"));
  const lines = (d: string): string[] => {
    const p = join(d, "metrics", "child-sessions.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
  };
  test("priced usage writes exactly one line", () => {
    const d = mk();
    noteJudgeUsage({ lokiDir: d, phase: "council" }, "claude-haiku-4-5", { usage: { input_tokens: 1000, output_tokens: 500 } });
    const l = lines(d);
    expect(l.length).toBe(1);
    expect(JSON.parse(l[0]!).phase).toBe("council");
    rmSync(d, { recursive: true, force: true });
  });
  test("no ledger param writes nothing", () => {
    const d = mk();
    noteJudgeUsage(undefined, "claude-haiku-4-5", { usage: { input_tokens: 1, output_tokens: 1 } });
    expect(lines(d).length).toBe(0);
    rmSync(d, { recursive: true, force: true });
  });
  test("missing usage writes an unmeasured line", () => {
    const d = mk();
    noteJudgeUsage({ lokiDir: d, phase: "reviewer" }, "claude-haiku-4-5", {});
    const l = lines(d);
    expect(l.length).toBe(1);
    expect(JSON.parse(l[0]!).cost_status).toBe("unmeasured");
    rmSync(d, { recursive: true, force: true });
  });
});

// COST-WALL-c: drive the real judgeJson / judgeText against a local stub API (ANTHROPIC_BASE_URL) and assert the ledger line.
describe("COST-WALL-c judge ledger wiring (stub API)", () => {
  const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
  const saved: Record<string, string | undefined> = {};
  let dir = "";
  let srv: ReturnType<typeof Bun.serve> | null = null;
  const ok = JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn", content: [{ type: "text", text: "{\"verdict\":\"done\"}" }], usage: { input_tokens: 1000, output_tokens: 500 } });
  const lines = (): Record<string, unknown>[] => {
    const p = join(dir, "metrics", "child-sessions.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const serve = (status: number, body: string) => {
    srv = Bun.serve({ port: 0, fetch: () => new Response(body, { status, headers: { "content-type": "application/json" } }) });
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${srv.port}`;
    __resetSdkClientForTests();
  };
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), "loki-cwc-sdk-"));
  });
  afterEach(() => {
    srv?.stop(true); srv = null;
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __resetSdkClientForTests();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = { prompt: "p", model: "claude-sonnet-4-5" };

  test("judgeJson with a ledger param writes one priced line", async () => {
    serve(200, ok);
    expect(await judgeJson({ ...base, schema: SCHEMA, ledger: { lokiDir: dir, phase: "council" } })).toEqual({ verdict: "done" });
    const l = lines();
    expect(l.length).toBe(1);
    expect(l[0]!["phase"]).toBe("council");
    expect(l[0]!["source"]).toBe("sdk-judge");
    expect(typeof l[0]!["usd"]).toBe("number");
  });

  test("judgeText with a ledger param writes one priced line", async () => {
    serve(200, ok);
    expect(await judgeText({ ...base, ledger: { lokiDir: dir, phase: "sdk-text" } })).not.toBeNull();
    const l = lines();
    expect(l.length).toBe(1);
    expect(l[0]!["phase"]).toBe("sdk-text");
  });

  test("no ledger param writes nothing", async () => {
    serve(200, ok);
    await judgeJson({ ...base, schema: SCHEMA });
    await judgeText(base);
    expect(lines().length).toBe(0);
  });

  test("messages.create throwing still leaves one unmeasured line (never a zero usd)", async () => {
    serve(400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }));
    expect(await judgeJson({ ...base, schema: SCHEMA, ledger: { lokiDir: dir, phase: "council" } })).toBeNull();
    expect(await judgeText({ ...base, ledger: { lokiDir: dir, phase: "sdk-text" } })).toBeNull();
    const l = lines();
    expect(l.length).toBe(2);
    for (const r of l) { expect(r["cost_status"]).toBe("unmeasured"); expect("usd" in r).toBe(false); }
  });

  test("loki internal sdk-judge / sdk-text entry points pass cliLedger (phase from --phase, else default)", async () => {
    serve(200, ok);
    const prev = process.env["LOKI_DIR"];
    process.env["LOKI_DIR"] = dir;
    const pf = join(dir, "p.txt"), sf = join(dir, "s.json");
    writeFileSync(pf, "p"); writeFileSync(sf, JSON.stringify(SCHEMA));
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(await runInternalSdkJudge(["--prompt-file", pf, "--schema-file", sf, "--model", "claude-sonnet-4-5", "--phase", "council"])).toBe(0);
      expect(await runInternalSdkText(["--prompt-file", pf, "--model", "claude-sonnet-4-5"])).toBe(0);
    } finally {
      process.stdout.write = w;
      if (prev === undefined) delete process.env["LOKI_DIR"]; else process.env["LOKI_DIR"] = prev;
    }
    const l = lines();
    expect(l.map((r) => r["phase"])).toEqual(["council", "sdk-text"]);
  });

  test("no client (no key) writes nothing: no call was made", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    __resetSdkClientForTests();
    expect(await judgeJson({ ...base, schema: SCHEMA, ledger: { lokiDir: dir, phase: "council" } })).toBeNull();
    expect(lines().length).toBe(0);
  });
});

describe("COST-WALL-c cliLedger", () => {
  test("--phase names the ledger role, else the fallback; lokiDir follows LOKI_DIR", () => {
    const prev = process.env["LOKI_DIR"];
    process.env["LOKI_DIR"] = "/x/.loki";
    try {
      expect(cliLedger(["--phase", "council"], "sdk-judge")).toEqual({ lokiDir: "/x/.loki", phase: "council" });
      expect(cliLedger([], "sdk-text")).toEqual({ lokiDir: "/x/.loki", phase: "sdk-text" });
    } finally { if (prev === undefined) delete process.env["LOKI_DIR"]; else process.env["LOKI_DIR"] = prev; }
  });
});
