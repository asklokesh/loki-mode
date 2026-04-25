/**
 * Loki Mode TypeScript CLI dispatcher (Bun runtime).
 *
 * Phase 2 of the bash->Bun migration. Routes the 8 highest-traffic
 * read-only commands (version, status, provider show/list, stats,
 * memory list/index, doctor) to TypeScript ports; everything else
 * falls through to autonomy/loki (bash) via the bin/loki shim.
 *
 * See docs/architecture/ADR-001-runtime-migration.md and
 * /Users/lokesh/.claude/plans/polished-waddling-stardust.md.
 */
import { runVersion } from "./commands/version.ts";
import { runProvider } from "./commands/provider.ts";
import { runMemory } from "./commands/memory.ts";

const HELP = `Loki Mode (TypeScript port, Phase 2 of bash->Bun migration)

Usage: loki <command> [args...]

Phase 2 ported (Bun-native, fast):
  version                Print Loki Mode version
  status [--json]        Show current orchestrator status
  stats [--json] [--efficiency]   Session statistics
  provider show [name]   Show current provider
  provider list          List available providers and install status
  memory list            Cross-project learnings counts
  memory index [rebuild] Show or rebuild memory index
  doctor [--json]        System prerequisites health check

All other commands fall through to the bash CLI (autonomy/loki).
Set LOKI_LEGACY_BASH=1 to force the bash CLI for every command.
`;

async function dispatch(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;

    case "version":
    case "--version":
    case "-v":
      return runVersion();

    case "provider":
      return runProvider(rest);

    case "memory":
      return runMemory(rest);

    case "status": {
      const { runStatus } = await import("./commands/status.ts");
      return runStatus(rest);
    }

    case "stats": {
      const { runStats } = await import("./commands/stats.ts");
      return runStats(rest);
    }

    case "doctor": {
      const { runDoctor } = await import("./commands/doctor.ts");
      return runDoctor(rest);
    }

    default:
      // Unknown to Bun -- shim falls through to bash. If invoked directly
      // via `bun src/cli.ts <unknown>`, print help and exit 2.
      process.stderr.write(`Unknown command: ${cmd}\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

// SIGINT handler -- propagate Ctrl-C to a clean exit so child processes
// spawned via Bun.spawn (e.g. doctor's network probes) don't outlive us.
// Standard convention: 128 + signal number.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const code = await dispatch(Bun.argv.slice(2));
process.exit(code);
