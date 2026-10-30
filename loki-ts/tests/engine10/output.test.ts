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
  formatTierSeal,
  formatTokens,
  EXIT,
  outcomeOf,
  reasonOf,
  spendSoFar,
} from "../../src/engine10/output.ts";
import { summaryCost } from "../../src/engine10/events.ts";
import type { EventEnvelope } from "../../src/engine10/types.ts";
import { cacheSavings } from "../../src/runner/budget.ts";
import { clipWords } from "../../src/util/term_width.ts";
import { reset as resetEta } from "../../src/contrib/eta.ts";

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
    const line = formatHeartbeatLine({ clockS: 5, stage: "seal", waitingOn: "signing key", elapsedS: 5, etaS: null });
    expect(line).toBe("[00:05] seal        waiting on signing key  5s");
  });

  test("Q18-07: the heartbeat computes an ETA from the stage target when none is passed", async () => {
    resetEta();
    formatHeartbeatLine({ clockS: 0, stage: "implement", waitingOn: "x", elapsedS: 0 }); // first call starts the lazy eta.ts load
    await Bun.sleep(30);
    expect(formatHeartbeatLine({ clockS: 65, stage: "implement", waitingOn: "claude session", elapsedS: 60 })).toContain("ETA 2m00s");
    expect(formatHeartbeatLine({ clockS: 5, stage: "no-such-stage", waitingOn: "x", elapsedS: 5 })).not.toContain("ETA");
  });

  test("Q18-07: a done stage line records its actual so later ETAs learn the overrun", async () => {
    resetEta();
    formatHeartbeatLine({ clockS: 0, stage: "implement", waitingOn: "x", elapsedS: 0 });
    await Bun.sleep(30);
    formatStageLine({ clockS: 360, name: "implement", status: "done", durationS: 360, detail: "x" });
    expect(formatHeartbeatLine({ clockS: 1, stage: "implement", waitingOn: "x", elapsedS: 60 })).toContain("ETA 5m00s");
    resetEta();
  });
});

