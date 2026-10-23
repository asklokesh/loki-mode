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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { REPO_ROOT } from "../util/paths.ts";
import { findPython3 } from "../util/python.ts";
import { run as shellRun } from "../util/shell.ts";
import { getVersion } from "../version.ts";
import { atomicWriteText } from "../util/atomic.ts";
import { appProbe } from "../util/app_probe.ts";
import type { RunnerContext } from "./types.ts";

// Resolve the standalone generator relative to the repo root (matches
// run.sh's "$SCRIPT_DIR/lib/proof-generator.py").
function generatorPath(): string {
  return resolve(REPO_ROOT, "autonomy", "lib", "proof-generator.py");
}

// Mint a run id the same shape bash mints when no persisted trust run-id
// exists (run.sh): "proof-<utc-timestamp>-<pid>-<rand>". Kept
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
export interface ProofDeps {
  probe?: (repoDir: string, lokiDir: string, opts?: { specText?: string }) => Promise<unknown>;
  // Test seam: path to the ablation producer. Production uses ablationPath().
  ablationScript?: string;
}

// The load-bearing ablation producer (moat P8, TEN-GATES-11). Same parity rule
// as the generator: one Python implementation, resolved from REPO_ROOT.
function ablationPath(): string {
  return resolve(REPO_ROOT, "autonomy", "lib", "ablation.py");
}

const ABLATION_STATUSES = new Set(["load_bearing", "not_load_bearing", "not_applicable"]);

// The run's baseline commit: _LOKI_RUN_START_SHA (exported by run.sh at runner
// init) wins, else the .loki/state/start-sha file run.sh persists. Empty when
// neither exists, which records not_applicable rather than guessing a base.
function runStartSha(lokiDir: string): string {
  const env = (process.env["_LOKI_RUN_START_SHA"] ?? "").trim();
  if (env) return env;
  try {
    return readFileSync(join(lokiDir, "state", "start-sha"), "utf8").trim();
  } catch {
    return "";
  }
}

function writeAblationNotApplicable(lokiDir: string, reason: string): void {
  const qdir = join(lokiDir, "quality");
  mkdirSync(qdir, { recursive: true });
  const rec = { ablated_exit_code: null, ablated_files: [], command: "", reason, status: "not_applicable" };
  atomicWriteText(join(qdir, "ablation.json"), JSON.stringify(rec, null, 2) + "\n");
}

// Run ablation.py so quality/ablation.json exists before the generator copies
// it into facts.ablation (TEN-GATES-12). A stale record from an earlier run is
// removed first so it can never be copied into this run's proof. Any failure
// (no base, script missing, non-zero exit, timeout, unreadable record) is
// recorded as not_applicable with the reason and never blocks the proof.
// LOKI_PROOF_ABLATION=0 opts out and leaves no record (facts carry no key).
async function collectAblation(ctx: RunnerContext, py: string, deps: ProofDeps): Promise<void> {
  if (process.env["LOKI_PROOF_ABLATION"] === "0") return;
  const out = join(ctx.lokiDir, "quality", "ablation.json");
  let failure = "";
  try {
    rmSync(out, { force: true });
    const script = deps.ablationScript ?? ablationPath();
    const base = runStartSha(ctx.lokiDir);
    if (!base) {
      failure = "no run start sha recorded (_LOKI_RUN_START_SHA or .loki/state/start-sha), so there is no change to ablate";
    } else if (!existsSync(script)) {
      failure = `ablation producer missing: ${script}`;
    } else {
      let timeoutSec = Number.parseInt(process.env["LOKI_ABLATION_TIMEOUT"] ?? "", 10);
      if (!Number.isFinite(timeoutSec) || timeoutSec < 1) timeoutSec = 600;
      // The script bounds its own re-run; the outer limit only catches a hang
      // in git or the restore. SIGTERM lets ablation.py restore the tree.
      const r = await shellRun(
        [py, script, "--repo", ctx.cwd, "--base", base, "--loki-dir", ctx.lokiDir, "--timeout", String(timeoutSec)],
        { cwd: ctx.cwd, timeoutMs: (timeoutSec + 60) * 1000 },
      );
      if (r.exitCode !== 0) {
        const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0] ?? "";
        failure = `ablation exited ${r.exitCode}${tail ? `: ${tail}` : ""}`;
      } else {
        const rec = JSON.parse(readFileSync(out, "utf8")) as { status?: unknown };
        if (typeof rec.status !== "string" || !ABLATION_STATUSES.has(rec.status)) {
          failure = `ablation record has no valid status (${String(rec.status)})`;
        }
      }
    }
  } catch (err) {
    failure = `ablation failed: ${(err as Error).message}`;
  }
  if (!failure) return;
  try {
    writeAblationNotApplicable(ctx.lokiDir, failure);
  } catch {
    /* an absent record stays an honest "no ablation" in the proof */
  }
  try {
    ctx.log(`[runner] proof ablation not_applicable: ${failure}`);
  } catch {
    /* logging must not throw either */
  }
}

// Collect app health and functional facts before the generator reads them.
// LOKI_PROOF_APP_PROBE=0 opts out. A failure leaves the artifacts absent
// (facts stay not_run); nothing is ever fabricated here.
async function collectAppFacts(ctx: RunnerContext, deps: ProofDeps): Promise<void> {
  if (process.env["LOKI_PROOF_APP_PROBE"] === "0") return;
  try {
    let specText: string | undefined;
    if (ctx.prdPath) {
      try {
        specText = readFileSync(ctx.prdPath, "utf8");
      } catch {
        specText = undefined;
      }
    }
    const probe = deps.probe ?? appProbe;
    await probe(ctx.cwd, ctx.lokiDir, specText !== undefined ? { specText } : {});
  } catch (err) {
    try {
      ctx.log(`[runner] proof app probe skipped: ${(err as Error).message}`);
    } catch {
      /* logging must not throw either */
    }
  }
}

export async function maybeGenerateProof(ctx: RunnerContext, deps: ProofDeps = {}): Promise<boolean> {
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

    // Pass an EXPLICIT --run-id, exactly as bash does (run.sh). Without
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

    await collectAppFacts(ctx, deps);
    await collectAblation(ctx, py, deps);

    await shellRun([py, ...args], { cwd: ctx.cwd, env, timeoutMs: 30_000 });

    // Persist the resolved run id atomically, mirroring run.sh, so
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
