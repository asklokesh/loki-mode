// loki-ts/src/council/finding_schema.ts -- Phase C (v7.5.20) helpers.
//
// Loads the static JSON Schema from loki-ts/data/finding-schema.json and
// provides minimal manual validation + multi-response parsing. Both bash and
// Bun routes consume the SAME schema file (see architect design Phase C).
//
// Why manual validation (no ajv): adding ajv pulls in ~200KB of runtime deps
// for a 4-field check. We only validate the small set required by the
// AgentVerdict reconciliation: required fields, vote enum, confidence range.
// Optional fields (severity, suggested_action, issues) are tolerated when
// well-typed and silently dropped otherwise -- the schema file remains the
// authoritative spec for upstream Claude consumers.
//
// Reconciliation with AgentVerdict (council.ts:128-133):
//   schema.findings[i].vote        -> AgentVerdict.verdict
//   schema.findings[i].confidence  -> dropped (not on AgentVerdict in v7.5.20)
//   schema.findings[i].severity    -> dropped (top-level hint; issues carry it)
//   schema.findings[i].suggested_action -> dropped (carried in transcripts only)
//   schema.findings[i].issues      -> mapped onto AgentVerdict.issues
//
// Public API:
//   FINDING_SCHEMA            -- the parsed JSON Schema object (frozen)
//   validateFinding(obj)      -> AgentVerdict | { error, path }
//   parseMultiResponse(text)  -> AgentVerdict[]  (throws on malformed JSON)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath, dirname, relative, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentVerdict, Severity } from "../runner/council.ts";

// Resolve loki-ts/data relative to this module. The data dir is ../../data from src/council and ../data from the bundled dist/loki.js (the package
// ships only loki-ts/data/), the same candidate pair runner/budget.ts uses; the first candidate holding finding-schema.json wins.
const _moduleDir = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DATA_DIR_CANDIDATES: readonly (readonly string[])[] = [["..", "..", "data"], ["..", "data"]];
export function resolveSchemaDataDir(moduleDir: string = _moduleDir, candidates: readonly (readonly string[])[] = SCHEMA_DATA_DIR_CANDIDATES): string {
  for (const rel of candidates) {
    const dir = resolvePath(moduleDir, ...rel);
    if (existsSync(resolvePath(dir, "finding-schema.json"))) return dir;
  }
  return resolvePath(moduleDir, ...candidates[0]!);
}
const _dataDir = resolveSchemaDataDir();
const _schemaPath = resolvePath(_dataDir, "finding-schema.json");

export const FINDING_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze(
  JSON.parse(readFileSync(_schemaPath, "utf8")) as Record<string, unknown>,
);

/** Enum case is not guaranteed by structured outputs: trim, uppercase, and map spaces/hyphens to "_" so "high", "High" and "HIGH" tally as one value. */
export function normalizeEnumValue(v: unknown): unknown {
  return typeof v === "string" ? v.trim().toUpperCase().replace(/[\s-]+/g, "_") : v;
}

