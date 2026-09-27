// E-28: Slack notify adapter (docs/v10/ENGINE.md section 16, section 13).
//
// Green: a local HTTP fixture receives exactly the 5-line summary; no call
// is made when the webhook is unset.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSlackAdapter } from "../../src/engine10/adapters/slack.ts";
import { formatSummary, type SummaryInput } from "../../src/engine10/output.ts";

let lastBody: string | null = null;
let requestCount = 0;
let server: ReturnType<typeof Bun.serve> | null = null;
let webhookUrl = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requestCount++;
      lastBody = await req.text();
      return new Response("ok", { status: 200 });
    },
  });
  webhookUrl = `http://127.0.0.1:${server.port}/webhook`;
});

afterAll(() => {
  server?.stop(true);
});

const SUMMARY: SummaryInput = {
  pr: { url: "https://github.com/acme/widgets/pull/42", draft: false },
  verdict: "VERIFIED",
  notProven: [],
  flaky: [],
  cost: { usd: 1.23, provider: "claude", tokens: 45000 },
  wallS: 611,
  stages: [
    { label: "intake", seconds: 11 },
    { label: "plan+wall", seconds: 600 },
  ],
};

describe("createSlackAdapter", () => {
  test("posts exactly the 5-line summary as the request body", async () => {
    lastBody = null;
    requestCount = 0;
    const adapter = createSlackAdapter(webhookUrl);
    await adapter.notify!(SUMMARY);
    expect(requestCount).toBe(1);
    const parsed = JSON.parse(lastBody!) as { text: string };
    expect(parsed.text).toBe(formatSummary(SUMMARY));
    expect(parsed.text.split("\n")).toHaveLength(5);
  });

  test("makes no call when the webhook is unset", async () => {
    requestCount = 0;
    const adapter = createSlackAdapter(undefined);
    await adapter.notify!(SUMMARY);
    expect(requestCount).toBe(0);
  });

  test("makes no call when the webhook is an empty string", async () => {
    requestCount = 0;
    const adapter = createSlackAdapter("");
    await adapter.notify!(SUMMARY);
    expect(requestCount).toBe(0);
  });

  test("name is slack", () => {
    expect(createSlackAdapter(webhookUrl).name).toBe("slack");
  });
});
