/**
 * Build script: produce a self-contained `dist/loki.js` artifact via Bun.build.
 *
 * Phase 3 of the bash->Bun migration: ship a single bundled JavaScript file
 * to npm so end users get a fast, dependency-free TypeScript CLI without
 * shipping the entire src/ tree or invoking a build at install time.
 *
 * Output:
 *   loki-ts/dist/loki.js       -- minified, tree-shaken bundle
 *   loki-ts/dist/loki.js.map   -- external source map
 *
 * Externals: node:* and bun:* builtins are left as runtime imports; every
 * other dependency is bundled. We currently have zero npm runtime deps,
 * so the tree-shake pass is mostly a safety net.
 *
 * Run: bun run scripts/build.ts
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rm, stat, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..");
const ENTRY = resolve(PKG_ROOT, "src", "cli.ts");
const OUTDIR = resolve(PKG_ROOT, "dist");
const OUTFILE = resolve(OUTDIR, "loki.js");

// v7.4.3 (BUG-8): read the canonical version from VERSION at build time so
// `bun build --compile` standalone binaries print the real version instead
// of "unknown" (the runtime version.ts reads VERSION from disk via
// import.meta.url, which doesn't resolve inside a compiled binary).
async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(resolve(REPO_ROOT, "VERSION"), "utf-8");
    return raw.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Build with module identities rooted at the package instead of the checkout.
 * Bun includes resolved module identities in its debugId. An explicit root
 * keeps source-map identities stable when the same tree is built in another
 * worktree, provided dependencies live beneath that root as they do in a
 * normal install. Bun's generated debugId still includes checkout entropy, so
 * the bundle/map pair is assigned a content-derived replacement below.
 */
const BUNDLE_DEBUG_ID_RE = /\/\/# debugId=([A-F0-9]{32})/;
const MAP_DEBUG_ID_RE = /(\"debugId\"\s*:\s*\")([A-F0-9]{32})(\")/;

export async function writeDeterministicDebugId(outfile: string): Promise<void> {
  const mapfile = `${outfile}.map`;
  const [bundle, map] = await Promise.all([
    readFile(outfile, "utf8"),
    readFile(mapfile, "utf8"),
  ]);
  if (!BUNDLE_DEBUG_ID_RE.test(bundle) || !MAP_DEBUG_ID_RE.test(map)) {
    throw new Error(`build output is missing a debugId: ${outfile}`);
  }

  const zeroId = "0".repeat(32);
  const neutralBundle = bundle.replace(BUNDLE_DEBUG_ID_RE, `//# debugId=${zeroId}`);
  const neutralMap = map.replace(
    MAP_DEBUG_ID_RE,
    (_match, prefix: string, _id: string, suffix: string) => `${prefix}${zeroId}${suffix}`,
  );
  const debugId = createHash("sha256")
    .update(neutralBundle)
    .update("\0")
    .update(neutralMap)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();

  await Promise.all([
    writeFile(outfile, neutralBundle.replace(BUNDLE_DEBUG_ID_RE, `//# debugId=${debugId}`)),
    writeFile(
      mapfile,
      neutralMap.replace(
        MAP_DEBUG_ID_RE,
        (_match, prefix: string, _id: string, suffix: string) => `${prefix}${debugId}${suffix}`,
      ),
    ),
  ]);
}

export async function buildWithDeterministicRoot(
  root: string,
  outfile: string,
  config: Omit<Bun.BuildConfig, "root">,
) {
  const result = await Bun.build({ ...config, root });
  if (result.success) await writeDeterministicDebugId(outfile);
  return result;
}

async function main(): Promise<number> {
  // Clean prior artifacts so a failed/partial build cannot masquerade as a
  // good one. Bun.build with `outdir` overwrites individual files but does
  // not garbage-collect stale chunks.
  await rm(OUTDIR, { recursive: true, force: true });

  const t0 = performance.now();
  const version = await readVersion();

  const result = await buildWithDeterministicRoot(PKG_ROOT, OUTFILE, {
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    naming: "loki.js",
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "external",
    // v7.4.3 (BUG-8): inject the version at build time so the standalone
    // compiled binary (bun build --compile) doesn't print "unknown".
    define: {
      "globalThis.__LOKI_BUILD_VERSION__": JSON.stringify(version),
    },
    // Bun automatically treats `node:*` and `bun:*` specifiers as externals
    // when target is "bun"; declaring them here is belt-and-suspenders so
    // the intent is obvious to future maintainers.
    external: ["node:*", "bun:*"],
    // Tree-shaking is on by default for ESM output; we set splitting=false
    // so the artifact is a single file (matches the spec).
    splitting: false,
  });

  const elapsedMs = performance.now() - t0;

  if (!result.success) {
    process.stderr.write("build: FAILED\n");
    for (const log of result.logs) {
      process.stderr.write(`  ${log}\n`);
    }
    return 1;
  }

  const info = await stat(OUTFILE);
  process.stdout.write(
    `build: ok  ${formatBytes(info.size)}  ${elapsedMs.toFixed(1)} ms  ->  ${OUTFILE}\n`,
  );

  // Second entry: the cockpit render CLI (invoked by autonomy/lib/
  // cockpit-render.sh). Bundled to dist/cockpit.js so it SHIPS with the npm
  // package (which ships loki-ts/dist/ but NOT loki-ts/src/); without this the
  // installed `loki cockpit` could never render an inline image and would
  // silently fall back on every install.
  const cockpitEntry = resolve(PKG_ROOT, "src", "cockpit", "cli.ts");
  const cockpitOut = resolve(OUTDIR, "cockpit.js");
  const cockpitResult = await buildWithDeterministicRoot(PKG_ROOT, cockpitOut, {
    entrypoints: [cockpitEntry],
    outdir: OUTDIR,
    naming: "cockpit.js",
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "external",
    external: ["node:*", "bun:*", "@resvg/resvg-js"],
    splitting: false,
  });
  if (!cockpitResult.success) {
    process.stderr.write("build: cockpit bundle FAILED\n");
    for (const log of cockpitResult.logs) process.stderr.write(`  ${log}\n`);
    return 1;
  }
  const cockpitInfo = await stat(cockpitOut);
  process.stdout.write(
    `build: ok  ${formatBytes(cockpitInfo.size)}  ->  ${cockpitOut}\n`,
  );
  return 0;
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
