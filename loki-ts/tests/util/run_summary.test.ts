// HANDOFF: render from fixture state. Unmeasured spend is never $0.00; a skipped check is never "passed".
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeHandoff, decisionCommands, renderHandoff, handoffSection, spendText, writeHandoff, type HandoffFacts, type HandoffInput } from "../../src/util/run_summary.ts";
import type { EventEnvelope } from "../../src/engine10/types.ts";

const base: HandoffInput = {
  task: "add retry to fetch", outcome: "VERIFIED", runId: "e10-1", checks: [{ name: "t", cmd: "pytest -q", result: "pass" }], notProven: [], failures: [],
  filesChanged: 2, insertions: 10, deletions: 1, hunks: [{ file: "a.py", line: 3, added: 9, removed: 1, summary: "def retry" }], usd: 0.42, elapsedS: 75, interventions: null,
};
const ev = (type: string, stage: string | undefined, data: Record<string, unknown>): EventEnvelope => ({ type, stage, data, ts: "2026-01-01T00:00:00Z" } as unknown as EventEnvelope);

test("success: label verbatim, measured spend, commands, about 30 lines", () => {
  const md = renderHandoff({ ...base, prUrl: "https://github.com/o/r/pull/9" });
  expect(md).toContain("# Review handoff: VERIFIED");
  expect(md).toContain("spend $0.42 (measured)");
  expect(md).toContain("PASSED: pytest -q");
  expect(md).toContain("gh pr close https://github.com/o/r/pull/9");
  expect(md.trimEnd().split("\n").length).toBeLessThanOrEqual(32);
});

test("failure: failed check and stage failure are listed, never as passed", () => {
  const md = renderHandoff({ ...base, outcome: "FAILED", reason: "pytest failed", checks: [{ name: "t", cmd: "pytest -q", result: "fail" }], failures: ["verify failed: boom"], usd: null });
  expect(md).toContain("FAILED: pytest -q");
  expect(md).toContain("verify failed: boom");
  expect(md).not.toContain("PASSED");
  expect(md).toContain("nothing demonstrated");
});

test("partial checks: skipped, not_run and flaky are NOT CHECKED, never passed; uncovered requirements surface", () => {
  const md = renderHandoff({ ...base, checks: [{ name: "a", cmd: "unit", result: "pass" }, { name: "b", cmd: "e2e", result: "not_run", reason: "no browser" }, { name: "c", cmd: "slow", result: "flaky" }], requirements: [{ id: "R1", text: "handles 429", status: "uncovered" }, { id: "R2", text: "ok", status: "covered" }], notProven: ["perf"] });
  expect(md).toContain("PASSED: unit");
  expect(md).not.toContain("PASSED: e2e");
  expect(md).not.toContain("PASSED: slow");
  expect(md).toContain("NOT RUN: e2e");
  expect(md).toContain("FLAKY (not counted as passed): slow");
  expect(md).toContain("UNCOVERED requirement: handles 429");
  expect(md).not.toContain("UNCOVERED requirement: ok");
  expect(md).toContain("NOT PROVEN: perf");
});

test("spend: retry dollars append only when positive", () => {
  expect(spendText({ usd: 1.5, retryUsd: 0.4 })).toBe("$1.50 (measured) ($0.40 on retries)");
  for (const r of [0, null, undefined, -1, NaN]) expect(spendText({ usd: 1.5, retryUsd: r as number | null | undefined })).toBe("$1.50 (measured)");
  expect(spendText({ usd: null, retryUsd: 0.4 })).toBe("not measured");
  const f: HandoffFacts = { repoDir: ".", runId: "r", events: [], outcome: "VERIFIED", usd: 1.5, retryUsd: 0.4, elapsedS: 5, notProven: [], task: "t", requirements: null };
  expect(renderHandoff(composeHandoff(f))).toContain("spend $1.50 (measured) ($0.40 on retries);");
  expect(renderHandoff(composeHandoff({ ...f, retryUsd: 0 }))).not.toContain("on retries");
});

test("spend: unmeasured never renders as $0.00", () => {
  expect(spendText({ usd: null })).toBe("not measured");
  expect(spendText({ usd: null, partialUsd: 0.1, measuredSessions: 1, totalSessions: 3 })).toContain("partial: $0.10 for 1 of 3");
  expect(renderHandoff({ ...base, usd: null })).not.toContain("$0.00");
  expect(renderHandoff({ ...base, usd: null })).toContain("spend not measured");
});

test("empty state: no checks says nothing is verified; commands fall back to loki undo", () => {
  const md = renderHandoff({ ...base, checks: [], hunks: [], filesChanged: null, riskTier: null, elapsedS: null });
  expect(md).toContain("no checks were recorded, so nothing is verified");
  expect(md).toContain("diff unavailable");
  expect(md).toContain("risk tier: not recorded");
  expect(md).toContain("elapsed not measured");
  expect(decisionCommands({ outcome: "X" }).reject).toBe("loki undo");
  expect(decisionCommands({ outcome: "X", branch: "loki/e10-1" }).accept).toBe("git merge --no-ff loki/e10-1");
});

