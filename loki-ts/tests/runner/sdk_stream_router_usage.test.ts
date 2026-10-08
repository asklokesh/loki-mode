// R1-08: per-request size and advisor telemetry from the SDK stream. The advisor shape is the
// Anthropic SDK's BetaAdvisorMessageIterationUsage (usage.iterations[] entry with type
// 'advisor_message'); the Agent SDK 0.3.293 typings only expose the advisorModel option, so the
// fixture follows the @anthropic-ai/sdk beta typings.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSdkStream, type StreamMsg } from "../../src/runner/sdk_stream_parser.ts";
import { costTotalsOf, sumResultCosts } from "../../src/engine10/cost.ts";

let scratch: string;
const savedFlag = process.env["LOKI_ROUTER"];
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-r108-"));
  process.env["LOKI_ROUTER"] = "1"; // telemetry is gated on the router flag; the flag-off block below unsets it
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (savedFlag === undefined) delete process.env["LOKI_ROUTER"]; else process.env["LOKI_ROUTER"] = savedFlag;
});

const ctx = () => ({ cwd: scratch, iteration: "7", hookEventsEnabled: true, write: (_s: string) => {} });
const costFile = () => join(scratch, ".loki", "metrics", "result-cost-7.json");

const advisor = (i: number, o: number) => ({
  type: "advisor_message", model: "claude-opus-4-7", input_tokens: i, output_tokens: o,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null,
});

const stream = (): StreamMsg[] => [
  { type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 2000, output_tokens: 50, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 } } },
  // growing snapshot of m1 must not double count
  { type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 2000, output_tokens: 80, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 } } },
  { type: "assistant", message: { id: "m2", content: [], usage: {
    input_tokens: 20000, output_tokens: 400, cache_read_input_tokens: 90000, cache_creation_input_tokens: 10000,
    iterations: [
      { type: "message", input_tokens: 20000, output_tokens: 400, cache_read_input_tokens: 90000, cache_creation_input_tokens: 10000 },
      advisor(30000, 700),
    ] } } },
  { type: "result", subtype: "success", is_error: false, total_cost_usd: 1.5, session_id: "s",
    usage: { input_tokens: 22000, output_tokens: 480, cache_read_input_tokens: 100000, cache_creation_input_tokens: 10000 } },
];

