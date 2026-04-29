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
  rollback <subcmd>      Restore .loki/ state from a checkpoint
                         (subcmds: list | show <id> | to <id> | latest)

All other commands fall through to the bash CLI (autonomy/loki).
Set LOKI_LEGACY_BASH=1 to force the bash CLI for every command.
`;

// Defense-in-depth: LOKI_LEGACY_BASH is interpreted by the bin/loki shim
// (which decides between Bun and bash routes). If we are already running
// inside Bun, the env var is a no-op -- the shim is bypassed. Warn so the
// operator does not assume the legacy route is active. We do NOT change
// behavior; this is purely an observability aid. Mirrors the truthy
// convention used elsewhere ("1"/"true"/"yes"/"on", case-insensitive).
function warnIfLegacyBashSetUnderBun(): void {
  const raw = process.env["LOKI_LEGACY_BASH"];
  if (raw === undefined) return;
  const v = raw.trim().toLowerCase();
  if (v !== "1" && v !== "true" && v !== "yes" && v !== "on") return;
  // Allow tests / tooling to suppress the noise when they intentionally
  // invoke the Bun entrypoint directly.
  if (process.env["LOKI_SUPPRESS_BUN_DIRECT_WARN"] === "1") return;
  process.stderr.write(
    "warning: LOKI_LEGACY_BASH is set, but you are running the Bun runtime " +
      "directly (src/cli.ts). The env var only takes effect via the " +
      "bin/loki shim, which dispatches between Bun and bash. Behavior is " +
      "unchanged; this message is informational.\n",
  );
}

async function dispatch(argv: readonly string[]): Promise<number> {
  warnIfLegacyBashSetUnderBun();
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

    case "rollback": {
      // v7.5.2: wire the checkpoint rollback API (was dead code per H4).
      const { runRollback } = await import("./commands/rollback.ts");
      return runRollback(rest);
    }

    case "internal": {
      // v7.5.3: hidden internal subcommand surface used by autonomy/run.sh
      // to drive Phase 1 hooks (findings persistence, override council,
      // handoff doc) once per iteration. NOT user-facing -- absent from
      // top-level help text.
      //
      // v7.5.5 (#204): bare `loki internal` and `--help` now print a
      // discoverable subcommand listing instead of failing silently. The
      // surface is still flagged "internal" so users know it is a runtime
      // hook, not part of the supported public CLI.
      const subcmd = rest[0];
      const isHelp = !subcmd || subcmd === "--help" || subcmd === "-h" || subcmd === "help";
      if (isHelp) {
        // v7.5.6 (council R5 #1): list the Phase 1 env vars so operators
        // have an on-CLI discovery path to the toggles that drive the
        // RARV-C closure flow. References point at the canonical doc
        // (CHANGELOG #204 + skills/healing.md) for the longer story.
        const help = [
          "loki internal -- runtime hooks driven by autonomy/run.sh",
          "",
          "Subcommands:",
          "  phase1-hooks    Persist structured findings, run override council,",
          "                  append learnings, and write the escalation handoff",
          "                  doc once per iteration. Driven by run.sh; not",
          "                  intended for direct invocation.",
          "",
          "Phase 1 (RARV-C closure) env vars:",
          "  LOKI_INJECT_FINDINGS=1   Persist structured reviewer findings to",
          "                           .loki/state/findings-<iter>.json so the",
          "                           next iteration can address them.",
          "  LOKI_OVERRIDE_COUNCIL=1  Allow a 3-LLM override panel to lift a",
          "                           BLOCK when counter-evidence is presented.",
          "                           See LOKI_OVERRIDE_JUDGES (csv),",
          "                           LOKI_OVERRIDE_PANEL_SIZE,",
          "                           LOKI_OVERRIDE_REAL_JUDGE.",
          "  LOKI_AUTO_LEARNINGS=1    Append failure rootcauses to",
          "                           .loki/state/relevant-learnings.json via",
          "                           the episodic memory bridge.",
          "  LOKI_HANDOFF_MD=1        Write a structured human handoff doc to",
          "                           .loki/escalations/<ts>.md before PAUSE.",
          "",
          "All four are default-on as of v7.5.3. Set to 0 to disable.",
          "Reference: CHANGELOG.md (search 'Phase 1') and skills/healing.md.",
          "",
          "These commands are wired into the autonomous loop and may change",
          "without notice. Do not script against them.",
          "",
        ].join("\n");
        process.stdout.write(`${help}\n`);
        return 0;
      }
      if (subcmd === "phase1-hooks") {
        const { runInternalPhase1Hooks } = await import("./commands/internal_phase1.ts");
        return runInternalPhase1Hooks(rest.slice(1));
      }
      process.stderr.write(`Unknown internal subcommand: ${subcmd}\n`);
      process.stderr.write(`Run 'loki internal --help' for the supported list.\n`);
      return 2;
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
