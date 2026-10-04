// D58 basic 3: scope control at the commit stage, through the real entry with the stub claude CLI.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "e2e");
const STUB_DIR = join(FIX, "bin");
const ENTRY = join(LOKI_TS, "src", "cli.ts");
const SETTINGS = "DEBUG = True\n";
const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function runEngine(mode: string, plan: "1" | "0") {
  const tmp = mkdtempSync(join(tmpdir(), "loki-scope-")); temps.push(tmp);
  const repo = join(tmp, "repo"), keyDir = mkdtempSync(join(tmpdir(), "loki-scope-key-")); temps.push(keyDir);
  cpSync(join(FIX, "repo"), repo, { recursive: true });
  writeFileSync(join(repo, "settings.py"), SETTINGS);
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.name", "e2e"); git(repo, "config", "user.email", "e2e@example.invalid");
  git(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml", "settings.py"); git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  const env: Record<string, string | undefined> = { ...process.env, LOKI_TS_ENTRY: ENTRY, LOKI_E10_INVOKER: "cli", LOKI_CLAUDE_CLI: join(STUB_DIR, "claude"), PATH: `${STUB_DIR}:${process.env.PATH ?? ""}`, E2E_STUB_MODE: mode, LOKI_NO_BROWSER: "1", LOKI_E10_PLAN: plan, LOKI_RECEIPT_SIGNING_KEY_FILE: join(keyDir, "k.pem") };
  delete env.LOKI_LEGACY_BASH; delete env.LOKI_RECEIPT_SIGNING_KEY; delete env.LOKI_MODEL_OVERRIDE;
  const r = Bun.spawnSync(["bash", BIN_LOKI, "add a multiply(a, b) function to calc.ts", "--no-pr"], { cwd: repo, env, timeout: 60_000 });
  const m = JSON.parse(readFileSync(join(repo, ".loki", "engine.json"), "utf8")) as { run_id: string };
  const receipt = JSON.parse(readFileSync(join(repo, ".loki", "runs", m.run_id, "receipt.json"), "utf8")) as { verdict: string; not_proven: string[] };
  const committed = git(repo, "diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
  return { repo, receipt, committed, out: r.stdout.toString() + r.stderr.toString() };
}

describe("D58/D76 scope control (advisory: flag, never revert)", () => {
  test("planned file kept, unrelated settings.py KEPT and flagged outside stated scope in NOT PROVEN", () => {
    const r = runEngine("scope", "1");
    expect(r.committed.sort()).toEqual(["calc.ts", "settings.py"]);
    expect(readFileSync(join(r.repo, "settings.py"), "utf8")).toBe(`${SETTINGS}DEBUG = False\n`);
    expect(r.receipt.not_proven).toContain("outside stated scope: settings.py");
    expect(r.receipt.not_proven).not.toContain("scope not determined; all edits committed");
  }, 120_000);
  test("no plan file list: all edits committed, with the scope note", () => {
    const r = runEngine("scope", "0");
    expect(r.committed.sort()).toEqual(["calc.ts", "settings.py"]);
    expect(r.receipt.not_proven).toContain("scope not determined; all edits committed");
  }, 120_000);
  test("only unrelated edits: committed and flagged, never VERIFIED", () => {
    const r = runEngine("unrelated", "1");
    expect(r.committed).toEqual(["settings.py"]);
    expect(readFileSync(join(r.repo, "settings.py"), "utf8")).toBe(`${SETTINGS}DEBUG = False\n`);
    expect(r.receipt.verdict).not.toBe("VERIFIED");
    expect(r.receipt.not_proven).toContain("outside stated scope: settings.py");
  }, 120_000);
});
