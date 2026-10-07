import { describe, expect, test } from "bun:test";
import { defaultRoute, nextState, parseRoute, parseUnits, resolveExecutor, unitRedo, wallReviewRequired, type EscalationAction, type EscalationEvent, type ExecState } from "../../src/runner/router/decision.ts";
import { routerEnabled, routerMode } from "../../src/runner/router/flag.ts";

const H: ExecState = { model: "haiku", swapped: false };
const S: ExecState = { model: "sonnet", swapped: true };
const O: ExecState = { model: "opus", swapped: true };
const good = { executor: "haiku", reason: "small change", risk: "low", source: "advisor" } as const;

describe("escalation table (4.3)", () => {
  const rows: Array<[string, ExecState, EscalationEvent, ExecState["model"], EscalationAction]> = [
    ["haiku a", H, { kind: "code_fail_repeat" }, "sonnet", "swap-sonnet"],
    ["haiku b", H, { kind: "escalate_marker" }, "sonnet", "swap-sonnet"],
    ["haiku c spec_conflict", H, { kind: "spec_conflict" }, "sonnet", "swap-sonnet-retry"],
    ["haiku c stall", H, { kind: "stall" }, "sonnet", "swap-sonnet-retry"],
    ["haiku c limit kill", H, { kind: "limit_kill" }, "sonnet", "swap-sonnet-retry"],
    ["sonnet a", S, { kind: "code_fail_repeat" }, "opus", "fix-on-opus"],
    ["sonnet stall", S, { kind: "stall" }, "opus", "fix-on-opus"],
    ["sonnet spec_conflict stays blocked", S, { kind: "spec_conflict" }, "sonnet", "blocked"],
    ["sonnet marker no-op", S, { kind: "escalate_marker" }, "sonnet", "none"],
    ["opus a stalls", O, { kind: "code_fail_repeat" }, "opus", "stalled"],
    ["opus stall stalls", O, { kind: "stall" }, "opus", "stalled"],
  ];
  for (const [name, from, ev, model, action] of rows) {
    test(name, () => { const t = nextState(from, ev); expect(t.state.model).toBe(model); expect(t.action).toBe(action); });
  }
  for (const owner of ["harness", "env", "provider", "code"] as const) {
    for (const st of [H, S, O]) test(`ERROR owner ${owner} on ${st.model} causes no transition`, () => {
      const t = nextState(st, { kind: "error", owner }); expect(t.state).toEqual(st); expect(t.action).toBe("none");
    });
  }
  test("haiku -> sonnet is a single swap", () => {
    const a = nextState(H, { kind: "code_fail_repeat" });
    expect(a.state).toEqual({ model: "sonnet", swapped: true });
    const b = nextState(a.state, { kind: "escalate_marker" });
    expect(b.state).toEqual(a.state); expect(b.action).toBe("none");
  });
});

describe("parseRoute (4.1)", () => {
  test("valid JSON string and plan-scope shape", () => {
    expect(parseRoute(JSON.stringify(good), true)).toEqual({ route: good, notProven: null });
    expect(parseRoute({ route: good }, true).route).toEqual(good);
  });
  const bads: Array<[string, unknown]> = [["invalid JSON", "{nope"], ["missing", undefined], ["bad executor", { ...good, executor: "opus" }], ["bad risk", { ...good, risk: "x" }], ["long reason", { ...good, reason: "x".repeat(201) }], ["bad source", { ...good, source: "default" }]];
  for (const [name, bad] of bads) {
    test(`${name} -> default + NOT PROVEN`, () => {
      const p = parseRoute(bad, true);
      expect(p.route).toEqual(defaultRoute(true)); expect(p.route.executor).toBe("sonnet"); expect(p.route.source).toBe("default");
      expect(p.notProven).toContain("NOT PROVEN");
    });
  }
  test("invalid JSON with advisor unavailable defaults to sonnet", () => {
    expect(parseRoute("garbage", false).route.executor).toBe("sonnet");
  });
});

