// EL-FC08b (D86, FC-08, L2): integrity of an INGESTED event log, run on every rebuild of a run's projection.
// Pure: no db. The same checks `loki verify` makes on events.jsonl (loki-ts/src/engine10/verify_cmd.ts: checkEventLog, checkLogSeal),
// restated over stored envelopes. Option taken for sharing: a CP-local module plus test/server/integrity-parity.test.ts, which runs both
// implementations over the same fixtures, including signed ones (unknown kid, mismatched kid, appended run.completed), so they cannot drift.
// TAMPERED means positive evidence of forgery. A log the CP cannot check (redacted before ingest) is UNVERIFIED, never TAMPERED and never VERIFIED.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "../../../../loki-ts/src/engine10/types.ts";

export interface RunIntegrity {
  /** Positive evidence of forgery, loss or edit. Always shown as TAMPERED. */
  tampered: boolean;
  /** A VERIFIED claim backed by a signed receipt.sealed and a sealing line, with a log that could be checked. False means unattested (shown UNVERIFIED). */
  attested: boolean;
  /** The sealing line's signature was verified against a configured public key. False: shape and hash chain only. */
  sig_checked: boolean;
  reasons: string[];
}
export type KeyResolver = ((kid: string) => KeyObject | undefined) & { configured?: boolean; fingerprint?: string };
export interface IntegrityOpts {
  pubkeyFor?: KeyResolver;
  /** At least one key is configured: an unknown kid is then TAMPERED, as in the engine's checkLogSeal. Defaults to pubkeyFor.configured. */
  keysConfigured?: boolean;
}

const SHA = /^[0-9a-f]{64}$/;
const SEAL_LINE = "log.sealed";
const REDACTED = /\[REDACTED(?::[A-Z_]+)?\]/;
export const REDACTED_NOTE = "log redacted before ingest; seal not checkable";
export const UNCHECKED_SIG = "VERIFIED (signature not checked)";
export const UNATTESTED_SUFFIX = " (unattested)";
/** Outcomes that claim success: each needs a signed seal, exactly like VERIFIED. */
export const SUCCESS_VERDICTS: ReadonlySet<string> = new Set(["VERIFIED", "ALREADY_SATISFIED"]);
const normVerdict = (v: string | null | undefined): string | null => (typeof v === "string" ? v.trim().toUpperCase() : null);

/** Same derivation as loki-ts/src/engine10/stages/seal.ts kidOf (parity-tested). */
export const kidOf = (pub: KeyObject): string => createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${pub.export({ format: "jwk" }).x}"}`).digest("base64url");

/** The local signer's PUBLIC half, found where `loki verify` finds it: LOKI_RECEIPT_SIGNING_KEY_FILE, else $HOME/.loki/keys/receipt-ed25519.pem.
 *  There is no separate public file on disk, so the public KeyObject is derived in memory (createPublicKey) and only that derived object is kept:
 *  the private key is never retained, logged, copied or returned, and no key is ever generated here. Absent, unreadable or non-Ed25519 means no key. */
export function localPublicKey(env: Record<string, string | undefined> = process.env): KeyObject | undefined {
  try {
    const file = env["LOKI_RECEIPT_SIGNING_KEY_FILE"]?.trim() || join(env["HOME"] || homedir(), ".loki", "keys", "receipt-ed25519.pem");
    const pub = createPublicKey(readFileSync(file));
    return pub.asymmetricKeyType === "ed25519" ? pub : undefined;
  } catch { return undefined; }
}

/** Verification keys by kid: the local signer's public half (automatic, no setup) merged with public PEM files from LOKI_CP_RECEIPT_PUBKEYS
 *  (colon-separated, for remote/team keys, like `loki verify` retired keys). Unreadable files are skipped. */
