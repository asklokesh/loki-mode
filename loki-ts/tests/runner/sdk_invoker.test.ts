// v8 Phase 1: sdk_invoker judge-path contract tests. No billable API call --
// these assert the fail-closed behavior (the load-bearing safety property) and
// the availability probe. A live smoke test (real API) lives behind an env gate.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cliLedger, parseThinking, parsePosInt, runInternalSdkJudge, runInternalSdkText } from "../../src/commands/internal_sdk_judge.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EFFORT_MAX_TOKENS, judgeJson, judgeJsonOutcome, judgeText, judgeTextOutcome, noteJudgeUsage, sdkJudgeAvailable, __resetSdkClientForTests, __setSdkClientForTests } from "../../src/runner/sdk_invoker.ts";

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
  test("#295: a schema with a dynamic enum literal returns null and never reaches the API", async () => {
    let calls = 0;
    __setSdkClientForTests({ messages: { create: async () => { calls++; return { content: [{ type: "text", text: "{}" }], usage: {} }; } } });
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => { errs.push(String(c)); return true; }) as typeof process.stderr.write;
    try {
      const r = await judgeJson({ prompt: "p", schema: { type: "object", properties: { v: { type: "string", enum: ["run-7c1e-manifest"] } } }, model: "claude-haiku-4-5" });
      expect(r).toBeNull();
    } finally { process.stderr.write = orig; }
    expect(calls).toBe(0);
    expect(errs.join("")).toContain("static schema allowlist");
  });

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

describe("judge calls are always synchronous (LOKI_JUDGE_BATCH removed)", () => {
  const savedBatch = process.env["LOKI_JUDGE_BATCH"];
  afterEach(() => {
    if (savedBatch === undefined) delete process.env["LOKI_JUDGE_BATCH"];
    else process.env["LOKI_JUDGE_BATCH"] = savedBatch;
  });
  test("LOKI_JUDGE_BATCH=1 with an API key never touches the batches API", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    process.env["LOKI_JUDGE_BATCH"] = "1";
    const calls = { sync: 0, batch: 0 };
    const trap = () => {
      calls.batch++;
      throw new Error("batches API must not be used in-loop");
    };
    __setSdkClientForTests({
      messages: {
        create: async () => {
          calls.sync++;
          return { stop_reason: "end_turn", content: [{ type: "text", text: '{"verdict":"done"}' }], usage: {} };
        },
        batches: { create: trap, retrieve: trap, results: trap, cancel: trap },
      },
    });
    const out = await judgeJson({ prompt: "p", schema: SCHEMA as unknown as Record<string, unknown>, model: "claude-haiku-4-5" });
    expect(out).toEqual({ verdict: "done" });
    expect(calls.sync).toBe(1);
    expect(calls.batch).toBe(0);
  });
});

