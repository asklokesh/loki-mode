// ROUTER-1 R1-09: LOKI_ESCALATE marker, cost event fields, no-advisor executor pin. All inert unless LOKI_ROUTER=1.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSessionRunner } from "../../src/engine10/session.ts";
import type { SessionRunOptions } from "../../src/engine10/types.ts";

const KEYS = ["LOKI_ROUTER", "LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_MODEL_DEVELOPMENT", "SESSION_TEST_ENV_FILE"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const opts = (o: Partial<SessionRunOptions> = {}): SessionRunOptions => ({ stage: "implement", brief: "b", tier: "development", iterationId: "e10-r-1", limitS: 20, signal: new AbortController().signal, ...o });
const say = (text: string): [string, string[]] => ["bash", ["-c", `printf '%s\\n' '${text}'`]];

describe("R1-09 LOKI_ESCALATE marker", () => {
  test("flag on: parses into markers.escalate", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const r = await createSessionRunner({ provider: "claude", childCommand: say("working\nLOKI_ESCALATE: advisor says the parser is too subtle") }).run(opts());
    expect(r.markers.escalate).toBe("advisor says the parser is too subtle");
    expect(r.markers.done).toBe(true);
  });
  test("flag off or 0: the marker is ignored and the shape is unchanged", async () => {
    for (const v of [undefined, "0"]) {
      if (v === undefined) delete process.env["LOKI_ROUTER"]; else process.env["LOKI_ROUTER"] = v;
      const r = await createSessionRunner({ provider: "claude", childCommand: say("LOKI_ESCALATE: x") }).run(opts());
      expect(r.markers).toEqual({ done: true, alreadyDone: null, specConflict: null });
      expect("escalate" in r.markers).toBe(false);
    }
  });
  test("prose that merely names the marker does not count", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const r = await createSessionRunner({ provider: "claude", childCommand: say("I will not emit LOKI_ESCALATE: here") }).run(opts());
    expect(r.markers.escalate).toBeUndefined();
  });
});

describe("R1-09 cost event fields", () => {
  const withCost = async (flag: string | undefined) => {
    if (flag === undefined) delete process.env["LOKI_ROUTER"]; else process.env["LOKI_ROUTER"] = flag;
    const dir = mkdtempSync(join(tmpdir(), "loki-r109-"));
    try {
      mkdirSync(join(dir, "metrics"), { recursive: true });
      writeFileSync(join(dir, "metrics", "result-cost-e10-r-1.json"), JSON.stringify({ total_cost_usd: 0.01, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, model: "m", requests_total: 7, requests_over_100k: 1, advisor_calls: 2, advisor_input_tokens: 300, advisor_output_tokens: 40 }));
      const events: { type: string; data: Record<string, unknown> }[] = [];
      await createSessionRunner({ provider: "claude", lokiRoot: dir, childCommand: say("ok"), emit: (type, _s, data) => events.push({ type, data }) }).run(opts({ cwd: dir }));
      return events.find((e) => e.type === "cost")!.data;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  test("flag on: cost event carries the R1-08 fields", async () => {
    const d = await withCost("1");
    expect(d["requests_total"]).toBe(7);
    expect(d["requests_over_100k"]).toBe(1);
    expect(d["advisor_input_tokens"]).toBe(300);
    expect(d["advisor_output_tokens"]).toBe(40);
    expect(d["advisor_calls"]).toBe(2);
  });
  test("flag off: cost event keys are exactly the pre-router set", async () => {
    const d = await withCost(undefined);
    expect(Object.keys(d).sort()).toEqual(["cache_creation_tokens", "cache_read_tokens", "input_tokens", "model", "output_tokens", "session_id", "source", "usd"]);
  });
});

describe("R1-09 no-advisor executor pin", () => {
  const envOf = async (cfgAdvisor: { available: boolean } | undefined, o: Partial<SessionRunOptions> = {}): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "loki-r109e-"));
    try {
      const f = join(dir, "env.txt");
      process.env["SESSION_TEST_ENV_FILE"] = f;
      await createSessionRunner({ provider: "claude", ...(cfgAdvisor ? { advisor: cfgAdvisor } : {}), childCommand: ["bash", ["-c", `env > "$SESSION_TEST_ENV_FILE"`]] }).run(opts(o));
      return readFileSync(f, "utf8");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  test("flag on + advisor unavailable: development tier pins sonnet", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const e = await envOf({ available: false });
    expect(e).toMatch(/^LOKI_CLAUDE_MODEL_DEVELOPMENT=.*sonnet/m);
    expect(e).not.toContain("LOKI_E10_MODEL_DEFAULT=1");
  });
  test("advisor available, flag off, or an explicit pin: no sonnet pin added", async () => {
    process.env["LOKI_ROUTER"] = "1";
    expect(await envOf({ available: true })).not.toMatch(/^LOKI_CLAUDE_MODEL_DEVELOPMENT=/m);
    expect(await envOf({ available: true }, { model: "claude-haiku-5-5" })).toMatch(/^LOKI_CLAUDE_MODEL_DEVELOPMENT=claude-haiku-5-5$/m);
    expect(await envOf({ available: false }, { model: "claude-opus-5-5" })).toMatch(/^LOKI_CLAUDE_MODEL_DEVELOPMENT=claude-opus-5-5$/m);
    // R1-09 floor (section 4.4): a per-call haiku pin is raised to sonnet when the advisor is unavailable, so a routed unit cannot bypass it.
    expect(await envOf({ available: false }, { model: "claude-haiku-5-5" })).toMatch(/^LOKI_CLAUDE_MODEL_DEVELOPMENT=.*sonnet/m);
    expect(await envOf({ available: false }, { model: "claude-haiku-5-5" })).not.toContain("haiku");
    process.env["LOKI_CLAUDE_MODEL_DEVELOPMENT"] = "opus";
    expect(await envOf({ available: false })).toMatch(/^LOKI_CLAUDE_MODEL_DEVELOPMENT=opus$/m);
    delete process.env["LOKI_CLAUDE_MODEL_DEVELOPMENT"];
    delete process.env["LOKI_ROUTER"];
    expect(await envOf({ available: false })).not.toMatch(/^LOKI_CLAUDE_MODEL_DEVELOPMENT=/m);
  });
});
