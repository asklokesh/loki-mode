// D60-5 (INTEL-2): visible per-run cost cap. Resolution (--max-cost > loki.yaml budgets.per_run > default),
// the start line, and enforcement: cost over the cap ends the run BUDGET_STOP with exit code 3.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budgetNext, lastBudgetStop, priorSpend, unenforceableNote, writeBudgetStop, capMeter, capNote, perAttemptCap, runnerBudget, childBudgetLimit, costMeter, groupEnv, ledgerSum, DEFAULT_MAX_COST_USD, hasApiKey, SUBSCRIPTION_NOTE, parseCapUsd, resolveCap, yamlPerRun } from "../../src/e10ext/budget_cap.ts";
import { workerEmits } from "../../src/engine10/worker.ts";
import { childEnv } from "../../src/engine10/session.ts";
import { watchBudget } from "../../src/providers/provider_guard.ts";
import { runMachine } from "../../src/engine10/machine.ts";
import { EXIT, outcomeOf } from "../../src/engine10/output.ts";
import { USAGE } from "../../src/engine10/cli.ts";
import { engineArgv, START_USAGE, type ParsedStartOpts } from "../../src/commands/start.ts";
import { buildProviderCost, writeProviderCost } from "../../src/providers/provider_cost.ts";
import type { RunContext, Stage, StageName } from "../../src/engine10/types.ts";
import { appendChildLedger, childSpendDelta } from "../../src/util/child_ledger.ts";