describe("formatSummary (golden, ENGINE.md section 11)", () => {
  test("cache saved: Cost line shows cache read tokens and saved dollars; measured 0 is 0.00, unmeasured is not measured", () => {
    const base = { pr: null, verdict: "VERIFIED", notProven: [], flaky: [], wallS: 60, stages: [] };
    const c = (extra: object): string => formatSummary({ ...base, cost: { usd: 0.84, provider: "claude", tokens: 212000, ...extra } } as never);
    expect(c({ cacheReadTokens: 1_000_000, cacheSavedUsd: 1.9 })).toContain("cache read 1000k tokens, saved $1.90");
    expect(c({ cacheReadTokens: 0, cacheSavedUsd: 0 })).toContain("cache read 0 tokens, saved $0.00");
    expect(c({ cacheReadTokens: null, cacheSavedUsd: null })).toContain("cache not measured");
    expect(c({})).not.toContain("cache");
  });
  test("cache saved: cacheSavings equals tokens times the price delta and is null when any record lacks the key", () => {
    // sonnet: input 2.0, cache_read 0.1 per MTok -> delta 1.9
    expect(cacheSavings([{ model: "sonnet", cache_read_tokens: 2_000_000 }])).toEqual({ readTokens: 2_000_000, savedUsd: 3.8 });
    expect(cacheSavings([{ model: "sonnet", cache_read_tokens: 0 }])).toEqual({ readTokens: 0, savedUsd: 0 });
    expect(cacheSavings([{ model: "sonnet", cache_read_tokens: 1000 }, { model: "sonnet" }])).toBeNull();
    expect(cacheSavings([])).toBeNull();
  });
  test("Q17-02: cost line shows cap use only when a cap is set", () => {
    const base = { pr: null, verdict: "VERIFIED", notProven: [], flaky: [], wallS: 60, stages: [] };
    const capped = formatSummary({ ...base, cost: { usd: 0.84, provider: "claude", tokens: 212000, capUsd: 2 } } as never);
    expect(capped).toContain("$0.84 (claude, 212k tokens; 42% of cap $2.00)");
    const plain = formatSummary({ ...base, cost: { usd: 0.84, provider: "claude", tokens: 212000 } } as never);
    expect(plain).not.toContain("of cap");
    expect(formatSummary({ ...base, cost: { usd: null, provider: "claude", tokens: null, capUsd: 2 } } as never)).not.toContain("of cap");
    expect(formatSummary({ ...base, cost: { usd: null, provider: "claude", tokens: null, partialUsd: 1, measuredSessions: 1, totalSessions: 2, capUsd: 2 } } as never)).not.toContain("of cap");
  });
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
      "Time:       4m12s (intake 11s, plan+wall 38s, implement 2m41s, verify 29s, seal+pr 13s; slowest: implement 64%)",
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
      "Time:       5m00s (intake 10s, plan+wall 40s, implement 3m20s, verify 35s, seal+pr 15s; slowest: implement 67%)",
    );
  });

  test("Time line names the slowest stage and its share of wall time; omitted without durations (TEN-SPEED-03)", () => {
    const base = { pr: null, verdict: "VERIFIED" as const, notProven: [], flaky: [], cost: { usd: 0.1, provider: "claude", tokens: 1000 } };
    const timeOf = (wallS: number, stages: { label: string; seconds: number }[]): string => formatSummary({ ...base, wallS, stages } as never).split("\n").at(-1) as string;
    expect(timeOf(100, [{ label: "a", seconds: 10 }, { label: "b", seconds: 70 }, { label: "c", seconds: 20 }])).toBe("Time:       1m40s (a 10s, b 1m10s, c 20s; slowest: b 70%)");
    expect(timeOf(100, [])).toBe("Time:       1m40s ()");
    expect(timeOf(0, [{ label: "a", seconds: 10 }])).not.toContain("slowest");
    expect(timeOf(100, [{ label: "a", seconds: Number.NaN }])).not.toContain("slowest");
  });

  test("firstSealed marks the Time line only when literally true (TEN-UX-11)", () => {
    const base = { pr: null, verdict: "VERIFIED" as const, notProven: [], flaky: [], cost: { usd: 0.1, provider: "claude", tokens: 1000 }, wallS: 60, stages: [{ label: "intake", seconds: 5 }] };
    const timeOf = (extra: object): string => formatSummary({ ...base, ...extra } as never).split("\n").at(-1) as string;
    const plain = "Time:       1m00s (intake 5s; slowest: intake 8%)";
    expect(timeOf({})).toBe(plain);
    expect(timeOf({ firstSealed: false })).toBe(plain);
    expect(timeOf({ firstSealed: "false" })).toBe(plain);
    expect(timeOf({ firstSealed: true })).toBe(plain + " - first sealed PR in this repo");
    expect(formatSummary({ ...base, firstSealed: true }).split("\n")).toHaveLength(formatSummary(base).split("\n").length);
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
    expect(row("PARTIAL", false, null)).toEqual(["PARTIAL", 1]); // FC-21 (d): the Outcome line is the receipt verdict
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
  test("FC-LINT-PRE-RED: a check excused as failing on base is not the reason", () => {
    const v = (pre: string[]) => ev("stage.completed", "verify", { checks: [{ name: "lint:shellcheck", result: "fail" }, { name: "bun:x", result: "fail", first_error: "boom" }], pre_red_checks: pre });
    expect(reasonOf([v(["lint:shellcheck"])], false, null, "PARTIAL")).toBe("bun:x failed: boom");
    expect(reasonOf([v([])], false, null, "PARTIAL")).toBe("lint:shellcheck failed");
  });
  test("failing check reason names the file:line anchor", () => {
    expect(reasonOf([vfy([{ name: "bun:x", result: "fail", first_error: "boom", anchor: "src/a.ts:42" }])], false, null, "PARTIAL")).toBe("bun:x failed: boom (at src/a.ts:42)");
  });
  test("success has no reason", () => expect(reasonOf([], false, null, "VERIFIED")).toBeUndefined());
  test("tamper wins over everything", () => expect(reasonOf([ev("stage.failed", "verify", { reason: "x" })], true, "stalled", "FAILED")).toBe("event log modified outside the engine"));
  test("fatal stops are named", () => {
    expect(reasonOf([ev("stage.failed", "implement", { reason: "exit 1 (general error)" })], false, "fatal:quota_exhausted", "FAILED")).toBe("provider credit exhausted");
    expect(reasonOf([], false, "fatal:auth", "FAILED")).toBe("provider authentication failed");
  });
  test("FC-AUTH-CAUSE-ONLY-IN-IMPL-LOG: a fatal auth stop names the provider's cause", () => {
    const e = [ev("session.ended", "implement", { exit: "error", cause: "exit 1 (general error)", provider_error: "Invalid API key \u00b7 Fix external API key" })];
    expect(reasonOf(e, false, "fatal:auth", "FAILED")).toBe("provider authentication failed: Invalid API key \u00b7 Fix external API key");
  });
  test("BLOCKED prints the conflict, not the empty diff", () => {
    const e = [ev("stage.completed", "implement", { spec_conflict_reason: "spec says A and B" }), ev("stage.failed", "verify", { reason: "empty diff without an already_done marker" })];
    expect(reasonOf(e, false, null, "BLOCKED")).toBe("spec conflict: spec says A and B");
  });
  test("a long reason is clipped at a word with a marker, never mid-word", () => {
    const why = "Wall test tests/loki_wall_gitlab_slack.test.ts passes only if CHANGELOG.md/README.md claim GitLab support for Slack, but that integration is server-side and not in this repo, and the plan says to leave the tree unchanged apart from the two plan files";
    const r = reasonOf([ev("stage.completed", "implement", { spec_conflict_reason: why })], false, null, "BLOCKED")!;
    expect(r.length).toBeLessThanOrEqual(200);
    expect(r.endsWith("...")).toBe(true);
    expect(`spec conflict: ${why}`.startsWith(r.slice(0, -3))).toBe(true);
    expect(`spec conflict: ${why}`.charAt(r.length - 3)).toBe(" ");
    expect(clipWords("abcdef", 2)).toBe("ab");
  });
  test("stalled", () => expect(reasonOf([vfy([{ name: "t", result: "fail" }])], false, "stalled", "STALLED")).toBe("stalled: same failure 3 times"));
  test("a red suite names the failing check and first_error", () => expect(reasonOf([vfy([{ name: "bun:calc.test.ts", result: "fail", first_error: "expected 6 got 5" }])], false, null, "FAILED")).toBe("bun:calc.test.ts failed: expected 6 got 5"));
  test("secrets in first_error are redacted before printing", () => {
    const t = "ghp_" + "a".repeat(36), k = "sk-" + "b".repeat(30);
    const r = reasonOf([vfy([{ name: "t", result: "fail", first_error: `auth ${t} and ${k} bad` }])], false, null, "FAILED") ?? "";
    expect(r).not.toContain(t);
    expect(r).not.toContain(k);
    expect(r).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(r).toContain("[REDACTED:OPENAI_KEY]");
  });
  test("first stage.failed reason", () => expect(reasonOf([ev("stage.failed", "verify", { reason: "empty diff" })], false, null, "FAILED")).toBe("empty diff"));
  test("cap hit before any stage", () => expect(reasonOf([ev("cap.hit", null)], false, null, "BUDGET_STOP")).toBe("cost/time cap reached"));
  test("a crashed worker (no receipt.sealed) still gets a reason", () => expect(reasonOf([], false, null, "FAILED")).toBe("engine ended before sealing a receipt"));
  test("an unsealed run never prints an empty NOT PROVEN", () => {
    const base = { pr: null, verdict: "FAILED", notProven: [], flaky: [], cost: { usd: null, provider: "claude", tokens: null }, wallS: 1, stages: [] };
    expect(formatSummary({ ...base, receipt: { sha: null, signed: null } } as never)).toContain("NOT PROVEN: everything (no receipt sealed)");
  });
  test("a multi-line NOT PROVEN item (raw push stderr) stays on one line", () => {
    const base = { pr: null, verdict: "SPEC_CONFLICT", flaky: [], cost: { usd: null, provider: "claude", tokens: null }, wallS: 1, stages: [], receipt: { sha: "ab", signed: true } };
    const out = formatSummary({ ...base, notProven: ["full suite", "PR not opened: x failed:\nremote: Permission to a/b.git denied to u.\nfatal: 403"] } as never);
    const line = out.split("\n").find((l) => l.startsWith("NOT PROVEN:"))!;
    expect(line).toBe("NOT PROVEN: full suite, PR not opened: x failed: remote: Permission to a/b.git denied to u. fatal: 403");
    expect(out.split("\n").some((l) => l.startsWith("fatal:"))).toBe(false);
  });
  test("no tests to run", () => expect(reasonOf([vfy([])], false, null, "FAILED")).toBe("no tests to run"));
  test("control characters are stripped and the length capped", () => {
    const r = reasonOf([ev("stage.failed", "verify", { reason: `a\x1b[31m\nb${"x".repeat(300)}` })], false, null, "FAILED")!;
    expect(r).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(r.length).toBe(200);
  });
});

