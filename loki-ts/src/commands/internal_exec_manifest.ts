import { readFileSync } from "node:fs";

import {
  planManifest,
  readManifest,
  validateResult,
  writeManifest,
  type PlanOpts,
  type StreamResult,
} from "../runner/exec_manifest.ts";

function usage(): void {
  process.stdout.write(
    "Usage: loki internal exec-manifest plan|validate <json-file> [loki-dir]\n",
  );
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Hidden bridge used by the bash parallel-worktree orchestrator. */
export function runInternalExecManifest(args: readonly string[]): number {
  const action = args[0];
  if (action === undefined || action === "help" || action === "--help" || action === "-h") {
    usage();
    return 0;
  }

  const input = args[1];
  const lokiDir = args[2];
  if (input === undefined) {
    process.stderr.write("exec-manifest: JSON input file is required\n");
    return 2;
  }

  try {
    if (action === "plan") {
      const manifest = planManifest(readJson<PlanOpts>(input));
      if (manifest === null) return 0;
      const path = writeManifest(manifest, lokiDir);
      process.stdout.write(`${path}\n`);
      return 0;
    }

    if (action === "validate") {
      const manifest = readManifest(lokiDir);
      if (manifest === null) {
        process.stderr.write("exec-manifest: no valid manifest found\n");
        return 2;
      }
      const outcome = validateResult(manifest, readJson<StreamResult>(input));
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
      return outcome.verdict === "accepted" ? 0 : 2;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`exec-manifest: ${detail}\n`);
    return 2;
  }

  process.stderr.write(`exec-manifest: unknown action "${action}"\n`);
  return 2;
}
