// A-101: seal and verify must share one canonicalizer. Non-ASCII in any string field
// (model-written spec_conflict_reason, paths, keys) must round-trip through the real
// JSON.stringify(receipt, null, 2) file path and verify OK.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptSha256 } from "../../src/engine10/stages/seal.ts";
import { main, verifyReceipt } from "../../src/engine10/verify_cmd.ts";

const root = mkdtempSync(join(tmpdir(), "e10-roundtrip-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function seal(body: Record<string, unknown>, dir: string): string {
  const receipt = { ...body, receipt_sha256: receiptSha256(body as never), verification: { jwt: null, kid: null } };
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "receipt.json");
  writeFileSync(p, JSON.stringify(receipt, null, 2) + "\n");
  return p;
}

async function capture(args: string[], runsRoot: string): Promise<{ rc: number; out: string }> {
  let out = "";
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => ((out += s), true)) as never;
  try {
    return { rc: await main(args, { runsRoot }), out };
  } finally {
    process.stdout.write = w;
  }
}

describe("seal then verify round-trip", () => {
  test("non-ASCII in every string field, key, and nested value verifies", async () => {
    const p = seal(
      {
        verdict: "SPEC_CONFLICT",
        spec_conflict_reason: "a \u2192 b, caf\u00e9, \u65e5\u672c\u8a9e, " + String.fromCodePoint(0x1f600),
        task: "t\u00e2che",
        not_proven: ["n\u00f6t proven \u2260 failed"],
        nested: { "k\u00e9y": ["\u2713", { z: "\u00fc" }], skipped: undefined },
        provider: "p\u00f8",
        model: "m\u00f6",
      },
      join(root, "a"),
    );
    const r = await verifyReceipt(p);
    expect(r.reasons).toEqual([]);
    expect(r.verdict).toBe("UNSIGNED");
  });

  test("main prints the full receipt_sha256", async () => {
    seal({ verdict: "VERIFIED", reason: "\u2192" }, join(root, "runs", "e10-1"));
    const { rc, out } = await capture(["e10-1"], join(root, "runs"));
    expect(rc).toBe(0);
    expect(out).toMatch(/receipt_sha256: [0-9a-f]{64}/);
  });

  test("--help and -h print usage and exit 0", async () => {
    for (const flag of ["--help", "-h"]) {
      const { rc, out } = await capture([flag], join(root, "none"));
      expect(rc).toBe(0);
      expect(out).toContain("Usage");
    }
  });
});
