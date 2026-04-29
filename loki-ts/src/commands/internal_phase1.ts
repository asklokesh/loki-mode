// v7.5.3: hidden internal Bun command that bash autonomy/run.sh calls
// once per iteration to drive the Phase 1 hooks (findings + learnings +
// override council + handoff doc) without paying a fork cost per gate.
//
// Why hidden: this is NOT a user-facing command. It exists so the bash
// runner can reuse the Bun side's structured-findings parser, override
// council judges, learnings writer, and handoff doc renderer instead of
// reimplementing all of them in bash. Per the "embedded by default" UX
// mandate, users never invoke this directly -- they just run `loki start`
// and the bash runner orchestrates it.
//
// Subcommands (designed for one-shot bash invocation):
//   loki internal phase1-hooks reflect <iter>
//      Read .loki/quality/reviews/<latest> -> write .loki/state/findings-<iter>.json
//      Append learnings for each blocking finding (LOKI_AUTO_LEARNINGS).
//
//   loki internal phase1-hooks override <iter>
//      Read counter-evidence-<iter>.json (if present) -> run override
//      council. Print "lifted" or "blocked" to stdout. Write transcript
//      to .loki/quality/reviews/<latest>/override-<iter>.json.
//
//   loki internal phase1-hooks handoff <gate-name> <consecutive-failures> <iter>
//      Write the structured handoff doc before bash writes .loki/PAUSE.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { lokiDir } from "../util/paths.ts";
import { atomicWriteJson } from "../util/atomic.ts";

const HELP = `loki internal phase1-hooks <subcommand>

Subcommands:
  reflect <iter>                    Persist structured findings + auto-learnings.
  override <iter>                   Run override council if counter-evidence present.
  handoff <gate> <count> <iter>     Write structured handoff doc before PAUSE.

This command is invoked by autonomy/run.sh between iterations. Users
should not run it directly -- run \`loki start\` instead.
`;

