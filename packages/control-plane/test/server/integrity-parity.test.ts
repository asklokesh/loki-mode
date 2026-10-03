// EL-FC08b parity: the CP integrity verifier and `loki verify` (verifyReceipt) agree on the same fixtures, so the two cannot drift.
// verifyReceipt needs receipt.json beside events.jsonl; its events_sha256 binding is what flags an edited or gapped log.
import { afterAll, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEnvelope } from "../../../../loki-ts/src/engine10/events.ts";
import { kidOf as engineKidOf } from "../../../../loki-ts/src/engine10/stages/seal.ts";
import { verifyReceipt } from "../../../../loki-ts/src/engine10/verify_cmd.ts";
import { effectiveVerdict as uiEffective } from "../../ui/src/api.ts";
import { effectiveVerdict, kidOf, verifyRunIntegrity } from "../../src/server/integrity.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const tmp = mkdtempSync(join(tmpdir(), "cp-integrity-parity-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Mut = (lines: string[]) => string[];
const cases: [string, string, Mut, boolean][] = [
  ["verified", "genuine", (l) => l, false],
  ["verified-pr", "genuine", (l) => l, false],
  ["partial", "genuine", (l) => l, false],
  ["failed", "genuine", (l) => l, false],
  ["tampered", "supervisor-detected", (l) => l, true],
  ["verified", "seq gap", (l) => l.filter((_, i) => i !== 5), true],
  ["verified", "edited payload", (l) => l.map((x, i) => (i === 4 ? x.replace(/"data":\{/, '"data":{"edited":true,') : x)), true],
  ["verified", "tail dropped", (l) => l.slice(0, -2), false], // engine: deleting the tail is a signed-receipt check (UNCHECKED here); CP: an unfinished run
];

for (const [name, label, mut, expectTampered] of cases) {
  test(`${name} / ${label}: CP and loki verify agree`, async () => {
    const dir = join(tmp, `${name}-${label.replace(/\W/g, "_")}`);
    cpSync(join(FIX, name), dir, { recursive: true });
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "");
    const out = mut(lines);
    writeFileSync(join(dir, "events.jsonl"), out.join("\n") + "\n");
    // the committed receipts carry a redacted jwt ("malformed token"); drop it (receipt_sha256 excludes `verification`) so only the log binding is judged
    const rcpt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
    writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...rcpt, verification: { ...rcpt.verification, jwt: null } }, null, 2) + "\n");
    const evs = out.map((l) => JSON.parse(l)).filter((e) => validateEnvelope(e) === null);
    const cp = verifyRunIntegrity(evs);
    const engine = await verifyReceipt(join(dir, "receipt.json"));
    expect([cp.tampered, engine.verdict === "TAMPERED"]).toEqual([expectTampered, expectTampered]);
  });
}

test("kid derivation matches the engine", () => {
  const pub = createPublicKey(generateKeyPairSync("ed25519").privateKey);
  expect(kidOf(pub)).toBe(engineKidOf(pub));
});

test("UI effectiveVerdict matches the server helper on every combination", () => {
  for (const verdict of ["VERIFIED", "verified", " Verified ", "FAILED", "PARTIAL", "ALREADY_SATISFIED", null]) for (const tampered of [true, false]) for (const attested of [true, false, undefined]) for (const sig_checked of [true, false, undefined]) {
    expect(uiEffective({ verdict, tampered, attested, sig_checked })).toBe(effectiveVerdict({ verdict, tampered, attested, sig_checked }));
  }
});