// FC-OUTCOME-FLOOD: per-item lists collapse on every display surface; receipt.json keeps the full list.
import { collapseNotProven } from "../../src/util/term_width.ts";
const floodFixture = (n = 150): string[] => Array.from({ length: n }, (_, i) => `has gray background ${i}`).flatMap((t, i) => [`pre red: ${t}`, `pre red: src/app/p${i % 7}/__tests__/page.test.tsx > Page > Styling > ${t}`]);
describe("collapseNotProven (FC-OUTCOME-FLOOD)", () => {
  test("150 short plus full-name pre-red entries become one line with the deduplicated count", () => {
    const out = collapseNotProven(["diff not computed", ...floodFixture(), "baseline: 150 pre-existing failing check(s) (not blocking), 0 introduced"]);
    expect(out).toEqual(["diff not computed", "pre red: 150 tests already failing on base (listed in receipt.json)", "baseline: 150 pre-existing failing check(s) (not blocking), 0 introduced"]);
  });
  test("a short-name-only list counts once per test; a few stay listed", () => {
    expect(collapseNotProven(floodFixture(40).filter((l) => !l.includes(" > ")))).toEqual(["pre red: 40 tests already failing on base (listed in receipt.json)"]);
    expect(collapseNotProven(["pre red: a", "pre red: x.test.ts > S > a", "pre red: b"])).toEqual(["pre red: x.test.ts > S > a", "pre red: b"]);
  });
  test("other per-item lists collapse past a cap and the pass is idempotent", () => {
    const many = Array.from({ length: 30 }, (_, i) => `not run: check ${i}`), flaky = Array.from({ length: 30 }, (_, i) => `flaky test: t${i}`);
    const once = collapseNotProven([...many, ...flaky, ...floodFixture(20)]);
    expect(once).toEqual(["not run: 30 entries (listed in receipt.json)", "flaky test: 30 entries (listed in receipt.json)", "pre red: 20 tests already failing on base (listed in receipt.json)"]);
    expect(collapseNotProven(once)).toEqual(once);
    expect(collapseNotProven(["not run: a", "not run: b"])).toEqual(["not run: a", "not run: b"]);
  });
  test("terminal NOT PROVEN line is one short line, not 300 entries", () => {
    const base = { pr: null, verdict: "PARTIAL", flaky: [], wallS: 60, stages: [], cost: { usd: 1, provider: "claude", tokens: 1000 } };
    const out = formatSummary({ ...base, notProven: floodFixture() } as never);
    expect(out).toContain("pre red: 150 tests already failing on base (listed in receipt.json)");
    expect(out).not.toContain("has gray background");
    expect(out.length).toBeLessThan(1500);
    expect(formatSummary({ ...base, notProven: [], flaky: Array.from({ length: 40 }, (_, i) => `f${i}`) } as never)).toContain("flaky 40 tests (listed in receipt.json)");
  });
});

