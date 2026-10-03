import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { childEnv, findRepoRoot, REPO_ROOT, TASK_HINT, handleSlackEvent, makeSlackFetch, runSlackCli, slackPoster, spawnRunDeps, newInboundState, parseMention, signSlackBody, slackInboundEnabled, threadKey, verifySlackSignature, type InboundDeps } from "../../src/features/slack_inbound.ts";

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
  test("flag is on by default and LOKI_SLACK_INBOUND=0 disables", () => {
    expect(slackInboundEnabled({})).toBe(true);
    expect(slackInboundEnabled({ LOKI_SLACK_INBOUND: "1" })).toBe(true);
    expect(slackInboundEnabled({ LOKI_SLACK_INBOUND: "0" })).toBe(false);
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

describe("serve CLI (C6)", () => {
  const FAKE_TOKEN = "xoxb-fake-token", FAKE_SECRET = "fake-secret";
  const run = async (env: NodeJS.ProcessEnv) => {
    let served = 0, err = "";
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string) => { err += c; return true; }) as typeof process.stderr.write;
    try {
      const code = await runSlackCli(["serve", "--port", "3999"], env, { wait: false, serve: () => { served++; return { port: 3999 }; } });
      return { code, served, err };
    } finally { process.stderr.write = orig; }
  };
  test("no credentials: one line naming both, exit 2, nothing bound", async () => {
    const r = await run({});
    expect(r.code).toBe(2);
    expect(r.served).toBe(0);
    expect(r.err.trim().split("\n").length).toBe(1);
    expect(r.err).toContain("SLACK_BOT_TOKEN");
    expect(r.err).toContain("SLACK_SIGNING_SECRET");
  });
  test("LOKI_SLACK_INBOUND=0 exits 2 with the disabled line, nothing bound", async () => {
    const r = await run({ LOKI_SLACK_INBOUND: "0", SLACK_BOT_TOKEN: FAKE_TOKEN, SLACK_SIGNING_SECRET: FAKE_SECRET });
    expect(r.code).toBe(2);
    expect(r.served).toBe(0);
    expect(r.err).toContain("disabled");
  });
  test("credentials present binds once with no flag set", async () => {
    const r = await run({ SLACK_BOT_TOKEN: FAKE_TOKEN, SLACK_SIGNING_SECRET: FAKE_SECRET });
    expect(r.code).toBe(0);
    expect(r.served).toBe(1);
  });
});

describe("http handler", () => {
  const mk = (body: string, sig: string, ts: string) => new Request("http://x/", { method: "POST", body, headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig } });
  test("signed url_verification returns the challenge; bad signature is 401", async () => {
    const f = makeSlackFetch(SECRET, newInboundState(), fake(0).deps);
    const body = JSON.stringify({ type: "url_verification", challenge: "chal-1" }), ts = String(Math.floor(Date.now() / 1000));
    const ok = await f(mk(body, signSlackBody(SECRET, ts, body), ts));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("chal-1");
    expect((await f(mk(body, "v0=bad", ts))).status).toBe(401);
  });
});

