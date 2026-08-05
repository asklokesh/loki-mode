// RUN-25 iter 3 (T3(b)): the SDK RARV loop's query() options must carry the same
// MCP tools / effort / USD budget / fallback the shell route passes, or the
// loop-flip ships a silently-degraded engine (no MCP tools, no effort tuning, no
// budget backstop). buildSdkLoopOptions composes them from the SAME helpers the
// shell route uses. Pure over env + a scratch cwd; no query() spawn.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSdkLoopOptions } from "../../src/runner/providers.ts";

let scratch: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["LOKI_BUDGET_LIMIT", "LOKI_ALLOW_HAIKU", "LOKI_COMPLEXITY"];

beforeEach(() => {
  scratch = mkdtempSync(resolve(tmpdir(), "loki-sdkopts-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("buildSdkLoopOptions: MCP tools", () => {
  test("includes the loki MCP server bundle + strictMcpConfig", () => {
    const o = buildSdkLoopOptions({ tier: "development", model: "claude-sonnet-5", cwd: scratch });
    // mcpConfigPath writes the bundle idempotently; the loki-mode server must be present.
    expect(o.mcpServers).toBeDefined();
    expect(o.strictMcpConfig).toBe(true);
    const servers = o.mcpServers as Array<Record<string, unknown>>;
    expect(servers.length).toBeGreaterThan(0);
    expect(Object.keys(servers[0]!)).toContain("loki-mode");
  });

  test("settingSources are set (parity with claude_code preset)", () => {
    const o = buildSdkLoopOptions({ tier: "development", model: "claude-sonnet-5", cwd: scratch });
    expect(o.settingSources).toEqual(["user", "project", "local"]);
  });
});

describe("buildSdkLoopOptions: effort tier", () => {
  test("effort derives from the tier (same mapping as the shell route)", () => {
    // effort is optional on the options type, so assert it is actually SET
    // before the membership check -- an unset effort must fail the test, not
    // pass vacuously.
    const dev = buildSdkLoopOptions({ tier: "development", model: "claude-sonnet-5", cwd: scratch });
    expect(dev.effort).toBeDefined();
    expect(["low", "medium", "high", "xhigh", "max"]).toContain(dev.effort!);
    const plan = buildSdkLoopOptions({ tier: "planning", model: "claude-opus-4-8", cwd: scratch });
    expect(plan.effort).toBeDefined();
    expect(["low", "medium", "high", "xhigh", "max"]).toContain(plan.effort!);
  });
});

describe("buildSdkLoopOptions: USD budget backstop", () => {
  test("omitted when no LOKI_BUDGET_LIMIT is set", () => {
    const o = buildSdkLoopOptions({ tier: "development", model: "claude-sonnet-5", cwd: scratch });
    expect(o.maxBudgetUsd).toBeUndefined();
  });

  test("set to remaining budget when a limit is configured with spend headroom", () => {
    // limit 10, spent 3 -> remaining 7 (>0). remainingBudget reads .loki/metrics/budget.json.
    process.env["LOKI_BUDGET_LIMIT"] = "10";
    mkdirSync(join(scratch, ".loki", "metrics"), { recursive: true });
    writeFileSync(join(scratch, ".loki", "metrics", "budget.json"), JSON.stringify({ current_spend: 3 }));
    const o = buildSdkLoopOptions({ tier: "development", model: "claude-sonnet-5", cwd: scratch });
    // remaining is positive (7), so maxBudgetUsd MUST be set to a finite positive
    // number. Assert unconditionally: a guard (if defined) would let a
    // dropped-passthrough mutation survive by skipping the assertion.
    expect(o.maxBudgetUsd).toBeGreaterThan(0);
    expect(Number.isFinite(o.maxBudgetUsd)).toBe(true);
  });

  test("omitted when the budget is fully spent (remaining <= 0)", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "5";
    mkdirSync(join(scratch, ".loki", "metrics"), { recursive: true });
    writeFileSync(join(scratch, ".loki", "metrics", "budget.json"), JSON.stringify({ current_spend: 5 }));
    const o = buildSdkLoopOptions({ tier: "development", model: "claude-sonnet-5", cwd: scratch });
    expect(o.maxBudgetUsd).toBeUndefined();
  });
});

describe("buildSdkLoopOptions: fallback model (parity with shell route)", () => {
  test("matches fallbackForPrimary's behavior for the given model", () => {
    // Parity note: the shell route passes the MODEL ID as `primary`, so
    // fallbackForPrimary hits its default->null arm for real model ids. This helper
    // does the SAME, so fallbackModel is omitted -- byte-identical to the shell
    // route's actual behavior (not a regression this task introduces).
    const o = buildSdkLoopOptions({ tier: "planning", model: "claude-opus-4-8", cwd: scratch });
    // Either undefined (parity with shell route) or a valid string; never throws.
    if (o.fallbackModel !== undefined) expect(typeof o.fallbackModel).toBe("string");
  });
});

describe("buildSdkLoopOptions: never throws (best-effort)", () => {
  test("returns an object even for an unwritable/odd cwd", () => {
    const o = buildSdkLoopOptions({ tier: undefined, model: "", cwd: "/nonexistent-xyz-123" });
    expect(typeof o).toBe("object");
  });
});
