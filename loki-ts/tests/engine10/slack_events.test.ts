// D51-A4: pr_opened / blocked / finished post well-formed Slack payloads to a local mock webhook.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { notifyEvent, signWebhookBody, webhookPayload } from "../../src/util/slack_events.ts";

const bodies: any[] = [];
let server: ReturnType<typeof Bun.serve>;
let url = "";
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { bodies.push(JSON.parse(await req.text())); return new Response("ok"); } });
  url = `http://127.0.0.1:${server.port}/services/T000/B000/SECRETTOKEN`;
});
afterAll(() => server.stop(true));
const field = (b: any, t: string) => b.attachments[0].fields.find((f: any) => f.title === t)?.value;

describe("slack events", () => {
  test("pr_opened carries repo, issue, PR url, outcome", async () => {
    bodies.length = 0;
    await notifyEvent({ LOKI_SLACK_WEBHOOK_URL: url }, "pr_opened", { repo: "acme/widgets", issue: "acme/widgets#7", prUrl: "https://github.com/acme/widgets/pull/9", outcome: "VERIFIED" });
    expect(bodies).toHaveLength(1);
    const b = bodies[0];
    expect(b.attachments[0].title).toBe("Loki Mode: PR opened");
    expect([field(b, "Repo"), field(b, "Issue"), field(b, "PR"), field(b, "Outcome")]).toEqual(["acme/widgets", "acme/widgets#7", "https://github.com/acme/widgets/pull/9", "VERIFIED"]);
  });
  test("blocked carries the one question; webhook var named by config", async () => {
    bodies.length = 0;
    await notifyEvent({ MY_HOOK: url, LOKI_SLACK_WEBHOOK_ENV: "MY_HOOK" }, "blocked", { repo: "acme/widgets", issue: "acme/widgets#7", question: "spec conflict: which API version?" });
    expect(bodies).toHaveLength(1);
    expect(field(bodies[0], "Question")).toBe("spec conflict: which API version?");
    expect(bodies[0].text).toContain("BLOCKED");
  });
  test("finished carries outcome, cost, time", async () => {
    bodies.length = 0;
    await notifyEvent({ LOKI_SLACK_WEBHOOK_URL: url }, "finished", { summary: "Outcome: VERIFIED", outcome: "VERIFIED", cost: "$1.50", time: "61s" });
    expect(bodies).toHaveLength(1);
    expect([field(bodies[0], "Outcome"), field(bodies[0], "Cost"), field(bodies[0], "Time")]).toEqual(["VERIFIED", "$1.50", "61s"]);
    expect(bodies[0].text).toBe("Outcome: VERIFIED\nreceipt (unattested)");
  });
  test("finished shows the stored receipt verdict, TAMPERED never VERIFIED, (unattested) when none", async () => {
    const run = async (receipt?: string) => { bodies.length = 0; await notifyEvent({ LOKI_SLACK_WEBHOOK_URL: url }, "finished", { summary: "Outcome: X", outcome: "VERIFIED", receipt }); return bodies[0]; };
    const ok = await run("VERIFIED"), bad = await run("TAMPERED"), none = await run(undefined);
    expect(field(ok, "Receipt")).toBe("VERIFIED");
    expect(field(bad, "Receipt")).toBe("TAMPERED");
    expect(JSON.stringify(bad)).not.toContain("Receipt\",\"value\":\"VERIFIED");
    expect(field(none, "Receipt")).toBe("(unattested)");
    expect(bad.text).toContain("receipt TAMPERED");
    expect(none.text).toContain("(unattested)");
  });
  test("no webhook set: nothing posted, no error", async () => {
    bodies.length = 0;
    await notifyEvent({}, "blocked", { question: "q" });
    await notifyEvent({ LOKI_SLACK_WEBHOOK_URL: "" }, "pr_opened", {});
    expect(bodies).toHaveLength(0);
  });
  test("a failed post never leaks the URL", async () => {
    const dead = "http://127.0.0.1:1/services/SECRETTOKEN";
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { writes.push(String(s)); return true; };
    try { await notifyEvent({ LOKI_SLACK_WEBHOOK_URL: dead }, "blocked", { question: "q" }); } finally { (process.stderr as any).write = orig; }
    expect(writes.join("")).toContain("slack notify failed");
    expect(writes.join("")).not.toContain("SECRETTOKEN");
  });
  test("negative notify timeout falls back to the default and the event still posts", async () => {
    const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { await new Promise((r) => setTimeout(r, 150)); bodies.push(JSON.parse(await req.text())); return new Response("ok"); } });
    try {
      for (const bad of ["-1", "-5000", "NaN", "0"]) {
        bodies.length = 0;
        await notifyEvent({ LOKI_SLACK_WEBHOOK_URL: `http://127.0.0.1:${slow.port}/x`, LOKI_E10_NOTIFY_TIMEOUT_MS: bad }, "blocked", { question: "q" });
        expect(bodies).toHaveLength(1);
      }
    } finally { slow.stop(true); }
  });
});

