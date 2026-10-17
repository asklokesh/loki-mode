import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runControl } from "../../src/commands/control.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const realFetch = globalThis.fetch;
let out = "";
let realWrite: typeof process.stdout.write;
beforeEach(() => {
  out = "";
  realWrite = process.stdout.write;
  process.stdout.write = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
});
afterEach(() => { process.stdout.write = realWrite; globalThis.fetch = realFetch; });

const stub = (runs: () => Response): void => {
  globalThis.fetch = (async (u: string) => (String(u).endsWith("/health")
    ? new Response(JSON.stringify({ service: "loki-control", pid: 1 }))
    : runs())) as unknown as typeof fetch;
};
const env = { LOKI_CONTROL_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv;

describe("loki control status runs count", () => {
  test("500 from /v1/runs reads unknown, never 0 runs", async () => {
    stub(() => new Response("boom", { status: 500 }));
    await runControl(["status"], env);
    expect(out).not.toMatch(/\b0 runs\b/);
    expect(out).toContain("unknown");
  });
  test("body without total reads unknown, never 0 runs", async () => {
    stub(() => new Response("{}"));
    await runControl(["status"], env);
    expect(out).not.toMatch(/\b0 runs\b/);
    expect(out).toContain("unknown");
  });
  test("total 3 prints 3 runs", async () => {
    stub(() => new Response(JSON.stringify({ total: 3 })));
    expect(await runControl(["status"], env)).toBe(0);
    expect(out).toContain("3 runs");
  });
  test("a real total of 0 prints 0 runs", async () => {
    stub(() => new Response(JSON.stringify({ total: 0 })));
    await runControl(["status"], env);
    expect(out).toContain("0 runs");
  });
});

describe("loki control status json", () => {
  test("status json up: one object with running pid port url runs", async () => {
    stub(() => new Response(JSON.stringify({ total: 3 })));
    expect(await runControl(["status", "--json"], env)).toBe(0);
    expect(JSON.parse(out)).toEqual({ running: true, pid: 1, port: 1, url: "http://127.0.0.1:1", runs: 3 });
  });
  test("status json runs unknown is null, never 0", async () => {
    stub(() => new Response("boom", { status: 500 }));
    await runControl(["status", "--json"], env);
    expect(JSON.parse(out).runs).toBeNull();
  });
  test("status json down: running false, exit 1, valid JSON", async () => {
    globalThis.fetch = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    expect(await runControl(["status", "--json"], env)).toBe(1);
    const j = JSON.parse(out);
    expect(j.running).toBe(false);
    expect(j.pid).toBeNull();
  });
  test("status without --json text output unchanged", async () => {
    stub(() => new Response(JSON.stringify({ total: 3 })));
    await runControl(["status"], env);
    expect(out).toBe("loki control: up at http://127.0.0.1:1 (pid 1), 3 runs\n");
  });
});

describe("loki control stop", () => {
  let home = "";
  let child: ChildProcess | undefined;
  const instFile = (): string => join(home, ".loki", "control", "instance.json");
  const record = (pid: unknown): string => {
    mkdirSync(join(home, ".loki", "control"), { recursive: true });
    writeFileSync(instFile(), JSON.stringify({ pid, url: "http://127.0.0.1:9", port: 9 }));
    return instFile();
  };
  const health = (service: string): void => { globalThis.fetch = (async () => new Response(JSON.stringify({ service }))) as unknown as typeof fetch; };
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));
  const running = (): boolean => child!.exitCode === null && child!.signalCode === null;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "loki-ctl-stop-")); child = undefined; });
  afterEach(() => { try { child?.kill("SIGKILL"); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
  const e = (): NodeJS.ProcessEnv => ({ HOME: home }) as NodeJS.ProcessEnv;

  test("no record exits 0 and says not running", async () => {
    expect(await runControl(["stop"], e())).toBe(0);
    expect(out).toContain("not running");
  });
  test("stale record (dead pid) exits 0 and removes the record", async () => {
    const f = record(2147483646);
    expect(await runControl(["stop"], e())).toBe(0);
    expect(existsSync(f)).toBe(false);
  });
  test("health identity matches: the recorded pid is ended", async () => {
    child = spawn("sleep", ["60"], { stdio: "ignore" });
    const f = record(child.pid);
    health("loki-control");
    expect(await runControl(["stop"], e())).toBe(0);
    await settle();
    expect(running()).toBe(false);
    expect(existsSync(f)).toBe(false);
    expect(out).toContain("stopped");
  });
  test("health identity mismatch: refused, pid untouched, exit 1", async () => {
    child = spawn("sleep", ["60"], { stdio: "ignore" });
    record(child.pid);
    health("something-else");
    expect(await runControl(["stop"], e())).toBe(1);
    await settle();
    expect(running()).toBe(true);
  });
  test("health unreachable: refused, pid untouched, exit 1", async () => {
    child = spawn("sleep", ["60"], { stdio: "ignore" });
    record(child.pid);
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await runControl(["stop"], e())).toBe(1);
    await settle();
    expect(running()).toBe(true);
  });
  test("pid 1, 0, negative, string and fractional pids are never signalled", async () => {
    const realKill = process.kill;
    const sent: Array<string | number | undefined> = [];
    // every pid reads as alive, so only the pid validation can keep these from being signalled
    process.kill = ((_pid: number, sig?: string | number) => { sent.push(sig); return true; }) as typeof process.kill;
    try {
      for (const bad of [1, 0, -5, "123", 1.5]) {
        record(bad);
        health("loki-control");
        expect(await runControl(["stop"], e())).toBe(0);
      }
    } finally { process.kill = realKill; }
    expect(sent).not.toContain("SIGTERM");
  });
});

describe("loki control serve flag values", () => {
  let err = "";
  let realErr: typeof process.stderr.write;
  beforeEach(() => {
    err = "";
    realErr = process.stderr.write;
    process.stderr.write = ((s: string | Uint8Array) => { err += String(s); return true; }) as typeof process.stderr.write;
  });
  afterEach(() => { process.stderr.write = realErr; });
  const e = { LOKI_CONTROL_PORT: "" } as NodeJS.ProcessEnv;
  test("port without value exits 2 with usage", async () => {
    expect(await runControl(["serve", "--port"], e)).toBe(2);
    expect(err).toContain("--port needs a value");
    expect(err).toContain("Usage: loki control serve");
  });
  test("port followed by another flag exits 2", async () => {
    expect(await runControl(["serve", "--port", "--db", "x"], e)).toBe(2);
    expect(err).toContain("--port needs a value");
  });
  test("db without value exits 2", async () => {
    expect(await runControl(["serve", "--db"], e)).toBe(2);
    expect(err).toContain("--db needs a value");
  });
  test("non-numeric port exits 2", async () => {
    expect(await runControl(["serve", "--port", "abc"], e)).toBe(2);
    expect(err).toContain("invalid --port abc");
  });
});

describe("loki control backfill repo missing value", () => {
  test("backfill repo missing value fails with exit 2 and names --repo", async () => {
    let err = "";
    const realErr = process.stderr.write;
    process.stderr.write = ((s: string | Uint8Array) => { err += String(s); return true; }) as typeof process.stderr.write;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    try {
      expect(await runControl(["backfill", "--repo"], env)).toBe(2);
      expect(await runControl(["backfill", "--repo", "--other"], env)).toBe(2);
    } finally { process.stderr.write = realErr; }
    expect(err).toContain("--repo needs a value");
    expect(called).toBe(false);
  });
});
