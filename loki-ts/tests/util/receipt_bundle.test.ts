// TEN-ADOPTION-02: the portable receipt bundle verifies on its own, refuses unsigned/unverified runs, and carries no private material.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { SupervisorLog } from "../../src/engine10/supervisor.ts";
import { receiptSha256, signReceipt } from "../../src/engine10/stages/seal.ts";
import { takePubkey } from "../../src/engine10/keys_cmd.ts";
import { verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { buildReceiptBundle } from "../../src/util/receipt_bundle.ts";

const root = mkdtempSync(join(tmpdir(), "e10-bundle-"));
const saved = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];
beforeAll(() => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "k.pem"); });
afterAll(() => { if (saved === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = saved; rmSync(root, { recursive: true, force: true }); });

let n = 0;
const sha = (b: Buffer): string => new Bun.CryptoHasher("sha256").update(b).digest("hex");
function run(signed: boolean): string {
  const id = `e10-rb-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl");
  mkdirSync(dir, { recursive: true });
  const log = new SupervisorLog(ev, id);
  log.append("run.started", null, { provider: "claude" });
  const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", events_sha256: sha(readFileSync(ev)), time: { wall_s: 0, stages: {} }, log_seal: true };
  const hash = receiptSha256(body as never);
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signed ? signReceipt(id, hash) : { jwt: null, kid: null } }, null, 2));
  log.append("receipt.sealed", "seal", { receipt_sha256: hash });
  log.verify();
  log.append("run.completed", null, {});
  log.sealLog();
  return dir;
}

describe("buildReceiptBundle", () => {
  test("bundle verifies VERIFIED against its own pubkey.jwk; one-byte edit is TAMPERED", async () => {
    const out = join(root, "out-ok"), r = await buildReceiptBundle(run(true), out);
    expect(r.ok).toBe(true);
    const pk = takePubkey(["--pubkey", join(out, "pubkey.jwk")]);
    expect(pk.error).toBeUndefined();
    expect((await verifyReceipt(join(out, "receipt.json"), { pubkey: pk.pubkey })).verdict).toBe("VERIFIED");
    expect(readFileSync(join(out, "VERIFY.md"), "utf8")).toContain("npx loki-mode verify --pubkey pubkey.jwk receipt.json");
    const p = join(out, "receipt.json"), t = readFileSync(p, "utf8");
    writeFileSync(p, t.replace('"VERIFIED"', '"VERIFIEX"'));
    expect((await verifyReceipt(p, { pubkey: pk.pubkey })).verdict).toBe("TAMPERED");
  });
  test("unsigned run: error, outDir not created", async () => {
    const out = join(root, "out-unsigned"), r = await buildReceiptBundle(run(false), out);
    expect(r.ok).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
  test("tampered run: error, outDir not created", async () => {
    const dir = run(true), p = join(dir, "receipt.json"), out = join(root, "out-tampered");
    writeFileSync(p, readFileSync(p, "utf8").replace('"VERIFIED"', '"VERIFIEX"'));
    expect((await buildReceiptBundle(dir, out)).ok).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
  test("no private material in any bundled file", async () => {
    const out = join(root, "out-priv");
    expect((await buildReceiptBundle(run(true), out)).ok).toBe(true);
    const jwk = JSON.parse(readFileSync(join(out, "pubkey.jwk"), "utf8"));
    expect(jwk.d).toBeUndefined();
    expect(typeof jwk.kid).toBe("string");
    expect(() => createPublicKey({ key: jwk, format: "jwk" })).not.toThrow();
    for (const f of readdirSync(out)) expect(readFileSync(join(out, f), "utf8")).not.toContain("PRIVATE KEY");
  });
});
