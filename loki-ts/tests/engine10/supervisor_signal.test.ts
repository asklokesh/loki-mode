// D50-F1c: SIGINT/SIGTERM mid-run returns the checkout to the starting branch, kills worker and session groups, keeps the run branch.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterAll(() => { for (const r of roots) execFileSync("rm", ["-rf", r]); });
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const SUP = join(import.meta.dir, "../../src/engine10/supervisor.ts");

// Fake worker: creates the run branch (as intake does), starts a detached session-like sleeper, reports its pgid, then sleeps.
const WORKER = (dirty: boolean): string => `
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
execFileSync("git", ["checkout", "-b", "loki/e10-sig"]);
const s = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
${dirty ? 'fs.writeFileSync("a.txt", "agent edit\\n");' : ""}
fs.writeFileSync("../pids", process.pid + " " + s.pid);
console.log(JSON.stringify({ type: "session.started", stage: "implement", data: { pgid: s.pid } }));
setTimeout(() => {}, 300000);
`;

async function run(sig: NodeJS.Signals, dirty = false): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "e10-sig-"));
  roots.push(base);
  const dir = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@example.com");
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "base");
  writeFileSync(join(base, "worker.js"), WORKER(dirty));
  writeFileSync(join(base, "drive.ts"), `import { runSupervisor } from ${JSON.stringify(SUP)};
await runSupervisor({ runId: "e10-sig", repoDir: ${JSON.stringify(dir)}, env: process.env, capS: 600, workerArgv: [process.execPath, ${JSON.stringify(join(base, "worker.js"))}], started: {} });`);
  const sup = spawn(process.execPath, [join(base, "drive.ts")], { env: { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true" }, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; sup.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
  const exited = new Promise<number | null>((r) => sup.on("exit", (c, s) => r(c ?? (s ? 1 : null))));
  const pidsFile = join(base, "pids");
  for (let i = 0; i < 100 && !existsSync(pidsFile); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300)); // let the session.started line reach the supervisor
  const [workerPid, sleeperPid] = readFileSync(pidsFile, "utf8").split(" ").map(Number) as [number, number];
  expect(git(dir, "branch", "--show-current")).toBe("loki/e10-sig");
  sup.kill(sig);
  const code = await exited;
  expect(code).toBe(sig === "SIGINT" ? 130 : 143);
  await new Promise((r) => setTimeout(r, 300));
  if (dirty) {
    expect(git(dir, "branch", "--show-current")).toBe("loki/e10-sig");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("agent edit\n");
    expect(err).toContain("git checkout main");
    expect(git(dir, "show", "main:a.txt")).toBe("base");
  } else expect(git(dir, "branch", "--show-current")).toBe("main");
  expect(git(dir, "branch", "--list", "loki/e10-sig")).toContain("loki/e10-sig");
  expect(alive(workerPid)).toBe(false);
  expect(alive(sleeperPid)).toBe(false);
}

describe("supervisor stop signals", () => {
  test("SIGINT returns to the starting branch and leaves no orphans", () => run("SIGINT"), 30000);
  test("SIGTERM with an uncommitted run edit stays on the run branch and keeps the edit", () => run("SIGTERM", true), 30000);
  test("SIGTERM returns to the starting branch and leaves no orphans", () => run("SIGTERM"), 30000);
});
