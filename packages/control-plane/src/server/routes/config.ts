// CPE-14: GET and PUT /v1/config for the repo's loki.yaml. Both live on the loopback-only router.
// Writes keep comments (yaml Document API), are atomic (temp file plus rename in the same directory), use a sha256 ETag with If-Match,
// and refuse anything that looks like a secret: loki.yaml stores env var NAMES only (schemas/loki-yaml.schema.json).
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { Context } from "hono";
import { isMap, parseDocument, type Document } from "yaml";
import { audit } from "../audit.ts";
import { originOk } from "./start.ts";
import type { RouteCtx } from "./index.ts";
import schema from "../../../../../schemas/loki-yaml.schema.json";

const MAX_BODY = 100_000;
const MAX_FILE = 1_000_000;

type Json = unknown;
type Schema = { type?: string; enum?: unknown[]; pattern?: string; minLength?: number; minimum?: number; maximum?: number; exclusiveMinimum?: number; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema; items?: Schema };

const isObj = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates the JSON-Schema subset schemas/loki-yaml.schema.json uses. Returns one message per violation (paths only, never values). */
export function validateConfig(value: Json, s: Schema = schema as Schema, path = ""): string[] {
  const at = path || "(root)";
  const errs: string[] = [];
  const join2 = (k: string) => (path ? `${path}.${k}` : k);
  if (s.type === "object") {
    if (!isObj(value)) return [`${at}: must be an object`];
    for (const [k, v] of Object.entries(value)) {
      const sub = s.properties?.[k];
      if (sub) errs.push(...validateConfig(v, sub, join2(k)));
      else if (isObj(s.additionalProperties)) errs.push(...validateConfig(v, s.additionalProperties as Schema, join2(k)));
      else if (s.additionalProperties === false) errs.push(`${join2(k)}: unknown key`);
    }
  } else if (s.type === "array") {
    if (!Array.isArray(value)) return [`${at}: must be an array`];
    if (s.items) value.forEach((v, i) => errs.push(...validateConfig(v, s.items!, `${path}[${i}]`)));
  } else if (s.type === "string") {
    if (typeof value !== "string") return [`${at}: must be a string`];
    if (s.minLength !== undefined && value.length < s.minLength) errs.push(`${at}: must not be empty`);
    if (s.pattern && !new RegExp(s.pattern).test(value)) errs.push(`${at}: wrong format`);
    if (s.enum && !s.enum.includes(value)) errs.push(`${at}: must be one of ${s.enum.join(", ")}`);
  } else if (s.type === "integer" || s.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (s.type === "integer" && !Number.isInteger(value))) return [`${at}: must be ${s.type === "integer" ? "an integer" : "a number"}`];
    if (s.minimum !== undefined && value < s.minimum) errs.push(`${at}: must be at least ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errs.push(`${at}: must be at most ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) errs.push(`${at}: must be greater than ${s.exclusiveMinimum}`);
  }
  return errs;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/, /gh[pousr]_[A-Za-z0-9]{8,}/, /github_pat_[A-Za-z0-9_]{8,}/, /xox[abprs]-[A-Za-z0-9-]{4,}/,
  /AKIA[0-9A-Z]{12,}/, /AIza[0-9A-Za-z_-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+\S{8,}/i,
  /hooks\.slack\.com\/services\//i, /discord(app)?\.com\/api\/webhooks\//i, /:\/\/[^\s/:@]+:[^\s/@]+@/,
];

const entropy = (s: string): number => {
  const n = new Map<string, number>();
  for (const ch of s) n.set(ch, (n.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of n.values()) { const p = c / s.length; h -= p * Math.log2(p); }
  return h;
};

/** True when a string looks like a credential: a known token shape or a long mixed high-entropy run. */
export function looksLikeSecret(s: string): boolean {
  if (SECRET_PATTERNS.some((r) => r.test(s))) return true;
  for (const tok of s.split(/[\s/\\:,;=]+/)) {
    if (tok.length >= 24 && /^[A-Za-z0-9+_-]+$/.test(tok) && /[A-Za-z]/.test(tok) && /\d/.test(tok) && entropy(tok) >= 3.8) return true;
  }
  return false;
}

/** Paths (never values) of every key or string that looks like a secret. */
export function findSecrets(v: Json, path = ""): string[] {
  if (typeof v === "string") return looksLikeSecret(v) ? [path || "(root)"] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => findSecrets(x, `${path}[${i}]`));
  if (isObj(v)) {
    return Object.entries(v).flatMap(([k, x]) => [
      ...(looksLikeSecret(k) ? [`${path ? `${path}.` : ""}(key)`] : []),
      ...findSecrets(x, path ? `${path}.${k}` : k),
    ]);
  }
  return [];
}

const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
const canon = (v: Json): Json => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const deepEq = (a: Json, b: Json): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Applies `next` onto the document key by key, so comments on untouched nodes survive. */
function sync(doc: Document, path: string[], prev: Json, next: Json): void {
  if (isObj(next) && isObj(prev)) {
    for (const k of Object.keys(prev)) if (!(k in next)) doc.deleteIn([...path, k]);
    for (const [k, v] of Object.entries(next)) sync(doc, [...path, k], prev[k], v);
    return;
  }
  if (prev !== undefined && deepEq(prev, next)) return;
  doc.setIn(path, doc.createNode(next));
}

type Resolved = { ok: true; file: string; exists: boolean } | { ok: false; error: string };

