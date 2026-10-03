import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryWarm, warmLine, warmRequest } from "../../src/features/warm_client.ts";

const temps: string[] = [];
const saved = process.env["LOKI_SPEED"];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  if (saved === undefined) delete process.env["LOKI_SPEED"];
  else process.env["LOKI_SPEED"] = saved;
});

describe("warm client", () => {
  test("no daemon gives null (cold path) and prints nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-wc-"));
    temps.push(dir);
    const path = join(dir, "none.sock");
    expect(await warmRequest({ op: "ping" }, 50, path)).toBeNull();
    process.env["LOKI_SPEED"] = "1";
    const out: string[] = [];
    expect(await tryWarm(dir, { path, write: (s) => out.push(s) })).toBeNull();
    expect(out).toEqual([]);
  });

  test("flag off never connects", async () => {
    delete process.env["LOKI_SPEED"];
    expect(await tryWarm("/nonexistent", { path: "/nonexistent.sock" })).toBeNull();
  });

  test("warmLine format", () => {
    expect(warmLine(0.12)).toBe("warm in 0.1s");
  });
});
