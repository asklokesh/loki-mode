// TEN-ADOPTION-02: package a sealed run as a self-contained directory a third party can verify offline.
import { createPublicKey } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReceipt } from "../engine10/verify_cmd.ts";
import { kidOf, loadSigningKey } from "./receipt_signer.ts";

export type BundleResult = { ok: true; outDir: string; kid: string } | { ok: false; error: string };

export const VERIFY_COMMAND = "npx loki-mode verify --pubkey pubkey.jwk receipt.json";

/** Writes receipt.json, events.jsonl, pubkey.jwk (public half only) and VERIFY.md into outDir.
 *  Refuses, writing nothing, unless the run's receipt is signed and verifies locally against the signer's public key. */
export async function buildReceiptBundle(runDir: string, outDir: string): Promise<BundleResult> {
  const receiptPath = join(runDir, "receipt.json"), eventsPath = join(runDir, "events.jsonl");
  if (!existsSync(receiptPath)) return { ok: false, error: `no receipt.json in ${runDir}` };
  const priv = loadSigningKey(false);
  if (!priv) return { ok: false, error: "no receipt signing key on this machine; cannot publish a verifying public key" };
  const pub = createPublicKey(priv), kid = kidOf(pub);
  const v = await verifyReceipt(receiptPath, { pubkey: pub });
  if (v.verdict !== "VERIFIED") return { ok: false, error: `receipt is ${v.verdict}${v.reasons.length ? `: ${v.reasons.join("; ")}` : ""}; only a locally VERIFIED signed receipt can be bundled` };
  if (!existsSync(eventsPath)) return { ok: false, error: `events.jsonl missing in ${runDir}` };
  const { kty, crv, x } = pub.export({ format: "jwk" });
  mkdirSync(outDir, { recursive: true });
  copyFileSync(receiptPath, join(outDir, "receipt.json"));
  copyFileSync(eventsPath, join(outDir, "events.jsonl"));
  writeFileSync(join(outDir, "pubkey.jwk"), `${JSON.stringify({ kty, crv, x, kid, alg: "EdDSA", use: "sig" })}\n`);
  writeFileSync(join(outDir, "VERIFY.md"), `# Verify this Loki receipt\n\nRun from this directory. No Loki install or account is needed.\n\n\`\`\`\n${VERIFY_COMMAND}\n\`\`\`\n\nExpected: VERIFIED (exit 0). Key id: ${kid}\n\nreceipt.json and events.jsonl must stay together: verify checks the signed event log beside the receipt.\n`);
  return { ok: true, outDir, kid };
}
