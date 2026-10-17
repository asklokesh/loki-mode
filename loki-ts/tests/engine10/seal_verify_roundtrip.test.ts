// A-101: seal and verify must share one canonicalizer. Non-ASCII in any string field
// (model-written spec_conflict_reason, paths, keys) must round-trip through the real
// JSON.stringify(receipt, null, 2) file path and verify OK.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { receiptSha256 } from "../../src/engine10/stages/seal.ts";
import { collectToolchain, resetToolchainMemo, signReceipt, toolchainProbeRuns } from "../../src/util/receipt_signer.ts";
import { main, verifyReceipt } from "../../src/engine10/verify_cmd.ts";

const root = mkdtempSync(join(tmpdir(), "e10-roundtrip-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function seal(raw: Record<string, unknown>, dir: string): string {
  const body = { schema: "loki.v10.receipt/1", time: { wall_s: 0, stages: {} }, events_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ...raw };
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
  test("toolchain probed once", () => {
    resetToolchainMemo();
    const a = collectToolchain();
    const b = collectToolchain();
    expect(toolchainProbeRuns()).toBe(1);
    expect(b).toEqual(a);
    expect(a.node).toMatch(/^\d+\.\d+/);
    expect(a.git).toMatch(/^\d+\.\d+/);
    expect(collectToolchain((bin) => `v-${bin}`).git).toBe("v-git");
  });
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
    const { rc, out } = await capture(["e10-1", "--allow-unsigned"], join(root, "runs"));
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

  test("unusable signing key names the reason", () => {
    const keep = { k: process.env["LOKI_RECEIPT_SIGNING_KEY"], f: process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"], h: process.env["HOME"] };
    const dirAsFile = join(root, "dir-as-file");
    mkdirSync(dirAsFile, { recursive: true });
    const cases: Array<[string, string | null, RegExp]> = [
      [dirAsFile, null, /unreadable/],
      ["junk.pem", "not a pem SECRETBYTES", /not a valid PEM/],
      ["rsa.pem", generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string, /not ed25519/],
    ];
    const w = process.stderr.write.bind(process.stderr);
    const sign = (): { r: ReturnType<typeof signReceipt>; err: string } => {
      let err = "";
      process.stderr.write = ((s: string) => ((err += s), true)) as never;
      try { return { r: signReceipt("run-x", "ab".repeat(32)), err }; } finally { process.stderr.write = w; }
    };
    try {
      delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
      process.env["HOME"] = join(root, "home");
      for (const [name, body, re] of cases) {
        const f = body === null ? name : join(root, name);
        if (body !== null) writeFileSync(f, body);
        process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = f;
        const { r, err } = sign();
        expect(r).toEqual({ jwt: null, kid: null });
        expect(err).toMatch(re);
        expect(err).not.toContain("SECRETBYTES");
        expect(err.trim().split("\n").length).toBe(1);
      }
      const good = join(root, "valid.pem");
      writeFileSync(good, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
      process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = good;
      const ok = sign();
      expect(ok.r.jwt).toBeTruthy();
      expect(ok.err).toBe("");
    } finally {
      process.stderr.write = w;
      for (const [n, v] of [["LOKI_RECEIPT_SIGNING_KEY", keep.k], ["LOKI_RECEIPT_SIGNING_KEY_FILE", keep.f], ["HOME", keep.h]] as const) {
        if (v === undefined) delete process.env[n]; else process.env[n] = v;
      }
    }
  });
});
