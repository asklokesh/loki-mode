// T10 (redesign): supply-chain guard v2. The model DECLARES the new third-party registry dependencies it added
// (.loki/supply-declared.json in the repo, bounded reader); the harness PROVES each one with the ecosystem's own resolver under the
// user's config (npm view, pip index versions, cargo search, go list). The harness never parses manifest or
// lockfile formats (FC-36). Only a declared registry dep that does not resolve is FAILED; everything the
// tooling cannot answer is NOT PROVEN. Off with LOKI_SUPPLY_GUARD=0 (no receipt block; the brief rule is unconditional by CTO ruling).
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { run } from "../util/shell.ts";

export type SupplyStatus = "ok" | "nonexistent" | "too_new" | "allowlisted" | "unreachable" | "unsupported" | "capped";
export interface SupplyEntry { ecosystem: string; name: string; version_spec: string; registry: string; status: SupplyStatus; age_days?: number }
export interface SupplyBlock { guard: "v2"; warn_age_days: number; fail_age_days: number | null; declared: number; entries: SupplyEntry[] }
export interface SupplyResult { block: SupplyBlock | null; notProven: string[]; blocked: boolean }
export interface DeclaredDep { ecosystem: string; name: string; version_spec: string; registry: string }
export type Resolution = { status: "exists"; firstPublish?: number } | { status: "missing" } | { status: "unproven" };
export type Resolver = (dep: DeclaredDep, cwd: string, env: NodeJS.ProcessEnv) => Promise<Resolution>;

export const MIN_AGE_DAYS = 7; // warning threshold; a hard fail on age needs LOKI_SUPPLY_MIN_AGE_DAYS
export const DECLARED_FILE = "supply-declared.json";
const MAX_CHECKED = 50, MAX_DECLARED = 200, MAX_FILE_BYTES = 64 * 1024, DAY_MS = 86400000;
const MANIFESTS = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements.*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile|Pipfile\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock|composer\.json|composer\.lock|pom\.xml|build\.gradle(\.kts)?)$/;

export function supplyEnabled(env: NodeJS.ProcessEnv): boolean { return env["LOKI_SUPPLY_GUARD"] !== "0"; }
/** A positive LOKI_SUPPLY_MIN_AGE_DAYS makes a younger package a hard fail; otherwise age only warns. */
export function failAgeDays(env: NodeJS.ProcessEnv): number | null { const n = Number(env["LOKI_SUPPLY_MIN_AGE_DAYS"]); return Number.isFinite(n) && n > 0 ? n : null; }
/** Only a nonexistent declared dependency (or an opted-in age fail) changes the verdict; VERIFIED becomes FAILED, nothing else moves. */
export function supplyVerdict<V extends string>(verdict: V, r: SupplyResult): V { return r.blocked && verdict === "VERIFIED" ? ("FAILED" as V) : verdict; }
export function isManifestPath(path: string): boolean { return MANIFESTS.test(basename(path)); }

const ECO: Record<string, string> = { npm: "npm", node: "npm", pypi: "pypi", pip: "pypi", python: "pypi", cargo: "cargo", crates: "cargo", go: "go", golang: "go" };
const NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/~+-]{0,213}$/;

/** Bounded, validating reader: null means no usable declaration (absent, oversized or malformed), never a throw. */
export function readDeclared(repoDir: string): { deps: DeclaredDep[]; problem: string | null } {
  const p = join(repoDir, ".loki", DECLARED_FILE);
  if (!existsSync(p)) return { deps: [], problem: null };
  try {
    if (statSync(p).size > MAX_FILE_BYTES) return { deps: [], problem: "declaration file too large" };
    const j = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(j)) return { deps: [], problem: "declaration is not a JSON array" };
    const deps: DeclaredDep[] = [];
    for (const o of j.slice(0, MAX_DECLARED)) {
      if (!o || typeof o !== "object") continue;
      const r = o as Record<string, unknown>;
      const eco = ECO[String(r["ecosystem"] ?? "").toLowerCase()] ?? String(r["ecosystem"] ?? "").toLowerCase().slice(0, 30);
      const name = String(r["name"] ?? "");
      if (!eco || !NAME.test(name)) continue;
      deps.push({ ecosystem: eco, name, version_spec: String(r["version_spec"] ?? "").slice(0, 100), registry: String(r["registry"] ?? "default").slice(0, 200) });
    }
    return { deps, problem: null };
  } catch { return { deps: [], problem: "declaration unreadable" }; }
}

