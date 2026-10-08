// FC-25: no attempt's engine10 spawn may carry the GitHub token family, even when the parent env has them.
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Each test spawns bin/loki with a 60-120s budget; bun's 5s default fails them under full-suite load (FC-38).
setDefaultTimeout(130_000);

const REPO = resolve(import.meta.dir, "../../..");
const START_TS = join(REPO, "loki-ts/src/commands/start.ts");

describe("attempt spawn env", () => {
  it("every attempt engine10 child sees no GH_TOKEN, GITHUB_TOKEN or SSH_AUTH_SOCK", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-attempts-env-"));
    try {
      const repo = join(root, "repo");
      mkdirSync(repo);
      const sh = (a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
      sh(["init", "-q", "-b", "main"]);
      writeFileSync(join(repo, "a.txt"), "x\n");
      sh(["add", "a.txt"]);
      sh(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
      const log = join(root, "env.log");
      const entry = join(root, "entry.ts");
      writeFileSync(entry, `import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "engine10") {
  const e = process.env;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ gh: e.GH_TOKEN ?? null, github: e.GITHUB_TOKEN ?? null, ssh: e.SSH_AUTH_SOCK ?? null }) + "\\n");
  process.exit(0);
}
const { runStart } = await import(${JSON.stringify(START_TS)});
process.exit(await runStart(a.slice(1)));
`);
      spawnSync(join(REPO, "bin/loki"), ["start", "fix the thing please", "--attempts", "2", "--no-pr"], {
        cwd: repo, encoding: "utf8", timeout: 120_000,
        env: { ...process.env, GH_TOKEN: "leak-gh", GITHUB_TOKEN: "leak-github", SSH_AUTH_SOCK: "/tmp/leak.sock", PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LOKI_TS_ENTRY: entry, LOKI_NO_BROWSER: "1", LOKI_DIR: join(repo, ".loki") },
      });
      expect(existsSync(log)).toBe(true);
      const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows.length).toBe(2);
      // FC-90: a withheld token is a non-working sentinel, never the leaked value and never unset (unset lets gh fall back to its keyring).
      for (const r of rows) {
        expect(String(r.gh).startsWith("ghp_LOKIWITHHELDsentinel")).toBe(true);
        expect(String(r.github).startsWith("ghp_LOKIWITHHELDsentinel")).toBe(true);
        expect(r.ssh).toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
