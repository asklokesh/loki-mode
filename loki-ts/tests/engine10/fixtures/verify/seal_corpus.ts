// Labelled Seal fixture corpus. Every fixture is a real run directory: a SupervisorLog events.jsonl (run.started first), a
// receipt with log_seal: true bound to that log, a receipt.sealed event, run.completed and a signed log.sealed line, the shape
// seal.ts and the supervisor write. Keys are throwaway Ed25519 keys made at build time; nothing secret is checked in.
// `loggedRun` is the helper log_seal.test.ts uses (extracted here so both share one builder).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SupervisorLog } from "../../../../src/engine10/supervisor.ts";
import { receiptSha256, signReceipt } from "../../../../src/engine10/stages/seal.ts";
import { canonicalJson, kidOf } from "../../../../src/util/receipt_signer.ts";

type Obj = Record<string, unknown>;
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export interface LoggedRun { id: string; dir: string; path: string; lines: () => string[]; put: (l: string[]) => void }
export interface LoggedRunOpts {
  tamper?: boolean; // edit log line 1 before the seal (the supervisor then appends tamper.detected)
  marker?: boolean; // log_seal: true on the receipt (default true)
  started?: Obj; // run.started data
  fields?: Obj; // extra receipt body fields (checks, diff_sha256, ...)
  events?: Array<[string, string | null, Obj]>; // extra events appended after run.started, before the seal
  pem?: string; // sign with this key (set as LOKI_RECEIPT_SIGNING_KEY for the call); omit to use the caller's environment
  unsigned?: boolean; // null jwt, no log.sealed line
  wall?: string[]; // sealed Wall copies under <run dir>/wall, recorded in the receipt
}
/** A run the way the engine writes it. A signed one ends run.started, ..., receipt.sealed, run.completed, log.sealed. */
export function loggedRun(root: string, id: string, o: LoggedRunOpts = {}): LoggedRun {
  const dir = join(root, "runs", id), ev = join(dir, "events.jsonl"), marker = o.marker ?? true;
  mkdirSync(dir, { recursive: true });
  const saved = process.env["LOKI_RECEIPT_SIGNING_KEY"];
  if (o.pem !== undefined) process.env["LOKI_RECEIPT_SIGNING_KEY"] = o.pem;
  try {
    const log = new SupervisorLog(ev, id);
    log.append("run.started", null, o.started ?? { provider: "claude" });
    for (const [t, s, d] of o.events ?? []) log.append(t, s as never, d);
    if (o.tamper) writeFileSync(ev, readFileSync(ev, "utf8").replace('"claude"', '"claudX"'));
    const fields: Obj = { ...(o.fields ?? {}) };
    if (o.wall) {
      mkdirSync(join(dir, "wall"), { recursive: true });
      fields["wall"] = { files: o.wall.map((n) => ({ path: `tests/wall/${n}`, sha256: sha(n + "\n") })), passed: true };
      for (const n of o.wall) writeFileSync(join(dir, "wall", n), n + "\n");
    }
    const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", events_sha256: sha(readFileSync(ev)), time: { wall_s: 0, stages: {} }, ...(marker ? { log_seal: true } : {}), ...fields };
    const hash = receiptSha256(body as never);
    writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: o.unsigned ? { jwt: null, kid: null } : signReceipt(id, hash) }, null, 2));
    log.append("receipt.sealed", "seal", { receipt_sha256: hash });
    log.verify();
    log.append("run.completed", null, {});
    if (!o.unsigned) log.sealLog();
  } finally {
    if (o.pem !== undefined) { if (saved === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY"]; else process.env["LOKI_RECEIPT_SIGNING_KEY"] = saved; }
  }
  return { id, dir, path: join(dir, "receipt.json"), lines: () => readFileSync(ev, "utf8").trim().split("\n"), put: (l) => writeFileSync(ev, l.join("\n") + "\n") };
}

export type SealLabel =
  | "genuine pass" | "tampered diff" | "missing check" | "deleted sealed copy" | "wrong key" | "unknown-as-pass"
  | "log edited after seal" | "log truncated after seal" | "forged log.sealed" | "deleted log.sealed" | "rehashed unsigned edit";
export const SEAL_LABELS: readonly SealLabel[] = [
  "genuine pass", "tampered diff", "missing check", "deleted sealed copy", "wrong key", "unknown-as-pass",
  "log edited after seal", "log truncated after seal", "forged log.sealed", "deleted log.sealed", "rehashed unsigned edit",
];
/** What `loki verify <run-id>` returns through main: exit 0 VERIFIED, 1 TAMPERED, 2 UNCHECKED, 3 UNSIGNED (refused), 4 run outcome not verified. */
export type SealOutcome = "VERIFIED" | "TAMPERED" | "UNCHECKED" | "UNSIGNED" | "NOT_VERIFIED";
export const EXIT_OF: Record<SealOutcome, number> = { VERIFIED: 0, TAMPERED: 1, UNCHECKED: 2, UNSIGNED: 3, NOT_VERIFIED: 4 };
export interface SealFixture { label: SealLabel; name: string; expected: SealOutcome; build(root: string): { runId: string; pubkey?: KeyObject } }

const newPem = (): string => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pubOf = (pem: string): KeyObject => createPublicKey(createPrivateKey(pem));
const kidOfPem = (pem: string): string => kidOf(pubOf(pem));
let seq = 0;
const nextId = (p: string): string => `${p}-${seq++}`;

/** A verify stage that left test.result pass lines for both checks, so the receipt's checks are backed by its bound log. */
const CHECKS = [{ name: "unit", cmd: "bun test", result: "pass", duration_s: 1.2 }, { name: "types", cmd: "tsc --noEmit", result: "pass", duration_s: 2.1 }];
const VERIFY_EVENTS: LoggedRunOpts["events"] = [["stage.started", "verify", {}], ["test.result", "verify", { name: "unit", result: "pass" }], ["test.result", "verify", { name: "types", result: "pass" }]];
const FIELDS: Obj = { task: { source: "text", sha256: "a".repeat(64) }, repo: "o/r", base_sha: "b".repeat(40), head_sha: "c".repeat(40), tree: "d".repeat(40), diff_sha256: "e".repeat(64), wall: { files: [], passed: true }, checks: CHECKS, not_proven: ["full suite"], provider: "claude", model: "claude-x", resumed: false };

function signedRun(root: string, p: string, o: LoggedRunOpts = {}): { r: LoggedRun; pem: string; pubkey: KeyObject } {
  const pem = o.pem ?? newPem(), r = loggedRun(root, nextId(p), { events: VERIFY_EVENTS, ...o, fields: { ...FIELDS, ...(o.fields ?? {}) }, pem });
  return { r, pem, pubkey: pubOf(pem) };
}
const readReceipt = (r: LoggedRun): Obj => JSON.parse(readFileSync(r.path, "utf8")) as Obj;
/** Edit receipt.json after the seal. `rehash` recomputes receipt_sha256 over the edit but leaves the old signature in place. */
function editReceipt(r: LoggedRun, f: (x: Obj) => void, rehash = false): void {
  const x = readReceipt(r);
  f(x);
  if (rehash) { const { receipt_sha256: _h, verification: _v, ...rest } = x; x["receipt_sha256"] = receiptSha256(rest as never); }
  writeFileSync(r.path, JSON.stringify(x, null, 2));
}
const setChecks = (x: Obj, f: (c: Obj[]) => Obj[]): void => { x["checks"] = f(x["checks"] as Obj[]); };
const wallCopy = (r: LoggedRun, name: string): string => join(r.dir, "wall", name);
function jwtFor(pem: string, runId: string, hash: string, headerKid: string): string {
  const input = `${b64u(canonicalJson({ alg: "EdDSA", typ: "JWT", kid: headerKid }))}.${b64u(canonicalJson({ job_id: runId, run_id: runId, receipt_sha256: hash, iat: Math.floor(Date.now() / 1000) }))}`;
  return `${input}.${b64u(sign(null, Buffer.from(input), createPrivateKey(pem)))}`;
}
/** Replace the last (log.sealed) line's data fields. */
function editSealLine(r: LoggedRun, f: (d: Obj) => void): void {
  const l = r.lines(), e = JSON.parse(l.at(-1)!) as { data: Obj };
  f(e.data);
  r.put([...l.slice(0, -1), JSON.stringify(e)]);
}

export function sealCorpus(): SealFixture[] {
  const F: SealFixture[] = [];
  const add = (label: SealLabel, name: string, expected: SealOutcome, build: (root: string) => { r: LoggedRun; pubkey?: KeyObject }): void => {
    F.push({ label, name, expected, build: (root) => { const { r, pubkey } = build(root); return { runId: r.id, ...(pubkey ? { pubkey } : {}) }; } });
  };

  // genuine pass: sealed, signed, untouched
  add("genuine pass", "signed-with-backed-checks", "VERIFIED", (root) => signedRun(root, "g"));
  add("genuine pass", "signed-with-sealed-wall", "VERIFIED", (root) => signedRun(root, "g", { wall: ["a.test.ts", "b.test.ts"] }));
  add("genuine pass", "signed-single-check", "VERIFIED", (root) => signedRun(root, "g", { events: VERIFY_EVENTS!.slice(0, 2), fields: { checks: CHECKS.slice(0, 1) } }));
  add("genuine pass", "signed-long-log", "VERIFIED", (root) => signedRun(root, "g", { events: [...VERIFY_EVENTS!, ...Array.from({ length: 40 }, (_, i): [string, string | null, Obj] => ["worker.note", null, { i }])] }));

  // tampered diff: a field of the sealed receipt changed after the seal
  add("tampered diff", "diff-sha-edited-signed", "TAMPERED", (root) => { const s = signedRun(root, "t"); editReceipt(s.r, (x) => { x["diff_sha256"] = "f".repeat(64); }); return s; });
  add("tampered diff", "head-sha-edited-unsigned", "TAMPERED", (root) => { const r = loggedRun(root, nextId("t"), { unsigned: true, events: VERIFY_EVENTS, fields: FIELDS }); editReceipt(r, (x) => { x["head_sha"] = "9".repeat(40); }); return { r }; });
  add("tampered diff", "diff-sha-edited-rehashed-keeps-old-signature", "TAMPERED", (root) => { const s = signedRun(root, "t"); editReceipt(s.r, (x) => { x["diff_sha256"] = "0".repeat(64); }, true); return s; });
  add("tampered diff", "verdict-and-diff-edited-signed", "TAMPERED", (root) => { const s = signedRun(root, "t"); editReceipt(s.r, (x) => { x["verdict"] = "FAILED"; x["diff_sha256"] = "1".repeat(64); }); return s; });

  // missing check: a recorded check removed, renamed or invented after the seal
  add("missing check", "check-removed-signed", "TAMPERED", (root) => { const s = signedRun(root, "m"); editReceipt(s.r, (x) => setChecks(x, (c) => c.slice(1))); return s; });
  add("missing check", "check-removed-rehashed-keeps-old-signature", "TAMPERED", (root) => { const s = signedRun(root, "m"); editReceipt(s.r, (x) => setChecks(x, (c) => c.slice(0, 1)), true); return s; });
  add("missing check", "all-checks-emptied-unsigned", "TAMPERED", (root) => { const r = loggedRun(root, nextId("m"), { unsigned: true, events: VERIFY_EVENTS, fields: FIELDS }); editReceipt(r, (x) => setChecks(x, () => [])); return { r }; });
  add("missing check", "pass-claimed-without-log-evidence-rehashed-unsigned", "TAMPERED", (root) => { const r = loggedRun(root, nextId("m"), { unsigned: true, events: VERIFY_EVENTS, fields: FIELDS }); editReceipt(r, (x) => setChecks(x, (c) => [...c, { name: "e2e", cmd: "x", result: "pass", duration_s: 1 }]), true); return { r }; });

  // deleted sealed copy: a sealed Wall file removed from (or edited in) the run's wall dir
  add("deleted sealed copy", "one-of-two-deleted-signed", "TAMPERED", (root) => { const s = signedRun(root, "w", { wall: ["a.test.ts", "b.test.ts"] }); rmSync(wallCopy(s.r, "a.test.ts")); return s; });
  add("deleted sealed copy", "all-deleted-dir-remains", "TAMPERED", (root) => { const s = signedRun(root, "w", { wall: ["a.test.ts", "b.test.ts"] }); for (const n of ["a.test.ts", "b.test.ts"]) rmSync(wallCopy(s.r, n)); return s; });
  add("deleted sealed copy", "middle-of-three-deleted-unsigned", "TAMPERED", (root) => { const r = loggedRun(root, nextId("w"), { unsigned: true, wall: ["a.test.ts", "b.test.ts", "c.test.ts"] }); rmSync(wallCopy(r, "b.test.ts")); return { r }; });
  add("deleted sealed copy", "copy-edited-signed", "TAMPERED", (root) => { const s = signedRun(root, "w", { wall: ["a.test.ts"] }); writeFileSync(wallCopy(s.r, "a.test.ts"), "weakened\n"); return s; });

  // wrong key: the signature cannot be tied to the key the verifier trusts
  add("wrong key", "signed-by-A-checked-with-B", "UNCHECKED", (root) => ({ r: signedRun(root, "k").r, pubkey: pubOf(newPem()) }));
  add("wrong key", "signed-by-B-claims-kid-A", "TAMPERED", (root) => {
    const a = newPem(), b = newPem(), s = signedRun(root, "k", { pem: b }); // log.sealed is B's too; only the receipt JWT is re-issued with A's kid
    const x = readReceipt(s.r); editReceipt(s.r, (y) => { y["verification"] = { jwt: jwtFor(b, s.r.id, x["receipt_sha256"] as string, kidOfPem(a)), kid: kidOfPem(a) }; });
    return { r: s.r, pubkey: pubOf(a) };
  });
  add("wrong key", "display-kid-swapped", "TAMPERED", (root) => { const s = signedRun(root, "k"); editReceipt(s.r, (x) => { x["verification"] = { ...(x["verification"] as Obj), kid: kidOfPem(newPem()) }; }); return s; });
  add("wrong key", "log-sealed-signed-by-another-key", "TAMPERED", (root) => { const s = signedRun(root, "k"), other = newPem(); editSealLine(s.r, (d) => { d["kid"] = kidOfPem(other); d["sig"] = sign(null, Buffer.from(`${String(d["events_sha256"])}:false`), createPrivateKey(other)).toString("base64url"); }); return s; });

  // unknown-as-pass: a receipt that cannot be established must never read VERIFIED
  add("unknown-as-pass", "unsigned-genuine", "UNSIGNED", (root) => ({ r: loggedRun(root, nextId("u"), { unsigned: true, events: VERIFY_EVENTS, fields: FIELDS }), pubkey: pubOf(newPem()) }));
  add("unknown-as-pass", "not-json", "UNCHECKED", (root) => { const s = signedRun(root, "u"); writeFileSync(s.r.path, "{ not json"); return s; });
  add("unknown-as-pass", "receipt-file-absent", "UNCHECKED", (root) => { const s = signedRun(root, "u"); rmSync(s.r.path); return s; });
  add("unknown-as-pass", "jwt-not-a-string", "UNCHECKED", (root) => { const s = signedRun(root, "u"); editReceipt(s.r, (x) => { x["verification"] = { jwt: 12345, kid: null }; }); return s; });
  add("unknown-as-pass", "signed-recorded-failure", "NOT_VERIFIED", (root) => signedRun(root, "u", { fields: { verdict: "FAILED" } }));

  // log edited after the seal
  add("log edited after seal", "run-started-edited-signed", "TAMPERED", (root) => { const s = signedRun(root, "e"); s.r.put(s.r.lines().map((l, i) => (i === 0 ? l.replace('"claude"', '"claudX"') : l))); return s; });
  add("log edited after seal", "test-result-flipped-signed", "TAMPERED", (root) => { const s = signedRun(root, "e"); s.r.put(s.r.lines().map((l) => l.replace('"name":"unit"', '"name":"unix"'))); return s; });
  add("log edited after seal", "line-duplicated-signed", "TAMPERED", (root) => { const s = signedRun(root, "e"), l = s.r.lines(); l.splice(2, 0, l[1]!); s.r.put(l); return s; });
  add("log edited after seal", "log-edited-unsigned", "TAMPERED", (root) => { const r = loggedRun(root, nextId("e"), { unsigned: true, events: VERIFY_EVENTS, fields: FIELDS }); r.put(r.lines().map((l) => l.replace('"claude"', '"claudX"'))); return { r }; });
  add("log edited after seal", "tampered-in-flight-signed", "TAMPERED", (root) => signedRun(root, "e", { tamper: true }));

  // log truncated after the seal
  add("log truncated after seal", "seal-completed-and-log-sealed-dropped", "TAMPERED", (root) => { const s = signedRun(root, "x"); s.r.put(s.r.lines().slice(0, -3)); return s; });
  add("log truncated after seal", "run-completed-and-log-sealed-dropped", "UNCHECKED", (root) => { const s = signedRun(root, "x"); s.r.put(s.r.lines().slice(0, -2)); return s; });
  add("log truncated after seal", "kept-only-first-line", "TAMPERED", (root) => { const s = signedRun(root, "x"); s.r.put(s.r.lines().slice(0, 1)); return s; });
  add("log truncated after seal", "events-file-deleted", "TAMPERED", (root) => { const s = signedRun(root, "x"); rmSync(join(s.r.dir, "events.jsonl")); return s; });

  // forged log.sealed line
  add("forged log.sealed", "signed-with-another-key", "TAMPERED", (root) => { const s = signedRun(root, "f"), other = newPem(); editSealLine(s.r, (d) => { d["sig"] = sign(null, Buffer.from(`${String(d["events_sha256"])}:false`), createPrivateKey(other)).toString("base64url"); }); return s; });
  add("forged log.sealed", "tampered-flag-flipped", "TAMPERED", (root) => { const s = signedRun(root, "f"); editSealLine(s.r, (d) => { d["tampered"] = true; }); return s; });
  add("forged log.sealed", "events-sha-replaced", "TAMPERED", (root) => { const s = signedRun(root, "f"); editSealLine(s.r, (d) => { d["events_sha256"] = "0".repeat(64); }); return s; });
  add("forged log.sealed", "sig-removed", "TAMPERED", (root) => { const s = signedRun(root, "f"); editSealLine(s.r, (d) => { delete d["sig"]; }); return s; });

  // deleted log.sealed line
  add("deleted log.sealed", "last-line-removed", "TAMPERED", (root) => { const s = signedRun(root, "d"); s.r.put(s.r.lines().slice(0, -1)); return s; });
  add("deleted log.sealed", "replaced-by-a-note", "TAMPERED", (root) => { const s = signedRun(root, "d"), l = s.r.lines(), e = JSON.parse(l.at(-1)!) as { type: string; data: Obj }; e.type = "worker.note"; e.data = {}; s.r.put([...l.slice(0, -1), JSON.stringify(e)]); return s; });
  add("deleted log.sealed", "swapped-with-run-completed", "TAMPERED", (root) => { const s = signedRun(root, "d"), l = s.r.lines(); s.r.put([...l.slice(0, -2), l.at(-1)!, l.at(-2)!]); return s; });

  // rehashed unsigned edit: with no signature the edit cannot be detected, and the honest verdict is UNSIGNED (never VERIFIED)
  add("rehashed unsigned edit", "diff-sha-rehashed", "UNSIGNED", (root) => { const r = loggedRun(root, nextId("h"), { unsigned: true, events: VERIFY_EVENTS, fields: FIELDS }); editReceipt(r, (x) => { x["diff_sha256"] = "7".repeat(64); }, true); return { r }; });
  add("rehashed unsigned edit", "check-removed-rehashed", "UNSIGNED", (root) => { const r = loggedRun(root, nextId("h"), { unsigned: true, events: VERIFY_EVENTS, fields: FIELDS }); editReceipt(r, (x) => setChecks(x, (c) => c.slice(1)), true); return { r }; });
  add("rehashed unsigned edit", "model-field-rehashed", "UNSIGNED", (root) => { const r = loggedRun(root, nextId("h"), { unsigned: true, events: VERIFY_EVENTS, fields: FIELDS }); editReceipt(r, (x) => { x["model"] = "other"; }, true); return { r }; });
  return F;
}
