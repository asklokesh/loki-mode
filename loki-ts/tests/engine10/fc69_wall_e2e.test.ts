// FC-69 CI guard (global guard, scripts/global-guards.tsv): the real engine from bin/loki with the stub claude CLI (no billed
// calls) and FORCE_COLOR=1 in the user's env. The Wall author writes one test that is red on base; it must be kept and executed.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "e2e");
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "cli.ts");
const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function runWallColor(color: Record<string, string>): { code: number; out: string; repo: string; receipt: { verdict: string; not_proven: string[]; checks: { name: string; result: string }[]; wall: { files: unknown[] } } } {
  if (!existsSync(ENTRY)) throw new Error(`engine entry missing: ${ENTRY}`);
  const tmp = mkdtempSync(join(tmpdir(), "loki-fc69-e2e-")); temps.push(tmp);
  const keyDir = mkdtempSync(join(tmpdir(), "loki-fc69-key-")); temps.push(keyDir);
  const repo = join(tmp, "repo");
  cpSync(join(FIX, "repo"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.name", "e2e"); git(repo, "config", "user.email", "e2e@example.invalid");
  git(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml"); git(repo, "commit", "-q", "-m", "base");
  const env: Record<string, string | undefined> = {
    ...process.env, LOKI_TS_ENTRY: ENTRY, LOKI_E10_INVOKER: "cli", LOKI_CLAUDE_CLI: join(FIX, "bin", "claude"),
    PATH: `${join(FIX, "bin")}:${process.env.PATH ?? ""}`, E2E_STUB_MODE: "wallcolor", LOKI_NO_BROWSER: "1", LOKI_E10_PLAN: "1",
    LOKI_RECEIPT_SIGNING_KEY_FILE: join(keyDir, "k.pem"), ...color,
  };
  delete env.LOKI_LEGACY_BASH; delete env.LOKI_MODEL_OVERRIDE; delete env.LOKI_RECEIPT_SIGNING_KEY; delete env.NO_COLOR;
  const r = Bun.spawnSync(["bash", BIN_LOKI, "add a multiply(a, b) function to calc.ts", "--no-pr"], { cwd: repo, env, timeout: 60_000 });
  const marker = JSON.parse(readFileSync(join(repo, ".loki", "engine.json"), "utf8")) as { run_id: string };
  const receipt = JSON.parse(readFileSync(join(repo, ".loki", "runs", marker.run_id, "receipt.json"), "utf8"));
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString(), repo, receipt };
}

describe("FC-69 a user's FORCE_COLOR never changes whether the Wall executes", () => {
  for (const fc of ["1", "3"]) {
    test(`FORCE_COLOR=${fc}: Wall test kept, base run red, 2 executed checks, no Wall NOT PROVEN line`, () => {
      const r = runWallColor({ FORCE_COLOR: fc });
      if (r.receipt.wall.files.length !== 1) console.error(r.out);
      expect(r.receipt.wall.files.length).toBe(1);
      expect(r.receipt.not_proven.filter((n) => /wall base run|wall test discarded|Wall test not executed/.test(n))).toEqual([]);
      expect(r.receipt.checks.filter((c) => c.result === "pass").length).toBe(2);
      expect(r.receipt.checks.map((c) => c.name)).toContain("bun:loki_wall_multiply.test.ts");
    }, 90_000);
  }
});

// RQ-64: verify --fast runs the engine10-written .ts Wall file through the same runner (loki internal wall-run).
describe("RQ-64 verify --fast runs a real engine10-written .ts Wall file", () => {
  const FAST = resolve(LOKI_TS, "../autonomy/lib/fast_verify.py");
  const fast = (repo: string): { verdict: string; wall: number; out: string } => {
    const r = Bun.spawnSync(["python3", FAST, repo, "--json"], { cwd: repo, env: process.env, timeout: 120_000 }), out = r.stdout.toString();
    const j = JSON.parse(out) as { verdict: string; signals: { wall_files_run: number } };
    return { verdict: j.verdict, wall: j.signals.wall_files_run, out };
  };
  test("a failing engine-written Wall gives FAIL; the same file with the feature added gives PASS", () => {
    const { repo } = runWallColor({});
    const wall = join(repo, "loki_wall_multiply.test.ts");
    expect(existsSync(wall)).toBe(true);
    // provenance: the Wall must be tracked and unchanged, and its sha256 is in the run's wall.sealed event (the engine may already have committed it)
    if (Bun.spawnSync(["git", "status", "--porcelain", "--", "loki_wall_multiply.test.ts"], { cwd: repo }).stdout.toString().trim()) { git(repo, "add", "loki_wall_multiply.test.ts"); git(repo, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "wall"); }
    writeFileSync(join(repo, "calc.ts"), readFileSync(join(repo, "calc.ts"), "utf8").replace(/export function multiply[\s\S]*?\n}\n/, ""));
    const red = fast(repo);
    expect({ v: red.verdict, w: red.wall }).toEqual({ v: "FAIL", w: 1 });
    expect(red.out).toContain("wall_failed");
    appendFileSync(join(repo, "calc.ts"), "\nexport function multiply(a: number, b: number): number { return a * b; }\n");
    const green = fast(repo);
    expect({ v: green.verdict, w: green.wall }).toEqual({ v: "PASS", w: 1 });
  }, 180_000);
  test("an agent-added untracked .ts Wall with a trivial pass is INCONCLUSIVE, and a failing one still FAILs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "loki-rq64-untracked-")); temps.push(tmp);
    cpSync(join(FIX, "repo"), tmp, { recursive: true });
    git(tmp, "init", "-q", "-b", "main"); git(tmp, "add", "calc.ts", "calc.test.ts", "bunfig.toml");
    git(tmp, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "base");
    writeFileSync(join(tmp, "loki_wall_trivial.test.ts"), 'import { expect, test } from "bun:test";\ntest("t", () => { expect(1).toBe(1); });\n');
    const trivial = fast(tmp);
    expect({ v: trivial.verdict, w: trivial.wall }).toEqual({ v: "INCONCLUSIVE", w: 1 });
    writeFileSync(join(tmp, "loki_wall_trivial.test.ts"), 'import { expect, test } from "bun:test";\ntest("t", () => { expect(1).toBe(2); });\n');
    expect(fast(tmp).verdict).toBe("FAIL");
  }, 120_000);
});
