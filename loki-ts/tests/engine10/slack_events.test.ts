// D51-A4: pr_opened / blocked / finished post well-formed Slack payloads to a local mock webhook.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { notifyEvent } from "../../src/e10ext/slack_events.ts";

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
    expect(bodies[0].text).toBe("Outcome: VERIFIED");
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
});
