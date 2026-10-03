// D61-04-F: the base-pinned tree copy (loki-already-done-*) must never outlive its check. Every TMPDIR here is a
// test-owned dir, so the real TMPDIR is never counted or touched.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TS_ROOT = join(import.meta.dir, "..", "..");
const left = (d: string): string[] => readdirSync(d).filter((n) => n.startsWith("loki-already-done-"));
const own = (): string => realpathSync(mkdtempSync(join(tmpdir(), "e10-ad-cleanup-")));

describe("already-done pinned tree cleanup (D61-04-F)", () => {
  test("race tests leave zero loki-already-done-* entries", () => {
    const tmp = own();
    try {
      const r = spawnSync("bun", ["test", "tests/engine10/already_done.test.ts", "-t", "race with implement"], {
        cwd: TS_ROOT, env: { ...process.env, TMPDIR: tmp }, encoding: "utf8", timeout: 120_000,
      });
      expect(r.status).toBe(0);
      expect(left(tmp)).toEqual([]);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("process.exit(143) mid-flight removes the root", () => {
    const tmp = own(), repo = own(), script = join(tmp, "child.ts");
    try {
      const fix = join(TS_ROOT, "tests", "engine10", "fixtures", "intake", "already-done-repo");
      execFileSync("cp", ["-R", `${fix}/.`, repo]);
      for (const a of [["init", "-q"], ["config", "user.email", "t@e.x"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "i"]]) execFileSync("git", a, { cwd: repo, stdio: "pipe" });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
      writeFileSync(script, `
import { readdirSync } from "node:fs";
import { deferAlreadyDone } from ${JSON.stringify(join(TS_ROOT, "src/features/speed/already_done_async.ts"))};
import { buildRepoMap } from ${JSON.stringify(join(TS_ROOT, "src/engine10/repomap.ts"))};
import { buildTestMap } from ${JSON.stringify(join(TS_ROOT, "src/engine10/testmap.ts"))};
const repo = ${JSON.stringify(repo)}, tmp = ${JSON.stringify(tmp)};
const sessions = { run: () => new Promise(() => {}) };
const ctx: any = { runId: "r", repoDir: repo, runDir: repo, baseSha: ${JSON.stringify(sha)}, branch: "b", provider: "claude", model: "m",
  deep: false, capS: 900, emit: () => {}, sessions, tests: { detect: async (d: string) => buildTestMap(d), impacted: () => [] },
  clock: { now: () => Date.now() }, outputs: () => ({}) };
process.env["LOKI_SPEED"] = "1";
deferAlreadyDone(ctx, new AbortController().signal, "Add global search (Cmd+K)", buildRepoMap(repo), buildTestMap(repo), () => {});
const t0 = Date.now();
const poll = setInterval(() => {
  const roots = readdirSync(tmp).filter((n) => n.startsWith("loki-already-done-"));
  if (roots.some((n) => readdirSync(tmp + "/" + n).includes("tree") && readdirSync(tmp + "/" + n + "/tree").length > 0)) process.exit(143);
  if (Date.now() - t0 > 20000) { clearInterval(poll); process.exit(2); }
}, 20);
`);
      const r = spawnSync("bun", [script], { env: { ...process.env, TMPDIR: tmp }, encoding: "utf8", timeout: 60_000 });
      expect(r.status).toBe(143);
      expect(left(tmp)).toEqual([]);
    } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
  });
});