describe("summary cost of a CLI-invoker (unmetered) run", () => {
  const cost = (seq: number, data: Record<string, unknown>): EventEnvelope => ({ v: 1, seq, ts: "2026-01-01T00:00:00Z", run: "r", type: "cost", stage: "implement", data });
  const render = (events: EventEnvelope[]): string => {
    const { usd, pc } = summaryCost(events, false);
    return formatSummary({ pr: null, verdict: "VERIFIED", notProven: [], flaky: [], wallS: 10, stages: [],
      cost: { usd, provider: "claude", tokens: 0, note: usd === null ? "CLI invoker records no cost" : null, partialUsd: pc.usd, measuredSessions: pc.measured, totalSessions: pc.total } } as never);
  };
  test("every cost event unmetered prints not measured, never $0.00", () => {
    const out = render([cost(1, { usd: 0, source: "cli-invoker-unmetered" }), cost(2, { usd: 0, source: "cli-invoker-unmetered" })]);
    expect(out).toContain("Cost:       not measured (CLI invoker records no cost)");
    expect(out).not.toContain("$0.00");
    expect(out).not.toContain("partial");
  });
  test("a metered run still prints its dollar figure", () => {
    const out = render([cost(1, { usd: 0.3, input_tokens: 500 }), cost(2, { usd: 0.2, input_tokens: 500 })]);
    expect(out).toContain("Cost:       $0.50");
  });
  test("a measured zero is still $0.00", () => {
    expect(render([cost(1, { usd: 0, input_tokens: 10 })])).toContain("Cost:       $0.00");
  });
});

