// Phase 1 (v7.5.0) -- the missing writer for .loki/state/relevant-learnings.json.
//
// Plan reference: /Users/lokesh/.claude/plans/polished-waddling-stardust.md
// Part B "Phase 1". The pre-v7.5.0 build_prompt.ts:175 instructs the LLM to
// "CHECK .loki/state/relevant-learnings.json for cross-project learnings"
// but no orchestrator code writes the file. Templates in
// references/core-workflow.md:123-149 describe a Mistakes & Learnings loop
// that depends on this file. This module is the writer that closes the loop.
//
// Default ON: the caller (internal_phase1.ts, the bash route's phase1 hooks) fires the file write on `LOKI_AUTO_LEARNINGS !== "0"`, so
// relevant-learnings.json is populated unless explicitly disabled with
// LOKI_AUTO_LEARNINGS=0. The env gate lives at the call sites, not here.
// The episodic-memory bridge is a SEPARATE, default-OFF enrichment: both
// production callers pass episodeBridge:null, so it only runs when a caller
// opts in (or LOKI_AUTO_LEARNINGS_EPISODE=1 with the default bridge).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { atomicWriteJson, withAppendLock, withFileLockSync } from "../util/atomic.ts";
import { storeEpisodeTrace } from "./episode_bridge.ts";
import type { Finding } from "./findings_injector.ts";

export type LearningTrigger =
  | "gate_failure"
  | "council_reject"
  | "override_approved"
  | "override_rejected"
  | "escalation_pause";

export type Learning = {
  id: string;             // sha256 of (trigger,rootCause,evidence.file) - dedupe key
  timestamp: string;      // ISO8601
  iteration: number;
  trigger: LearningTrigger;
  rootCause: string;
  fix: string;            // how the orchestrator (or human) addressed it
  preventInFuture: string;
  evidence: {
    findingId?: string;
    reviewId?: string;
    file?: string;
    line?: number;
    severity?: string;
    reviewer?: string;
  };
};

export type LearningsFile = {
  version: 1;
  learnings: Learning[];
};

const FILE_REL = join("state", "relevant-learnings.json");

function fileFor(lokiDir: string): string {
  return join(lokiDir, FILE_REL);
}

function isValidLearning(x: unknown): x is Learning {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["timestamp"] === "string" &&
    typeof o["iteration"] === "number" &&
    typeof o["trigger"] === "string" &&
    typeof o["rootCause"] === "string" &&
    typeof o["fix"] === "string" &&
    typeof o["preventInFuture"] === "string" &&
    typeof o["evidence"] === "object" &&
    o["evidence"] !== null
  );
}

function loadOrInit(path: string): LearningsFile {
  if (!existsSync(path)) return { version: 1, learnings: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed["version"] === 1 && Array.isArray(parsed["learnings"])) {
      // v7.5.1 bug-hunt fix B3: per-element validation. The pre-v7.5.1 cast
      // accepted `null` and `{}` entries which crashed `findIndex(l => l.id)`
      // downstream and rejected the lock chain (cascading B4). Filter out
      // invalid entries silently -- malformed entries are a soft signal that
      // the file was hand-edited or partially-written.
      const learnings = (parsed["learnings"] as unknown[]).filter(isValidLearning);
      return { version: 1, learnings };
    }
  } catch {
    // tolerate corrupt file -- start fresh (we keep an audit trail in
    // episodic memory so corruption here is a soft failure)
  }
  return { version: 1, learnings: [] };
}

// v7.5.3: atomicWriteJson + withAppendLock moved to ../util/atomic.ts so
// other call sites (gate-failure-count.json race fix, future Phase 2
// work) reuse the same proven primitive. v7.5.0 council R1 introduced
// in-process serialization to defeat TOCTOU; v7.5.1 fixed the GC check
// (B1) and poisoned-chain propagation (B4); v7.5.3 extracted to util.