/** loki.yaml in the repo root. A symlink is followed only when it resolves to a regular file inside the repo. */
export function resolveConfigFile(repoDir: string): Resolved {
  let root: string;
  try { root = realpathSync(repoDir); } catch { return { ok: false, error: "repo directory not found" }; }
  const p = join(root, "loki.yaml");
  let st;
  try { st = lstatSync(p); } catch { return { ok: true, file: p, exists: false }; }
  if (st.isSymbolicLink()) {
    let real: string;
    try { real = realpathSync(p); } catch { return { ok: false, error: "loki.yaml is a broken symlink" }; }
    if (!real.startsWith(root + sep)) return { ok: false, error: "loki.yaml is a symlink that resolves outside the repo" };
    if (!statSync(real).isFile()) return { ok: false, error: "loki.yaml is not a regular file" };
    return { ok: true, file: real, exists: true };
  }
  if (!st.isFile()) return { ok: false, error: "loki.yaml is not a regular file" };
  return { ok: true, file: p, exists: true };
}

function atomicWrite(file: string, text: string, mode: number): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, text);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch { /* best effort */ } throw e; }
  closeSync(fd);
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* best effort */ } throw e; }
}

const etagOf = (raw: string): string => `"${sha(raw)}"`;
const norm = (h: string | undefined): string | null => (h ? h.trim().replace(/^W\//, "").replace(/^"|"$/g, "") : null);

export function mount(ctx: RouteCtx): void {
  const { act, db, repoDir, local } = ctx;

  act.get("/v1/config", (c: Context) => {
    if (!ctx.peerIsLoopback(c)) return c.json({ error: "loopback requests only" }, 403);
    const r = resolveConfigFile(repoDir);
    if (!r.ok) return c.json({ error: r.error }, 400);
    let raw = "";
    if (r.exists) {
      if (statSync(r.file).size > MAX_FILE) return c.json({ error: "loki.yaml is too large" }, 413);
      raw = readFileSync(r.file, "utf8");
    }
    const doc = parseDocument(raw);
    let config: Json = {};
    let errors: string[] = doc.errors.map((e) => e.message.split("\n")[0]!);
    if (!errors.length) {
      config = doc.toJS({ maxAliasCount: 20 }) ?? {};
      errors = validateConfig(config);
    }
    c.header("ETag", etagOf(raw));
    return c.json({ path: "loki.yaml", exists: r.exists, etag: etagOf(raw), config, errors });
  });

  act.put("/v1/config", async (c: Context) => {
    if (!local(c)) return c.json({ error: "loopback JSON requests only" }, 403);
    if (!originOk(c.req.header("origin"))) { audit(db, { kind: "config.update", target: "loki.yaml", result: "refused", detail: "origin not allowed" }); return c.json({ error: "origin not allowed" }, 403); }
    const text = await c.req.text();
    if (text.length > MAX_BODY) return c.json({ error: "body too large" }, 413);
    const refuse = (status: 400 | 409 | 422 | 428, error: string, extra: Record<string, unknown> = {}) => {
      audit(db, { kind: "config.update", target: "loki.yaml", result: status === 409 ? "conflict" : "refused", detail: error });
      return c.json({ error, ...extra }, status);
    };
    const ifMatch = norm(c.req.header("if-match"));
    if (!ifMatch) return refuse(428, "If-Match is required");
    let body: unknown;
    try { body = JSON.parse(text); } catch { return refuse(400, "invalid JSON"); }
    const next = isObj(body) ? body.config : undefined;
    if (!isObj(next)) return refuse(400, "body must be {config: object}");

    const secrets = findSecrets(next);
    if (secrets.length) return refuse(422, "value looks like a secret; loki.yaml stores env var names only", { paths: secrets });
    const errors = validateConfig(next);
    if (errors.length) return refuse(422, "config does not match schemas/loki-yaml.schema.json", { errors });

    const r = resolveConfigFile(repoDir);
    if (!r.ok) return refuse(400, r.error);
    let raw = "";
    if (r.exists) {
      if (statSync(r.file).size > MAX_FILE) return refuse(400, "loki.yaml is too large");
      raw = readFileSync(r.file, "utf8");
    }
    if (sha(raw) !== ifMatch) return refuse(409, "loki.yaml changed since it was read", { etag: etagOf(raw) });

    const doc = parseDocument(raw);
    if (doc.errors.length) return refuse(422, "existing loki.yaml does not parse; fix it by hand first");
    if (doc.contents !== null && !isMap(doc.contents)) return refuse(422, "existing loki.yaml root is not a mapping");
    const prev = (doc.toJS({ maxAliasCount: 20 }) ?? {}) as Record<string, Json>;
    if (doc.contents === null) doc.contents = doc.createNode({}) as typeof doc.contents;
    sync(doc, [], prev, next);
    const out = String(doc);
    const back = parseDocument(out);
    if (back.errors.length || !deepEq(back.toJS(), next)) return refuse(400, "could not render the config safely");

    const changed = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((k) => !deepEq(prev[k], next[k]));
    try {
      const mode = r.exists ? statSync(r.file).mode & 0o777 : 0o644;
      if (r.exists) atomicWrite(`${r.file}.bak`, raw, 0o600);
      atomicWrite(r.file, out, mode);
    } catch (e) {
      audit(db, { kind: "config.update", target: "loki.yaml", result: "error", detail: (e as Error).message });
      return c.json({ error: "could not write loki.yaml" }, 500);
    }
    audit(db, { kind: "config.update", target: "loki.yaml", result: "updated", detail: `sections: ${changed.join(", ") || "none"}` });
    c.header("ETag", etagOf(out));
    return c.json({ ok: true, etag: etagOf(out), config: next });
  });
}
