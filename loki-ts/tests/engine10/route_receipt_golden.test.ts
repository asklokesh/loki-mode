// R1-15 (L7): goldens for the router start line, receipt route block and PR line. Flag off must be inert.
import { describe, expect, test } from "bun:test";
import { renderPrBody } from "../../src/engine10/pr_body.ts";
import { buildRouteBlock, routeNotProven, routePrLine, routeReceiptLines, routeStartLine, withRouteLine } from "../../src/runner/router/route_block.ts";
import { renderReceiptMd } from "../../src/engine10/stages/seal.ts";
import type { Receipt } from "../../src/engine10/types.ts";

const ON = { LOKI_ROUTER: "1" };
const tel = { requests_total: 8, requests_over_100k: 2, advisor_calls: 3, advisor_input_tokens: 30000, advisor_output_tokens: 700 };

describe("start line", () => {
  test("flag unset, 0, off: nothing", () => {
    expect(routeStartLine({}, "claude")).toBeNull();
    expect(routeStartLine({ LOKI_ROUTER: "0" }, "claude")).toBeNull();
    expect(routeStartLine({ LOKI_ROUTER: "off" }, "claude")).toBeNull();
  });
  test("golden: executor haiku-5.5, advisor opus", () => {
    expect(routeStartLine(ON, "claude")).toBe("route: executor haiku-5.5, advisor opus: Opus routes at plan time");
  });
  test("advisor unavailable: sonnet executor and the reason, never silent", () => {
    expect(routeStartLine({ ...ON, CLAUDE_CODE_USE_BEDROCK: "1" }, "claude")).toBe("route: executor sonnet-5.5, advisor unavailable: advisor tool is unsupported on Bedrock, Vertex and Foundry");
    expect(routeStartLine(ON, "codex")).toContain("advisor unavailable: provider codex has no advisor tool");
  });
});

describe("route block", () => {
  test("flag off: null (receipt key omitted)", () => {
    expect(buildRouteBlock({}, "claude", { executor: "haiku" }, tel)).toBeNull();
  });
  test("per-run route renders as the single unit run", () => {
    const b = buildRouteBlock(ON, "claude", { executor: "haiku", source: "opus", reason: "small change", shape_key: "single:vitest", escalations: [{ trigger: "code-owned FAIL x2", from: "haiku", to: "sonnet", evidence: "verify.json#3" }] }, tel)!;
    expect(b.units).toEqual([{ id: "run", executor: "haiku-5.5", assigned_by: "opus", reason: "small change", escalations: b.escalations }]);
    expect(b.over_100k_share).toBe(0.25);
    expect(routeReceiptLines(b)).toEqual([
      "- Route: executor haiku-5.5, advisor opus-5.5: small change",
      "- Route shape_key: single:vitest  shape_parity: NOT PROVEN (no B9 row for shape single:vitest)",
      "- Route escalations: haiku-5.5 -> sonnet-5.5 (code-owned FAIL x2; evidence verify.json#3)",
      "- Route advisor: 3 calls, 30000 in / 700 out tokens",
      "- Route unit run: executor haiku-5.5, assigned by opus: small change; escalation: haiku-5.5 -> sonnet-5.5 (code-owned FAIL x2)",
      "- Route requests over 100K: 2 of 8 (25.0%)",
    ]);
    expect(routePrLine(b)).toBe("Route: executor haiku-5.5, advisor opus-5.5; advisor tokens 30000 in / 700 out; over 100K: 2 of 8 requests (25.0%)");
  });
  test("per-unit routes are read when present", () => {
    const b = buildRouteBlock(ON, "claude", { executor: "haiku", units: [{ id: "u1", executor: "sonnet", reason: "touches auth" }, { id: "u2", executor: "haiku", reason: "rename", escalations: [{ trigger: "spec conflict", from: "haiku", to: "sonnet" }] }] }, tel)!;
    expect(b.units.map((u) => [u.id, u.executor, u.assigned_by, u.escalations.length])).toEqual([["u1", "sonnet-5.5", "opus", 0], ["u2", "haiku-5.5", "opus", 1]]);
  });
  test("router on but no route recorded: not routed, with the reason", () => {
    const b = buildRouteBlock(ON, "claude", undefined, undefined)!;
    expect(b.routed).toBe(false);
    expect(routePrLine(b)).toBe("Route: not routed (no route recorded by implement)");
    expect(routeReceiptLines(b)[0]).toBe("- Route: not routed (no route recorded by implement)");
    expect(b.over_100k_share).toBeNull();
  });
  test("NOT PROVEN: shape parity always, advisor with owner provider when unavailable", () => {
    const b = buildRouteBlock({ ...ON, LOKI_ROUTER_ADVISOR: "off" }, "claude", { executor: "sonnet", shape_key: "k" }, tel)!;
    expect(routeNotProven(b)).toEqual(["advisor: NOT PROVEN (owner provider): LOKI_ROUTER_ADVISOR=off", "route.shape_parity: NOT PROVEN (no B9 row for shape k)"]);
  });
});

describe("byte stability when the router is off", () => {
  const base = { verdict: "VERIFIED" as const, notProven: ["full suite"], receiptPath: "/r/receipt.json", capHit: false, outputs: {} };
  test("PR body without a route line equals the body before R1-15", () => {
    expect(withRouteLine("Verdict: VERIFIED\n\nx\n", null)).toBe("Verdict: VERIFIED\n\nx\n");
    const plain = renderPrBody(base);
    expect(renderPrBody({ ...base, routeLine: undefined })).toBe(plain);
  });
  test("route line lands directly under the verdict line", () => {
    const lines = renderPrBody({ ...base, routeLine: "Route: not routed (x)" }).split("\n");
    const i = lines.findIndex((l) => l.startsWith("Verdict:"));
    expect(lines[i + 1]).toBe("Route: not routed (x)");
  });
  test("receipt markdown is unchanged without a route key", () => {
    const r = { run_id: "r", base_sha: "a", head_sha: "b", receipt_sha256: "h", verification: { jwt: "", kid: "" }, provider: "claude", model: "m", verdict: "VERIFIED",
      cost: { usd: 1, partial_usd: 1, measured_sessions: 1, total_sessions: 1 }, time: { wall_s: 3 }, checks: [], evidence: [], not_proven: [] } as unknown as Receipt;
    const md = renderReceiptMd(r);
    expect(md).not.toContain("Route");
    const withRoute = renderReceiptMd({ ...r, route: buildRouteBlock(ON, "claude", { executor: "haiku" }, tel) } as unknown as Receipt);
    expect(withRoute).toContain("- Route: executor haiku-5.5, advisor opus-5.5:");
    expect(withRoute.replace(/- Route[^\n]*\n/g, "")).toBe(md);
  });

  test("router on with no telemetry: advisor tokens and request counts render as not recorded, never 0", () => {
    const b = buildRouteBlock(ON, "claude", { executor: "haiku" }, undefined)!;
    expect(b.advisor_input_tokens).toBeNull();
    expect(routePrLine(b)).toBe("Route: executor haiku-5.5, advisor opus-5.5; advisor tokens not recorded in / not recorded out; over 100K: not recorded");
    expect(routeReceiptLines(b).join("\n")).toContain("Route advisor: not recorded calls, not recorded in / not recorded out tokens");
    expect(routeReceiptLines(b).join("\n")).toContain("Route requests over 100K: not recorded");
  });
});
