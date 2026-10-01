// D48 row 2b: `loki keys export` prints the receipt signer's PUBLIC JWK (with kid); `loki verify --pubkey FILE` reads a JWK or PEM. Never private bytes.
import { readFileSync } from "node:fs";
import { createPublicKey, type KeyObject } from "node:crypto";
import { kidOf, loadSigningKey } from "./stages/seal.ts";
function parsePubkey(t: string): KeyObject {
  const key = createPublicKey(t.trim().startsWith("{") ? { key: JSON.parse(t), format: "jwk" } : t);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  return key;
}
/** Strips `--pubkey <file>` from args; an unreadable or invalid key is an error (caller exits 2). */
export function takePubkey(args: readonly string[]): { args: string[]; pubkey?: KeyObject; error?: string } {
  const i = args.indexOf("--pubkey"), rest = args.filter((_, j) => j !== i && j !== i + 1);
  if (i < 0) return { args: rest };
  try { return { args: rest, pubkey: parsePubkey(readFileSync(args[i + 1] ?? "", "utf8")) }; } catch { return { args: rest, error: `cannot read an Ed25519 public key from ${args[i + 1] ?? "(missing file)"}` }; }
}
export async function main(args: readonly string[]): Promise<number> {
  const priv = args[0] === "export" ? loadSigningKey(false) : null;
  if (args[0] !== "export" || !priv) {
    process.stderr.write(args[0] === "export" ? "loki keys export: no signing key found (run a sealed build first or set LOKI_RECEIPT_SIGNING_KEY_FILE)\n" : "Usage: loki keys export\nPrint the receipt-signing PUBLIC key as a JWK with its kid. Use: loki verify --pubkey <file> <receipt|run-id>\n");
    return args[0] === "export" ? 66 : args[0] === "--help" || args[0] === "-h" ? 0 : 2;
  }
  const pub = createPublicKey(priv), { kty, crv, x } = pub.export({ format: "jwk" });
  process.stdout.write(`${JSON.stringify({ kty, crv, x, kid: kidOf(pub), alg: "EdDSA", use: "sig" })}\n`);
  return 0;
}
