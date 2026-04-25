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
import { rm, stat } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const ENTRY = resolve(PKG_ROOT, "src", "cli.ts");
const OUTDIR = resolve(PKG_ROOT, "dist");
const OUTFILE = resolve(OUTDIR, "loki.js");

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

async function main(): Promise<number> {
  // Clean prior artifacts so a failed/partial build cannot masquerade as a
  // good one. Bun.build with `outdir` overwrites individual files but does
  // not garbage-collect stale chunks.
  await rm(OUTDIR, { recursive: true, force: true });

  const t0 = performance.now();

  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    naming: "loki.js",
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "external",
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
  return 0;
}

const code = await main();
process.exit(code);
