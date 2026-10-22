// Single definition of the default receipt signer file name. Kept apart from any
// key-ish word so the secret scanner never reads the name as a secret (E-156).
import { createHash, randomBytes, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { plainTestEnv } from "./check_result.ts";
import { dirname, join } from "node:path";
import { sweepStaleSecretTmp } from "./atomic.ts";
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
  lastProblem = null;
  let stage = "read";
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
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") lastProblem = `signing key file unreadable (${(e as NodeJS.ErrnoException).code ?? "error"})`;
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !generate) return null;
        mkdirSync(dirname(dirname(file)), { recursive: true, mode: 0o700 });
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        sweepStaleSecretTmp(dirname(file), [new RegExp(`^${RECEIPT_SIGNER_BASENAME.replace(/\./g, "\\.")}\\.(\\d{1,8})\\.tmp$`), new RegExp(`^${RECEIPT_SIGNER_BASENAME.replace(/\./g, "\\.")}\\.[0-9a-f]{12}\\.tmp$`)]);
        const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`; // random, so a stale temp never blocks creation
        writeFileSync(tmp, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
        try { linkSync(tmp, file); } catch (l) { if ((l as NodeJS.ErrnoException).code !== "EEXIST") throw l; } finally { unlinkSync(tmp); }
        pem = readFileSync(file);
      }
    }
    stage = "parse";
    const k = createPrivateKey(pem);
    if (k.asymmetricKeyType === "ed25519") return k;
    lastProblem = `signing key is not ed25519 (found ${k.asymmetricKeyType ?? "unknown"})`;
    return null;
  } catch {
    lastProblem ??= stage === "parse" ? "signing key is not a valid PEM private key" : "signing key could not be read or created";
    return null;
  }
}
let lastProblem: string | null = null;
/** Why the last loadSigningKey returned null, or null when it was only absent. Never holds key bytes. */
export const signingKeyProblem = (): string | null => lastProblem;

/** Signs a compact EdDSA JWT with node:crypto, byte-compatible with receipt_jwt.sign_attestation. Null jwt means UNSIGNED. */
export function signReceipt(runId: string, hash: string): { jwt: string | null; kid: string | null } {
  const key = loadSigningKey();
  if (!key) {
    if (lastProblem) process.stderr.write(`loki: receipt left UNSIGNED: ${lastProblem}\n`);
    return { jwt: null, kid: null };
  }
  const kid = kidOf(createPublicKey(key));
  const input = `${b64u(canonicalJson({ alg: "EdDSA", typ: "JWT", kid }))}.${b64u(canonicalJson({ job_id: runId, run_id: runId, receipt_sha256: hash, iat: Math.floor(Date.now() / 1000) }))}`;
  return { jwt: `${input}.${b64u(sign(null, Buffer.from(input), key))}`, kid };
}
/** Versions of the tools that ran the checks; an absent tool is null. Optional on the body, so receipts sealed before it existed still verify. */
export interface Toolchain { bun: string | null; node: string | null; python3: string | null; git: string | null }
export const TOOLCHAIN_KEYS = ["bun", "node", "python3", "git"] as const;
/** First version-looking token of `<bin> --version` output, or null when the tool is missing or prints nothing usable. */
function toolVersion(bin: string): string | null {
  try {
    const r = spawnSync(bin, ["--version"], { env: plainTestEnv(), encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? /\d+(\.\d+)+\S*/.exec(String(r.stdout))?.[0] ?? null : null;
  } catch { return null; }
}
let probeRuns = 0;
/** Times the default probe spawned its tool processes this process; the memo keeps it at one per process. */
export const toolchainProbeRuns = (): number => probeRuns;
let memo: Toolchain | null = null;
/** Drops the per-process memo (tests only). */
export const resetToolchainMemo = (): void => { memo = null; probeRuns = 0; };
/** node, python3 and git probed together in one shell with concurrent jobs; each prints one atomic `bin=line` record. */
function probeAll(): Record<string, string | null> {
  const out: Record<string, string | null> = { node: null, python3: null, git: null };
  probeRuns++;
  const job = (b: string): string => `(v=$(${b} --version 2>/dev/null) && printf '${b}=%s\\n' "$(printf %s "$v" | head -n 1)") &`;
  try {
    const r = spawnSync("/bin/sh", ["-c", `${job("node")} ${job("python3")} ${job("git")} wait`], { env: plainTestEnv(), encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of String(r.stdout ?? "").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && line.slice(0, i) in out) out[line.slice(0, i)] = /\d+(\.\d+)+\S*/.exec(line.slice(i + 1))?.[0] ?? null;
    }
  } catch { /* all stay null */ }
  return out;
}
/** Tool versions never change inside one run: the default path probes once per process and memoizes. An injected probe bypasses the memo. */
export function collectToolchain(probe?: (bin: string) => string | null): Toolchain {
  if (probe) return { bun: process.versions["bun"] ?? probe("bun"), node: probe("node"), python3: probe("python3"), git: probe("git") };
  if (!memo) {
    const p = probeAll();
    memo = { bun: process.versions["bun"] ?? toolVersion("bun"), node: p["node"]!, python3: p["python3"]!, git: p["git"]! };
  }
  return { ...memo };
}
/** --max-age value: Ns, Nm, Nh, Nd or plain seconds; returns seconds, or null when invalid or <= 0. */
function parseMaxAge(v: string): number | null {
  const m = /^(\d+)([smhd]?)$/.exec(v);
  const n = m ? Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]!] as number) : 0;
  return n > 0 && Number.isFinite(n) ? n : null;
}
/** Age check on the signed JWT iat (receipts carry no other trusted time). Runs only after integrity checks: TAMPERED and UNCHECKED pass through unchanged. */
export function applyMaxAge<R extends { verdict: string; reasons: string[] }>(result: R, receiptPath: string, raw: string, maxAge: number, now: number): R {
  if (result.verdict === "TAMPERED" || result.verdict === "UNCHECKED") return result;
  const unchecked = (reason: string): R => ({ ...result, verdict: "UNCHECKED", reasons: [...result.reasons, reason] });
  let iat: unknown;
  try {
    const jwt = ((JSON.parse(readFileSync(receiptPath, "utf8")).verification ?? {}) as { jwt?: unknown }).jwt;
    if (result.verdict === "VERIFIED" && typeof jwt === "string") iat = (JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as { iat?: unknown }).iat;
  } catch { /* no readable signed iat */ }
  if (typeof iat !== "number" || !Number.isFinite(iat)) return unchecked("no signed iat; age cannot be checked");
  const iso = new Date(iat * 1000).toISOString();
  if (iat - now / 1000 > 300) return unchecked(`receipt iat ${iso} is in the future`);
  if (now / 1000 - iat > maxAge) return unchecked(`receipt iat ${iso} is older than --max-age ${raw}`);
  return result;
}
/** Pull --max-age (Ns, Nm, Nh, Nd or seconds; also --max-age=V) out of argv. `raw` is null when absent; `error` is set when invalid or repeated. */
export function takeMaxAge(args: readonly string[]): { args: readonly string[]; raw: string | null; seconds: number; error?: string } {
  let raw: string | null = null, seconds = 0;
  if (!(args[0] === "--help" || args[0] === "-h")) {
    const i = args.findIndex((a) => a === "--max-age" || a.startsWith("--max-age="));
    if (i >= 0) {
      const eq = args[i]!.startsWith("--max-age=");
      raw = eq ? args[i]!.slice(10) : (args[i + 1] ?? "");
      const parsed = parseMaxAge(raw);
      if (parsed === null || args.some((a, j) => j > i + (eq ? 0 : 1) && (a === "--max-age" || a.startsWith("--max-age=")))) return { args, raw, seconds: 0, error: `invalid --max-age ${JSON.stringify(raw)} (use Ns, Nm, Nh, Nd or seconds, greater than 0)` };
      seconds = parsed;
      args = args.filter((_, j) => j !== i && !(!eq && j === i + 1));
    }
  }
  return { args, raw, seconds };
}

// ---- loki.deploy/1: a deploy record signed with the receipt signer and bound to the receipt that authorized it ----
export const DEPLOY_SCHEMA = "loki.deploy/1";
export interface DeployDeps {
  pubFor(kid: unknown): KeyObject | undefined; // the key for a kid, or undefined (never creates a key)
  verifyReceipt(path: string): Promise<{ verdict: string; reasons: string[] }>; // engine10 receipt.json check, injected
  attest(jwt: string, hash: string): { status: string; reason: string | null }; // JWT attestation check, injected
}
type DeployResult = { verdict: "VERIFIED" | "TAMPERED" | "UNCHECKED"; reasons: string[] };
const deployBody = (r: Obj): Obj => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "signature"));
/** Adds signature {alg,kid,sig} (Ed25519 over the canonical body, every other field covered). Null when no signing key exists. */
export function signDeployRecord(rec: Obj): Obj | null {
  const key = loadSigningKey();
  if (!key) return null;
  const body = deployBody(rec);
  return { ...body, signature: { alg: "EdDSA", kid: kidOf(createPublicKey(key)), sig: b64u(sign(null, Buffer.from(canonicalJson(body)), key)) } };
}
/** Finds the receipt a record cites (by receipt_sha256) next to it: proofs/<id>/proof.json or runs/<id>/receipt.json under the .loki dir. */
function citedReceipt(recPath: string, hash: string, explicit: string | null): string | null {
  if (explicit) return explicit;
  const root = dirname(dirname(recPath));
  for (const sub of ["proofs", "runs"]) {
    const base = join(root, sub);
    let ids: string[] = [];
    try { ids = readdirSync(base); } catch { continue; }
    for (const id of ids) {
      const p = join(base, id, sub === "proofs" ? "proof.json" : "receipt.json");
      try {
        const d = JSON.parse(readFileSync(p, "utf8")) as Obj;
        if ((sub === "proofs" ? (d["verification"] as Obj | undefined)?.["hash"] : d["receipt_sha256"]) === hash) return p;
      } catch { /* not this one */ }
    }
  }
  return null;
}
async function checkCited(path: string, hash: string, deps: DeployDeps): Promise<DeployResult> {
  const doc = JSON.parse(readFileSync(path, "utf8")) as Obj;
  if (doc["receipt_sha256"] !== undefined) {
    if (doc["receipt_sha256"] !== hash) return { verdict: "TAMPERED", reasons: ["the cited receipt has a different receipt_sha256"] };
    const r = await deps.verifyReceipt(path);
    return r.verdict === "VERIFIED" ? { verdict: "VERIFIED", reasons: [] } : { verdict: r.verdict === "TAMPERED" ? "TAMPERED" : "UNCHECKED", reasons: [`cited receipt is ${r.verdict}`, ...r.reasons] };
  }
  const v = (doc["verification"] ?? {}) as { hash?: unknown; attestation?: unknown };
  if (v.hash !== hash) return { verdict: "TAMPERED", reasons: ["the cited receipt has a different digest"] };
  if (createHash("sha256").update(canonicalJson(Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "verification")))).digest("hex") !== hash) return { verdict: "TAMPERED", reasons: ["cited receipt body does not hash to its recorded digest"] };
  if (typeof v.attestation !== "string" || !v.attestation) return { verdict: "UNCHECKED", reasons: ["cited receipt is UNSIGNED"] };
  const a = deps.attest(v.attestation, hash);
  return a.status === "verified" ? { verdict: "VERIFIED", reasons: [] } : { verdict: a.status === "tampered" ? "TAMPERED" : "UNCHECKED", reasons: [`cited receipt attestation: ${a.reason ?? a.status}`] };
}
/** Shared by deploy records and provenance docs: signature presence, kid lookup and verification. Null means the signature holds; else the verdict to return. */
function checkBodySignature(doc: Obj, deps: DeployDeps, noun: string, edited: string): DeployResult | null {
  const sig = doc["signature"] as { alg?: unknown; kid?: unknown; sig?: unknown } | undefined;
  const w = noun.split(" ")[0];
  if (!sig || typeof sig !== "object") return { verdict: "UNCHECKED", reasons: [`${noun} is unsigned (no signature)`] };
  if (sig.alg !== "EdDSA" || typeof sig.sig !== "string") return { verdict: "TAMPERED", reasons: [`malformed ${w} signature`] };
  const pub = deps.pubFor(sig.kid);
  if (!pub) return { verdict: "UNCHECKED", reasons: [`no key for kid ${String(sig.kid)} on this machine (set LOKI_RECEIPT_SIGNING_KEY_FILE or use --pubkey)`] };
  if (!verify(null, Buffer.from(canonicalJson(deployBody(doc))), pub, Buffer.from(sig.sig, "base64url"))) return { verdict: "TAMPERED", reasons: [`${w} signature does not verify (${edited} was edited)`] };
  return null;
}
/** Offline re-check of a signed deploy record. Fails closed: unsigned, unknown key, missing or non-VERIFIED cited receipt is UNCHECKED, never VERIFIED. */
export async function verifyDeployRecord(recPath: string, rec: Obj, deps: DeployDeps, receiptFile: string | null = null): Promise<DeployResult> {
  const bad = checkBodySignature(rec, deps, "deploy record", "record"); if (bad) return bad;
  const hash = rec["receipt_sha256"];
  if (typeof hash !== "string" || !hash) return { verdict: "UNCHECKED", reasons: ["deploy record cites no receipt_sha256"] };
  const path = citedReceipt(recPath, hash, receiptFile);
  if (!path) return { verdict: "UNCHECKED", reasons: [`cited receipt ${hash.slice(0, 12)} not found next to the record (pass --receipt FILE)`] };
  try { return await checkCited(path, hash, deps); } catch { return { verdict: "UNCHECKED", reasons: ["cited receipt is unreadable"] }; }
}
// ---- loki.provenance/1: a live provenance doc served at <host>/.well-known/loki-provenance.json, signed with the same key as a deploy record ----
export const PROVENANCE_SCHEMA = "loki.provenance/1";
const PROVENANCE_MAX_BYTES = 65536, PROVENANCE_TIMEOUT_MS = 5000;
/** Signs {schema, head_sha, tree_sha, receipt_sha256, run_id, built_at}; every field is covered. Null when no signing key exists. */
export function signProvenance(head_sha: string, tree_sha: string, receipt_sha256: string, run_id: string, built_at: string): Obj | null {
  return signDeployRecord({ schema: PROVENANCE_SCHEMA, head_sha, tree_sha, receipt_sha256, run_id, built_at });
}
/** Fetches <url>/.well-known/loki-provenance.json with a timeout and a 64KB cap. Any failure is a reason string, never a doc. */
async function fetchProvenance(url: string): Promise<{ doc: Obj } | { problem: string }> {
  try {
    const target = `${url.replace(/\/+$/, "")}/.well-known/loki-provenance.json`;
    const res = await fetch(target, { signal: AbortSignal.timeout(PROVENANCE_TIMEOUT_MS), redirect: "error" });
    if (res.status !== 200) return { problem: `fetch ${target} returned HTTP ${res.status}` };
    const reader = res.body?.getReader();
    if (!reader) return { problem: "provenance response has no body" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > PROVENANCE_MAX_BYTES) { await reader.cancel(); return { problem: `provenance doc is larger than ${PROVENANCE_MAX_BYTES} bytes` }; }
      chunks.push(value);
    }
    const doc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { problem: "provenance body is not a JSON object" };
    return { doc: doc as Obj };
  } catch (e) {
    return { problem: `provenance fetch failed: ${(e as Error).message}` };
  }
}
/** Signature first (TAMPERED on an edit), then --expect-sha, then the cited receipt when one is found locally or via --receipt. Fails closed. */
export async function verifyProvenanceDoc(doc: Obj, deps: DeployDeps, receiptFile: string | null, expectSha: string | null, searchFrom: string): Promise<DeployResult> {
  if (doc["schema"] !== PROVENANCE_SCHEMA) return { verdict: "UNCHECKED", reasons: [`provenance doc is not a ${PROVENANCE_SCHEMA} document`] };
  const bad = checkBodySignature(doc, deps, "provenance doc", "doc"); if (bad) return bad;
  if (expectSha !== null && doc["head_sha"] !== expectSha) return { verdict: "TAMPERED", reasons: [`head_sha ${String(doc["head_sha"])} does not equal --expect-sha ${expectSha}`] };
  const hash = doc["receipt_sha256"];
  if (typeof hash !== "string" || !hash) return { verdict: "VERIFIED", reasons: [] };
  const path = citedReceipt(searchFrom, hash, receiptFile);
  if (!path) return { verdict: "VERIFIED", reasons: [] };
  try { return await checkCited(path, hash, deps); } catch { return { verdict: "UNCHECKED", reasons: ["cited receipt is unreadable"] }; }
}
const takeFlag = (a: readonly string[], name: string): { rest: string[]; value: string | null } => {
  const i = a.indexOf(name);
  return i < 0 ? { rest: [...a], value: null } : { rest: a.filter((_, j) => j !== i && j !== i + 1), value: a[i + 1] ?? "" };
};
/** Freshness on the signed built_at of a provenance doc: stale, future, missing or unparseable is UNCHECKED (same class applyMaxAge uses). */
function applyProvenanceMaxAge(res: DeployResult, doc: Obj, raw: string, now: number): DeployResult {
  const unchecked = (reason: string): DeployResult => ({ verdict: "UNCHECKED", reasons: [...res.reasons, reason] });
  const max = parseMaxAge(raw), at = doc["built_at"], t = typeof at === "string" ? Date.parse(at) : NaN;
  if (max === null) return unchecked(`invalid --max-age ${raw}`);
  if (!Number.isFinite(t)) return unchecked("no parseable signed built_at; age cannot be checked");
  if (t - now > 300_000) return unchecked(`provenance built_at ${String(at)} is in the future`);
  if (now - t > max * 1000) return unchecked(`provenance built_at ${String(at)} is older than --max-age ${raw}`);
  return res;
}
/** `loki verify --url https://host [--expect-sha SHA] [--receipt FILE] [--pubkey FILE]` and `--sign-provenance FILE`. Null when neither flag is present. */
async function provenanceCmd(args: readonly string[], env: Parameters<typeof deployAttestCmd>[1]): Promise<number | null> {
  const sp = takeFlag(args, "--sign-provenance"), u = takeFlag(sp.rest, "--url");
  if (sp.value === null && u.value === null) return null;
  if (sp.value !== null) {
    const f = sp.value;
    let rec: Obj;
    try { rec = JSON.parse(readFileSync(f, "utf8")) as Obj; } catch { return (process.stderr.write(`loki verify: cannot read provenance input ${f}\n`), 2); }
    const str = (k: string): string | null => (typeof rec[k] === "string" && rec[k] ? (rec[k] as string) : null);
    const [h, t, r, id, at] = ["head_sha", "tree_sha", "receipt_sha256", "run_id", "built_at"].map(str);
    if (!h || !t || !r || !id || !at) return (process.stderr.write("loki verify: provenance input needs head_sha, tree_sha, receipt_sha256, run_id and built_at\n"), 2);
    const signed = signProvenance(h, t, r, id, at);
    if (!signed) return (process.stdout.write("provenance doc: UNSIGNED (no signing key)\n"), 2);
    writeFileSync(`${f}.tmp`, JSON.stringify(signed, null, 2) + "\n");
    renameSync(`${f}.tmp`, f);
    process.stdout.write(`provenance doc: signed (kid ${(signed["signature"] as { kid: string }).kid})\n`);
    return 0;
  }
  const url = u.value ?? "";
  if (!/^https?:\/\/[^\s/]+/.test(url)) return (process.stderr.write("loki verify: --url needs an http(s) URL\n"), 2);
  const rc = takeFlag(u.rest, "--receipt"), ex = takeFlag(rc.rest, "--expect-sha");
  if (ex.value === "") return (process.stderr.write("loki verify: --expect-sha needs a value\n"), 2);
  const pk = env.takePubkey(ex.rest);
  if (pk.error) return (process.stderr.write(`loki verify: ${pk.error}\n`), 2);
  if (pk.args.length) return (process.stderr.write(`loki verify: unexpected arguments with --url: ${pk.args.join(" ")}\n`), 2);
  const got = await fetchProvenance(url);
  let res: DeployResult = "problem" in got ? { verdict: "UNCHECKED" as const, reasons: [got.problem] } : await verifyProvenanceDoc(got.doc, env.make(pk.pubkey), rc.value, ex.value, join(process.cwd(), ".loki", "provenance", "p.json"));
  if (env.maxAge && res.verdict === "VERIFIED" && "doc" in got) res = applyProvenanceMaxAge(res, got.doc, env.maxAge, (env.now ?? Date.now)());
  process.stdout.write(`provenance: ${url}\nverdict: ${res.verdict}\n${res.reasons.map((x) => `  ${x}\n`).join("")}`);
  return res.verdict === "VERIFIED" ? 0 : res.verdict === "TAMPERED" ? 1 : 2;
}
/** loki verify dispatch: `--sign-deploy FILE` signs a record in place; a loki.deploy/1 file is verified. Null means the args are not a deploy record. */
export async function deployAttestCmd(args: readonly string[], env: { takePubkey(a: readonly string[]): { args: string[]; pubkey?: KeyObject; error?: string }; make(pk?: KeyObject): DeployDeps; maxAge?: string | null; now?: () => number }): Promise<number | null> {
  const prov = await provenanceCmd(args, env); if (prov !== null) return prov;
  const rc = args.indexOf("--receipt"), receiptFile = rc >= 0 ? (args[rc + 1] ?? null) : null;
  const pre = rc < 0 ? args : args.filter((_, i) => i !== rc && i !== rc + 1), si = pre.indexOf("--sign-deploy");
  const pk = env.takePubkey(si >= 0 ? pre.filter((_, i) => i !== si && i !== si + 1) : pre), deps = env.make(pk.pubkey);
  const file = si >= 0 ? pre[si + 1] : pk.args[0];
  if (!file || file.startsWith("-")) return null;
  let rec: Obj;
  try { if (statSync(file).size > 1_000_000) return null; rec = JSON.parse(readFileSync(file, "utf8")) as Obj; } catch { return si >= 0 ? (process.stderr.write(`loki verify: cannot read deploy record ${file}\n`), 2) : null; }
  if (rec === null || typeof rec !== "object" || rec["schema"] !== DEPLOY_SCHEMA) return si >= 0 ? (process.stderr.write(`loki verify: ${file} is not a ${DEPLOY_SCHEMA} record\n`), 2) : null;
  if (si < 0 && pk.error) return (process.stderr.write(`loki verify: ${pk.error}\n`), 2);
  if (si < 0 && env.maxAge) return (process.stdout.write(`deploy: ${file}\nverdict: UNCHECKED\n  --max-age is not supported on a ${DEPLOY_SCHEMA} record (no signed iat); freshness was not checked\n`), 2);
  if (si < 0 && pk.args.length > 1) return (process.stderr.write(`loki verify: unexpected arguments after the deploy record: ${pk.args.slice(1).join(" ")}\n`), 2);
  if (si >= 0) {
    const signed = signDeployRecord(rec);
    if (!signed) return (process.stdout.write("deploy record: UNSIGNED (no signing key)\n"), 2);
    writeFileSync(`${file}.tmp`, JSON.stringify(signed, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
    process.stdout.write(`deploy record: signed (kid ${(signed["signature"] as { kid: string }).kid})\n`);
    return 0;
  }
  const r = await verifyDeployRecord(file, rec, deps, receiptFile);
  process.stdout.write(`deploy: ${file}\nverdict: ${r.verdict}\n${r.reasons.map((x) => `  ${x}\n`).join("")}`);
  if (r.verdict === "VERIFIED") process.stdout.write(`receipt_sha256: ${String(rec["receipt_sha256"])}\n`);
  return r.verdict === "VERIFIED" ? 0 : r.verdict === "TAMPERED" ? 1 : 2;
}
