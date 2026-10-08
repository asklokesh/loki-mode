import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runQueue, readQueue, normalizeRef, type GovernorReading, type RunResult } from "../../src/commands/queue.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "queue-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(opts: {
  results?: Record<string, RunResult>;
  governor?: (n: number) => GovernorReading;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[] = [];
  let gcalls = 0;
  const inject = {
    lokiDir: dir,
    out: (s: string) => void out.push(s),
    err: (s: string) => void err.push(s),
    now: () => new Date("2026-10-08T03:00:00.000Z"),
    runner: async (ref: string) => {
      ran.push(ref);
      return opts.results?.[ref] ?? { rc: 0, output: "" };
    },
    governor: async () => opts.governor?.(gcalls++) ?? { ok: true, hold: false, reason: "ok" },
  };
  return { inject, out, err, ran };
}

describe("loki queue", () => {
  test("add and list keep insertion order, dedupe, and normalize URLs", async () => {
    const h = harness({});
    expect(await runQueue(["add", "o/r#3", "o/r#1"], h.inject)).toBe(0);
    expect(await runQueue(["add", "o/r#3", "https://github.com/o/r/issues/2"], h.inject)).toBe(0);
    expect(readQueue(dir).map((i) => i.ref)).toEqual(["o/r#3", "o/r#1", "o/r#2"]);
    h.out.length = 0;
    await runQueue(["list"], h.inject);
    const text = h.out.join("");
    expect(text.indexOf("o/r#3")).toBeLessThan(text.indexOf("o/r#1"));
    expect(text.indexOf("o/r#1")).toBeLessThan(text.indexOf("o/r#2"));
  });

  test("add rejects a bad ref with exit 2 and queues nothing", async () => {
    const h = harness({});
    expect(await runQueue(["add", "o/r#1", "not a ref"], h.inject)).toBe(2);
    expect(readQueue(dir)).toEqual([]);
    expect(normalizeRef("o/r")).toBeNull();
  });

  test("governor hold stops the run and leaves the rest queued with the reason", async () => {
    const h = harness({ governor: (n) => (n >= 1 ? { ok: true, hold: true, reason: "hold_above_70_session (82% session)" } : { ok: true, hold: false, reason: "ok" }) });
    await runQueue(["add", "o/r#1", "o/r#2", "o/r#3"], h.inject);
    h.out.length = 0;
    expect(await runQueue(["run"], h.inject)).toBe(0);
    expect(h.ran).toEqual(["o/r#1"]);
    expect(readQueue(dir).map((i) => i.ref)).toEqual(["o/r#2", "o/r#3"]);
    const digest = h.out.join("");
    expect(digest).toContain("Stopped early: governor hold: hold_above_70_session (82% session)");
    expect(digest).toContain("o/r#2: governor hold");
    expect(digest).toContain("o/r#3: governor hold");
  });

  test("digest has verdict, PR link, cost or NOT RECORDED, and is written to disk", async () => {
    const h = harness({
      results: {
        "o/r#1": { rc: 0, output: "opened https://github.com/o/r/pull/9\n", verdict: "VERIFIED", costUsd: 1.234 },
        "o/r#2": { rc: 0, output: "done" },
      },
    });
    await runQueue(["add", "o/r#1", "o/r#2"], h.inject);
    h.out.length = 0;
    await runQueue(["run"], h.inject);
    const digest = h.out.join("");
    expect(digest).toContain("verdict: VERIFIED");
    expect(digest).toContain("pr:      https://github.com/o/r/pull/9");
    expect(digest).toContain("cost:    $1.23");
    expect(digest).toContain("pr:      none");
    expect(digest).toContain("cost:    NOT RECORDED");
    expect(existsSync(join(dir, "queue-digest-latest.txt"))).toBe(true);
    expect(readFileSync(join(dir, "queue-digest-latest.txt"), "utf8")).toBe(digest);
    expect(readQueue(dir)).toEqual([]);
  });

  test("a failed or throwing item does not stop the queue", async () => {
    const h = harness({ results: { "o/r#1": { rc: 3, output: "boom" } } });
    h.inject.runner = async (ref: string) => {
      h.ran.push(ref);
      if (ref === "o/r#2") throw new Error("spawn failed");
      return ref === "o/r#1" ? { rc: 3, output: "boom" } : { rc: 0, output: "" };
    };
    await runQueue(["add", "o/r#1", "o/r#2", "o/r#3"], h.inject);
    h.out.length = 0;
    await runQueue(["run"], h.inject);
    expect(h.ran).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
    const digest = h.out.join("");
    expect(digest).toContain("FAILED (exit 3)");
    expect(digest).toContain("FAILED (exit 1)");
    expect(digest).toContain("COMPLETED (no proof verdict)");
    expect(digest).toContain("Processed: 3   Skipped: 0");
  });

  test("an unreadable governor proceeds and says so in the digest", async () => {
    const h = harness({ governor: () => ({ ok: false, hold: false, reason: "timeout" }) });
    await runQueue(["add", "o/r#1"], h.inject);
    h.out.length = 0;
    await runQueue(["run"], h.inject);
    expect(h.ran).toEqual(["o/r#1"]);
    expect(h.out.join("")).toContain("governor unreadable (timeout); proceeded");
  });
});
