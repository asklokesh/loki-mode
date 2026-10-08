// CH-02: the advisor attaches only to stages Opus marks (plan, fix). Every other stage child env carries LOKI_ADVISOR_SCOPE=off,
// which the probe reads as advisor-unavailable (executor stays Sonnet, never Haiku).
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { probeAdvisor } from "../../src/runner/router/advisor_probe.ts";
import { planRouterSession } from "../../src/runner/providers.ts";
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
    expect(probeAdvisor(base, "claude", "2.1.300", "/nonexistent")).toEqual({ available: false, reason: "advisor not marked for this stage" });
  });
  test("scope unset stays available", () => {
    expect(probeAdvisor({}, "claude", "2.1.300", "/nonexistent").available).toBe(true);
  });
  test("an unmarked stage gets Sonnet, never Haiku, with no advisor settings", () => {
    const p = planRouterSession({ model: "haiku", runDir: "/nonexistent", claudeCodeVersion: "2.1.300", env: { LOKI_ROUTER: "1", ...base } });
    expect(p?.model).toBe("sonnet");
    expect(p?.settings).toBeUndefined();
  });
});