export function readAllowlist(repoDir: string): Set<string> {
  const p = join(repoDir, ".loki", "supply-allowlist");
  if (!existsSync(p)) return new Set();
  try { return new Set(readFileSync(p, "utf8").split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean)); } catch { return new Set(); }
}

/** Pure classifier for a resolver command's outcome. Anything not clearly "absent" is unproven. */
export function classify(eco: string, name: string, exitCode: number, stdout: string, stderr: string): Resolution {
  const err = `${stderr}\n${stdout}`;
  if (eco === "npm") {
    if (exitCode === 0) { const m = /"?(\d{4}-\d\d-\d\dT[\d:.]+Z)"?/.exec(stdout); return m ? { status: "exists", firstPublish: Date.parse(m[1]!) } : { status: "exists" }; }
    return /E404|404 Not Found|is not in this registry/i.test(err) ? { status: "missing" } : { status: "unproven" };
  }
  if (eco === "pypi") {
    if (exitCode === 0) return /Available versions/i.test(stdout) ? { status: "exists" } : { status: "unproven" };
    return /No matching distribution|from versions: none/i.test(err) ? { status: "missing" } : { status: "unproven" };
  }
  if (eco === "cargo") {
    if (exitCode !== 0) return { status: "unproven" };
    const norm = (x: string): string => x.toLowerCase().replace(/_/g, "-");
    return stdout.split("\n").some((l) => norm(l).startsWith(`${norm(name)} = `)) ? { status: "exists" } : { status: "missing" };
  }
  if (eco === "go") {
    if (exitCode === 0) return { status: "exists" };
    return /no matching versions|not found|404|410/i.test(err) && !/dial tcp|timeout|no such host|connection/i.test(err) ? { status: "missing" } : { status: "unproven" };
  }
  return { status: "unproven" };
}

/** INTERIM FALLBACK: a fixed per-ecosystem command table. Upgrade path: resolver commands sourced from the Project Model (slice for 11.3.3 L4). */
/** Default resolver: the ecosystem's own tool, run in the repo so the user's .npmrc / pip.conf / cargo config apply. */
export const defaultResolver: Resolver = async (dep, cwd) => {
  const argv: Record<string, string[]> = {
    npm: ["npm", "view", dep.name, "time.created", "--json"],
    pypi: ["pip", "index", "versions", "--pre", "--ignore-requires-python", dep.name],
    cargo: ["cargo", "search", dep.name, "--limit", "5"],
    go: ["go", "list", "-m", "-json", `${dep.name}@latest`],
  };
  const cmd = argv[dep.ecosystem];
  if (!cmd || dep.name.startsWith("-")) return { status: "unproven" };
  try {
    const r = await run(cmd, { cwd, timeoutMs: 10000 });
    return classify(dep.ecosystem, dep.name, r.exitCode, r.stdout, r.stderr);
  } catch { return { status: "unproven" }; } // tool absent or timed out
};

const PUBLIC_HOSTS = new Set(["registry.npmjs.org", "registry.npmjs.com", "registry.yarnpkg.com", "npmjs.com", "npmjs.org", "pypi.org", "pypi.python.org", "files.pythonhosted.org", "crates.io", "index.crates.io", "static.crates.io", "proxy.golang.org", "golang.org", "pkg.go.dev"]);
const hostOf = (u: string): string => u.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0]!.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
const privateUrl = (u: string): boolean => /[a-z0-9]/i.test(u) && !PUBLIC_HOSTS.has(hostOf(u));
const readSmall = (p: string): string => { try { return statSync(p).size <= MAX_FILE_BYTES ? readFileSync(p, "utf8") : ""; } catch { return ""; } };

