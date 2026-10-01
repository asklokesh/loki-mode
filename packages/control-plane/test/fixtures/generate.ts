// CP-00: regenerate the corpus with the REAL engine10 supervisor under the engine10 e2e stub claude CLI
// (loki-ts/tests/engine10/fixtures/e2e/bin/claude, extended by ./bin/claude).
// Run: bun packages/control-plane/test/fixtures/generate.ts
// Not deterministic: run ids, timestamps, durations, shas and the receipt signing key differ per generation.
// The committed files are the corpus; EXPECTED.json is keyed by directory name and holds no id or timestamp.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fold, partialCost, type Folded } from "../../../../loki-ts/src/engine10/events.ts";
import type { EventEnvelope } from "../../../../loki-ts/src/engine10/types.ts";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "../../../..");
const E2E_FIX = join(ROOT, "loki-ts/tests/engine10/fixtures/e2e");
const OUT = join(HERE, "runs");
const TASK = "add a multiply(a, b) function to calc.ts";

interface Case { name: string; task?: string; pr?: boolean; e2e?: string; cp?: string; env?: Record<string, string> }
const CASES: Case[] = [
  { name: "verified", e2e: "done" },
  { name: "verified-pr", e2e: "done", pr: true },
  { name: "partial", cp: "docs", task: "add a NOTES.md file describing the project" },
  { name: "failed", e2e: "nochange" },
  { name: "blocked", cp: "spec" },
  { name: "cap-hit", cp: "slow", env: { LOKI_E10_CAP_S: "6" } },
  { name: "tampered", e2e: "tamper" },
  { name: "unpriced", cp: "unpriced" },
  // resumed: not producible. engine10 has no resume (supervisor.ts --resume exits 2; intake.ts records resumed:false always).
];

function git(cwd: string, ...a: string[]): void {
  const r = Bun.spawnSync(["git", ...a], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
}

function runOne(c: Case, tmp: string): void {
  const repo = join(tmp, c.name, "repo");
  cpSync(join(E2E_FIX, "repo"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "corpus");
  git(repo, "config", "user.email", "corpus@example.invalid");
  git(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml");
  git(repo, "commit", "-q", "-m", "base");
  if (c.pr) { // local bare origin, as the e2e Rule of Two test does: pr.opened carries a local:// url
    const origin = join(tmp, c.name, "origin.git");
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
  }
  const keyDir = join(tmp, c.name, "key");
  mkdirSync(keyDir, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env, LOKI_ENGINE: "v10", LOKI_TS_ENTRY: join(ROOT, "loki-ts/src/cli.ts"), LOKI_E10_INVOKER: "cli",
    LOKI_CLAUDE_CLI: join(HERE, "bin/claude"), PATH: `${join(HERE, "bin")}:${process.env.PATH ?? ""}`,
    E2E_STUB_MODE: c.e2e ?? "done", ...(c.cp ? { CP_STUB_MODE: c.cp } : {}), LOKI_NO_BROWSER: "1", LOKI_E10_PLAN: "1",
    LOKI_RECEIPT_SIGNING_KEY_FILE: join(keyDir, "k.pem"), ...c.env,
  };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "LOKI_LEGACY_BASH", "LOKI_RECEIPT_SIGNING_KEY", "LOKI_MODEL_OVERRIDE"]) delete env[k];
  const r = Bun.spawnSync(["bash", join(ROOT, "bin/loki"), c.task ?? TASK, ...(c.pr ? [] : ["--no-pr"])], { cwd: repo, env, timeout: 120_000 });
  const m = JSON.parse(readFileSync(join(repo, ".loki/engine.json"), "utf8")) as { run_id: string };
  const runDir = join(repo, ".loki/runs", m.run_id);
  const dest = join(OUT, c.name);
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(runDir)) if (f === "events.jsonl" || f === "receipt.json") cpSync(join(runDir, f), join(dest, f));
  // gitleaks flags the EdDSA signature string; the fixtures never verify it, so replace it with a non-JWT placeholder
  const rp = join(dest, "receipt.json");
  if (existsSync(rp)) writeFileSync(rp, readFileSync(rp, "utf8").replace(/("jwt": ")[^"]*"/, '$1redacted-fixture-signature"'));
  console.log(`${c.name}: exit ${r.exitCode} run ${m.run_id}`);
}

export function readEvents(path: string): EventEnvelope[] {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as EventEnvelope);
}

/** The per-run values EXPECTED.json records: only what fold()/the log decide, never an id or timestamp. */
export function summarize(events: EventEnvelope[], receiptPath: string) {
  const f: Folded = fold(events);
  const pr = events.find((e) => e.type === "pr.opened")?.data.url;
  const done = f.run.completed?.data;
  const receipt = existsSync(receiptPath) ? (JSON.parse(readFileSync(receiptPath, "utf8")) as { verdict?: string }) : null;
  const pc = partialCost(events, f.run.tampered);
  return {
    verdict: f.run.verdict,
    receipt_verdict: receipt?.verdict ?? null,
    tampered: f.run.tampered,
    cap_hit: events.some((e) => e.type === "cap.hit"),
    event_count: events.length,
    stages_completed: f.completed,
    cost_usd: f.cost.usd,
    measured_sessions: pc.measured,
    total_sessions: pc.total,
    pr_url: typeof pr === "string" ? pr : null,
    not_proven: Array.isArray(done?.not_proven) ? (done.not_proven as string[]) : [],
  };
}

export function buildExpected(runsDir: string) {
  const runs: Record<string, ReturnType<typeof summarize>> = {};
  for (const name of readdirSync(runsDir).sort()) {
    const dir = join(runsDir, name);
    runs[name] = summarize(readEvents(join(dir, "events.jsonl")), join(dir, "receipt.json"));
  }
  const verdict_counts: Record<string, number> = {};
  for (const r of Object.values(runs)) { const v = r.verdict ?? "none"; verdict_counts[v] = (verdict_counts[v] ?? 0) + 1; }
  return { run_count: Object.keys(runs).length, verdict_counts, runs };
}

if (import.meta.main) {
  const tmp = mkdtempSync(join(tmpdir(), "loki-run-cp00-"));
  try {
    rmSync(OUT, { recursive: true, force: true });
    for (const c of CASES) runOne(c, tmp);
    writeFileSync(join(HERE, "EXPECTED.json"), JSON.stringify(buildExpected(OUT), null, 2) + "\n");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