// v7.x bug-hunt M2: fold the evidence file into the dedupe key. Pre-fix the
// id was sha256(trigger,rootCause) and rootCause is `[severity] description`,
// which omits the file -- two distinct findings sharing the same description
// text in different files (e.g. "missing null check") collapsed onto one
// learning, silently dropping one. Including the file disambiguates them. A
// file-less finding keeps prior behavior (empty trailing segment).
function learningId(
  trigger: LearningTrigger,
  rootCause: string,
  file: string | undefined,
): string {
  return createHash("sha256")
    .update(`${trigger} ${rootCause} ${file ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

export type AppendOpts = {
  // Allow callers (and tests) to skip the python episode-bridge call.
  // When undefined the bridge is invoked iff LOKI_AUTO_LEARNINGS_EPISODE=1.
  episodeBridge?: typeof storeEpisodeTrace | null;
  // v7.5.2: optional sink for episode_bridge failure messages so operators
  // see `python3 not found`, `chromadb ImportError` etc. instead of silent
  // skips. Default sink writes to process.stderr.
  bridgeFailureLog?: (msg: string) => void;
};

// Append a learning. Dedupe on (trigger, rootCause, evidence.file) -- if the
// same root cause in the same file fires twice we only update the timestamp +
// iteration counter on the existing entry, which keeps the file from growing
// unbounded across long runs (v7.x M2 folded file into the key so distinct
// findings sharing description text in different files are kept separate).
//
// v7.5.0 council R1 fix: serialized via withAppendLock so concurrent callers
// (e.g. fire-and-forget loop over multiple findings) do not lose entries to
// the read-mutate-write race.
export async function appendLearning(
  lokiDir: string,
  learning: Omit<Learning, "id" | "timestamp">,
  opts: AppendOpts = {},
): Promise<Learning> {
  const id = learningId(learning.trigger, learning.rootCause, learning.evidence.file);
  const timestamp = new Date().toISOString();
  const finalLearning: Learning = { id, timestamp, ...learning };
  const target = fileFor(lokiDir);

  // v7.x bug-hunt H1 (lost-update fix): withAppendLock only serializes
  // callers WITHIN one Bun process. relevant-learnings.json is also written
  // from a SEPARATE process per `loki internal phase1-hooks reflect`
  // invocation (the bash runner forks one per iteration) and from
  // recordOverrideOutcome. Two processes doing read-modify-write
  // concurrently silently drop entries. Wrap the full read-mutate-write in
  // withFileLockSync so concurrent processes serialize on a <target>.lock
  // sentinel -- the same cross-process primitive gate-failure-count.json
  // uses. The in-process withAppendLock is kept as the outer mutex: it
  // cheaply serializes same-process callers without each one busy-waiting on
  // the file lock, and the file lock then closes the cross-process gap. The
  // lock MUST span the READ (loadOrInit) through the WRITE (atomicWriteJson)
  // so no other process can read a stale snapshot mid-update.
  await withAppendLock(target, () => {
    withFileLockSync(target, () => {
      const file = loadOrInit(target);
      const existingIdx = file.learnings.findIndex((l) => l.id === id);
      if (existingIdx >= 0) {
        // Update timestamp + iteration; keep first-seen evidence for stability.
        const prev = file.learnings[existingIdx]!;
        file.learnings[existingIdx] = {
          ...prev,
          timestamp,
          iteration: finalLearning.iteration,
        };
      } else {
        file.learnings.push(finalLearning);
      }
      atomicWriteJson(target, file);
    });
  });

  // Best-effort: also write to episodic memory so the consolidation pass
  // can roll it into anti-patterns. Bridge swallows its own errors.
  // v7.5.2 (bug-hunt H3): the bridge returns a structured EpisodeBridgeResult
  // but the pre-v7.5.2 code discarded it -- so a python3 ImportError or
  // chromadb crash was completely invisible. Log to the optional sink so
  // operators can debug "why did my learnings not persist" without reading
  // source. Sink defaults to console.warn unless tests inject one.
  const enableEpisode =
    opts.episodeBridge !== null &&
    (opts.episodeBridge !== undefined ||
      process.env["LOKI_AUTO_LEARNINGS_EPISODE"] === "1");
  if (enableEpisode) {
    const bridge = opts.episodeBridge ?? storeEpisodeTrace;
    const sink = opts.bridgeFailureLog ?? defaultBridgeFailureLog;
    try {
      const result = await bridge(lokiDir, {
        taskId: `learning-${id}`,
        outcome: "failure",
        phase: "VERIFY",
        goal: `${learning.trigger}: ${learning.rootCause}`,
      });
      if (result && !result.stored) {
        // v7.5.3: distinguish intentional NOOP skips (memory dir not
        // initialized -- common, benign) from real failures (python3
        // missing, ImportError, write failure). Don't log the NOOPs.
        const benign = new Set(["memory dir not initialized", "stub"]);
        if (!benign.has(result.reason)) {
          sink(`episode_bridge skipped: ${result.reason}`);
        }
      }
    } catch (err) {
      sink(`episode_bridge threw: ${(err as Error).message}`);
    }
  }

  return finalLearning;
}

// Default sink: log to stderr at WARN-equivalent level so operators see
// the message without it being mistaken for normal output. Tests inject
// a buffer so they can assert without polluting stderr.
function defaultBridgeFailureLog(msg: string): void {
  process.stderr.write(`[learnings_writer] ${msg}\n`);
}

// Convenience: derive a Learning from a code-review Finding and append it.
export async function appendFromGateFailure(
  lokiDir: string,
  iteration: number,
  finding: Finding,
  opts: AppendOpts = {},
): Promise<Learning> {
  const rootCause = `[${finding.severity}] ${finding.description}`;
  return appendLearning(
    lokiDir,
    {
      iteration,
      trigger: "gate_failure",
      rootCause,
      fix: "pending: dev agent must address in next iteration or supply counter-evidence",
      preventInFuture:
        "if this finding recurs, lower its severity threshold or add a regression test",
      evidence: {
        reviewId: finding.reviewId,
        file: finding.file ?? undefined,
        line: finding.line ?? undefined,
        severity: finding.severity,
        reviewer: finding.reviewer,
      },
    },
    opts,
  );
}

// Read the current learnings file (a short summary for the next iteration).
export function loadLearnings(lokiDir: string): LearningsFile {
  return loadOrInit(fileFor(lokiDir));
}
