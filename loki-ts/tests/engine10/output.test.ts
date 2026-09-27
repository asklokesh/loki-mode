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
      .toBe("[00:11] intake      done   11s   repo map cached, runners: pytest, vitest");
  });
  test("plan+wall done", () => {
    expect(formatStageLine({ clockS: 49, name: "plan+wall", status: "done", durationS: 38, detail: "plan 7 lines, 4 wall tests sealed" }))
      .toBe("[00:49] plan+wall   done   38s   plan 7 lines, 4 wall tests sealed");
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
      "PR:         https://github.com/o/r/pull/12 (draft: fix rounds exhausted)\n" +
      "Verdict:    PARTIAL\n" +
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
      "PR:         https://github.com/o/r/pull/34\n" +
      "Verdict:    VERIFIED\n" +
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
  });
});

describe("estimateEtaS (optional module via dynamic import, section 3)", () => {
  test("returns null when the eta module is not present (this slice ships without it)", async () => {
    expect(await estimateEtaS(180, 60)).toBeNull();
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
