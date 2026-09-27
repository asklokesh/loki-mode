// E-14: thin-path end to end (docs/v10/ENGINE.md section 16). Runs the real
// engine from source through bin/loki (LOKI_ENGINE=v10, stub claude CLI via
// LOKI_E10_INVOKER=cli, --no-pr) on a fresh copy of a tiny bun repo.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "e2e");
const STUB_DIR = join(FIX, "bin");
// ponytail: src/cli.ts routes a run to supervisor.ts `main`, which no sibling
// exports yet; run.ts is the glue entry that reuses cli.ts's router. Point
// this at src/cli.ts once supervisor.ts and worker.ts export `main`.
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "engine10", "run.ts");
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
  runDir: string; stubCalls: string[];
}

function runEngine(mode: "done" | "already"): Run {
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
  const stubLog = join(tmp, "stub.log");
  const env: Record<string, string | undefined> = {
    ...process.env,
    LOKI_ENGINE: "v10",
    LOKI_TS_ENTRY: ENTRY,
    LOKI_E10_INVOKER: "cli",
    LOKI_CLAUDE_CLI: join(STUB_DIR, "claude"),
    PATH: `${STUB_DIR}:${process.env.PATH ?? ""}`,
    E2E_STUB_MODE: mode,
    E2E_STUB_LOG: stubLog,
    LOKI_NO_BROWSER: "1",
  };
  delete env.LOKI_LEGACY_BASH; // bin/loki would skip the engine10 block
  delete env.LOKI_RECEIPT_SIGNING_KEY;
  delete env.LOKI_RECEIPT_SIGNING_KEY_FILE;
  const t0 = Date.now();
  const r = Bun.spawnSync(["bash", BIN_LOKI, TASK, "--no-pr"], { cwd: repo, env, timeout: 60_000 });
  const wallMs = Date.now() - t0;
  const out = r.stdout.toString() + r.stderr.toString();
  const marker = join(repo, ".loki", "engine.json");
  const m = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { run_id: string; events: string }) : null;
  const eventsPath = m ? join(repo, m.events) : "";
  const events = eventsPath && existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  const stubCalls = existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n") : [];
  return { repo, code: r.exitCode ?? -1, wallMs, out, events, runDir: m ? join(repo, ".loki", "runs", m.run_id) : "", stubCalls };
}

describe("engine10 e2e (stub claude)", () => {
  test("done run: intake through seal, receipt, marker, efficiency record, under 60s", () => {
    const r = runEngine("done");
    if (r.code !== 0) console.error(r.out);
    expect(r.code).toBe(0);
    expect(r.wallMs).toBeLessThan(60_000);

    const completed = r.events.filter((e) => e.type === "stage.completed").map((e) => e.stage);
    expect(completed).toEqual(["intake", "plan", "implement", "verify", "commit", "seal"]);
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
    expect(r.out).toContain("Verdict:    VERIFIED");
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
});
