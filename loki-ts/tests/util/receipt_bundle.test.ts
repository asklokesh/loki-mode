// TEN-ADOPTION-02: the portable receipt bundle verifies on its own, refuses unsigned/unverified runs, and carries no private material.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { sealGroup } from "../../src/features/speed/seal_group.ts";
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
function run(signed: boolean, extra: (dir: string) => Record<string, unknown> = () => ({})): string {
  const id = `e10-rb-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl");
  mkdirSync(dir, { recursive: true });
  const log = new SupervisorLog(ev, id);
  log.append("run.started", null, { provider: "claude" });
  const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", events_sha256: sha(readFileSync(ev)), time: { wall_s: 0, stages: {} }, log_seal: true, ...extra(dir) };
  const hash = receiptSha256(body as never);
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signed ? signReceipt(id, hash) : { jwt: null, kid: null } }, null, 2));
  log.append("receipt.sealed", "seal", { receipt_sha256: hash });
  log.verify();
  log.append("run.completed", null, {});
  log.sealLog();
  return dir;
}

function groupExtra(dir: string): Record<string, unknown> {
  const u = join(dir, "group", "units", "u1");
  mkdirSync(u, { recursive: true });
  writeFileSync(join(dir, "group", "manifest.json"), JSON.stringify({ group_id: "g1", units: [{ unit_id: "u1", goal: "g", files: ["a.txt"], tests: 1, tokens: 1, model: "m" }] }));
  const events = JSON.stringify({ v: 1, seq: 0, ts: "2026-01-01T00:00:00.000Z", run: "u1", type: "run.started", stage: null, data: {} }) + "\n";
  writeFileSync(join(u, "events.jsonl"), events);
  const sub = { schema: "loki.v10.receipt/1", run_id: "u1", verdict: "VERIFIED", head_sha: "h".repeat(40), events_sha256: sha(Buffer.from(events)), time: { wall_s: 0, stages: {} }, not_proven: [] };
  const h = receiptSha256(sub as never);
  writeFileSync(join(u, "receipt.json"), JSON.stringify({ ...sub, receipt_sha256: h, verification: signReceipt("u1", h) }, null, 2) + "\n");
  return { group: sealGroup(dir, receiptSha256 as never).section };
}

describe("loadSigningKey stale key temp sweep", () => {
  test("a key temp left by a killed generator is removed once old; a fresh one is kept", async () => {
    const { loadSigningKey } = await import("../../src/util/receipt_signer.ts");
    const { utimesSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "loki-signer-sweep-"));
    const prev = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];
    const keyFile = join(dir, "k.pem");
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
    try {
      const oldTmp = join(dir, "k.pem.0123456789ab.tmp"), freshTmp = join(dir, "k.pem.ba9876543210.tmp");
      writeFileSync(oldTmp, "PRIVATE-LEAK");
      writeFileSync(freshTmp, "PRIVATE-FRESH");
      const old = new Date(Date.now() - 2 * 3600 * 1000);
      utimesSync(oldTmp, old, old);
      expect(loadSigningKey(true)).not.toBeNull();
      expect(existsSync(oldTmp)).toBe(false);
      expect(existsSync(freshTmp)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildReceiptBundle", () => {
  test("receipt with evidence_screens bundles its screenshots and verifies", async () => {
    const dir = run(true, (d) => {
      mkdirSync(join(d, "evidence"), { recursive: true });
      const png = Buffer.from("fakepng");
      writeFileSync(join(d, "evidence", "home.png"), png);
      return { evidence_screens: [{ path: "evidence/home.png", sha256: sha(png) }] };
    });
    const out = join(root, "out-ev"), r = await buildReceiptBundle(dir, out);
    expect(r.ok).toBe(true);
    expect(existsSync(join(out, "evidence", "home.png"))).toBe(true);
    const pk = takePubkey(["--pubkey", join(out, "pubkey.jwk")]);
    expect((await verifyReceipt(join(out, "receipt.json"), { pubkey: pk.pubkey })).verdict).toBe("VERIFIED");
  });
  test("group receipt bundles group/ units and verifies", async () => {
    const out = join(root, "out-group"), r = await buildReceiptBundle(run(true, groupExtra), out);
    expect(r.ok).toBe(true);
    expect(existsSync(join(out, "group", "units", "u1", "receipt.json"))).toBe(true);
    const pk = takePubkey(["--pubkey", join(out, "pubkey.jwk")]);
    expect((await verifyReceipt(join(out, "receipt.json"), { pubkey: pk.pubkey })).verdict).toBe("VERIFIED");
  });
  test("receipt copied into a run dir named for another run id is refused and writes nothing", async () => {
    const src = run(true), dst = join(root, "runs", "e10-rb-copy");
    mkdirSync(dst, { recursive: true });
    for (const f of ["receipt.json", "events.jsonl"]) writeFileSync(join(dst, f), readFileSync(join(src, f)));
    const out = join(root, "out-copy"), r = await buildReceiptBundle(dst, out);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("does not match run id");
    expect(existsSync(out)).toBe(false);
  });
  test("non-empty existing outDir is refused and left untouched", async () => {
    const out = join(root, "out-busy");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "keep.txt"), "x");
    expect((await buildReceiptBundle(run(true), out)).ok).toBe(false);
    expect(readdirSync(out)).toEqual(["keep.txt"]);
  });
  test("bundle verifies VERIFIED against its own pubkey.jwk; one-byte edit is TAMPERED", async () => {
    const out = join(root, "out-ok"), r = await buildReceiptBundle(run(true), out);
    expect(r.ok).toBe(true);
    const pk = takePubkey(["--pubkey", join(out, "pubkey.jwk")]);
    expect(pk.error).toBeUndefined();
    expect((await verifyReceipt(join(out, "receipt.json"), { pubkey: pk.pubkey })).verdict).toBe("VERIFIED");
    expect(readFileSync(join(out, "VERIFY.md"), "utf8")).toContain("loki verify --pubkey pubkey.jwk receipt.json");
    const p = join(out, "receipt.json"), t = readFileSync(p, "utf8");
    writeFileSync(p, t.replace('"VERIFIED"', '"VERIFIEX"'));
    expect((await verifyReceipt(p, { pubkey: pk.pubkey })).verdict).toBe("TAMPERED");
  });
  test("unsigned run: error, outDir not created", async () => {
    expect((await buildReceiptBundle(run(true), join(root, "out-prime"))).ok).toBe(true); // creates the signing key itself
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
