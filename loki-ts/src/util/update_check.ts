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
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

// A SHADOWED INSTALL is a newer loki-mode that is already installed but sits
// later on PATH than an older one, so the old binary keeps winning.
//
// Reported by a user: `bun install -g loki-mode` said "installed
// loki-mode@9.35.0", then `loki --version` printed 9.22.3 and the update nudge
// told them to run the install they had just run. Reinstalling cannot fix this
// -- it updates a copy that PATH never reaches -- so the nudge sent them round a
// loop with no exit. The cause was a leftover ~/.local/bin/loki symlink into an
// old npm-global tree, shadowing ~/.bun/bin/loki.
//
// Returns the first install on PATH that is strictly newer than the running one,
// or null. Best-effort and fully fail-silent: an unreadable entry is skipped, so
// the worst case is the ordinary nudge, never a crash or a false report.
export function findShadowedNewerInstall(
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; version: string } | null {
  const cur = parseSemver(current);
  if (cur === null) return null;
  const pathVar = env["PATH"];
  if (!pathVar) return null;

  const seen = new Set<string>();
  for (const dir of pathVar.split(":")) {
    if (!dir) continue;
    const bin = join(dir, "loki");
    let real: string;
    try {
      statSync(bin);
      real = realpathSync(bin);
    } catch {
      continue; // no loki here, or unreadable
    }
    if (seen.has(real)) continue;
    seen.add(real);
    // bin/loki lives at <pkg>/bin/loki, so package.json is two levels up.
    try {
      const pkg = join(dirname(dirname(real)), "package.json");
      const version = JSON.parse(readFileSync(pkg, "utf8")).version;
      if (typeof version !== "string") continue;
      if (isNewer(version, current)) return { path: bin, version };
    } catch {
      continue; // not a package layout we recognise; skip it
    }
  }
  return null;
}

// Post-upgrade notice (TEN-ADOPTION-12): print a one-line what-is-new once per
// version, the first time a newer loki runs after an upgrade. No network call:
// it compares the running version against the last version this machine saw,
// stored in ~/.loki/cache/last-seen-version.json. A first run (no record) only
// records the version and prints nothing. Skipped like the update nudge (opt-out
// via LOKI_NO_UPDATE_CHECK, CI, non-TTY), and a skipped run does not record, so
// the notice still appears at the next interactive run. Returns true if printed.
export function defaultSeenPath(): string {
  return resolve(homeLokiDir(), "cache", "last-seen-version.json");
}

export function maybePrintWhatsNew(
  current: string,
  opts: { write?: (msg: string) => void; seenFile?: string } = {},
): boolean {
  try {
    if (shouldSkipUpdateCheck()) return false;
    if (parseSemver(current) === null) return false;
    const file = opts.seenFile ?? defaultSeenPath();
    let seen: string | null = null;
    try {
      const v = (JSON.parse(readFileSync(file, "utf-8")) as { version?: unknown }).version;
      if (typeof v === "string" && parseSemver(v) !== null) seen = v;
    } catch {
      // missing/corrupt record -> treat as first run
    }
    // Same version (once-only) and downgrades never print or overwrite the record.
    if (seen !== null && !isNewer(current, seen)) return false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: current }), "utf-8");
    } catch {
      return false; // cannot persist -> stay silent rather than repeat every run
    }
    if (seen === null) return false;
    const write = opts.write ?? ((m: string) => process.stderr.write(m));
    write(
      `Loki Mode upgraded ${seen} -> ${current}. ` +
        `What is new: https://github.com/asklokesh/loki-mode/releases/tag/v${current}\n`,
    );
    return true;
  } catch {
    return false;
  }
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
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  try {
    if (shouldSkipUpdateCheck()) return;
    if (parseSemver(current) === null) return; // e.g. "unknown" -> never nudge
    const write = opts.write ?? ((m: string) => process.stderr.write(m));
    maybePrintWhatsNew(current, {
      write,
      ...(opts.cacheFile ? { seenFile: join(dirname(opts.cacheFile), "last-seen-version.json") } : {}),
    });

    // SHADOW CHECK RUNS FIRST, BEFORE any registry lookup.
    //
    // It used to sit INSIDE the "a newer release exists" branch, which made the
    // most damaging case unreachable: a user whose PATH is shadowed by a stale
    // copy got the generic "install it again" nudge, quoting whatever version
    // the <=24h cache happened to hold. Reported from the field twice: bun
    // reported `installed loki-mode@9.39.0`, `loki --version` printed 9.22.3,
    // and the nudge advised installing 9.35.0 -- three different numbers, and
    // the advice could not work because the newer copy was ALREADY on disk.
    //
    // Shadowing is a local, on-disk condition. It does not depend on what the
    // registry says, on the cache being fresh, or on the network being up, so
    // nothing about a registry result should gate reporting it.
    const shadowed = findShadowedNewerInstall(current, opts.env ?? process.env);
    if (shadowed !== null) {
      write(
        `Loki Mode ${shadowed.version} is installed but not the one running ` +
          `(you are running ${current}).\n` +
          `  Another loki earlier on PATH is winning. Newer copy: ${shadowed.path}\n` +
          `  Run \`which -a loki\` to see the order, then remove or re-point the ` +
          `earlier entry.\n`,
      );
      return;
    }

    // No shadow: fall through to the ordinary "a newer release exists" nudge,
    // which DOES need the registry.
    const latest = await resolveLatest(opts.now, opts.fetcher, opts.cacheFile);
    if (latest === null) return;
    if (!isNewer(latest, current)) return;

    write(
      `A newer Loki Mode is available: ${latest} (you have ${current}). ` +
        `Update: bun install -g loki-mode  (or npm i -g loki-mode)\n`,
    );
  } catch {
    // a nudge must never break the command it is attached to
  }
}
