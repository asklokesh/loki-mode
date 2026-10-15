// D60-5 (INTEL-2): visible per-run cost cap. Resolution (--max-cost > loki.yaml budgets.per_run > default),
// the start line, and enforcement: cost over the cap ends the run BUDGET_STOP with exit code 3.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { capNote, costMeter, DEFAULT_MAX_COST_USD, hasApiKey, SUBSCRIPTION_NOTE, parseCapUsd, resolveCap, yamlPerRun } from "../../src/e10ext/budget_cap.ts";
import { runMachine } from "../../src/engine10/machine.ts";
import { EXIT, outcomeOf } from "../../src/engine10/output.ts";
import { USAGE } from "../../src/engine10/cli.ts";
import { START_USAGE } from "../../src/commands/start.ts";
import { buildProviderCost } from "../../src/providers/provider_cost.ts";
import type { RunContext, Stage, StageName } from "../../src/engine10/types.ts";

describe("cap resolution", () => {
  test("parse accepts positive numbers only", () => {
    expect(parseCapUsd("5")).toBe(5);
    expect(parseCapUsd("2.50")).toBe(2.5);
    expect(parseCapUsd("$7")).toBe(7);
    for (const bad of ["0", "-1", "abc", "", "1e3", "NaN"]) expect(parseCapUsd(bad)).toBeNull();
  });
  test("yamlPerRun reads budgets.per_run only", () => {
    expect(yamlPerRun("budgets:\n  per_run: 3.5\n  per_day: 50\n")).toBe(3.5);
    expect(yamlPerRun("other:\n  per_run: 9\nbudgets:\n  per_day: 1\n")).toBeNull();
    expect(yamlPerRun("budgets:\n  per_run: 4 # comment\n")).toBe(4);
    expect(yamlPerRun("per_run: 8\n")).toBeNull();
  });
  test("CLI wins over yaml, yaml over default", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-cap-"));
    try {
      const keyed = { ANTHROPIC_API_KEY: "present" } as NodeJS.ProcessEnv, none = {} as NodeJS.ProcessEnv;
      expect(DEFAULT_MAX_COST_USD).toBe(100);
      expect(resolveCap(null, d, keyed)).toEqual({ usd: 100, source: "default" });
      expect(resolveCap(null, d, none)).toEqual({ usd: 0, source: "subscription" });
      expect(hasApiKey({ ANTHROPIC_API_KEY: "" })).toBe(false);
      writeFileSync(join(d, "loki.yaml"), "budgets:\n  per_run: 3\n");
      expect(resolveCap(null, d, none)).toEqual({ usd: 3, source: "loki.yaml" });
      expect(resolveCap(null, d, keyed)).toEqual({ usd: 3, source: "loki.yaml" });
      expect(resolveCap("1.5", d, none)).toEqual({ usd: 1.5, source: "--max-cost" });
      expect(resolveCap("1.5", d, keyed)).toEqual({ usd: 1.5, source: "--max-cost" });
      expect("error" in resolveCap("zero", d, none)).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("start-line note names the cap", () => {
    expect(capNote(100, "default")).toBe("cap $100.00 (default)");
    expect(capNote(0, "subscription")).toBe("no dollar cap (subscription)");
    expect(SUBSCRIPTION_NOTE).toBe("subscription: no dollar cap; usage counts against your plan limits");
    expect(capNote(2.5, "--max-cost")).toBe("cap $2.50 (--max-cost)");
  });
  test("a zero cap (subscription) never trips the meter", () => {
    const m = costMeter(0);
    m.add(1000);
    expect(m.over()).toBe(false);
  });
  test("meter ignores null cost and trips at the cap", () => {
    const m = costMeter(1);
    m.add(null); m.add(0.4);
    expect(m.over()).toBe(false);
    m.add(0.6);
    expect(m.over()).toBe(true);
  });
});

describe("enforcement", () => {
  test("a cap hit maps to BUDGET_STOP and exit code 3", () => {
    expect(outcomeOf("PARTIAL", true, null)).toBe("BUDGET_STOP");
    expect(EXIT.BUDGET_STOP).toBe(3);
  });
  test("machine: cost over the cap stops the running stage, emits cap.hit, starts no more work stages", async () => {
    const events: { type: string; stage: StageName | null }[] = [];
    let spent = false;
    const ctx: RunContext = {
      runId: "e10-t", repoDir: "/x", runDir: "/x/r", baseSha: "a", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
      emit: (type, stage) => { events.push({ type, stage }); },
      sessions: { run: async () => { spent = true; return { exit: 0 } as never; } },
      tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
      cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
      clock: { now: () => Date.now() }, outputs: () => ({}), overCap: () => spent,
    };
    const st = (name: StageName, run?: Stage["run"]): Stage => ({ name, targetS: 1, limitS: 5, run: run ?? (async () => ({ status: "completed", data: {} })) });
    const sleep = (ms: number, s: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); s.addEventListener("abort", () => { clearTimeout(t); r(); }); });
    const stages: Partial<Record<StageName, Stage>> = {};
    for (const n of ["intake", "plan", "wall", "implement", "verify", "fix", "commit", "seal", "pr"] as StageName[]) stages[n] = st(n);
    stages.implement = st("implement", async (c, signal) => { await c.sessions.run({} as never); await sleep(5000, signal); return { status: "completed", data: {} }; });
    stages.verify = st("verify", async () => { throw new Error("verify must not run over the cap"); });
    const r = await runMachine(ctx, { load: async (n) => stages[n] ?? null });
    expect(r.capHit).toBe(true);
    expect(events.some((e) => e.type === "cap.hit")).toBe(true);
    expect(events.filter((e) => e.type === "stage.started").map((e) => e.stage)).not.toContain("verify");
  });
});

