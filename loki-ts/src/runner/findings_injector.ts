// Phase 1 (v7.5.0) -- structured findings extraction from prior code reviews.
//
// Plan reference: /Users/lokesh/.claude/plans/polished-waddling-stardust.md
// Part B "Phase 1 -- Close the 'fix issues completely' gaps".
//
// The pre-v7.5.0 prompt-build path only saw a comma-separated failure token
// (e.g. "code_review,test_coverage,") because build_prompt_helpers.ts
// loadGateFailures reads only .loki/quality/gate-failures.txt. The structured
// data the reviewers actually produced -- per-finding severity / file / line
// / quote -- lives in:
//
//   .loki/quality/reviews/<id>/aggregate.json   (summary only; pass/fail counts)
//   .loki/quality/reviews/<id>/<reviewer>.txt   (the actual prose with [Severity] markers)
//
// This module reads both, parses the per-reviewer text with the same regex
// quality_gates.ts:548 uses to detect blocking severity, and returns
// structured Finding records for build_prompt.ts to inject.
//
// Default off: build_prompt.ts only calls into this module when
// LOKI_INJECT_FINDINGS=1.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Severity = "Critical" | "High" | "Medium" | "Low";

export type Finding = {
  reviewId: string;
  iteration: number;
  reviewer: string;
  severity: Severity;
  // The full bullet body, e.g. "user input is not sanitized at src/api/login.ts:42"
  description: string;
  // Best-effort file extraction from `(file:line)` or trailing `file:line` text.
  file: string | null;
  line: number | null;
  // Raw line as it appeared in the reviewer output (debug + audit trail).
  raw: string;
};

const SEVERITY_RE = /\[(Critical|High|Medium|Low)\]\s*(.+)/i;
const FILE_LINE_RE = /([\w.\-/]+\.[a-zA-Z]+):(\d+)/;

function normalizeSeverity(raw: string): Severity {
  const lower = raw.toLowerCase();
  if (lower === "critical") return "Critical";
  if (lower === "high") return "High";
  if (lower === "medium") return "Medium";
  return "Low";
}

function parseReviewerOutput(
  text: string,
  reviewer: string,
  reviewId: string,
  iteration: number,
): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Strip leading "- " or "* " bullet markers; reviewer prompts ask for them
    // (quality_gates.ts:556-561 buildReviewerPrompt) but tolerate variation.
    const stripped = trimmed.replace(/^[-*]\s*/, "");
    const m = SEVERITY_RE.exec(stripped);
    if (!m) continue;
    const sev = normalizeSeverity(m[1]!);
    const description = m[2]!.trim();
    const fileLine = FILE_LINE_RE.exec(description);
    const file = fileLine ? fileLine[1]! : null;
    const lineNo = fileLine ? Number.parseInt(fileLine[2]!, 10) : null;
    out.push({
      reviewId,
      iteration,
      reviewer,
      severity: sev,
      description,
      file,
      line: Number.isFinite(lineNo) ? lineNo : null,
      raw: trimmed,
    });
  }
  return out;
}

// Locate the most recent review directory under <lokiDir>/quality/reviews/.
// Reviews are named "review-<ts>-<iteration>" by quality_gates.ts:614-616, so
// lexicographic sort picks the latest by timestamp. We honor an explicit iter
// filter so the integration test can replay a known run.
export function findLatestReviewDir(lokiDir: string, iter?: number): string | null {
  const root = join(lokiDir, "quality", "reviews");
  if (!existsSync(root)) return null;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  const filtered = iter === undefined
    ? names.filter((n) => n.startsWith("review-"))
    : names.filter((n) => n.endsWith(`-${iter}`) && n.startsWith("review-"));
  if (filtered.length === 0) return null;
  filtered.sort();
  const last = filtered[filtered.length - 1];
  if (!last) return null;
  const full = join(root, last);
  try {
    if (!statSync(full).isDirectory()) return null;
  } catch {
    return null;
  }
  return full;
}

