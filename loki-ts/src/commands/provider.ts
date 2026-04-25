// Port of autonomy/loki:cmd_provider (line 2572) + cmd_provider_show (2615)
// + cmd_provider_list (2708). Read-only operations only -- `set` stays in
// bash for Phase 2 (it mutates .loki/state/provider).
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { commandExists } from "../util/shell.ts";
import { BOLD, CYAN, GREEN, YELLOW, RED, DIM, NC } from "../util/colors.ts";
import { lokiDir } from "../util/paths.ts";

type Provider = "claude" | "codex" | "gemini" | "cline" | "aider";

const ALL_PROVIDERS: readonly Provider[] = ["claude", "codex", "gemini", "cline", "aider"];

function readSavedProvider(): string {
  const path = resolve(lokiDir(), "state", "provider");
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

function defaultProvider(positional: string | undefined, saved: string): string {
  return positional || saved || process.env["LOKI_PROVIDER"] || "claude";
}

export function runProviderShow(positional?: string): number {
  const saved = readSavedProvider();
  const current = defaultProvider(positional, saved);

  process.stdout.write(`${BOLD}Current Provider${NC}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`${CYAN}Provider:${NC} ${current}\n`);

  switch (current) {
    case "claude":
      process.stdout.write(`${GREEN}Status:${NC}   Full features (subagents, parallel, MCP)\n`);
      break;
    case "cline":
      process.stdout.write(`${GREEN}Status:${NC}   Near-full mode (subagents, MCP, 12+ providers)\n`);
      break;
    case "codex":
    case "gemini":
    case "aider":
      process.stdout.write(`${YELLOW}Status:${NC}   Degraded mode (sequential only)\n`);
      break;
    default:
      // Match bash: no status line for unknown providers.
      break;
  }

  if (saved) {
    process.stdout.write(`${DIM}(saved in .loki/state/provider)${NC}\n`);
  } else {
    process.stdout.write(`${DIM}(default - not explicitly set)${NC}\n`);
  }

  process.stdout.write(`\n`);
  process.stdout.write(`Switch provider: ${CYAN}loki provider set <name>${NC}\n`);
  process.stdout.write(`Available:       ${CYAN}loki provider list${NC}\n`);
  return 0;
}

export async function runProviderList(): Promise<number> {
  const saved = readSavedProvider();
  const current = saved || process.env["LOKI_PROVIDER"] || "claude";

  process.stdout.write(`${BOLD}Available Providers${NC}\n`);
  process.stdout.write(`\n`);

  const installed = await Promise.all(
    ALL_PROVIDERS.map(async (p) => [p, (await commandExists(p)) !== null] as const),
  );
  const statusOf = new Map<Provider, string>();
  for (const [p, isInstalled] of installed) {
    statusOf.set(p, isInstalled ? `${GREEN}installed${NC}` : `${RED}not installed${NC}`);
  }

  // Bash output preserves exact column alignment via padded labels.
  const rows: ReadonlyArray<readonly [Provider, string]> = [
    ["claude", "claude  - Claude Code (Anthropic)    "],
    ["codex", "codex   - Codex CLI (OpenAI)         "],
    ["gemini", "gemini  - Gemini CLI (Google)        "],
    ["cline", "cline   - Cline (multi-provider)     "],
    ["aider", "aider   - Aider (terminal pair prog) "],
  ];

  for (const [p, label] of rows) {
    const marker = current === p ? ` ${CYAN}(current)${NC}` : "";
    process.stdout.write(`  ${label} ${statusOf.get(p)}${marker}\n`);
  }

  process.stdout.write(`\n`);
  process.stdout.write(`Set provider: ${CYAN}loki provider set <name>${NC}\n`);
  return 0;
}

export function printProviderHelp(): number {
  process.stdout.write(`${BOLD}Loki Mode Provider Management${NC}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Usage: loki provider <command>\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  show     Show current provider (default)\n`);
  process.stdout.write(`  set      Set provider for this project\n`);
  process.stdout.write(`  list     List available providers\n`);
  process.stdout.write(`  info     Show provider details\n`);
  process.stdout.write(`  models   Show resolved model configuration for all providers\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Examples:\n`);
  process.stdout.write(`  loki provider show\n`);
  process.stdout.write(`  loki provider set claude\n`);
  process.stdout.write(`  loki provider set codex\n`);
  process.stdout.write(`  loki provider list\n`);
  process.stdout.write(`  loki provider info gemini\n`);
  process.stdout.write(`  loki provider models\n`);
  return 0;
}

export async function runProvider(argv: readonly string[]): Promise<number> {
  const sub = argv[0] ?? "show";
  const rest = argv.slice(1);
  switch (sub) {
    case "show":
    case "current":
      return runProviderShow(rest[0]);
    case "list":
      return runProviderList();
    case "set":
    case "info":
    case "models":
      // Defer to bash for write/lookup commands not in Phase 2 scope.
      return execLegacyBash(["provider", sub, ...rest]);
    default:
      return printProviderHelp();
  }
}

// Hand off to autonomy/loki for commands that aren't in this phase yet.
// Defined here to avoid a circular import; cli.ts also exports a copy.
async function execLegacyBash(args: readonly string[]): Promise<number> {
  const { run } = await import("../util/shell.ts");
  const { resolve: resolvePath } = await import("node:path");
  const { REPO_ROOT } = await import("../util/paths.ts");
  const bashCmd = resolvePath(REPO_ROOT, "autonomy", "loki");
  const r = await run([bashCmd, ...args], { env: { LOKI_LEGACY_BASH: "1" } });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.exitCode;
}
