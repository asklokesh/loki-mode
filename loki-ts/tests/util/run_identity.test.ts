import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDigest, endpointHost, modelOutcome, runIdentity } from "../../src/util/run_identity.ts";
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
    process.env["LOKI_REQUESTED_MODEL"] = "opus";
    const msgs = [
      { type: "system", subtype: "init", model: "claude-sonnet-4-6", session_id: "s" },
      { type: "result", subtype: "success", total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s" },
    ];
    async function* gen() { for (const m of msgs) yield m as never; }
    await consumeSdkStream(gen(), { cwd: dir, iteration: "1", hookEventsEnabled: true, write: () => {} });
    const rec = JSON.parse(readFileSync(join(dir, ".loki", "metrics", "result-cost-1.json"), "utf8"));
    expect(rec.model).toBe("claude-sonnet-4-6");
    expect(rec.requested_model).toBe("opus");
    expect(rec.model_downgraded).toBe(true);
  });
});
