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
//   loki rollback deploy                  -- print the provider rollback command for the last deploy

import {
  listCheckpoints,
  readCheckpoint,
  rollbackToCheckpoint,
  executeRollbackWithSnapshot,
} from "../runner/checkpoint.ts";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOLD, CYAN, GREEN, NC, RED, YELLOW } from "../util/colors.ts";
import { lokiDir } from "../util/paths.ts";

const HELP = `Usage: loki rollback <subcommand>

Subcommands:
  list                   List checkpoints (newest first)
  show <id>              Print metadata for one checkpoint
  to <id>                Restore .loki/ state + context to that checkpoint
  latest                 Restore to the most recent checkpoint
  deploy                 Print the provider rollback command for the last deploy
                         record (read-only; never runs it)

Restored automatically (safe, non-code):
  .loki/state/orchestrator.json
  .loki/queue/{pending,completed,in-progress,current-task}.json
  .loki/CONTINUITY.md            (iteration / conversation handoff context)

Re-undoable: every rollback first captures a forced pre-rollback snapshot of
your current state, so you can always undo the undo (the snapshot id is printed).

Source code is NOT touched by this command. To also restore the working tree
to the checkpoint's snapshot (if one was anchored at checkpoint time):
  git stash apply refs/loki/cp/<id>

Re-run \`loki start\` to resume from the restored state.
`;

export async function runRollback(argv: readonly string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    return sub === undefined ? 1 : 0;
  }

  // Reject unknown flags so a mistyped safety flag never runs the real rollback.
  const allowed = sub === "to" || sub === "latest" ? ["--force"] : [];
  if (["list", "show", "to", "latest", "deploy"].includes(sub)) {
    const bad = rest.find((a) => a.startsWith("-") && !allowed.includes(a));
    if (bad !== undefined) {
      process.stderr.write(`${RED}Unknown flag for rollback ${sub}:${NC} ${bad}\n`);
      process.stderr.write(HELP);
      return 2;
    }
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
      return await executePlan(id, rest.includes("--force"));
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
      return await executePlan(latest.id, rest.includes("--force"));
    }

    case "deploy":
      return printDeployRollback();

    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

async function executePlan(id: string, force = false): Promise<number> {
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
  // R6: force a pre-rollback snapshot first, so this restore is itself undoable.
  // If that snapshot fails, executeRollbackWithSnapshot aborts (no destructive
  // restore without a safety net) unless --force is passed.
  let result;
  try {
    result = await executeRollbackWithSnapshot(plan, undefined, force);
  } catch (err) {
    process.stderr.write(`${RED}Rollback aborted:${NC} ${(err as Error).message}\n`);
    return 1;
  }
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
  if (result.preRollbackSnapshotId) {
    process.stdout.write(
      `Saved your prior state as ${CYAN}${result.preRollbackSnapshotId}${NC}; undo this rollback with \`loki rollback to ${result.preRollbackSnapshotId}\`.\n`,
    );
  }
  process.stdout.write(`Run \`loki start\` to resume from the restored state.\n`);
  return 0;
}

// Rollback verbs by deploy command, mirroring _deploy_options_for_type in autonomy/loki. Only these
// fixed strings are printed; the record's own command text and any environment are never echoed.
const DEPLOY_ROLLBACKS: ReadonlyArray<{ prefix: string; provider: string; cmd?: string; manual?: string }> = [
  { prefix: "vercel", provider: "Vercel", cmd: "vercel rollback" },
  { prefix: "fly", provider: "Fly.io", cmd: "fly releases rollback <previous-version>" },
  { prefix: "netlify", provider: "Netlify", manual: "Netlify documents no CLI rollback; restore the previous deploy from the Netlify dashboard" },
  { prefix: "wrangler", provider: "Cloudflare", manual: "roll back from the Cloudflare dashboard or with the provider CLI yourself" },
];

// loki rollback deploy: read-only. Reads the newest .loki/deploys/*.json (loki.deploy/1) and prints the
// provider rollback command for its deploy command. Exit 0 with a note when there is nothing to print.
function printDeployRollback(): number {
  const ddir = resolve(lokiDir(), "deploys");
  let files: string[] = [];
  try {
    files = readdirSync(ddir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }
  const newest = files[files.length - 1];
  if (newest === undefined) {
    process.stdout.write("No deploy to roll back: no deploy record\n");
    return 0;
  }
  let command = "";
  try {
    const rec = JSON.parse(readFileSync(resolve(ddir, newest), "utf-8")) as Record<string, unknown>;
    if (rec["schema"] !== "loki.deploy/1") throw new Error("schema");
    command = typeof rec["command"] === "string" ? rec["command"].trim() : "";
  } catch {
    process.stdout.write("No deploy to roll back: last deploy record unreadable\n");
    return 0;
  }
  const first = command.split(/\s+/)[0] ?? "";
  const hit = DEPLOY_ROLLBACKS.find((r) => r.prefix === first);
  if (hit === undefined) {
    process.stdout.write("No rollback command known for the last deploy's provider; roll back with the provider's own tooling\n");
    return 0;
  }
  if (hit.cmd !== undefined) {
    process.stdout.write(`Last deploy: ${hit.provider}. Roll back with (not run by loki): ${hit.cmd}\n`);
  } else {
    process.stdout.write(`Last deploy: ${hit.provider}. No CLI rollback: ${hit.manual}\n`);
  }
  return 0;
}
