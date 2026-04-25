// Repo + .loki path resolution.
// Mirrors autonomy/loki:67-91 (find_skill_dir) and :128 (LOKI_DIR default).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

// Walk up from the bundle/source location until we find a directory
// containing both VERSION and autonomy/run.sh -- the repo root marker.
// This works for both `bun src/cli.ts` (HERE = loki-ts/src/util) and
// `bun loki-ts/dist/loki.js` (HERE = loki-ts/dist), avoiding the bug
// where a hardcoded depth resolved to the wrong directory in dist mode.
function findRepoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, "VERSION")) && existsSync(resolve(dir, "autonomy/run.sh"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback (older behavior) -- 3 levels up from src/util/paths.ts.
  return resolve(HERE, "..", "..", "..");
}

export const REPO_ROOT = findRepoRoot();

// Honor LOKI_DIR env var; default to ./.loki relative to cwd (bash idiom).
export function lokiDir(): string {
  return process.env["LOKI_DIR"] ?? resolve(process.cwd(), ".loki");
}

export function homeLokiDir(): string {
  return resolve(homedir(), ".loki");
}

// Verify the SKILL.md and autonomy/run.sh markers exist (mirror find_skill_dir).
export function findSkillDir(): string | null {
  const candidates = [REPO_ROOT, resolve(homedir(), ".claude/skills/loki-mode"), process.cwd()];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, "SKILL.md")) && existsSync(resolve(dir, "autonomy/run.sh"))) {
      return dir;
    }
  }
  return null;
}
