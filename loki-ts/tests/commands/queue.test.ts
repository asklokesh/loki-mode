import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runQueue, readQueue, itemTimeoutMin, makeDefaultRunner, queueStartArgs, normalizeRef, type GovernorReading, type RunResult } from "../../src/commands/queue.ts";

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
  test("add on a corrupt queue file quarantines it, warns once, and starts a fresh file", async () => {
    const qf = join(dir, "issue-queue.json");
    writeFileSync(qf, '{"version":1,"items":[{"ref":"o/r#9","added_at":"2026');
    const h = harness({});
    expect(await runQueue(["add", "o/r#1", "o/r#2"], h.inject)).toBe(0);
    expect(readQueue(dir).map((i) => i.ref)).toEqual(["o/r#1", "o/r#2"]);
    const q = readdirSync(dir).filter((f) => f.startsWith("issue-queue.json.corrupt-"));
    expect(q.length).toBe(1);
    expect(readFileSync(join(dir, q[0]!), "utf8")).toContain("o/r#9");
    expect(h.err.filter((e) => e.includes("corrupt")).length).toBe(1);
  });

  test("add on a valid queue and on a missing file does not quarantine", async () => {
    const h = harness({});
    await runQueue(["add", "o/r#1"], h.inject);
    await runQueue(["add", "o/r#2"], h.inject);
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length).toBe(0);
    expect(h.err.length).toBe(0);
    expect(readQueue(dir).map((i) => i.ref)).toEqual(["o/r#1", "o/r#2"]);
  });

  test("add on a parseable file with no items array quarantines it", async () => {
    writeFileSync(join(dir, "issue-queue.json"), "[]");
    const h = harness({});
    await runQueue(["add", "o/r#1"], h.inject);
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length).toBe(1);
  });

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

  test("remove drops normalized refs, clear empties, missing ref exits 0", async () => {
    const h = harness({});
    await runQueue(["add", "o/r#1", "o/r#2", "o/r#3"], h.inject);
    h.out.length = 0;
    expect(await runQueue(["remove", "https://github.com/o/r/issues/2"], h.inject)).toBe(0);
    expect(h.out.join("")).toContain("1 removed, 2 left");
    expect(readQueue(dir).map((i) => i.ref)).toEqual(["o/r#1", "o/r#3"]);
    h.out.length = 0;
    expect(await runQueue(["remove", "o/r#9"], h.inject)).toBe(0);
    expect(h.out.join("")).toContain("not queued: o/r#9");
    expect(h.out.join("")).toContain("0 removed, 2 left");
    expect(await runQueue(["remove"], h.inject)).toBe(2);
    expect(await runQueue(["remove", "bad ref"], h.inject)).toBe(2);
    h.out.length = 0;
    expect(await runQueue(["clear"], h.inject)).toBe(0);
    expect(h.out.join("")).toContain("2 removed, 0 left");
    expect(readQueue(dir)).toEqual([]);
  });

  test("remove and clear through bin/loki", () => {
    const run = (...a: string[]) => Bun.spawnSync([join(import.meta.dir, "../../../bin/loki"), "queue", ...a], { env: { ...process.env, LOKI_DIR: dir } });
    expect(run("add", "o/r#5", "o/r#6").exitCode).toBe(0);
    const r = run("remove", "o/r#5");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("1 removed, 1 left");
    expect(run("clear").stdout.toString()).toContain("1 removed, 0 left");
  });

  test("queue zero issue: 0, #0, o/r#0, o/r#00 and a /issues/0 URL are rejected with exit 2", async () => {
    for (const bad of ["0", "#0", "o/r#0", "o/r#00", "https://github.com/o/r/issues/0"]) {
      expect(normalizeRef(bad)).toBeNull();
      const h = harness({});
      expect(await runQueue(["add", bad], h.inject)).toBe(2);
      expect(readQueue(dir)).toEqual([]);
    }
    expect(normalizeRef("o/r#10")).toBe("o/r#10");
    expect(normalizeRef("10")).toBe("10");
  });

  test("queue zero issue: bin/loki queue add o/r#0 exits 2", () => {
    const r = Bun.spawnSync(["bash", join(import.meta.dir, "../../../bin/loki"), "queue", "add", "o/r#0"], { cwd: dir });
    expect(r.exitCode).toBe(2);
  });

  test("add rejects a bad ref with exit 2 and queues nothing", async () => {
    const h = harness({});
    expect(await runQueue(["add", "o/r#1", "not a ref"], h.inject)).toBe(2);
    expect(readQueue(dir)).toEqual([]);
    expect(normalizeRef("o/r")).toBeNull();
  });

  test("--max-total-cost stops after the item that reaches the cap and keeps the rest queued", async () => {
    const results = { "o/r#1": { rc: 0, output: "", costUsd: 2 }, "o/r#2": { rc: 0, output: "", costUsd: 2 }, "o/r#3": { rc: 0, output: "", costUsd: 2 } };
    const h = harness({ results });
    await runQueue(["add", "o/r#1", "o/r#2", "o/r#3"], h.inject);
    h.out.length = 0;
    expect(await runQueue(["run", "--max-total-cost", "3"], h.inject)).toBe(0);
    expect(h.ran).toEqual(["o/r#1", "o/r#2"]);
    expect(readQueue(dir).map((i) => i.ref)).toEqual(["o/r#3"]);
    const digest = h.out.join("");
    expect(digest).toContain("Stopped early: total cost cap $3.00 reached (spent $4.00)");
    expect(digest).toContain("o/r#3: total cost cap");
  });

  test("--max-total-cost=<usd> form works and without the flag all items run", async () => {
    const results = { "o/r#1": { rc: 0, output: "", costUsd: 2 }, "o/r#2": { rc: 0, output: "", costUsd: 2 } };
    const h = harness({ results });
    await runQueue(["add", "o/r#1", "o/r#2"], h.inject);
    await runQueue(["run", "--max-total-cost=1.5"], h.inject);
    expect(h.ran).toEqual(["o/r#1"]);
    await runQueue(["run"], h.inject);
    expect(h.ran).toEqual(["o/r#1", "o/r#2"]);
  });

  test("--max-total-cost rejects a bad value with exit 2 through bin/loki and runs nothing", async () => {
    const run = (...a: string[]) => Bun.spawnSync([join(import.meta.dir, "../../../bin/loki"), "queue", ...a], { env: { ...process.env, LOKI_DIR: dir } });
    expect(run("add", "o/r#5").exitCode).toBe(0);
    for (const bad of ["abc", "0", "-1", ""]) {
      const r = run("run", "--max-total-cost", bad);
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("--max-total-cost needs a positive USD amount");
    }
    expect(run("list").stdout.toString()).toContain("1 queued");
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

describe("loki queue run progress (TEN-UX-28)", () => {
  test("progress line per item before it runs, and digest rows carry [n/m]", async () => {
    const h = harness({});
    await runQueue(["add", "o/r#1", "o/r#2"], h.inject);
    h.err.length = 0;
    h.out.length = 0;
    expect(await runQueue(["run", "--no-pr"], h.inject)).toBe(0);
    expect(h.err.filter((e) => /^\[\d+\/\d+\] /.test(e))).toEqual(["[1/2] o/r#1\n", "[2/2] o/r#2\n"]);
    const digest = h.out.join("");
    expect(digest).toContain("  [1/2] o/r#1\n    verdict:");
    expect(digest).toContain("  [2/2] o/r#2\n    verdict:");
  });
});

describe("loki queue list columns (TEN-UX-14)", () => {
  test("prints id, age, status columns and an N queued footer", async () => {
    const h = harness({});
    await runQueue(["add", "o/r#3", "o/r#10"], h.inject);
    const later = { ...h.inject, now: () => new Date("2026-10-08T05:00:00.000Z") };
    h.out.length = 0;
    expect(await runQueue(["list"], later)).toBe(0);
    const lines = h.out.join("").split("\n");
    expect(lines[0]).toMatch(/^ID\s+AGE\s+STATUS$/);
    expect(lines[1]).toMatch(/^o\/r#3\s+2h\s+queued$/);
    expect(lines[2]).toMatch(/^o\/r#10\s+2h\s+queued$/);
    expect(lines[3]).toBe("2 queued");
  });

  test("age uses seconds, minutes and days units", async () => {
    const { formatAge } = await import("../../src/commands/queue.ts");
    const n = new Date("2026-10-08T03:00:00.000Z");
    expect(formatAge("2026-10-08T02:59:30.000Z", n)).toBe("30s");
    expect(formatAge("2026-10-08T02:57:00.000Z", n)).toBe("3m");
    expect(formatAge("2026-10-05T03:00:00.000Z", n)).toBe("3d");
    expect(formatAge("garbage", n)).toBe("unknown");
  });

  test("empty queue prints a next step", async () => {
    const h = harness({});
    await runQueue(["list"], h.inject);
    expect(h.out.join("")).toContain("queue is empty");
    expect(h.out.join("")).toContain("loki queue add");
  });

  test("unknown flag or extra arg is rejected with usage and exit 2", async () => {
    const h = harness({});
    await runQueue(["add", "o/r#1"], h.inject);
    for (const args of [["list", "--bogus"], ["clear", "extra"], ["run", "--bogus"], ["run", "--no-pr", "extra"], ["run", "--no-prr"]]) {
      h.err.length = 0;
      expect(await runQueue(args, h.inject)).toBe(2);
      expect(h.err.join("")).toContain("usage: loki queue");
    }
    expect(h.ran).toEqual([]);
    expect(readQueue(dir).length).toBe(1);
  });

  test("valid queue forms are unchanged", async () => {
    const h = harness({});
    await runQueue(["add", "o/r#1"], h.inject);
    expect(await runQueue(["list"], h.inject)).toBe(0);
    expect(await runQueue(["run", "--no-pr", "--max-total-cost", "5"], h.inject)).toBe(0);
    expect(await runQueue(["run", "--max-total-cost=5"], h.inject)).toBe(0);
    expect(await runQueue(["clear"], h.inject)).toBe(0);
  });
});

describe("loki queue list --json (TEN-ADOPTION-25)", () => {
  const bin = join(import.meta.dir, "../../../bin/loki");
  const run = (...a: string[]) => Bun.spawnSync([bin, "queue", ...a], { env: { ...process.env, LOKI_DIR: dir } });

  test("list json prints the refs as a JSON array through bin/loki", () => {
    expect(run("add", "o/r#1", "o/r#2").exitCode).toBe(0);
    const r = run("list", "--json");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual(["o/r#1", "o/r#2"]);
  });

  test("list json on an empty queue is []", () => {
    const r = run("list", "--json");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual([]);
  });

  test("plain list output is unchanged and other extras still exit 2", async () => {
    const h = harness({});
    await runQueue(["add", "o/r#1"], h.inject);
    h.out.length = 0;
    expect(await runQueue(["list"], h.inject)).toBe(0);
    expect(h.out.join("")).toBe("ID     AGE  STATUS\no/r#1  0s   queued\n1 queued\n");
    expect(await runQueue(["list", "--json", "--bogus"], h.inject)).toBe(2);
  });
});

describe("queue item timeout", () => {
  test("negative item timeout falls back to 120 with one note; valid values unchanged", () => {
    for (const bad of ["-5", "0", "abc", "Infinity", "NaN", "99999999999"]) {
      const notes: string[] = [];
      expect(itemTimeoutMin(bad, (s) => void notes.push(s))).toBe(120);
      expect(notes.length).toBe(1);
      expect(notes[0]).toContain("LOKI_QUEUE_ITEM_TIMEOUT_MIN");
    }
    const quiet: string[] = [];
    expect(itemTimeoutMin("30", (s) => void quiet.push(s))).toBe(30);
    expect(itemTimeoutMin("0.5", (s) => void quiet.push(s))).toBe(0.5);
    expect(itemTimeoutMin(undefined, (s) => void quiet.push(s))).toBe(120);
    expect(itemTimeoutMin("", (s) => void quiet.push(s))).toBe(120);
    expect(quiet).toEqual([]);
  });

  test("negative item timeout does not kill the real runner child at once", async () => {
    const prev = process.env["LOKI_QUEUE_ITEM_TIMEOUT_MIN"];
    process.env["LOKI_QUEUE_ITEM_TIMEOUT_MIN"] = "-5";
    try {
      const r = await makeDefaultRunner(dir)("not-a-ref", {} as never);
      expect([143, 137, -15]).not.toContain(r.rc);
    } finally {
      if (prev === undefined) delete process.env["LOKI_QUEUE_ITEM_TIMEOUT_MIN"];
      else process.env["LOKI_QUEUE_ITEM_TIMEOUT_MIN"] = prev;
    }
  }, 60000);

  test("unknown subcommand hint names the bad word and the closest subcommand", async () => {
    const h = harness({});
    expect(await runQueue(["lst"], h.inject)).toBe(2);
    const msg = h.err.join("");
    expect(msg).toContain("unknown subcommand 'lst'");
    expect(msg).toContain("did you mean 'list'?");
    expect(msg).toContain("usage: loki queue");
    const h2 = harness({});
    expect(await runQueue(["zzzzzz"], h2.inject)).toBe(2);
    expect(h2.err.join("")).toContain("unknown subcommand 'zzzzzz'");
    expect(h2.err.join("")).not.toContain("did you mean");
    const h3 = harness({});
    expect(await runQueue([], h3.inject)).toBe(2);
    expect(h3.err.join("")).not.toContain("unknown subcommand");
  });
});

describe("loki queue run arg hint (TEN-UX-44)", () => {
  test("unknown run argument suggests the closest valid flag", async () => {
    const h = harness({});
    expect(await runQueue(["run", "--no-pir"], h.inject)).toBe(2);
    const msg = h.err.join("");
    expect(msg).toContain("unknown argument '--no-pir'");
    expect(msg).toContain("did you mean '--no-pr'?");
    const h2 = harness({});
    expect(await runQueue(["run", "--max-total-cots=5"], h2.inject)).toBe(2);
    expect(h2.err.join("")).toContain("did you mean '--max-total-cost'?");
    const h3 = harness({});
    expect(await runQueue(["run", "zzzzzzzz"], h3.inject)).toBe(2);
    expect(h3.err.join("")).toContain("unknown argument 'zzzzzzzz'");
    expect(h3.err.join("")).not.toContain("did you mean");
  });
});

describe("queue run start argv reaches engine10 (#236)", () => {
  const route = (args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, LOKI_NO_BROWSER: "1", HOME: dir };
    delete env["LOKI_ENGINE"]; delete env["LOKI_PROVIDER"];
    return spawnSync(join(import.meta.dir, "..", "..", "..", "bin", "loki"), ["route", ...args, "--json"], { encoding: "utf8", env, cwd: dir });
  };
  test("PR on: argv carries the accepted --pr and routes to engine10, not the refusal", () => {
    const argv = queueStartArgs("owner/repo#5", true);
    expect(argv).toEqual(["start", "owner/repo#5", "--pr"]);
    const r = route(argv);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).engine).toBe("engine10");
    expect(r.stderr).not.toContain("not supported");
  });
  test("PR off: argv carries --no-pr (engine10 opens a PR by default) and routes to engine10", () => {
    const argv = queueStartArgs("owner/repo#5", false);
    expect(argv).toEqual(["start", "owner/repo#5", "--no-pr"]);
    const r = route(argv);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).engine).toBe("engine10");
  });
});
