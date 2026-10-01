// D48 row 2b: a third party holding only the public key verifies a receipt on another machine.
import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signReceipt, receiptSha256 } from "../../src/engine10/stages/seal.ts";
import { main as keysMain } from "../../src/engine10/keys_cmd.ts";
import { main as verifyMain } from "../../src/engine10/verify_cmd.ts";

const root = mkdtempSync(join(tmpdir(), "e10-portable-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const pem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;

async function cap(fn: () => Promise<number>): Promise<{ rc: number; out: string }> {
  let out = "";
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => ((out += s), true)) as never;
  try { return { rc: await fn(), out }; } finally { process.stdout.write = w; }
}
const asHome = <T>(home: string, key: string | null, fn: () => Promise<T>): Promise<T> => {
  const save = { h: process.env["HOME"], k: process.env["LOKI_RECEIPT_SIGNING_KEY"], f: process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] };
  process.env["HOME"] = home;
  delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];
  if (key) process.env["LOKI_RECEIPT_SIGNING_KEY"] = key; else delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
  return fn().finally(() => {
    for (const [n, v] of [["HOME", save.h], ["LOKI_RECEIPT_SIGNING_KEY", save.k], ["LOKI_RECEIPT_SIGNING_KEY_FILE", save.f]] as const) {
      if (v === undefined) delete process.env[n]; else process.env[n] = v;
    }
  });
};

const homeA = join(root, "homeA");
const homeB = join(root, "homeB");
mkdirSync(homeA); mkdirSync(homeB);
const keyA = pem();
const receiptPath = join(root, "receipt.json");
const pubA = join(root, "pubA.json");
let pubText = "";

describe("portable signed receipt", () => {
  test("seal under HOME A, export the public key", async () => {
    const body = { verdict: "VERIFIED", task: "portable receipt", not_proven: ["nothing extra"] };
    const hash = receiptSha256(body as never);
    const sig = await asHome(homeA, keyA, async () => signReceipt("e10-x", hash));
    writeFileSync(receiptPath, JSON.stringify({ ...body, receipt_sha256: hash, verification: sig }, null, 2) + "\n");
    const r = await asHome(homeA, keyA, () => cap(() => keysMain(["export"])));
    expect(r.rc).toBe(0);
    pubText = r.out;
    writeFileSync(pubA, pubText);
    const jwk = JSON.parse(pubText);
    expect(jwk.kid).toBe(sig.kid);
    expect(jwk.d).toBeUndefined();
    expect(pubText).not.toMatch(/PRIVATE KEY/);
  });

  test("keys export never prints private material", async () => {
    const r = await asHome(homeA, keyA, () => cap(() => keysMain(["export"])));
    expect(Object.keys(JSON.parse(r.out)).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
    expect(r.out).not.toContain(keyA.split("\n")[1]!);
  });

  test("HOME B (no ~/.loki, no key): VERIFIED rc 0 by receipt path, and a PEM public key works too", async () => {
    const r = await asHome(homeB, null, () => cap(() => verifyMain(["--pubkey", pubA, receiptPath])));
    expect(r.out).toContain("verdict: VERIFIED");
    expect(r.rc).toBe(0);
    const { createPublicKey } = await import("node:crypto");
    const pemPub = join(root, "pub.pem");
    writeFileSync(pemPub, createPublicKey(keyA).export({ type: "spki", format: "pem" }));
    expect((await asHome(homeB, null, () => cap(() => verifyMain(["--pubkey", pemPub, receiptPath])))).rc).toBe(0);
  });

  test("flipping any single byte in the hashed body is TAMPERED rc 1", async () => {
    const text = readFileSync(receiptPath, "utf8");
    const start = text.indexOf("portable receipt");
    for (const off of [0, 3, 8, 15]) {
      const i = start + off;
      const bad = text.slice(0, i) + (text[i] === "z" ? "y" : "z") + text.slice(i + 1);
      const p = join(root, `tampered-${off}.json`);
      writeFileSync(p, bad);
      const r = await asHome(homeB, null, () => cap(() => verifyMain(["--pubkey", pubA, p])));
      expect(r.rc).toBe(1);
      expect(r.out).toContain("verdict: TAMPERED");
    }
  });

  test("a forged signature with a rehashed body is TAMPERED rc 1", async () => {
    const r0 = JSON.parse(readFileSync(receiptPath, "utf8"));
    const jwt = r0.verification.jwt as string;
    const [h, p, s] = jwt.split(".");
    const flipped = s!.slice(0, -2) + (s!.endsWith("AA") ? "BB" : "AA");
    const forged = join(root, "forged.json");
    writeFileSync(forged, JSON.stringify({ ...r0, verification: { ...r0.verification, jwt: `${h}.${p}.${flipped}` } }));
    expect((await asHome(homeB, null, () => cap(() => verifyMain(["--pubkey", pubA, forged])))).rc).toBe(1);
  });

  test("--pubkey with an unsigned (jwt null) rehashed body is non-zero even with --allow-unsigned", async () => {
    const r0 = JSON.parse(readFileSync(receiptPath, "utf8"));
    const { receipt_sha256: _h, verification: _v, ...body } = r0;
    const forgedBody = { ...body, task: "forged" };
    const forged = join(root, "unsigned.json");
    writeFileSync(forged, JSON.stringify({ ...forgedBody, receipt_sha256: receiptSha256(forgedBody as never), verification: { jwt: null } }));
    for (const extra of [[], ["--allow-unsigned"]]) {
      const r = await asHome(homeB, null, () => cap(() => verifyMain([...extra, "--pubkey", pubA, forged])));
      expect(r.rc).not.toBe(0);
    }
  });

  test("success line names the supplied key", async () => {
    const r = await asHome(homeB, null, () => cap(() => verifyMain(["--pubkey", pubA, receiptPath])));
    expect(r.out).toContain("against the supplied key");
    expect(r.out).not.toContain("local JWKS");
  });

  test("a different key is UNCHECKED rc 2", async () => {
    const other = join(root, "other.json");
    await asHome(homeA, pem(), async () => writeFileSync(other, (await cap(() => keysMain(["export"]))).out));
    const r = await asHome(homeB, null, () => cap(() => verifyMain(["--pubkey", other, receiptPath])));
    expect(r.rc).toBe(2);
    expect(r.out).toContain("verdict: UNCHECKED");
  });

  test("an unreadable --pubkey file is rc 2", async () => {
    expect((await asHome(homeB, null, () => cap(() => verifyMain(["--pubkey", join(root, "nope"), receiptPath])))).rc).toBe(2);
  });
});