describe("R1-08 router usage telemetry", () => {
  test("120K request and one advisor call are recorded in the result-cost file", async () => {
    await consumeSdkStream(stream(), ctx(), () => "2026-10-07T00:00:00.000Z");
    const rec = JSON.parse(readFileSync(costFile(), "utf8"));
    expect(rec.requests_total).toBe(2);
    expect(rec.requests_over_100k).toBe(1);
    expect(rec.max_request_tokens).toBe(120000);
    expect(rec.over_100k_input_tokens).toBe(120000);
    expect(rec.over_100k_output_tokens).toBe(400);
    expect(rec.advisor_calls).toBe(1);
    expect(rec.advisor_input_tokens).toBe(30000);
    expect(rec.advisor_output_tokens).toBe(700);
    // existing keys unchanged
    expect(rec.total_cost_usd).toBe(1.5);
    expect(rec.input_tokens).toBe(22000);
  });

  test("exactly 100000 is not over 100K", async () => {
    const msgs: StreamMsg[] = [
      { type: "assistant", message: { id: "a", content: [], usage: { input_tokens: 100000, output_tokens: 1 } } },
      { type: "result", subtype: "success", total_cost_usd: 0.1, usage: { input_tokens: 100000, output_tokens: 1 } },
    ];
    await consumeSdkStream(msgs, ctx(), () => "t");
    const rec = JSON.parse(readFileSync(costFile(), "utf8"));
    expect(rec.requests_total).toBe(1);
    expect(rec.requests_over_100k).toBe(0);
    expect(rec.advisor_calls).toBe(0);
  });

  test("sumResultCosts carries the fields across sessions; old files sum to zero", () => {
    mkdirSync(join(scratch, "metrics"), { recursive: true });
    const base = { total_cost_usd: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
    writeFileSync(join(scratch, "metrics", "result-cost-1.json"), JSON.stringify({ ...base, requests_total: 3, requests_over_100k: 1, advisor_calls: 2, advisor_input_tokens: 10, advisor_output_tokens: 5, over_100k_input_tokens: 120000, over_100k_output_tokens: 9 }));
    writeFileSync(join(scratch, "metrics", "result-cost-2.json"), JSON.stringify(base));
    const c = sumResultCosts(scratch, ["1", "2"]);
    expect(c.router?.requests_total).toBe(3);
    expect(c.router?.requests_over_100k).toBe(1);
    expect(c.router?.advisor_calls).toBe(2);
    expect(c.router?.advisor_input_tokens).toBe(10);
    expect(c.router?.advisor_output_tokens).toBe(5);
    expect(c.router?.over_100k_input_tokens).toBe(120000);
  });
});

describe("R1-08 flag off is byte-identical to pre-router", () => {
  const PRE_KEYS = ["cache_creation_tokens", "cache_read_tokens", "input_tokens", "output_tokens", "total_cost_usd"];
  for (const v of [undefined, "0", "off", "false", "yes"]) {
    test(`LOKI_ROUTER=${v ?? "(unset)"}: no new result-cost keys, no CostResult.router`, async () => {
      if (v === undefined) delete process.env["LOKI_ROUTER"]; else process.env["LOKI_ROUTER"] = v;
      await consumeSdkStream(stream(), ctx(), () => "t");
      const rec = JSON.parse(readFileSync(costFile(), "utf8"));
      expect(Object.keys(rec).sort()).toEqual([...PRE_KEYS, "first_turn_prompt_tokens", "session_id"].sort()); // session_id: RECEIPT-TRUTH resume detection, router-independent
      // a file that already carries the keys (written under the flag) is not summed while the flag is off
      mkdirSync(join(scratch, "metrics"), { recursive: true });
      writeFileSync(join(scratch, "metrics", "result-cost-9.json"), JSON.stringify({ ...rec, requests_total: 5, advisor_calls: 2 }));
      const c = sumResultCosts(scratch, ["9"]);
      expect("router" in c).toBe(false);
      expect(Object.keys(c).sort()).toEqual(["cache_creation_seen", "cache_creation_tokens", "cache_read_seen", "cache_read_tokens", "input_tokens", "measuredCount", "missing", "model", "output_tokens", "partialUsd", "records", "source", "totalCount", "usd"].sort());
    });
  }
});

describe("RECEIPT-TRUTH: the result line's modelUsage, turns, 5m/1h split and resume id reach the result-cost file", () => {
  test("captured result shape", async () => {
    process.env["LOKI_E10_RESUME_SESSION"] = "S-prev";
    try {
      await consumeSdkStream([{ type: "result", subtype: "success", total_cost_usd: 1, duration_ms: 4000, num_turns: 5, session_id: "S-now",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 } },
        modelUsage: { "claude-sonnet-5-5": { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 5, costUSD: 1 } } } as StreamMsg], ctx(), () => "t");
    } finally { delete process.env["LOKI_E10_RESUME_SESSION"]; }
    const rec = JSON.parse(readFileSync(costFile(), "utf8"));
    expect(rec).toMatchObject({ num_turns: 5, session_id: "S-now", resumed_from: "S-prev", cache_creation_5m_tokens: 2, cache_creation_1h_tokens: 3 });
    expect(rec.model_usage["claude-sonnet-5-5"]).toEqual({ input_tokens: 10, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 5, cost_usd: 1 });
  });
});

describe("RECEIPT-TRUTH: absent cache usage keys stay absent through the real writer and reader", () => {
  test("usage without cache keys: file omits them and the receipt mapping reports unseen", async () => {
    await consumeSdkStream([{ type: "result", subtype: "success", total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } } as StreamMsg], ctx(), () => "t");
    const rec = JSON.parse(readFileSync(costFile(), "utf8"));
    expect("cache_read_tokens" in rec).toBe(false);
    expect("cache_creation_tokens" in rec).toBe(false);
    const t = costTotalsOf(sumResultCosts(scratch + "/.loki", ["7"]));
    expect(t.cacheReadSeen).toBe(false);
    expect(t.cacheCreationSeen).toBe(false);
  });
});
