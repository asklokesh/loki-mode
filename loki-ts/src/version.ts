/**
 * Read VERSION from the repo root. Cached at module load.
 * Mirrors the bash idiom `cat VERSION` in autonomy/loki:cmd_version.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

let _version: string | null = null;

export function getVersion(): string {
  if (_version === null) {
    try {
      _version = readFileSync(resolve(REPO_ROOT, "VERSION"), "utf-8").trim();
    } catch {
      _version = "unknown";
    }
  }
  return _version;
}
