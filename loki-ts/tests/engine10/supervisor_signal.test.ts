// D50-F1c: SIGINT/SIGTERM mid-run returns the checkout to the starting branch, kills worker and session groups, keeps the run branch.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const r = await runSupervisor({ runId: "e10-sig", repoDir: ${JSON.stringify(dir)}, env: process.env, capS: 600, workerArgv: [process.execPath, ${JSON.stringify(join(base, "worker.js"))}], started: {} });
process.exit(r.outcome === "CANCELLED" ? (r.notProven.some((n) => n.endsWith("SIGTERM")) ? 143 : 130) : 0); // main() returns this code; the supervisor now cancels gracefully instead of exiting in the handler`);
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

// SIGINT e2e (LM-002): a stub claude records its pid and sleeps; SIGINT to the supervisor must leave the provider child dead,
// the run cancelled (not failed), usage recorded as unmeasured, the summary printed and exit 130. Headless, no network.
const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "issue-ref");
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "cli.ts");
function gitRun(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Stub claude: records its pid, then sleeps far longer than the test. Tokens are recorded but no dollar figure,
// so the cancelled session's cost must read as unmeasured (usd null), never 0.
const STUB = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "--help" ]; then
  echo "Usage: claude [options] -p <prompt>"
  echo "  --dangerously-skip-permissions --model <m> --settings <json> -p, --print"
  exit 0