export function pubkeysFromEnv(env: Record<string, string | undefined> = process.env): KeyResolver {
  const local = localPublicKey(env);
  const listed = (env["LOKI_CP_RECEIPT_PUBKEYS"] ?? "").split(":").map((f) => f.trim()).filter(Boolean).flatMap((f) => {
    try { return [createPublicKey(readFileSync(f))]; } catch { return []; }
  });
  const keys = [...(local ? [local] : []), ...listed];
  const fn: KeyResolver = (kid) => keys.find((k) => kidOf(k) === kid);
  fn.configured = keys.length > 0;
  fn.fingerprint = createHash("sha256").update(keys.map(kidOf).sort().join(",")).digest("hex").slice(0, 16); // identifies the key set a row was judged under
  return fn;
}

// The engine writes JSON.stringify(envelope) in this key order, so a stored envelope re-serialises to the bytes it was hashed as.
const line = (e: EventEnvelope): string => JSON.stringify({ v: e.v, seq: e.seq, ts: e.ts, run: e.run, type: e.type, stage: e.stage, data: e.data });
const verdictOf = (e: EventEnvelope | undefined): string | null => (typeof e?.data["verdict"] === "string" ? e.data["verdict"].trim().toUpperCase() : null);

/** Events up to and including the sealing line (the authenticated prefix); everything when the run has none. Lines after it are unauthenticated. */
export function sealedPrefix<T extends { type: string }>(evs: readonly T[]): T[] {
  const i = evs.findIndex((e) => e.type === SEAL_LINE);
  return i < 0 ? [...evs] : evs.slice(0, i + 1);
}

