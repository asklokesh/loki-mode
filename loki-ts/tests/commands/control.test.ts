import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runControl } from "../../src/commands/control.ts";

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
