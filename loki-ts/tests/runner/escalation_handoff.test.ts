// Tests for src/runner/escalation_handoff.ts.
//
// Covers:
//   - renderHandoff: pure markdown rendering (no findings, no learnings,
//     severity grouping, file:line formatting, learnings tail-window)
//   - writeEscalationHandoff: filename pattern, opts override behavior,
//     deterministic timestamp via opts.now
//   - readLatestHandoff: missing dir, empty dir, lex-latest selection,
//     non-.md filtering
//
// Strategy: each test uses an isolated temp dir scoped to scratch. Pure
// renderHandoff cases never touch disk. Disk-touching tests pass injected
// findings/learnings via opts so loadPreviousFindings + loadLearnings are
// not exercised against real review/state directories.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readLatestHandoff,
  renderHandoff,
  writeEscalationHandoff,
} from "../../src/runner/escalation_handoff.ts";
import type { HandoffInput } from "../../src/runner/escalation_handoff.ts";
import type { Finding, Severity } from "../../src/runner/findings_injector.ts";
import type { Learning } from "../../src/runner/learnings_writer.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-handoff-test-"));
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewId: "review-test",
    iteration: 1,
    reviewer: "architecture-strategist",
    severity: "Medium",
    description: "default description",
    file: null,
    line: null,
    raw: "[Medium] default description",
    ...overrides,
  };
}

function mkLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: "abc1234567890def",
    timestamp: "2026-04-28T00:00:00.000Z",
    iteration: 1,
    trigger: "gate_failure",
    rootCause: "default root cause",
    fix: "pending",
    preventInFuture: "regression test",
    evidence: {},
    ...overrides,
  };
}

const baseInput: HandoffInput = {
  gateName: "static_analysis",
  iteration: 7,
  consecutiveFailures: 3,
  detail: "bad.sh: line 2: unexpected EOF",
};

// --- renderHandoff (pure) -------------------------------------------------

describe("renderHandoff", () => {
  it("with 0 findings and 0 learnings: contains gate, iteration, consecutiveFailures, decision section", () => {
    const out = renderHandoff(baseInput, [], []);
    expect(out).toContain("static_analysis");
    expect(out).toContain("iteration 7");
    expect(out).toContain("3 consecutive");
    expect(out).toContain("What the human must decide");
    // Empty-findings hint.
    expect(out).toContain("no per-finding records captured");
    // No learnings section header is added when there are none.
    expect(out).not.toContain("## Recent learnings");
  });

  it("renders findings sorted by severity (Critical, High, Medium, Low groups)", () => {
    // Caller-controlled order: pass them in already-sorted (renderHandoff
    // does NOT re-sort -- it iterates in-input-order). We verify the rendered
    // body keeps Critical above High above Medium above Low when given sorted
    // input, mirroring how quality_gates would feed them.
    const order: Severity[] = ["Critical", "High", "Medium", "Low"];
    const findings: Finding[] = order.map((sev) =>
      mkFinding({
        severity: sev,
        description: `${sev}-issue`,
        raw: `[${sev}] ${sev}-issue`,
      }),
    );
    const out = renderHandoff(baseInput, findings, []);
    const idxCritical = out.indexOf("[Critical]");
    const idxHigh = out.indexOf("[High]");
    const idxMedium = out.indexOf("[Medium]");
    const idxLow = out.indexOf("[Low]");
    expect(idxCritical).toBeGreaterThan(-1);
    expect(idxHigh).toBeGreaterThan(idxCritical);
    expect(idxMedium).toBeGreaterThan(idxHigh);
    expect(idxLow).toBeGreaterThan(idxMedium);
    expect(out).toContain("Outstanding findings (4)");
  });

  it("with file:line: renders as '(file:line)'", () => {
    const findings = [
      mkFinding({
        severity: "Critical",
        description: "hardcoded secret",
        file: "src/auth/login.ts",
        line: 42,
      }),
    ];
    const out = renderHandoff(baseInput, findings, []);
    expect(out).toContain("(src/auth/login.ts:42)");
  });

  it("with no file in finding: no parens for location", () => {
    const findings = [
      mkFinding({
        severity: "High",
        description: "design smell",
        file: null,
        line: null,
      }),
    ];
    const out = renderHandoff(baseInput, findings, []);
    // The bullet must include the description without a trailing "(...)" loc.
    expect(out).toContain("[High] design smell -- architecture-strategist");
    // No location parens follow the description before the reviewer suffix.
    expect(out).not.toContain("design smell (");
  });

  it("with 15 learnings: renders only the last 10", () => {
    const learnings: Learning[] = [];
    for (let i = 1; i <= 15; i++) {
      learnings.push(
        mkLearning({
          id: `id-${i}`,
          iteration: i,
          rootCause: `cause-${i}`,
        }),
      );
    }
    const out = renderHandoff(baseInput, [], learnings);
    expect(out).toContain("## Recent learnings (10)");
    // First 5 must NOT appear (cause-1..cause-5).
    for (let i = 1; i <= 5; i++) {
      expect(out).not.toContain(`cause-${i}\n`);
      expect(out).not.toContain(`cause-${i}$`);
    }
    // Last 10 (cause-6..cause-15) MUST appear.
    for (let i = 6; i <= 15; i++) {
      expect(out).toContain(`cause-${i}`);
    }
  });
});

