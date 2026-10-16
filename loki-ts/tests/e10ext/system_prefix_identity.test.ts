// CH-01: every engine10 stage sends a byte-identical systemPrompt and tool list across runs that differ in cwd, branch and clock.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSdkLoopOptions, resolveSystemPrompt } from "../../src/runner/providers.ts";

const STAGES = ["intake", "project-model", "plan", "wall", "implement", "fix"];
const KEYS = ["LOKI_E10_STAGE", "LOKI_E10_STABLE_PREFIX", "LOKI_E10_PREFIX", "LOKI_ROUTER", "LOKI_GIT_BRANCH"];
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env["LOKI_E10_STABLE_PREFIX"];
  delete process.env["LOKI_E10_PREFIX"];
  delete process.env["LOKI_ROUTER"];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Run = { cwd: string; branch: string; clock: Date };
const wire = (stage: string, run: Run, inject?: (sp: unknown) => unknown) => {
  process.env["LOKI_E10_STAGE"] = stage;
  process.env["LOKI_GIT_BRANCH"] = run.branch;
  const extra = buildSdkLoopOptions({ tier: "development", model: "sonnet", cwd: run.cwd });
  let sp: unknown = resolveSystemPrompt(extra);
  if (inject) sp = inject(sp);
  return JSON.stringify({ systemPrompt: sp, tools: extra.tools });
};
const mkRun = (branch: string, t: string): Run => {
  const cwd = mkdtempSync(join(tmpdir(), "ch01-"));
  dirs.push(cwd);
  return { cwd, branch, clock: new Date(t) };
};
const runs = () => [mkRun("main", "2026-10-08T00:00:00Z"), mkRun("slice-X", "2031-01-01T12:34:56Z")];

describe("CH-01 stable engine10 system prefix", () => {
  test("default: preset with excludeDynamicSections, identical across stages and runs", () => {
    const [a, b] = runs() as [Run, Run];
    const seen = new Set<string>();
    for (const s of STAGES) for (const r of [a, b]) seen.add(wire(s, r));
    expect(seen.size).toBe(1);
    const sp = JSON.parse([...seen][0] as string).systemPrompt;
    expect(sp).toEqual({ type: "preset", preset: "claude_code", excludeDynamicSections: true });
  });

  test("LOKI_E10_STABLE_PREFIX=0 restores the legacy preset bytes", () => {
    process.env["LOKI_E10_STABLE_PREFIX"] = "0";
    const [a] = runs() as [Run, Run];
    expect(JSON.parse(wire("plan", a)).systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  });

  test("lean prefix still wins as a plain string", () => {
    process.env["LOKI_E10_PREFIX"] = "lean";
    const [a] = runs() as [Run, Run];
    expect(typeof JSON.parse(wire("plan", a)).systemPrompt).toBe("string");
  });

  test("mutation: injecting the date or cwd turns the identity check red", () => {
    const [a, b] = runs() as [Run, Run];
    const injectDate = (r: Run) => (sp: unknown) => ({ ...(sp as object), append: r.clock.toISOString() });
    const injectCwd = (r: Run) => (sp: unknown) => ({ ...(sp as object), append: r.cwd });
    for (const inj of [injectDate, injectCwd]) {
      const seen = new Set([wire("wall", a, inj(a)), wire("wall", b, inj(b))]);
      expect(seen.size).toBe(2);
    }
  });
});
