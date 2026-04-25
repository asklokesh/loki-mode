// Repo + .loki path resolution.
// Mirrors autonomy/loki:67-91 (find_skill_dir) and :128 (LOKI_DIR default).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

// loki-ts/src/util -> loki-ts/src -> loki-ts -> repo root
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

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
