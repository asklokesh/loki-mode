// v7.5.2: `loki rollback` CLI command.
//
// Wires the checkpoint rollback API at loki-ts/src/runner/checkpoint.ts which
// shipped in Phase 4 of Part A but had no user-visible entry point. Pre-v7.5.2
// the entire rollback surface (readCheckpoint, listCheckpoints,
// rollbackToCheckpoint, executeRollback) was tested but unreachable from a
// real `loki <command>` invocation -- bug-hunt H4 (dead code) finding F4.
//
// Subcommands:
//   loki rollback list                    -- list checkpoints
//   loki rollback show <id>               -- print metadata for one checkpoint
//   loki rollback to <id>                 -- restore to that checkpoint
//   loki rollback latest                  -- restore to the most recent checkpoint

import {
  listCheckpoints,
  readCheckpoint,
  rollbackToCheckpoint,
  executeRollback,
} from "../runner/checkpoint.ts";
import { BOLD, CYAN, GREEN, NC, RED, YELLOW } from "../util/colors.ts";

const HELP = `Usage: loki rollback <subcommand>

Subcommands:
  list                   List checkpoints (newest first)
  show <id>              Print metadata for one checkpoint
  to <id>                Restore .loki/ state files to that checkpoint
  latest                 Restore to the most recent checkpoint

Restored files (matches autonomy/run.sh:7028 byte-for-byte):
  .loki/state/orchestrator.json
  .loki/queue/{pending,completed,in-progress,current-task}.json

Note: only state files are restored. Source code, git history, and the
session's autonomy-state.json are unchanged. Re-run \`loki start\` to
resume from the restored state.
`;

export async function runRollback(argv: readonly string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    return sub === undefined ? 1 : 0;
  }

  switch (sub) {
    case "list": {
      // listCheckpoints returns oldest-first; reverse so users see newest at
      // the top (matches the "latest" subcommand semantics below).
      const items = [...listCheckpoints()].reverse();
      if (items.length === 0) {
        process.stdout.write(`${YELLOW}No checkpoints found.${NC}\n`);
        return 0;
      }
      process.stdout.write(`${BOLD}Checkpoints${NC} (${items.length}, newest first):\n`);
      for (const m of items) {
        process.stdout.write(
          `  ${CYAN}${m.id}${NC}  iter=${m.iteration}  ${m.git_branch || "(no branch)"}@${(m.git_sha || "").slice(0, 7)}  ${m.timestamp}\n`,
        );
      }
      return 0;
    }

    case "show": {
      const id = rest[0];
      if (!id) {
        process.stderr.write(`${RED}Missing checkpoint id.${NC} Use \`loki rollback list\`.\n`);
        return 2;
      }
      try {
        const m = readCheckpoint(id);
        process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
        return 0;
      } catch (err) {
        process.stderr.write(`${RED}Failed to read checkpoint:${NC} ${(err as Error).message}\n`);
        return 1;
      }
    }

    case "to": {
      const id = rest[0];
      if (!id) {
        process.stderr.write(`${RED}Missing checkpoint id.${NC} Use \`loki rollback list\`.\n`);
        return 2;
      }
      return executePlan(id);
    }

    case "latest": {
      // listCheckpoints returns oldest-first, so the latest is the last entry.
      const items = listCheckpoints();
      const latest = items[items.length - 1];
      if (!latest) {
        process.stderr.write(`${RED}No checkpoints found to roll back to.${NC}\n`);
        return 1;
      }
      process.stdout.write(`Rolling back to latest checkpoint: ${CYAN}${latest.id}${NC}\n`);
      return executePlan(latest.id);
    }

    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

function executePlan(id: string): number {
  let plan;
  try {
    plan = rollbackToCheckpoint(id);
  } catch (err) {
    process.stderr.write(`${RED}Cannot plan rollback:${NC} ${(err as Error).message}\n`);
    return 1;
  }
  if (plan.restore.length === 0) {
    process.stdout.write(
      `${YELLOW}Checkpoint ${id} has no restorable state files; nothing to do.${NC}\n`,
    );
    return 0;
  }
  const result = executeRollback(plan);
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      process.stderr.write(`${RED}restore error:${NC} ${e}\n`);
    }
    process.stderr.write(
      `${RED}Partial rollback: ${result.restored}/${plan.restore.length} files restored.${NC}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${GREEN}Rolled back ${result.restored}/${plan.restore.length} state files from ${id}.${NC}\n`,
  );
  process.stdout.write(`Run \`loki start\` to resume from the restored state.\n`);
  return 0;
}
