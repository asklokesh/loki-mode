// Stale-install nudge (F54): print a one-line hint when a newer loki-mode is
// published on npm. Designed to be honest, non-intrusive, and add zero latency
// on the hot path:
//   - result is cached in ~/.loki/cache/update-check.json for >= 24h, so the
//     network is hit at most once a day;
//   - the network fetch has a short timeout and is fully fail-silent;
//   - the check is skipped entirely in non-TTY / CI contexts and when opted
//     out via LOKI_NO_UPDATE_CHECK=1;
//   - the hint is written to stderr so stdout stays byte-for-byte stable for
//     scripts/parsers (and the bash<->bun version parity test).
//
// We never fabricate a version: the hint prints only when a successful network
// check (or a fresh cache from one) reports a strictly newer semver.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homeLokiDir } from "./paths.ts";

const REGISTRY_URL = "https://registry.npmjs.org/loki-mode/latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 1500;

interface UpdateCache {
  // Wall-clock ms when the registry was last queried successfully.
  checkedAt: number;
  // Latest version string from the registry (validated semver-ish).
  latest: string;
}

// Default cache location under ~/.loki. Injectable in resolveLatest /
// maybePrintUpdateHint so tests can point at a throwaway dir (note: os.homedir()
// ignores a mutated $HOME on macOS, so we cannot rely on env stubbing here).
export function defaultCachePath(): string {
  return resolve(homeLokiDir(), "cache", "update-check.json");
}

// Parse a "major.minor.patch" prefix into a numeric tuple. Returns null if the
// string is not a usable release version (e.g. "unknown", prereleases, garbage).
// Prereleases (containing "-") are deliberately rejected so we never nudge a
// user toward a non-stable tag.
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Returns true iff `latest` is strictly newer than `current`. Defensive: any
// unparseable input yields false (never nudge on ambiguous data).
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  const [aMaj, aMin, aPat] = a;
  const [bMaj, bMin, bPat] = b;
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

// True when an update check should be skipped without touching disk or network.
// Exported for tests.
export function shouldSkipUpdateCheck(): boolean {
  if (process.env["LOKI_NO_UPDATE_CHECK"] === "1") return true;
  // Common CI signal: most CI providers set CI=true/1/anything non-empty.
  if (process.env["CI"]) return true;
  // Only nudge interactive users; never in pipes, redirects, or daemons.
  if (!process.stdout.isTTY) return true;
  return false;
}

function readCache(file: string): UpdateCache | null {
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    if (
      typeof parsed.checkedAt === "number" &&
      typeof parsed.latest === "string" &&
      parseSemver(parsed.latest) !== null
    ) {
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    }
  } catch {
    // missing/corrupt cache -> treat as no cache
  }
  return null;
}

function writeCache(file: string, c: UpdateCache): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(c), "utf-8");
  } catch {
    // best-effort: a non-writable HOME must never break `loki version`
  }
}

// Fetch the latest published version from the npm registry. Fail-silent: any
// error (offline, timeout, non-2xx, bad JSON, missing version) returns null.
async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version === "string" && parseSemver(body.version) !== null) {
      return body.version;
    }
  } catch {
    // offline/slow/blocked -> print nothing
  }
  return null;
}

// Resolve the latest known version, preferring a fresh (< 24h) cache so we hit
// the network at most once a day. On a cache miss, query the registry and
// persist the result. Always fail-silent (returns null on any failure).
//
// `now` and `fetcher` are injectable for deterministic tests.
export async function resolveLatest(
  now: number = Date.now(),
  fetcher: () => Promise<string | null> = fetchLatest,
  cacheFile: string = defaultCachePath(),
): Promise<string | null> {
  const cached = readCache(cacheFile);
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
    return cached.latest;
  }
  const latest = await fetcher();
  if (latest === null) return null;
  writeCache(cacheFile, { checkedAt: now, latest });
  return latest;
}

// Top-level entry: print the nudge to stderr if (and only if) a successful,
// non-fabricated check reports a strictly newer release. Never throws.
//
// `current` is the running version. `now`/`fetcher`/`write` are injectable for
// tests.
export async function maybePrintUpdateHint(
  current: string,
  opts: {
    now?: number;
    fetcher?: () => Promise<string | null>;
    write?: (msg: string) => void;
    cacheFile?: string;
  } = {},
): Promise<void> {
  try {
    if (shouldSkipUpdateCheck()) return;
    if (parseSemver(current) === null) return; // e.g. "unknown" -> never nudge
    const latest = await resolveLatest(opts.now, opts.fetcher, opts.cacheFile);
    if (latest === null) return;
    if (!isNewer(latest, current)) return;
    const write = opts.write ?? ((m: string) => process.stderr.write(m));
    write(
      `A newer Loki Mode is available: ${latest} (you have ${current}). ` +
        `Update: bun install -g loki-mode  (or npm i -g loki-mode)\n`,
    );
  } catch {
    // a nudge must never break the command it is attached to
  }
}
