// Phase 1 (v7.5.0) -- counter-evidence override council.
//
// Plan reference: /Users/lokesh/.claude/plans/polished-waddling-stardust.md
// Part B "Phase 1". When a reviewer flags a finding the dev agent has factual
// evidence against (e.g. the reviewer read dead-duplicate code), the dev
// agent emits .loki/state/counter-evidence-<iter>.json. A 3-judge override
// council votes; 2-of-3 approval lifts the BLOCK and writes the override
// reasoning into episodic memory.
//
// Closest existing precedent: `councilEvaluate` in council.ts:373 (3-voter
// pattern). The override-on-REJECT direction is new architecture.
//
// Default off: only fires when LOKI_OVERRIDE_COUNCIL=1.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding } from "./findings_injector.ts";
import { appendLearning } from "./learnings_writer.ts";

export type OverrideProofType =
  | "file-exists"
  | "test-passes"
  | "grep-miss"
  | "reviewer-misread"
  | "duplicate-code-path"
  | "out-of-scope";

export type CounterEvidence = {
  // Stable identifier the dev agent assigns. Maps 1-1 to a Finding's
  // reviewer + raw line, or to a free-form claim if the dev disagrees with
  // an entire reviewer.
  findingId: string;
  claim: string;             // dev agent's pushback in plain English
  proofType: OverrideProofType;
  // Free-form artifacts (file paths, test command output, grep output) that
  // back the claim. The override council reads these to vote.
  artifacts: string[];
};

export type CounterEvidenceFile = {
  iteration: number;
  evidence: CounterEvidence[];
};

export type OverrideVote = {
  judge: string;
  verdict: "APPROVE_OVERRIDE" | "REJECT_OVERRIDE";
  reasoning: string;
};

export type OverrideOutcome = {
  // Findings that the override council approved -- caller should NOT block
  // on these in the current iteration.
  approvedFindingIds: Set<string>;
  // Findings that were not overridden (no evidence supplied OR override
  // rejected) -- caller still blocks on these.
  rejectedFindingIds: Set<string>;
  // Per-finding judge transcripts -- written to .loki/state/overrides-<iter>.json
  // for audit.
  votes: Record<string, OverrideVote[]>;
};

// Judge function -- the override council fans out to 3 of these. Production
// wires this to the existing 5-provider abstraction (claude/codex/gemini/
// cline/aider). Tests inject deterministic stubs.
export type OverrideJudgeFn = (input: {
  finding: Finding;
  evidence: CounterEvidence;
  judge: string;
}) => Promise<OverrideVote>;

// v7.5.1 bug-hunt fix B2: validate proofType against the documented union.
// Pre-v7.5.1 the cast accepted any string, which then flowed into judges,
// learnings, and audit transcripts. Untrusted strings are now silently
// dropped at the boundary -- the override council cannot be fooled by a
// hand-edited counter-evidence file with a made-up proofType.
const VALID_PROOF_TYPES = new Set<OverrideProofType>([
  "file-exists",
  "test-passes",
  "grep-miss",
  "reviewer-misread",
  "duplicate-code-path",
  "out-of-scope",
]);

