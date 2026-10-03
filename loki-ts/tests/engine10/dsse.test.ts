// INTEL-1: DSSE / in-toto Statement v1 export of the Seal receipt. No cosign or in_toto is installed here, so the
// "stock verifier" is written below with node:crypto only, independent of src/features/receipt_dsse.ts (own PAE, own checks).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kidOf, receiptSha256, signReceipt } from "../../src/engine10/stages/seal.ts";
import { DSSE_PAYLOAD_TYPE, PREDICATE_TYPE, STATEMENT_TYPE, pae, signEnvelope, verifyEnvelope } from "../../src/features/receipt_dsse.ts";
import { main } from "../../src/engine10/verify_cmd.ts";

const root = mkdtempSync(join(tmpdir(), "e10-dsse-"));
const kp = generateKeyPairSync("ed25519");
const pem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const saved = process.env["LOKI_RECEIPT_SIGNING_KEY"];
const HEAD = "a1".repeat(20), TREE = "b2".repeat(20);
let receiptPath = "";
let receipt: Record<string, unknown>;

beforeAll(() => {
  process.env["LOKI_RECEIPT_SIGNING_KEY"] = pem;
  const body = { run_id: "e10-1", verdict: "VERIFIED", base_sha: "c3".repeat(20), head_sha: HEAD, tree: TREE, diff_sha256: "d".repeat(64), events_sha256: createHash("sha256").digest("hex"), task: "t" };
  const hash = receiptSha256(body as never);
  receipt = { ...body, receipt_sha256: hash, verification: signReceipt("e10-1", hash) };
  mkdirSync(join(root, "runs", "e10-1"), { recursive: true });
  receiptPath = join(root, "runs", "e10-1", "receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
});
afterAll(() => {
  if (saved === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY"]; else process.env["LOKI_RECEIPT_SIGNING_KEY"] = saved;
  rmSync(root, { recursive: true, force: true });
});

// Independent verifier: DSSE spec, written from the spec text, no import from receipt_dsse.ts.
function stockVerify(env: { payloadType: string; payload: string; signatures: { sig: string }[] }, pub: KeyObject): boolean {
  const body = Buffer.from(env.payload, "base64");
  const msg = Buffer.concat([Buffer.from("DSSEv1 " + Buffer.byteLength(env.payloadType) + " " + env.payloadType + " " + body.length + " "), body]);
  return env.signatures.some((s) => verify(null, msg, pub, Buffer.from(s.sig, "base64")));
}
async function run(args: string[]): Promise<{ rc: number; out: string }> {
  let out = "";
  const w = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => ((out += s), true)) as never;
  process.stderr.write = (() => true) as never;
  try { return { rc: await main(args, { runsRoot: join(root, "runs") }), out }; } finally { process.stdout.write = w; process.stderr.write = e; }
}
const exportEnv = async () => JSON.parse((await run(["e10-1", "--export-dsse"])).out) as { payloadType: string; payload: string; signatures: { keyid: string; sig: string }[] };
const pub = () => createPublicKey(kp.privateKey);

describe("DSSE export", () => {
  test("exports a Statement v1 the independent verifier accepts, predicate is the receipt unchanged", async () => {
    const env = await exportEnv();
    expect(env.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(env.signatures[0]!.keyid).toBe(kidOf(pub()));
    expect(stockVerify(env, pub())).toBe(true);
    const st = JSON.parse(Buffer.from(env.payload, "base64").toString());
    expect(st._type).toBe(STATEMENT_TYPE);
    expect(st.predicateType).toBe(PREDICATE_TYPE);
    expect(st.subject[0].digest).toEqual({ gitCommit: HEAD, gitTree: TREE });
    expect(st.predicate).toEqual(receipt);
  });

  test("loki verify accepts the exported envelope file", async () => {
    const p = join(root, "env.json");
    writeFileSync(p, JSON.stringify(await exportEnv()));
    const r = await run([p]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("verdict: VERIFIED");
  });

  test("one flipped payload byte fails both the independent verifier and loki verify", async () => {
    const env = await exportEnv();
    const body = Buffer.from(env.payload, "base64");
    body[body.indexOf(Buffer.from("e10-1"))] = body[body.indexOf(Buffer.from("e10-1"))]! ^ 1; // flips a byte inside the receipt run_id
    const bad = { ...env, payload: body.toString("base64") };
    expect(stockVerify(bad, pub())).toBe(false);
    const p = join(root, "bad.json");
    writeFileSync(p, JSON.stringify(bad));
    const r = await run([p]);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("TAMPERED");
  });

  test("a re-signed envelope whose predicate no longer matches its receipt hash is TAMPERED", async () => {
    const forged = signEnvelope({ ...receipt, task: "other" }, kp.privateKey, kidOf(pub()));
    const p = join(root, "forged.json");
    writeFileSync(p, JSON.stringify(forged));
    expect((await run([p])).rc).toBe(1);
  });

  test("an unknown signer is UNCHECKED, and a wrong key never verifies", () => {
    const other = generateKeyPairSync("ed25519");
    const env = signEnvelope(receipt, other.privateKey, kidOf(createPublicKey(other.privateKey)));
    expect(verifyEnvelope(env, () => pub()).ok).toBe(false);
    const r = verifyEnvelope(env, () => undefined);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.unchecked).toBe(true);
  });

  test("a tampered receipt is refused for export", async () => {
    mkdirSync(join(root, "runs", "e10-2"), { recursive: true });
    writeFileSync(join(root, "runs", "e10-2", "receipt.json"), JSON.stringify({ ...receipt, task: "x" }));
    const r = await run(["e10-2", "--export-dsse"]);
    expect(r.rc).toBe(1);
    expect(r.out).toBe("");
  });
});

describe("mutations the verifier must catch", () => {
  const mk = (signed: (body: Buffer) => Buffer) => {
    const body = Buffer.from(JSON.stringify({ _type: STATEMENT_TYPE, subject: [{ name: "x", digest: { gitCommit: HEAD, gitTree: TREE } }], predicateType: PREDICATE_TYPE, predicate: receipt }));
    return { payloadType: DSSE_PAYLOAD_TYPE, payload: body.toString("base64"), signatures: [{ keyid: kidOf(pub()), sig: sign(null, signed(body), kp.privateKey).toString("base64") }] };
  };
  test("control: the correct PAE verifies", () => {
    const env = mk((b) => pae(DSSE_PAYLOAD_TYPE, b));
    expect(stockVerify(env, pub())).toBe(true);
    expect(verifyEnvelope(env, () => pub()).ok).toBe(true);
  });
  test("wrong PAE (raw body, no DSSEv1 prefix) is rejected", () => {
    const env = mk((b) => b);
    expect(stockVerify(env, pub())).toBe(false);
    expect(verifyEnvelope(env, () => pub()).ok).toBe(false);
  });
  test("wrong PAE (type length off by one) is rejected", () => {
    const env = mk((b) => Buffer.concat([Buffer.from(`DSSEv1 ${DSSE_PAYLOAD_TYPE.length + 1} ${DSSE_PAYLOAD_TYPE} ${b.length} `), b]));
    expect(verifyEnvelope(env, () => pub()).ok).toBe(false);
  });
  test("payload not signed (signature over other bytes) is rejected", () => {
    const env = mk(() => pae(DSSE_PAYLOAD_TYPE, Buffer.from("something else")));
    expect(stockVerify(env, pub())).toBe(false);
    expect(verifyEnvelope(env, () => pub()).ok).toBe(false);
  });
});