/** The ecosystem decides the default registry; only the USER's own config may move it. The model's declared `registry` text is never consulted. */
export function userConfigPrivate(eco: string, repoDir: string, env: NodeJS.ProcessEnv, goEnv: Record<string, string> = {}, name = ""): boolean {
  const home = env["HOME"] ?? "";
  const files = (...p: string[]): string[] => p.filter((x) => x !== "").map((x) => readSmall(x));
  if (eco === "npm") {
    if (privateUrlList([env["npm_config_registry"] ?? "", env["NPM_CONFIG_REGISTRY"] ?? ""])) return true;
    return files(join(repoDir, ".npmrc"), home ? join(home, ".npmrc") : "").some((t) => t.split("\n").some((l) => { const m = /^\s*(?:(@[^:\s]+):)?registry\s*=\s*(\S+)/.exec(l); return !!m && privateUrl(m[2]!) && (m[1] === undefined || name.startsWith(`${m[1]}/`)); })); // a scoped line applies only to its own scope
  }
  if (eco === "pypi") {
    if (privateUrlList([env["PIP_INDEX_URL"] ?? "", env["PIP_EXTRA_INDEX_URL"] ?? ""])) return true;
    const cfg = [env["PIP_CONFIG_FILE"] ?? "", home ? join(home, ".config", "pip", "pip.conf") : "", home ? join(home, ".pip", "pip.conf") : "", join(repoDir, "pip.conf")];
    return files(...cfg).some((t) => t.split("\n").some((l) => { const m = /^\s*(?:extra-)?index-url\s*[=:]\s*(.+)$/.exec(l); return !!m && m[1]!.split(/\s+/).some(privateUrl); }));
  }
  if (eco === "cargo") {
    if (Object.keys(env).some((k) => /^CARGO_REGISTRIES_.+_INDEX$/.test(k) || /^CARGO_SOURCE_/.test(k))) return true;
    return files(join(repoDir, ".cargo", "config.toml"), join(repoDir, ".cargo", "config"), home ? join(home, ".cargo", "config.toml") : "", home ? join(home, ".cargo", "config") : "").some((t) => /^\s*\[(registries\.|source\.)/m.test(t) || /replace-with\s*=/.test(t));
  }
  if (eco === "go") {
    const gp = goEnv["GOPROXY"] ?? env["GOPROXY"] ?? "";
    return gp.split(/[,|]/).map((x) => x.trim()).filter((x) => x && x !== "direct" && x !== "off").some(privateUrl);
  }
  return false;
}
const privateUrlList = (v: string[]): boolean => v.some((x) => x.split(/\s+/).some((u) => u !== "" && privateUrl(u)));

/** Go module path matched by GOPRIVATE / GONOPROXY (comma-separated globs on path prefixes). */
export function goPrivate(d: DeclaredDep, env: NodeJS.ProcessEnv): boolean {
  if (d.ecosystem !== "go") return false;
  const pats = `${env["GOPRIVATE"] ?? ""},${env["GONOPROXY"] ?? ""}`.split(",").map((x) => x.trim()).filter(Boolean);
  const parts = d.name.split("/");
  return pats.some((pat) => { const n = pat.split("/").length; const re = new RegExp(`^${pat.split("/").map((seg) => seg.replace(/[.+^${}()|\\[\]]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("/")}$`); return re.test(parts.slice(0, n).join("/")); });
}

async function readGoEnv(cwd: string): Promise<Record<string, string>> {
  try {
    const r = await run(["go", "env", "-json", "GOPRIVATE", "GONOPROXY", "GOPROXY"], { cwd, timeoutMs: 10000 });
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
  } catch { return {}; }
}

let injected: Resolver | null = null;
/** Test seam: replace the resolver (null restores the real tooling). */
export function setSupplyResolver(f: Resolver | null): void { injected = f; }

export async function supplyGuard(repoDir: string, changedFiles: string[], declared: { deps: DeclaredDep[]; problem: string | null }, env: NodeJS.ProcessEnv, opts: { resolver?: Resolver; now?: number; goEnv?: Record<string, string> } = {}): Promise<SupplyResult> {
  const none: SupplyResult = { block: null, notProven: [], blocked: false };
  if (!supplyEnabled(env)) return none;
  const touched = changedFiles.filter(isManifestPath);
  if (touched.length === 0) return none; // the diff adds or changes no dependency file
  const resolver = opts.resolver ?? injected ?? defaultResolver, now = opts.now ?? Date.now(), failAge = failAgeDays(env);
  // `go env` so values set with `go env -w` count; only asked when a go dependency is declared and the real resolver is in use
  const goEnv = opts.goEnv ?? (declared.deps.some((x) => x.ecosystem === "go") && !opts.resolver && !injected ? await readGoEnv(repoDir) : {});
  const notProven: string[] = []; let blocked = false;
  if (declared.problem) notProven.push(`supply guard NOT PROVEN: ${declared.problem}`);
  if (declared.deps.length === 0) {
    if (!declared.problem) notProven.push(`supply guard WARNING: dependencies changed (${[...new Set(touched)].slice(0, 5).join(", ")}) but none declared; not checked`);
    return { block: { guard: "v2", warn_age_days: MIN_AGE_DAYS, fail_age_days: failAge, declared: 0, entries: [] }, notProven, blocked: false };
  }
  const allow = readAllowlist(repoDir), cache = new Map<string, Promise<Resolution>>();
  let checked = 0;
  const entries: SupplyEntry[] = [];
  for (const d of declared.deps) {
    const base = { ecosystem: d.ecosystem, name: d.name, version_spec: d.version_spec, registry: d.registry };
    if (!["npm", "pypi", "cargo", "go"].includes(d.ecosystem)) { entries.push({ ...base, status: "unsupported" }); continue; }
    if (allow.has(d.name)) { entries.push({ ...base, status: "allowlisted" }); continue; }
    if (++checked > MAX_CHECKED) { entries.push({ ...base, status: "capped" }); continue; }
    const key = `${d.ecosystem}:${d.name}`;
    let h = cache.get(key); if (!h) { h = resolver(d, repoDir, env).catch((): Resolution => ({ status: "unproven" })); cache.set(key, h); }
    let res = await h;
    if (res.status === "missing" && (userConfigPrivate(d.ecosystem, repoDir, env, goEnv, d.name) || goPrivate(d, { ...env, ...goEnv }))) res = { status: "unproven" }; // user config points elsewhere than the public default
    if (res.status === "missing") entries.push({ ...base, status: "nonexistent" });
    else if (res.status === "unproven") entries.push({ ...base, status: "unreachable" });
    else if (res.firstPublish === undefined || !Number.isFinite(res.firstPublish)) entries.push({ ...base, status: "ok" });
    else { const age = Math.floor((now - res.firstPublish) / DAY_MS); entries.push({ ...base, status: age < MIN_AGE_DAYS || (failAge !== null && age < failAge) ? "too_new" : "ok", age_days: age }); }
  }
  for (const e of entries) {
    const id = `${e.ecosystem}:${e.name}`;
    if (e.status === "nonexistent") { blocked = true; notProven.push(`supply guard FAILED: declared dependency ${id} does not resolve in the registry (possible hallucinated package)`); }
    else if (e.status === "too_new") {
      if (failAge !== null && (e.age_days ?? 0) < failAge) { blocked = true; notProven.push(`supply guard FAILED: ${id} first published ${e.age_days} days ago (LOKI_SUPPLY_MIN_AGE_DAYS=${failAge}); allowlist in .loki/supply-allowlist to accept`); }
      else notProven.push(`supply guard WARNING: ${id} first published ${e.age_days} days ago (under ${MIN_AGE_DAYS}); verdict unchanged`);
    }
    else if (e.status === "unreachable") notProven.push(`supply guard NOT PROVEN: resolver could not answer for ${id}`);
    else if (e.status === "capped") notProven.push(`supply guard: not checked: cap ${MAX_CHECKED} exceeded: ${id}`);
    else if (e.status === "unsupported") notProven.push(`supply guard: not checked (ecosystem unsupported in v1): ${id}`);
    else if (e.status === "allowlisted") notProven.push(`supply guard: allowlisted, not checked: ${id}`);
  }
  return { block: { guard: "v2", warn_age_days: MIN_AGE_DAYS, fail_age_days: failAge, declared: declared.deps.length, entries }, notProven, blocked };
}
