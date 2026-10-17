// TEN-ADOPTION-02: package a sealed run as a self-contained directory a third party can verify offline.
import { createPublicKey } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
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
  if (existsSync(outDir) && readdirSync(outDir).length > 0) return { ok: false, error: `${outDir} already exists and is not empty; refusing to overwrite` };
  const { kty, crv, x } = pub.export({ format: "jwk" });
  const stage = `${outDir}.tmp-${process.pid}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    copyFileSync(receiptPath, join(stage, "receipt.json"));
    copyFileSync(eventsPath, join(stage, "events.jsonl"));
    // Files verify reads beside the receipt: evidence screenshots and the group/ unit tree.
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { evidence_screens?: { path?: unknown }[] };
    for (const s of Array.isArray(receipt.evidence_screens) ? receipt.evidence_screens : []) {
      if (typeof s?.path !== "string") continue;
      const rel = normalize(s.path);
      mkdirSync(dirname(join(stage, rel)), { recursive: true });
      copyFileSync(join(runDir, rel), join(stage, rel));
    }
    if (existsSync(join(runDir, "group"))) cpSync(join(runDir, "group"), join(stage, "group"), { recursive: true });
    writeFileSync(join(stage, "pubkey.jwk"), `${JSON.stringify({ kty, crv, x, kid, alg: "EdDSA", use: "sig" })}\n`);
    writeFileSync(join(stage, "VERIFY.md"), `# Verify this Loki receipt\n\nRun from this directory. No Loki install or account is needed.\n\n\`\`\`\n${VERIFY_COMMAND}\n\`\`\`\n\nExpected: VERIFIED (exit 0). Key id: ${kid}\n\nreceipt.json and events.jsonl must stay together: verify checks the signed event log beside the receipt.\n`);
    const again = await verifyReceipt(join(stage, "receipt.json"), { pubkey: pub });
    if (again.verdict !== "VERIFIED") throw new Error(`bundle does not verify on its own: ${again.verdict}${again.reasons.length ? `: ${again.reasons.join("; ")}` : ""}`);
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true }); // empty dir only, checked above
    mkdirSync(dirname(outDir), { recursive: true });
    renameSync(stage, outDir);
    return { ok: true, outDir, kid };
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
