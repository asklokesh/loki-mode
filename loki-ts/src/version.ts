/**
 * Read VERSION from the repo root. Cached at module load.
 * Mirrors the bash idiom `cat VERSION` in autonomy/loki:cmd_version.
 *
 * v7.4.3 (BUG-8): when invoked from a bun build --compile standalone binary,
 * import.meta.url doesn't resolve to a real file path so readFileSync throws
 * and we'd return "unknown". We now check for a build-time injected version
 * first (set via Bun.build define), then fall back to the on-disk read.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRootForVersion } from "./util/paths.ts";

let _version: string | null = null;

declare global {
  // Optional build-time version constant; populated by scripts/build.ts via
  // Bun.build({define: { "globalThis.__LOKI_BUILD_VERSION__": "..." }}).
  // Falsy when running unbundled (source mode).
  // eslint-disable-next-line no-var
  var __LOKI_BUILD_VERSION__: string | undefined;
}

export function getVersion(): string {
  if (_version !== null) return _version;
  // Build-time injection wins (set by Bun.build define).
  const injected = (globalThis as { __LOKI_BUILD_VERSION__?: string }).__LOKI_BUILD_VERSION__;
  if (typeof injected === "string" && injected.length > 0) {
    _version = injected;
    return _version;
  }
  // Fall back to on-disk read (source mode + dist run from repo).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = findRepoRootForVersion(here);
    _version = readFileSync(resolve(repoRoot, "VERSION"), "utf-8").trim();
  } catch {
    _version = "unknown";
  }
  return _version;
}
