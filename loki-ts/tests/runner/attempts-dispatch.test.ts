// FC-35: `bin/loki start "<task>" --attempts N` must reach the attempts runner on the positional
// (engine10) route too. A stub entry answers `engine10`; start delegates to the real runStart.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const REPO = resolve(import.meta.dir, "../../..");
const SEAL_TS = join(REPO, "loki-ts/src/engine10/stages/seal.ts");
const START_TS = join(REPO, "loki-ts/src/commands/start.ts");

function sh(cwd: string, cmd: string, args: string[]) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8" });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loki-attempts-dispatch-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  sh(repo, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "sum.js"), "exports.sum = (a) => a.slice(1).reduce((x, y) => x + y, 0);\n");
  writeFileSync(join(repo, ".gitignore"), ".loki/\n");
  sh(repo, "git", ["add", "sum.js", ".gitignore"]);
  sh(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
  const log = join(root, "engine.log");
  const keyFile = join(root, "key.pem");
  writeFileSync(keyFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  const entry = join(root, "entry.ts");
  writeFileSync(
    entry,
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const a = process.argv.slice(2);
if (a[0] === "engine10") {
  const wts = spawnSync("git", ["worktree", "list"], { encoding: "utf8" }).stdout.trim().split("\\n").length;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), wts, argv: a.slice(1) }) + "\\n");
  writeFileSync("sum.js", "exports.sum = (a) => a.reduce((x, y) => x + y, 0);\\n");
  mkdirSync(".loki/runs/stub", { recursive: true });
  const { receiptSha256, signReceipt } = await import(${JSON.stringify(SEAL_TS)});
  const body: Record<string, unknown> = { run_id: "stub", verdict: "VERIFIED", checks: [{ name: "t", cmd: "t", result: "pass", duration_s: 1, n: 3 }], verification: {} };
  body["receipt_sha256"] = receiptSha256(body);
  const { jwt, kid } = signReceipt("stub", body["receipt_sha256"]);
  body["verification"] = { jwt, kid };
  writeFileSync(".loki/runs/stub/receipt.json", JSON.stringify(body));
  process.exit(0);
}
const { runStart } = await import(${JSON.stringify(START_TS)});
process.exit(await runStart(a.slice(1)));
`,
  );
  return { root, repo, log, entry, keyFile };
}

function run(f: ReturnType<typeof fixture>, args: string[]) {
  return spawnSync(join(REPO, "bin/loki"), args, {
    cwd: f.repo,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, LOKI_TS_ENTRY: f.entry, LOKI_NO_BROWSER: "1", LOKI_RECEIPT_SIGNING_KEY_FILE: f.keyFile, LOKI_ATTEMPTS_GOVERNOR_MAX: "8", LOKI_DIR: join(f.repo, ".loki") },
  });
}

describe("FC-35 --attempts on the positional start route", () => {
  it("runs 2 attempt worktrees for `start \"<multi word task>\" --no-pr --attempts 2`", () => {
    const f = fixture();
    try {
      const r = run(f, ["start", "sum skips the first element; fix it", "--no-pr", "--attempts", "2"]);
      expect(r.status).toBe(0);
      const lines = readFileSync(f.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cwd: string; wts: number; argv: string[] });
      expect(lines.length).toBe(2);
      expect(new Set(lines.map((l) => l.cwd)).size).toBe(2);
      expect(lines.every((l) => l.cwd !== f.repo)).toBe(true);
      expect(Math.max(...lines.map((l) => l.wts))).toBeGreaterThanOrEqual(3);
      expect(readFileSync(join(f.repo, "sum.js"), "utf8")).toContain("a.reduce");
      const att = join(f.repo, ".loki", "attempts");
      expect(existsSync(att)).toBe(true);
      const rc = JSON.parse(readFileSync(join(att, readdirSync(att)[0]!, "attempts-receipt.json"), "utf8")) as { ran: number; requested: number };
      expect(rc.ran).toBe(2);
      expect(rc.requested).toBe(2);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses an out-of-range or valueless --attempts loudly", () => {
    const f = fixture();
    try {
      expect(run(f, ["start", "fix the thing please", "--attempts", "9"]).status).not.toBe(0);
      expect(run(f, ["start", "fix the thing please", "--attempts"]).status).not.toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("maps --budget to the engine10 per-run cap instead of gluing it onto the task", () => {
    const f = fixture();
    try {
      const r = run(f, ["start", "fix the thing please", "--attempts", "2", "--budget", "3"]);
      expect(r.status).toBe(0);
      const lines = readFileSync(f.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[] });
      for (const l of lines) {
        expect(l.argv).toContain("--max-cost");
        expect(l.argv[0]).toBe("fix the thing please");
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
