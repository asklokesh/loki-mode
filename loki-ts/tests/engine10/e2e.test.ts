// E-14/E-42: thin-path end to end (docs/v10/ENGINE.md section 16). Runs the real
// engine from the real entry (bin/loki, LOKI_TS_ENTRY=src/cli.ts,
// stub claude CLI via LOKI_E10_INVOKER=cli) on a fresh copy of a tiny bun repo:
// with --no-pr, and with a local bare origin plus a canary GH_TOKEN (Rule of Two).
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { verifyReceipt } from "../../src/engine10/verify_cmd.ts";
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
  runDir: string; key: string; stubCalls: string[]; stubEnv: string; origin: string;
}

function runEngine(mode: "done" | "already" | "tamper" | "nochange", withPr = false, extra: string[] = []): Run {
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
  const keyDir = mkdtempSync(join(tmpdir(), "e10-e2e-key-")); temps.push(keyDir);
  env.LOKI_RECEIPT_SIGNING_KEY_FILE = join(keyDir, "k.pem"); // throwaway auto-generated key, never the real ~/.loki
  const t0 = Date.now();
  const r = Bun.spawnSync(["bash", BIN_LOKI, TASK, ...(withPr ? [] : ["--no-pr"]), ...extra], { cwd: repo, env, timeout: 60_000 });
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
  return { repo, code: r.exitCode ?? -1, wallMs, out, events, runDir: m ? join(repo, ".loki", "runs", m.run_id) : "", key: env.LOKI_RECEIPT_SIGNING_KEY_FILE!, stubCalls, stubEnv, origin };
}

const verdictOf = async (r: Run, edit?: (p: { receipt: string; events: string }) => void) => {
  const receipt = join(r.runDir, "receipt.json"), events = join(r.runDir, "events.jsonl"), prev = process.env.LOKI_RECEIPT_SIGNING_KEY_FILE;
  process.env.LOKI_RECEIPT_SIGNING_KEY_FILE = r.key; edit?.({ receipt, events });
  try { return (await verifyReceipt(receipt)).verdict; } finally { if (prev === undefined) delete process.env.LOKI_RECEIPT_SIGNING_KEY_FILE; else process.env.LOKI_RECEIPT_SIGNING_KEY_FILE = prev; }
};
describe("A-117 loki verify binds the receipt to events.jsonl", () => {
  test("untampered run verifies; a run tampered during the run is TAMPERED, and removing the evidence stays TAMPERED", async () => {
    expect(await verdictOf(runEngine("done"))).toBe("VERIFIED");
    const t = runEngine("tamper");
    expect(await verdictOf(t)).toBe("TAMPERED");
    const lines = () => readFileSync(join(t.runDir, "events.jsonl"), "utf8").trim().split("\n");
    expect(await verdictOf(t, (p) => writeFileSync(p.events, lines().filter((l) => !l.includes("tamper.detected") && !l.includes("forged")).join("\n") + "\n"))).toBe("TAMPERED"); // seq gap
  }, 120_000);
  test("a deleted log, an edited log and an edited recorded hash are TAMPERED", async () => {
    const d = runEngine("done");
    expect(await verdictOf(d, (p) => writeFileSync(p.events, readFileSync(p.events, "utf8").replace('"stage":"intake"', '"stage":"intakX"')))).toBe("TAMPERED");
    expect(await verdictOf(d, (p) => writeFileSync(p.receipt, readFileSync(p.receipt, "utf8").replace(/"events_sha256": "[0-9a-f]{64}"/, `"events_sha256": "${"0".repeat(64)}"`)))).toBe("TAMPERED");
    expect(await verdictOf(runEngine("done"), (p) => rmSync(p.events))).toBe("TAMPERED");
  }, 120_000);
});
describe("engine10 e2e (stub claude)", () => {
  test("A-130 round 2: a tampered event log is TAMPERED on the receipt line, never VERIFIED, never exit 0", () => {
    const t = runEngine("tamper", false, ["--json"]);
    const j = JSON.parse(t.out.trim().split("\n").find((l) => l.startsWith("{"))!);
    expect(j.ok).toBe(false);
    expect(j.outcome).not.toBe("VERIFIED");
    expect(t.code).not.toBe(0);
    const d = runEngine("tamper");
    expect(d.out).toMatch(/^Receipt:\s+TAMPERED/m);
    expect(d.out).toMatch(/^Reason:\s+event log modified/m);
    expect(d.out).not.toContain("Outcome:    VERIFIED");
    expect(d.code).not.toBe(0);
  });
  test("A-130 round 3: an empty-diff failure names its cause in one Reason line", () => {
    const r = runEngine("nochange");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/^Reason:\s+.*empty diff/m);
    expect(r.out.trim().split("\n").filter((l) => !l.includes("ended FAILED")).length).toBeLessThanOrEqual(8); // stdout only: the E-67 stderr line stays
  });
  test("A-130 quiet by default: at most 8 lines (D48), start line names the engine, stage lines only with --verbose", () => {
    const q = runEngine("done");
    const lines = q.out.trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines[0]).toBe("Loki 10 engine");
    expect(q.out).not.toMatch(/^\[\d\d:\d\d\]/m);
    expect(q.out).toMatch(/^Receipt:\s+sha256:[0-9a-f]{64}/m);
    expect(q.out).toContain("NOT PROVEN:");
    const v = runEngine("done", false, ["--verbose"]);
    expect(v.out).toMatch(/^\[\d\d:\d\d\] intake/m);
  });
  test("done run: intake through seal, receipt, marker, efficiency record, under 60s", () => {
    const r = runEngine("done");
    if (r.code !== 0) console.error(r.out);
    expect(r.code).toBe(0);
    expect(r.wallMs).toBeLessThan(60_000);

    const completed = r.events.filter((e) => e.type === "stage.completed").map((e) => e.stage);
    // plan is forced on (LOKI_E10_PLAN=1): the lean path never applies to a forced plan (minor fix), so
    // Wall also runs here even though calc.test.ts is a relevant test for the calc.ts the task names.
    expect([...completed.slice(0, 3)].sort()).toEqual(["intake", "plan", "wall"]);
    expect(completed.slice(3)).toEqual(["implement", "verify", "commit", "seal"]);
    const skipped = r.events.filter((e) => e.type === "stage.skipped");
    expect(skipped).toEqual([]);
    const seqs = r.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(r.events[0]!.type).toBe("run.started");
    expect(r.events.at(-2)!.type).toBe("run.completed");
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
    expect(r.out).toContain("Outcome:    VERIFIED");
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
    const done = r.events.at(-2)!;
    expect(done.type).toBe("run.completed");
    expect(done.data.not_proven).toContain("commit status loki/deep-verify not set (local origin)");
    expect(r.out).toContain(`PR:         local://${r.origin}#loki/${runId}`);
  }, 90_000);
});
