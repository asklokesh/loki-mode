// INTEL-1: export the Seal receipt as an in-toto Statement v1 inside a DSSE envelope, signed with the SAME
// Ed25519 receipt key (the key type DSSE expresses natively: PureEdDSA over the PAE bytes). Reads seal.ts only.
import { sign, verify, type KeyObject } from "node:crypto";

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const PREDICATE_TYPE = "https://autonomi.dev/loki/receipt/v10";
export interface DsseEnvelope { payloadType: string; payload: string; signatures: { keyid: string; sig: string }[] }

/** DSSE v1 pre-authentication encoding: "DSSEv1" SP len(type) SP type SP len(body) SP body (lengths in bytes, decimal). */
export function pae(payloadType: string, body: Buffer): Buffer {
  const t = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${t.length} `), t, Buffer.from(` ${body.length} `), body]);
}

/** Statement v1: subject is the commit and tree the receipt covers, predicate is the receipt body unchanged. */
export function buildStatement(receipt: Record<string, unknown>): Record<string, unknown> {
  const head = receipt["head_sha"], tree = receipt["tree"];
  if (typeof head !== "string" || !/^[0-9a-f]{40,64}$/.test(head)) throw new Error("receipt has no head_sha to use as the subject");
  const digest: Record<string, string> = { gitCommit: head };
  if (typeof tree === "string" && /^[0-9a-f]{40,64}$/.test(tree)) digest["gitTree"] = tree;
  return { _type: STATEMENT_TYPE, subject: [{ name: `git+commit:${head}`, digest }], predicateType: PREDICATE_TYPE, predicate: receipt };
}

export function signEnvelope(receipt: Record<string, unknown>, priv: KeyObject, kid: string): DsseEnvelope {
  const body = Buffer.from(JSON.stringify(buildStatement(receipt)), "utf8");
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: body.toString("base64"),
    signatures: [{ keyid: kid, sig: sign(null, pae(DSSE_PAYLOAD_TYPE, body), priv).toString("base64") }],
  };
}

export const isEnvelope = (x: unknown): x is DsseEnvelope => !!x && typeof x === "object" && typeof (x as DsseEnvelope).payloadType === "string" && typeof (x as DsseEnvelope).payload === "string" && Array.isArray((x as DsseEnvelope).signatures);

export type EnvelopeCheck = { ok: true; receipt: Record<string, unknown>; kid: string } | { ok: false; unchecked?: boolean; reason: string };

/** Checks the signature over PAE (key chosen by keyid; an unknown keyid is UNCHECKED, never tried against other keys), then the statement shape and subject binding. */
export function verifyEnvelope(env: DsseEnvelope, pubFor: (kid: string) => KeyObject | undefined): EnvelopeCheck {
  if (env.payloadType !== DSSE_PAYLOAD_TYPE) return { ok: false, reason: `unexpected payloadType: ${env.payloadType}` };
  const body = Buffer.from(env.payload, "base64");
  let unknown = "", kid = "";
  for (const s of env.signatures) {
    if (!s || typeof s.keyid !== "string" || typeof s.sig !== "string") continue;
    const pub = pubFor(s.keyid);
    if (!pub) { unknown = s.keyid; continue; }
    if (verify(null, pae(env.payloadType, body), pub, Buffer.from(s.sig, "base64"))) { kid = s.keyid; break; }
  }
  if (!kid) return unknown && env.signatures.length === 1 ? { ok: false, unchecked: true, reason: `no key for keyid ${unknown} on this machine (use --pubkey FILE)` } : { ok: false, reason: "DSSE signature does not verify" };
  let st: Record<string, unknown>;
  try { st = JSON.parse(body.toString("utf8")); } catch { return { ok: false, reason: "payload is not JSON" }; }
  if (st["_type"] !== STATEMENT_TYPE) return { ok: false, reason: "payload is not an in-toto Statement v1" };
  if (st["predicateType"] !== PREDICATE_TYPE) return { ok: false, reason: `unexpected predicateType: ${String(st["predicateType"])}` };
  const receipt = st["predicate"] as Record<string, unknown> | undefined;
  if (!receipt || typeof receipt !== "object") return { ok: false, reason: "statement has no predicate" };
  const dig = ((st["subject"] as { digest?: Record<string, unknown> }[] | undefined)?.[0]?.digest) ?? {};
  if (dig["gitCommit"] !== receipt["head_sha"] || (dig["gitTree"] !== undefined && dig["gitTree"] !== receipt["tree"])) return { ok: false, reason: "subject digest does not match the receipt head_sha/tree" };
  return { ok: true, receipt, kid };
}

export interface DsseVerifyDeps {
  pubFor: (kid: string) => KeyObject | undefined;
  hash: (receipt: Record<string, unknown>) => string; // the receipt's own receipt_sha256 recomputation, injected so this module never imports seal.ts or verify_cmd.ts
  attest: (jwt: string, hash: string) => { status: "verified" | "tampered" | "unchecked"; reason: string | null };
}
/** A DSSE envelope is VERIFIED only if its signature, the embedded receipt hash and the receipt's own Ed25519 attestation all hold. events.jsonl is not part of the envelope. */
export function verifyDsseReceipt(env: DsseEnvelope, d: DsseVerifyDeps): { verdict: "VERIFIED" | "TAMPERED" | "UNCHECKED"; reasons: string[]; receiptSha256?: string } {
  const c = verifyEnvelope(env, d.pubFor);
  if (!c.ok) return { verdict: c.unchecked ? "UNCHECKED" : "TAMPERED", reasons: [c.reason] };
  const computed = d.hash(c.receipt);
  if (c.receipt["receipt_sha256"] !== computed) return { verdict: "TAMPERED", reasons: [`receipt_sha256 mismatch: recorded ${JSON.stringify(c.receipt["receipt_sha256"])}, computed ${computed}`] };
  const jwt = (c.receipt["verification"] as { jwt?: unknown } | undefined)?.jwt;
  const o = typeof jwt === "string" ? d.attest(jwt, computed) : { status: "tampered" as const, reason: "receipt carries no attestation" };
  if (o.status !== "verified") return { verdict: o.status === "tampered" ? "TAMPERED" : "UNCHECKED", reasons: [o.reason ?? "attestation invalid"] };
  return { verdict: "VERIFIED", reasons: [], receiptSha256: computed };
}
