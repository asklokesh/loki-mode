// Tests for stats command port. See src/commands/stats.ts and the
// fixture under tests/fixtures/stats/.loki.
//
// Hermetic: each test sets LOKI_DIR to a fixture path or a tmpdir; nothing
// reads the real ~/.loki or repo .loki.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { computeStats } from "../../src/commands/stats.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "stats", ".loki");

let savedLokiDir: string | undefined;

beforeEach(() => {
  savedLokiDir = process.env["LOKI_DIR"];
});

afterEach(() => {
  if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = savedLokiDir;
});

describe("stats: missing .loki directory", () => {
  it("returns friendly text message when no session exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-stats-"));
    try {
      process.env["LOKI_DIR"] = join(dir, "nonexistent");
      const r = computeStats([]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("No active session found.");
      expect(r.stdout).toContain("loki start <prd>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns JSON error when --json and no session", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-stats-"));
    try {
      process.env["LOKI_DIR"] = join(dir, "nonexistent");
      const r = computeStats(["--json"]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ error: "No active session" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stats: text mode against fixture", () => {
  beforeEach(() => {
    process.env["LOKI_DIR"] = FIXTURE;
  });

  it("renders the standard report", () => {
    const r = computeStats([]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout;
    expect(out).toContain("Loki Mode Session Statistics");
    expect(out).toContain("Iterations completed: 3");
    expect(out).toContain("Current phase: implementation");
    // Token totals (1500+2500+4000=8000 input, 500+800+1200=2500 output)
    expect(out).toContain("Input tokens:  8,000");
    expect(out).toContain("Output tokens: 2,500");
    expect(out).toContain("Total tokens:  10,500");
    expect(out).toContain("Estimated cost: $0.40");
    // Quality gates: 3 of 4 passed (lint, tests, security; coverage failed)
    expect(out).toContain("Gates passed: 3/4 (75%)");
    // Reviews: 3 total, 2 approved, 1 revision
    expect(out).toContain("Code reviews: 3 (2 approved, 1 revision requested)");
    expect(out).toContain("Gate failures: coverage (2)");
    // Duration: 45+75+3720 = 3840s = 1h 04m
    expect(out).toContain("Duration: 1h 04m");
    // Budget
    expect(out).toContain("Used: $0.40 / $10.00 (4.0%)");
  });

  it("includes per-iteration breakdown with --efficiency", () => {
    const r = computeStats(["--efficiency"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Per-Iteration Breakdown");
    expect(r.stdout).toContain("#1");
    expect(r.stdout).toContain("#2");
    expect(r.stdout).toContain("#3");
    expect(r.stdout).toContain("input: 1,500");
    expect(r.stdout).toContain("input: 4,000");
  });

  it("does not show breakdown without --efficiency", () => {
    const r = computeStats([]);
    expect(r.stdout).not.toContain("Per-Iteration Breakdown");
  });
});

describe("stats: JSON mode against fixture", () => {
  beforeEach(() => {
    process.env["LOKI_DIR"] = FIXTURE;
  });

  it("emits the documented JSON shape", () => {
    const r = computeStats(["--json"]);
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.session).toEqual({
      iterations: 3,
      duration_seconds: 3840,
      phase: "implementation",
    });
    expect(j.tokens).toEqual({
      input: 8000,
      output: 2500,
      total: 10500,
      cost_usd: 0.4,
    });
    expect(j.quality.gates_passed).toBe(3);
    expect(j.quality.gates_total).toBe(4);
    expect(j.quality.reviews_total).toBe(3);
    expect(j.quality.reviews_approved).toBe(2);
    expect(j.quality.reviews_revision).toBe(1);
    expect(j.quality.gate_failures).toEqual({ coverage: 2, lint: 0 });
    expect(j.efficiency.avg_tokens_per_iteration).toBe(3500);
    expect(j.efficiency.avg_cost_per_iteration).toBe(0.13);
    expect(j.efficiency.avg_duration_per_iteration).toBe(1280);
    expect(j.budget).toEqual({ used: 0.4, limit: 10, percent: 4 });
    // No iterations field without --efficiency
    expect(j.iterations).toBeUndefined();
  });

  it("includes iterations array with --json --efficiency", () => {
    const r = computeStats(["--json", "--efficiency"]);
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(Array.isArray(j.iterations)).toBe(true);
    expect(j.iterations).toHaveLength(3);
    expect(j.iterations[0]).toEqual({
      number: 1,
      input_tokens: 1500,
      output_tokens: 500,
      cost_usd: 0.05,
      duration_seconds: 45,
    });
    expect(j.iterations[2].number).toBe(3);
    expect(j.iterations[2].duration_seconds).toBe(3720);
  });
});

describe("stats: empty .loki and missing files", () => {
  it("handles empty .loki directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-stats-"));
    try {
      const loki = join(dir, ".loki");
      mkdirSync(loki);
      process.env["LOKI_DIR"] = loki;
      const r = computeStats([]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Iterations completed: 0");
      expect(r.stdout).toContain("Current phase: N/A");
      expect(r.stdout).toContain("N/A (no iteration metrics found)");
      expect(r.stdout).toContain("Gates passed: N/A");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles empty .loki in JSON mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-stats-"));
    try {
      const loki = join(dir, ".loki");
      mkdirSync(loki);
      process.env["LOKI_DIR"] = loki;
      const r = computeStats(["--json"]);
      expect(r.exitCode).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.session.iterations).toBe(0);
      expect(j.session.phase).toBe("N/A");
      expect(j.tokens.total).toBe(0);
      expect(j.efficiency.avg_tokens_per_iteration).toBe(0);
      expect(j.budget.percent).toBe(0);
      expect(j.quality.gate_failures).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores corrupt JSON files gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-stats-"));
    try {
      const loki = join(dir, ".loki");
      mkdirSync(join(loki, "state"), { recursive: true });
      mkdirSync(join(loki, "metrics", "efficiency"), { recursive: true });
      writeFileSync(join(loki, "state", "orchestrator.json"), "not json {{{");
      writeFileSync(
        join(loki, "metrics", "efficiency", "iteration-001.json"),
        "garbage",
      );
      // One valid iteration so we still exercise aggregation
      writeFileSync(
        join(loki, "metrics", "efficiency", "iteration-002.json"),
        JSON.stringify({ input_tokens: 100, output_tokens: 50, cost_usd: 0.01, duration_seconds: 10 }),
      );
      process.env["LOKI_DIR"] = loki;
      const r = computeStats(["--json"]);
      expect(r.exitCode).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.tokens.total).toBe(150);
      expect(j.session.iterations).toBe(1);
      expect(j.session.phase).toBe("N/A");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stats: glob handling for iteration files", () => {
  it("only picks up iteration-*.json (not other files)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-stats-"));
    try {
      const loki = join(dir, ".loki");
      const eff = join(loki, "metrics", "efficiency");
      mkdirSync(eff, { recursive: true });
      writeFileSync(
        join(eff, "iteration-001.json"),
        JSON.stringify({ input_tokens: 10, output_tokens: 5, cost_usd: 0.01, duration_seconds: 1 }),
      );
      writeFileSync(
        join(eff, "iteration-002.json"),
        JSON.stringify({ input_tokens: 20, output_tokens: 10, cost_usd: 0.02, duration_seconds: 2 }),
      );
      // These should be ignored
      writeFileSync(join(eff, "summary.json"), JSON.stringify({ input_tokens: 99999 }));
      writeFileSync(join(eff, "iteration-003.txt"), "not json");
      writeFileSync(join(eff, "iter-004.json"), JSON.stringify({ input_tokens: 88888 }));
      process.env["LOKI_DIR"] = loki;
      const r = computeStats(["--json"]);
      const j = JSON.parse(r.stdout);
      expect(j.tokens.input).toBe(30);
      expect(j.session.iterations).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sorts iteration files lexicographically", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-stats-"));
    try {
      const loki = join(dir, ".loki");
      const eff = join(loki, "metrics", "efficiency");
      mkdirSync(eff, { recursive: true });
      // Write out-of-order; sorted should give 001, 002, 010
      writeFileSync(
        join(eff, "iteration-010.json"),
        JSON.stringify({ input_tokens: 10, output_tokens: 0, cost_usd: 0, duration_seconds: 0 }),
      );
      writeFileSync(
        join(eff, "iteration-001.json"),
        JSON.stringify({ input_tokens: 1, output_tokens: 0, cost_usd: 0, duration_seconds: 0 }),
      );
      writeFileSync(
        join(eff, "iteration-002.json"),
        JSON.stringify({ input_tokens: 2, output_tokens: 0, cost_usd: 0, duration_seconds: 0 }),
      );
      process.env["LOKI_DIR"] = loki;
      const r = computeStats(["--json", "--efficiency"]);
      const j = JSON.parse(r.stdout);
      expect(j.iterations.map((i: { input_tokens: number }) => i.input_tokens)).toEqual([1, 2, 10]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stats: unknown flags are ignored (matches bash case *)", () => {
  it("does not error on unknown flag", () => {
    process.env["LOKI_DIR"] = FIXTURE;
    const r = computeStats(["--bogus", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});
