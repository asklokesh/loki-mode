// E-14/E-42: thin-path end to end (docs/v10/ENGINE.md section 16). Runs the real
// engine from the real entry (bin/loki, LOKI_ENGINE=v10, LOKI_TS_ENTRY=src/cli.ts,
// stub claude CLI via LOKI_E10_INVOKER=cli) on a fresh copy of a tiny bun repo:
// with --no-pr, and with a local bare origin plus a canary GH_TOKEN (Rule of Two).
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "e2e");
const STUB_DIR = join(FIX, "bin");
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "cli.ts");
const CANARY = "ghp_E2ECANARYnotarealtoken0000000000000";
const TASK = "add a multiply(a, b) function to calc.ts";

const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

interface Run {
  repo: string; code: number; wallMs: number; out: string;
  events: { seq: number; type: string; stage: string | null; data: Record<string, unknown> }[];
  runDir: string; stubCalls: string[]; stubEnv: string; origin: string;
}

function runEngine(mode: "done" | "already", withPr = false): Run {
  if (!existsSync(ENTRY)) throw new Error(`engine entry missing: ${ENTRY}`); // never fall through to the legacy bash route
  const tmp = mkdtempSync(join(tmpdir(), "loki-e2e-"));
  temps.push(tmp);
  const repo = join(tmp, "repo");
  cpSync(join(FIX, "repo"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "e2e");
  git(repo, "config", "user.email", "e2e@example.invalid");
  git(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml");
  git(repo, "commit", "-q", "-m", "base");
  const origin = join(tmp, "origin.git");
  if (withPr) { // E-41 local bare origin: HEAD on main, main pushed
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
  }
  const stubLog = join(tmp, "stub.log");
  const stubEnvLog = join(tmp, "stub-env.log");
  const env: Record<string, string | undefined> = {
    ...process.env,
    LOKI_ENGINE: "v10",
    LOKI_TS_ENTRY: ENTRY,
    LOKI_E10_INVOKER: "cli",
    LOKI_CLAUDE_CLI: join(STUB_DIR, "claude"),
    PATH: `${STUB_DIR}:${process.env.PATH ?? ""}`,
    E2E_STUB_MODE: mode,
    E2E_STUB_LOG: stubLog,
    E2E_STUB_ENV_LOG: stubEnvLog,
    LOKI_NO_BROWSER: "1",
    LOKI_E10_PLAN: "1", // E-45: this fixture's task sizes "small" by default; force plan so the pipeline shape below still holds.
    GH_TOKEN: CANARY,
  };
  delete env.LOKI_ALLOW_AGENT_GITHUB_TOKEN;
  delete env.LOKI_MODEL_OVERRIDE;
  delete env.LOKI_LEGACY_BASH; // bin/loki would skip the engine10 block
  delete env.LOKI_RECEIPT_SIGNING_KEY;
  delete env.LOKI_RECEIPT_SIGNING_KEY_FILE;
  const t0 = Date.now();
  const r = Bun.spawnSync(["bash", BIN_LOKI, TASK, ...(withPr ? [] : ["--no-pr"])], { cwd: repo, env, timeout: 60_000 });
  const wallMs = Date.now() - t0;
  const out = r.stdout.toString() + r.stderr.toString();
  const marker = join(repo, ".loki", "engine.json");
  const m = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { run_id: string; events: string }) : null;
  const eventsPath = m ? join(repo, m.events) : "";
  const events = eventsPath && existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  const stubCalls = existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n") : [];
  const stubEnv = existsSync(stubEnvLog) ? readFileSync(stubEnvLog, "utf8") : "";
  return { repo, code: r.exitCode ?? -1, wallMs, out, events, runDir: m ? join(repo, ".loki", "runs", m.run_id) : "", stubCalls, stubEnv, origin };
}

describe("engine10 e2e (stub claude)", () => {
  test("done run: intake through seal, receipt, marker, efficiency record, under 60s", () => {
    const r = runEngine("done");
    if (r.code !== 0) console.error(r.out);
    expect(r.code).toBe(0);
    expect(r.wallMs).toBeLessThan(60_000);

    const completed = r.events.filter((e) => e.type === "stage.completed").map((e) => e.stage);
    // plan and wall run in parallel, so their order is free.
    expect([...completed.slice(0, 3)].sort()).toEqual(["intake", "plan", "wall"]);
    expect(completed.slice(3)).toEqual(["implement", "verify", "commit", "seal"]);
    expect(r.events.some((e) => e.type === "stage.skipped")).toBe(false);
    const seqs = r.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(r.events[0]!.type).toBe("run.started");
    expect(r.events.at(-1)!.type).toBe("run.completed");
    expect(r.events.some((e) => e.type === "receipt.sealed")).toBe(true);

    const runId = r.runDir.split("/").pop();
    const marker = JSON.parse(readFileSync(join(r.repo, ".loki", "engine.json"), "utf8"));
    expect(marker).toEqual({ engine: "v10", run_id: runId, events: `.loki/runs/${runId}/events.jsonl` });

    const receipt = JSON.parse(readFileSync(join(r.runDir, "receipt.json"), "utf8"));
    expect(receipt.verdict).toBe("VERIFIED");
    expect(receipt.checks).toEqual([expect.objectContaining({ name: "bun:calc.test.ts", result: "pass" })]);
    expect(receipt.head_sha).not.toBe(receipt.base_sha);
    expect(readFileSync(join(r.repo, "calc.ts"), "utf8")).toContain("multiply");

    const eff = readdirSync(join(r.repo, ".loki", "metrics", "efficiency")).filter((f) => /^iteration-\d+\.json$/.test(f));
    expect(eff.length).toBeGreaterThanOrEqual(1);
    expect(r.events.some((e) => e.type === "cost")).toBe(true);
    // Seal priced the run from the stages' iteration ids (never "no iteration ids recorded").
    expect(receipt.not_proven.some((n: string) => n.startsWith("cost not measured"))).toBe(false);
    expect(receipt.model).toBe("sonnet");
    expect(r.out).toContain("Verdict:    VERIFIED");
    expect(r.out).toContain("PR:         none");
  }, 90_000);

  test("already-done run seals ALREADY_SATISFIED with no second implement session", () => {
    const r = runEngine("already");
    if (r.code !== 0) console.error(r.out);
    expect(r.code).toBe(0);
    const receipt = JSON.parse(readFileSync(join(r.runDir, "receipt.json"), "utf8"));
    expect(receipt.verdict).toBe("ALREADY_SATISFIED");
    expect(receipt.head_sha).toBe(receipt.base_sha);
    expect(r.stubCalls.filter((s) => s === "implement")).toEqual(["implement"]);
    expect(r.events.some((e) => e.stage === "fix" && e.type === "stage.started")).toBe(false);
    const impl = r.events.filter((e) => e.type === "session.ended" && e.stage === "implement");
    expect(impl.length).toBe(1);
  }, 90_000);

  test("Rule of Two: the worker never sees GH_TOKEN; the pr stage runs in the supervisor", () => {
    const r = runEngine("done", true);
    if (r.code !== 0) console.error(r.out);
    expect(r.code).toBe(0);
    // The canary never reaches a provider session, and the CLI invoker is chosen without LOKI_LEGACY_BASH.
    expect(r.stubEnv).toContain("implement GH_TOKEN=ghp_LOKIWITHHELDsentinel");
    expect(r.stubEnv).not.toContain(CANARY);
    expect(r.stubEnv).not.toMatch(/LOKI_LEGACY_BASH=\S/);
    const leaked = Bun.spawnSync(["grep", "-rl", CANARY, join(r.repo, ".loki")], { env: process.env });
    expect(leaked.stdout.toString()).toBe("");
    // No stage event for pr: the worker's machine never loads it.
    expect(r.events.filter((e) => e.stage === "pr" && e.type.startsWith("stage."))).toEqual([]);
    // pr.opened is supervisor-only (a worker copy is dropped), and the branch landed on the pinned origin.
    const runId = r.runDir.split("/").pop()!;
    const opened = r.events.filter((e) => e.type === "pr.opened");
    expect(opened.map((e) => e.data.url)).toEqual([`local://${r.origin}#loki/${runId}`]);
    expect(git(r.origin, "rev-parse", `refs/heads/loki/${runId}`)).toBe(git(r.repo, "rev-parse", "HEAD"));
    expect(JSON.parse(readFileSync(join(r.runDir, "receipt.json"), "utf8")).repo).toBe(r.origin);
    const done = r.events.at(-1)!;
    expect(done.type).toBe("run.completed");
    expect(done.data.not_proven).toContain("commit status loki/deep-verify not set (local origin)");
    expect(r.out).toContain(`PR:         local://${r.origin}#loki/${runId}`);
  }, 90_000);
});
