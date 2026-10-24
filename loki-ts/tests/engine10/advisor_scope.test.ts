// CH-02: the advisor attaches only to stages Opus marks (plan, fix). Every other stage child env carries LOKI_ADVISOR_SCOPE=off,
// which the probe reads as advisor-unavailable (executor stays Sonnet, never Haiku).
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { advisorPair, probeAdvisor } from "../../src/runner/router/advisor_probe.ts";
import { planRouterSession } from "../../src/runner/providers.ts";
import { advisorOnlyEnabled } from "../../src/runner/router/flag.ts";
import { routerTelemetryOn } from "../../src/engine10/cost.ts";
import type { SessionRunOptions } from "../../src/engine10/types.ts";

const KEYS = ["LOKI_ROUTER", "LOKI_ADVISOR_SCOPE", "SESSION_TEST_ENV_FILE"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const opts = (stage: string): SessionRunOptions => ({ stage: stage as SessionRunOptions["stage"], brief: "b", tier: "development", iterationId: "e10-r-1", limitS: 20, signal: new AbortController().signal });

async function scopeSeenBy(stage: string, router: string | undefined): Promise<string> {
  if (router === undefined) delete process.env["LOKI_ROUTER"]; else process.env["LOKI_ROUTER"] = router;
  delete process.env["LOKI_ADVISOR_SCOPE"];
  const dir = mkdtempSync(join(tmpdir(), "loki-ch02-"));
  try {
    const file = join(dir, "env.txt");
    process.env["SESSION_TEST_ENV_FILE"] = file;
    await createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", `printf '%s' "\${LOKI_ADVISOR_SCOPE-unset}" > "$SESSION_TEST_ENV_FILE"`]] }).run(opts(stage));
    return readFileSync(file, "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("CH-02 child env scope", () => {
  for (const stage of ["implement", "wall", "intake", "project-model"]) {
    test(`${stage} carries scope=off with the router on`, async () => { expect(await scopeSeenBy(stage, "1")).toBe("off"); });
  }
  for (const stage of ["plan", "fix"]) {
    test(`${stage} does not carry scope=off`, async () => { expect(await scopeSeenBy(stage, "1")).toBe("unset"); });
  }
  test("router unset or 0: no stage env changes (opt-out golden stays byte-identical)", async () => {
    for (const r of [undefined, "0"]) for (const stage of ["implement", "wall", "plan"]) expect(await scopeSeenBy(stage, r)).toBe("unset");
  });
});

describe("CH-02 probe", () => {
  const base = { LOKI_ADVISOR_SCOPE: "off" };
  test("scope=off is unavailable with the exact reason", () => {
    expect(probeAdvisor(base, "claude", "2.1.300", "/nonexistent", advisorPair({}))).toEqual({ available: false, reason: "advisor not marked for this stage" });
  });
  test("scope unset stays available", () => {
    expect(probeAdvisor({}, "claude", "2.1.300", "/nonexistent", advisorPair({})).available).toBe(true);
  });
  test("an unmarked stage gets Sonnet, never Haiku, with no advisor settings", () => {
    const p = planRouterSession({ model: "haiku", runDir: "/nonexistent", claudeCodeVersion: "2.1.300", env: { LOKI_ROUTER: "1", ...base } });
    expect(p?.model).toBe("sonnet");
    expect(p?.settings).toBeUndefined();
  });
  test("a Sonnet executor with the advisor attached runs at medium effort; others carry no override", () => {
    const env = { LOKI_ROUTER: "1" };
    expect(planRouterSession({ model: "sonnet", runDir: "/nonexistent", claudeCodeVersion: "2.1.300", env })?.effort).toBe("medium");
    expect(planRouterSession({ model: "opus", runDir: "/nonexistent", claudeCodeVersion: "2.1.300", env })?.effort).toBeUndefined();
    expect(planRouterSession({ model: "sonnet", runDir: "/nonexistent", claudeCodeVersion: "2.1.300", env: { ...env, LOKI_ADVISOR_SCOPE: "off" } })?.effort).toBeUndefined();
  });
});

describe("advisor alone (#246): LOKI_ADVISOR=1 measures the advisor without the router", () => {
  const plan = (env: Record<string, string>, model = "sonnet") => planRouterSession({ model, runDir: "/nonexistent", claudeCodeVersion: "2.1.300", env });
  test("both flags unset: nothing added (default stays off until the parity run proves it)", () => {
    expect(plan({})).toBeNull();
    expect(advisorOnlyEnabled({})).toBe(false);
  });
  test("LOKI_ADVISOR=1 attaches the advisor and keeps the caller's model, even Haiku, with no compact window", () => {
    for (const m of ["haiku", "sonnet"]) {
      const p = plan({ LOKI_ADVISOR: "1" }, m);
      expect(p?.model).toBe(m);
      expect(p?.settings).toEqual({ advisorModel: "opus" });
    }
  });
  test("LOKI_ADVISOR=1 with an unavailable advisor adds nothing and never swaps the model", () => {
    expect(plan({ LOKI_ADVISOR: "1", CLAUDE_CODE_USE_BEDROCK: "1" }, "haiku")).toBeNull();
  });
  test("LOKI_ADVISOR=0 and LOKI_ROUTER_ADVISOR=off both win over LOKI_ADVISOR=1", () => {
    expect(plan({ LOKI_ADVISOR: "0" })).toBeNull();
    expect(plan({ LOKI_ADVISOR: "1", LOKI_ROUTER_ADVISOR: "off" })).toBeNull();
  });
  test("the executor pair is checked on the advisor-only path too: an advisor weaker than its executor adds nothing", () => {
    expect(plan({ LOKI_ADVISOR: "1" }, "fable")).toBeNull();
    expect(plan({ LOKI_ROUTER: "1", LOKI_ADVISOR: "1" }, "fable")?.advisorReason).toContain("invalid_pair");
  });
  test("advisor telemetry is recorded when the advisor runs alone, and only then or with the router", () => {
    expect(routerTelemetryOn({ LOKI_ADVISOR: "1" })).toBe(true);
    expect(routerTelemetryOn({ LOKI_ROUTER: "1" })).toBe(true);
    expect(routerTelemetryOn({})).toBe(false);
    expect(routerTelemetryOn({ LOKI_ADVISOR: "0" })).toBe(false);
  });
  test("router on keeps the router plan (compact window for haiku)", () => {
    expect(plan({ LOKI_ROUTER: "1", LOKI_ADVISOR: "1" }, "haiku")?.settings).toEqual({ advisorModel: "opus", autoCompactWindow: 100000 });
  });
});