describe("launcher and poster", () => {
  test("spawn uses bin/loki and strips both Slack secrets", async () => {
    const calls: { cmd: string; env: NodeJS.ProcessEnv }[] = [];
    const fakeSpawn = ((cmd: string, _a: string[], o: { env: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, env: o.env });
      return { pid: 1, on(ev: string, cb: (c: number) => void) { if (ev === "exit") cb(0); } };
    }) as never;
    const d = spawnRunDeps("/nonexistent-repo", { SLACK_BOT_TOKEN: "a", SLACK_SIGNING_SECRET: "b", PATH: "/usr/bin" }, undefined, fakeSpawn);
    const h = await d.startRun("task");
    await h.done;
    expect(calls[0]!.cmd.endsWith("bin/loki")).toBe(true);
    expect(calls[0]!.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(calls[0]!.env.SLACK_SIGNING_SECRET).toBeUndefined();
    expect(calls[0]!.env.LOKI_NO_BROWSER).toBe("1");
    expect(childEnv({ SLACK_BOT_TOKEN: "a" }).SLACK_BOT_TOKEN).toBeUndefined();
  });
  test("poster logs an HTTP failure as one redacted line", async () => {
    const lines: string[] = [];
    const post = slackPoster("xoxb-fake-token", (async () => new Response("no", { status: 500 })) as never, (l) => lines.push(l));
    await post("C1", "1.1", "hi");
    expect(lines).toEqual(["slack: post failed (HTTP 500)"]);
    const post2 = slackPoster("xoxb-fake-token", (async () => { throw new Error("boom xoxb-fake-token"); }) as never, (l) => lines.push(l));
    await post2("C1", "1.1", "hi");
    expect(lines.length).toBe(2);
    expect(lines[1]).not.toContain("xoxb-fake-token");
  });
});

describe("round 2 (D63-C6)", () => {
  test("default repo root and cliPath exist (src layout)", () => {
    expect(existsSync(`${REPO_ROOT}/bin/loki`)).toBe(true);
  });
  test("findRepoRoot resolves from a bundled dist directory", () => {
    expect(findRepoRoot(`${REPO_ROOT}/loki-ts/dist`)).toBe(REPO_ROOT);
  });
  test.each(["reset", "share", "-x", "--help", "status"])("single-token or flag mention %p is rejected with a hint and never starts a run", async (t) => {
    const st = newInboundState(), f = fake(0);
    expect((await handleSlackEvent(st, f.deps, mention(`R-${t}`, `<@UB> ${t}`, "300.1"))).body).toBe("rejected");
    expect(f.tasks).toEqual([]);
    expect(f.posts).toEqual([TASK_HINT]);
  });
  test("normal multi-word task still starts", async () => {
    const st = newInboundState(), f = fake(0);
    expect((await handleSlackEvent(st, f.deps, mention("R-ok", "<@UB> fix the login bug", "300.2"))).body).toBe("started");
    await tick();
    expect(f.tasks).toEqual(["fix the login bug"]);
  });
  test("port 0 is accepted and the bound port is printed", async () => {
    let out = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => { out += c; return true; }) as typeof process.stdout.write;
    try {
      const code = await runSlackCli(["serve", "--port", "0"], { SLACK_BOT_TOKEN: "xoxb-fake", SLACK_SIGNING_SECRET: "s" }, { wait: false, serve: () => ({ port: 41234 }) });
      expect(code).toBe(0);
    } finally { process.stdout.write = orig; }
    expect(out).toContain("http://127.0.0.1:41234");
  });
  test("poster treats HTTP 200 with ok:false as an error", async () => {
    const lines: string[] = [];
    const post = slackPoster("xoxb-fake-token", (async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 })) as never, (l) => lines.push(l));
    await post("C1", "1.1", "hi");
    expect(lines).toEqual(["slack: post failed (slack error: channel_not_found)"]);
  });
  test("spawn failure throws instead of reporting pid-undefined, and the thread gets an error post", async () => {
    const fakeSpawn = (() => ({ pid: undefined, on(ev: string, cb: (e: Error) => void) { if (ev === "error") cb(new Error("ENOENT")); } })) as never;
    const d = spawnRunDeps("/nonexistent-repo", {}, "/nope/bin/loki", fakeSpawn);
    await expect(d.startRun("fix the thing")).rejects.toThrow("could not launch");
    const posts: string[] = [];
    const st = newInboundState();
    await handleSlackEvent(st, { ...d, post: async (_c, _t, x) => { posts.push(x); } }, mention("R-sf", "<@UB> fix the thing", "300.3"));
    await tick();
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain("Could not start a run");
    expect(posts.join()).not.toContain("pid-undefined");
  });
});
