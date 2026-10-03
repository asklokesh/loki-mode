// EL-FC08b round 2 (D86, FC-08, L2): the signed-path blocks from the D12 review, each red-then-green.
// B1 appended verdict, B2 unknown/mismatched kid, B3 no keys, S5 redaction, plus signed parity against the engine's verifyReceipt.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kidOf as engineKidOf } from "../../../../loki-ts/src/engine10/stages/seal.ts";
import { computeReceiptHash, verifyReceipt } from "../../../../loki-ts/src/engine10/verify_cmd.ts";
import { createApp } from "../../src/server/app.ts";
import { effectiveVerdict, kidOf, REDACTED_NOTE, UNCHECKED_SIG, verifyRunIntegrity } from "../../src/server/integrity.ts";

const tmp = mkdtempSync(join(tmpdir(), "cp-integrity-signed-"));
const SRC = "abcdef0123456789";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KID_ACTIVE = engineKidOf(publicKey);
const KID = KID_ACTIVE;
const pemPath = join(tmp, "pub.pem");
const savedEnv = process.env["LOKI_CP_RECEIPT_PUBKEYS"];
beforeAll(() => writeFileSync(pemPath, publicKey.export({ type: "spki", format: "pem" })));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env["LOKI_CP_RECEIPT_PUBKEYS"]; else process.env["LOKI_CP_RECEIPT_PUBKEYS"] = savedEnv;
});

const env = (run: string, seq: number, type: string, data: object, stage: string | null = null) => ({ v: 1, seq, ts: `2026-10-03T00:00:${String(seq).padStart(2, "0")}.000Z`, run, type, stage, data });
const lineOf = (e: any) => JSON.stringify({ v: e.v, seq: e.seq, ts: e.ts, run: e.run, type: e.type, stage: e.stage, data: e.data });
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

interface Built { events: any[]; receipt: Record<string, unknown> }
/** An honest signed run exactly as the engine writes it: run.started, receipt.sealed, run.completed, signed log.sealed. */
function honest(run: string, verdict = "VERIFIED", opts: { startData?: object; sealKid?: string; signer?: KeyObject; kid?: string } = {}): Built {
  const signer = opts.signer ?? privateKey, KID = opts.kid ?? KID_ACTIVE;
  const start = env(run, 0, "run.started", opts.startData ?? { task_source: "text" });
  const receipt: Record<string, unknown> = { run_id: run, verdict, events_sha256: createHash("sha256").update(lineOf(start) + "\n").digest("hex"), log_seal: true };
  const hash = computeReceiptHash(receipt);
  receipt["receipt_sha256"] = hash;
  const h = b64({ alg: "EdDSA", kid: KID }), p = b64({ receipt_sha256: hash });
  receipt["verification"] = { jwt: `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), signer).toString("base64url")}` };
  const sealed = env(run, 1, "receipt.sealed", { path: "/x/receipt.json", receipt_sha256: hash, signed: true, kid: KID, verdict }, "seal");
  const done = env(run, 2, "run.completed", { verdict, not_proven: [] });
  const sha = createHash("sha256").update([start, sealed, done].map(lineOf).join("\n") + "\n").digest("hex");
  const lsig = sign(null, Buffer.from(`${sha}:false`), signer).toString("base64url");
  const ls = env(run, 3, "log.sealed", { kid: opts.sealKid ?? KID, events_sha256: sha, tampered: false, sig: lsig });
  return { events: [start, sealed, done, ls], receipt };
}
const keys: any = (kid: string) => (kid === KID ? publicKey : undefined);
keys.configured = true;

async function viaApi(events: any[], withKeys: boolean) {
  if (withKeys) process.env["LOKI_CP_RECEIPT_PUBKEYS"] = pemPath; else delete process.env["LOKI_CP_RECEIPT_PUBKEYS"];
  const { app } = createApp({ dbPath: ":memory:" });
  const res = await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: events[0].run, events }) });
  expect(res.status).toBe(200);
  const detail = (await (await app.request(`/v1/runs/${SRC}/${events[0].run}`)).json()) as any;
  const filt = async (v: string) => ((await (await app.request(`/v1/runs?verdict=${encodeURIComponent(v)}`)).json()) as any).total as number;
  return { detail, filt };
}