describe("judge stop_reason classification and recovery (stub API)", () => {
  const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
  const saved: Record<string, string | undefined> = {};
  let srv: ReturnType<typeof Bun.serve> | null = null;
  let dir = "";
  const seen: { body: Record<string, unknown>; beta: string | null }[] = [];
  const msg = (stop_reason: string, text: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-5", stop_reason, content: text ? [{ type: "text", text }] : [], usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
  // Serve the given bodies in order (last repeats), recording each request.
  const serveSeq = (bodies: string[]) => {
    let i = 0;
    srv = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ body: (await req.json()) as Record<string, unknown>, beta: req.headers.get("anthropic-beta") });
        const b = bodies[Math.min(i++, bodies.length - 1)]!;
        return new Response(b, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${srv.port}`;
    __resetSdkClientForTests();
  };
  // Stub client on the default endpoint (server-side fallback is only sent there).
  // Items are message JSON strings or Errors to throw; the last item repeats.
  const serveStub = (items: (string | Error)[], baseURL = "https://api.anthropic.com") => {
    let i = 0;
    __setSdkClientForTests({
      baseURL,
      messages: {
        create: async (body: Record<string, unknown>, opts?: { headers?: Record<string, string> }) => {
          seen.push({ body, beta: opts?.headers?.["anthropic-beta"] ?? null });
          const it = items[Math.min(i++, items.length - 1)]!;
          if (it instanceof Error) throw it;
          return JSON.parse(it);
        },
      },
    });
  };
  const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });
  const base = { prompt: "p", model: "claude-sonnet-5-5", schema: SCHEMA as unknown as Record<string, unknown> };
  const ledgerOutcomes = (): unknown[] => {
    const p = join(dir, "metrics", "child-sessions.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)["outcome"]) : [];
  };
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    seen.length = 0;
    dir = mkdtempSync(join(tmpdir(), "loki-stop-"));
  });
  afterEach(() => {
    srv?.stop(true); srv = null;
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __resetSdkClientForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test("end_turn with JSON -> ok, one call", async () => {
    serveSeq([msg("end_turn", '{"verdict":"done"}')]);
    expect(await judgeJsonOutcome(base)).toEqual({ kind: "ok", value: { verdict: "done" } });
    expect(seen.length).toBe(1);
  });

  test("max_tokens then ok: one retry with a larger max_tokens", async () => {
    serveSeq([msg("max_tokens", '{"verdi'), msg("end_turn", '{"verdict":"done"}')]);
    const r = await judgeJsonOutcome({ ...base, maxTokens: 1000, ledger: { lokiDir: dir, phase: "council" } });
    expect(r).toEqual({ kind: "ok", value: { verdict: "done" } });
    expect(seen.map((x) => x.body["max_tokens"])).toEqual([1000, 2000]);
    expect(ledgerOutcomes()).toEqual(["truncated", "ok"]);
  });

  test("max_tokens twice -> truncated after exactly one retry", async () => {
    serveSeq([msg("max_tokens", '{"verdi')]);
    expect(await judgeJsonOutcome({ ...base, maxTokens: 1000 })).toEqual({ kind: "truncated" });
    expect(seen.length).toBe(2);
    expect(await judgeJson({ ...base, maxTokens: 1000 })).toBeNull();
  });

  test("refusal then ok: retried once with server-side fallback body and beta header", async () => {
    serveStub([msg("refusal", "", { stop_details: { category: "cyber" } }), msg("end_turn", '{"verdict":"done"}')]);
    const r = await judgeJsonOutcome(base);
    expect(r).toEqual({ kind: "ok", value: { verdict: "done" } });
    expect(seen.length).toBe(2);
    expect(seen[0]!.body["fallbacks"]).toBeUndefined();
    expect(seen[1]!.body["fallbacks"]).toBe("default");
    expect(seen[1]!.beta).toContain("server-side-fallback-2026-07-01");
  });

  test("refusal that fallback also refuses -> refused with category, two calls", async () => {
    serveStub([msg("refusal", "", { stop_details: { category: "cyber" } })]);
    expect(await judgeJsonOutcome({ ...base, ledger: { lokiDir: dir, phase: "council" } })).toEqual({ kind: "refused", category: "cyber" });
    expect(seen.length).toBe(2);
    expect(ledgerOutcomes()).toEqual(["refused:cyber", "refused:cyber"]);
  });

  test("refusal on Haiku 5.5 -> refused, no fallback attempt", async () => {
    serveSeq([msg("refusal", "")]);
    expect(await judgeJsonOutcome({ ...base, model: "claude-haiku-5-5" })).toEqual({ kind: "refused", category: null });
    expect(seen.length).toBe(1);
  });

  test("refusal on a model outside the allowlist (older or unknown) -> refused, never sends fallbacks", async () => {
    for (const model of ["claude-opus-4-8", "claude-sonnet-4-5", "some-gateway-model"]) {
      seen.length = 0;
      serveStub([msg("refusal", "")]);
      expect(await judgeJsonOutcome({ ...base, model })).toEqual({ kind: "refused", category: null });
      expect(seen.length).toBe(1);
      expect(seen[0]!.body["fallbacks"]).toBeUndefined();
    }
  });

  test("B1: 400 and 413 prompt-too-long map to context_exceeded, ledger names it; other 400 stays transport", async () => {
    for (const status of [400, 413]) {
      seen.length = 0;
      serveStub([apiError(status, `${status} prompt is too long: 250000 tokens > 200000 maximum`)]);
      expect(await judgeJsonOutcome({ ...base, ledger: { lokiDir: dir, phase: "council" } })).toEqual({ kind: "context_exceeded" });
      expect(seen.length).toBe(1);
    }
    expect(ledgerOutcomes()).toEqual(["context_exceeded", "context_exceeded"]);
    serveStub([apiError(400, "400 invalid x-api-key shape")]);
    expect(await judgeJsonOutcome(base)).toEqual({ kind: "transport" });
    serveStub([apiError(500, "prompt is too long")]);
    expect(await judgeJsonOutcome(base)).toEqual({ kind: "transport" });
  });

  test("B2: fallback retry throwing after a refusal returns the original refused outcome", async () => {
    serveStub([msg("refusal", "", { stop_details: { category: "cyber" } }), new Error("fallback hop failed")]);
    expect(await judgeJsonOutcome({ ...base, ledger: { lokiDir: dir, phase: "council" } })).toEqual({ kind: "refused", category: "cyber" });
    expect(seen.length).toBe(2);
    expect(ledgerOutcomes()).toEqual(["refused:cyber", "refused:cyber"]);
  });

  test("B2: no fallback when the base URL is not the default endpoint (client or env)", async () => {
    serveStub([msg("refusal", "", { stop_details: { category: "cyber" } })], "http://127.0.0.1:9999");
    expect(await judgeJsonOutcome(base)).toEqual({ kind: "refused", category: "cyber" });
    expect(seen.length).toBe(1);
    seen.length = 0;
    serveSeq([msg("refusal", "", { stop_details: { category: "cyber" } })]);
    expect(await judgeJsonOutcome(base)).toEqual({ kind: "refused", category: "cyber" });
    expect(seen.length).toBe(1);
    expect(seen[0]!.body["fallbacks"]).toBeUndefined();
  });

  test("default endpoint with a trailing slash still gets the fallback", async () => {
    serveStub([msg("refusal", "", { stop_details: { category: "cyber" } }), msg("end_turn", '{"verdict":"done"}')], "https://api.anthropic.com/");
    expect((await judgeJsonOutcome(base)).kind).toBe("ok");
    expect(seen.length).toBe(2);
  });

  test("nit: only end_turn and stop_sequence are ok; tool_use, pause_turn, null with text are malformed", async () => {
    serveStub([msg("stop_sequence", '{"verdict":"done"}')]);
    expect((await judgeJsonOutcome(base)).kind).toBe("ok");
    for (const sr of ["tool_use", "pause_turn", null as unknown as string]) {
      serveStub([msg(sr, '{"verdict":"done"}')]);
      expect(await judgeJsonOutcome(base)).toEqual({ kind: "malformed" });
      expect(await judgeTextOutcome({ prompt: "p", model: base.model })).toEqual({ kind: "malformed" });
    }
  });

  test("nit: the ledger prices msg.model, so a fallback hop is billed at the fallback model", async () => {
    serveStub([msg("refusal", "", { model: "claude-sonnet-5-5", stop_details: { category: "cyber" } }), msg("end_turn", '{"verdict":"done"}', { model: "claude-opus-4-8" })]);
    await judgeJsonOutcome({ ...base, ledger: { lokiDir: dir, phase: "council" } });
    const p = join(dir, "metrics", "child-sessions.jsonl");
    const models = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)["model"]);
    expect(models).toEqual(["claude-sonnet-5-5", "claude-opus-4-8"]);
  });

  test("nit: no fallback for categories the fallback model does not cover", async () => {
    const cases: [string, string, number][] = [
      ["claude-sonnet-5-5", "bio", 1],
      ["claude-sonnet-5-5", "reasoning_extraction", 1],
      ["claude-sonnet-5-5", "general_harms", 1],
      ["claude-sonnet-5-5", "frontier_llm", 2],
      ["claude-sonnet-5-5", "cyber", 2],
      ["claude-opus-5-5", "reasoning_extraction", 1],
      ["claude-opus-5-5", "bio", 2],
      ["claude-fable-5-1", "bio", 2],
    ];
    for (const [model, category, calls] of cases) {
      seen.length = 0;
      serveStub([msg("refusal", "", { stop_details: { category } })]);
      expect(await judgeJsonOutcome({ ...base, model })).toEqual({ kind: "refused", category });
      expect([model, category, seen.length]).toEqual([model, category, calls]);
    }
  });

  test("model_context_window_exceeded -> context_exceeded, no retry", async () => {
    serveSeq([msg("model_context_window_exceeded", "")]);
    expect(await judgeJsonOutcome(base)).toEqual({ kind: "context_exceeded" });
    expect(seen.length).toBe(1);
  });

  test("end_turn with prose or empty text -> malformed", async () => {
    serveSeq([msg("end_turn", "sorry, prose")]);
    expect(await judgeJsonOutcome(base)).toEqual({ kind: "malformed" });
    serveSeq([msg("end_turn", "")]);
    expect(await judgeTextOutcome({ prompt: "p", model: base.model })).toEqual({ kind: "malformed" });
  });

  test("HTTP error -> transport, ledger names it", async () => {
    srv = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } }) });
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${srv.port}`;
    __resetSdkClientForTests();
    expect(await judgeJsonOutcome({ ...base, ledger: { lokiDir: dir, phase: "council" } })).toEqual({ kind: "transport" });
    expect(ledgerOutcomes()).toEqual(["transport"]);
  });

  test("CLI entry names the cause on stderr and still exits 1 with no stdout", async () => {
    serveSeq([msg("model_context_window_exceeded", "")]);
    const pf = join(dir, "p.txt"), sf = join(dir, "s.json");
    writeFileSync(pf, "prompt"); writeFileSync(sf, JSON.stringify(SCHEMA));
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => { errs.push(String(c)); return true; };
    try {
      expect(await runInternalSdkJudge(["--prompt-file", pf, "--schema-file", sf, "--model", base.model])).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
    expect(errs.join("")).toContain("outcome=context_exceeded");
  });
});

