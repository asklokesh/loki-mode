// R1-21 (docs/v11/ROUTER-1.md section 6): the opt-out golden. Fixture pre_router_models.json was captured from the
// 11.0.3 code BEFORE any router slice merged. LOKI_ROUTER=0 (and, until R1-19 flips the default, LOKI_ROUTER unset)
// must reproduce it exactly: per stage the model passed to sessions.run, the child-env model variables, the SDK
// query options (model, fallbackModel, settings), the downgrade list, the start line and the run.started data.
// Regenerate deliberately with LOKI_GOLDEN_UPDATE=1 only when pre-router behavior is meant to change.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sdkQueryProvider } from "../../src/runner/providers.ts";
import { modelDowngrades } from "../../src/runner/model_downgrades.ts";
import { checkAlreadyDone } from "../../src/engine10/already_done.ts";
import { buildRepoMap } from "../../src/engine10/repomap.ts";
import { buildTestMap } from "../../src/engine10/testmap.ts";
import { createSessionRunner, resolveModel } from "../../src/engine10/session.ts";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { planStage } from "../../src/engine10/stages/plan.ts";
import { runWall } from "../../src/engine10/stages/wall.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner, StageName } from "../../src/engine10/types.ts";

const LOKI_TS = resolve(import.meta.dir, "../..");
const E2E = join(import.meta.dir, "fixtures", "e2e");
const FIXTURE = join(import.meta.dir, "fixtures", "pre_router_models.json");
const ALREADY_DONE_REPO = join(import.meta.dir, "fixtures", "intake", "already-done-repo");

const MATRIX: { name: string; env: Record<string, string> }[] = [
  { name: "default", env: {} },
  { name: "cascade", env: { LOKI_E10_CASCADE: "1" } },
  { name: "wall_tier_haiku", env: { LOKI_E10_WALL_TIER: "haiku" } },
  { name: "allow_haiku", env: { LOKI_ALLOW_HAIKU: "true" } },
  { name: "model_override_sonnet", env: { LOKI_MODEL_OVERRIDE: "sonnet" } },
  { name: "development_opus", env: { LOKI_CLAUDE_MODEL_DEVELOPMENT: "opus" } },
  { name: "plan_always", env: { LOKI_E10_PLAN: "always" } },
];

let scratch: string;
let alreadyDoneRepo: string;
let sdkSeen: { options: Record<string, unknown> } | undefined;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-r1-21-"));
  alreadyDoneRepo = join(scratch, "already-done-repo");
  mkdirSync(alreadyDoneRepo);
  cpSync(ALREADY_DONE_REPO, alreadyDoneRepo, { recursive: true });
  const git = (...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd: alreadyDoneRepo }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  git("init", "-q"); git("config", "user.name", "golden"); git("config", "user.email", "golden@example.invalid"); git("add", "-A"); git("commit", "-q", "-m", "base");
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: (args: { options: Record<string, unknown> }) => {
      sdkSeen = args;
      return (async function* () { yield { type: "result", is_error: false, total_cost_usd: 0, usage: {}, session_id: "golden-sess" }; })();
    },
  }));
});
afterAll(() => { mock.restore(); rmSync(scratch, { recursive: true, force: true }); });

const MODEL_ENV = /^LOKI_(CLAUDE_)?MODEL_|^LOKI_E10_MODEL_DEFAULT$/;
const sortedPick = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([k, v]) => MODEL_ENV.test(k) && v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)) as [string, string][]);