fi
mkdir -p .loki/metrics
printf '{"input_tokens":1000,"output_tokens":500,"cache_read_tokens":0,"cache_creation_tokens":0,"model":"sonnet"}' > ".loki/metrics/result-cost-\${LOKI_ITERATION:-x}.json"
echo "$$" > "\${LOKI_STUB_PIDFILE}"
sleep 300
`;

type Ev = { type: string; stage: string | null; data: Record<string, unknown> };

describe("engine10 SIGINT cancellation (stub provider that sleeps)", () => {
  test("SIGINT ends the run cancelled: child dead, usage recorded as unmeasured, summary printed, exit 130", async () => {
    expect(existsSync(ENTRY)).toBe(true);
    const tmp = mkdtempSync(join(tmpdir(), "loki-cancel-e2e-"));
    roots.push(tmp);
    const repo = join(tmp, "repo");
    cpSync(join(FIX, "repo"), repo, { recursive: true });
    gitRun(repo, "init", "-q", "-b", "main");
    gitRun(repo, "config", "user.name", "e2e");
    gitRun(repo, "config", "user.email", "e2e@example.invalid");
    gitRun(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml");
    gitRun(repo, "commit", "-q", "-m", "base");
    const stubDir = join(tmp, "bin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "claude");
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    const pidFile = join(tmp, "stub.pid");
    const env: Record<string, string | undefined> = {
      ...process.env,
      LOKI_TS_ENTRY: ENTRY,
      LOKI_E10_INVOKER: "cli",
      LOKI_CLAUDE_CLI: stub,
      LOKI_STUB_PIDFILE: pidFile,
      LOKI_E10_CANCEL_GRACE_MS: "15000",
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      LOKI_NO_BROWSER: "1",
      LOKI_RECEIPT_SIGNING_KEY_FILE: join(tmp, "k.pem"),
    };
    delete env.LOKI_LEGACY_BASH;
    delete env.LOKI_MODEL_OVERRIDE;
    delete env.LOKI_RECEIPT_SIGNING_KEY;
    const proc = Bun.spawn(["bash", BIN_LOKI, "add a subtract function to calc.ts", "--no-pr"], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    const outP = new Response(proc.stdout).text();
    const errP = new Response(proc.stderr).text();

    let stubPid = 0;
    for (let i = 0; i < 400 && !stubPid; i++) {
      if (existsSync(pidFile)) stubPid = Number(readFileSync(pidFile, "utf8").trim()) || 0;
      else await sleep(150);
    }
    expect(stubPid).toBeGreaterThan(0);
    expect(alive(stubPid)).toBe(true);

    const supPid = proc.pid; // bin/loki execs the bun supervisor, so this is the supervisor itself
    try {
      expect(supPid).toBeGreaterThan(0);
      process.kill(supPid, "SIGINT");
    } catch (err) {
      try { process.kill(-stubPid, "SIGKILL"); } catch { /* gone */ }
      proc.kill("SIGKILL");
      throw err;
    }

    const rc = await Promise.race([proc.exited, sleep(60_000).then(() => -1)]);
    const out = (await outP) + (await errP);
    if (rc !== 130) console.error(out);
    expect(rc).toBe(130);

    for (let i = 0; i < 40 && alive(stubPid); i++) await sleep(100);
    if (alive(stubPid)) {
      const mk = JSON.parse(readFileSync(join(repo, ".loki", "engine.json"), "utf8")) as { events: string };
      console.error(readFileSync(join(repo, mk.events), "utf8").split("\n").map((l) => l.slice(0, 160)).join("\n") + "\n" + out);
      try { process.kill(stubPid, "SIGKILL"); } catch { /* gone */ }
    }
    expect(alive(stubPid)).toBe(false);

    const marker = JSON.parse(readFileSync(join(repo, ".loki", "engine.json"), "utf8")) as { events: string };
    const events = readFileSync(join(repo, marker.events), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
    const done = events.findLast((e) => e.type === "run.completed");
    expect(done?.data.cancelled).toBe(true);
    expect(done?.data.outcome).toBe("CANCELLED");
    const cost = events.find((e) => e.type === "cost");
    if (!cost) console.error(events.map((e) => `${e.type} ${e.stage ?? ""} ${JSON.stringify(e.data).slice(0, 120)}`).join("\n") + "\n" + out);
    expect(cost).toBeDefined();
    expect(cost!.data.usd).toBeNull(); // unmeasured dollars: never a fake 0
    expect(events.some((e) => e.type === "session.ended")).toBe(true);
    expect(out).toContain("CANCELLED");
    expect(out).not.toMatch(/Cost:\s+\$0\.00/);
  }, 120_000);
});

// P12-10b: a cancel honoured at a stage boundary (control-request.json) ends the run CANCELLED with run.completed cancelled:true, no PR.
describe("supervisor request cancel", () => {
  test("cancel_effective from the worker completes the run as cancelled", async () => {
    const base = mkdtempSync(join(tmpdir(), "e10-rcancel-"));
    roots.push(base);
    const dir = join(base, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@example.com");
    writeFileSync(join(dir, "a.txt"), "base\n");
    git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(base, "worker.js"), `
console.log(JSON.stringify({ type: "cancel_requested", stage: null, data: {} }));
console.log(JSON.stringify({ type: "cancel_effective", stage: null, data: {} }));
console.log(JSON.stringify({ type: "escalated", stage: null, data: { stop: "cancelled by request" } }));
`);
    writeFileSync(join(base, "drive.ts"), `import { runSupervisor } from ${JSON.stringify(SUP)};
const r = await runSupervisor({ runId: "e10-rc", repoDir: ${JSON.stringify(dir)}, env: process.env, capS: 600, workerArgv: [process.execPath, ${JSON.stringify(join(base, "worker.js"))}], started: {} });
console.log("OUTCOME=" + r.outcome);`);
    const r = Bun.spawnSync([process.execPath, join(base, "drive.ts")], { env: { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true" } });
    expect(r.stdout.toString()).toContain("OUTCOME=CANCELLED");
    const marker = JSON.parse(readFileSync(join(dir, ".loki", "engine.json"), "utf8")) as { events: string };
    const evs = readFileSync(join(dir, marker.events), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
    const done = evs.findLast((e) => e.type === "run.completed");
    expect(done?.data.cancelled).toBe(true);
    expect(done?.data.outcome).toBe("CANCELLED");
    expect(evs.some((e) => e.type === "pr.opened")).toBe(false);
  }, 30_000);
});
