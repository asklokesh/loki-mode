// D62-VIS-F1 F1: a session group announced by session.started (the visual-evidence dev server) is reaped on every
// supervisor exit path, not only on SIGINT/SIGTERM: the backstop kill and a worker that dies by SIGKILL.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisor } from "../../src/engine10/supervisor.ts";

const roots: string[] = [];
const sleepers: number[] = [];
afterAll(() => {
  for (const p of sleepers) { try { process.kill(-p, "SIGKILL"); } catch { /* already gone */ } }
  for (const r of roots) execFileSync("rm", ["-rf", r]);
});
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

function repo(): { dir: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "e10-sg-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  execFileSync("git", ["-C", dir, "add", "a.txt"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"]);
  const pidFile = mkdtempSync(join(tmpdir(), "e10-sg-pid-"));
  roots.push(pidFile);
  return { dir, pidFile: join(pidFile, "sleeper.pid") };
}
const ENV: NodeJS.ProcessEnv = { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true" };
// Spawns a detached sleeper, announces its group the way sealEvidence does, then runs `tail`.
const workerCode = (pidFile: string, tail: string): string => `
  const s = require("node:child_process").spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  s.unref();
  require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(s.pid));
  console.log(JSON.stringify({ type: "session.started", stage: "seal", data: { session_id: "visual-evidence", provider: "visual-evidence", model: null, pgid: s.pid } }));
  ${tail}
`;
function sleeperPid(pidFile: string): number {
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  sleepers.push(pid);
  return pid;
}

describe("supervisor reaps announced session groups on every exit path", () => {
  test("backstop kill of a hung worker kills the announced group", async () => {
    const { dir, pidFile } = repo();
    const r = await runSupervisor({ runId: "e10-sg1", repoDir: dir, env: ENV, workerArgv: [process.execPath, "-e", workerCode(pidFile, "setInterval(() => {}, 1000);")], capS: 3, graceS: 1 });
    expect(r.verdict).toBe("FAILED");
    const pid = sleeperPid(pidFile);
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(pid)).toBe(false);
  }, 15_000);

  test("a worker that SIGKILLs itself leaves no live announced group", async () => {
    const { dir, pidFile } = repo();
    const r = await runSupervisor({ runId: "e10-sg2", repoDir: dir, env: ENV, workerArgv: [process.execPath, "-e", workerCode(pidFile, "setTimeout(() => process.kill(process.pid, 'SIGKILL'), 300); setInterval(() => {}, 1000);")], capS: 30 });
    expect(r.verdict).toBe("FAILED");
    const pid = sleeperPid(pidFile);
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(pid)).toBe(false);
  }, 15_000);
});