describe("summaryCache", () => {
  const ev = (data: Record<string, unknown>) => ({ type: "cost", data }) as never;
  test("cache saved: derived from cost events, null when a session lacks the key or the log is tampered", async () => {
    const { summaryCache } = await import("../../src/engine10/supervisor.ts");
    expect(summaryCache([ev({ model: "sonnet", cache_read_tokens: 1_000_000 })], false)).toEqual({ cacheReadTokens: 1_000_000, cacheSavedUsd: 1.9 });
    expect(summaryCache([ev({ model: "sonnet", cache_read_tokens: 5 }), ev({ model: "sonnet" })], false)).toEqual({ cacheReadTokens: null, cacheSavedUsd: null });
    expect(summaryCache([ev({ model: "sonnet", cache_read_tokens: 5 })], true).cacheSavedUsd).toBeNull();
  });
});

describe("formatTierSeal and the Tier summary line (GAME10-09b)", () => {
  const c = (verified: number, total: number) => ({ verified, partial: 0, failed: total - verified, other: 0, unsealed: 0, total });
  const base = { pr: null, verdict: "VERIFIED", notProven: [], flaky: [], wallS: 60, stages: [], cost: { usd: 0.84, provider: "claude", tokens: 1000 } };
  test("renders the sealed tier, the avoided cost and both parity counts from the record", () => {
    const t = { tier: "haiku", topTierCostAvoidedUsd: 1.5, record: { haiku: c(23, 24), opus: c(24, 24) } };
    expect(formatTierSeal(t)).toBe("haiku tier sealed; top-tier cost avoided $1.50; parity here: haiku sealed 23 of 24, opus sealed 24 of 24");
    expect(formatSummary({ ...base, tier: t } as never)).toContain("Tier:       haiku tier sealed;");
  });
  test("a missing record, cost or tier reads not measured, never 0", () => {
    expect(formatTierSeal({ tier: "haiku", record: null })).toBe("haiku tier sealed; top-tier cost avoided not measured; parity here: haiku not measured, opus not measured");
    expect(formatTierSeal({ tier: "haiku", topTierCostAvoidedUsd: -1, record: { haiku: c(0, 0) } })).toContain("avoided not measured");
    expect(formatTierSeal({})).toBe("sealed tier not measured; top-tier cost avoided not measured; parity here: not measured, opus not measured");
  });
  test("a prototype-named tier is a plain missing key, and no tier input leaves the summary unchanged", () => {
    expect(formatTierSeal({ tier: "constructor", record: {} })).toContain("constructor not measured");
    expect(formatSummary(base as never)).not.toContain("Tier:");
    expect(formatSummary({ ...base, verdict: "FAILED", tier: { tier: "haiku" } } as never)).not.toContain("Tier:");
  });
});

describe("stage lines carry the run spend so far", () => {
  const cost = (stage: string, usd: number, source = "provider") => ({ v: 1, seq: 0, ts: "t", run: "r", type: "cost", stage, data: { usd, source, input_tokens: 10, output_tokens: 5, session_id: `s-${stage}` } }) as unknown as EventEnvelope;
  const line = (name: string, evs: EventEnvelope[]) => formatStageLine({ clockS: 1, name, status: "done", durationS: 2, detail: "ok", spend: spendSoFar(evs) });
  test("figures are cumulative across stages and the last one equals the summary Cost", () => {
    const evs: EventEnvelope[] = [];
    const lines: string[] = [];
    for (const [stage, usd] of [["plan", 0.01], ["implement", 0.02], ["verify", 0.01]] as const) { evs.push(cost(stage, usd)); lines.push(line(stage, evs)); }
    expect(lines[0]).toContain("($0.01 so far)");
    expect(lines[1]).toContain("($0.03 so far)");
    expect(lines[2]).toContain("($0.04 so far)");
    const sc = summaryCost(evs, false);
    expect(formatSummary({ pr: null, verdict: "VERIFIED", notProven: [], flaky: [], wallS: 1, stages: [], cost: { usd: sc.usd, provider: "claude", tokens: 15 } } as never)).toContain("Cost:       $0.04 ");
  });
  test("an unmetered run prints no dollar figure on any stage line", () => {
    const evs = [cost("plan", 0, "cli-invoker-unmetered")];
    expect(line("plan", evs)).toContain("(spend not measured)");
    expect(line("plan", evs)).not.toContain("$");
    expect(line("intake", [])).not.toContain("$");
  });
  test("a partially priced run labels the figure partial", () => {
    const evs = [cost("plan", 0.02), cost("fix", null as unknown as number)];
    expect(line("fix", evs)).toContain("(partial: $0.02 so far)");
  });
});
