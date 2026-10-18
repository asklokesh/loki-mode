import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeAsk, parseScore, satisfactionEnabled } from "../../src/util/satisfaction.ts";

describe("satisfaction", () => {
  test("the prompt is opt-in and off without a TTY, in CI, or when disabled", () => {
    expect(satisfactionEnabled({}, true)).toBe(true);
    expect(satisfactionEnabled({}, false)).toBe(false);
    expect(satisfactionEnabled({ CI: "true" }, true)).toBe(false);
    expect(satisfactionEnabled({ LOKI_SATISFACTION: "0" }, true)).toBe(false);
    expect(satisfactionEnabled({ LOKI_SATISFACTION: "off" }, true)).toBe(false);
  });
  test("parseScore accepts 1-5 and an optional y or n, and skips junk", () => {
    expect(parseScore("5 y")).toEqual({ score: 5, again: true });
    expect(parseScore("1 n")).toEqual({ score: 1, again: false });
    expect(parseScore("3")).toEqual({ score: 3, again: null });
    expect(parseScore("")).toBeNull();
    expect(parseScore("9 y")).toBeNull();
    expect(parseScore("here is my code")).toBeNull();
  });
  test("a rating is written only on this machine and a skip writes nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "loki-sat-"));
    const file = join(home, ".loki", "satisfaction.jsonl");
    await maybeAsk({ runId: "e10-1", env: { HOME: home }, isTTY: true, ask: async () => "" });
    expect(existsSync(file)).toBe(false);
    await maybeAsk({ runId: "e10-1", env: { HOME: home }, isTTY: true, ask: async () => "4 y" });
    const row = JSON.parse(readFileSync(file, "utf8").trim()) as { run_id: string; score: number; again: boolean };
    expect(row).toMatchObject({ run_id: "e10-1", score: 4, again: true });
    expect(JSON.stringify(row)).not.toContain("prompt");
    rmSync(home, { recursive: true, force: true });
  });
});
