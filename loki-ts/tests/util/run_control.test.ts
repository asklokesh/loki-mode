import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseTimeoutMs, readRunControl, runControlBoundary, writeRunControl } from "../../src/util/run_control.ts";
import { runMachine } from "../../src/engine10/machine.ts";
import type { RunContext, Stage, StageName } from "../../src/engine10/types.ts";
import { runControlVerb } from "../../src/commands/run_status.ts";

const mk = (): string => mkdtempSync(join(tmpdir(), "loki-run.rc-"));
const rec = (): { ev: string[]; emit: (t: string) => void } => { const ev: string[] = []; return { ev, emit: (t) => { ev.push(t); } }; };

describe("run_control", () => {
  it("writes a request that reads back", () => {
    const d = mk();
    try {
      writeRunControl(d, "pause", 5);
      expect(readRunControl(d)).toBe("pause");
      expect(JSON.parse(readFileSync(join(d, "control-request.json"), "utf8")).ts).toBe(5);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("ignores an unknown or malformed request", async () => {
    const d = mk();
    try {
      writeFileSync(join(d, "control-request.json"), JSON.stringify({ action: "explode" }));
      expect(readRunControl(d)).toBeNull();
      const r = rec();
      expect(await runControlBoundary(d, r.emit)).toBe(false);
      writeFileSync(join(d, "control-request.json"), "{not json");
      expect(readRunControl(d)).toBeNull();
      expect(r.ev).toEqual([]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("cancel at a boundary records cancel_requested then cancel_effective", async () => {
    const d = mk();
    try {
      writeRunControl(d, "cancel");
      const r = rec();
      expect(await runControlBoundary(d, r.emit)).toBe(true);
      expect(r.ev).toEqual(["cancel_requested", "cancel_effective"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("pause waits at the boundary until resume, then continues", async () => {
    const d = mk();
    try {
      writeRunControl(d, "pause");
      const r = rec(); let n = 0;
      const sleep = async (): Promise<void> => { if (++n === 2) writeRunControl(d, "resume"); };
      expect(await runControlBoundary(d, r.emit, sleep)).toBe(false);
      expect(n).toBe(2);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("cancel while paused cancels", async () => {
    const d = mk();
    try {
      writeRunControl(d, "pause");
      const r = rec();
      const sleep = async (): Promise<void> => { writeRunControl(d, "cancel"); };
      expect(await runControlBoundary(d, r.emit, sleep)).toBe(true);
      expect(r.ev).toEqual(["cancel_requested", "cancel_effective"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("runControlVerb writes into the newest run dir", () => {
    const d = mk();
    try {
      mkdirSync(join(d, "runs", "e10-a"), { recursive: true });
      expect(runControlVerb("cancel", { LOKI_DIR: d } as NodeJS.ProcessEnv, d)).toBe(0);
      expect(readRunControl(join(d, "runs", "e10-a"))).toBe("cancel");
      expect(runControlVerb("cancel", { LOKI_DIR: join(d, "none") } as NodeJS.ProcessEnv, d)).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("engine honours a cancel at the first non-tail boundary, cancel events in order", async () => {
    const d = mk();
    try {
      writeRunControl(d, "cancel");
      const events: { type: string; stage: StageName | null }[] = [];
      const ctx = {
        runId: "e10-t", repoDir: d, runDir: d, baseSha: "a", branch: "b", provider: "claude", model: "f", deep: false, capS: 900,
        emit: (type: string, stage: StageName | null) => { events.push({ type, stage }); },
        sessions: { run: async () => { throw new Error("none"); } },
        tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
        cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
        clock: { now: () => Date.now() }, outputs: () => ({}),
      } as unknown as RunContext;
      const st = (name: StageName): Stage => ({ name, targetS: 1, limitS: 5, run: async () => ({ status: "completed", data: {} }) });
      const r = await runMachine(ctx, { load: async (n) => st(n) });
      const types = events.map((e) => e.type);
      expect(r.stopped).toBe("cancelled by request");
      expect(types.indexOf("cancel_requested")).toBeGreaterThanOrEqual(0);
      expect(types.indexOf("cancel_effective")).toBe(types.indexOf("cancel_requested") + 1);
      expect(events.filter((e) => e.type === "stage.completed" && e.stage === "implement").length).toBe(0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("loki pause|resume|cancel dispatch (P12-10b)", () => {
  const withRun = (events: string): { d: string; run: string } => {
    const d = mk(), run = join(d, "runs", "e10-a");
    mkdirSync(run, { recursive: true });
    if (events) writeFileSync(join(run, "events.jsonl"), events);
    return { d, run };
  };
  const done = JSON.stringify({ v: 1, seq: 1, ts: "2026-01-01T00:00:00.000Z", type: "run.completed", stage: null, data: {}, run: "e10-a" }) + "\n";
  it("refuses to pause or cancel a run that already completed", () => {
    const { d, run } = withRun(done);
    try {
      const env = { LOKI_DIR: d } as NodeJS.ProcessEnv;
      expect(runControlVerb("pause", env, d)).toBe(1);
      expect(runControlVerb("cancel", env, d)).toBe(1);
      expect(readRunControl(run)).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("resume needs a pending pause", () => {
    const { d, run } = withRun("");
    try {
      const env = { LOKI_DIR: d } as NodeJS.ProcessEnv;
      expect(runControlVerb("resume", env, d)).toBe(1);
      expect(runControlVerb("pause", env, d)).toBe(0);
      expect(readRunControl(run)).toBe("pause");
      expect(runControlVerb("resume", env, d)).toBe(0);
      expect(readRunControl(run)).toBe("resume");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("cli.ts and the registry route the three verbs to Bun", async () => {
    const { findCommand } = await import("../../src/cli/registry.ts");
    for (const v of ["pause", "resume", "cancel"]) expect(findCommand(v)?.where).not.toBe("bash");
    expect(readFileSync(join(import.meta.dir, "../../src/cli.ts"), "utf8")).toContain('case "cancel":');
  });
});

describe("run_control pause liveness (P12-10b)", () => {
  it("a paused run whose process is dead stops instead of polling forever", async () => {
    const d = mk();
    try {
      writeRunControl(d, "pause");
      const r = rec(); let n = 0;
      expect(await runControlBoundary(d, r.emit, { sleep: async () => { n++; }, alive: () => n < 2, timeoutMs: 0 })).toBe(true);
      expect(n).toBe(2);
      expect(r.ev).toEqual(["cancel_requested", "cancel_effective"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("a pause past the timeout stops", async () => {
    const d = mk();
    try {
      writeRunControl(d, "pause");
      const r = rec(); let t = 0;
      expect(await runControlBoundary(d, r.emit, { sleep: async () => { t += 400; }, alive: () => true, timeoutMs: 1000, now: () => t })).toBe(true);
      expect(t).toBe(1200);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("timeout env parses, 0 means unlimited", () => {
    expect(pauseTimeoutMs({ LOKI_PAUSE_TIMEOUT_S: "5" } as NodeJS.ProcessEnv)).toBe(5000);
    expect(pauseTimeoutMs({ LOKI_PAUSE_TIMEOUT_S: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(pauseTimeoutMs({} as NodeJS.ProcessEnv)).toBe(3600000);
    expect(pauseTimeoutMs({ LOKI_PAUSE_TIMEOUT_S: "x" } as NodeJS.ProcessEnv)).toBe(3600000);
  });
  it("resume before the timeout continues", async () => {
    const d = mk();
    try {
      writeRunControl(d, "pause");
      let n = 0;
      expect(await runControlBoundary(d, () => {}, { sleep: async () => { if (++n === 1) writeRunControl(d, "resume"); }, alive: () => true, timeoutMs: 1000 })).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