export function verifyRunIntegrity(evs: readonly EventEnvelope[], opts: IntegrityOpts = {}): RunIntegrity {
  const bad: string[] = [], notes: string[] = [];
  const doneAt = evs.findIndex((e) => e.type === "run.completed");
  const sealedAt = evs.map((e, i) => (e.type === "receipt.sealed" ? i : -1)).filter((i) => i >= 0);
  const finalised = doneAt >= 0 || sealedAt.length > 0;
  const lines = evs.map(line);
  const keysConfigured = opts.keysConfigured ?? opts.pubkeyFor?.configured ?? false;
  let sigChecked = false;

  if (finalised) { // a live run may still be missing a batch; once it claims an end, every seq must be present
    const gap = evs.findIndex((e, i) => e.seq !== i);
    if (gap >= 0) bad.push(`event log has a seq gap, duplicate or missing start at position ${gap} (seq ${evs[gap]!.seq})`);
  }
  if (evs.some((e) => e.type === "tamper.detected")) bad.push("the supervisor detected events.jsonl being modified during the run");
  const firstSeal = evs.findIndex((e) => e.type === SEAL_LINE);
  if (firstSeal >= 0 && evs.slice(firstSeal + 1).some((e) => e.type === "run.completed" || e.type === "receipt.sealed" || typeof e.data["verdict"] === "string")) bad.push("a verdict-bearing event after log.sealed is unauthenticated");
  if (evs.filter((e) => e.type === "run.completed").length > 1) bad.push("more than one run.completed (a verdict appended after the seal is unauthenticated)");

  // Hash problems are tamper evidence unless a redaction placeholder explains the changed bytes.
  const hashBad: string[] = [];
  const redacted = REDACTED.test(JSON.stringify(doneAt >= 0 ? evs.slice(0, doneAt + 2).map((e) => e.data) : evs.map((e) => e.data)));

  for (const i of sealedAt) {
    const d = evs[i]!.data;
    if (typeof d["receipt_sha256"] !== "string" || !SHA.test(d["receipt_sha256"])) hashBad.push(`receipt.sealed at seq ${evs[i]!.seq} has no valid receipt_sha256`);
    const bound = d["events_sha256"]; // optional on the event: the engine keeps it in receipt.json, which the CP never sees
    if (typeof bound === "string") {
      const h = createHash("sha256");
      let ok = false;
      for (const l of lines) { if (h.copy().digest("hex") === bound) { ok = true; break; } h.update(l + "\n"); }
      if (!ok && h.digest("hex") === bound) ok = true;
      if (!ok) hashBad.push("receipt.sealed events_sha256 does not match any prefix of the ingested log");
    }
  }

  const sealLines = evs.map((e, i) => (e.type === SEAL_LINE ? i : -1)).filter((i) => i >= 0);
  if (sealLines.some((i) => i !== doneAt + 1)) bad.push(`${SEAL_LINE} is not the line right after run.completed`);
  const ls = doneAt >= 0 && evs[doneAt + 1]?.type === SEAL_LINE ? evs[doneAt + 1]!.data : null;
  const signedSeals = sealedAt.map((i) => evs[i]!.data).filter((d) => d["signed"] === true);
  const signedReceipt = signedSeals.length > 0;
  if (ls) {
    const sha = createHash("sha256").update(lines.slice(0, doneAt + 1).join("\n") + "\n").digest("hex");
    const sig = typeof ls["sig"] === "string" ? Buffer.from(ls["sig"], "base64url") : null;
    const kid = ls["kid"];
    if (ls["tampered"] !== false) bad.push(`${SEAL_LINE} line records a tamper or is malformed`);
    else if (typeof kid !== "string" || !sig || sig.length !== 64) hashBad.push(`${SEAL_LINE} line is malformed or records a tamper`);
    else {
      if (signedSeals.some((d) => typeof d["kid"] === "string" && d["kid"] !== kid)) hashBad.push(`${SEAL_LINE} kid differs from the receipt kid`);
      if (ls["events_sha256"] !== sha) hashBad.push(`${SEAL_LINE} events_sha256 does not match the ingested log`);
      else {
        const pub = opts.pubkeyFor?.(kid);
        if (pub) { sigChecked = true; if (!verify(null, Buffer.from(`${sha}:false`), pub, sig)) bad.push(`${SEAL_LINE} signature does not verify`); }
        else if (keysConfigured) bad.push(`${SEAL_LINE} kid ${kid} has no configured public key`);
      }
    }
  } else if (signedReceipt && doneAt >= 0) bad.push(`signed receipt but no ${SEAL_LINE} line after run.completed`);

  let unverifiable = false;
  if (hashBad.length > 0) {
    if (redacted) { unverifiable = true; sigChecked = false; notes.push(REDACTED_NOTE); } else bad.push(...hashBad);
  }

  // A VERIFIED claim (first run.completed only) needs a receipt sealed before it, for the same verdict.
  let claimsVerified = false;
  const claimed = doneAt >= 0 ? verdictOf(evs[doneAt]) : null;
  if (claimed !== null && SUCCESS_VERDICTS.has(claimed)) {
    claimsVerified = true;
    const before = sealedAt.filter((i) => i < doneAt);
    if (before.length === 0) bad.push(`run.completed claims ${claimed} but no receipt.sealed precedes it`);
    else if (!before.some((i) => verdictOf(evs[i]) === claimed)) bad.push(`run.completed claims ${claimed} but the sealed receipt does not`);
  }

  const tampered = bad.length > 0;
  const attested = !tampered && !unverifiable && (!claimsVerified || (signedReceipt && ls !== null));
  return { tampered, attested, sig_checked: sigChecked && !tampered, reasons: [...bad, ...notes] };
}

/** The one display verdict (FC-08). TAMPERED when the log failed integrity. When it is not attested, a success claim shows UNVERIFIED and any other verdict carries an
 *  "(unattested)" marker. An attested success whose seal no key checked shows "<verdict> (signature not checked)"; plain VERIFIED only for a signature-checked run.
 *  sig_checked undefined (older captures) reads as checked. */
export function effectiveVerdict(r: { verdict: string | null; tampered: boolean; attested?: boolean; sig_checked?: boolean }): string | null {
  if (r.tampered) return "TAMPERED";
  const v = normVerdict(r.verdict);
  if (v === null) return r.verdict;
  if (r.attested === false) return SUCCESS_VERDICTS.has(v) ? "UNVERIFIED" : `${r.verdict}${UNATTESTED_SUFFIX}`;
  if (SUCCESS_VERDICTS.has(v)) return r.sig_checked === false ? `${v} (signature not checked)` : v;
  return r.verdict;
}
