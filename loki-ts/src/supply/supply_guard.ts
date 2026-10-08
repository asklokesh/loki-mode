// T10: supply-chain guard v1. Finds dependencies newly added by the change (manifest diff base..head)
// and checks npm / PyPI that each exists and was first published at least 7 days ago.
// Off with LOKI_SUPPLY_GUARD=0 (receipt byte-identical to before). Registry access is injectable.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { run } from "../util/shell.ts";

export type SupplyStatus = "ok" | "nonexistent" | "too_new" | "allowlisted" | "unreachable" | "unsupported" | "capped";
export interface SupplyEntry { ecosystem: string; name: string; manifest: string; status: SupplyStatus; age_days?: number }
export interface SupplyBlock { guard: "v1"; warn_age_days: number; fail_age_days: number | null; entries: SupplyEntry[] }
export interface SupplyResult { block: SupplyBlock | null; notProven: string[]; blocked: boolean }
export interface RegistryReply { status: number; json?: unknown }
export type RegistryFetcher = (url: string, timeoutMs: number) => Promise<RegistryReply>;

export const MIN_AGE_DAYS = 7; // warning threshold; a hard fail on age needs LOKI_SUPPLY_MIN_AGE_DAYS
const MAX_CHECKED = 50;
const DAY_MS = 86400000;

/** CTO ruling: age is a warning by default; a positive LOKI_SUPPLY_MIN_AGE_DAYS makes younger packages a hard fail. */
export function failAgeDays(env: NodeJS.ProcessEnv): number | null { const n = Number(env["LOKI_SUPPLY_MIN_AGE_DAYS"]); return Number.isFinite(n) && n > 0 ? n : null; }

/** Only a nonexistent package (or an opted-in age fail) changes the verdict; VERIFIED becomes FAILED, nothing else moves. */
export function supplyVerdict<V extends string>(verdict: V, r: SupplyResult): V { return r.blocked && verdict === "VERIFIED" ? ("FAILED" as V) : verdict; }

export function supplyEnabled(env: NodeJS.ProcessEnv): boolean { return env["LOKI_SUPPLY_GUARD"] !== "0"; }

export const defaultFetcher: RegistryFetcher = async (url, timeoutMs) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (r.status === 200) return { status: 200, json: await r.json() };
  return { status: r.status };
};

type Eco = "npm" | "pypi" | "go" | "cargo";
export function manifestEcosystem(path: string): Eco | null {
  const b = basename(path);
  if (b === "package.json" || b === "package-lock.json") return "npm";
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
      const s = String(spec).trim();
      if (/^(file|link|workspace|portal|catalog|git|git\+\w+|https?|github|gitlab|bitbucket):/.test(s) || /^[./~]/.test(s) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)) continue; // not a registry spec
      const alias = /^npm:(@?[^@]+)(@.*)?$/.exec(s); // an alias installs the target package
      out.push(alias ? alias[1]! : name);
    }
  }
  return out;
}

