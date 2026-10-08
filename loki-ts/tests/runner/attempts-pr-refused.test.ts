// 11.3.1: `start --attempts N` (N>1) without --no-pr is refused before any worktree, pin or spawn (FC-40 open gap).
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Each test spawns bin/loki with a 60-120s budget; bun's 5s default fails them under full-suite load (FC-38).
setDefaultTimeout(130_000);

const REPO = resolve(import.meta.dir, "../../..");
const MSG = "--attempts opens no PR yet in 11.3.1; rerun with --no-pr, PR support ships in 11.3.2";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "loki-attempts-refused-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const sh = (a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  sh(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "x\n");
  sh(["add", "a.txt"]);
  sh(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
  const spawned = join(root, "engine10.spawned");
  const entry = join(root, "entry.ts");
  writeFileSync(entry, `import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "engine10") { writeFileSync(${JSON.stringify(spawned)}, "1"); process.exit(0); }
const { runStart } = await import(${JSON.stringify(join(REPO, "loki-ts/src/commands/start.ts"))});
process.exit(await runStart(a.slice(1)));
`);
  const run = (args: string[]) => spawnSync(join(REPO, "bin/loki"), args, {
    cwd: repo, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LOKI_TS_ENTRY: entry, LOKI_NO_BROWSER: "1", LOKI_DIR: join(repo, ".loki") },
  });
  return { root, repo, spawned, run, sh };
}

describe("start --attempts without --no-pr", () => {
  it("exits 2 with the message and creates no worktree, attempts dir or engine10 spawn", () => {
    const f = setup();
    try {
      const r = f.run(["start", "fix the thing please", "--attempts", "2"]);
      expect(r.stderr).toContain(MSG);
      expect(r.status).toBe(2);
      expect(existsSync(f.spawned)).toBe(false);
      expect(f.sh(["worktree", "list"]).stdout.trim().split("\n").length).toBe(1);
      expect(existsSync(join(f.repo, ".loki", "attempts"))).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("with --no-pr the same command is not refused", () => {
    const f = setup();
    try {
      const r = f.run(["start", "fix the thing please", "--attempts", "2", "--no-pr"]);
      expect(r.stderr).not.toContain(MSG);
      expect(existsSync(f.spawned)).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
