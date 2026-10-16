// P12-27 (D99 item 1): gateway lane label and OTel passthrough.
// New file: no existing TS test owns providers/model_routes.ts.
import { describe, it, expect } from "bun:test";
import {
  GATEWAY_LANE_LABEL,
  GATEWAY_LANE_LOSS,
  gatewayLaneLabel,
  otelPassthroughEnv,
} from "../../src/providers/model_routes.ts";

describe("gatewayLaneLabel", () => {
  it("labels an active non-Anthropic route", () => {
    expect(gatewayLaneLabel({ LOKI_MODEL_ROUTE: "ollama/qwen3-coder" })).toBe("gateway lane (unqualified)");
    expect(GATEWAY_LANE_LABEL).toBe("gateway lane (unqualified)");
    expect(GATEWAY_LANE_LOSS).toBe(
      "prompt caching, extended thinking, server tools and hooks are not guaranteed on this lane",
    );
  });
  it("labels ANTHROPIC_BASE_URL with a non-Claude model override", () => {
    expect(gatewayLaneLabel({ ANTHROPIC_BASE_URL: "https://gw.example", LOKI_MODEL_OVERRIDE: "gpt-5" })).toBe(
      GATEWAY_LANE_LABEL,
    );
  });
  it("prints no label for Claude routes", () => {
    expect(gatewayLaneLabel({})).toBeNull();
    expect(gatewayLaneLabel({ LOKI_MODEL_OVERRIDE: "opus" })).toBeNull();
    expect(gatewayLaneLabel({ ANTHROPIC_BASE_URL: "https://gw.example", LOKI_MODEL_OVERRIDE: "claude-sonnet-4-5" })).toBeNull();
    expect(gatewayLaneLabel({ ANTHROPIC_BASE_URL: "https://gw.example" })).toBeNull();
  });
});

describe("otelPassthroughEnv", () => {
  it("passes only the OTel vars that are set, unchanged", () => {
    const out = otelPassthroughEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_SERVICE_NAME: "svc",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      HOME: "/x",
    });
    expect(out).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_SERVICE_NAME: "svc",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    });
  });
  it("never invents values when nothing is set", () => {
    expect(otelPassthroughEnv({})).toEqual({});
  });
});
