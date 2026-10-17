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