export async function runInternalPhase1Hooks(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return sub === undefined ? 1 : 0;
    case "reflect":
      return runReflect(rest);
    case "override":
      return runOverride(rest);
    case "handoff":
      return runHandoff(rest);
    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

async function runReflect(argv: readonly string[]): Promise<number> {
  const iter = parseIter(argv[0]);
  if (iter === null) {
    process.stderr.write("reflect: missing or invalid <iter>\n");
    return 2;
  }
  const base = lokiDir();
  try {
    const fInjector = await import("../runner/findings_injector.ts");
    const result = fInjector.loadPreviousFindings(base, iter);
    if (result.findings.length === 0) {
      process.stdout.write(`reflect: no findings for iter ${iter} (nothing to do)\n`);
      return 0;
    }
    const stateDir = join(base, "state");
    mkdirSync(stateDir, { recursive: true });
    atomicWriteJson(join(stateDir, `findings-${iter}.json`), {
      review_id: result.reviewId,
      iteration: iter,
      findings: result.findings,
    });

    const learn = await import("../runner/learnings_writer.ts");
    let learningsAppended = 0;
    if (process.env["LOKI_AUTO_LEARNINGS"] !== "0") {
      for (const f of result.findings) {
        if (f.severity === "Critical" || f.severity === "High") {
          await learn.appendFromGateFailure(base, iter, f, { episodeBridge: null });
          learningsAppended += 1;
        }
      }
    }
    process.stdout.write(
      `reflect: persisted ${result.findings.length} findings + ${learningsAppended} learnings (iter ${iter})\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`reflect: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runOverride(argv: readonly string[]): Promise<number> {
  const iter = parseIter(argv[0]);
  if (iter === null) {
    process.stderr.write("override: missing or invalid <iter>\n");
    return 2;
  }
  const base = lokiDir();
  try {
    const ce = await import("../runner/counter_evidence.ts");
    const evidence = ce.loadCounterEvidence(base, iter);
    if (evidence === null || evidence.evidence.length === 0) {
      process.stdout.write(`override: no counter-evidence for iter ${iter} (skip)\n`);
      return 0;
    }
    const fInjector = await import("../runner/findings_injector.ts");
    const result = fInjector.loadPreviousFindings(base, iter);
    const blockers = result.findings.filter(
      (f) => f.severity === "Critical" || f.severity === "High",
    );
    if (blockers.length === 0) {
      process.stdout.write(`override: no blocking findings for iter ${iter} (skip)\n`);
      return 0;
    }

    // Always use the stub-judge path here -- bash invokes this hook
    // synchronously between iterations, and a hung provider call would
    // wedge the autonomous loop. Real provider judges run inside the
    // Bun route's runCodeReview where the loop already tolerates async.
    const TRUSTED = new Set([
      "duplicate-code-path",
      "file-exists",
      "test-passes",
      "grep-miss",
      "out-of-scope",
    ]);
    const stubJudge = async (input: {
      finding: import("../runner/findings_injector.ts").Finding;
      evidence: import("../runner/counter_evidence.ts").CounterEvidence;
      judge: string;
    }) => {
      const trusted = TRUSTED.has(input.evidence.proofType);
      return {
        judge: input.judge,
        verdict: trusted ? ("APPROVE_OVERRIDE" as const) : ("REJECT_OVERRIDE" as const),
        reasoning: trusted
          ? `[stub] proofType=${input.evidence.proofType} trusted`
          : `[stub] proofType=${input.evidence.proofType} requires manual review`,
      };
    };

    const outcome = await ce.runOverrideCouncil(blockers, evidence, stubJudge);
    await ce.recordOverrideOutcome(base, iter, outcome, blockers);

    // Persist transcript next to the most recent review dir.
    const reviewsRoot = join(base, "quality", "reviews");
    if (existsSync(reviewsRoot)) {
      try {
        const entries = readdirSync(reviewsRoot)
          .filter((n) => n.startsWith("review-"))
          .sort();
        const latest = entries[entries.length - 1];
        if (latest && statSync(join(reviewsRoot, latest)).isDirectory()) {
          atomicWriteJson(join(reviewsRoot, latest, `override-${iter}.json`), {
            review_id: result.reviewId,
            iteration: iter,
            approved_finding_ids: Array.from(outcome.approvedFindingIds),
            rejected_finding_ids: Array.from(outcome.rejectedFindingIds),
            votes: outcome.votes,
          });
        }
      } catch {
        // best-effort
      }
    }

    const approved = outcome.approvedFindingIds.size;
    const rejected = outcome.rejectedFindingIds.size;
    const allLifted = rejected === 0 && approved > 0;
    if (allLifted) {
      process.stdout.write(`override: LIFTED -- ${approved} approved, ${rejected} rejected\n`);
    } else {
      process.stdout.write(`override: BLOCKED -- ${approved} approved, ${rejected} rejected\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`override: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runHandoff(argv: readonly string[]): Promise<number> {
  const gate = argv[0];
  const count = Number.parseInt(argv[1] ?? "0", 10);
  const iter = parseIter(argv[2]);
  if (!gate || !Number.isFinite(count) || iter === null) {
    process.stderr.write("handoff: usage: handoff <gate> <consecutive-failures> <iter>\n");
    return 2;
  }
  const base = lokiDir();
  try {
    const mod = await import("../runner/escalation_handoff.ts");
    const result = mod.writeEscalationHandoff(base, {
      gateName: gate,
      iteration: iter,
      consecutiveFailures: count,
      detail: `${gate} hit PAUSE_LIMIT (${count} consecutive failures)`,
    });
    process.stdout.write(`handoff: wrote ${result.path} (${result.bytes}B)\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`handoff: ${(err as Error).message}\n`);
    return 1;
  }
}

function parseIter(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// stable export for tests + the CLI dispatcher
export const _internalPhase1HooksHelp = HELP;
// Re-export resolve so the CLI test harness can use the same path module.
export { resolve as _resolveForTests };