export type LoadFindingsResult = {
  reviewDir: string | null;
  reviewId: string | null;
  iteration: number | null;
  findings: Finding[];
};

// Read the most recent review directory and return all findings parsed from
// per-reviewer *.txt files. aggregate.json is consulted only for the
// review_id/iteration metadata; it does NOT contain per-finding records.
export function loadPreviousFindings(lokiDir: string, iter?: number): LoadFindingsResult {
  const reviewDir = findLatestReviewDir(lokiDir, iter);
  if (reviewDir === null) {
    return { reviewDir: null, reviewId: null, iteration: null, findings: [] };
  }

  let reviewId: string | null = null;
  let iteration: number | null = null;
  const aggPath = join(reviewDir, "aggregate.json");
  if (existsSync(aggPath)) {
    try {
      const raw = readFileSync(aggPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed["review_id"] === "string") reviewId = parsed["review_id"];
      if (typeof parsed["iteration"] === "number") iteration = parsed["iteration"];
    } catch {
      // Malformed aggregate.json should never happen on a clean run, but
      // we tolerate it: the per-reviewer *.txt files are the source of truth.
    }
  }

  let entries: string[];
  try {
    entries = readdirSync(reviewDir);
  } catch {
    return { reviewDir, reviewId, iteration, findings: [] };
  }

  // Skip the well-known non-reviewer artifacts. Anything else ending in .txt
  // is treated as reviewer prose. selection.json + aggregate.json + diff.txt +
  // files.txt + anti-sycophancy.txt + <reviewer>-prompt.txt are skipped.
  const SKIP = new Set([
    "diff.txt",
    "files.txt",
    "anti-sycophancy.txt",
  ]);

  const findings: Finding[] = [];
  for (const name of entries) {
    if (!name.endsWith(".txt")) continue;
    if (SKIP.has(name)) continue;
    if (name.endsWith("-prompt.txt")) continue;
    const reviewer = name.replace(/\.txt$/, "");
    let body: string;
    try {
      body = readFileSync(join(reviewDir, name), "utf-8");
    } catch {
      continue;
    }
    findings.push(
      ...parseReviewerOutput(body, reviewer, reviewId ?? "", iteration ?? -1),
    );
  }

  return { reviewDir, reviewId, iteration, findings };
}

// Render findings as a prompt-ready block. Used by build_prompt.ts when
// LOKI_INJECT_FINDINGS=1. Format chosen to be greppable and short so it
// does not blow up the token budget.
export function renderFindingsForPrompt(findings: readonly Finding[]): string {
  if (findings.length === 0) return "";
  const order: Severity[] = ["Critical", "High", "Medium", "Low"];
  const groups = new Map<Severity, Finding[]>();
  for (const sev of order) groups.set(sev, []);
  for (const f of findings) {
    const arr = groups.get(f.severity);
    if (arr) arr.push(f);
  }
  const lines: string[] = [];
  lines.push("PREVIOUS REVIEWER FINDINGS (must address each, or supply counter-evidence in .loki/state/counter-evidence-<iter>.json):");
  for (const sev of order) {
    const arr = groups.get(sev) ?? [];
    if (arr.length === 0) continue;
    lines.push(`  [${sev}] (${arr.length}):`);
    for (const f of arr) {
      const loc = f.file ? ` (${f.file}${f.line !== null ? ":" + f.line : ""})` : "";
      lines.push(`    - ${f.description}${loc} -- via ${f.reviewer}`);
    }
  }
  return lines.join("\n");
}

// Test-only: parse a single reviewer body in isolation. Exposed so unit tests
// can pin the regex without touching disk.
export function _parseReviewerOutputForTests(
  text: string,
  reviewer: string,
  reviewId = "review-test",
  iteration = 0,
): Finding[] {
  return parseReviewerOutput(text, reviewer, reviewId, iteration);
}
