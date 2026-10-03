// EL-FC08b (D86, FC-08, L2): integrity of an INGESTED event log, run on every rebuild of a run's projection.
// Pure: no db, no fs reads of runs. The same checks `loki verify` makes on events.jsonl (loki-ts/src/engine10/verify_cmd.ts: checkEventLog, checkLogSeal),
// restated over stored envelopes. test/server/integrity-parity.test.ts runs both over the same fixtures so they cannot drift.
// Without it a forged receipt.sealed + run.completed rendered VERIFIED, because `tampered` came only from a supervisor-written tamper.detected.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EventEnvelope } from "../../../../loki-ts/src/engine10/types.ts";

export interface RunIntegrity {
  /** Positive evidence of forgery, loss or edit. Always shown as TAMPERED. */
  tampered: boolean;
  /** A VERIFIED claim backed by a signed receipt.sealed and a sealing line. False means the claim is unattested (shown UNVERIFIED), never VERIFIED. */
  attested: boolean;
  /** The sealing line's signature was checked against a configured public key (false: no key for that kid, shape and hash chain only). */
  sig_checked: boolean;
  reasons: string[];
}
export interface IntegrityOpts { pubkeyFor?: (kid: string) => KeyObject | undefined }

const SHA = /^[0-9a-f]{64}$/;
const SEAL_LINE = "log.sealed";
/** Same derivation as loki-ts/src/engine10/stages/seal.ts kidOf (parity-tested). */
export const kidOf = (pub: KeyObject): string => createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${pub.export({ format: "jwk" }).x}"}`).digest("base64url");

/** Public keys from LOKI_CP_RECEIPT_PUBKEYS (colon-separated PEM files, like `loki verify` retired keys), by kid. Unreadable files are skipped. */
export function pubkeysFromEnv(env: Record<string, string | undefined> = process.env): (kid: string) => KeyObject | undefined {
  const keys = (env["LOKI_CP_RECEIPT_PUBKEYS"] ?? "").split(":").map((f) => f.trim()).filter(Boolean).flatMap((f) => {
    try { return [createPublicKey(readFileSync(f))]; } catch { return []; }
  });
  return (kid) => keys.find((k) => kidOf(k) === kid);
}

// The engine writes JSON.stringify(envelope) in this key order, so a stored envelope re-serialises to the bytes it was hashed as.
const line = (e: EventEnvelope): string => JSON.stringify({ v: e.v, seq: e.seq, ts: e.ts, run: e.run, type: e.type, stage: e.stage, data: e.data });

export function verifyRunIntegrity(evs: readonly EventEnvelope[], opts: IntegrityOpts = {}): RunIntegrity {
  const reasons: string[] = [];
  const doneAt = evs.findIndex((e) => e.type === "run.completed");
  const sealedAt = evs.map((e, i) => (e.type === "receipt.sealed" ? i : -1)).filter((i) => i >= 0);
  const finalised = doneAt >= 0 || sealedAt.length > 0;
  const lines = evs.map(line);
  let sigChecked = false;

  if (finalised) { // a live run may still be missing a batch; once it claims an end, every seq must be present
    const bad = evs.findIndex((e, i) => e.seq !== i);
    if (bad >= 0) reasons.push(`event log has a seq gap, duplicate or missing start at position ${bad} (seq ${evs[bad]!.seq})`);
  }
  if (evs.some((e) => e.type === "tamper.detected")) reasons.push("the supervisor detected events.jsonl being modified during the run");

  for (const i of sealedAt) {
    const d = evs[i]!.data;
    if (typeof d["receipt_sha256"] !== "string" || !SHA.test(d["receipt_sha256"])) reasons.push(`receipt.sealed at seq ${evs[i]!.seq} has no valid receipt_sha256`);
    const bound = d["events_sha256"]; // optional on the event: the engine keeps it in receipt.json, which the CP never sees
    if (typeof bound === "string") {
      const h = createHash("sha256");
      let ok = false;
      for (const l of lines) { if (h.copy().digest("hex") === bound) { ok = true; break; } h.update(l + "\n"); }
      if (!ok && h.digest("hex") === bound) ok = true;
      if (!ok) reasons.push("receipt.sealed events_sha256 does not match any prefix of the ingested log");
    }
  }

  const sealLines = evs.map((e, i) => (e.type === SEAL_LINE ? i : -1)).filter((i) => i >= 0);
  if (sealLines.some((i) => i !== doneAt + 1)) reasons.push(`${SEAL_LINE} is not the line right after run.completed`);
  const ls = doneAt >= 0 && evs[doneAt + 1]?.type === SEAL_LINE ? evs[doneAt + 1]!.data : null;
  const signedReceipt = sealedAt.some((i) => evs[i]!.data["signed"] === true);
  if (ls) {
    const sha = createHash("sha256").update(lines.slice(0, doneAt + 1).join("\n") + "\n").digest("hex");
    const sig = typeof ls["sig"] === "string" ? Buffer.from(ls["sig"], "base64url") : null;
    if (typeof ls["kid"] !== "string" || ls["tampered"] !== false || !sig || sig.length !== 64) reasons.push(`${SEAL_LINE} line is malformed or records a tamper`);
    else if (ls["events_sha256"] !== sha) reasons.push(`${SEAL_LINE} events_sha256 does not match the ingested log`);
    else {
      const pub = opts.pubkeyFor?.(ls["kid"]);
      if (pub) { sigChecked = true; if (!verify(null, Buffer.from(`${sha}:false`), pub, sig)) reasons.push(`${SEAL_LINE} signature does not verify`); }
    }
  } else if (signedReceipt && doneAt >= 0) reasons.push(`signed receipt but no ${SEAL_LINE} line after run.completed`);

  // A VERIFIED claim needs a receipt sealed before it, for the same verdict.
  let claimsVerified = false;
  if (doneAt >= 0 && evs[doneAt]!.data["verdict"] === "VERIFIED") {
    claimsVerified = true;
    const before = sealedAt.filter((i) => i < doneAt);
    if (before.length === 0) reasons.push("run.completed claims VERIFIED but no receipt.sealed precedes it");
    else if (!before.some((i) => evs[i]!.data["verdict"] === "VERIFIED")) reasons.push("run.completed claims VERIFIED but the sealed receipt does not");
  }

  const tampered = reasons.length > 0;
  const attested = !tampered && (!claimsVerified || (signedReceipt && ls !== null));
  return { tampered, attested, sig_checked: sigChecked, reasons };
}

/** The one display verdict (FC-08). TAMPERED when the log failed integrity, UNVERIFIED when a VERIFIED claim is not attested, else the raw verdict. */
export function effectiveVerdict(r: { verdict: string | null; tampered: boolean; attested?: boolean }): string | null {
  if (r.tampered) return "TAMPERED";
  if (r.verdict === "VERIFIED" && r.attested === false) return "UNVERIFIED";
  return r.verdict;
}
