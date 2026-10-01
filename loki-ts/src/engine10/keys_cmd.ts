// D48 row 2b: `loki keys export` prints the PUBLIC half of the receipt signer as a JWK (with kid);
// parsePubkey reads that JWK or a PEM so `loki verify --pubkey` needs no ~/.loki. Never emits private bytes.
import { readFileSync } from "node:fs";
import { createPublicKey, type KeyObject } from "node:crypto";
import { kidOf, loadSigningKey } from "./stages/seal.ts";

/** JWK JSON or PEM text to an Ed25519 public KeyObject (a private input is reduced to its public half). */
export function parsePubkey(text: string): KeyObject {
  const t = text.trim();
  const key = createPublicKey(t.startsWith("{") ? { key: JSON.parse(t), format: "jwk" } : t);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  return key;
}

/** Strips `--pubkey <file>` from args; an unreadable or invalid key is an error (caller exits 2). */
export function takePubkey(args: readonly string[]): { args: string[]; pubkey?: KeyObject; error?: string } {
  const i = args.indexOf("--pubkey");
  const rest = args.filter((_, j) => j !== i && j !== i + 1);
  if (i < 0) return { args: rest };
  try {
    return { args: rest, pubkey: parsePubkey(readFileSync(args[i + 1] ?? "", "utf8")) };
  } catch {
    return { args: rest, error: `cannot read an Ed25519 public key from ${args[i + 1] ?? "(missing file)"}` };
  }
}

export async function main(args: readonly string[]): Promise<number> {
  if (args[0] !== "export") {
    process.stdout.write("Usage: loki keys export\nPrint the receipt-signing PUBLIC key as a JWK with its kid (never the private key).\nUse with: loki verify --pubkey <file> <receipt|run-id>\n");
    return args[0] === "--help" || args[0] === "-h" ? 0 : 2;
  }
  const priv = loadSigningKey(false);
  if (!priv) {
    process.stderr.write("loki keys export: no signing key found (run a sealed build first or set LOKI_RECEIPT_SIGNING_KEY_FILE)\n");
    return 66;
  }
  const pub = createPublicKey(priv);
  const { kty, crv, x } = pub.export({ format: "jwk" });
  process.stdout.write(`${JSON.stringify({ kty, crv, x, kid: kidOf(pub), alg: "EdDSA", use: "sig" })}\n`);
  return 0;
}