describe("cap resolution", () => {
  test("parse accepts positive numbers only", () => {
    expect(parseCapUsd("5")).toBe(5);
    expect(parseCapUsd("2.50")).toBe(2.5);
    expect(parseCapUsd("$7")).toBe(7);
    for (const bad of ["0", "-1", "abc", "", "1e3", "NaN"]) expect(parseCapUsd(bad)).toBeNull();
  });
  test("bare decimal cap: .5 and 5. are dollar caps, not null", () => {
    expect(parseCapUsd(".5")).toBe(0.5);
    expect(parseCapUsd("$.25")).toBe(0.25);
    expect(parseCapUsd("5.")).toBe(5);
    for (const bad of [".", "$.", "..5", "5..", ".0", "0."]) expect(parseCapUsd(bad)).toBeNull();
    expect(resolveCap(".5", "/nonexistent-loki-repo", {})).toEqual({ usd: 0.5, source: "--max-cost" });
    expect(resolveCap(null, "/nonexistent-loki-repo", { LOKI_BUDGET_LIMIT: "5." })).toEqual({ usd: 5, source: "env" });
    expect(resolveCap(null, "/nonexistent-loki-repo", { LOKI_BUDGET_LIMIT: ".0" })).toEqual({ usd: 0, source: "subscription" });
    expect(yamlPerRun("budgets:\n  per_run: .5\n")).toBe(0.5);
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
  test("unparseable env or yaml cap returns an error, 0 stays valid", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-cap-"));
    try {
      const keyed = { ANTHROPIC_API_KEY: "present" } as NodeJS.ProcessEnv;
      for (const bad of ["5usd", "abc", "-3"]) {
        const r = resolveCap(null, d, { ...keyed, LOKI_BUDGET_LIMIT: bad });
        expect("error" in r && r.error.includes("LOKI_BUDGET_LIMIT")).toBe(true);
      }
      expect(resolveCap(null, d, { ...keyed, LOKI_BUDGET_LIMIT: "0" })).toEqual({ usd: 100, source: "default" });
      expect(resolveCap(null, d, { ...keyed, LOKI_BUDGET_LIMIT: "" })).toEqual({ usd: 100, source: "default" });
      writeFileSync(join(d, "loki.yaml"), "budgets:\n  per_run: 5usd\n");
      const y = resolveCap(null, d, keyed);
      expect("error" in y && y.error.includes("budgets.per_run")).toBe(true);
      writeFileSync(join(d, "loki.yaml"), "budgets:\n  per_run: 0\n");
      expect(resolveCap(null, d, keyed)).toEqual({ usd: 100, source: "default" });
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

describe("opencode estimate", () => {
  test("a priced opencode model gets a size-estimate record", () => {
    const rec = buildProviderCost("opencode", "gpt-5.3-codex", "do the thing please", "some opencode output");
    expect(rec).not.toBeNull();
    expect(rec!.estimated).toBe(true);
    expect(rec!.cost_basis).toBe("size-estimate");
    expect(typeof rec!.total_cost_usd).toBe("number");
  });
  test("an unpriced opencode model stays unmeasured with a reason", () => {
    const rec = buildProviderCost("opencode", "totally-unknown-model-x", "do the thing please", "some opencode output");
    expect(rec!.total_cost_usd).toBeNull();
    expect(rec!.cost_basis).toBe("unpriced");
  });
  test("writeProviderCost writes the result-cost file for opencode", () => {
    const d = mkdtempSync(join(tmpdir(), "oc-est-"));
    try {
      const dest = join(d, "metrics", "result-cost-1.json");
      expect(writeProviderCost(dest, "opencode", "gpt-5.3-codex", "do the thing please", "some opencode output")).not.toBeNull();
      expect(JSON.parse(readFileSync(dest, "utf8")).cost_basis).toBe("size-estimate");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("group env carries the resolved cap to unit children", () => {
  test("a positive cap is exported as LOKI_BUDGET_LIMIT without mutating the input", () => {
    const base = { PATH: "/bin" } as NodeJS.ProcessEnv;
    const g = groupEnv(base, 5);
    expect(g.LOKI_BUDGET_LIMIT).toBe("5");
    expect(g.PATH).toBe("/bin");
    expect(base.LOKI_BUDGET_LIMIT).toBeUndefined();
  });
  test("a subscription run (cap 0) leaves the env untouched", () => {
    expect(groupEnv({ LOKI_BUDGET_LIMIT: "9" } as NodeJS.ProcessEnv, 0).LOKI_BUDGET_LIMIT).toBe("9");
    expect(groupEnv({} as NodeJS.ProcessEnv, 0).LOKI_BUDGET_LIMIT).toBeUndefined();
  });
  test("supervisor hands the group the capped env, not process.env", () => {
    expect(readFileSync(resolve(ROOT, "loki-ts/src/engine10/supervisor.ts"), "utf8")).toContain("maybeRunGroup(task, repoDir, groupEnv(process.env, cap.usd, repoDir)");
  });
});

describe("live in-session cap", () => {
  test("meter reports what is left and null without a cap", () => {
    const m = costMeter(5); m.add(1.5); m.add(null);
    expect(m.remaining()).toBe(3.5);
    m.add(10);
    expect(m.remaining()).toBe(0);
    expect(costMeter(0).remaining()).toBeNull();
  });
  test("capMeter exposes remaining from LOKI_E10_MAX_COST_USD", () => {
    const { emit, remaining } = capMeter((() => {}) as (t: never, s: never, d: Record<string, unknown>) => void, { LOKI_E10_MAX_COST_USD: "2" } as NodeJS.ProcessEnv);
    (emit as unknown as (t: string, s: null, d: Record<string, unknown>) => void)("cost", null, { usd: 0.5 });
    expect(remaining()).toBe(1.5);
  });
  test("childBudgetLimit floors a spent cap at 0.01 and passes null through", () => {
    expect(childBudgetLimit(1.5)).toBe("1.5");
    expect(childBudgetLimit(0)).toBe("0.01");
    expect(childBudgetLimit(null)).toBeNull();
  });
  test("a session child env carries LOKI_BUDGET_LIMIT <= the cap", () => {
    const opts = { stage: "implement", brief: "b", tier: "dev", iterationId: "i", limitS: 1, signal: new AbortController().signal } as never;
    const saved = process.env.LOKI_BUDGET_LIMIT; delete process.env.LOKI_BUDGET_LIMIT;
    try {
      const m = costMeter(2); m.add(0.5);
      expect(Number(childEnv(opts, { provider: "codex", remaining: m.remaining }).LOKI_BUDGET_LIMIT)).toBeLessThanOrEqual(2);
      expect(childEnv(opts, { provider: "codex", remaining: m.remaining }).LOKI_BUDGET_LIMIT).toBe("1.5");
      expect(childEnv(opts, { provider: "codex" }).LOKI_BUDGET_LIMIT).toBeUndefined();
    } finally { if (saved !== undefined) process.env.LOKI_BUDGET_LIMIT = saved; }
  });
  test("watchBudget kills once a fake exceeded() turns true", async () => {
    let hit = false, killed = "";
    const stop = watchBudget(() => hit, (c) => { killed = c; }, 5);
    await new Promise((r) => setTimeout(r, 20)); expect(killed).toBe("");
    hit = true; await new Promise((r) => setTimeout(r, 30));
    stop(); expect(killed).toBe("budget");
  });
});

describe("every start mode honors the one cap", () => {
  const base = { prdPath: "spec.md" } as ParsedStartOpts;
  test("spec-first argv carries --max-cost", () => {
    const a = engineArgv({ ...base, specFirst: true, budgetLimit: 3 }, "do it", false);
    expect(a.slice(a.indexOf("--max-cost"))).toEqual(["--max-cost", "3"]);
    expect(a).toContain("plan");
  });
  test("plain engine argv still carries --max-cost", () => {
    expect(engineArgv({ ...base, budgetLimit: 2 }, "t", true)).toEqual([expect.anything(), "engine10", "t", "--no-pr", "--max-cost", "2"]);
  });
  test("runner default: explicit wins; API key gives the default; subscription gives none", () => {
    expect(runnerBudget(4, "/nonexistent", {}).usd).toBe(4);
    expect(runnerBudget(undefined, "/nonexistent", { ANTHROPIC_API_KEY: "x" } as NodeJS.ProcessEnv)).toEqual({ usd: DEFAULT_MAX_COST_USD, note: capNote(DEFAULT_MAX_COST_USD, "default") });
    expect(runnerBudget(undefined, "/nonexistent", {} as NodeJS.ProcessEnv)).toEqual({ usd: undefined, note: null });
  });
  test("runner keeps a dollar cap when LOKI_BUDGET_LIMIT is unparseable", () => {
    const r = runnerBudget(undefined, "/nonexistent", { ANTHROPIC_API_KEY: "x", LOKI_BUDGET_LIMIT: "5usd" } as NodeJS.ProcessEnv);
    expect(r.usd).toBe(DEFAULT_MAX_COST_USD);
    expect(r.note).toContain("LOKI_BUDGET_LIMIT must be a positive number");
    expect(runnerBudget(undefined, "/nonexistent", { LOKI_BUDGET_LIMIT: "5usd" } as NodeJS.ProcessEnv).usd).toBe(DEFAULT_MAX_COST_USD);
  });
  test("attempts split the total: 3 attempts on a $3 cap get $1 each", () => {
    expect(perAttemptCap(3, 3)).toBe(1);
    expect(perAttemptCap(1, 3)).toBe(0.33);
    expect(perAttemptCap(0.01, 5)).toBe(0.01);
    expect(perAttemptCap(5, 1)).toBe(5);
    expect(perAttemptCap(undefined, 3)).toBeUndefined();
    const a = engineArgv({ ...base, budgetLimit: perAttemptCap(3, 3) }, "t", true);
    expect(a.slice(a.indexOf("--max-cost"))).toEqual(["--max-cost", "1"]);
  });
});

describe("budget stop survives a kill-and-rerun", () => {
  const withRepo = (fn: (repo: string) => void): void => { const d = mkdtempSync(join(tmpdir(), "bcap-")); try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
  test("a meter seeded with 4 of 5 trips after one more dollar", () => {
    const emitted: unknown[] = [];
    const m = capMeter(((t: string, _s: never, d: Record<string, unknown>) => { emitted.push([t, d]); }) as never, { LOKI_E10_MAX_COST_USD: "5", LOKI_E10_SPENT_USD: "4" });
    expect(m.over()).toBe(false); expect(m.remaining()).toBe(1);
    (m.emit as unknown as (t: string, s: string, d: Record<string, unknown>) => void)("cost", "implement", { usd: 1 });
    expect(m.over()).toBe(true);
  });
  test("a bad or missing seed is ignored", () => {
    for (const v of [undefined, "", "abc", "-3"]) expect(capMeter((() => {}) as never, { LOKI_E10_MAX_COST_USD: "5", ...(v === undefined ? {} : { LOKI_E10_SPENT_USD: v }) }).remaining()).toBe(5);
  });
  test("budget.json records cap, spent, source and outcome; the same task finds it", () => withRepo((repo) => {
    writeBudgetStop(repo, "e10-20260101T000000Z-aaaa", { task: "fix the thing", cap_usd: 5, spent_usd: 4.2, source: "--max-cost" });
    const raw = JSON.parse(readFileSync(join(repo, ".loki", "runs", "e10-20260101T000000Z-aaaa", "budget.json"), "utf8"));
    expect(raw).toEqual({ task: "fix the thing", cap_usd: 5, spent_usd: 4.2, source: "--max-cost", outcome: "budget_stopped" });
    expect(priorSpend(repo, " fix the thing ")).toBe(4.2);
    expect(priorSpend(repo, "another task")).toBe(0);
    expect(lastBudgetStop(repo)?.runId).toBe("e10-20260101T000000Z-aaaa");
  }));
  test("the newest stop for the task wins (its spent is cumulative)", () => withRepo((repo) => {
    writeBudgetStop(repo, "e10-20260101T000000Z-aaaa", { task: "t", cap_usd: 5, spent_usd: 3, source: "default" });
    writeBudgetStop(repo, "e10-20260102T000000Z-bbbb", { task: "t", cap_usd: 8, spent_usd: 7, source: "--max-cost" });
    expect(priorSpend(repo, "t")).toBe(7);
  }));
  test("next step names --max-cost; unpriced provider is warned about", () => {
    expect(budgetNext(4.2, 5)).toContain("raise with --max-cost");
    expect(unenforceableNote("claude", 5)).toBeNull();
    expect(unenforceableNote("claude", 0)).toBeNull();
  });
  test("supervisor seeds the worker env and writes budget.json on BUDGET_STOP", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../src/engine10/supervisor.ts"), "utf8");
    expect(src).toContain("LOKI_E10_SPENT_USD"); expect(src).toContain("writeBudgetStop(");
  });
});

describe("P12-22r shared budget ledger across parallel units", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "p1222r-"));
  const cost = (m: { emit: (t: never, s: never, d: Record<string, unknown>) => void }, usd: number) => m.emit("cost" as never, null as never, { usd });
  test("two units sharing a ledger stop at the single cap", () => {
    const d = mk();
    try {
      const env = { LOKI_E10_MAX_COST_USD: "1", LOKI_BUDGET_LEDGER: join(d, "l.ledger") } as NodeJS.ProcessEnv;
      const a = capMeter((() => {}) as never, env), b = capMeter((() => {}) as never, env);
      cost(a, 0.6); expect(a.over()).toBe(false); expect(b.over()).toBe(false);
      cost(b, 0.6);
      expect(a.over()).toBe(true); expect(b.over()).toBe(true);
      expect(a.remaining()).toBe(0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("without a ledger units keep private meters (unchanged)", () => {
    const env = { LOKI_E10_MAX_COST_USD: "1" } as NodeJS.ProcessEnv;
    const a = capMeter((() => {}) as never, env), b = capMeter((() => {}) as never, env);
    cost(a, 0.6); cost(b, 0.6); expect(a.over()).toBe(false); expect(b.over()).toBe(false);
  });
  test("fail closed: unwritable ledger path stops the unit", () => {
    const env = { LOKI_E10_MAX_COST_USD: "5", LOKI_BUDGET_LEDGER: "/nonexistent-p1222r/dir/x.ledger" } as NodeJS.ProcessEnv;
    const m = capMeter((() => {}) as never, env);
    expect(m.over()).toBe(true); expect(m.remaining()).toBe(0);
  });
  test("fail closed: ledger vanishing mid-run stops the unit", () => {
    const d = mk();
    try {
      const f = join(d, "l.ledger"), m = capMeter((() => {}) as never, { LOKI_E10_MAX_COST_USD: "5", LOKI_BUDGET_LEDGER: f } as NodeJS.ProcessEnv);
      expect(m.over()).toBe(false); rmSync(f); expect(m.over()).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("groupEnv exports one absolute ledger, keeps an existing one", () => {
    const d = mk();
    try {
      const g = groupEnv({} as NodeJS.ProcessEnv, 5, d);
      expect(g.LOKI_BUDGET_LEDGER && g.LOKI_BUDGET_LEDGER.startsWith(d)).toBe(true);
      expect(groupEnv({ LOKI_BUDGET_LEDGER: "/x/y" } as NodeJS.ProcessEnv, 5, d).LOKI_BUDGET_LEDGER).toBe("/x/y");
      expect(groupEnv({} as NodeJS.ProcessEnv, 0, d).LOKI_BUDGET_LEDGER).toBeUndefined();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("groupEnv fails closed when the ledger dir cannot be created", () => {
    const d = mk();
    try {
      writeFileSync(join(d, ".loki"), "not a dir");
      const g = groupEnv({} as NodeJS.ProcessEnv, 5, d);
      expect(g.LOKI_BUDGET_LEDGER).toBeTruthy();
      expect(capMeter((() => {}) as never, { LOKI_E10_MAX_COST_USD: "5", LOKI_BUDGET_LEDGER: g.LOKI_BUDGET_LEDGER } as NodeJS.ProcessEnv).over()).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("rerun seed is recorded once in the ledger, never added on top of it", () => {
    const d = mk();
    try {
      const env = { LOKI_E10_MAX_COST_USD: "10", LOKI_E10_SPENT_USD: "4", LOKI_BUDGET_LEDGER: join(d, "l.ledger") } as NodeJS.ProcessEnv;
      const a = capMeter((() => {}) as never, env), b = capMeter((() => {}) as never, env);
      expect(a.remaining()).toBe(6); expect(b.remaining()).toBe(6);
      cost(a, 1);
      expect(capMeter((() => {}) as never, env).remaining()).toBe(5);
      const f2 = join(d, "old.ledger"); writeFileSync(f2, JSON.stringify({ pid: 1, usd: 4 }) + "\n"); // ledger already holds the 4 dollars
      expect(capMeter((() => {}) as never, { ...env, LOKI_BUDGET_LEDGER: f2 } as NodeJS.ProcessEnv).remaining()).toBe(6);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("concurrent processes append one ledger: exact sum, no torn line", async () => {
    const d = mk();
    try {
      const ledger = join(d, "race.ledger"), child = join(d, "child.ts"), n = 4, per = 200;
      writeFileSync(child, `import { capMeter } from ${JSON.stringify(resolve(ROOT, "loki-ts/src/e10ext/budget_cap.ts"))};
const m = capMeter((() => {}) as never, { LOKI_E10_MAX_COST_USD: "100000", LOKI_BUDGET_LEDGER: process.argv[2] } as NodeJS.ProcessEnv);
for (let i = 0; i < ${per}; i++) m.emit("cost" as never, "x" as never, { usd: 0.25, pad: "x".repeat(300) });
`);
      const procs = Array.from({ length: n }, () => Bun.spawn([process.execPath, child, ledger], { stdout: "ignore", stderr: "pipe" }));
      for (const p of procs) expect(await p.exited).toBe(0);
      const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBe(n * per);
      for (const l of lines) expect(typeof (JSON.parse(l) as { usd: number }).usd).toBe("number");
      expect(ledgerSum(ledger)).toBe(n * per * 0.25);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("ledgerSum counts only the first seed line, first seed wins", () => {
    const d = mk();
    try {
      const f = join(d, "s.ledger");
      writeFileSync(f, JSON.stringify({ usd: 2, seed: true }) + "\n" + JSON.stringify({ usd: 3, seed: true }) + "\n" + JSON.stringify({ usd: 0.5 }) + "\n");
      expect(ledgerSum(f)).toBe(2.5);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("route key cap", () => {
  test("route key cap: a model-route key counts as an API key", () => {
    expect(hasApiKey({ OPENROUTER_API_KEY: "k" })).toBe(true);
    expect(hasApiKey({ LOKI_MODEL_API_KEY: "k" })).toBe(true);
    expect(hasApiKey({ OPENROUTER_API_KEY: "" })).toBe(false);
    const d = mkdtempSync(join(tmpdir(), "loki-rk-"));
    try {
      expect(resolveCap(null, d, { OPENROUTER_API_KEY: "k" })).toEqual({ usd: DEFAULT_MAX_COST_USD, source: "default" });
      expect(resolveCap(null, d, { LOKI_MODEL_API_KEY: "k" })).toEqual({ usd: DEFAULT_MAX_COST_USD, source: "default" });
      expect(resolveCap(null, d, {})).toEqual({ usd: 0, source: "subscription" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("budget threshold events (50, 80, 100 percent of the cap)", () => {
  type Em = (t: string, s: string, d: Record<string, unknown>) => void;
  const drive = (costs: unknown[], env: Record<string, string> = { LOKI_E10_MAX_COST_USD: "1.00" }) => {
    const events: Array<[string, Record<string, unknown>]> = [], notified: Array<Record<string, unknown>> = [];
    const m = capMeter(((t: string, _s: never, d: Record<string, unknown>) => { events.push([t, d]); }) as never, env as NodeJS.ProcessEnv, (b) => { notified.push(b as never); });
    for (const usd of costs) (m.emit as unknown as Em)("cost", "implement", { usd });
    return { budget: events.filter(([t]) => t === "budget").map(([, d]) => d), notified };
  };
  test("cap 1.00 with 0.30, 0.25, 0.30, 0.20 gives exactly three budget events at 0.50, 0.80, 1.00", () => {
    const { budget, notified } = drive([0.3, 0.25, 0.3, 0.2]);
    expect(budget.map((b) => b.threshold_usd)).toEqual([0.5, 0.8, 1]);
    expect(budget.map((b) => b.threshold_pct)).toEqual([50, 80, 100]);
    expect(notified.length).toBe(3);
  });
  test("one cost event crossing two thresholds emits both, each once", () => {
    expect(drive([0.85, 0.05, 0.05]).budget.map((b) => b.threshold_pct)).toEqual([50, 80]);
  });
  test("no cap, or unmeasured (null) cost, emits nothing", () => {
    expect(drive([0.9], {}).budget).toEqual([]);
    expect(drive([null, undefined]).budget).toEqual([]);
  });
  test("a rerun seeded past a threshold does not re-emit it", () => {
    expect(drive([0.25], { LOKI_E10_MAX_COST_USD: "1.00", LOKI_E10_SPENT_USD: "0.6" }).budget.map((b) => b.threshold_pct)).toEqual([80]);
  });
});

describe("child sessions count against the dollar cap", () => {
  const rec = { phase: "reviewer", model: "m", input_tokens: 5, output_tokens: 7, cache_creation_tokens: 0, cache_read_tokens: 0, usd: 0.7, source: "x" };
  const child = (d: string, runId: string, r = rec): void => { const p = process.env["LOKI_E10_RUN_ID"]; process.env["LOKI_E10_RUN_ID"] = runId; try { appendChildLedger(d, r); } finally { if (p === undefined) delete process.env["LOKI_E10_RUN_ID"]; else process.env["LOKI_E10_RUN_ID"] = p; } };
  const noop = (() => {}) as (t: never, s: never, d: Record<string, unknown>) => void;
  test("child spend alone trips the cap, stage cost then adds to it", () => {
    const d = mkdtempSync(join(tmpdir(), "c5child-"));
    try {
      const m = capMeter(noop, { LOKI_E10_MAX_COST_USD: "1" } as NodeJS.ProcessEnv, undefined, childSpendDelta(d, "R1"));
      expect(m.over()).toBe(false);
      child(d, "R1"); expect(m.over()).toBe(false); expect(m.remaining()).toBeCloseTo(0.3, 10);
      m.emit("cost" as never, null as never, { usd: 0.4 }); // stage 0.4 + child 0.7
      expect(m.over()).toBe(true); expect(m.remaining()).toBe(0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("another run's child lines never count, and spend already in the resume seed is not counted twice", () => {
    const d = mkdtempSync(join(tmpdir(), "c5child-"));
    try {
      child(d, "R1"); // pre-resume child spend, already inside LOKI_E10_SPENT_USD
      const m = capMeter(noop, { LOKI_E10_MAX_COST_USD: "1", LOKI_E10_SPENT_USD: "0.7" } as NodeJS.ProcessEnv, undefined, childSpendDelta(d, "R1"));
      child(d, "R2"); expect(m.over()).toBe(false); expect(m.remaining()).toBeCloseTo(0.3, 10);
      child(d, "R1", { ...rec, usd: 0.1 }); expect(m.remaining()).toBeCloseTo(0.2, 10); // post-resume child spend IS metered
      child(d, "R1", { ...rec, usd: 0.25 }); expect(m.over()).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("child spend is written to the shared ledger, so a sibling unit stops at the one cap", () => {
    const d = mkdtempSync(join(tmpdir(), "c5child-"));
    try {
      const env = { LOKI_E10_MAX_COST_USD: "1", LOKI_BUDGET_LEDGER: join(d, "l.ledger") } as NodeJS.ProcessEnv;
      const a = capMeter(noop, env, undefined, childSpendDelta(d, "R1")), b = capMeter(noop, env);
      child(d, "R1"); expect(a.over()).toBe(false);
      expect(ledgerSum(join(d, "l.ledger"))).toBeCloseTo(0.7, 10);
      b.emit("cost" as never, null as never, { usd: 0.4 });
      expect(b.over()).toBe(true); expect(a.over()).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("workerEmits: one cost event feeds the receipt reader, the cap meter and the log, and the run's child spend seeds the meter", () => {
    const d = mkdtempSync(join(tmpdir(), "c5child-"));
    try {
      const sent: unknown[] = [], lokiRoot = join(d, ".loki");
      const w = workerEmits((t, _s, data) => { sent.push([t, data]); }, "R1", d, lokiRoot, { LOKI_E10_MAX_COST_USD: "2", LOKI_E10_SPENT_USD: "0.5" } as NodeJS.ProcessEnv);
      expect(w.remaining()).toBeCloseTo(1.5, 10);
      w.emit("cost", "implement", { session_id: "s1", usd: 0.25 });
      expect(sent).toEqual([["cost", { session_id: "s1", usd: 0.25 }]]);
      expect(w.cost.read(d, []).usd).toBe(0.25); // the reader main puts on ctx.cost saw the same event
      expect(w.remaining()).toBeCloseTo(1.25, 10); // the meter saw it too, from the seed
      child(lokiRoot, "R1"); expect(w.remaining()).toBeCloseTo(0.55, 10); // the child meter is wired in
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("main takes emit, over, remaining and cost only from workerEmits", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "engine10", "worker.ts"), "utf8"), body = src.slice(src.indexOf("export async function main"));
    expect(body).toMatch(/const \{ emit, over, remaining, cost \} = workerEmits\(rawEmit, runId, repoDir, lokiRoot, process\.env,/);
    expect(body).not.toMatch(/capMeter\(|costCapture\(|workerCostReader\(/);
    expect(body).toMatch(/\n\s+cost,\n/);
  });
});