test("F1: stale requirements-map.json never leaks; the in-memory map wins; F2: risk tier and deferred checks come from risk-tier.json", () => {
  const repo = mkdtempSync(join(tmpdir(), "loki-handoff-"));
  try {
    mkdirSync(join(repo, ".loki", "state"), { recursive: true });
    writeFileSync(join(repo, ".loki", "state", "requirements-map.json"), JSON.stringify({ version: 1, requirements: [{ id: "R1", text: "OLD PRD: export CSV of invoices", status: "uncovered", checks: [], method: "m" }] }));
    writeFileSync(join(repo, ".loki", "state", "risk-tier.json"), JSON.stringify({ version: 1, tier: "high", summary: "risk high", checks_deferred: ["mutation"] }));
    const f: HandoffFacts = { repoDir: repo, runId: "e10-2", events: [], outcome: "VERIFIED", usd: null, elapsedS: 5, notProven: [], task: "t", requirements: null };
    const md = writeHandoff(f) ?? "";
    expect(md).not.toContain("OLD PRD");
    expect(md).not.toContain("UNCOVERED");
    expect(md).toContain("risk tier: high");
    expect(md).toContain("NOT RUN (deferred by risk tier): mutation");
    const pr = handoffSection({ ...f, requirements: [{ id: "R9", text: "this run", status: "uncovered" }] });
    expect(pr).toContain("UNCOVERED requirement: this run");
    expect(pr).not.toContain("OLD PRD");
    expect(composeHandoff({ ...f, sinceMs: Date.now() + 60_000 }).riskTier).toBeNull();
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("compose + write from events, missing files tolerated, requirements-map read when present", () => {
  const repo = mkdtempSync(join(tmpdir(), "loki-handoff-"));
  try {
    const events = [ev("run.started", undefined, { branch: "loki/e10-1" }), ev("stage.completed", "verify", { checks: [{ name: "x", cmd: "bun test", result: "pass" }, { name: "y", cmd: "lint", result: "not_run" }] }), ev("stage.failed", "wall", { reason: "timeout" })];
    const f: HandoffFacts = { repoDir: repo, runId: "e10-1", events, outcome: "PARTIAL", usd: null, elapsedS: 5, notProven: [], task: "t" };
    const h = composeHandoff(f);
    expect(h.requirements).toBeNull();
    expect(h.failures).toEqual(["wall failed: timeout"]);
    mkdirSync(join(repo, ".loki", "state"), { recursive: true });
    writeFileSync(join(repo, ".loki", "state", "requirements-map.json"), JSON.stringify({ version: 1, requirements: [{ id: "R1", text: "needs auth", status: "uncovered", checks: [], method: "m" }] }));
    const md = writeHandoff(f) ?? "";
    expect(md).toContain("UNCOVERED requirement: needs auth");
    expect(md).toContain("NOT RUN: lint");
    expect(readFileSync(join(repo, ".loki", "review", "HANDOFF.md"), "utf8")).toBe(md);
    const j = JSON.parse(readFileSync(join(repo, ".loki", "review", "handoff.json"), "utf8"));
    expect(j.outcome).toBe("PARTIAL");
    expect(j.spend).toBe("not measured");
    expect(existsSync(join(repo, ".loki", "review", "HANDOFF.md.tmp"))).toBe(false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("FV-3: interventions come from state/interventions.json by type with waited time; absent file stays not recorded; count 0 stays 0", () => {
  const repo = mkdtempSync(join(tmpdir(), "loki-handoff-"));
  try {
    const f: HandoffFacts = { repoDir: repo, runId: "e10-9", events: [], outcome: "VERIFIED", usd: null, elapsedS: 5, notProven: [], task: "t", requirements: null };
    expect(renderHandoff(composeHandoff(f))).toContain("interventions not recorded");
    mkdirSync(join(repo, ".loki", "state"), { recursive: true });
    const iv = join(repo, ".loki", "state", "interventions.json");
    writeFileSync(iv, JSON.stringify({ count: 2, basis: "x", by_type: { steer: 0, input: 1, authorization: 1, repair: 0 }, waited_s: 240 }));
    const md = renderHandoff(composeHandoff(f));
    expect(md).toContain("interventions 2 (input 1, authorization 1); waited 4m");
    expect(handoffSection(f)).toContain("interventions 2 (input 1, authorization 1); waited 4m");
    writeFileSync(iv, JSON.stringify({ count: 1, basis: "x" }));
    expect(renderHandoff(composeHandoff(f))).toContain("interventions 1\n");
    writeFileSync(iv, JSON.stringify({ count: 0, by_type: { steer: 0, input: 0, authorization: 0, repair: 0 }, waited_s: 0 }));
    expect(renderHandoff(composeHandoff(f))).toContain("interventions 0");
    expect(composeHandoff({ ...f, sinceMs: Date.now() + 60_000 }).interventions).toBeNull();
    const withEvents = composeHandoff({ ...f, events: [ev("intervention", undefined, {})] });
    expect(withEvents.interventions).toBe(1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("FV-pr-loop-4: a blocked merge shows the gate and waiting at, never merged; merged and absent states read plainly", () => {
  const repo = mkdtempSync(join(tmpdir(), "loki-handoff-"));
  try {
    const f: HandoffFacts = { repoDir: repo, runId: "e10-10", events: [], outcome: "VERIFIED", usd: null, elapsedS: 5, notProven: [], task: "t", requirements: null, prUrl: "https://github.com/o/r/pull/7" };
    expect(renderHandoff(composeHandoff(f))).toContain("Merge: not recorded");
    mkdirSync(join(repo, ".loki", "state"), { recursive: true });
    const pj = join(repo, ".loki", "state", "pr.json");
    writeFileSync(pj, JSON.stringify({ state: "created", url: "u", merge: { outcome: "blocked:required_checks", checks: "2 of 3 passing" } }));
    const md = renderHandoff(composeHandoff(f));
    expect(md).toContain("Merge: waiting at: required_checks (checks: 2 of 3 passing)");
    expect(md).not.toContain("Merge: merged");
    expect(handoffSection(f)).toContain("waiting at: required_checks");
    writeFileSync(pj, JSON.stringify({ state: "created", merge: { outcome: "waiting", gate: "human_review" } }));
    expect(renderHandoff(composeHandoff(f))).toContain("Merge: waiting at: human_review");
    writeFileSync(pj, JSON.stringify({ state: "created", merge: { outcome: "merged", checks: "all passing" } }));
    expect(renderHandoff(composeHandoff(f))).toContain("Merge: merged (checks: all passing)");
    writeFileSync(pj, JSON.stringify({ state: "created", merge: { outcome: "bogus" } }));
    expect(renderHandoff(composeHandoff(f))).toContain("Merge: not recorded");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// TEN-UX-02: failure-specific Next line. Reason literals are copied from engine10/output.ts reasonOf.
import { nextOf } from "../../src/util/run_summary.ts";
const NEXT_ROWS: [string, "failed" | "stopped", number | null, string][] = [
  ["provider authentication failed", "failed", 2, "claude login"],
  ["provider credit exhausted", "failed", null, "check provider billing, or loki start --provider <other>"],
  ["pytest failed: 2 errors", "failed", null, "loki chat --attach (ask why)"],
  ["pytest failed: 2 errors", "failed", 3, "loki chat --attach (ask why); loki undo to revert"],
  ["spec conflict: R1 vs R2", "stopped", 1, 'loki answer --text "<your decision>"'],
  ["stalled: same failure 3 times", "stopped", 1, "loki chat --attach"],
  ["engine ended before sealing a receipt", "failed", 1, "loki doctor"],
];
test.each(NEXT_ROWS)("nextOf %s (%s, files %p)", (reason, result, files, want) => { expect(nextOf(result, files, reason)).toBe(want); });
test("nextOf auth failure names the active provider, not claude", () => {
  expect(nextOf("failed", 2, "provider authentication failed", "codex")).toBe("re-authenticate codex, then loki doctor");
  expect(nextOf("failed", 2, "provider authentication failed", "claude")).toBe("claude login");
  expect(nextOf("failed", 2, "provider authentication failed")).toBe("claude login");
});
test("nextOf default outputs do not drift", () => {
  expect(nextOf("verified", 2)).toBe("loki diff");
  expect(nextOf("verified", 0)).toBe("loki status");
  expect(nextOf("done-unverified", 1, "x failed: y")).toBe("loki verify");
  expect(nextOf("stopped", 1)).toBe("loki status");
  expect(nextOf("failed", 1)).toBe("loki undo");
  expect(nextOf("failed", null)).toBe("loki doctor");
  expect(nextOf("failed", 1, "cost/time cap reached")).toBe("loki undo");
});
test("every reason literal in output.ts reasonOf has a nextOf mapping row", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/engine10/output.ts"), "utf8").split("\n").find((l) => l.includes("const r = EXIT[outcome] === 0"))!;
  const lits = [...src.matchAll(/"((?:provider|engine ended|stalled)[^"]*)"|`(spec conflict)|\$\{bad\.name\}( failed)/g)].map((m) => m[1] ?? m[2] ?? "<check> failed");
  expect(lits.length).toBeGreaterThanOrEqual(5);
  const rowFor = (l: string): boolean => NEXT_ROWS.some(([r]) => r === l || r.startsWith(l) || (l === "<check> failed" && / failed: /.test(r)));
  for (const l of lits) expect(rowFor(l), `no nextOf row for reason: ${l}`).toBe(true);
});