// Schema hygiene: the API compiles a schema into a grammar and caches it (and every enum, const and pattern literal in it) for 24h, so a schema must be
// static and carry no run data. The allowlist is every enum/const/pattern literal in the shipped loki-ts/data/*.json schemas.
export class SchemaLiteralError extends Error {
  constructor(public readonly kind: string, public readonly path: string, detail: number) {
    super(`schema ${kind} at ${path} is not in the static schema allowlist (${detail} chars); a judge schema must be a static file with no run-specific literals`);
    this.name = "SchemaLiteralError";
  }
}
type Literals = { values: Set<string>; patterns: Set<string> };
function collectLiterals(node: unknown, out: Literals): void {
  if (Array.isArray(node)) { for (const n of node) collectLiterals(n, out); return; }
  if (!isRecord(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "enum" && Array.isArray(v)) for (const e of v) out.values.add(String(normalizeEnumValue(e)));
    else if (k === "const") out.values.add(String(normalizeEnumValue(v)));
    else if (k === "pattern" && typeof v === "string") out.patterns.add(v);
    else collectLiterals(v, out);
  }
}
let _static: Literals | null = null;
function staticLiterals(): Literals {
  if (_static) return _static;
  const out: Literals = { values: new Set(), patterns: new Set() };
  for (const f of readdirSync(_dataDir).filter((n) => n.endsWith("-schema.json"))) {
    try { collectLiterals(JSON.parse(readFileSync(resolvePath(_dataDir, f), "utf8")), out); } catch { /* an unreadable file contributes nothing */ }
  }
  return (_static = out);
}
/** Throws SchemaLiteralError when a schema's enum, const or pattern literal is not one the static schema files already carry (case-insensitive for enum and const). */
export function assertStaticSchema(schema: unknown): void {
  const allow = staticLiterals();
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`)); return; }
    if (!isRecord(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const at = `${path}.${k}`;
      if (k === "enum" && Array.isArray(v)) { for (const e of v) if (!allow.values.has(String(normalizeEnumValue(e)))) throw new SchemaLiteralError("enum", at, String(e).length); }
      else if (k === "const") { if (!allow.values.has(String(normalizeEnumValue(v)))) throw new SchemaLiteralError("const", at, String(v).length); }
      else if (k === "pattern" && typeof v === "string") { if (!allow.patterns.has(v)) throw new SchemaLiteralError("pattern", at, v.length); }
      else walk(v, at);
    }
  };
  walk(schema, "$");
}

const VOTE_ENUM = new Set(["APPROVE", "REJECT", "CANNOT_VALIDATE"]);

const SEVERITY_ENUM = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

// A blocking issue (CRITICAL or HIGH) from a code-reviewing role should cite a
// file:line anchor (src/a.ts:42, a.ts:L42, a.ts#L42, a.ts (line 42), Makefile:3,
// or an explicit "(no file)" marker). An unanchored one is downgraded to MEDIUM
// and tagged "[unanchored]"; the finding is never rejected, so one sloppy issue
// cannot drop the rest of the council response. Evidence-based roles whose
// findings point at .loki/ state rather than code are exempt.
const BLOCKING_SEVERITY = new Set(["CRITICAL", "HIGH"]);
const ANCHOR_EXEMPT_ROLES = new Set(["requirements-verifier", "test-auditor", "convergence-voter"]);
export const UNANCHORED_TAG = "[unanchored]";
const NO_FILE_MARKER = /\(no file\)|\[no-file\]/i;
const URL_RE = /\b[a-z][a-z0-9+.-]{0,63}:\/\/\S+/gi; // bounded scheme: linear (TEN-SECURITY-26)
const ANCHOR_RE = /([\w./@-]+)[`'"]?(?::L?|#L|\s*\(line\s+)([1-9]\d*)(?!\d)/g;
const EXTENSIONLESS = /^(?:.*\/)?(?:Makefile|GNUmakefile|Dockerfile|Jenkinsfile|Rakefile|Gemfile|Procfile|Vagrantfile)$/;

export function hasFileLineAnchor(desc: string): boolean {
  if (NO_FILE_MARKER.test(desc)) return true;
  const text = desc.replace(URL_RE, " ");
  for (const m of text.matchAll(ANCHOR_RE)) {
    const tok = m[1] as string;
    if (/\.[A-Za-z][A-Za-z0-9]*$/.test(tok) || tok.includes("/") || EXTENSIONLESS.test(tok)) return true;
  }
  return false;
}

export const CITATION_NOT_FOUND_TAG = "[citation not found]";
export const CITATION_NOT_PROVEN_TAG = "[NOT PROVEN: the cited path lies under a submodule that is not checked out]";
const MAX_CITATION_FILE_BYTES = 8 * 1024 * 1024;

// Where cited paths are resolved. root = the reviewed tree (derived by the
// caller at runtime); diffFiles = paths touched by the reviewed diff, supplied
// only when the caller really has the diff. Without it nothing is downgraded.
// Downgrade happens only on positive evidence: (1) the citation matches exactly
// one file the diff does NOT touch and its line is past that file's EOF (a diff
// file may have shrunk, so a base-side line past EOF proves nothing), or (2) the
// file is on neither the disk nor the diff. A basename, a package-relative suffix or a backslash path that
// matches any file counts as resolving; an ambiguous match is never evidence.
// cwd = the directory the reviewer ran in when it is below root (a monorepo
// subdirectory); a cwd-relative citation resolves there first. diffFiles are
// root-relative, as git diff --name-only prints them. gitlinks are the diffFiles
// entries that are submodule gitlinks (mode 160000 on either side of git diff --raw).
// gitlinkDeleted are root-relative files the bump deleted inside a checked-out submodule (its old..new diff): the only way a missing path under a
// checked-out gitlink is recognized as a deletion rather than a fabrication.
export type CitationContext = { root?: string; cwd?: string; diffFiles?: readonly string[]; gitlinks?: readonly string[]; gitlinkDeleted?: readonly string[] };

type Citation = { path: string; line: number };

function extractCitations(desc: string): Citation[] {
  const out: Citation[] = [];
  const text = desc.replace(URL_RE, " ").replace(/\\/g, "/"); // a Windows path cites the same file
  for (const m of text.matchAll(ANCHOR_RE)) {
    const tok = m[1] as string;
    if (/\.[A-Za-z][A-Za-z0-9]*$/.test(tok) || tok.includes("/") || EXTENSIONLESS.test(tok)) {
      out.push({ path: tok.replace(/^\.\//, ""), line: Number(m[2]) });
    }
  }
  return out;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".loki", "dist", ".claude"]);
const MAX_WALK_ENTRIES = 100_000;
const treeFiles = new WeakMap<CitationContext, string[]>();

// Root-relative file list (bounded walk), built once per context.
function listTree(ctx: CitationContext): string[] {
  const cached = treeFiles.get(ctx);
  if (cached) return cached;
  const root = ctx.root as string, out: string[] = [], stack = [""];
  while (stack.length > 0 && out.length < MAX_WALK_ENTRIES) {
    const rel = stack.pop() as string;
    let names: import("node:fs").Dirent[] = [];
    try { names = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) stack.push(r); } else if (d.isFile()) out.push(r);
    }
  }
  treeFiles.set(ctx, out);
  return out;
}

const suffixMatches = (files: readonly string[], cited: string): string[] => {
  const c = cited.replace(/^\/+/, "");
  return files.filter((f) => f === c || f.endsWith(`/${c}`));
};

function lineCount(abs: string): number | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_CITATION_FILE_BYTES) return null;
    const body = readFileSync(abs, "utf8");
    let n = 1;
    for (let i = 0; i < body.length; i++) if (body.charCodeAt(i) === 10) n++;
    return body.endsWith("\n") ? n - 1 : n;
  } catch { return null; }
}

