// D62-FIX: end-to-end proof of the per-run cost cap through the real CLI entry.
// bin/loki (LOKI_TS_ENTRY=src/cli.ts) runs a task with a stub claude that writes a priced
// result-cost file for its session; the total crosses a tiny --max-cost, so the run must end BUDGET_STOP, exit 3.
// Headless, no network, no real provider.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "issue-ref");
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "cli.ts");

const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

// Stub claude: every -p session records a priced result-cost file ($0.50) under its own .loki, then reports done.
const STUB = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "--help" ]; then
  echo "Usage: claude [options] -p <prompt>"
  echo "  --dangerously-skip-permissions --model <m> --settings <json> -p, --print"
  exit 0
fi
mkdir -p .loki/metrics
printf '{"total_cost_usd":0.5,"input_tokens":1000,"output_tokens":500,"cache_read_tokens":0,"cache_creation_tokens":0,"model":"sonnet"}' > ".loki/metrics/result-cost-\${LOKI_ITERATION:-x}.json"
printf '\\nexport function subtract(a: number, b: number): number {\\n  return a - b;\\n}\\n' >> calc.ts
echo "LOKI_DONE"
exit 0
`;

describe("engine10 cost cap e2e (stub claude, real CLI entry)", () => {
  function runCapped(extraArgs: string[], yaml: string | null): { rc: number; out: string; repo: string } {
    expect(existsSync(ENTRY)).toBe(true);
    const tmp = mkdtempSync(join(tmpdir(), "loki-budget-e2e-"));
    temps.push(tmp);
    const repo = join(tmp, "repo");
    cpSync(join(FIX, "repo"), repo, { recursive: true });
    if (yaml !== null) writeFileSync(join(repo, "loki.yaml"), yaml);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "e2e");
    git(repo, "config", "user.email", "e2e@example.invalid");
    git(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml");
    git(repo, "commit", "-q", "-m", "base");
    const stubDir = join(tmp, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "claude");
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    const env: Record<string, string | undefined> = {
      ...process.env,
      LOKI_TS_ENTRY: ENTRY,
      LOKI_E10_INVOKER: "cli",
      LOKI_CLAUDE_CLI: stub,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      LOKI_NO_BROWSER: "1",
      LOKI_RECEIPT_SIGNING_KEY_FILE: join(tmp, "k.pem"),
    };
    delete env.LOKI_LEGACY_BASH;
    delete env.LOKI_MODEL_OVERRIDE;
    delete env.LOKI_RECEIPT_SIGNING_KEY;
    const r = Bun.spawnSync(["bash", BIN_LOKI, "add a subtract function to calc.ts", "--no-pr", ...extraArgs], { cwd: repo, env, timeout: 90_000 });
    const out = r.stdout.toString() + r.stderr.toString();
    return { rc: r.exitCode, out, repo };
  }
  function expectCapHit(repo: string): void {
    const marker = JSON.parse(readFileSync(join(repo, ".loki", "engine.json"), "utf8")) as { events: string };
    const events = readFileSync(join(repo, marker.events), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
    expect(events.some((e) => e.type === "cost" && typeof e.data.usd === "number" && e.data.usd > 0.01)).toBe(true);
    expect(events.some((e) => e.type === "cap.hit")).toBe(true);
  }
  test("priced cost events over a tiny --max-cost end BUDGET_STOP with exit 3", () => {
    const r = runCapped(["--max-cost", "0.01"], null);
    if (r.rc !== 3) console.error(r.out);
    expect(r.rc).toBe(3);
    expect(r.out).toContain("BUDGET_STOP");
    expect(r.out).toContain("cap $0.01 (--max-cost)");
    expectCapHit(r.repo);
  }, 120_000);
  test("loki.yaml budgets.per_run sets the cap with no flag, and the start line names loki.yaml", () => {
    const r = runCapped([], "budgets:\n  per_run: 0.02\n");
    if (r.rc !== 3) console.error(r.out);
    expect(r.rc).toBe(3);
    expect(r.out).toContain("BUDGET_STOP");
    expect(r.out).toContain("cap $0.02 (loki.yaml)");
    expectCapHit(r.repo);
  }, 120_000);
  test("--max-cost beats loki.yaml per_run on the start line", () => {
    const r = runCapped(["--max-cost", "0.03"], "budgets:\n  per_run: 500\n");
    expect(r.rc).toBe(3);
    expect(r.out).toContain("cap $0.03 (--max-cost)");
    expect(r.out).not.toContain("(loki.yaml)");
  }, 120_000);
});
