// E-13: live output (docs/v10/ENGINE.md section 11).
// Golden lines are copied verbatim from the ENGINE.md examples.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  estimateEtaS,
  formatClock,
  formatDuration,
  formatHeartbeatLine,
  formatStageLine,
  formatSummary,
  formatTokens,
  EXIT,
  outcomeOf,
  reasonOf,
} from "../../src/engine10/output.ts";

describe("formatClock", () => {
  test("zero-padded mm:ss", () => {
    expect(formatClock(11)).toBe("00:11");
    expect(formatClock(49)).toBe("00:49");
    expect(formatClock(65)).toBe("01:05");
  });
});

describe("formatDuration", () => {
  test("under a minute is plain seconds", () => {
    expect(formatDuration(11)).toBe("11s");
    expect(formatDuration(38)).toBe("38s");
    expect(formatDuration(0)).toBe("0s");
  });
  test("a minute or more is Mm SSs, seconds zero-padded", () => {
    expect(formatDuration(60)).toBe("1m00s");
    expect(formatDuration(120)).toBe("2m00s");
    expect(formatDuration(161)).toBe("2m41s");
    expect(formatDuration(252)).toBe("4m12s");
  });
  test("never negative", () => {
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("formatTokens", () => {
  test("thousands render as k", () => {
    expect(formatTokens(212000)).toBe("212k");
    expect(formatTokens(98000)).toBe("98k");
  });
  test("under 1000 renders as-is", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatStageLine (golden, ENGINE.md section 11)", () => {
  test("intake done", () => {
    expect(formatStageLine({ clockS: 11, name: "intake", status: "done", durationS: 11, detail: "repo map cached, runners: pytest, vitest" }))
      .toBe("[00:11] intake      done    11s   repo map cached, runners: pytest, vitest");
  });
  test("plan+wall done", () => {
    expect(formatStageLine({ clockS: 49, name: "plan+wall", status: "done", durationS: 38, detail: "plan 7 lines, 4 wall tests sealed" }))
      .toBe("[00:49] plan+wall   done    38s   plan 7 lines, 4 wall tests sealed");
  });
  test("a null duration renders as not measured, never 0s (section 5)", () => {
    expect(formatStageLine({ clockS: 0, name: "plan", status: "skipped", durationS: null, detail: "module not present" }))
      .toBe("[00:00] plan        skipped not measured   module not present");
  });

  // E-44 (found by E-14): "skipped" is exactly STATUS_WIDTH-1 chars wide, so
  // padEnd left zero separating spaces and any duration glued straight onto
  // it ("skipped0s"). STATUS_WIDTH must leave room for at least one space
  // after the longest status word, whatever duration follows it.
  test("skipped never runs into the duration, even when one is present", () => {
    const line = formatStageLine({ clockS: 0, name: "plan", status: "skipped", durationS: 0, detail: "x" });
    expect(line).not.toContain("skipped0s");
    expect(line).toContain("skipped 0s");
  });
});

describe("formatHeartbeatLine (golden, ENGINE.md section 11)", () => {
  test("implement waiting on a claude session", () => {
    const line = formatHeartbeatLine({
      clockS: 65,
      stage: "implement",
      waitingOn: "claude session",
      elapsedS: 60,
      etaS: 120,
      diff: { files: 3, insertions: 41, deletions: 2 },
    });
    expect(line).toBe("[01:05] implement   waiting on claude session  1m00s  ETA 2m00s  (3 files, +41 -2)");
  });

  test("contains the literal \"waiting on <x>\" phrase the card requires", () => {
    const line = formatHeartbeatLine({ clockS: 60, stage: "verify", waitingOn: "impacted tests", elapsedS: 60 });
    expect(line).toContain("waiting on impacted tests");
  });

  test("omits ETA and diff when absent", () => {
    const line = formatHeartbeatLine({ clockS: 5, stage: "seal", waitingOn: "signing key", elapsedS: 5 });
    expect(line).toBe("[00:05] seal        waiting on signing key  5s");
  });
});

describe("formatSummary (golden, ENGINE.md section 11)", () => {
  test("known dollars with unknown tokens never prints 0 tokens", () => {
    const out = formatSummary({
      pr: null, verdict: "VERIFIED", notProven: [], flaky: [],
      cost: { usd: 0.84, provider: "claude", tokens: null },
      wallS: 60, stages: [],
    } as never);
    expect(out).not.toContain("0 tokens");
    expect(out).toContain("tokens not measured");
  });
  test("PARTIAL fixture reproduces the ENGINE.md example verbatim", () => {
    const out = formatSummary({
      pr: { url: "https://github.com/o/r/pull/12", draft: true, draftReason: "fix rounds exhausted" },
      verdict: "PARTIAL",
      notProven: ["full suite", "app boot", "council", "security scan (deep verify running)"],
      flaky: ["tests/test_x.py::t"],
      cost: { usd: 0.84, provider: "claude", tokens: 212000 },
      wallS: 252,
      stages: [
        { label: "intake", seconds: 11 },
        { label: "plan+wall", seconds: 38 },
        { label: "implement", seconds: 161 },
        { label: "verify", seconds: 29 },
        { label: "seal+pr", seconds: 13 },
      ],
    });
    expect(out).toBe(
      "Outcome:    PARTIAL\n" +
      "PR:         https://github.com/o/r/pull/12 (draft: fix rounds exhausted)\n" +
      "NOT PROVEN: full suite, app boot, council, security scan (deep verify running); flaky tests/test_x.py::t\n" +
      "Cost:       $0.84 (claude, 212k tokens)\n" +
      "Time:       4m12s (intake 11s, plan+wall 38s, implement 2m41s, verify 29s, seal+pr 13s)",
    );
  });

  test("VERIFIED fixture: no draft suffix, no flaky clause", () => {
    const out = formatSummary({
      pr: { url: "https://github.com/o/r/pull/34", draft: false },
      verdict: "VERIFIED",
      notProven: [
        "full suite (deep verify running)",
        "app boot (deep verify running)",
        "council (deep verify running)",
        "security scan (deep verify running)",
      ],
      flaky: [],
      cost: { usd: 0.42, provider: "claude", tokens: 98000 },
      wallS: 300,
      stages: [
        { label: "intake", seconds: 10 },
        { label: "plan+wall", seconds: 40 },
        { label: "implement", seconds: 200 },
        { label: "verify", seconds: 35 },
        { label: "seal+pr", seconds: 15 },
      ],
    });
    expect(out).toBe(
      "Outcome:    VERIFIED\n" +
      "PR:         https://github.com/o/r/pull/34\n" +
      "NOT PROVEN: full suite (deep verify running), app boot (deep verify running), council (deep verify running), security scan (deep verify running)\n" +
      "Cost:       $0.42 (claude, 98k tokens)\n" +
      "Time:       5m00s (intake 10s, plan+wall 40s, implement 3m20s, verify 35s, seal+pr 15s)",
    );
  });

  test("null cost renders \"not measured\", never $0.00", () => {
    const out = formatSummary({
      pr: null,
      verdict: "PARTIAL",
      notProven: ["full suite"],
      flaky: [],
      cost: { usd: null, provider: "codex", tokens: null, note: "codex reports tokens only" },
      wallS: 30,
      stages: [{ label: "intake", seconds: 30 }],
    });
    expect(out).toContain("Cost:       not measured (codex reports tokens only)");
    expect(out).not.toContain("$0.00");
    expect(out).not.toContain("$0");
    expect(out).toContain("PR:         none");
    const base = { pr: null, verdict: "VERIFIED", notProven: [], flaky: [], cost: { usd: null, provider: "claude", tokens: null }, wallS: 1, stages: [] } as never;
    expect(formatSummary({ ...(base as object), reason: "empty diff" } as never)).toContain("Outcome:    VERIFIED\nReason:     empty diff\n");
    const sha = "a".repeat(64);
    expect(formatSummary({ ...(base as object), receipt: { sha, signed: false } } as never)).toContain(`Receipt:    sha256:${sha} (UNSIGNED)`);
    expect(formatSummary({ ...(base as object), receipt: { sha: null, signed: null } } as never)).toContain("Receipt:    none (UNCHECKED)");
    expect(formatSummary({ ...(base as object), receipt: { sha: null, signed: null, tampered: true } } as never)).toContain("Receipt:    TAMPERED (event log modified; receipt not trustworthy)");
    expect(outcomeOf("VERIFIED", false, null, true)).toBe("FAILED");
    expect(formatSummary({ ...(base as object), receipt: { sha, signed: true } } as never)).toContain(`Receipt:    sha256:${sha}\n`);
  });

  // E-69: the three cost states a run's Cost line can be in.
  test("fully measured: every session priced renders the plain $X.XX line", () => {
    const out = formatSummary({
      pr: null, verdict: "VERIFIED", notProven: [], flaky: [],
      cost: { usd: 0.30, provider: "claude", tokens: 1000, measuredSessions: 2, totalSessions: 2, partialUsd: 0.30 },
      wallS: 10, stages: [],
    } as never);
    expect(out).toContain("Cost:       $0.30 (claude, 1k tokens)");
    expect(out).not.toContain("partial");
  });

  test("not measured: zero sessions priced renders \"not measured\", never $0.00", () => {
    const out = formatSummary({
      pr: null, verdict: "FAILED", notProven: [], flaky: [],
      cost: { usd: null, provider: "claude", tokens: null, measuredSessions: 0, totalSessions: 2, partialUsd: 0 },
      wallS: 10, stages: [],
    } as never);
    expect(out).toContain("Cost:       not measured");
    expect(out).not.toContain("$0.00");
    expect(out).not.toContain("partial");
  });

  test("partial: some sessions priced renders \"partial: $X for N of M sessions\"", () => {
    const out = formatSummary({
      pr: null, verdict: "PARTIAL", notProven: [], flaky: [],
      cost: { usd: null, provider: "claude", tokens: 1200, measuredSessions: 1, totalSessions: 2, partialUsd: 0.125 },
      wallS: 10, stages: [],
    } as never);
    expect(out).toContain("Cost:       partial: $0.13 for 1 of 2 sessions");
    expect(out).not.toContain("$0.00");
    expect(out).not.toContain("not measured");
  });
});

describe("estimateEtaS (optional module via dynamic import, section 3)", () => {
  test("returns null when the eta module is not present", async () => {
    expect(await estimateEtaS(180, 60, "./fixtures/output/no-such-eta-module.ts")).toBeNull();
  });

  test("uses an injected eta module when one is present", async () => {
    const modulePath = join(import.meta.dir, "fixtures", "output", "fake-eta.ts");
    expect(await estimateEtaS(180, 60, modulePath)).toBe(120);
  });

  test("a module with no estimate export is treated as absent", async () => {
    const modulePath = join(import.meta.dir, "..", "..", "src", "engine10", "types.ts");
    expect(await estimateEtaS(180, 60, modulePath)).toBeNull();
  });
});

describe("estimateEtaS import errors", () => {
  test("an eta module that throws on import is surfaced, not swallowed", async () => {
    const p = join(import.meta.dir, "fixtures", "output", "throwing-eta.ts");
    await expect(estimateEtaS(180, 60, p)).rejects.toThrow("eta boom");
  });
});

describe("outcomeOf and the exit ladder (A-110)", () => {
  test("every verdict maps to one outcome and exit", () => {
    const row = (v: Parameters<typeof outcomeOf>[0], cap: boolean, stop: string | null) => { const o = outcomeOf(v, cap, stop); return [o, EXIT[o]]; };
    expect(row("VERIFIED", false, null)).toEqual(["VERIFIED", 0]);
    expect(row("ALREADY_SATISFIED", false, null)).toEqual(["ALREADY_SATISFIED", 0]);
    expect(row("PARTIAL", false, null)).toEqual(["FAILED", 1]);
    expect(row("FAILED", false, "fatal:auth")).toEqual(["FAILED", 1]);
    expect(row("PARTIAL", true, null)).toEqual(["BUDGET_STOP", 3]);
    expect(row("SPEC_CONFLICT", false, null)).toEqual(["BLOCKED", 4]);
    expect(row("PARTIAL", false, "stalled")).toEqual(["STALLED", 5]);
  });
  test("the Outcome line carries the outcome name, falling back to the verdict", () => {
    const base = { pr: null, verdict: "PARTIAL", notProven: [], flaky: [], cost: { usd: 1, provider: "claude", tokens: 1 }, wallS: 1, stages: [] } as never;
    expect(formatSummary({ ...(base as object), outcome: "FAILED" } as never)).toContain("Outcome:    FAILED\n");
    expect(formatSummary(base)).toContain("Outcome:    PARTIAL\n");
  });
});

describe("reasonOf (A-130 round 4)", () => {
  const ev = (type: string, stage: string | null, data: Record<string, unknown> = {}) => ({ v: 1, seq: 0, ts: "t", run: "r", type, stage, data }) as never;
  const vfy = (checks: unknown[]) => ev("stage.completed", "verify", { checks });
  test("success has no reason", () => expect(reasonOf([], false, null, "VERIFIED")).toBeUndefined());
  test("tamper wins over everything", () => expect(reasonOf([ev("stage.failed", "verify", { reason: "x" })], true, "stalled", "FAILED")).toBe("event log modified outside the engine"));
  test("fatal stops are named", () => {
    expect(reasonOf([ev("stage.failed", "implement", { reason: "exit 1 (general error)" })], false, "fatal:quota_exhausted", "FAILED")).toBe("provider credit exhausted");
    expect(reasonOf([], false, "fatal:auth", "FAILED")).toBe("provider authentication failed");
  });
  test("BLOCKED prints the conflict, not the empty diff", () => {
    const e = [ev("stage.completed", "implement", { spec_conflict_reason: "spec says A and B" }), ev("stage.failed", "verify", { reason: "empty diff without an already_done marker" })];
    expect(reasonOf(e, false, null, "BLOCKED")).toBe("spec conflict: spec says A and B");
  });
  test("stalled", () => expect(reasonOf([vfy([{ name: "t", result: "fail" }])], false, "stalled", "STALLED")).toBe("stalled: same failure 3 times"));
  test("a red suite names the failing check and first_error", () => expect(reasonOf([vfy([{ name: "bun:calc.test.ts", result: "fail", first_error: "expected 6 got 5" }])], false, null, "FAILED")).toBe("bun:calc.test.ts failed: expected 6 got 5"));
  test("first stage.failed reason", () => expect(reasonOf([ev("stage.failed", "verify", { reason: "empty diff" })], false, null, "FAILED")).toBe("empty diff"));
  test("cap hit before any stage", () => expect(reasonOf([ev("cap.hit", null)], false, null, "BUDGET_STOP")).toBe("cost/time cap reached"));
  test("no tests to run", () => expect(reasonOf([vfy([])], false, null, "FAILED")).toBe("no tests to run"));
  test("control characters are stripped and the length capped", () => {
    const r = reasonOf([ev("stage.failed", "verify", { reason: `a\x1b[31m\nb${"x".repeat(300)}` })], false, null, "FAILED")!;
    expect(r).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(r.length).toBe(200);
  });
});