// "refuted" only on positive evidence; "unproven" when the path may sit in a submodule that is not checked out; everything else is "ok" (keep severity).
function citationVerdict(c: Citation, ctx: CitationContext): "refuted" | "unproven" | "ok" {
  if (ctx.diffFiles === undefined) return "ok"; // no diff: neither a missing file nor a past-EOF line is evidence
  const root = ctx.root as string;
  const touched = (f: string): boolean => ctx.diffFiles!.some((d0) => { const d = d0.replace(/\\/g, "/"); return f === d || f.startsWith(`${d}/`); }); // a submodule shows in the diff as its gitlink path only
  let files: string[] = [];
  for (const base of [ctx.cwd ?? root, root]) {
    const exact = resolvePath(base, c.path), inRoot = relative(root, exact);
    if (inRoot.startsWith("..") || isAbsolute(inRoot) || lineCount(exact) === null) continue;
    files = [inRoot.split(sep).join("/")];
    break;
  }
  if (files.length === 0) files = suffixMatches(listTree(ctx), c.path);
  if (files.length === 1) {
    if (touched(files[0] as string)) return "ok"; // the diff changed this file: the cited line may be base-side
    const n = lineCount(join(root, files[0] as string));
    return n !== null && c.line > n ? "refuted" : "ok";
  }
  if (files.length > 1) return "ok"; // ambiguous: not evidence
  if (ctx.diffFiles.some((f) => suffixMatches([f.replace(/\\/g, "/")], c.path).length > 0)) return "ok";
  // An unresolved path may sit inside a bumped submodule: a gitlink the diff lists (its entry is a directory prefix of the path), one whose final segment is a whole
  // directory component of the path (vendor/lib never matches src/libfoo/x.ts), or, for a bare basename, any gitlink. The diff names only the gitlink, so a checked-out
  // one refutes the path unless gitlinkDeleted records it; one with no content on disk cannot be searched, so the citation is unproven, never silently ok.
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^(\.?\/)+/, "");
  const deleted = (ctx.gitlinkDeleted ?? []).map(norm);
  const links = [...new Set([...(ctx.gitlinks ?? []), ...ctx.diffFiles.filter((d) => ctx.diffFiles!.some((f) => f !== d && f.startsWith(`${d}/`)) || (ctx.gitlinks ?? []).includes(d))])].map(norm);
  const parts = norm(c.path).split("/").filter(Boolean);
  const owners = new Set<string>();
  for (const base of [ctx.cwd ?? root, root]) {
    const inRoot = relative(root, resolvePath(base, c.path)).split(sep).join("/");
    if (inRoot.startsWith("..") || isAbsolute(inRoot)) continue;
    if (deleted.includes(inRoot)) return "ok";
    for (const g of links) if (inRoot === g || inRoot.startsWith(`${g}/`)) owners.add(g);
    if (touched(inRoot)) for (const d of ctx.diffFiles) if (inRoot.startsWith(`${norm(d)}/`)) owners.add(norm(d));
  }
  for (const g of links) {
    const seg = g.split("/").filter(Boolean).pop();
    if (parts.length <= 1 || parts.slice(0, -1).includes(seg as string)) owners.add(g);
  }
  if (deleted.some((d) => suffixMatches([d], c.path).length > 0)) return "ok";
  if (owners.size === 0) return "refuted";
  return [...owners].every((g) => checkedOut(root, g)) ? "refuted" : "unproven";
}

