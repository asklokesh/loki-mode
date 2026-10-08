// T10: supply-chain guard v1. Finds dependencies newly added by the change (manifest diff base..head)
// and checks npm / PyPI that each exists and was first published at least 7 days ago.
// Off with LOKI_SUPPLY_GUARD=0 (receipt byte-identical to before). Registry access is injectable.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { run } from "../util/shell.ts";

export type SupplyStatus = "ok" | "nonexistent" | "too_new" | "allowlisted" | "unreachable" | "unsupported";
export interface SupplyEntry { ecosystem: string; name: string; manifest: string; status: SupplyStatus; age_days?: number }
export interface SupplyBlock { guard: "v1"; min_age_days: number; entries: SupplyEntry[] }
export interface SupplyResult { block: SupplyBlock | null; notProven: string[]; blocked: boolean }
export interface RegistryReply { status: number; json?: unknown }
export type RegistryFetcher = (url: string, timeoutMs: number) => Promise<RegistryReply>;

export const MIN_AGE_DAYS = 7;
const MAX_CHECKED = 50;
const DAY_MS = 86400000;

export function supplyEnabled(env: NodeJS.ProcessEnv): boolean { return env["LOKI_SUPPLY_GUARD"] !== "0"; }

export const defaultFetcher: RegistryFetcher = async (url, timeoutMs) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (r.status === 200) return { status: 200, json: await r.json() };
  return { status: r.status };
};

type Eco = "npm" | "pypi" | "go" | "cargo";
export function manifestEcosystem(path: string): Eco | null {
  const b = basename(path);
  if (b === "package.json") return "npm";
  if (/^requirements.*\.txt$/.test(b) || b === "pyproject.toml") return "pypi";
  if (b === "go.mod") return "go";
  if (b === "Cargo.toml") return "cargo";
  return null;
}

const pyNorm = (n: string): string => n.toLowerCase().replace(/[-_.]+/g, "-");

function npmDeps(text: string): string[] {
  let j: Record<string, unknown>;
  try { j = JSON.parse(text) as Record<string, unknown>; } catch { return []; }
  const out: string[] = [];
  for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const d = j[k]; if (!d || typeof d !== "object") continue;
    for (const [name, spec] of Object.entries(d as Record<string, unknown>)) {
      const s = String(spec);
      if (/^(file|link|workspace|git|git\+\w+|https?|github):/.test(s)) continue; // not a registry spec
      out.push(name);
    }
  }
  return out;
}

function reqLine(line: string): string | null {
  const l = line.replace(/\s#.*$/, "").trim();
  if (!l || l.startsWith("#") || l.startsWith("-") || /^(git\+|https?:|file:|\.|\/)/.test(l)) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l);
  return m ? pyNorm(m[1]!) : null;
}

function pyprojectDeps(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(?:dependencies|[A-Za-z0-9_-]+)\s*=\s*\[([\s\S]*?)\n?\s*\]/gm)) {
    for (const s of m[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)) { const n = reqLine(s[1] ?? s[2] ?? ""); if (n) out.push(n); }
  }
  let inPoetry = false;
  for (const line of text.split("\n")) {
    const h = /^\s*\[([^\]]+)\]/.exec(line);
    if (h) { inPoetry = /^tool\.poetry\.(group\.[^.]+\.)?dependencies$|^tool\.poetry\.dev-dependencies$/.test(h[1]!.trim()); continue; }
    if (!inPoetry) continue;
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
    if (m && m[1]!.toLowerCase() !== "python") out.push(pyNorm(m[1]!));
  }
  return out;
}

function goDeps(text: string): string[] {
  const out: string[] = []; let block = false;
  for (const line of text.split("\n")) {
    const t = line.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(t)) { block = true; continue; }
    if (block && t === ")") { block = false; continue; }
    const m = block ? /^(\S+)\s+v\S+/.exec(t) : /^require\s+(\S+)\s+v\S+/.exec(t);
    if (m) out.push(m[1]!);
  }
  return out;
}

function cargoDeps(text: string): string[] {
  const out: string[] = []; let inDeps = false;
  for (const line of text.split("\n")) {
    const h = /^\s*\[([^\]]+)\]/.exec(line);
    if (h) {
      const sec = h[1]!.trim();
      const tbl = /(^|\.)(dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(sec);
      if (tbl) out.push(tbl[3]!);
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(sec); continue;
    }
    if (!inDeps) continue;
    const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line); if (m) out.push(m[1]!);
  }
  return out;
}

export function parseDeps(path: string, text: string): string[] {
  const eco = manifestEcosystem(path);
  if (eco === "npm") return npmDeps(text);
  if (eco === "go") return goDeps(text);
  if (eco === "cargo") return cargoDeps(text);
  if (eco === "pypi") return basename(path) === "pyproject.toml" ? pyprojectDeps(text) : text.split("\n").map(reqLine).filter((x): x is string => !!x);
  return [];
}

async function show(cwd: string, sha: string, path: string): Promise<string> {
  const r = await run(["git", "show", `${sha}:${path}`], { cwd, timeoutMs: 20000 });
  return r.exitCode === 0 ? r.stdout : "";
}

