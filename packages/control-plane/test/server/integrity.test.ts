// EL-FC08b (D86, FC-08, L2): ingest verifies the log; a forged or edited log is TAMPERED and never shows VERIFIED.
import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateEnvelope } from "../../../../loki-ts/src/engine10/events.ts";
import { createApp } from "../../src/server/app.ts";
import { effectiveVerdict, verifyRunIntegrity } from "../../src/server/integrity.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const load = (n: string): any[] => readFileSync(join(FIX, n, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => validateEnvelope(e) === null);
const SRC = "abcdef0123456789";

async function ingestAndRead(evs: any[]) {
  const { app } = createApp({ dbPath: ":memory:" });
  const res = await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: evs[0].run, events: evs }) });
  expect(res.status).toBe(200);
  const detail = (await (await app.request(`/v1/runs/${SRC}/${evs[0].run}`)).json()) as any;
  const list = (await (await app.request("/v1/runs")).json()) as any;
  return { detail, row: list.runs[0], app };
}
const ev = (run: string, seq: number, type: string, data: object, stage: string | null = null) => ({ v: 1, seq, ts: `2026-10-03T00:00:0${seq}.000Z`, run, type, stage, data });

test("forged receipt.sealed (sha deadbeef) + run.completed VERIFIED is TAMPERED, not VERIFIED", async () => {
  const run = "e10-forged";
  const forged = [
    ev(run, 0, "run.started", { task_source: "text" }),
    ev(run, 1, "receipt.sealed", { path: "/x/receipt.json", receipt_sha256: "deadbeef", signed: true, verdict: "VERIFIED" }, "seal"),
    ev(run, 2, "run.completed", { verdict: "VERIFIED", not_proven: [] }),
  ];
  const { detail, row } = await ingestAndRead(forged);
  expect(detail.tampered).toBe(true);
  expect(detail.effective_verdict).toBe("TAMPERED");
  expect(row.effective_verdict).toBe("TAMPERED");
  expect(detail.integrity_reasons.join(" ")).toContain("receipt_sha256");
});

test("genuine engine runs stay VERIFIED; the tamper.detected run stays TAMPERED", async () => {
  for (const n of ["verified", "verified-pr"]) {
    const { detail } = await ingestAndRead(load(n));
    expect([n, detail.tampered, detail.attested, detail.effective_verdict]).toEqual([n, false, true, "VERIFIED"]);
  }
  expect((await ingestAndRead(load("tampered"))).detail.effective_verdict).toBe("TAMPERED");
  for (const n of ["failed", "partial", "blocked", "cap-hit", "unpriced"]) expect([n, (await ingestAndRead(load(n))).detail.tampered]).toEqual([n, false]);
});

test("seq gap in a finalised run is TAMPERED", async () => {
  const evs = load("verified");
  const gapped = evs.filter((e) => e.seq !== 5);
  const { detail } = await ingestAndRead(gapped);
  expect(detail.tampered).toBe(true);
  expect(detail.effective_verdict).toBe("TAMPERED");
  expect(detail.integrity_reasons.join(" ")).toContain("seq gap");
});

test("edited payload (hash mismatch against the sealing line) is TAMPERED", async () => {
  const evs = load("verified");
  const i = evs.findIndex((e) => e.type === "cost" || e.type === "stage.completed");
  evs[i].data = { ...evs[i].data, edited_after_the_run: true };
  const { detail } = await ingestAndRead(evs);
  expect(detail.tampered).toBe(true);
  expect(detail.effective_verdict).toBe("TAMPERED");
  expect(detail.integrity_reasons.join(" ")).toContain("does not match");
});

test("missing seal: run.completed VERIFIED with no receipt.sealed is TAMPERED", async () => {
  const evs = load("verified").filter((e) => e.type !== "receipt.sealed").map((e, i) => ({ ...e, seq: i }));
  expect((await ingestAndRead(evs)).detail.effective_verdict).toBe("TAMPERED");
});

test("unsigned VERIFIED claim is unattested: UNVERIFIED, never VERIFIED, not accused of tampering", async () => {
  const run = "e10-unsigned";
  const evs = [
    ev(run, 0, "run.started", { task_source: "text" }),
    ev(run, 1, "receipt.sealed", { path: "/x", receipt_sha256: "a".repeat(64), signed: false, verdict: "VERIFIED" }, "seal"),
    ev(run, 2, "run.completed", { verdict: "VERIFIED", not_proven: [] }),
  ];
  const { detail } = await ingestAndRead(evs);
  expect([detail.tampered, detail.attested, detail.effective_verdict]).toEqual([false, false, "UNVERIFIED"]);
});

test("a running run with a missing batch is not yet tampered", async () => {
  const run = "e10-live";
  const { detail } = await ingestAndRead([ev(run, 0, "run.started", {}), ev(run, 2, "stage.started", {}, "plan")]);
  expect(detail.tampered).toBe(false);
});

test("log seal signature is verified when the public key is known, and a bad one is TAMPERED", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const run = "e10-signed";
  const base = [
    ev(run, 0, "run.started", {}),
    ev(run, 1, "receipt.sealed", { path: "/x", receipt_sha256: "b".repeat(64), signed: true, verdict: "VERIFIED" }, "seal"),
    ev(run, 2, "run.completed", { verdict: "VERIFIED" }),
  ];
  const sha = createHash("sha256").update(base.map((e) => JSON.stringify(e)).join("\n") + "\n").digest("hex");
  const seal = (sig: Buffer) => [...base, ev(run, 3, "log.sealed", { kid: "k1", events_sha256: sha, tampered: false, sig: sig.toString("base64url") })] as any[];
  const good = seal(sign(null, Buffer.from(`${sha}:false`), privateKey));
  const keys = { pubkeyFor: (kid: string) => (kid === "k1" ? publicKey : undefined) };
  expect(verifyRunIntegrity(good, keys)).toMatchObject({ tampered: false, attested: true, sig_checked: true });
  expect(verifyRunIntegrity(good)).toMatchObject({ tampered: false, attested: true, sig_checked: false });
  expect(verifyRunIntegrity(seal(Buffer.alloc(64, 1)), keys)).toMatchObject({ tampered: true, attested: false });
});

test("effectiveVerdict never returns VERIFIED for a tampered or unattested run", () => {
  expect(effectiveVerdict({ verdict: "VERIFIED", tampered: true })).toBe("TAMPERED");
  expect(effectiveVerdict({ verdict: "VERIFIED", tampered: false, attested: false })).toBe("UNVERIFIED");
  expect(effectiveVerdict({ verdict: "VERIFIED", tampered: false, attested: true })).toBe("VERIFIED");
  expect(effectiveVerdict({ verdict: "FAILED", tampered: false, attested: false })).toBe("FAILED");
  expect(effectiveVerdict({ verdict: null, tampered: false })).toBeNull();
});