// A gitlink directory counts as checked out when it holds anything besides its .git pointer.
function checkedOut(root: string, gitlink: string): boolean {
  try { return readdirSync(join(root, gitlink)).some((n) => n !== ".git"); } catch { return false; }
}

// "refuted" when every citation is refuted; "unproven" when each is refuted or unproven and one could not be checked; otherwise "ok".
function citationStatus(desc: string, ctx: CitationContext): "refuted" | "unproven" | "ok" {
  if (!ctx.root || NO_FILE_MARKER.test(desc)) return "ok";
  const cites = extractCitations(desc);
  if (cites.length === 0) return "ok";
  const v = cites.map((c) => citationVerdict(c, ctx));
  if (v.every((x) => x === "refuted")) return "refuted";
  return v.every((x) => x !== "ok") ? "unproven" : "ok";
}

export type ValidationError = { error: string; path: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Manual validator. Returns AgentVerdict on success, structured error otherwise.
// Validates required fields, vote enum, confidence range; tolerates optional
// fields and drops them from the AgentVerdict output.
export function validateFinding(obj: unknown, ctx: CitationContext = {}): AgentVerdict | ValidationError {
  if (!isRecord(obj)) {
    return { error: "finding must be an object", path: "$" };
  }
  if (typeof obj["role"] !== "string" || obj["role"].length === 0) {
    return { error: "role must be a non-empty string", path: "$.role" };
  }
  const vote = normalizeEnumValue(obj["vote"]);
  if (typeof vote !== "string" || !VOTE_ENUM.has(vote)) {
    return {
      error: `vote must be one of APPROVE|REJECT|CANNOT_VALIDATE, got ${JSON.stringify(obj["vote"])}`,
      path: "$.vote",
    };
  }
  if (typeof obj["reason"] !== "string" || obj["reason"].length === 0) {
    return { error: "reason must be a non-empty string", path: "$.reason" };
  }
  if (obj["reason"].length > 4000) {
    return { error: "reason exceeds 4000 chars", path: "$.reason" };
  }
  if (typeof obj["confidence"] !== "number" || !Number.isFinite(obj["confidence"])) {
    return { error: "confidence must be a finite number", path: "$.confidence" };
  }
  const conf = obj["confidence"] as number;
  if (conf < 0 || conf > 1) {
    return { error: `confidence must be in [0,1], got ${conf}`, path: "$.confidence" };
  }

  // Optional issues array. Tolerated when present; mapped onto AgentVerdict.issues.
  const issuesOut: AgentVerdict["issues"] = [];
  const rawIssues = obj["issues"];
  if (rawIssues !== undefined) {
    if (!Array.isArray(rawIssues)) {
      return { error: "issues must be an array when present", path: "$.issues" };
    }
    for (let i = 0; i < rawIssues.length; i++) {
      const it = rawIssues[i];
      if (!isRecord(it)) {
        return { error: "issue must be an object", path: `$.issues[${i}]` };
      }
      const sev = normalizeEnumValue(it["severity"]);
      const desc = it["description"];
      if (typeof sev !== "string" || !SEVERITY_ENUM.has(sev)) {
        return { error: "issue.severity must be CRITICAL|HIGH|MEDIUM|LOW", path: `$.issues[${i}].severity` };
      }
      if (typeof desc !== "string" || desc.length === 0) {
        return { error: "issue.description must be a non-empty string", path: `$.issues[${i}].description` };
      }
      if (
        BLOCKING_SEVERITY.has(sev) &&
        !ANCHOR_EXEMPT_ROLES.has(obj["role"] as string) &&
        !hasFileLineAnchor(desc)
      ) {
        issuesOut.push({ severity: "MEDIUM", description: `${UNANCHORED_TAG} ${desc}` });
        continue;
      }
      if (BLOCKING_SEVERITY.has(sev) && !ANCHOR_EXEMPT_ROLES.has(obj["role"] as string)) {
        const status = citationStatus(desc, ctx);
        if (status === "refuted") {
          issuesOut.push({ severity: "MEDIUM", description: `${CITATION_NOT_FOUND_TAG} ${desc}` });
          continue;
        }
        if (status === "unproven") {
          issuesOut.push({ severity: sev as Severity, description: `${CITATION_NOT_PROVEN_TAG} ${desc}` });
          continue;
        }
      }
      issuesOut.push({ severity: sev as Severity, description: desc });
    }
  }

  return {
    role: obj["role"],
    verdict: vote as AgentVerdict["verdict"],
    reason: obj["reason"],
    issues: issuesOut,
  };
}

// parseMultiResponse extracts the first JSON object from Claude's output text
// and validates each finding. Throws on malformed JSON or on schema-level
// errors (missing top-level findings, empty array, per-finding validation).
// Caller (dispatchClaudeAgents) catches throw and falls through to heuristic.
export function parseMultiResponse(text: string, ctx: CitationContext = {}): AgentVerdict[] {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("empty response text");
  }
  // Find the first balanced JSON object in the text. Claude may emit prose
  // before/after the JSON block; we extract the substring between the first
  // '{' and its matching '}'.
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) {
    throw new Error("no JSON object found in response");
  }
  // Walk forward, counting braces (naive but handles the common case where
  // strings don't contain unbalanced braces; Claude's structured output is
  // simple JSON, not arbitrary text with brace-like content in strings).
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) {
    throw new Error("unbalanced JSON braces in response");
  }
  const jsonStr = text.slice(firstBrace, endIdx + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`malformed JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("response must be a JSON object");
  }
  const findings = parsed["findings"];
  if (!Array.isArray(findings)) {
    throw new Error("response.findings must be an array");
  }
  if (findings.length === 0) {
    throw new Error("response.findings must be non-empty");
  }

  const out: AgentVerdict[] = [];
  for (let i = 0; i < findings.length; i++) {
    const r = validateFinding(findings[i], ctx);
    if ("error" in r) {
      throw new Error(`findings[${i}] validation: ${r.error} (${r.path})`);
    }
    out.push(r);
  }
  return out;
}
