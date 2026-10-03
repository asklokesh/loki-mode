// D48 row 2b: `loki keys export` prints the receipt signer's PUBLIC JWK (with kid); `loki verify --pubkey FILE` reads a JWK or PEM. Never private bytes.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicKey, type KeyObject } from "node:crypto";
import { kidOf, loadSigningKey } from "./stages/seal.ts";
/** Strips `--pubkey <file>` or `--pubkey=<file>`; an unknown option, a missing, empty, unreadable or repeated key, or more than one run-id is an error (caller exits 2). */
export function takePubkey(args: readonly string[]): { args: string[]; pubkey?: KeyObject; error?: string } {
  let file = "";
  try {
    const { values: { pubkey = [] }, positionals: rest } = parseArgs({ args: [...args], options: { pubkey: { type: "string", multiple: true } }, allowPositionals: true });
    if (pubkey.length > 1 || rest.length > 1) throw new Error(pubkey.length > 1 ? "--pubkey may be given only once" : `expected at most one run-id or receipt path, got ${rest.length}`);
    if (!pubkey.length) return { args: rest };
    if (!(file = pubkey[0]!)) throw new Error("--pubkey requires a file argument");
    const t = readFileSync(file, "utf8"), key = createPublicKey(t.trim().startsWith("{") ? { key: JSON.parse(t), format: "jwk" } : t);
    return key.asymmetricKeyType === "ed25519" ? { args: rest, pubkey: key } : { args: rest, error: `cannot read an Ed25519 public key from ${file}` };
  } catch (e) { return { args: [], error: file ? `cannot read an Ed25519 public key from ${file}` : (e as Error).message.replace(/^./, (c) => c.toLowerCase()) }; }
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
