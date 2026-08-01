// Close the eval feedback loop: the run's own efficiency records must reach the
// next prompt.
//
// WHY THIS TEST EXISTS. .loki/metrics/efficiency/iteration-N.json has been
// written every iteration for the engine's entire life and read back only by a
// stop-only budget breaker and an offline `loki kpis` report. The agent
// PRODUCING the cost was the only party to the run with no visibility into it.
//
// The load-bearing assertion here is not "the block appears". It is
// noBareSpend(): the block must never report spend without the progress/rework
// split beside it. A block reporting cost and duration alone instructs the model
// to be CHEAP, and the cheapest iteration is the one that verifies less -- gate
// weakening through the front door, with no gate edited. That property is
// asserted, not left to convention.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPrompt } from "../../src/runner/build_prompt.ts";

function seedRun(records: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(resolve(tmpdir(), "loki-evaltrend-"));
  mkdirSync(resolve(dir, ".loki/metrics/efficiency"), { recursive: true });
  for (const r of records) {
    writeFileSync(
      resolve(dir, `.loki/metrics/efficiency/iteration-${String(r["iteration"])}.json`),
      JSON.stringify(r),
    );
  }
  return dir;
}

function emptyRun(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "loki-evaltrend-"));
  mkdirSync(resolve(dir, ".loki/metrics/efficiency"), { recursive: true });
  return dir;
}

async function prompt(cwd: string, env: Record<string, string> = {}): Promise<string> {
  return buildPrompt({
    prd: null,
    iteration: 4,
    retry: 0,
    ctx: { cwd, env: { ...env } },
  });
}

const RECORDS = [
  {
    iteration: 1,
    status: "completed",
    cost_usd: 0.2,
    duration_ms: 60000,
    input_tokens: 1000,
    cache_read_tokens: 9000,
  },
  {
    iteration: 2,
    status: "completed",
    cost_usd: 0.3,
    duration_ms: 90000,
    input_tokens: 2000,
    cache_read_tokens: 8000,
  },
  {
    iteration: 3,
    status: "failed",
    cost_usd: 0.5,
    duration_ms: 120000,
    input_tokens: 5000,
    cache_read_tokens: 5000,
  },
];

// The anti-incentive invariant. Any line quoting a dollar figure must be
// accompanied by outcome data somewhere in the block.
function noBareSpend(block: string): boolean {
  if (!/\$\d/.test(block)) return true;
  return /progress \d+\/\d+, rework \d+\/\d+/.test(block);
}

describe("efficiency trend injection", () => {
  it("surfaces the run's own efficiency trend into the prompt", async () => {
    const dir = seedRun(RECORDS);
    try {
      const out = await prompt(dir);
      expect(out).toContain("EFFICIENCY TREND");
      // Verbatim numbers, not just the header -- a header with wrong numbers is
      // worse than no header, because it steers on a lie.
      expect(out).toContain("iter 3: 120s, $0.50, cache 50%, failed");
      expect(out).toContain("iter 2: 90s, $0.30, cache 80%, completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never reports spend without the progress/rework split (anti-incentive guard)", async () => {
    const dir = seedRun(RECORDS);
    try {
      const out = await prompt(dir);
      const block = out.slice(out.indexOf("EFFICIENCY TREND"));
      const end = block.indexOf("</dynamic_context>");
      const rendered = end >= 0 ? block.slice(0, end) : block;
      expect(rendered).toMatch(/\$\d/); // spend IS reported
      expect(noBareSpend(rendered)).toBe(true);
      expect(rendered).toContain("progress 2/3, rework 1/3");
      // The actionable framing must steer toward fixing gates, not skipping them.
      expect(rendered).toContain("NEVER by verifying less");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("places the block AFTER [CACHE_BREAKPOINT] so it cannot bust the prompt cache", async () => {
    const dir = seedRun(RECORDS);
    try {
      const out = await prompt(dir);
      const bp = out.indexOf("[CACHE_BREAKPOINT]");
      const trend = out.indexOf("EFFICIENCY TREND");
      expect(bp).toBeGreaterThan(-1);
      expect(trend).toBeGreaterThan(bp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds NOTHING when metrics are absent or empty (no dangling header)", async () => {
    const empty = emptyRun();
    const absent = mkdtempSync(resolve(tmpdir(), "loki-evaltrend-"));
    mkdirSync(resolve(absent, ".loki"), { recursive: true });
    try {
      const emptyOut = await prompt(empty);
      const absentOut = await prompt(absent);
      expect(emptyOut).not.toContain("EFFICIENCY TREND");
      expect(absentOut).not.toContain("EFFICIENCY TREND");
      // Byte-identical to each other: the gated section contributed zero bytes
      // in both no-data shapes.
      expect(emptyOut).toBe(absentOut);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(absent, { recursive: true, force: true });
    }
  });

  // The opt-out must honour BOTH spellings. This repo uses both conventions
  // (LOKI_AUTO_DOCS=false alongside LOKI_GOAL_SCORING=0), so accepting only "0"
  // would give an operator who writes "false" a silent no-op opt-out -- a flag
  // that ignores the value you set is worse than no flag at all.
  it("is opt-outable via LOKI_EVAL_TREND read from the run env (0 and false)", async () => {
    const dir = seedRun(RECORDS);
    try {
      expect(await prompt(dir)).toContain("EFFICIENCY TREND");
      for (const off of ["0", "false", "FALSE", "False"]) {
        expect(await prompt(dir, { LOKI_EVAL_TREND: off })).not.toContain("EFFICIENCY TREND");
      }
      // Any other value leaves the default (ON) intact -- opt-out is explicit.
      expect(await prompt(dir, { LOKI_EVAL_TREND: "1" })).toContain("EFFICIENCY TREND");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // REGRESSION: the renderer is located by walking UP from this module, because
  // it runs from loki-ts/src/runner/ in dev but from the bundled loki-ts/dist/
  // in the shipped package. A hardcoded "../../../" is right for exactly one of
  // those and silently resolves to a nonexistent path for the other -- which
  // renders nothing, forever, in the artifact users actually run, while every
  // source-tree test stays green. Assert the SHIPPED bundle emits the block.
  it("locates the renderer from BOTH the src and dist module depths", async () => {
    const { existsSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    // Mirror of findEngineFile in build_prompt.ts. The bundled module lives at
    // loki-ts/dist/, one level shallower than loki-ts/src/runner/, so a fixed
    // relative depth is correct for only one of them.
    const walkUp = (rel: string, start: string): string | null => {
      let dir = start;
      for (let i = 0; i < 6; i++) {
        const c = resolve(dir, rel);
        if (existsSync(c)) return c;
        const p = dirname(dir);
        if (p === dir) break;
        dir = p;
      }
      return null;
    };
    const rel = "autonomy/lib/iteration_attribution.py";
    const fromSrc = walkUp(rel, resolve(import.meta.dir, "../../src/runner"));
    const fromDist = walkUp(rel, resolve(import.meta.dir, "../../dist"));
    expect(fromSrc).not.toBeNull();
    expect(fromDist).not.toBeNull();
    expect(fromDist).toBe(fromSrc);
  });

  it("tolerates a malformed record without losing the run", async () => {
    const dir = seedRun(RECORDS);
    try {
      writeFileSync(resolve(dir, ".loki/metrics/efficiency/iteration-9.json"), "not json");
      const out = await prompt(dir);
      expect(out).toContain("EFFICIENCY TREND");
      expect(out).toContain("progress 2/3, rework 1/3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