// --- signed parity with the engine ---
function engineVerdict(b: Built, evs: any[]) {
  const dir = mkdtempSync(join(tmp, "e-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "receipt.json"), JSON.stringify(b.receipt));
  writeFileSync(join(dir, "events.jsonl"), evs.map(lineOf).join("\n") + "\n");
  return verifyReceipt(join(dir, "receipt.json"), { pubkey: publicKey });
}

test("signed parity: a genuine signed run is VERIFIED in the engine and attested, signature-checked in the CP", async () => {
  const b = honest("e10-sp1");
  expect((await engineVerdict(b, b.events)).verdict).toBe("VERIFIED");
  expect(verifyRunIntegrity(b.events, { pubkeyFor: keys })).toMatchObject({ tampered: false, attested: true, sig_checked: true });
});

test("signed parity (B2): a log.sealed kid that differs from the receipt kid is TAMPERED in both", async () => {
  const b = honest("e10-sp2", "VERIFIED", { sealKid: "someone-else" });
  expect((await engineVerdict(b, b.events)).verdict).toBe("TAMPERED");
  expect(verifyRunIntegrity(b.events, { pubkeyFor: keys }).tampered).toBe(true);
});

test("signed parity (B1): a verdict appended after log.sealed; the engine authenticates only the prefix, the CP is stricter and flags it", async () => {
  const b = honest("e10-sp3", "FAILED");
  const appended = [...b.events, env("e10-sp3", 4, "run.completed", { verdict: "VERIFIED", not_proven: [] })];
  expect((await engineVerdict(b, appended)).verdict).toBe("VERIFIED"); // engine ignores unauthenticated trailing lines
  expect(verifyRunIntegrity(appended, { pubkeyFor: keys }).tampered).toBe(true);
});

test("signed parity (B2): a forged signature is TAMPERED in both", async () => {
  const other = generateKeyPairSync("ed25519");
  const b = honest("e10-sp4", "VERIFIED", { signer: other.privateKey });
  expect((await engineVerdict(b, b.events)).verdict).toBe("TAMPERED");
  expect(verifyRunIntegrity(b.events, { pubkeyFor: keys }).tampered).toBe(true);
});

// --- B1 appended verdict ---
test("B1: run.completed VERIFIED appended after log.sealed to an honest FAILED run is TAMPERED and not in ?verdict=VERIFIED", async () => {
  const b = honest("e10-b1", "FAILED");
  const evs = [...b.events, env("e10-b1", 4, "run.completed", { verdict: "VERIFIED", not_proven: [] })];
  for (const withKeys of [true, false]) {
    const { detail, filt } = await viaApi(evs, withKeys);
    expect([withKeys, detail.tampered, detail.effective_verdict]).toEqual([withKeys, true, "TAMPERED"]);
    expect(await filt("VERIFIED")).toBe(0);
    expect(await filt(UNCHECKED_SIG)).toBe(0);
    expect(detail.integrity_reasons.join(" ")).toContain("more than one run.completed");
  }
});

test("B1: the CP verdict comes from the sealed prefix, so an honest FAILED run still reads FAILED", async () => {
  const { detail } = await viaApi(honest("e10-b1b", "FAILED").events, true);
  expect([detail.tampered, detail.effective_verdict]).toEqual([false, "FAILED"]);
});

test("B1: a receipt.sealed carrying a verdict after log.sealed is TAMPERED", () => {
  const b = honest("e10-b1c", "FAILED");
  const evs = [...b.events, env("e10-b1c", 4, "receipt.sealed", { path: "/x", receipt_sha256: "c".repeat(64), signed: true, kid: KID, verdict: "VERIFIED" }, "seal")];
  expect(verifyRunIntegrity(evs, { pubkeyFor: keys }).tampered).toBe(true);
});

// --- B2 unknown kid ---
test("B2: an unknown kid with keys configured is TAMPERED; the same log under the right key is VERIFIED", async () => {
  const stranger = generateKeyPairSync("ed25519");
  const b = honest("e10-b2", "VERIFIED");
  // a forger holds their own key: a fully self-consistent signed log whose kid the CP has no key for
  const evs = honest("e10-b2", "VERIFIED", { signer: stranger.privateKey, kid: kidOf(createPublicKey(stranger.privateKey)) }).events;
  const r = verifyRunIntegrity(evs, { pubkeyFor: keys });
  expect(r.tampered).toBe(true);
  expect(r.reasons.join(" ")).toContain("no configured public key");
  expect((await viaApi(evs, true)).detail.effective_verdict).toBe("TAMPERED");
  expect((await viaApi(b.events, true)).detail.effective_verdict).toBe("VERIFIED");
});

test("B2: log.sealed kid differing from the receipt.sealed kid is TAMPERED", () => {
  const b = honest("e10-b2b", "VERIFIED", { sealKid: "another-kid" });
  const r = verifyRunIntegrity(b.events, { pubkeyFor: keys });
  expect(r.tampered).toBe(true);
  expect(r.reasons.join(" ")).toContain("kid differs");
});

// --- B3 no keys ---
test("B3: with no keys configured a forger (valid-looking sha, random sig, signed:true) is never plain VERIFIED", async () => {
  const run = "e10-b3";
  const start = env(run, 0, "run.started", {});
  const sealed = env(run, 1, "receipt.sealed", { path: "/x", receipt_sha256: "d".repeat(64), signed: true, kid: "forger", verdict: "VERIFIED" }, "seal");
  const done = env(run, 2, "run.completed", { verdict: "VERIFIED", not_proven: [] });
  const sha = createHash("sha256").update([start, sealed, done].map(lineOf).join("\n") + "\n").digest("hex");
  const ls = env(run, 3, "log.sealed", { kid: "forger", events_sha256: sha, tampered: false, sig: Buffer.alloc(64, 7).toString("base64url") });
  const { detail, filt } = await viaApi([start, sealed, done, ls], false);
  expect(detail.sig_checked).toBe(false);
  expect(detail.effective_verdict).toBe(UNCHECKED_SIG);
  expect(await filt("VERIFIED")).toBe(0);
  expect(await filt(UNCHECKED_SIG)).toBe(1);
});

test("B3: the genuine signed run is plain VERIFIED only when a key checks it, and listed under ?verdict=VERIFIED", async () => {
  const b = honest("e10-b3b", "VERIFIED");
  const withKey = await viaApi(b.events, true);
  expect([withKey.detail.sig_checked, withKey.detail.effective_verdict, await withKey.filt("VERIFIED")]).toEqual([true, "VERIFIED", 1]);
  const noKey = await viaApi(b.events, false);
  expect([noKey.detail.sig_checked, noKey.detail.effective_verdict, await noKey.filt("VERIFIED")]).toEqual([false, UNCHECKED_SIG, 0]);
});

// --- S5 redaction ---
test("S5: an honest signed run whose data held an sk- token (redacted on ingest) is UNVERIFIED with a note, never TAMPERED, never VERIFIED", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const b = honest("e10-s5", "VERIFIED", { startData: { task_source: "text", note: `key ${secret}` } });
  const { detail, filt } = await viaApi(b.events, true);
  expect(JSON.stringify(detail)).not.toContain(secret);
  expect([detail.tampered, detail.attested, detail.sig_checked, detail.effective_verdict]).toEqual([false, false, false, "UNVERIFIED"]);
  expect(detail.integrity_reasons).toContain(REDACTED_NOTE);
  expect(await filt("VERIFIED")).toBe(0);
  expect(await filt("TAMPERED")).toBe(0);
  expect(await filt("UNVERIFIED")).toBe(1);
});

test("S5: an edit with no redaction placeholder is still TAMPERED", async () => {
  const b = honest("e10-s5b", "VERIFIED");
  const evs = b.events.map((e) => (e.type === "run.started" ? { ...e, data: { task_source: "edited" } } : e));
  expect((await viaApi(evs, true)).detail.effective_verdict).toBe("TAMPERED");
});

// --- advisories ---
test("a non-canonical verdict case cannot dodge the checks", () => {
  expect(effectiveVerdict({ verdict: "verified", tampered: false, attested: false })).toBe("UNVERIFIED");
  expect(effectiveVerdict({ verdict: " Verified ", tampered: false, attested: true, sig_checked: false })).toBe(UNCHECKED_SIG);
  const evs = [env("e10-case", 0, "run.started", {}), env("e10-case", 1, "run.completed", { verdict: "verified" })] as any[];
  expect(verifyRunIntegrity(evs).tampered).toBe(true); // claims VERIFIED with no receipt.sealed
});
