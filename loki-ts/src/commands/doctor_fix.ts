// `loki doctor --fix`: apply safe automatic fixes, print exact commands for
// anything that needs sudo, a system package manager or a network install.
// Safe = local, reversible, inside the user's own home or project dir.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface FixResult {
  applied: string[];
  manual: string[];
}

function has(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

const MANUAL: Record<string, string> = {
  node: "Install Node.js 20+: https://nodejs.org (or: brew install node)",
  python3: "Install Python 3.8+: brew install python3 (macOS) or your distro package manager",
  jq: "Install jq: brew install jq (macOS) or apt install jq / dnf install jq (Linux)",
  git: "Install git: brew install git (macOS) or apt install git (Linux)",
  curl: "Install curl: brew install curl (macOS) or apt install curl (Linux)",
};

export function applyDoctorFixes(cwd: string = process.cwd(), home: string = homedir()): FixResult {
  const applied: string[] = [];
  const manual: string[] = [];

  // 1. Create the state directories Loki writes to.
  for (const dir of [join(home, ".loki"), join(home, ".config", "loki-mode"), join(cwd, ".loki")]) {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
        applied.push(`created ${dir}`);
      } catch (e) {
        manual.push(`mkdir -p ${dir}   (${(e as Error).message})`);
      }
    }
  }

  // 2. Seed project config defaults (Claude Code is the default provider).
  const cfgDir = join(cwd, ".loki", "config");
  const cfgFile = join(cfgDir, "settings.json");
  if (!existsSync(cfgFile)) {
    try {
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(cfgFile, JSON.stringify({ provider: "claude" }, null, 2) + "\n");
      applied.push(`wrote default config ${cfgFile} (provider=claude)`);
    } catch (e) {
      manual.push(`loki config set provider claude   (${(e as Error).message})`);
    }
  } else {
    try {
      JSON.parse(readFileSync(cfgFile, "utf8"));
    } catch {
      manual.push(`${cfgFile} is not valid JSON; fix or delete it, then run: loki config set provider claude`);
    }
  }

  // 3. Required tools and providers: never install system packages here.
  for (const tool of ["node", "python3", "jq", "git", "curl"]) {
    if (!has(tool)) manual.push(MANUAL[tool]!);
  }
  const providers = ["claude", "codex", "cline", "aider", "opencode"];
  if (!has("claude")) {
    manual.push("claude (default provider): npm install -g @anthropic-ai/claude-code   (then: claude auth login)");
  }
  if (!providers.some((c) => has(c))) {
    manual.push("No provider CLI found: install claude (above), or codex/cline/aider/opencode, or run: loki setup");
  }
  if (!has("bun")) {
    manual.push("bun (optional, bundled by the npm package): see https://bun.sh");
  }
  return { applied, manual };
}

export function runDoctorFix(): void {
  const { applied, manual } = applyDoctorFixes();
  process.stdout.write(`\nloki doctor --fix\n`);
  if (applied.length === 0) process.stdout.write(`  Nothing to fix automatically.\n`);
  for (const a of applied) process.stdout.write(`  fixed: ${a}\n`);
  if (manual.length > 0) {
    process.stdout.write(`\nRun these yourself (need a package manager, sudo or network):\n`);
    for (const m of manual) process.stdout.write(`  ${m}\n`);
  }
}
