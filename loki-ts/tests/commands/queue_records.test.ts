import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runQueue, newestRecord } from "../../src/commands/queue.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "queue-rec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Shaped like the engine10 seal receipt (stages/seal.ts): top-level verdict, cost.usd, optional cost.source.
const receipt = (verdict: string, cost: Record<string, unknown>) =>
  JSON.stringify({
    schema: 1,
    run_id: "r1",
    verdict,
    cost: { usd: 0, input_tokens: 0, output_tokens: 0, measured_sessions: 0, total_sessions: 1, partial_usd: 0, ...cost },
    provider: "claude",
  });
const put = (sub: string, file: string, body: string) => {
  mkdirSync(join(dir, sub, "r1"), { recursive: true });
  writeFileSync(join(dir, sub, "r1", file), body);
};

async function runOne(res: { rc: number; verdict?: string | null; costUsd?: number | null }): Promise<string> {
  const out: string[] = [];
  await runQueue(["add", "o/r#1"], { lokiDir: dir, out: () => {} });
  await runQueue(["run"], {
    lokiDir: dir,
    out: (s) => void out.push(s),
    governor: async () => ({ ok: true, hold: false, reason: "ok" }),
    runner: async () => ({ output: "", ...res }),
  });
  return out.join("");
}

describe("run record reader", () => {
  test("reads verdict and cost from an engine10 runs/<id>/receipt.json", () => {
    put("runs", "receipt.json", receipt("VERIFIED", { usd: 2.5, measured_sessions: 1 }));
    expect(newestRecord(dir, 0)).toEqual({ verdict: "VERIFIED", costUsd: 2.5, runId: "r1" });
  });

  test("cli-invoker-unmetered cost is NOT RECORDED, never $0.00", async () => {
    put("runs", "receipt.json", receipt("VERIFIED", { usd: 0, source: "cli-invoker-unmetered" }));
    const r = newestRecord(dir, 0);
    expect(r.costUsd).toBeNull();
    const text = await runOne({ rc: 0, ...r });
    expect(text).toContain("cost:    NOT RECORDED");
    expect(text).not.toContain("$0.00");
  });

  test("falls back to proofs/<id>/proof.json for legacy runs", () => {
    put("proofs", "proof.json", JSON.stringify({ verdict: "PASSED", cost: { usd: 0.4 } }));
    expect(newestRecord(dir, 0)).toEqual({ verdict: "PASSED", costUsd: 0.4 });
  });

  test("a record older than since is ignored", () => {
    put("runs", "receipt.json", receipt("VERIFIED", { usd: 1 }));
    expect(newestRecord(dir, Date.now() + 60_000)).toEqual({ verdict: null, costUsd: null });
  });

  test("non-zero rc with a receipt shows the receipt verdict", async () => {
    put("runs", "receipt.json", receipt("PARTIAL", { usd: 1 }));
    const text = await runOne({ rc: 1, ...newestRecord(dir, 0) });
    expect(text).toContain("verdict: PARTIAL");
    expect(text).not.toContain("FAILED (exit 1)");
  });
});
