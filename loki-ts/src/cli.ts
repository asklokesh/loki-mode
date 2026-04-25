/**
 * Loki Mode TypeScript CLI entry point (Bun runtime).
 *
 * v0.1.0-alpha.1 -- Phase 1 of the bash->Bun migration. Implements ONE
 * command (`version`) as a proof-of-concept that the toolchain works
 * end-to-end. Does NOT replace autonomy/loki yet. See
 * docs/architecture/ADR-001-runtime-migration.md.
 *
 * Usage:
 *   bun src/cli.ts version
 */
import { getVersion } from "./version.ts";

const HELP = `Loki Mode (TypeScript prototype, v0.1.0-alpha.1)

Usage: bun src/cli.ts <command>

Commands:
  version       Print Loki Mode version (mirrors autonomy/loki cmd_version)
  help          Show this help

This is the alpha prototype scaffolded by feat/bun-migration. Production
behavior still flows through autonomy/loki (bash). See
docs/architecture/ADR-001-runtime-migration.md for the migration plan.
`;

function main(argv: readonly string[]): number {
  const cmd = argv[0] ?? "help";

  switch (cmd) {
    case "version":
      console.log(`Loki Mode v${getVersion()}`);
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(HELP);
      return 2;
  }
}

const code = main(Bun.argv.slice(2));
process.exit(code);
