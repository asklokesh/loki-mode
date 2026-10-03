import { describe, expect, test } from "bun:test";
import { handleSlackEvent, newInboundState, parseMention, signSlackBody, slackInboundEnabled, threadKey, verifySlackSignature, type InboundDeps } from "../../src/features/slack_inbound.ts";

const SECRET = "test-signing-secret", NOW = 1_700_000_000, BODY = '{"type":"event_callback"}';

describe("verifySlackSignature", () => {
  test("accepts a good signature", () => {
    expect(verifySlackSignature(SECRET, String(NOW), BODY, signSlackBody(SECRET, String(NOW), BODY), NOW + 10)).toBe(true);
  });
  test("rejects a bad signature, wrong secret, tampered body", () => {
    const sig = signSlackBody(SECRET, String(NOW), BODY);
    expect(verifySlackSignature(SECRET, String(NOW), BODY, "v0=deadbeef", NOW)).toBe(false);
    expect(verifySlackSignature("other", String(NOW), BODY, sig, NOW)).toBe(false);
    expect(verifySlackSignature(SECRET, String(NOW), BODY + "x", sig, NOW)).toBe(false);
    expect(verifySlackSignature(SECRET, String(NOW), BODY, "", NOW)).toBe(false);
  });
  test("rejects a stale timestamp (older than 5 minutes)", () => {
    const sig = signSlackBody(SECRET, String(NOW), BODY);
    expect(verifySlackSignature(SECRET, String(NOW), BODY, sig, NOW + 301)).toBe(false);
    expect(verifySlackSignature(SECRET, String(NOW), BODY, sig, NOW + 299)).toBe(true);
  });
});

describe("parseMention", () => {
  test("strips the bot mention and keeps the task", () => {
    expect(parseMention("<@U0BOT> owner/repo#12")).toBe("owner/repo#12");
    expect(parseMention("<@U0BOT>  fix the &lt;login&gt; bug")).toBe("fix the <login> bug");
  });
  test("returns null when only a mention", () => { expect(parseMention("<@U0BOT>")).toBeNull(); });
  test("flag is off by default", () => {
    expect(slackInboundEnabled({})).toBe(false);
    expect(slackInboundEnabled({ LOKI_SLACK_INBOUND: "1" })).toBe(true);
  });
});

function fake(code: number, question?: string) {
  const posts: string[] = [], tasks: string[] = [];
  const deps: InboundDeps = {
    async startRun(task) { tasks.push(task); return { runId: `e10-${tasks.length}`, done: Promise.resolve({ code, question }) }; },
    async post(_c, _t, text) { posts.push(text); },
  };
  return { deps, posts, tasks };
}
const mention = (id: string, text: string, ts: string) => ({ type: "event_callback", event_id: id, event: { type: "app_mention", channel: "C1", user: "U1", text, ts } });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("thread mapping", () => {
  test("mention starts a run mapped to the thread and replies with the run id", async () => {
    const st = newInboundState(), f = fake(0);
    expect((await handleSlackEvent(st, f.deps, mention("E1", "<@UB> do the thing", "100.1"))).body).toBe("started");
    await tick();
    expect(f.tasks).toEqual(["do the thing"]);
    expect(st.threads.get(threadKey("C1", "100.1"))?.runId).toBe("e10-1");
    expect(f.posts[0]).toContain("e10-1");
  });
  test("duplicate event ids are ignored (Slack retries)", async () => {
    const st = newInboundState(), f = fake(0);
    await handleSlackEvent(st, f.deps, mention("E1", "<@UB> a", "1.1"));
    expect((await handleSlackEvent(st, f.deps, mention("E1", "<@UB> a", "1.1"))).body).toBe("duplicate");
  });
  test("bot messages are ignored", async () => {
    const st = newInboundState(), f = fake(0);
    const p = mention("E2", "<@UB> a", "1.1");
    (p.event as Record<string, unknown>).bot_id = "B1";
    expect((await handleSlackEvent(st, f.deps, p)).body).toBe("ignored");
  });
  test("BLOCKED posts the question in-thread and a thread reply becomes the answer", async () => {
    const st = newInboundState(), f = fake(4, "which db?");
    await handleSlackEvent(st, f.deps, mention("E3", "<@UB> build it", "200.1"));
    await tick();
    expect(st.threads.get(threadKey("C1", "200.1"))?.state).toBe("blocked");
    expect(f.posts.some((p) => p.includes("BLOCKED") && p.includes("which db?"))).toBe(true);
    const reply = { type: "event_callback", event_id: "E4", event: { type: "message", channel: "C1", user: "U1", text: "use postgres", ts: "200.2", thread_ts: "200.1" } };
    expect((await handleSlackEvent(st, f.deps, reply)).body).toBe("answer");
    await tick();
    expect(f.tasks[1]).toContain("use postgres");
    expect(f.tasks[1]).toContain("build it");
  });
  test("url_verification echoes the challenge", async () => {
    expect((await handleSlackEvent(newInboundState(), fake(0).deps, { type: "url_verification", challenge: "abc" })).body).toBe("abc");
  });
});