describe("#261 judge max_tokens by effort, thinking, streaming", () => {
  const sc = SCHEMA as unknown as Record<string, unknown>;
  const base = { prompt: "p", model: "claude-sonnet-4-5" };
  const msg = { stop_reason: "end_turn", content: [{ type: "text", text: '{"verdict":"done"}' }], usage: { input_tokens: 5, output_tokens: 7 } };
  function mock() {
    const seen: { via: string; body: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
    __setSdkClientForTests({
      messages: {
        create: async (body: Record<string, unknown>, opts: Record<string, unknown>) => (seen.push({ via: "create", body, opts }), msg),
        stream: (body: Record<string, unknown>, opts: Record<string, unknown>) => (seen.push({ via: "stream", body, opts }), { finalMessage: async () => msg }),
      },
    });
    return seen;
  }
  beforeEach(() => { process.env["ANTHROPIC_API_KEY"] = "k"; });

  test("table: low 4096, medium 8192, high 16384, xhigh and max 64000", () => {
    expect(EFFORT_MAX_TOKENS).toEqual({ low: 4096, medium: 8192, high: 16384, xhigh: 64000, max: 64000 });
  });
  test("xhigh without maxTokens sends max_tokens 64000 via stream().finalMessage()", async () => {
    const seen = mock();
    expect(await judgeJson({ ...base, schema: sc, effort: "xhigh" })).toEqual({ verdict: "done" });
    expect(seen.map((s) => s.via)).toEqual(["stream"]);
    expect(seen[0]!.body["max_tokens"]).toBe(64000);
    expect(seen[0]!.opts["timeout"]).toBe(120_000);
  });
  test("judgeText sizes and streams the same way", async () => {
    const seen = mock();
    await judgeText({ ...base, effort: "max" });
    expect([seen[0]!.via, seen[0]!.body["max_tokens"]]).toEqual(["stream", 64000]);
  });
  test("low effort uses create at 4096; high 16384 stays on create; no effort keeps 4096", async () => {
    const seen = mock();
    await judgeJson({ ...base, schema: sc, effort: "low" });
    await judgeJson({ ...base, schema: sc, effort: "high" });
    await judgeJson({ ...base, schema: sc });
    expect(seen.map((s) => [s.via, s.body["max_tokens"]])).toEqual([["create", 4096], ["create", 16384], ["create", 4096]]);
  });
  test("an explicit maxTokens wins over the effort table and picks the path", async () => {
    const seen = mock();
    await judgeJson({ ...base, schema: sc, effort: "xhigh", maxTokens: 1000 });
    await judgeJson({ ...base, schema: sc, effort: "low", maxTokens: 30000 });
    expect(seen.map((s) => [s.via, s.body["max_tokens"]])).toEqual([["create", 1000], ["stream", 30000]]);
  });
  test("thinking reaches the request body unchanged; unset sends no thinking key", async () => {
    const seen = mock();
    await judgeJson({ ...base, schema: sc, thinking: { type: "disabled" } });
    await judgeText({ ...base, thinking: { type: "adaptive" } });
    await judgeJson({ ...base, schema: sc });
    expect(seen[0]!.body["thinking"]).toEqual({ type: "disabled" });
    expect(seen[1]!.body["thinking"]).toEqual({ type: "adaptive" });
    expect("thinking" in seen[2]!.body).toBe(false);
  });
  test("thinking clamp (#314): opus-5 disabled at max is sent as adaptive and the ledger line names the clamp; at high it is sent as asked", async () => {
    const seen = mock();
    const dir = mkdtempSync(join(tmpdir(), "sdkj314-"));
    try {
      const m = { prompt: "p", model: "claude-opus-5", schema: sc };
      await judgeJson({ ...m, effort: "max", thinking: { type: "disabled" }, ledger: { lokiDir: dir, phase: "p" } });
      await judgeJson({ ...m, effort: "high", thinking: { type: "disabled" }, ledger: { lokiDir: dir, phase: "p" } });
      expect(seen[0]!.body["thinking"]).toEqual({ type: "adaptive" });
      expect(seen[1]!.body["thinking"]).toEqual({ type: "disabled" });
      const recs = readFileSync(join(dir, "metrics", "child-sessions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(recs[0].thinking_clamp).toBe("disabled->adaptive@max (max high)");
      expect("thinking_clamp" in recs[1]).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("thinking clamp (#314): judgeText clamps too, and the CLI accepts a clampable pair instead of exiting 2", async () => {
    const seen = mock();
    await judgeText({ prompt: "p", model: "claude-haiku-5-5", effort: "xhigh", thinking: { type: "disabled" } });
    expect(seen[0]!.body["thinking"]).toEqual({ type: "adaptive" });
    const d = mkdtempSync(join(tmpdir(), "sdkj314c-"));
    const pf = join(d, "p.txt");
    writeFileSync(pf, "p");
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = () => true;
    try {
      expect(await runInternalSdkText(["--prompt-file", pf, "--model", "claude-opus-5", "--effort", "max", "--thinking", "disabled"])).toBe(0);
      expect(seen[1]!.body["thinking"]).toEqual({ type: "adaptive" });
    } finally {
      process.stderr.write = orig;
      rmSync(d, { recursive: true, force: true });
    }
  });
  test("thinking substitute (#314): sonnet-5-5 disabled is sent as between_tools, adaptive above high, and the ledger names it", async () => {
    const seen = mock();
    const dir = mkdtempSync(join(tmpdir(), "sdkj314s-"));
    try {
      const m = { prompt: "p", model: "claude-sonnet-5-5", schema: sc, thinking: { type: "disabled" as const }, ledger: { lokiDir: dir, phase: "p" } };
      await judgeJson({ ...m, effort: "high" });
      await judgeJson({ ...m, effort: "max" });
      await judgeJson({ ...m });
      expect(seen[0]!.body["thinking"]).toEqual({ type: "between_tools" });
      expect(seen[1]!.body["thinking"]).toEqual({ type: "adaptive" });
      expect(seen[2]!.body["thinking"]).toEqual({ type: "between_tools" });
      const recs = readFileSync(join(dir, "metrics", "child-sessions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(recs[0].thinking_clamp).toBe("disabled->between_tools@high (max high)");
      expect(recs[1].thinking_clamp).toBe("disabled->adaptive@max (max high)");
      expect(recs[2].thinking_clamp).toBe("disabled->between_tools@default (max high)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("thinking substitute (#314): the CLI accepts sonnet-5-5 disabled at max and an invalid value names the catalog limit", async () => {
    const seen = mock();
    const d = mkdtempSync(join(tmpdir(), "sdkj314u-"));
    const pf = join(d, "p.txt");
    writeFileSync(pf, "p");
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => { errs.push(c); return true; };
    try {
      expect(await runInternalSdkText(["--prompt-file", pf, "--model", "claude-sonnet-5-5", "--effort", "max", "--thinking", "disabled"])).toBe(0);
      expect(seen[0]!.body["thinking"]).toEqual({ type: "adaptive" });
      expect(await runInternalSdkText(["--prompt-file", pf, "--model", "claude-opus-5", "--thinking", "bogus"])).toBe(2);
      expect(errs.join("")).toContain("for claude-opus-5 disabled is sent as adaptive above --effort high");
      expect(errs.join("")).not.toContain("cannot combine");
    } finally {
      process.stderr.write = orig;
      rmSync(d, { recursive: true, force: true });
    }
  });
  test("the usage note carries output_tokens and max_tokens", async () => {
    mock();
    const dir = mkdtempSync(join(tmpdir(), "sdkj261-"));
    try {
      await judgeJson({ ...base, schema: sc, effort: "xhigh", ledger: { lokiDir: dir, phase: "p" } });
      const rec = JSON.parse(readFileSync(join(dir, "metrics", "child-sessions.jsonl"), "utf8").trim().split("\n")[0]!);
      expect(rec.output_tokens).toBe(7);
      expect(rec.max_tokens).toBe(64000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("parseThinking: absent, keywords, anything else rejected", () => {
    expect(parseThinking(undefined)).toBeUndefined();
    expect(parseThinking("disabled")).toEqual({ type: "disabled" });
    expect(parseThinking("adaptive")).toEqual({ type: "adaptive" });
    expect(parseThinking('{"type":"enabled","budget_tokens":2048}')).toBeNull();
    expect(parseThinking("bogus")).toBeNull();
    expect(parseThinking("[1]")).toBeNull();
  });
  test("disabled thinking with xhigh or max effort exits 2 on both CLIs; with high it is accepted", async () => {
    const d = mkdtempSync(join(tmpdir(), "sdkj261t-"));
    const pf = join(d, "p.txt"), sf = join(d, "s.json");
    writeFileSync(pf, "p"); writeFileSync(sf, JSON.stringify(SCHEMA));
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = () => true;
    try {
      for (const e of ["xhigh", "max"]) {
        expect(await runInternalSdkJudge(["--prompt-file", pf, "--schema-file", sf, "--model", base.model, "--effort", e, "--thinking", "disabled"])).toBe(2);
        expect(await runInternalSdkText(["--prompt-file", pf, "--model", base.model, "--effort", e, "--thinking", "disabled"])).toBe(2);
      }
      expect(await runInternalSdkJudge(["--prompt-file", pf, "--schema-file", sf, "--model", base.model, "--thinking", "{\"type\":\"enabled\"}"])).toBe(2);
    } finally {
      process.stderr.write = orig;
      rmSync(d, { recursive: true, force: true });
    }
  });
  test("the stream path passes an AbortSignal; the create path does not", async () => {
    const seen = mock();
    await judgeJson({ ...base, schema: sc, effort: "xhigh" });
    await judgeJson({ ...base, schema: sc, effort: "low" });
    expect(seen[0]!.opts["signal"]).toBeInstanceOf(AbortSignal);
    expect("signal" in seen[1]!.opts).toBe(false);
  });
  test("a high-effort truncation retries up to the table ceiling (16384 -> 32768)", async () => {
    const calls: number[] = [];
    __setSdkClientForTests({
      messages: {
        create: async (b: Record<string, unknown>) => {
          calls.push(b["max_tokens"] as number);
          return calls.length === 1 ? { stop_reason: "max_tokens", content: [], usage: {} } : msg;
        },
        stream: (b: Record<string, unknown>) => ({ finalMessage: async () => { calls.push(b["max_tokens"] as number); return msg; } }),
      },
    });
    expect(await judgeJson({ ...base, schema: sc, effort: "high" })).toEqual({ verdict: "done" });
    expect(calls).toEqual([16384, 32768]);
  });
  test("xhigh truncation retries at the 64000 ceiling only when below it", async () => {
    const calls: number[] = [];
    __setSdkClientForTests({
      messages: {
        create: async () => { throw new Error("unused"); },
        stream: (b: Record<string, unknown>) => ({ finalMessage: async () => { calls.push(b["max_tokens"] as number); return { stop_reason: "max_tokens", content: [], usage: {} }; } }),
      },
    });
    expect((await judgeJsonOutcome({ ...base, schema: sc, effort: "xhigh", maxTokens: 40000 })).kind).toBe("truncated");
    expect(calls).toEqual([40000, 64000]);
    calls.length = 0;
    await judgeJsonOutcome({ ...base, schema: sc, effort: "xhigh" });
    expect(calls).toEqual([64000]);
  });
  test("the fallback retry streams with its beta header and the signal", async () => {
    const seen: { via: string; body: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
    const refusal = { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [], usage: {} };
    __setSdkClientForTests({
      baseURL: "https://api.anthropic.com",
      messages: {
        create: async () => { throw new Error("unused"); },
        stream: (body: Record<string, unknown>, opts: Record<string, unknown>) => (seen.push({ via: "stream", body, opts }), { finalMessage: async () => (seen.length === 1 ? refusal : msg) }),
      },
    });
    expect(await judgeJson({ ...base, model: "claude-sonnet-5-5", schema: sc, effort: "xhigh" })).toEqual({ verdict: "done" });
    expect(seen.map((x) => x.via)).toEqual(["stream", "stream"]);
    expect(seen[1]!.body["fallbacks"]).toBe("default");
    expect(String((seen[1]!.opts["headers"] as Record<string, string>)["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(seen[1]!.opts["signal"]).toBeInstanceOf(AbortSignal);
  });
  test("a refusal with a null category still takes the fallback", async () => {
    const bodies: Record<string, unknown>[] = [];
    __setSdkClientForTests({
      baseURL: "https://api.anthropic.com",
      messages: {
        create: async (body: Record<string, unknown>) => (bodies.push(body), bodies.length === 1 ? { stop_reason: "refusal", stop_details: null, content: [], usage: {} } : msg),
      },
    });
    expect(await judgeJson({ ...base, model: "claude-sonnet-5-5", schema: sc })).toEqual({ verdict: "done" });
    expect(bodies.length).toBe(2);
    expect(bodies[1]!["fallbacks"]).toBe("default");
  });
  test("a non-static schema returns malformed before any API call", async () => {
    let calls = 0;
    __setSdkClientForTests({
      messages: {
        create: async () => { calls++; return msg; },
        stream: () => { calls++; return { finalMessage: async () => msg }; },
      },
    });
    const bad = { type: "object", properties: { verdict: { type: "string", enum: ["zz-run-data-not-in-static-schemas"] } } };
    expect(await judgeJsonOutcome({ ...base, schema: bad })).toEqual({ kind: "malformed" });
    expect(await judgeJsonOutcome({ ...base, schema: bad, effort: "xhigh" })).toEqual({ kind: "malformed" });
    expect(calls).toBe(0);
  });
  test("a failed call records max_tokens on the failure ledger line", async () => {
    __setSdkClientForTests({ messages: { create: async () => { throw new Error("boom"); }, stream: () => { throw new Error("boom"); } } });
    const dir = mkdtempSync(join(tmpdir(), "sdkj261f-"));
    try {
      await judgeJson({ ...base, schema: sc, effort: "xhigh", ledger: { lokiDir: dir, phase: "p" } });
      const rec = JSON.parse(readFileSync(join(dir, "metrics", "child-sessions.jsonl"), "utf8").trim().split("\n")[0]!);
      expect([rec.outcome, rec.max_tokens]).toEqual(["transport", 64000]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