const ROOT = resolve(import.meta.dir, "../../..");
const json = JSON.parse(readFileSync(resolve(ROOT, "loki-ts/data/model-pricing.json"), "utf8")) as { default_max_cost_usd: number };

// LM-002: the documented default spend cap, the JSON source of truth, the TS constant, the bash default and the help text must all state the same number; env precedence and the unmeasured-cost rule are pinned here too.
describe("budget default: one source of truth", () => {
  test("the TS constant equals the JSON file", () => {
    expect(DEFAULT_MAX_COST_USD).toBe(json.default_max_cost_usd);
  });
  test("docs/cost-controls.md states the same default", () => {
    const doc = readFileSync(resolve(ROOT, "docs/cost-controls.md"), "utf8");
    expect(doc).toContain(`**${json.default_max_cost_usd} USD per run**`);
  });
  test("the bash default (run.sh) reads the JSON file", () => {
    const runSh = readFileSync(resolve(ROOT, "autonomy/run.sh"), "utf8");
    expect(runSh).toContain("model-pricing.json");
    expect(runSh).not.toMatch(/LOKI_BUDGET_LIMIT-"\d/); // no second hard-coded default
  });
  test("both TS help texts state the real default", () => {
    expect(USAGE).toContain(`$${json.default_max_cost_usd}`);
    expect(START_USAGE).toContain(`$${json.default_max_cost_usd}`);
  });
  test("bash help states the real default", () => {
    const r = Bun.spawnSync(["bash", resolve(ROOT, "autonomy/loki"), "help"], { env: { ...process.env, LOKI_NO_BROWSER: "1" } });
    expect(r.stdout.toString()).toContain(`default cap ${json.default_max_cost_usd}`);
  });
});

describe("cap precedence (env and default): flag > env > loki.yaml > default", () => {
  const withKey = { ANTHROPIC_API_KEY: "set" } as NodeJS.ProcessEnv;
  test("env beats the default and is labelled env", () => {
    expect(resolveCap(null, "/nonexistent", { ...withKey, LOKI_BUDGET_LIMIT: "7" })).toEqual({ usd: 7, source: "env" });
  });
  test("env applies on a subscription too (explicit beats implicit)", () => {
    expect(resolveCap(null, "/nonexistent", { LOKI_BUDGET_LIMIT: "7" })).toEqual({ usd: 7, source: "env" });
  });
  test("the flag beats env", () => {
    expect(resolveCap("3", "/nonexistent", { LOKI_BUDGET_LIMIT: "7" })).toEqual({ usd: 3, source: "--max-cost" });
  });
  test("with an API key and nothing else the default applies", () => {
    expect(resolveCap(null, "/nonexistent", withKey)).toEqual({ usd: json.default_max_cost_usd, source: "default" });
  });
});

describe("a model with no known price is unmeasured, never priced by a guess or 0", () => {
  test("provider-reported tokens on an unknown model give null dollars with a reason", () => {
    const rec = buildProviderCost("codex", "totally-unknown-model-x", "prompt", "Token usage: total=1500 input=1000 output=500");
    expect(rec).not.toBeNull();
    expect(rec!.total_cost_usd).toBeNull();
    expect(rec!.cost_basis).toBe("unpriced");
    expect(rec!.unmeasured_reason).toContain("totally-unknown-model-x");
    expect(rec!.input_tokens).toBe(1000);
  });
  test("a size estimate on an unknown model is also unmeasured", () => {
    const rec = buildProviderCost("aider", "totally-unknown-model-x", "do the thing please", "some output without usage lines");
    expect(rec!.total_cost_usd).toBeNull();
    expect(rec!.cost_basis).toBe("unpriced");
  });
  test("a known model is still priced", () => {
    const rec = buildProviderCost("codex", "gpt-5.3-codex", "prompt", "Token usage: total=1500 input=1000 output=500");
    expect(typeof rec!.total_cost_usd).toBe("number");
  });
  test("provider-reported dollars are kept even for an unknown model", () => {
    const rec = buildProviderCost("aider", "totally-unknown-model-x", "p", "Tokens: 1.2k sent, 340 received. Cost: $0.01 message, $0.02 session.");
    expect(rec!.total_cost_usd).toBe(0.02);
    expect(rec!.cost_basis).toBe("provider-dollars");
  });
});