/** Dependencies present at head and absent at base, per touched manifest. */
export async function newDependencies(repoDir: string, baseSha: string, head: string, changedFiles: string[]): Promise<{ ecosystem: Eco; name: string; manifest: string }[]> {
  const out: { ecosystem: Eco; name: string; manifest: string }[] = [];
  for (const f of [...new Set(changedFiles)]) {
    const eco = manifestEcosystem(f); if (!eco) continue;
    const before = new Set(parseDeps(f, await show(repoDir, baseSha, f)));
    for (const n of new Set(parseDeps(f, await show(repoDir, head, f)))) if (!before.has(n)) out.push({ ecosystem: eco, name: n, manifest: f });
  }
  return out;
}

export function readAllowlist(repoDir: string): Set<string> {
  const p = join(repoDir, ".loki", "supply-allowlist");
  if (!existsSync(p)) return new Set();
  try { return new Set(readFileSync(p, "utf8").split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean)); } catch { return new Set(); }
}

type Probe = { kind: "nonexistent" } | { kind: "unreachable" } | { kind: "found"; firstPublish: number | null };

async function probe(eco: "npm" | "pypi", name: string, fetcher: RegistryFetcher): Promise<Probe> {
  const url = eco === "npm" ? `https://registry.npmjs.org/${name.startsWith("@") ? name.replace("/", "%2F") : name}` : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  let r: RegistryReply;
  try { r = await fetcher(url, 10000); } catch { return { kind: "unreachable" }; }
  if (r.status === 404) return { kind: "nonexistent" };
  if (r.status !== 200 || !r.json || typeof r.json !== "object") return { kind: "unreachable" };
  const j = r.json as Record<string, unknown>;
  const times: number[] = [];
  if (eco === "npm") {
    const t = (j["time"] ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(t)) if (k !== "modified") { const n = Date.parse(String(v)); if (Number.isFinite(n)) times.push(n); }
  } else {
    for (const files of Object.values((j["releases"] ?? {}) as Record<string, unknown>)) {
      if (!Array.isArray(files)) continue;
      for (const f of files) { const o = f as Record<string, unknown>; const n = Date.parse(String(o["upload_time_iso_8601"] ?? o["upload_time"] ?? "")); if (Number.isFinite(n)) times.push(n); }
    }
  }
  return { kind: "found", firstPublish: times.length ? Math.min(...times) : null };
}

let injected: RegistryFetcher | null = null;
/** Test seam: replace the registry fetcher (null restores the network default). */
export function setSupplyFetcher(f: RegistryFetcher | null): void { injected = f; }

export async function supplyGuard(repoDir: string, baseSha: string, head: string, changedFiles: string[], env: NodeJS.ProcessEnv, opts: { fetcher?: RegistryFetcher; now?: number } = {}): Promise<SupplyResult> {
  const none: SupplyResult = { block: null, notProven: [], blocked: false };
  if (!supplyEnabled(env)) return none;
  const fetcher = opts.fetcher ?? injected ?? defaultFetcher, now = opts.now ?? Date.now();
  let added: Awaited<ReturnType<typeof newDependencies>>;
  try { added = await newDependencies(repoDir, baseSha, head, changedFiles); } catch { return none; }
  if (added.length === 0) return none;
  const allow = readAllowlist(repoDir);
  const notProven: string[] = []; let blocked = false;
  const checkable = added.filter((d) => (d.ecosystem === "npm" || d.ecosystem === "pypi") && !allow.has(d.name));
  const overflow = new Set(checkable.slice(MAX_CHECKED));
  const entries = await Promise.all(added.map(async (d): Promise<SupplyEntry> => {
    const base = { ecosystem: d.ecosystem, name: d.name, manifest: d.manifest };
    if (d.ecosystem !== "npm" && d.ecosystem !== "pypi") return { ...base, status: "unsupported" };
    if (allow.has(d.name)) return { ...base, status: "allowlisted" };
    if (overflow.has(d)) return { ...base, status: "unreachable" };
    const p = await probe(d.ecosystem, d.name, fetcher);
    if (p.kind === "nonexistent") return { ...base, status: "nonexistent" };
    if (p.kind === "unreachable" || p.firstPublish === null) return { ...base, status: "unreachable" };
    const age = Math.floor((now - p.firstPublish) / DAY_MS);
    return { ...base, status: age < MIN_AGE_DAYS ? "too_new" : "ok", age_days: age };
  }));
  for (const e of entries) {
    const id = `${e.ecosystem}:${e.name} (${e.manifest})`;
    if (e.status === "nonexistent") { blocked = true; notProven.push(`supply guard FAILED: ${id} does not exist on the registry (possible hallucinated package)`); }
    else if (e.status === "too_new") { blocked = true; notProven.push(`supply guard FAILED: ${id} first published ${e.age_days} days ago (minimum ${MIN_AGE_DAYS}); allowlist in .loki/supply-allowlist to accept`); }
    else if (e.status === "unreachable") notProven.push(`supply guard NOT PROVEN: registry unreachable or unreadable for ${id}`);
    else if (e.status === "unsupported") notProven.push(`supply guard: not checked (ecosystem unsupported in v1): ${id}`);
    else if (e.status === "allowlisted") notProven.push(`supply guard: allowlisted, not checked: ${id}`);
  }
  return { block: { guard: "v1", min_age_days: MIN_AGE_DAYS, entries }, notProven, blocked };
}