// --- writeEscalationHandoff -----------------------------------------------

describe("writeEscalationHandoff", () => {
  it("writes to .loki/escalations/, filename pattern handoff-<iso-ms>-<pid>-<n>-<gate>.md (v7.5.1: collision-safe), returns {path,bytes}", () => {
    const fixedNow = new Date("2026-04-28T12:34:56.789Z");
    const result = writeEscalationHandoff(scratch, baseInput, {
      findings: [],
      learnings: [],
      now: () => fixedNow,
    });
    // Path lives under the escalations subdir.
    expect(result.path.startsWith(join(scratch, "escalations"))).toBe(true);
    // v7.5.1 fix B5: filename keeps millisecond resolution and adds
    // <pid>-<counter> to defeat sub-second collisions.
    const fname = result.path.split("/").pop()!;
    expect(fname).toMatch(
      /^handoff-20260428T123456789Z-\d+-\d+-static_analysis\.md$/,
    );
    // bytes equals body length (UTF-8 ASCII here).
    const body = readFileSync(result.path, "utf-8");
    expect(result.bytes).toBe(body.length);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("opts.findings overrides loadPreviousFindings (no review dir needed)", () => {
    // No .loki/quality/reviews tree exists under scratch -- if the impl tried
    // to read disk it would yield empty findings and the body would say "no
    // per-finding records captured". The override forces a real bullet.
    const findings = [
      mkFinding({
        severity: "Critical",
        description: "injected-finding-marker",
        reviewer: "security-sentinel",
      }),
    ];
    const result = writeEscalationHandoff(scratch, baseInput, {
      findings,
      learnings: [],
    });
    const body = readFileSync(result.path, "utf-8");
    expect(body).toContain("injected-finding-marker");
    expect(body).toContain("[Critical]");
    expect(body).not.toContain("no per-finding records captured");
  });

  it("opts.learnings overrides loadLearnings (no learnings file needed)", () => {
    // No .loki/state/relevant-learnings.json exists -- override forces the
    // learnings section to render.
    const learnings = [
      mkLearning({
        id: "marker",
        rootCause: "injected-learning-marker",
      }),
    ];
    const result = writeEscalationHandoff(scratch, baseInput, {
      findings: [],
      learnings,
    });
    const body = readFileSync(result.path, "utf-8");
    expect(body).toContain("injected-learning-marker");
    expect(body).toContain("## Recent learnings (1)");
  });

  it("opts.now stub controls the timestamp embedded in the filename", () => {
    const stubNow = new Date("2027-01-02T03:04:05.000Z");
    const result = writeEscalationHandoff(scratch, baseInput, {
      findings: [],
      learnings: [],
      now: () => stubNow,
    });
    const fname = result.path.split("/").pop()!;
    // v7.5.1 fix B5: ms preserved (.000 here -> "000"), pid + counter inserted.
    expect(fname).toMatch(
      /^handoff-20270102T030405000Z-\d+-\d+-static_analysis\.md$/,
    );
  });

  it("v7.5.1 fix B5: two handoffs in the same wall-clock millisecond do not collide", () => {
    const fixedNow = new Date("2026-04-28T12:34:56.789Z");
    const r1 = writeEscalationHandoff(scratch, baseInput, {
      findings: [],
      learnings: [],
      now: () => fixedNow,
    });
    const r2 = writeEscalationHandoff(scratch, baseInput, {
      findings: [],
      learnings: [],
      now: () => fixedNow,
    });
    expect(r1.path).not.toBe(r2.path);
    expect(existsSync(r1.path)).toBe(true);
    expect(existsSync(r2.path)).toBe(true);
  });
});

// --- readLatestHandoff ----------------------------------------------------

describe("readLatestHandoff", () => {
  it("returns null when escalations dir is missing", () => {
    expect(readLatestHandoff(scratch)).toBeNull();
  });

  it("returns null when escalations dir exists but is empty", () => {
    mkdirSync(join(scratch, "escalations"), { recursive: true });
    expect(readLatestHandoff(scratch)).toBeNull();
  });

  it("returns the lexicographically latest .md file in the dir", () => {
    const dir = join(scratch, "escalations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "handoff-20260101T000000Z-gate.md"), "first");
    writeFileSync(join(dir, "handoff-20270101T000000Z-gate.md"), "latest");
    writeFileSync(join(dir, "handoff-20260601T000000Z-gate.md"), "middle");
    const result = readLatestHandoff(scratch);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("latest");
    expect(result!.path).toBe(join(dir, "handoff-20270101T000000Z-gate.md"));
  });

  it("ignores non-.md files in the dir", () => {
    const dir = join(scratch, "escalations");
    mkdirSync(dir, { recursive: true });
    // A non-.md file with a lex-larger name must not be returned.
    writeFileSync(join(dir, "zzzz-not-markdown.txt"), "noise");
    writeFileSync(join(dir, "handoff-20260101T000000Z-gate.md"), "the-md");
    const result = readLatestHandoff(scratch);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("the-md");
    expect(result!.path.endsWith(".md")).toBe(true);
    // Sanity: dir actually contains the .txt (proves the filter is real).
    expect(readdirSync(dir)).toContain("zzzz-not-markdown.txt");
  });
});
