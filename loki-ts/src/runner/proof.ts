// Proof-of-run generation hook for the Bun runner (R1).
//
// Parity rule (R1-proof-of-run-PLAN.md HARD DECISION 1): there is exactly ONE
// generator implementation -- the standalone Python script at
// autonomy/lib/proof-generator.py. Both routes call it:
//   - bash: autonomy/run.sh generate_proof_of_run()
//   - Bun:  this module, spawned post-completion.
//
// This keeps the schema, redaction chokepoint, and HTML rendering in a single
// codepath so the two routes can never drift.
//
// The call is fire-and-forget: guarded by LOKI_PROOF (default-on; LOKI_PROOF=0
// opts out), it is awaited so the python finishes before the process exits but
// can never throw to the caller. Emits on both success and failure runs.

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { REPO_ROOT } from "../util/paths.ts";
import { findPython3 } from "../util/python.ts";
import { run as shellRun } from "../util/shell.ts";
import { getVersion } from "../version.ts";
import type { RunnerContext } from "./types.ts";

// Resolve the standalone generator relative to the repo root (matches
// run.sh's "$SCRIPT_DIR/lib/proof-generator.py").
function generatorPath(): string {
  return resolve(REPO_ROOT, "autonomy", "lib", "proof-generator.py");
}

// maybeGenerateProof: thin wrapper around the Python generator. Never throws.
// Returns true if the generator was invoked, false if skipped.
export async function maybeGenerateProof(ctx: RunnerContext): Promise<boolean> {
  try {
    if (process.env["LOKI_PROOF"] === "0") {
      return false;
    }

    const gen = generatorPath();
    if (!existsSync(gen)) {
      return false;
    }
    if (!existsSync(ctx.lokiDir)) {
      return false;
    }

    const py = await findPython3();
    if (!py) {
      return false;
    }

    let version = "unknown";
    try {
      version = getVersion();
    } catch {
      /* keep "unknown" */
    }

    const args = [
      gen,
      "--loki-dir",
      ctx.lokiDir,
      "--loki-version",
      version,
      "--provider",
      ctx.provider,
      "--quiet",
    ];

    // The generator threads ITERATION_COUNT / PRD_PATH / PROVIDER_NAME via env
    // (same contract as the bash wrapper). Awaited so it completes before the
    // process exits; shellRun never throws (it returns an exit code).
    const env: Record<string, string> = {
      ITERATION_COUNT: String(ctx.iterationCount),
      PROVIDER_NAME: ctx.provider,
    };
    if (ctx.prdPath) {
      env["PRD_PATH"] = ctx.prdPath;
    }

    await shellRun([py, ...args], { cwd: ctx.cwd, env, timeoutMs: 30_000 });
    return true;
  } catch (err) {
    // Fire-and-forget: log once, never propagate.
    try {
      ctx.log(`[runner] proof-of-run generation skipped: ${(err as Error).message}`);
    } catch {
      /* logging must not throw either */
    }
    return false;
  }
}