function lockDeps(text: string): string[] {
  try { return Object.keys(((JSON.parse(text) as Record<string, unknown>)["packages"] ?? {}) as object).map((k) => k.replace(/^.*node_modules\//, "")).filter((k) => k && !k.startsWith("/")); } catch { return []; }
}

function reqLine(line: string): string | null {
  const l = line.replace(/\s#.*$/, "").trim();
  if (!l || l.startsWith("#") || l.startsWith("-") || /^(git\+|https?:|file:|\.|\/)/.test(l)) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l);
  return m ? pyNorm(m[1]!) : null;
}

function pyprojectDeps(text: string): string[] {
  const out: string[] = [];
  let table = "", key = "", buf: string[] | null = null;
  const take = (arr: string): void => { for (const m of arr.matchAll(/"([^"]+)"|'([^']+)'/g)) { const n = reqLine(m[1] ?? m[2] ?? ""); if (n) out.push(n); } };
  const wanted = (t: string, k: string): boolean =>
    (t === "project" && k === "dependencies") || t === "project.optional-dependencies" || t === "dependency-groups" || (t === "build-system" && k === "requires");
  for (const line of text.split("\n")) {
    if (buf) { buf.push(line); if (/\]\s*(#.*)?$/.test(line.trim())) { if (wanted(table, key)) take(buf.join("\n")); buf = null; } continue; }
    const h = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (h) { table = h[1]!.trim(); continue; }
    if (/^\s*\[\[/.test(line)) { table = ""; continue; }
    const m = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.*)$/.exec(line);
    if (!m) { continue; }
    key = m[1]!.replace(/"/g, ""); const rest = m[2]!;
    if (table === "project" && key === "dependencies" || table === "project.optional-dependencies" || table === "dependency-groups" || (table === "build-system" && key === "requires")) {
      if (rest.trim().startsWith("[")) { if (/\]\s*(#.*)?$/.test(rest.trim())) { take(rest); } else buf = [rest]; }
    } else if (/^tool\.poetry\.(group\.[^.]+\.)?dependencies$|^tool\.poetry\.dev-dependencies$/.test(table)) {
      if (key.toLowerCase() !== "python") out.push(pyNorm(key));
      if (!/^["'{\[]/.test(rest.trim()) && !/^\d/.test(rest.trim())) continue;
    } else if (rest.trim().startsWith("[") && !/\]\s*(#.*)?$/.test(rest.trim())) buf = [rest]; // skip other multi-line arrays
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
  if (eco === "npm") return basename(path) === "package-lock.json" ? lockDeps(text) : npmDeps(text);
  if (eco === "go") return goDeps(text);
  if (eco === "cargo") return cargoDeps(text);
  if (eco === "pypi") return basename(path) === "pyproject.toml" ? pyprojectDeps(text) : text.split("\n").map(reqLine).filter((x): x is string => !!x);
  return [];
}

async function show(cwd: string, sha: string, path: string): Promise<string> {
  const r = await run(["git", "show", `${sha}:${path}`], { cwd, timeoutMs: 20000 });
  return r.exitCode === 0 ? r.stdout : "";
}

/** A requirements file that names its own index cannot be judged against the public PyPI. */
export function usesCustomIndex(path: string, text: string): boolean { return /^requirements.*\.txt$/.test(basename(path)) && /^\s*(--index-url|--extra-index-url|-i)\b/m.test(text); }

export interface NewDep { ecosystem: Eco; name: string; manifest: string; customIndex?: boolean }
/** Dependencies present at head and absent at base, per touched manifest. */
export async function newDependencies(repoDir: string, baseSha: string, head: string, changedFiles: string[]): Promise<NewDep[]> {
  const out: NewDep[] = [];
  for (const f of [...new Set(changedFiles)]) {
    const eco = manifestEcosystem(f); if (!eco) continue;
    const before = new Set(parseDeps(f, await show(repoDir, baseSha, f)));
    const headText = await show(repoDir, head, f), custom = usesCustomIndex(f, headText);
    for (const n of new Set(parseDeps(f, headText))) if (!before.has(n)) out.push({ ecosystem: eco, name: n, manifest: f, ...(custom ? { customIndex: true } : {}) });
  }
  return out;
}

/** Names of every package.json in the head tree: workspace siblings are local, never registry lookups. */
export async function localPackageNames(repoDir: string, head: string): Promise<Set<string>> {
  const names = new Set<string>();
  const ls = await run(["git", "ls-tree", "-r", "--name-only", "-z", head], { cwd: repoDir, timeoutMs: 20000 });
  if (ls.exitCode !== 0) return names;
  for (const f of ls.stdout.split("\0").filter((x) => basename(x) === "package.json" && !x.includes("node_modules/")).slice(0, 300)) {
    try { const n = (JSON.parse(await show(repoDir, head, f)) as Record<string, unknown>)["name"]; if (typeof n === "string") names.add(n); } catch { /* unparsable manifest */ }
  }
  return names;
}

export function readAllowlist(repoDir: string): Set<string> {
  const p = join(repoDir, ".loki", "supply-allowlist");
  if (!existsSync(p)) return new Set();
  try { return new Set(readFileSync(p, "utf8").split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean)); } catch { return new Set(); }
}

export interface RegistryConfig { npmDefault: string; npmScopes: Record<string, string>; pypiBase: string | null }
function readConf(p: string): string { try { return existsSync(p) ? readFileSync(p, "utf8") : ""; } catch { return ""; } }
const trimSlash = (u: string): string => u.replace(/\/+$/, "");
/** The user's configured registries: env, then repo .npmrc, ~/.npmrc, pip.conf. Defaults are the public registries. */
export function registryConfig(repoDir: string, env: NodeJS.ProcessEnv): RegistryConfig {
  const c: RegistryConfig = { npmDefault: "https://registry.npmjs.org", npmScopes: {}, pypiBase: null };
  const home = env["HOME"] || homedir();
  for (const text of [readConf(join(home, ".npmrc")), readConf(join(repoDir, ".npmrc"))]) { // later (repo) wins
    for (const line of text.split("\n")) {
      const m = /^\s*(@[^:\s]+:)?registry\s*=\s*(\S+)/.exec(line.replace(/[;#].*$/, ""));
      if (!m) continue;
      if (m[1]) c.npmScopes[m[1].slice(0, -1)] = trimSlash(m[2]!); else c.npmDefault = trimSlash(m[2]!);
    }
  }
  const e = env["npm_config_registry"] || env["NPM_CONFIG_REGISTRY"]; if (e) c.npmDefault = trimSlash(e);
  let idx = env["PIP_INDEX_URL"] ?? "";
  if (!idx) for (const p of [join(home, ".config", "pip", "pip.conf"), join(home, ".pip", "pip.conf"), join(repoDir, "pip.conf")]) { const m = /^\s*index-url\s*[=:]\s*(\S+)/m.exec(readConf(p)); if (m) idx = m[1]!; }
  if (idx) c.pypiBase = trimSlash(idx).replace(/\/simple$/, "");
  return c;
}

type Probe = { kind: "nonexistent" } | { kind: "unreachable" } | { kind: "found"; firstPublish: number | null };

async function probe(eco: "npm" | "pypi", name: string, fetcher: RegistryFetcher, cfg: RegistryConfig): Promise<Probe> {
  let url: string, custom = false;
  if (eco === "npm") {
    const scope = name.startsWith("@") ? name.split("/")[0]! : "";
    const root = (scope && cfg.npmScopes[scope]) || cfg.npmDefault; custom = root !== "https://registry.npmjs.org";
    url = `${root}/${name.startsWith("@") ? name.replace("/", "%2F") : name}`;
  } else { custom = cfg.pypiBase !== null; url = `${cfg.pypiBase ?? "https://pypi.org"}/pypi/${encodeURIComponent(name)}/json`; }
  let r: RegistryReply;
  try { r = await fetcher(url, 10000); } catch { return { kind: "unreachable" }; }
  // A configured private registry (.npmrc / pip.conf) may not mirror or expose the package: a 404 proves nothing about existence.
  if (r.status === 404) return custom ? { kind: "unreachable" } : { kind: "nonexistent" };
  if (r.status !== 200 || !r.json || typeof r.json !== "object") return { kind: "unreachable" };
  const j = r.json as Record<string, unknown>;
  const times: number[] = [];
  if (eco === "npm") {
    const t = (j["time"] ?? {}) as Record<string, unknown>;
    if (t["unpublished"] || !j["versions"] || Object.keys(j["versions"] as object).length === 0) return custom ? { kind: "unreachable" } : { kind: "nonexistent" };
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
  const raw = opts.fetcher ?? injected ?? defaultFetcher, now = opts.now ?? Date.now();
  const cache = new Map<string, Promise<RegistryReply>>(); // per-run lookup cache
  const fetcher: RegistryFetcher = (u, t) => { let h = cache.get(u); if (!h) { h = raw(u, t); cache.set(u, h); } return h; };
  const cfg = registryConfig(repoDir, env), failAge = failAgeDays(env);
  let added: NewDep[];
  try { added = await newDependencies(repoDir, baseSha, head, changedFiles); } catch { return none; }
  if (added.length === 0) return none;
  const allow = readAllowlist(repoDir), local = await localPackageNames(repoDir, head).catch(() => new Set<string>());
  added = added.filter((d) => !(d.ecosystem === "npm" && local.has(d.name))); // workspace siblings
  if (added.length === 0) return none;
  const notProven: string[] = []; let blocked = false;
  const checkable = added.filter((d) => (d.ecosystem === "npm" || d.ecosystem === "pypi") && !allow.has(d.name));
  const overflow = new Set(checkable.slice(MAX_CHECKED));
  const entries = await Promise.all(added.map(async (d): Promise<SupplyEntry> => {
    const base = { ecosystem: d.ecosystem, name: d.name, manifest: d.manifest };
    if (d.ecosystem !== "npm" && d.ecosystem !== "pypi") return { ...base, status: "unsupported" };
    if (allow.has(d.name)) return { ...base, status: "allowlisted" };
    if (d.customIndex) return { ...base, status: "unreachable" };
    if (overflow.has(d)) return { ...base, status: "capped" };
    const p = await probe(d.ecosystem, d.name, fetcher, cfg);
    if (p.kind === "nonexistent") return { ...base, status: "nonexistent" };
    if (p.kind === "unreachable" || p.firstPublish === null) return { ...base, status: "unreachable" };
    const age = Math.floor((now - p.firstPublish) / DAY_MS);
    return { ...base, status: age < Math.max(MIN_AGE_DAYS, failAge ?? 0) ? "too_new" : "ok", age_days: age };
  }));
  for (const e of entries) {
    const id = `${e.ecosystem}:${e.name} (${e.manifest})`;
    if (e.status === "nonexistent") { blocked = true; notProven.push(`supply guard FAILED: ${id} does not exist on the registry (possible hallucinated package)`); }
    else if (e.status === "too_new") {
      if (failAge !== null && (e.age_days ?? 0) < failAge) { blocked = true; notProven.push(`supply guard FAILED: ${id} first published ${e.age_days} days ago (LOKI_SUPPLY_MIN_AGE_DAYS=${failAge}); allowlist in .loki/supply-allowlist to accept`); }
      else notProven.push(`supply guard WARNING: ${id} first published ${e.age_days} days ago (under ${MIN_AGE_DAYS}); verdict unchanged`);
    }
    else if (e.status === "unreachable") notProven.push(`supply guard NOT PROVEN: registry unreachable or unreadable for ${id}`);
    else if (e.status === "capped") notProven.push(`supply guard: not checked: cap ${MAX_CHECKED} exceeded: ${id}`);
    else if (e.status === "unsupported") notProven.push(`supply guard: not checked (ecosystem unsupported in v1): ${id}`);
    else if (e.status === "allowlisted") notProven.push(`supply guard: allowlisted, not checked: ${id}`);
  }
  return { block: { guard: "v1", warn_age_days: MIN_AGE_DAYS, fail_age_days: failAge, entries }, notProven, blocked };
}
