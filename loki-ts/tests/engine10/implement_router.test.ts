// ROUTER-1 R1-11: routed executor in implement, triggers b (LOKI_ESCALATE) and c (SPEC_CONFLICT), per-unit ladder, start on haiku or sonnet.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { climb } from "../../src/runner/model_rank.ts";
import type { RunContext, SessionResult, SessionRunOptions, StageName } from "../../src/engine10/types.ts";

const saved = process.env["LOKI_ROUTER"];
afterEach(() => { rmSync(join(tmpdir(), "loki-r11-run"), { recursive: true, force: true }); if (saved === undefined) delete process.env["LOKI_ROUTER"]; else process.env["LOKI_ROUTER"] = saved; });

const ok: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
const esc: SessionResult = { ...ok, markers: { done: true, alreadyDone: null, specConflict: null, escalate: "advisor: too subtle" } };
const conflict: SessionResult = { ...ok, markers: { done: false, alreadyDone: null, specConflict: "spec says A and B" } };

// A valid Opus route record (R1-10 parseUnits output): every unit haiku with a reason, nothing NOT PROVEN.
const HAIKU_PLAN = { units: [{ id: "u1", kind: "impl", executor: "haiku", reason: "mechanical rename" }], route_not_proven: [] };

function run(results: SessionResult[], plan: Record<string, unknown> | undefined, model = "claude (provider default)") {
  const calls: SessionRunOptions[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const outputs: Partial<Record<StageName, Record<string, unknown>>> = { intake: { task: "t" }, ...(plan ? { plan } : {}) };
  const ctx = {
    runId: "e10-r11", repoDir: "/nonexistent-r11", runDir: join(tmpdir(), "loki-r11-run"), baseSha: "x", branch: "b", provider: "claude", model, deep: false, capS: 900,
    emit: (type: string, _s: unknown, data: Record<string, unknown>) => events.push({ type, data }),
    sessions: { async run(o: SessionRunOptions) { calls.push({ ...o }); return results[Math.min(calls.length - 1, results.length - 1)]!; } },
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
    cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
    clock: { now: () => 0 }, outputs: () => outputs,
  } as unknown as RunContext;
  return implementStage.run(ctx, new AbortController().signal).then((r) => ({ r, calls, events }));
}

describe("R1-11 routed implement", () => {
  test("flag on, haiku route: route event carries source; LOKI_ESCALATE switches the rest of the run to sonnet", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { r, calls, events } = await run([esc, ok], HAIKU_PLAN);
    expect(events.find((e) => e.type === "route")?.data).toMatchObject({ unit: "run", source: "opus-plan" });
    expect(calls[0]!.model).toMatch(/haiku/);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.model).toMatch(/sonnet/);
    expect(r.data["route_model"]).toMatch(/sonnet/);
    expect(events.find((e) => e.type === "route.escalated")?.data).toMatchObject({ trigger: "escalate_marker", unit: "run" });
  });
  test("an invalid or legacy route record never starts the run below its model", async () => {
    process.env["LOKI_ROUTER"] = "1";
    for (const plan of [{ route: { executor: "haiku" } }, { units: [{ id: "u1", kind: "impl", executor: "haiku", reason: "" }] }, { ...HAIKU_PLAN, route_not_proven: ["u1"] }]) {
      const { calls } = await run([ok], plan);
      expect(calls[0]!.model).toMatch(/sonnet/);
    }
  });
  test("SPEC_CONFLICT on haiku retries once on sonnet; sonnet agreeing stays BLOCKED (spec_conflict)", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { r, calls } = await run([conflict, conflict, conflict], HAIKU_PLAN);
    expect(calls[0]!.model).toMatch(/haiku/);
    expect(calls[1]!.model).toMatch(/sonnet/);
    expect(calls.slice(1).every((c) => !/opus/.test(c.model ?? ""))).toBe(true);
    expect(r.data["exit"]).toBe("spec_conflict");
  });
  test("SPEC_CONFLICT disproved by sonnet completes the stage as done", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { r } = await run([conflict, ok], HAIKU_PLAN);
    expect(r.data["exit"]).toBe("done");
  });
  test("a run that starts on sonnet climbs straight to opus on the marker", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { calls } = await run([esc, ok], undefined);
    expect(calls[0]!.model).toMatch(/sonnet/);
    expect(calls[1]!.model).toMatch(/opus/);
  });
  test("SPEC_CONFLICT on sonnet is not a climb", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { calls } = await run([conflict], undefined);
    expect(calls.some((c) => /opus/.test(c.model ?? ""))).toBe(false);
  });
  test("a harness/provider error exit never escalates", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { r, calls } = await run([{ ...ok, exit: 1 }], HAIKU_PLAN);
    expect(calls).toHaveLength(1);
    expect(r.status).toBe("failed");
  });
  test("flag off: one session, no model pin, no route data", async () => {
    delete process.env["LOKI_ROUTER"];
    const { r, calls, events } = await run([esc], HAIKU_PLAN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBeUndefined();
    expect(events.some((e) => e.type === "route" || e.type === "route.escalated")).toBe(false);
    expect("route_model" in r.data).toBe(false);
  });
});

describe("R1-12 ladder", () => {
  test("climb is per unit, one rung, never above opus, harness-neutral", () => {
    expect(climb("u1", "haiku", "code_fail", "e")?.to).toMatch(/sonnet/);
    expect(climb("u1", "sonnet", "code_fail", "e")?.to).toMatch(/opus/);
    expect(climb("u1", "claude-opus-5-5", "stall", "e")).toBeNull();
    expect(climb("u1", "sonnet", "spec_conflict", "e")).toBeNull();
    expect(climb("u2", "haiku", "spec_conflict", "e")?.unit).toBe("u2");
  });
});
