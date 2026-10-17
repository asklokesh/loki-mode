// `loki wiki` - auto-generated, cited per-project codebase wiki + Q&A (R5).
//
// Loki's answer to Devin DeepWiki. The Bun route implements `show` natively
// (reads the rendered markdown the generator wrote under .loki/wiki/), and
// delegates `generate` and `ask` to the bash CLI -- which runs the Python core
// (autonomy/lib/wiki-generator.py / wiki-ask.py). This mirrors the proof
// precedent: native reads, delegate the heavy/provider work. `generate` and
// `ask` need a provider call + the codebase index, so keeping one
// implementation (Python) avoids a parity drift surface.
//
// Routing note: the bin/loki shim allowlist includes "wiki", so a real
// `loki wiki ...` invocation routes here when bun is installed. The bash
// cmd_wiki (autonomy/loki) is the fallback for no-bun systems and the
// LOKI_LEGACY_BASH=1 escape hatch; `show` is kept at parity with the bash
// route (see loki-ts/tests/commands/wiki.test.ts).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../util/paths.ts";
import { BOLD, NC, RED, YELLOW } from "../util/colors.ts";

const HELP = `${BOLD}loki wiki${NC} - Auto-generated, cited codebase wiki + Q&A

Usage: loki wiki <command> [options]

Commands:
  generate [path] [--force]   Build/refresh the cited wiki in .loki/wiki/
  show [section]              Print the wiki (or one section: architecture|modules|data-flow)
  ask "<question>"           Cited answer grounded in the codebase (file:line)

Each wiki section cites the real source files it was built from.
Generation is incremental: it skips when the codebase is unchanged.

Examples:
  loki wiki generate
  loki wiki show architecture
  loki wiki ask "how does the cli dispatch commands"
`;

const SECTIONS = new Set(["architecture", "modules", "data-flow"]);

function wikiDir(): string {
  return join(process.cwd(), ".loki", "wiki");
}

function runShow(args: string[]): number {
  let section = "";
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: loki wiki show [section]\nSections: architecture, modules, data-flow\n",
      );
      return 0;
    }
    if (a.startsWith("-")) {
      process.stderr.write(`${RED}Unknown option: ${a}${NC}\n`);
      return 1;
    }
    if (section) {
      process.stderr.write(
        `${RED}Too many arguments: expected one section, got '${section}' and '${a}'${NC}\nUsage: loki wiki show [section]\n`,
      );
      return 1;
    }
    section = a;
  }

  const dir = wikiDir();
  if (!existsSync(dir)) {
    process.stderr.write(
      `${YELLOW}No wiki found. Run 'loki wiki generate' first.${NC}\n`,
    );
    return 1;
  }

  if (section) {
    if (!SECTIONS.has(section)) {
      process.stderr.write(
        `${RED}No such section: ${section} (try: architecture, modules, data-flow)${NC}\n`,
      );
      return 1;
    }
    const f = join(dir, `${section}.md`);
    if (!existsSync(f)) {
      process.stderr.write(`${RED}Section not generated: ${section}${NC}\n`);
      return 1;
    }
    process.stdout.write(readFileSync(f, "utf8"));
    return 0;
  }

  const indexMd = join(dir, "index.md");
  if (!existsSync(indexMd)) {
    process.stderr.write(
      `${RED}Wiki index not found. Run 'loki wiki generate'.${NC}\n`,
    );
    return 1;
  }
  process.stdout.write(readFileSync(indexMd, "utf8"));
  return 0;
}

async function delegateToBash(sub: string, args: string[]): Promise<number> {
  const bashCmd = resolve(REPO_ROOT, "autonomy", "loki");
  const TIMEOUT_MS = 3600000;
  const proc = Bun.spawn({
    cmd: [bashCmd, "wiki", sub, ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, LOKI_LEGACY_BASH: "1" },
  });
  const killTimer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, TIMEOUT_MS);
  try {
    return await proc.exited;
  } finally {
    clearTimeout(killTimer);
  }
}

export async function runWiki(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    case "show":
      return runShow(rest);
    case "generate":
      return delegateToBash("generate", rest);
    case "ask":
      return delegateToBash("ask", rest);
    default:
      process.stderr.write(`${RED}Unknown wiki command: ${sub}${NC}\n`);
      process.stdout.write(HELP);
      return 1;
  }
}