/** Runs `fn` with process.env replaced by `env`, then restores the original. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const snap = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try { return await fn(); } finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, snap); }
}
const baseEnv = (extra: Record<string, string>): Record<string, string | undefined> => {
  const e: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("LOKI_") || k === "ANTHROPIC_API_KEY" || k === "OPENAI_API_KEY" || k.startsWith("CLAUDE_CODE_USE_") || k === "ANTHROPIC_BASE_URL") delete e[k];
  return { ...e, LOKI_NO_BROWSER: "1", ...extra };
};

interface CallRecord { stage: string; tier: string; model_arg: string | null; child_env: Record<string, string>; sdk: { model: string; fallbackModel: string | null; settings: unknown } }

/** The real session runner's child env, then the real sdkQueryProvider options for that same env (SDK mocked). */
function recordingRunner(calls: CallRecord[], dir: string): SessionRunner {
  const dump = join(dir, "child-env.json");
  const real = createSessionRunner({ provider: "claude", childCommand: [process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env))`]] });
  return {
    async run(opts: SessionRunOptions): Promise<SessionResult> {
      const res = await real.run(opts);
      const childEnv = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
      const cwd = mkdtempSync(join(dir, "sdk-"));
      sdkSeen = undefined;
      await withEnv(childEnv, async () => {
        await sdkQueryProvider().invoke({ provider: "claude", prompt: "p", tier: opts.tier, cwd, iterationOutputPath: join(cwd, "out.txt"), mainLoop: true } as never);
      });
      const o = (sdkSeen as { options: Record<string, unknown> } | undefined)?.options ?? {};
      calls.push({
        stage: opts.stage, tier: String(opts.tier), model_arg: opts.model ?? null, child_env: sortedPick(childEnv),
        sdk: { model: typeof o["model"] === "string" ? (o["model"] as string) : "<unset>", fallbackModel: typeof o["fallbackModel"] === "string" ? (o["fallbackModel"] as string) : null, settings: o["settings"] ?? null },
      });
      return res;
    },
  };
}

function ctxFor(sessions: SessionRunner, outputs: Partial<Record<StageName, Record<string, unknown>>>, dir: string): RunContext {
  return {
    runId: "golden-1", repoDir: alreadyDoneRepo, runDir: dir, baseSha: "abc", branch: "loki/golden-1", provider: "claude", model: resolveModel("claude"), deep: false, capS: 900, emit: () => {},
    sessions, tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) }, clock: { now: () => 0 },
    outputs: () => outputs,
  } as unknown as RunContext;
}

const TASK = "Add global search (Cmd+K)";
const GROUPS = [{ signature: "bun:a.test.ts", count: 1, sample: "FULL OUTPUT" }];

async function captureStages(extra: Record<string, string>): Promise<Record<string, unknown>> {
  return withEnv(baseEnv(extra), async () => {
    const dir = mkdtempSync(join(scratch, "stages-"));
    const stages: Record<string, unknown> = {};
    const run = async (name: string, outputs: Partial<Record<StageName, Record<string, unknown>>>, body: (ctx: RunContext) => Promise<Record<string, unknown> | void>): Promise<void> => {
      const calls: CallRecord[] = [];
      const ctx = ctxFor(recordingRunner(calls, dir), outputs, dir);
      const res = (await body(ctx)) ?? {};
      stages[name] = { calls, ...res };
    };
    const sig = new AbortController().signal;
    const intake = { intake: { task: TASK } };
    await run("plan", intake, async (c) => { const r = await planStage.run(c, sig); return { status: r.status }; });
    await run("wall", intake, async (c) => { const r = await runWall(c, sig); return { status: r.status }; });
    await run("already_done", {}, async (c) => { const r = await checkAlreadyDone(c, sig, TASK, buildRepoMap(alreadyDoneRepo), buildTestMap(alreadyDoneRepo)); return { satisfied: r?.satisfied ?? false }; });
    await run("implement", { ...intake, plan: { plan: null } }, async (c) => { const r = await implementStage.run(c, sig); return { status: r.status, result_model: r.data?.["model"] ?? null, cascade: r.data?.["cascade"] ?? null, model_downgrade: r.data?.["model_downgrade"] ?? null }; });
    await run("fix_round_1", { ...intake, verify: { failures_grouped: GROUPS } }, async (c) => { const r = await fixStage.run(c, sig); return { status: r.status, result_model: r.data?.["model"] ?? null, cascade: r.data?.["cascade"] ?? null }; });
    await run("fix_round_2_escalated", { ...intake, verify: { failures_grouped: GROUPS }, fix: { round: 1, signatures: "bun:a.test.ts", diagnosis: "d" } }, async (c) => { const r = await fixStage.run(c, sig); return { status: r.status, result_model: r.data?.["model"] ?? null, cascade: r.data?.["cascade"] ?? null }; });
    return { run_model: resolveModel("claude"), downgrades: modelDowngrades("claude", process.env), stages };
  });
}

/** The real entry (bin/loki, stub claude CLI): the start line, the run.started data and the --model per stage. */
function captureEntry(extra: Record<string, string>): Record<string, unknown> {
  const repo = mkdtempSync(join(scratch, "e2e-"));
  cpSync(join(E2E, "repo"), repo, { recursive: true });
  const git = (...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd: repo }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  git("init", "-q", "-b", "main"); git("config", "user.name", "e2e"); git("config", "user.email", "e2e@example.invalid");
  git("add", "calc.ts", "calc.test.ts", "bunfig.toml"); git("commit", "-q", "-m", "base");
  const argvLog = join(repo, "..", `${repo.split("/").pop()}-argv.log`);
  const env = baseEnv({
    LOKI_TS_ENTRY: join(LOKI_TS, "src", "cli.ts"), LOKI_E10_INVOKER: "cli", LOKI_CLAUDE_CLI: join(E2E, "bin", "claude"), E2E_STUB_MODE: "done", E2E_STUB_ARGV_LOG: argvLog,
    LOKI_E10_PLAN: "1", LOKI_RECEIPT_SIGNING_KEY_FILE: join(scratch, "k.pem"), ...extra,
  });
  env["PATH"] = `${join(E2E, "bin")}:${process.env.PATH ?? ""}`;
  const r = Bun.spawnSync(["bash", resolve(LOKI_TS, "../bin/loki"), "add a multiply(a, b) function to calc.ts", "--no-pr"], { cwd: repo, env: env as Record<string, string>, timeout: 90_000 });
  const marker = JSON.parse(readFileSync(join(repo, ".loki", "engine.json"), "utf8")) as { events: string };
  const events = readFileSync(join(repo, marker.events), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
  const started = { ...events.find((e) => e.type === "run.started")!.data };
  started["branch"] = "<branch>";
  const startLine = (r.stdout.toString().split("\n")[0] ?? "");
  const argv = existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n") : [];
  return {
    start_line: startLine,
    run_started_keys: Object.keys(started),
    run_started: started,
    // Wall and the already-done check run concurrently with Plan, so the log order is not stable: sort it.
    cli_model_flags: argv.map((l) => `${l.split(" ")[0]} ${/--model (\S+)/.exec(l)?.[1] ?? "<none>"}`).sort(),
  };
}

async function captureAll(router: "unset" | "0"): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const m of MATRIX) {
    const extra = router === "0" ? { ...m.env, LOKI_ROUTER: "0" } : m.env;
    out[m.name] = { ...(await captureStages(extra)), entry: captureEntry(extra) };
  }
  return out;
}

describe("R1-21 opt-out golden: pre-router model behavior (11.0.3)", () => {
  test("LOKI_ROUTER unset and LOKI_ROUTER=0 both equal the pre-router fixture", async () => {
    const unset = await captureAll("unset");
    if (process.env["LOKI_GOLDEN_UPDATE"] === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify({ $schema_version: 1, _source: "captured from loki-mode 11.0.3 at aaafc6921, before any router slice (R1-21)", matrix: unset }, null, 2)}\n`);
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { matrix: Record<string, unknown> };
    expect(Object.keys(fixture.matrix)).toEqual(MATRIX.map((m) => m.name));
    expect(unset).toEqual(fixture.matrix);
    expect(await captureAll("0")).toEqual(fixture.matrix);
  }, 300_000);
});
