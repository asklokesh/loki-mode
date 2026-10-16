import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDigest, endpointHost, modelOutcome, runIdentity } from "../../src/util/run_identity.ts";
import { claudeModelFor, useProviderDefaultModel } from "../../src/runner/providers.ts";
import { PROVIDER_DEFAULT_MODEL } from "../../src/util/claude_model.ts";
import { consumeSdkStream } from "../../src/runner/sdk_stream_parser.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "loki-runid-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env["LOKI_REQUESTED_MODEL"]; });

describe("run identity tuple", () => {
  test("receipt fields: cli version, endpoint host only, config digest, policy id, requested model", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "rules");
    mkdirSync(join(dir, ".loki"));
    writeFileSync(join(dir, ".loki", "policies.json"), "{}");
    const env = { HOME: join(dir, "nohome"), ANTHROPIC_BASE_URL: "https://user:secret@gw.example.com:8443/v1?k=1" };
    const id = runIdentity(dir, env, "opus", () => "2.1.34");
    expect(id.cli_version).toBe("2.1.34");
    expect(id.endpoint).toBe("gw.example.com:8443");
    expect(JSON.stringify(id)).not.toContain("secret");
    expect(id.config_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toHaveProperty("policy_id");
    expect(id.requested_model).toBe("opus");
  });
  test("config digest changes with CLAUDE.md and is null with no config", () => {
    const env = { HOME: join(dir, "nohome") };
    expect(configDigest(dir, env)).toBeNull();
    writeFileSync(join(dir, "CLAUDE.md"), "a");
    const a = configDigest(dir, env);
    writeFileSync(join(dir, "CLAUDE.md"), "b");
    expect(configDigest(dir, env)).not.toBe(a);
  });
  test("a custom gateway route records the gateway host", () => {
    expect(endpointHost({ LOKI_MODEL_ROUTE: "custom/m", LOKI_MODEL_BASE_URL: "https://gw.internal:9000/x" })).toBe("gw.internal:9000");
  });
  test("settings env values never enter the digest, env key names do", () => {
    mkdirSync(join(dir, ".claude"));
    const env = { HOME: join(dir, "nohome") };
    const w = (e: Record<string, string>) => writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ model: "x", env: e }));
    w({ K: "secret1" }); const a = configDigest(dir, env);
    w({ K: "secret2" }); expect(configDigest(dir, env)).toBe(a);
    w({ K2: "secret2" }); expect(configDigest(dir, env)).not.toBe(a);
  });
  test("default endpoint and unparseable endpoint", () => {
    expect(endpointHost({})).toBe("api.anthropic.com");
    expect(endpointHost({ ANTHROPIC_BASE_URL: "not a url" })).toBeNull();
  });
  test("downgrade flag: opus requested, sonnet actual", () => {
    expect(modelOutcome("opus", "claude-sonnet-4-6")).toEqual({ requested_model: "opus", actual_model: "claude-sonnet-4-6", downgraded: true });
    expect(modelOutcome("sonnet", "claude-sonnet-4-6").downgraded).toBe(false);
    expect(modelOutcome("sonnet", "claude-opus-4-7").downgraded).toBe(false);
    expect(modelOutcome("opus", null).downgraded).toBeNull();
    expect(modelOutcome("claude (provider default)", "claude-sonnet-4-6").downgraded).toBeNull();
    expect(modelOutcome("opus", "some-other-model").downgraded).toBeNull();
  });
  test("stream parser records requested and actual model with the downgrade flag", async () => {
    const msgs = [
      { type: "system", subtype: "init", model: "claude-sonnet-4-6", session_id: "s" },
      { type: "result", subtype: "success", total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s" },
    ];
    async function* gen() { for (const m of msgs) yield m as never; }
    await consumeSdkStream(gen(), { cwd: dir, iteration: "1", hookEventsEnabled: true, write: () => {}, requestedModel: "opus" });
    const rec = JSON.parse(readFileSync(join(dir, ".loki", "metrics", "result-cost-1.json"), "utf8"));
    expect(rec.model).toBe("claude-sonnet-4-6");
    expect(rec.requested_model).toBe("opus");
    expect(rec.model_downgraded).toBe(true);
  });
  test("endpoint is null under Bedrock or Vertex auth with no base URL", () => {
    expect(endpointHost({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBeNull();
    expect(endpointHost({ CLAUDE_CODE_USE_VERTEX: "1" })).toBeNull();
    expect(endpointHost({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BASE_URL: "https://b.example.com" })).toBe("b.example.com");
  });
  test("an inherited LOKI_REQUESTED_MODEL env var is ignored by the parser", async () => {
    process.env["LOKI_REQUESTED_MODEL"] = "opus";
    const msgs = [
      { type: "system", subtype: "init", model: "claude-sonnet-4-6", session_id: "s" },
      { type: "result", subtype: "success", total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s" },
    ];
    async function* gen() { for (const m of msgs) yield m as never; }
    await consumeSdkStream(gen(), { cwd: dir, iteration: "3", hookEventsEnabled: true, write: () => {} });
    const rec = JSON.parse(readFileSync(join(dir, ".loki", "metrics", "result-cost-3.json"), "utf8"));
    expect(rec.requested_model).toBeUndefined();
    expect(rec.model_downgraded).toBeUndefined();
  });
  const KEYS = ["LOKI_MAX_TIER", "LOKI_TIER_ROUTING", "LOKI_COMPLEXITY", "LOKI_SESSION_MODEL", "LOKI_MODEL_OVERRIDE", "ANTHROPIC_BASE_URL", "LOKI_E10_MODEL_DEFAULT", "LOKI_LEGACY_TIER_SWITCHING", "LOKI_ALLOW_HAIKU", "LOKI_CLAUDE_MODEL_PLANNING", "LOKI_MODEL_PLANNING", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_MODEL_DEVELOPMENT", "LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_FAST"];
  function withEnv<T>(set: Record<string, string>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, set);
    try { return fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  }
  const call = (tier: string, mainLoop = false) => ({ tier, mainLoop, cwd: dir }) as never;
  // The runner passes claudeModelFor (or the sentinel) as requestedModel; mirror that exact rule.
  const requested = (tier: string, mainLoop = false) => (useProviderDefaultModel(call(tier, mainLoop)) ? PROVIDER_DEFAULT_MODEL : claudeModelFor(call(tier, mainLoop)));
  test("requested model parity with the runner: MAX_TIER ceiling beats the planning opus pin, so no false downgrade", () => {
    withEnv({ LOKI_MAX_TIER: "sonnet", LOKI_SESSION_MODEL: "opus" }, () => {
      expect(requested("planning", true)).toBe("sonnet");
      expect(modelOutcome(requested("planning", true), "claude-sonnet-4-6").downgraded).toBe(false);
    });
  });
  test("requested model parity: the session opus pin applies to the main-loop planning tier only", () => {
    withEnv({ LOKI_SESSION_MODEL: "opus" }, () => {
      expect(requested("planning", true)).toBe("opus");
      expect(requested("planning", false)).not.toBe("opus");
      expect(requested("development", true)).not.toBe("opus");
    });
  });
  test("requested model parity: tier routing to opus on a complex planning task is a real downgrade when sonnet ran", () => {
    withEnv({ LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "complex" }, () => {
      expect(requested("planning")).toBe("opus");
      expect(modelOutcome(requested("planning"), "claude-sonnet-4-6").downgraded).toBe(true);
    });
  });
  test("requested model parity: gateway override wins only with a base URL", () => {
    withEnv({ LOKI_MODEL_OVERRIDE: "my-model" }, () => { expect(requested("development")).not.toBe("my-model"); });
    withEnv({ LOKI_MODEL_OVERRIDE: "my-model", ANTHROPIC_BASE_URL: "https://gw.example.com" }, () => { expect(requested("development")).toBe("my-model"); });
  });
  test("requested model parity: provider-default mode yields the sentinel and a null downgrade flag", () => {
    withEnv({ LOKI_E10_MODEL_DEFAULT: "1" }, () => {
      expect(requested("development")).toBe(PROVIDER_DEFAULT_MODEL);
      expect(modelOutcome(requested("development"), "claude-sonnet-4-6").downgraded).toBeNull();
      expect(requested("fast")).not.toBe(PROVIDER_DEFAULT_MODEL);
    });
  });
});
