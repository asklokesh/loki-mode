// Tests for src/runner/findings_injector.ts (v7.5.0 Phase 1).
//
// Covers:
//   - _parseReviewerOutputForTests: regex parse, severity normalization,
//     bullet stripping, line filtering.
//   - findLatestReviewDir: missing root, lex-sort latest, iter filter.
//   - loadPreviousFindings: full integration (aggregate.json + reviewer .txt
//     files), SKIP set enforcement, malformed-aggregate tolerance.
//   - renderFindingsForPrompt: severity grouping, ordering, attribution.
//
// Strategy mirrors tests/runner/quality_gates.test.ts:54-63 -- per-test scratch
// dir via mkdtempSync, rmSync cleanup in afterEach.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _parseReviewerOutputForTests,
  findLatestReviewDir,
  loadPreviousFindings,
  renderFindingsForPrompt,
} from "../../src/runner/findings_injector.ts";
import type { Finding } from "../../src/runner/findings_injector.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-findings-test-"));
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Helper: layout matches quality_gates.ts:614-616 -- review-<ts>-<iter>/
function makeReviewDir(name: string): string {
  const dir = join(scratch, "quality", "reviews", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- _parseReviewerOutputForTests ----------------------------------------

describe("_parseReviewerOutputForTests", () => {
  it("parses a single [Critical] line and extracts file + line", () => {
    const out = _parseReviewerOutputForTests(
      "[Critical] foo at src/x.ts:42",
      "security-sentinel",
    );
    expect(out.length).toBe(1);
    const f = out[0]!;
    expect(f.severity).toBe("Critical");
    expect(f.file).toBe("src/x.ts");
    expect(f.line).toBe(42);
    expect(f.reviewer).toBe("security-sentinel");
    expect(f.description).toBe("foo at src/x.ts:42");
  });

  it("normalizes all 4 severities (case-insensitive)", () => {
    // Mixed-case input -- the regex at findings_injector.ts:41 has /i and
    // normalizeSeverity at :44-50 lowercases before matching.
    const text = [
      "[CRITICAL] alpha at a.ts:1",
      "[high] beta at b.ts:2",
      "[Medium] gamma at c.ts:3",
      "[loW] delta at d.ts:4",
    ].join("\n");
    const out = _parseReviewerOutputForTests(text, "rv");
    expect(out.length).toBe(4);
    expect(out.map((f) => f.severity)).toEqual([
      "Critical",
      "High",
      "Medium",
      "Low",
    ]);
  });

  it("strips leading '- ' and '* ' bullet markers before regex match", () => {
    // findings_injector.ts:65 strips /^[-*]\s*/ before the SEVERITY regex.
    const text = [
      "- [High] dash bullet at src/a.ts:10",
      "* [Medium] star bullet at src/b.ts:20",
      "[Low] no bullet at src/c.ts:30",
    ].join("\n");
    const out = _parseReviewerOutputForTests(text, "rv");
    expect(out.length).toBe(3);
    expect(out[0]!.severity).toBe("High");
    expect(out[0]!.file).toBe("src/a.ts");
    expect(out[1]!.severity).toBe("Medium");
    expect(out[1]!.file).toBe("src/b.ts");
    expect(out[2]!.severity).toBe("Low");
    expect(out[2]!.file).toBe("src/c.ts");
  });

  it("v7.5.8: skips matches with empty or missing capture groups (no findings emitted)", () => {
    // v7.5.8 replaced `m[1]!`/`m[2]!` non-null assertions with explicit
    // `!m[1] || !m[2]` guards. The current SEVERITY_RE requires `.+` in
    // group 2 so a stripped "[High]" with no trailing body fails the regex
    // outright (m === null). A line like "[High]   " has only whitespace
    // after the bracket, but `\s*` is greedy and `.+` then needs >=1 char,
    // so trailing-whitespace-only also fails to match. Both code paths must
    // produce zero findings -- if a future regex tweak ever lets group 2
    // be empty, the explicit `!m[2]` guard is the last line of defense.
    const text = [
      "[High]",         // no body at all -- m === null
      "[Critical]   ",  // only whitespace body -- m === null
      "[Medium] ",      // single trailing space -- m === null (\.+ needs >=1 non-eol)
    ].join("\n");
    const out = _parseReviewerOutputForTests(text, "rv");
    expect(out.length).toBe(0);
  });

  it("ignores lines without a [Severity] marker", () => {
    const text = [
      "VERDICT: FAIL",
      "FINDINGS:",
      "- not a structured finding",
      "- [Critical] real finding at src/x.ts:1",
      "some prose",
      "",
      "  ",
    ].join("\n");
    const out = _parseReviewerOutputForTests(text, "rv");
    expect(out.length).toBe(1);
    expect(out[0]!.severity).toBe("Critical");
    expect(out[0]!.file).toBe("src/x.ts");
    expect(out[0]!.line).toBe(1);
  });
});

// --- findLatestReviewDir -------------------------------------------------

describe("findLatestReviewDir", () => {
  it("returns null when .loki/quality/reviews does not exist", () => {
    expect(findLatestReviewDir(scratch)).toBeNull();
  });

  it("returns the lexicographically greatest review-* dir", () => {
    // review-<ts>-<iter> -- ts is ISO basic-format so lex sort == time sort.
    makeReviewDir("review-20260101T000000Z-1");
    makeReviewDir("review-20260201T000000Z-2");
    makeReviewDir("review-20260301T000000Z-3");
    const got = findLatestReviewDir(scratch);
    expect(got).not.toBeNull();
    expect(got!.endsWith("review-20260301T000000Z-3")).toBe(true);
  });

  it("filters by iteration suffix when iter param is passed", () => {
    makeReviewDir("review-20260101T000000Z-1");
    makeReviewDir("review-20260201T000000Z-2");
    makeReviewDir("review-20260301T000000Z-3");
    const got = findLatestReviewDir(scratch, 2);
    expect(got).not.toBeNull();
    expect(got!.endsWith("review-20260201T000000Z-2")).toBe(true);
  });
});

// --- loadPreviousFindings ------------------------------------------------

describe("loadPreviousFindings", () => {
  it("parses findings from BOTH reviewer .txt files and pulls metadata from aggregate.json", () => {
    const dir = makeReviewDir("review-20260301T000000Z-7");
    writeFileSync(
      join(dir, "aggregate.json"),
      JSON.stringify({
        review_id: "review-20260301T000000Z-7",
        iteration: 7,
        pass_count: 1,
        fail_count: 2,
      }),
    );
    writeFileSync(
      join(dir, "architecture-strategist.txt"),
      "VERDICT: FAIL\nFINDINGS:\n- [Critical] missing input validation at src/api/login.ts:42\n- [Medium] consider extracting helper at src/api/login.ts:80\n",
    );
    writeFileSync(
      join(dir, "security-sentinel.txt"),
      "VERDICT: FAIL\nFINDINGS:\n- [High] hardcoded secret at src/auth.ts:10\n",
    );

    const result = loadPreviousFindings(scratch);
    expect(result.reviewDir).not.toBeNull();
    expect(result.reviewId).toBe("review-20260301T000000Z-7");
    expect(result.iteration).toBe(7);
    expect(result.findings.length).toBe(3);

    // Ordering depends on readdirSync; verify via reviewer attribution counts.
    const arch = result.findings.filter((f) => f.reviewer === "architecture-strategist");
    const sec = result.findings.filter((f) => f.reviewer === "security-sentinel");
    expect(arch.length).toBe(2);
    expect(sec.length).toBe(1);
    expect(sec[0]!.severity).toBe("High");
    expect(sec[0]!.file).toBe("src/auth.ts");
    expect(sec[0]!.line).toBe(10);

    const critical = result.findings.find((f) => f.severity === "Critical");
    expect(critical).toBeDefined();
    expect(critical!.file).toBe("src/api/login.ts");
    expect(critical!.line).toBe(42);
    // reviewId/iteration propagate into per-Finding records.
    expect(critical!.reviewId).toBe("review-20260301T000000Z-7");
    expect(critical!.iteration).toBe(7);
  });

  it("skips the SKIP-set files and *-prompt.txt artifacts", () => {
    // findings_injector.ts:157-167 hard-skips diff.txt, files.txt,
    // anti-sycophancy.txt and any *-prompt.txt file.
    const dir = makeReviewDir("review-20260301T000000Z-1");
    writeFileSync(
      join(dir, "aggregate.json"),
      JSON.stringify({ review_id: "review-20260301T000000Z-1", iteration: 1 }),
    );
    // Should be parsed.
    writeFileSync(
      join(dir, "test-coverage-auditor.txt"),
      "FINDINGS:\n- [High] real finding at src/q.ts:9\n",
    );
    // Should be SKIPPED -- if the parser walked these, severity tokens would
    // leak into the finding count.
    writeFileSync(join(dir, "diff.txt"), "+ [Critical] noise at fake.ts:1\n");
    writeFileSync(join(dir, "files.txt"), "src/x.ts\n[Critical] also noise at fake.ts:2\n");
    writeFileSync(
      join(dir, "anti-sycophancy.txt"),
      "[Critical] sycophancy noise at fake.ts:3\n",
    );
    writeFileSync(
      join(dir, "test-coverage-auditor-prompt.txt"),
      "[Critical] prompt noise at fake.ts:4\n",
    );

    const result = loadPreviousFindings(scratch);
    expect(result.findings.length).toBe(1);
    const only = result.findings[0]!;
    expect(only.reviewer).toBe("test-coverage-auditor");
    expect(only.severity).toBe("High");
    expect(only.file).toBe("src/q.ts");
  });

  it("tolerates malformed aggregate.json -- still returns parsed findings", () => {
    // findings_injector.ts:141-144 swallows JSON.parse errors so per-reviewer
    // text remains the source of truth.
    const dir = makeReviewDir("review-20260301T000000Z-2");
    writeFileSync(join(dir, "aggregate.json"), "{not valid json,,,");
    writeFileSync(
      join(dir, "architecture-strategist.txt"),
      "FINDINGS:\n- [Critical] still parsed at src/a.ts:1\n",
    );

    const result = loadPreviousFindings(scratch);
    // Metadata extraction failed (malformed JSON) but findings still come
    // through with reviewId="" and iteration=-1 fallbacks (findings_injector.ts:176).
    expect(result.reviewId).toBeNull();
    expect(result.iteration).toBeNull();
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.severity).toBe("Critical");
    expect(result.findings[0]!.file).toBe("src/a.ts");
    expect(result.findings[0]!.reviewId).toBe("");
    expect(result.findings[0]!.iteration).toBe(-1);
  });
});

// --- renderFindingsForPrompt ---------------------------------------------

describe("renderFindingsForPrompt", () => {
  it("groups by severity (Critical first, Low last), includes counts and reviewer attribution", () => {
    const findings: Finding[] = [
      {
        reviewId: "r1",
        iteration: 3,
        reviewer: "security-sentinel",
        severity: "Low",
        description: "minor style at src/a.ts:1",
        file: "src/a.ts",
        line: 1,
        raw: "- [Low] minor style at src/a.ts:1",
      },
      {
        reviewId: "r1",
        iteration: 3,
        reviewer: "architecture-strategist",
        severity: "Critical",
        description: "missing auth at src/api/login.ts:42",
        file: "src/api/login.ts",
        line: 42,
        raw: "- [Critical] missing auth at src/api/login.ts:42",
      },
      {
        reviewId: "r1",
        iteration: 3,
        reviewer: "security-sentinel",
        severity: "Critical",
        description: "hardcoded secret at src/auth.ts:10",
        file: "src/auth.ts",
        line: 10,
        raw: "- [Critical] hardcoded secret at src/auth.ts:10",
      },
      {
        reviewId: "r1",
        iteration: 3,
        reviewer: "test-coverage-auditor",
        severity: "Medium",
        description: "no test for branch at src/util.ts:99",
        file: "src/util.ts",
        line: 99,
        raw: "- [Medium] no test for branch at src/util.ts:99",
      },
    ];

    const out = renderFindingsForPrompt(findings);
    expect(out.length).toBeGreaterThan(0);

    // Header (findings_injector.ts:196).
    expect(out).toContain("PREVIOUS REVIEWER FINDINGS");

    // Group counts -- 2 Criticals, 1 Medium, 1 Low, 0 High (High omitted).
    expect(out).toContain("[Critical] (2):");
    expect(out).toContain("[Medium] (1):");
    expect(out).toContain("[Low] (1):");
    expect(out).not.toContain("[High]");

    // Ordering: Critical block must precede Low block.
    const idxCrit = out.indexOf("[Critical] (2):");
    const idxMed = out.indexOf("[Medium] (1):");
    const idxLow = out.indexOf("[Low] (1):");
    expect(idxCrit).toBeGreaterThanOrEqual(0);
    expect(idxMed).toBeGreaterThan(idxCrit);
    expect(idxLow).toBeGreaterThan(idxMed);

    // Reviewer attribution appears (findings_injector.ts:203 "-- via <reviewer>").
    expect(out).toContain("via architecture-strategist");
    expect(out).toContain("via security-sentinel");
    expect(out).toContain("via test-coverage-auditor");
  });

  it("returns empty string when there are no findings", () => {
    expect(renderFindingsForPrompt([])).toBe("");
  });
});