describe("resolveExecutor (4.4, 4.6)", () => {
  const base = { route: { ...good }, advisorAvailable: true, priorDefaultModel: "claude-opus-5-5", env: {} };
  test("no evidence gives sonnet plus the advisor", () => {
    const r = resolveExecutor(base); expect(r.model).toBe("sonnet"); expect(r.source).toBe("no-evidence");
    expect(resolveExecutor({ ...base, route: defaultRoute(true) }).model).toBe("sonnet");
  });
  test("an earned haiku listing gives haiku", () => {
    expect(resolveExecutor({ ...base, shapeDefault: "haiku" }).model).toBe("haiku");
    expect(resolveExecutor({ ...base, shapeDefault: "haiku", historyFloor: "haiku" }).model).toBe("haiku");
  });
  test("an earned listing alone does not choose haiku: Opus must route it", () => {
    expect(resolveExecutor({ ...base, route: defaultRoute(true), shapeDefault: "haiku" }).model).toBe("sonnet");
    expect(resolveExecutor({ ...base, route: { ...good, executor: "sonnet" }, shapeDefault: "haiku" }).model).toBe("sonnet");
  });
  test("an earned listing plus a tripped floor gives sonnet", () => {
    const r = resolveExecutor({ ...base, shapeDefault: "haiku", historyFloor: "sonnet" }); expect(r.model).toBe("sonnet");
  });
  test("an earned listing without the advisor still gives sonnet", () => {
    expect(resolveExecutor({ ...base, shapeDefault: "haiku", advisorAvailable: false }).model).toBe("sonnet");
  });
  test("advisor unavailable raises a haiku route to sonnet", () => {
    const r = resolveExecutor({ ...base, advisorAvailable: false }); expect(r.model).toBe("sonnet");
  });
  test("never haiku without the advisor, even from a default", () => {
    expect(resolveExecutor({ ...base, advisorAvailable: false, route: defaultRoute(false) }).model).not.toBe("haiku");
  });
  test("prior-default resolves to the LOKI_ROUTER=0 model", () => {
    const r = resolveExecutor({ ...base, shapeDefault: "prior-default", priorDefaultModel: "claude-opus-5-5" });
    expect(r.model).toBe("claude-opus-5-5"); expect(r.source).toBe("shape-default");
  });
  test("shape default sonnet raises haiku", () => expect(resolveExecutor({ ...base, shapeDefault: "sonnet" }).model).toBe("sonnet"));
  test("history floor raises haiku to sonnet", () => expect(resolveExecutor({ ...base, shapeDefault: "haiku", historyFloor: "sonnet" }).model).toBe("sonnet"));
  test("evidence only moves up: sonnet route is not lowered", () => {
    const r = resolveExecutor({ ...base, route: { ...good, executor: "sonnet" }, historyFloor: "haiku", shapeDefault: null });
    expect(r.model).toBe("sonnet");
  });
  test("prior-default below the route does not lower it", () => {
    expect(resolveExecutor({ ...base, route: { ...good, executor: "sonnet" }, shapeDefault: "prior-default", priorDefaultModel: "claude-haiku-4-5" }).model).toBe("sonnet");
  });
  test("explicit override wins", () => expect(resolveExecutor({ ...base, env: { LOKI_MODEL_OVERRIDE: "opus" } })).toEqual({ model: "opus", source: "override", reason: "explicit model override" }));
});

describe("flag", () => {
  test("unset is off in this build", () => { expect(routerMode({})).toBe("off"); expect(routerEnabled({})).toBe(false); });
  test("0 opts out, 1 enables", () => { expect(routerMode({ LOKI_ROUTER: "0" })).toBe("opt-out"); expect(routerEnabled({ LOKI_ROUTER: "1" })).toBe(true); });
});

describe("per-unit routes (step 2)", () => {
  const u = (id: string, executor: string, extra: object = {}) => ({ id, kind: "free text", executor, reason: "why", ...extra });
  test("valid units pass through", () => {
    const p = parseUnits({ default: "sonnet", units: [u("a", "haiku"), u("b", "sonnet")] }, true);
    expect(p.units.map((x) => x.executor)).toEqual(["haiku", "sonnet"]); expect(p.notProven).toEqual([]);
  });
  test("an invalid unit becomes sonnet with NOT PROVEN", () => {
    const p = parseUnits({ units: [u("a", "opus"), { id: "b" }, u("c", "haiku", { reason: "" })] }, true);
    expect(p.units.every((x) => x.executor === "sonnet")).toBe(true); expect(p.notProven.length).toBe(3);
  });
  test("missing or non-JSON units -> empty + NOT PROVEN", () => {
    expect(parseUnits({}, true).notProven.length).toBe(1);
    expect(parseUnits("{bad", true).notProven.length).toBe(1);
  });
  test("advisor unavailable raises haiku units to sonnet", () => {
    expect(parseUnits({ units: [u("a", "haiku")] }, false).units[0]!.executor).toBe("sonnet");
  });
  test("code-owned failure redoes a haiku unit on sonnet; other owners never escalate", () => {
    expect(unitRedo("haiku", "code")).toBe("redo-sonnet");
    for (const o of ["harness", "env", "provider"] as const) expect(unitRedo("haiku", o)).toBe("none");
    expect(unitRedo("sonnet", "code")).toBe("none");
  });
  test("wall on haiku requires an Opus review; wall on sonnet does not", () => {
    expect(wallReviewRequired(parseUnits({ units: [u("wall", "haiku")] }, true).units)).toBe(true);
    expect(wallReviewRequired(parseUnits({ units: [u("wall", "sonnet"), u("x", "haiku")] }, true).units)).toBe(false);
  });
});
