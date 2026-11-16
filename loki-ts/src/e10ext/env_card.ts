// Q1 ENV CARD (LOKI_E10_ENV_CARD, default on; 0/off/false/no opts out): an issue run on the claude provider. Before implement the harness reads, without a
// model call or the network, which local services the repository needs (compose images, .env.example keys, dependency names) and where each is on this
// machine (PATH, Homebrew kegs, the Debian/Ubuntu postgresql dirs, Postgres.app, whether a docker daemon answers). New file: no module detects local
// service binaries. FireLater#24: two sessions asked to run the product ran `which psql pg_ctl postgres redis-server`, found nothing (Homebrew's
// postgresql@15 is keg-only, so not on PATH), said Postgres was not installed and were sealed VERIFIED; Postgres 15 was on the machine.
// Never fails the run: any error means no card. Never reads .env itself and never stores a value, only service names, versions and paths.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export const envCardOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_ENV_CARD"] ?? "").trim());
/** Same scope as the prove stage: an issue run on claude. */
export const envCardScope = (provider: string, source: unknown, env: NodeJS.ProcessEnv = process.env): boolean => provider === "claude" && source === "issue" && envCardOn(env);
export type Service = "postgres" | "redis" | "mysql" | "mongodb";
export interface EnvCard { needs: { service: Service; version: string | null; from: string[] }[]; found: Record<string, { dir: string; bins: string[] } | null>; docker: "answering" | "not answering" | "not found" | "not checked"; text: string }
export const ENV_CARD_FILE = "env-card.json";
const SERVICES: Service[] = ["postgres", "redis", "mysql", "mongodb"];
const BINS: Record<Service, string[]> = { postgres: ["initdb", "pg_ctl", "postgres"], redis: ["redis-server"], mysql: ["mysqld", "mariadbd"], mongodb: ["mongod"] };
const KEG: Record<Service, RegExp> = { postgres: /^postgresql(@[\d.]+)?$/, redis: /^redis(@[\d.]+)?$/, mysql: /^(mysql|mariadb)(@[\d.]+)?$/, mongodb: /^mongodb-community(@[\d.]+)?$|^mongodb(@[\d.]+)?$/ };
const MAX_BYTES = 256 * 1024;
const read = (p: string): string => { try { return statSync(p).size <= MAX_BYTES ? readFileSync(p, "utf8") : ""; } catch { return ""; } };
const SKIP = new Set(["node_modules", ".git", ".loki", "dist", "build", "vendor", ".venv", "venv"]);
/** The repository root and its first-level directories (a backend/ or apps/x package), never deeper. */
function dirsOf(repoDir: string): string[] {
  const out = [repoDir];
  try { for (const n of readdirSync(repoDir)) { if (SKIP.has(n) || n.startsWith(".")) continue; const p = join(repoDir, n); try { if (statSync(p).isDirectory()) { out.push(p); for (const m of ["packages", "apps", "services"].includes(n) ? readdirSync(p) : []) { const q = join(p, m); if (!SKIP.has(m) && statSync(q).isDirectory()) out.push(q); } } } catch { /* unreadable entry */ } } } catch { /* unreadable root */ }
  return out.slice(0, 80);
}
const fromImage = (img: string): Service | null => /(^|\/)(postgres|postgis|timescaledb)/i.test(img) ? "postgres" : /(^|\/)(redis|valkey)/i.test(img) ? "redis" : /(^|\/)(mysql|mariadb)/i.test(img) ? "mysql" : /(^|\/)mongo/i.test(img) ? "mongodb" : null;
const DEP: [Service, RegExp][] = [
  ["postgres", /(^|["'\s/])(pg|postgres|pg-promise|postgres\.js|psycopg2?(-binary)?|psycopg\[?\w*\]?|asyncpg|lib\/pq|jackc\/pgx(\/v\d)?)(["'\s=<>~^@,;\[]|$)/m],
  ["redis", /(^|["'\s/])(redis|ioredis|@redis\/client|go-redis\/redis(\/v\d)?|redis\/go-redis(\/v\d)?|aioredis)(["'\s=<>~^@,;\[]|$)/m],
  ["mysql", /(^|["'\s/])(mysql|mysql2|mysqlclient|pymysql|aiomysql|go-sql-driver\/mysql|mariadb)(["'\s=<>~^@,;\[]|$)/m],
  ["mongodb", /(^|["'\s/])(mongodb|mongoose|pymongo|motor|mongo-driver)(["'\s=<>~^@,;\[]|$)/m],
];
/** Which of the four services the repository needs, read from files only. */
export function serviceNeeds(repoDir: string): EnvCard["needs"] {
  const need = new Map<Service, { version: string | null; from: Set<string> }>();
  const add = (s: Service, from: string, version: string | null = null): void => { const e = need.get(s) ?? { version: null, from: new Set<string>() }; e.from.add(from); if (version && !e.version) e.version = version; need.set(s, e); };
  for (const d of dirsOf(repoDir)) {
    let names: string[] = []; try { names = readdirSync(d); } catch { continue; }
    const rel = (n: string): string => (d === repoDir ? n : `${d.slice(repoDir.length + 1)}/${n}`);
    for (const n of names) {
      if (/^(docker-)?compose[\w.-]*\.ya?ml$/i.test(n)) for (const m of read(join(d, n)).matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) { const s = fromImage(m[1]!); if (s) add(s, rel(n), /:(\d+)/.exec(m[1]!)?.[1] ?? null); }
      if (/^\.env\.(example|sample)$/i.test(n)) for (const line of read(join(d, n)).split("\n")) { // keys and URL schemes only; no value is kept
        const key = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*["']?([a-z+]*)/.exec(line); if (!key) continue;
        const [k, scheme] = [key[1]!, key[2] ?? ""];
        if (/^postgres/.test(scheme) || /^(POSTGRES|PG)[A-Z_]*$/.test(k)) add("postgres", rel(n)); else if (/^mysql/.test(scheme) || /^MYSQL/.test(k)) add("mysql", rel(n)); else if (/^mongodb/.test(scheme) || /^MONGO/.test(k)) add("mongodb", rel(n)); else if (/^rediss?$/.test(scheme) || /^REDIS/.test(k)) add("redis", rel(n));
      }
      if (n === "package.json") { try { const j = JSON.parse(read(join(d, n))) as Record<string, Record<string, unknown> | undefined>; const deps = Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }).map((x) => `"${x}"`).join("\n"); for (const [s, re] of DEP) if (re.test(deps)) add(s, rel(n)); } catch { /* not JSON */ } }
      if (/^requirements[\w.-]*\.txt$/i.test(n) || n === "pyproject.toml" || n === "go.mod") { const t = read(join(d, n)).toLowerCase(); for (const [s, re] of DEP) if (re.test(t)) add(s, rel(n)); }
    }
  }
  return SERVICES.filter((s) => need.has(s)).map((s) => ({ service: s, version: need.get(s)!.version, from: [...need.get(s)!.from].sort() }));
}
/** The directories searched for a service's binaries, in order: PATH, then the Homebrew kegs, the Debian/Ubuntu postgresql dirs and Postgres.app.
 *  LOKI_E10_ENV_CARD_SEARCH (tests only) replaces the whole list with its own dirs, each read as a keg root and as a bin dir. */
function searchDirs(service: Service, version: string | null, env: NodeJS.ProcessEnv): string[] {
  const kegRoots = (env["LOKI_E10_ENV_CARD_SEARCH"] ?? "").trim() ? env["LOKI_E10_ENV_CARD_SEARCH"]!.split(delimiter).filter(Boolean) : null;
  const path = kegRoots ? kegRoots : (env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const kegs: string[] = [], ls = (d: string): string[] => { try { return readdirSync(d).sort(); } catch { return []; } };
  for (const root of kegRoots ?? ["/opt/homebrew/opt", "/usr/local/opt"]) for (const n of ls(root)) if (KEG[service].test(n)) kegs.push(join(root, n, "bin"));
  if (!kegRoots && service === "postgres") { for (const v of ls("/usr/lib/postgresql")) kegs.push(join("/usr/lib/postgresql", v, "bin")); for (const v of ls("/Applications/Postgres.app/Contents/Versions")) kegs.push(join("/Applications/Postgres.app/Contents/Versions", v, "bin")); }
  const want = version ? kegs.filter((k) => k.includes(`@${version}`) || k.includes(`/${version}/`)) : [];
  return [...path, ...want, ...kegs.filter((k) => !want.includes(k))];
}
const isExec = (p: string): boolean => { try { const s = statSync(p); return s.isFile() && (s.mode & 0o111) !== 0; } catch { return false; } };
/** The first searched dir that holds the service's binaries (for postgres all three, for mysql either server binary). */
export function locate(service: Service, version: string | null, env: NodeJS.ProcessEnv = process.env): { dir: string; bins: string[] } | null {
  for (const d of searchDirs(service, version, env)) {
    const bins = BINS[service].filter((b) => isExec(join(d, b)));
    if (service === "postgres" ? bins.length === 3 : bins.length > 0) return { dir: d, bins };
  }
  return null;
}
function dockerState(env: NodeJS.ProcessEnv): EnvCard["docker"] {
  if ((env["LOKI_E10_ENV_CARD_SEARCH"] ?? "").trim()) return "not checked"; // tests: never reach the machine's docker
  const bin = (env["PATH"] ?? "").split(delimiter).map((d) => join(d, "docker")).find(isExec);
  if (!bin) return "not found";
  try { const r = Bun.spawnSync([bin, "info", "--format", "{{.ServerVersion}}"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 1500, env: { PATH: env["PATH"] ?? "", HOME: env["HOME"] ?? "" } }); return r.exitCode === 0 && r.stdout.toString().trim() ? "answering" : "not answering"; } catch { return "not answering"; } // one short call; never starts or pulls anything
}
/** The card, or null when the repository needs none of the four services or anything went wrong. */
export function buildEnvCard(repoDir: string, env: NodeJS.ProcessEnv = process.env): EnvCard | null {
  try {
    const needs = serviceNeeds(repoDir);
    if (needs.length === 0) return null;
    const found: EnvCard["found"] = {}; for (const n of needs) found[n.service] = locate(n.service, n.version, env);
    const docker = dockerState(env);
    const parts = needs.filter((n) => found[n.service]).map((n) => { const f = found[n.service]!; const label = `${n.service}${n.version ? ` (the repository names ${n.version})` : ""}`; return f.bins.length === 1 ? `${label}: ${f.bins[0]} at ${join(f.dir, f.bins[0]!)}` : `${label}: ${f.bins.join(", ")} in ${f.dir}`; });
    const missing = needs.filter((n) => !found[n.service]).map((n) => n.service);
    const text = `Local services this repository needs and where they are on this machine (read from ${[...new Set(needs.flatMap((n) => n.from))].slice(0, 6).join(", ")}): ${[...parts, ...(missing.length ? [`Not found: ${missing.join(", ")}`] : []), `docker: ${docker === "answering" ? "on PATH, its daemon answers" : docker === "not answering" ? "on PATH, its daemon does not answer" : docker}`].join(". ")}. Call each binary by the full path given here; a keg directory is not on PATH.`;
    return { needs, found, docker, text };
  } catch { return null; }
}
/** The block for a brief: the card's text, or "" (no card, so the brief is byte-identical). */
export const envCardBlock = (card: EnvCard | null): string => (card ? card.text : "");
export function readEnvCard(runDir: string): EnvCard | null { try { const c = JSON.parse(readFileSync(join(runDir, ENV_CARD_FILE), "utf8")) as EnvCard; return c && Array.isArray(c.needs) && typeof c.text === "string" ? c : null; } catch { return null; } }
/** Services the card lists as needed but not found on this machine. */
export const missingServices = (card: EnvCard | null): string[] => (card ? card.needs.filter((n) => !card.found[n.service]).map((n) => n.service) : []);
export const envCardReceiptBlock = (runDir: string): { env_card?: { needs: EnvCard["needs"]; found: EnvCard["found"]; docker: EnvCard["docker"] } } => { const c = existsSync(join(runDir, ENV_CARD_FILE)) ? readEnvCard(runDir) : null; return c ? { env_card: { needs: c.needs, found: c.found, docker: c.docker } } : {}; };