export function loadCounterEvidence(lokiDir: string, iter: number): CounterEvidenceFile | null {
  const path = join(lokiDir, "state", `counter-evidence-${iter}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed["iteration"] !== "number") return null;
    const evidence = Array.isArray(parsed["evidence"]) ? parsed["evidence"] : [];
    // Lightweight validation only -- judges still see raw evidence.
    const cleaned: CounterEvidence[] = [];
    for (const entry of evidence) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e["findingId"] !== "string") continue;
      if (typeof e["claim"] !== "string") continue;
      if (typeof e["proofType"] !== "string") continue;
      // v7.5.1 B2: enum validation. Drop entries with unknown proofType.
      const proofType = e["proofType"] as OverrideProofType;
      if (!VALID_PROOF_TYPES.has(proofType)) continue;
      const artifacts = Array.isArray(e["artifacts"]) ? e["artifacts"] : [];
      cleaned.push({
        findingId: e["findingId"],
        claim: e["claim"],
        proofType,
        artifacts: artifacts.filter((a): a is string => typeof a === "string"),
      });
    }
    return { iteration: parsed["iteration"] as number, evidence: cleaned };
  } catch {
    return null;
  }
}

// 3 default judge names. Production maps each to a different provider so
// the panel cannot collude on a single model's idiosyncrasy. Test injection
// can use any names.
export const DEFAULT_OVERRIDE_JUDGES: readonly string[] = [
  "judge-primary",
  "judge-secondary",
  "judge-tertiary",
];

// Run the override council. Returns the partition of findings into approved
// vs rejected based on a 2-of-3 vote per finding.
export async function runOverrideCouncil(
  findings: readonly Finding[],
  evidenceFile: CounterEvidenceFile,
  judge: OverrideJudgeFn,
  opts: { judges?: readonly string[] } = {},
): Promise<OverrideOutcome> {
  const judges = opts.judges ?? DEFAULT_OVERRIDE_JUDGES;
  const approved = new Set<string>();
  const rejected = new Set<string>();
  const votes: Record<string, OverrideVote[]> = {};

  // Build a lookup so we can match counter-evidence to findings by id.
  // findingId convention: dev agents synthesize stable IDs from
  // (reviewer + first 80 chars of finding.raw) -- documented in the plan.
  const evidenceById = new Map<string, CounterEvidence>();
  for (const e of evidenceFile.evidence) {
    evidenceById.set(e.findingId, e);
  }

  for (const f of findings) {
    const fid = canonicalFindingId(f);
    const ev = evidenceById.get(fid);
    if (!ev) {
      // No counter-evidence supplied -- finding stays rejected (BLOCK stays).
      rejected.add(fid);
      continue;
    }

    // Fan out 3 judges in parallel. Each judge sees only the finding +
    // evidence it must rule on -- mirrors blind-review pattern.
    const results = await Promise.all(
      judges.map((j) => judge({ finding: f, evidence: ev, judge: j })),
    );
    votes[fid] = results;

    const approveCount = results.filter((r) => r.verdict === "APPROVE_OVERRIDE").length;
    if (approveCount >= 2) approved.add(fid);
    else rejected.add(fid);
  }

  return { approvedFindingIds: approved, rejectedFindingIds: rejected, votes };
}

// Canonical finding ID convention. Stable across iterations as long as the
// reviewer text does not change. Documented for dev agents emitting
// counter-evidence files.
export function canonicalFindingId(f: Finding): string {
  const head = f.raw.slice(0, 80).replace(/\s+/g, " ").trim();
  return `${f.reviewer}::${head}`;
}

// Persist the override outcome and append a learning per approved override.
// Caller passes the current iteration so the learning is correctly scoped.
//
// v7.5.0 council R1 fix: episodeBridge defaults to null (hermetic) so
// production callers can opt in via the LOKI_AUTO_LEARNINGS_EPISODE env at
// the appendLearning level rather than getting an unexpected python3 spawn
// per override. Callers that want episodic memory writes pass {episodeBridge:
// undefined} to fall through to appendLearning's env-gated default.
export type RecordOverrideOpts = {
  episodeBridge?: import("./learnings_writer.ts").AppendOpts["episodeBridge"];
};

export async function recordOverrideOutcome(
  lokiDir: string,
  iteration: number,
  outcome: OverrideOutcome,
  findings: readonly Finding[],
  opts: RecordOverrideOpts = {},
): Promise<void> {
  // Default to null (skip bridge) for hermeticity. Callers that explicitly
  // pass `{episodeBridge: undefined}` get the env-gated default behavior.
  const bridgeOpt: import("./learnings_writer.ts").AppendOpts = {
    episodeBridge: opts.episodeBridge === undefined ? null : opts.episodeBridge,
  };
  for (const f of findings) {
    const fid = canonicalFindingId(f);
    if (outcome.approvedFindingIds.has(fid)) {
      await appendLearning(
        lokiDir,
        {
          iteration,
          trigger: "override_approved",
          rootCause: `[${f.severity}] ${f.description}`,
          fix: "override council approved counter-evidence; finding lifted",
          preventInFuture:
            "if this reviewer/file pair recurs, narrow the reviewer's selector OR add a baseline doc",
          evidence: {
            findingId: fid,
            reviewId: f.reviewId,
            file: f.file ?? undefined,
            line: f.line ?? undefined,
            severity: f.severity,
            reviewer: f.reviewer,
          },
        },
        bridgeOpt,
      );
    } else if (outcome.rejectedFindingIds.has(fid)) {
      await appendLearning(
        lokiDir,
        {
          iteration,
          trigger: "override_rejected",
          rootCause: `[${f.severity}] ${f.description}`,
          fix: "override council rejected -- dev agent must fix the finding",
          preventInFuture: "address this finding in the next iteration",
          evidence: {
            findingId: fid,
            reviewId: f.reviewId,
            file: f.file ?? undefined,
            line: f.line ?? undefined,
            severity: f.severity,
            reviewer: f.reviewer,
          },
        },
        bridgeOpt,
      );
    }
  }
}