describe("signed webhook", () => {
  const hits: { body: string; sig: string | null }[] = [];
  let srv: ReturnType<typeof Bun.serve>;
  let hook = "";
  beforeAll(() => {
    srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { hits.push({ body: await req.text(), sig: req.headers.get("x-loki-signature") }); return new Response("ok"); } });
    hook = `http://127.0.0.1:${srv.port}/hook`;
  });
  afterAll(() => srv.stop(true));
  const verify = (secret: string, body: string, sig: string | null) => sig === `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const events = ["pr_opened", "blocked", "finished", "budget", "stuck"] as const;

  test("each event carries schema_version 1 and a signature the secret verifies", async () => {
    for (const ev of events) {
      hits.length = 0;
      await notifyEvent({ LOKI_WEBHOOK_URL: hook, LOKI_WEBHOOK_SECRET: "s3cret" }, ev, { repo: "acme/widgets", outcome: "VERIFIED", stage: "verify" });
      expect(hits).toHaveLength(1);
      const b = JSON.parse(hits[0]!.body);
      expect(b.schema_version).toBe(1);
      expect(b.event).toBe(ev);
      expect(verify("s3cret", hits[0]!.body, hits[0]!.sig)).toBe(true);
    }
  });
  test("a wrong secret or a tampered body fails verification", async () => {
    hits.length = 0;
    await notifyEvent({ LOKI_WEBHOOK_URL: hook, LOKI_WEBHOOK_SECRET: "s3cret" }, "finished", { outcome: "VERIFIED" });
    const h = hits[0]!;
    expect(verify("other", h.body, h.sig)).toBe(false);
    expect(verify("s3cret", h.body.replace("VERIFIED", "FAILED"), h.sig)).toBe(false);
  });
  test("no secret means no request is attempted, even with a URL", async () => {
    hits.length = 0;
    const realFetch = globalThis.fetch, orig = process.stderr.write.bind(process.stderr);
    let attempts = 0;
    const writes: string[] = [];
    (globalThis as any).fetch = (...a: any[]) => { attempts++; return (realFetch as any)(...a); };
    (process.stderr as any).write = (c: any) => { writes.push(String(c)); return true; };
    try { await notifyEvent({ LOKI_WEBHOOK_URL: hook }, "finished", { outcome: "VERIFIED" }); }
    finally { (globalThis as any).fetch = realFetch; (process.stderr as any).write = orig; }
    expect(attempts).toBe(0);
    expect(writes.join("")).toBe("");
    expect(hits).toHaveLength(0);
  });
  test("payload excludes prompt-bearing text and paths; the secret never reaches stderr", () => {
    const p = JSON.stringify(webhookPayload("blocked", { question: "SECRET PROMPT TEXT", summary: "SUMMARY /Users/x/proj", action: "do /tmp/y", outcome: "BLOCKED" }));
    expect(p).not.toContain("PROMPT");
    expect(p).not.toContain("/Users");
    expect(p).not.toContain("/tmp");
    expect(signWebhookBody("k", "{}")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
