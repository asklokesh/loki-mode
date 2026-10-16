// P12-36: outbox + idempotency keys for external side effects (PR, comment, deploy).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idempotencyKey, runOnce } from "../../src/util/outbox.ts";

const dir = () => mkdtempSync(join(tmpdir(), "loki-outbox-"));

// Fake remote: post() records the call; probe() answers from what the remote holds.
function fakeRemote() {
  const remote = new Map<string, string>();
  let calls = 0;
  return {
    get calls() { return calls; },
    post: (key: string) => { calls++; remote.set(key, `url/${calls}`); return { url: `url/${calls}` }; },
    probe: (key: string) => (remote.has(key) ? { url: remote.get(key) as string } : null),
  };
}

describe("outbox", () => {
  test("kill between post and record replays with exactly one post", () => {
    const d = dir(), r = fakeRemote(), key = idempotencyKey("pr", "run1", "branch-a");
    // First attempt: post lands, then the process dies before the done record is written.
    expect(() => runOnce({ dir: d, key, post: r.post, probe: r.probe, afterPost: () => { throw new Error("killed"); } })).toThrow("killed");
    expect(r.calls).toBe(1);
    // Replay after resume: probe finds the remote effect, no second post.
    const res = runOnce({ dir: d, key, post: r.post, probe: r.probe });
    expect(r.calls).toBe(1);
    expect(res).toEqual({ url: "url/1" });
    // A third call is served from the done record alone.
    runOnce({ dir: d, key, post: r.post });
    expect(r.calls).toBe(1);
  });

  test("kill before post replays and posts once", () => {
    const d = dir(), r = fakeRemote(), key = idempotencyKey("comment", "run1", "x");
    expect(() => runOnce({ dir: d, key, post: () => { throw new Error("killed"); } })).toThrow("killed");
    runOnce({ dir: d, key, post: r.post, probe: r.probe });
    expect(r.calls).toBe(1);
  });

  test("pending record is written before the post", () => {
    const d = dir(), key = idempotencyKey("deploy", "run1", "prod");
    runOnce({ dir: d, key, post: () => {
      const f = readdirSync(d).filter((n) => n.endsWith(".json"));
      expect(f.length).toBe(1);
      expect(JSON.parse(readFileSync(join(d, f[0] as string), "utf8")).state).toBe("pending");
      return { ok: 1 };
    } });
  });

  test("key stable across resume and distinct per comment", () => {
    expect(idempotencyKey("comment", "run1", "hello")).toBe(idempotencyKey("comment", "run1", "hello"));
    const a = idempotencyKey("comment", "run1", "hello"), b = idempotencyKey("comment", "run1", "world");
    const c = idempotencyKey("comment", "run2", "hello"), e = idempotencyKey("pr", "run1", "hello");
    expect(new Set([a, b, c, e]).size).toBe(4);
  });

  test("a result rejected by keep is not recorded done, so replay retries", () => {
    const d = dir(), r = fakeRemote(), key = idempotencyKey("pr", "r", "b");
    runOnce({ dir: d, key, post: () => ({ ok: false }), keep: (x) => x.ok });
    runOnce({ dir: d, key, post: () => { r.post(key); return { ok: true }; }, keep: (x) => x.ok });
    expect(r.calls).toBe(1);
  });

  test("distinct keys post independently", () => {
    const d = dir(), r = fakeRemote();
    runOnce({ dir: d, key: idempotencyKey("comment", "r", "one"), post: r.post });
    runOnce({ dir: d, key: idempotencyKey("comment", "r", "two"), post: r.post });
    expect(r.calls).toBe(2);
  });
});
