// LM-002: the documented default spend cap, the JSON source of truth, the TS constant, the bash default and the
// help text must all state the same number; env precedence and the unmeasured-cost rule are pinned here too.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_MAX_COST_USD, resolveCap } from "../../src/e10ext/budget_cap.ts";
import { USAGE } from "../../src/engine10/cli.ts";
import { START_USAGE } from "../../src/commands/start.ts";
import { buildProviderCost } from "../../src/providers/provider_cost.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const json = JSON.parse(readFileSync(resolve(ROOT, "loki-ts/data/budget-defaults.json"), "utf8")) as { default_max_cost_usd: number };

describe("budget default: one source of truth", () => {
  test("the TS constant equals the JSON file", () => {
    expect(DEFAULT_MAX_COST_USD).toBe(json.default_max_cost_usd);
  });
  test("docs/contracts/budget.md states the same default", () => {
    const doc = readFileSync(resolve(ROOT, "docs/contracts/budget.md"), "utf8");
    expect(doc).toContain(`**${json.default_max_cost_usd} USD per run**`);
  });
  test("the bash default (lib and run.sh) equals the JSON file", () => {
    const lib = Bun.spawnSync(["bash", "-c", 'source "$1"; loki_budget_default_usd', "x", resolve(ROOT, "autonomy/lib/budget-default.sh")]);
    expect(lib.stdout.toString().trim()).toBe(String(json.default_max_cost_usd));
    const runSh = readFileSync(resolve(ROOT, "autonomy/run.sh"), "utf8");
    expect(runSh).toContain("budget-defaults.json");
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

describe("cap precedence: flag > env > loki.yaml > default", () => {
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
