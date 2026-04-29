// Phase 1 (v7.5.0) -- structured human-handoff document.
//
// Plan reference: /Users/lokesh/.claude/plans/polished-waddling-stardust.md
// Part B "Phase 1". The pre-v7.5.0 PAUSE_LIMIT path at quality_gates.ts:902-908
// just writes an empty `.loki/PAUSE` file and lets the operator dig through
// the review directories. This module produces a single markdown handoff with
// the failing finding, all attempted fixes, counter-evidence rejected, and a
// "what the human must decide" block -- so the operator can resume in seconds
// instead of minutes.
//
// Wires into quality_gates.applyEscalation (lines 895-923) BEFORE the existing
// writePauseSignal call. The PAUSE signal itself is NOT removed -- existing
// tooling (dashboard, autonomous.ts loop) keeps reading it. This module only
// adds the human-readable doc on top.
//
// Default off: only fires when LOKI_HANDOFF_MD=1.
//
// Scope note: this is the Bun route only. The bash sites that also write
// PAUSE (autonomy/run.sh:7953,11018,11280,11590; autonomy/loki:1901) are
// intentionally NOT touched -- they remain on the legacy bare-PAUSE path
// under LOKI_LEGACY_BASH=1. That is a Phase 6-of-Part-A concern.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding } from "./findings_injector.ts";
import { loadPreviousFindings } from "./findings_injector.ts";
import type { Learning } from "./learnings_writer.ts";
import { loadLearnings } from "./learnings_writer.ts";

export type HandoffInput = {
  gateName: string;
  iteration: number;
  consecutiveFailures: number;
  // The reason the gate failed this iteration (typically the GateResult.detail).
  detail: string;
};

export type HandoffResult = {
  path: string;
  bytes: number;
};

function isoNow(): string {
  return new Date().toISOString();
}

function fmtFinding(f: Finding): string {
  const loc = f.file ? ` (${f.file}${f.line !== null ? ":" + f.line : ""})` : "";
  return `  - [${f.severity}] ${f.description}${loc} -- ${f.reviewer}`;
}

function fmtLearning(l: Learning): string {
  const ev = l.evidence;
  const where = ev.file ? ` ${ev.file}${ev.line !== undefined ? ":" + ev.line : ""}` : "";
  return `  - **${l.trigger}** (iter ${l.iteration})${where}: ${l.rootCause}`;
}

// Produce the markdown body. Pure function for ease of testing.
export function renderHandoff(
  input: HandoffInput,
  findings: readonly Finding[],
  learnings: readonly Learning[],
): string {
  const lines: string[] = [];
  lines.push(`# Loki escalation handoff -- ${isoNow()}`);
  lines.push("");
  lines.push(`Gate **${input.gateName}** has failed ${input.consecutiveFailures} consecutive times at iteration ${input.iteration}.`);
  lines.push("");
  lines.push(`Reason: ${input.detail}`);
  lines.push("");

  if (findings.length > 0) {
    lines.push(`## Outstanding findings (${findings.length})`);
    lines.push("");
    for (const f of findings) lines.push(fmtFinding(f));
    lines.push("");
  } else {
    lines.push("## Outstanding findings");
    lines.push("");
    lines.push("(no per-finding records captured -- gate failed without populating reviewer outputs)");
    lines.push("");
  }

  if (learnings.length > 0) {
    lines.push(`## Recent learnings (${Math.min(learnings.length, 10)})`);
    lines.push("");
    for (const l of learnings.slice(-10)) lines.push(fmtLearning(l));
    lines.push("");
  }

  lines.push("## What the human must decide");
  lines.push("");
  lines.push("- Approve override? Write `.loki/state/counter-evidence-<iter>.json` with one entry per finding to dispute, then `rm .loki/PAUSE` to resume.");
  lines.push("- Disable a gate? Set `LOKI_GATE_<NAME>=false` in env (see skills/quality-gates.md).");
  lines.push("- Tweak escalation? Set `LOKI_GATE_PAUSE_LIMIT` or `LOKI_GATE_ESCALATE_LIMIT`.");
  lines.push("- Roll back? Switch to `LOKI_LEGACY_BASH=1` and re-run; the bash route does not consult this handoff doc.");
  lines.push("");
  lines.push("To resume: address the findings (or supply counter-evidence) and `rm .loki/PAUSE`.");

  return lines.join("\n");
}

export type WriteHandoffOpts = {
  // Allow tests to inject pre-loaded findings + learnings (no disk reads).
  findings?: readonly Finding[];
  learnings?: readonly Learning[];
  now?: () => Date;
};

// Produce + write the handoff doc. Returns the path so callers can log it.
// File name: .loki/escalations/handoff-<iso>-<gate>.md.
export function writeEscalationHandoff(
  lokiDir: string,
  input: HandoffInput,
  opts: WriteHandoffOpts = {},
): HandoffResult {
  const findings =
    opts.findings ??
    loadPreviousFindings(lokiDir, input.iteration).findings;
  const learnings =
    opts.learnings ??
    loadLearnings(lokiDir).learnings;

  const body = renderHandoff(input, findings, learnings);

  const ts = (opts.now?.() ?? new Date())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*/, "Z");
  const dir = join(lokiDir, "escalations");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `handoff-${ts}-${input.gateName}.md`);
  writeFileSync(path, body);
  return { path, bytes: body.length };
}

// Read the most recent handoff doc back -- used by the dashboard / status
// command to surface the "what the human must decide" block to the operator.
// Returns the latest by lexicographic name (timestamps embedded in filenames).
export function readLatestHandoff(lokiDir: string): { path: string; body: string } | null {
  const dir = join(lokiDir, "escalations");
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  entries.sort();
  const last = entries[entries.length - 1];
  if (!last) return null;
  const path = join(dir, last);
  try {
    return { path, body: readFileSync(path, "utf-8") };
  } catch {
    return null;
  }
}
