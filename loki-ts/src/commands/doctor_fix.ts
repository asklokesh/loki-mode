// `loki doctor --fix`: apply safe automatic fixes, print exact commands for
// anything that needs sudo, a system package manager or a network install.
// Safe = local, reversible, inside the user's own home or project dir.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tokenFreeEnv } from "../util/safe_git.ts";
import { claudeAuthStatusLoggedIn, evaluateClaudeLogin } from "./doctor.ts";

export interface FixResult {
  applied: string[];
  manual: string[];
  /** Required steps that ran and failed ("<command>: <first stderr line>"). */
  failed: string[];
}

export interface StepOutcome {
  status: number | null;
  stderr: string;
}

/** Runs one command (argv[0] plus args). Injectable so tests never install anything. */
export type StepRunner = (argv: readonly string[]) => StepOutcome;

export interface FixDeps {
  has?: (cmd: string) => boolean;
  runner?: StepRunner;
  tty?: boolean;
  yes?: boolean;
  confirm?: (question: string) => boolean;
  loggedIn?: () => "yes" | "no" | "";
}

const PROVIDER_CLIS = ["claude", "codex", "cline", "aider", "opencode"] as const;
const CLAUDE_INSTALL = ["npm", "install", "-g", "@anthropic-ai/claude-code"] as const;
const CLAUDE_LOGIN = ["claude", "login"] as const;

const defaultRunner: StepRunner = (argv) => {
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd!, args, { stdio: ["inherit", "inherit", "pipe"], encoding: "utf8", env: tokenFreeEnv() });
  if (r.error) return { status: null, stderr: String(r.error.message) };
  return { status: r.status, stderr: r.stderr ?? "" };
};

function defaultConfirm(question: string): boolean {
  process.stdout.write(`${question} [y/N] `);
  const buf = Buffer.alloc(256);
  let n = 0;
  try {
    n = readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  return /^\s*y(es)?\s*$/i.test(buf.toString("utf8", 0, n));
}

function firstLine(text: string, fallback: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return (line ?? fallback).slice(0, 200);
}

function defaultHas(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } }).status === 0;
}

const MANUAL: Record<string, string> = {
  node: "Install Node.js 20+: https://nodejs.org (or: brew install node)",
  python3: "Install Python 3.8+: brew install python3 (macOS) or your distro package manager",
  jq: "Install jq: brew install jq (macOS) or apt install jq / dnf install jq (Linux)",
  git: "Install git: brew install git (macOS) or apt install git (Linux)",
  curl: "Install curl: brew install curl (macOS) or apt install curl (Linux)",
};

export function applyDoctorFixes(cwd: string = process.cwd(), home: string = homedir(), deps: FixDeps = {}): FixResult {
  const applied: string[] = [];
  const manual: string[] = [];
  const failed: string[] = [];
  const has = deps.has ?? defaultHas;
  const runner = deps.runner ?? defaultRunner;
  const tty = deps.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const yes = deps.yes === true;
  const confirm = deps.confirm ?? defaultConfirm;

  // Consent gate: --yes runs unasked, a TTY asks y/N, anything else prints the command only.
  const runStep = (argv: readonly string[], question: string): boolean | null => {
    if (!yes && !(tty && confirm(question))) return null;
    const r = runner(argv);
    const cmd = argv.join(" ");
    if (r.status === 0) {
      applied.push(cmd);
      return true;
    }
    failed.push(`${cmd}: ${firstLine(r.stderr, `exit ${r.status}`)}`);
    return false;
  };

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

  // 2. Seed project config defaults: first installed provider CLI, claude when none is installed.
  const seedProvider = PROVIDER_CLIS.find((c) => has(c)) ?? "claude";
  const cfgDir = join(cwd, ".loki", "config");
  const cfgFile = join(cfgDir, "settings.json");
  if (!existsSync(cfgFile)) {
    try {
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(cfgFile, JSON.stringify({ provider: seedProvider }, null, 2) + "\n");
      applied.push(`wrote default config ${cfgFile} (provider=${seedProvider})`);
    } catch (e) {
      manual.push(`loki config set provider claude   (${(e as Error).message})`);
    }
  } else {
    try {
      JSON.parse(readFileSync(cfgFile, "utf8"));
    } catch {
      const manualLine = `${cfgFile} is not valid JSON; fix or delete it, then run: loki config set provider claude`;
      if (!yes && !(tty && confirm(`Back up invalid ${cfgFile} and rewrite defaults?`))) {
        manual.push(manualLine);
      } else {
        const backup = `${cfgFile}.invalid-${Date.now()}`;
        try {
          copyFileSync(cfgFile, backup);
          writeFileSync(cfgFile, JSON.stringify({ provider: seedProvider }, null, 2) + "\n");
          applied.push(`backed up invalid ${cfgFile} to ${backup} and rewrote defaults (provider=${seedProvider})`);
        } catch (e) {
          manual.push(`${manualLine}   (${(e as Error).message})`);
        }
      }
    }
  }

  // 3. Required tools and providers: never install system packages here.
  for (const tool of ["node", "python3", "jq", "git", "curl"]) {
    if (!has(tool)) manual.push(MANUAL[tool]!);
  }
  const providers = PROVIDER_CLIS;
  if (!has("claude")) {
    const installed = has("npm") ? runStep(CLAUDE_INSTALL, `Install claude (${CLAUDE_INSTALL.join(" ")})?`) : null;
    if (installed === null) {
      manual.push("claude (default provider): npm install -g @anthropic-ai/claude-code   (then: claude login)");
    }
  }
  if (has("claude")) {
    const login = evaluateClaudeLogin((deps.loggedIn ?? (() => claudeAuthStatusLoggedIn()))());
    if (login.status === "fail" && runStep(CLAUDE_LOGIN, `Run claude login now?`) === null) {
      manual.push("claude login   (or set ANTHROPIC_API_KEY)");
    }
  }
  if (!providers.some((c) => has(c))) {
    manual.push("No provider CLI found: install claude (above), or codex/cline/aider/opencode, or run: loki setup");
  }
  if (!has("bun")) {
    manual.push("bun (optional, bundled by the npm package): see https://bun.sh");
  }
  return { applied, manual, failed };
}

export function runDoctorFix(opts: FixDeps & { cwd?: string; home?: string } = {}): number {
  const { applied, manual, failed } = applyDoctorFixes(opts.cwd, opts.home, opts);
  process.stdout.write(`\nloki doctor --fix\n`);
  if (applied.length === 0 && failed.length === 0) process.stdout.write(`  Nothing to fix automatically.\n`);
  for (const a of applied) process.stdout.write(`  fixed: ${a}\n`);
  for (const f of failed) process.stdout.write(`  failed: ${f}\n`);
  if (manual.length > 0) {
    process.stdout.write(`\nRun these yourself (need a package manager, sudo, network or your consent):\n`);
    for (const m of manual) process.stdout.write(`  ${m}\n`);
  }
  return failed.length > 0 ? 1 : 0;
}
