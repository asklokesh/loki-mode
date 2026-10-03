// INTEL-1b: follow-ups from the INTEL-1 review (unknown keyids, outcome gate, run-id binding, single read, rotation).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kidOf, receiptSha256, signReceipt } from "../../src/engine10/stages/seal.ts";
import { signEnvelope, verifyEnvelope } from "../../src/features/receipt_dsse.ts";
import { main, type VerifyDeps } from "../../src/engine10/verify_cmd.ts";

const root = mkdtempSync(join(tmpdir(), "e10-dsse-fu-"));
const kp = generateKeyPairSync("ed25519");
const pub = () => createPublicKey(kp.privateKey);
const HEAD = "a1".repeat(20), TREE = "b2".repeat(20);
const saved = { k: process.env["LOKI_RECEIPT_SIGNING_KEY"], r: process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"] };

beforeAll(() => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string; delete process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"]; });
afterAll(() => {
  for (const [n, v] of [["LOKI_RECEIPT_SIGNING_KEY", saved.k], ["LOKI_RECEIPT_RETIRED_PUBKEYS", saved.r]] as const) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  rmSync(root, { recursive: true, force: true });
});

const sealed = (runId: string, over: Record<string, unknown> = {}) => {
  const body = { run_id: runId, verdict: "VERIFIED", base_sha: "c3".repeat(20), head_sha: HEAD, tree: TREE, diff_sha256: "d".repeat(64), events_sha256: createHash("sha256").digest("hex"), task: "t", ...over };
  const hash = receiptSha256(body as never);
  return { ...body, receipt_sha256: hash, verification: signReceipt(runId, hash) } as Record<string, unknown>;
};
const put = (runId: string, r: unknown) => { mkdirSync(join(root, "runs", runId), { recursive: true }); writeFileSync(join(root, "runs", runId, "receipt.json"), JSON.stringify(r)); };
async function run(args: string[], deps: VerifyDeps = {}): Promise<{ rc: number; out: string; err: string }> {
  let out = "", err = "";
  const w = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => ((out += s), true)) as never;
  process.stderr.write = ((s: string) => ((err += s), true)) as never;
  try { return { rc: await main(args, { runsRoot: join(root, "runs"), ...deps }), out, err }; } finally { process.stdout.write = w; process.stderr.write = e; }
}

describe("INTEL-1b", () => {
  test("1: all-unknown keyids are UNCHECKED; threshold of one still verifies; a known bad signature is not UNCHECKED", () => {
    const rc = sealed("fu-1");
    const o1 = generateKeyPairSync("ed25519"), o2 = generateKeyPairSync("ed25519");
    const e1 = signEnvelope(rc, o1.privateKey, kidOf(createPublicKey(o1.privateKey)));
    const e2 = signEnvelope(rc, o2.privateKey, kidOf(createPublicKey(o2.privateKey)));
    const two = { ...e1, signatures: [...e1.signatures, ...e2.signatures] };
    const r = verifyEnvelope(two, () => undefined);
    expect(!r.ok && r.unchecked).toBe(true);
    const good = signEnvelope(rc, kp.privateKey, kidOf(pub()));
    const lookup = (k: string) => (k === kidOf(pub()) ? pub() : undefined);
    expect(verifyEnvelope({ ...good, signatures: [...e1.signatures, ...good.signatures] }, lookup).ok).toBe(true);
    const badKnown = { ...good, signatures: [{ keyid: kidOf(pub()), sig: Buffer.alloc(64).toString("base64") }, ...e1.signatures] };
    const rb = verifyEnvelope(badKnown, lookup);
    expect(!rb.ok && !rb.unchecked).toBe(true);
  });

  test("2: a FAILED run whose receipt verifies is not exported; ALREADY_SATISFIED is", async () => {
    put("fu-failed", sealed("fu-failed", { verdict: "FAILED" }));
    const r = await run(["fu-failed", "--export-dsse"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("FAILED");
    put("fu-sat", sealed("fu-sat", { verdict: "ALREADY_SATISFIED" }));
    expect((await run(["fu-sat", "--export-dsse"])).rc).toBe(0);
  });

  test("3: an envelope in a run dir must carry that run id; an explicit file path is unchanged", async () => {
    const env = signEnvelope(sealed("fu-real"), kp.privateKey, kidOf(pub()));
    put("fu-other", env);
    const r = await run(["fu-other"]);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("run_id");
    put("fu-real", env);
    expect((await run(["fu-real"])).rc).toBe(0);
    const p = join(root, "explicit.json");
    writeFileSync(p, JSON.stringify(env));
    expect((await run([p])).rc).toBe(0);
  });

  test("4: export reads the receipt file exactly once and signs the verified bytes", async () => {
    put("fu-once", sealed("fu-once"));
    const target = join(root, "runs", "fu-once", "receipt.json");
    let reads = 0;
    const r = await run(["fu-once", "--export-dsse"], { read: (p: string) => { if (p === target) reads++; return readFileSync(p, "utf8"); } });
    expect(r.rc).toBe(0);
    expect(reads).toBe(1);
    expect(JSON.parse(Buffer.from(JSON.parse(r.out).payload, "base64").toString()).predicate.run_id).toBe("fu-once");
  });

  test("5: after rotation the envelope still verifies, and the keyid names the key that actually signed", async () => {
    const oldKid = kidOf(pub());
    put("fu-rot", sealed("fu-rot"));
    const next = generateKeyPairSync("ed25519");
    const f = join(root, "retired.pem");
    writeFileSync(f, pub().export({ type: "spki", format: "pem" }) as string);
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = next.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"] = f;
    try {
      const r = await run(["fu-rot", "--export-dsse"]);
      expect(r.rc).toBe(0);
      const env = JSON.parse(r.out);
      expect(JSON.parse(Buffer.from(env.payload, "base64").toString()).predicate.verification.kid).toBe(oldKid);
      expect(env.signatures[0].keyid).toBe(kidOf(createPublicKey(next.privateKey)));
      const p = join(root, "rot.json");
      writeFileSync(p, r.out);
      expect((await run([p])).rc).toBe(0);
    } finally {
      process.env["LOKI_RECEIPT_SIGNING_KEY"] = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      delete process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"];
    }
  });
});
