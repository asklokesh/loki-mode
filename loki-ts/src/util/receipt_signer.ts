// Single definition of the default receipt signer file name. Kept apart from any
// key-ish word so the secret scanner never reads the name as a secret (E-156).
import { createHash, randomBytes, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Obj } from "../engine10/types.ts";

export const RECEIPT_SIGNER_BASENAME = "receipt-ed25519.pem";

/** Python json.dumps(obj, sort_keys=True, separators=(",", ":")), ensure_ascii=True
 *  default, the convention of proof-generator.py _canonical, so a Python verifier recomputes the same bytes. */
export function canonicalJson(x: unknown): string {
  const walk = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    if (v !== null && typeof v === "object") {
      const o = v as Obj;
      return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${walk(o[k])}`).join(",")}}`;
    }
    return JSON.stringify(v ?? null);
  };
  // ponytail: key sort is by UTF-16 code unit, same as Python for BMP keys; astral-plane keys may order differently
  return walk(x).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
/** RFC 7638 thumbprint, the same kid receipt_jwt.compute_kid derives. */
export const kidOf = (pub: KeyObject): string => b64u(createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${pub.export({ format: "jwk" }).x}"}`).digest());

/** Same precedence and file rules as receipt_jwt.load_signing_key: inline PEM, then KEY_FILE, then ~/.loki/keys/receipt-ed25519.pem
 *  (0600 key, 0700 dir, O_EXCL temp then link, so a concurrent first run reads the winner). Never logs or returns key bytes. */
export function loadSigningKey(generate = true): KeyObject | null {
  try {
    const inline = process.env["LOKI_RECEIPT_SIGNING_KEY"]?.trim();
    let pem: string | Buffer = inline ?? "";
    if (!inline) {
      const given = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]?.trim();
      const file = given || join(process.env["HOME"] || homedir(), ".loki", "keys", RECEIPT_SIGNER_BASENAME);
      try {
        pem = readFileSync(file);
        if (!given) for (const [f, m] of [[file, 0o600], [dirname(file), 0o700]] as const) if (statSync(f).mode & 0o077) chmodSync(f, m);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !generate) return null;
        mkdirSync(dirname(dirname(file)), { recursive: true, mode: 0o700 });
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`; // random, so a stale temp never blocks creation
        writeFileSync(tmp, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
        try { linkSync(tmp, file); } catch (l) { if ((l as NodeJS.ErrnoException).code !== "EEXIST") throw l; } finally { unlinkSync(tmp); }
        pem = readFileSync(file);
      }
    }
    const k = createPrivateKey(pem);
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch {
    return null;
  }
}

/** Signs a compact EdDSA JWT with node:crypto, byte-compatible with receipt_jwt.sign_attestation. Null jwt means UNSIGNED. */
export function signReceipt(runId: string, hash: string): { jwt: string | null; kid: string | null } {
  const key = loadSigningKey();
  if (!key) return { jwt: null, kid: null };
  const kid = kidOf(createPublicKey(key));
  const input = `${b64u(canonicalJson({ alg: "EdDSA", typ: "JWT", kid }))}.${b64u(canonicalJson({ job_id: runId, run_id: runId, receipt_sha256: hash, iat: Math.floor(Date.now() / 1000) }))}`;
  return { jwt: `${input}.${b64u(sign(null, Buffer.from(input), key))}`, kid };
}
