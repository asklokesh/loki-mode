// CPE-16: in-process receipt verify and the public key. A signed receipt verifies; a one-field edit fails; the key route never leaks private bytes.
import { afterAll, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import { actions, localRepos } from "../../src/db/schema.ts";
import { computeReceiptHash } from "../../../../loki-ts/src/engine10/verify_cmd.ts";
import { kidOf } from "../../../../loki-ts/src/engine10/stages/seal.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const SRC = "abcdef0123456789";
const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-ver-")));
const repo = join(root, "repo");
const keyFile = join(root, "signer.pem");
const kp = generateKeyPairSync("ed25519");
const pem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
writeFileSync(keyFile, pem, { mode: 0o600 });
const prevKey = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"], prevInline = process.env["LOKI_RECEIPT_SIGNING_KEY"];
delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;

const { app, db, close } = createApp({ dbPath: ":memory:", loopbackOnly: true });
db.insert(localRepos).values({ sourceId: SRC, realpath: repo, name: "repo", discoveredAt: new Date().toISOString() }).run();
afterAll(() => {
  close();
  rmSync(root, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = prevKey;
  if (prevInline !== undefined) process.env["LOKI_RECEIPT_SIGNING_KEY"] = prevInline;
});

const peer = (address: string) => ({ requestIP: () => ({ address }) });
const post = (path: string, env: unknown = peer("127.0.0.1"), headers: Record<string, string> = { "content-type": "application/json" }) =>
  app.fetch(new Request(`http://127.0.0.1:1234${path}`, { method: "POST", body: "{}", headers: { host: "127.0.0.1:1234", ...headers } }), env as object);
const get = (path: string, env: unknown = peer("127.0.0.1")) =>
  app.fetch(new Request(`http://127.0.0.1:1234${path}`, { headers: { host: "127.0.0.1:1234" } }), env as object);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A receipt the real verifier accepts: hash recomputed, EdDSA jwt over it, no log binding (those need a full run dir). */
function signed(runId: string): Record<string, unknown> {
  const r = JSON.parse(readFileSync(join(FIX, "verified", "receipt.json"), "utf8")) as Record<string, unknown>;
  for (const k of ["events_sha256", "log_seal", "group", "screens"]) delete r[k];
  r["run_id"] = runId;
  const hash = computeReceiptHash(r);
  const head = b64({ alg: "EdDSA", kid: kidOf(createPublicKey(kp.privateKey)) }), body = b64({ receipt_sha256: hash });
  const sig = sign(null, Buffer.from(`${head}.${body}`), createPrivateKey(pem)).toString("base64url");
  r["receipt_sha256"] = hash;
  r["verification"] = { jwt: `${head}.${body}.${sig}` };
  return r;
}
const ingest = (runId: string) =>
  app.fetch(new Request("http://127.0.0.1:1234/v1/ingest", { method: "POST", headers: { host: "127.0.0.1:1234" }, body: JSON.stringify({ source: SRC, run_id: runId, events: [{ v: 1, seq: 0, ts: "2026-10-03T10:00:00Z", run: runId, type: "run.started", stage: null, data: {} }] }) }));
async function seedRun(runId: string, receipt: Record<string, unknown> | null) {
  if (receipt) {
    const dir = join(repo, ".loki", "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "receipt.json"), JSON.stringify(receipt));
  }
  return ingest(runId);
}
const verify = (run: string) => post(`/v1/runs/${SRC}/${run}/verify`);

test("a good signed receipt verifies", async () => {
  expect((await seedRun("good-1", signed("good-1"))).status).toBe(200);
  const r = await verify("good-1");
  expect(r.status).toBe(200);
  const j = (await r.json()) as { verdict: string; reasons: string[]; receipt_sha256: string };
  expect(j.verdict).toBe("VERIFIED");
  expect(j.reasons).toEqual([]);
  expect(j.receipt_sha256).toHaveLength(64);
});

test("a tampered receipt FAILS verify with the reason", async () => {
  const t = signed("bad-1");
  t["head_sha"] = "0".repeat(40);
  await seedRun("bad-1", t);
  const j = (await (await verify("bad-1")).json()) as { verdict: string; reasons: string[] };
  expect(j.verdict).toBe("TAMPERED");
  expect(j.reasons[0]).toContain("receipt_sha256 mismatch");
});

test("the committed tampered fixture is not VERIFIED, and verify wrote an audit row", async () => {
  const f = JSON.parse(readFileSync(join(FIX, "tampered", "receipt.json"), "utf8")) as Record<string, unknown>;
  await seedRun("fix-t", f);
  const j = (await (await verify("fix-t")).json()) as { verdict: string };
  expect(j.verdict).not.toBe("VERIFIED");
  expect(db.select().from(actions).all().some((a) => a.kind === "receipt.verify")).toBe(true);
});

test("verify is guarded: non-loopback peer, non-JSON, unknown run, missing receipt", async () => {
  expect((await post(`/v1/runs/${SRC}/good-1/verify`, peer("10.0.0.5"))).status).toBe(403);
  expect((await post(`/v1/runs/${SRC}/good-1/verify`, peer("127.0.0.1"), { "content-type": "text/plain" })).status).toBe(403);
  expect((await verify("nope")).status).toBe(404);
  await seedRun("no-receipt", null);
  expect((await verify("no-receipt")).status).toBe(404);
});

test("GET /v1/keys returns the public JWK only, loopback only", async () => {
  const r = await get("/v1/keys");
  expect(r.status).toBe(200);
  const text = await r.text();
  const j = JSON.parse(text) as Record<string, string>;
  expect(j["kty"]).toBe("OKP");
  expect(j["kid"]).toBe(kidOf(createPublicKey(kp.privateKey)));
  expect(j["d"]).toBeUndefined();
  expect(text).not.toContain("PRIVATE");
  expect((await get("/v1/keys", peer("10.0.0.5"))).status).toBe(403);
});
