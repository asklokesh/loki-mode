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

import { resolve, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { REPO_ROOT } from "../util/paths.ts";
import { findPython3 } from "../util/python.ts";
import { run as shellRun } from "../util/shell.ts";
import { getVersion } from "../version.ts";
import { atomicWriteText } from "../util/atomic.ts";
import type { RunnerContext } from "./types.ts";

// Resolve the standalone generator relative to the repo root (matches
// run.sh's "$SCRIPT_DIR/lib/proof-generator.py").
function generatorPath(): string {
  return resolve(REPO_ROOT, "autonomy", "lib", "proof-generator.py");
}

// Mint a run id the same shape bash mints when no persisted trust run-id
// exists (run.sh:6988): "proof-<utc-timestamp>-<pid>-<rand>". Kept
// deliberately similar so a human reading .loki/proofs/ cannot tell which
// route produced an entry.
function mintRunId(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  const rand = Math.floor(Math.random() * 32768);
  return `proof-${ts}-${process.pid}-${rand}`;
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

    // Pass an EXPLICIT --run-id, exactly as bash does (run.sh:6998). Without
    // it the generator mints its own id internally and nothing upstream ever
    // learns which run was written, so the proof lands on disk but is
    // unreachable: no last-proof-id.txt, so the PR receipt sites and any
    // downstream reader cannot find it. That was the real Bun-route gap -- the
    // TS runner DID generate proofs (autonomous.ts:455), it just never
    // recorded which one.
    const runId = mintRunId();

    const args = [
      gen,
      "--loki-dir",
      ctx.lokiDir,
      "--loki-version",
      version,
      "--provider",
      ctx.provider,
      "--run-id",
      runId,
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

    // Persist the resolved run id atomically, mirroring run.sh:7000-7007, so
    // downstream readers get the exact run the generator wrote rather than an
    // mtime guess.
    //
    // GATED ON THE PROOF ACTUALLY EXISTING. A generator that timed out, could
    // not write, or exited non-zero must leave NO pointer behind: a
    // last-proof-id.txt naming a proof that is not on disk is worse than an
    // absent one, because a reader cannot distinguish "no build completed"
    // from "a build completed and its evidence is missing". Fail closed --
    // absent pointer means no data, never a silently-empty completion.
    const proofPath = join(ctx.lokiDir, "proofs", runId, "proof.json");
    if (existsSync(proofPath)) {
      try {
        const stateDir = join(ctx.lokiDir, "state");
        mkdirSync(stateDir, { recursive: true });
        atomicWriteText(join(stateDir, "last-proof-id.txt"), runId);
      } catch {
        /* best effort: a missing pointer degrades to "no data", never to a lie */
      }
    }
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
