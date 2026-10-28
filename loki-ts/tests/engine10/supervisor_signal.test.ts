// D50-F1c: SIGINT/SIGTERM mid-run returns the checkout to the starting branch, kills worker and session groups, keeps the run branch.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterAll(() => { for (const r of roots) execFileSync("rm", ["-rf", r]); });
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const SUP = join(import.meta.dir, "../../src/engine10/supervisor.ts");
import { baseLine, dropEmptyRunBranch } from "../../src/util/base_guard.ts";
import { SupervisorLog } from "../../src/engine10/supervisor.ts";
import { readEvents } from "../../src/engine10/events.ts";
import { reasonOf } from "../../src/engine10/output.ts";
import { signReceipt } from "../../src/engine10/stages/seal.ts";
import { RECOVERY_ABORT, findInterrupted, nextStepText, resumeFlag, resumeMachineOpts, startRecovery, statusNextStep } from "../../src/util/run_outputs.ts";
import { verifyLogSeals } from "../../src/util/seal_drift.ts";

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
  expect(code).toBe(sig === "SIGTERM" ? 143 : 130);
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
  test("sighup (terminal closed) returns to the starting branch and leaves no orphans", () => run("SIGHUP"), 30000);
  test("SIGTERM returns to the starting branch and leaves no orphans", () => run("SIGTERM"), 30000);
});

// FC-EMPTY-RUN-BRANCH-LEFT-CHECKED-OUT: a terminal run that committed nothing restores the starting branch and drops its empty loki/ branch.
type EmptyMode = "empty" | "commit" | "switch" | "dirty";
const EMPTY_WORKER = (mode: EmptyMode): string => `
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const g = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const base = g("rev-parse", "HEAD");
g("checkout", "-b", "loki/e10-empty");
${mode === "commit" ? 'fs.writeFileSync("w.txt", "wall\\n"); g("add", "w.txt"); g("-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-q", "-m", "wall");' : ""}
${mode === "switch" ? 'g("checkout", "-b", "user-branch");' : ""}
${mode === "dirty" ? 'fs.writeFileSync("a.txt", "agent edit\\n");' : ""}
console.log(JSON.stringify({ type: "stage.completed", stage: "intake", data: { base_sha: base, branch: "loki/e10-empty" } }));
process.exit(1);
`;
async function emptyRun(mode: EmptyMode): Promise<{ dir: string; err: string }> {
  const base = mkdtempSync(join(tmpdir(), "e10-empty-"));
  roots.push(base);
  const dir = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@example.com");
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "base");
  writeFileSync(join(base, "worker.js"), EMPTY_WORKER(mode));
  writeFileSync(join(base, "drive.ts"), `import { runSupervisor } from ${JSON.stringify(SUP)};
const r = await runSupervisor({ runId: "e10-empty", repoDir: ${JSON.stringify(dir)}, env: process.env, capS: 600, workerArgv: [process.execPath, ${JSON.stringify(join(base, "worker.js"))}], started: {} });
process.exit(r.verdict === "FAILED" ? 0 : 3);`);
  const sup = spawn(process.execPath, [join(base, "drive.ts")], { env: { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true" }, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; sup.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
  const code = await new Promise<number | null>((r) => sup.on("exit", (c) => r(c)));
  expect(code).toBe(0);
  return { dir, err };
}
describe("supervisor: a run that committed nothing", () => {
  test("FAILED with 0 commits returns to main and leaves no loki/ branch", async () => {
    const { dir } = await emptyRun("empty");
    expect(git(dir, "branch", "--show-current")).toBe("main");
    expect(git(dir, "branch", "--list", "loki/*")).toBe("");
  }, 30000);
  test("a second run after a failed zero-commit run starts with base: main", async () => {
    const { dir } = await emptyRun("empty");
    expect(baseLine(dir)).toContain("base: main");
    expect(baseLine(dir)).not.toContain("loki/e10-empty");
  }, 30000);
  test("positive control: a run branch with a commit is kept, HEAD stays on it", async () => {
    const { dir } = await emptyRun("commit");
    expect(git(dir, "branch", "--list", "loki/e10-empty")).toContain("loki/e10-empty");
    expect(git(dir, "branch", "--show-current")).toBe("loki/e10-empty");
  }, 30000);
  test("the user switched branch mid-run: nothing is restored, the branch is kept, a note is printed", async () => {
    const { dir, err } = await emptyRun("switch");
    expect(git(dir, "branch", "--show-current")).toBe("user-branch");
    expect(git(dir, "branch", "--list", "loki/e10-empty")).toContain("loki/e10-empty");
    expect(err).toContain("git branch -D loki/e10-empty");
  }, 30000);
  test("an uncommitted run edit blocks the checkout: stays on the run branch, edit kept, branch kept", async () => {
    const { dir } = await emptyRun("dirty");
    expect(git(dir, "branch", "--show-current")).toBe("loki/e10-empty");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("agent edit\n");
  }, 30000);
  test("a non-loki branch name in the intake event is never deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-nl-")); roots.push(dir);
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@example.com");
    writeFileSync(join(dir, "a.txt"), "x\n"); git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "b");
    git(dir, "branch", "mine");
    const sha = git(dir, "rev-parse", "HEAD");
    expect(dropEmptyRunBranch(dir, "main", "mine", sha)).toBeNull();
    expect(git(dir, "branch", "--list", "mine")).toContain("mine");
  });
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
if [ "\${1:-}" = "auth" ] && [ "\${2:-}" = "status" ]; then
  echo '{"loggedIn":true}'
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

// Q17-02: the supervisor passes started.max_cost_usd into the summary, so the finished summary Cost line shows "N% of cap $X".
describe("supervisor summary cost cap", () => {
  test("a measured cost plus started.max_cost_usd renders the percent-of-cap on the summary Cost line", async () => {
    const bodies: { text: string }[] = [];
    const hook = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { bodies.push(JSON.parse(await req.text()) as { text: string }); return new Response("ok"); } });
    const base = mkdtempSync(join(tmpdir(), "e10-capsum-"));
    roots.push(base);
    try {
      const dir = join(base, "repo");
      execFileSync("git", ["init", "-q", "-b", "main", dir]);
      git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@example.com");
      writeFileSync(join(dir, "a.txt"), "base\n");
      git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "base");
      writeFileSync(join(base, "worker.js"), `console.log(JSON.stringify({ type: "cost", stage: "implement", data: { session_id: "s1", usd: 0.5 } }));\nconsole.log(JSON.stringify({ type: "cancel_effective", stage: null, data: {} }));\n`);
      writeFileSync(join(base, "drive.ts"), `import { runSupervisor } from ${JSON.stringify(SUP)};
await runSupervisor({ runId: "e10-capsum", repoDir: ${JSON.stringify(dir)}, env: process.env, capS: 600, workerArgv: [process.execPath, ${JSON.stringify(join(base, "worker.js"))}], started: { provider: "claude", max_cost_usd: 2 } });`);
      const p = Bun.spawn([process.execPath, join(base, "drive.ts")], { env: { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true", LOKI_SLACK_WEBHOOK_URL: `http://127.0.0.1:${hook.port}/hook` }, stdout: "ignore", stderr: "pipe" });
      const err = await new Response(p.stderr).text();
      await p.exited;
      const text = bodies.map((b) => b.text).join("\n");
      if (!text.includes("% of cap $")) console.error(text + "\n" + err);
      expect(text).toMatch(/Cost:\s+\$0\.50 .*25% of cap \$2\.00/);
    } finally { hook.stop(true); }
  }, 30_000);
});

// P12-10b smoke: `loki cancel` against a LIVE run (stub provider held in the implement stage) is honoured at the next stage boundary and the run completes CANCELLED.
describe("loki cancel on a live run", () => {
  test("cancel written while a stage is running completes the run as cancelled with no PR", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loki-cancel-live-"));
    roots.push(tmp);
    const repo = join(tmp, "repo");
    cpSync(join(FIX, "repo"), repo, { recursive: true });
    gitRun(repo, "init", "-q", "-b", "main");
    gitRun(repo, "config", "user.name", "e2e");
    gitRun(repo, "config", "user.email", "e2e@example.invalid");
    gitRun(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml");
    gitRun(repo, "commit", "-q", "-m", "base");
    const hangDir = join(tmp, "hang");
    mkdirSync(hangDir);
    const hang = join(hangDir, "hang-implement");
    writeFileSync(hang, "");
    const env: Record<string, string | undefined> = {
      ...process.env,
      LOKI_TS_ENTRY: ENTRY,
      LOKI_E10_INVOKER: "cli",
      LOKI_CLAUDE_CLI: join(FIX, "bin", "claude"),
      ISSUE_REF_STUB_HANG_DIR: hangDir,
      PATH: `${join(FIX, "bin")}:${process.env.PATH ?? ""}`,
      LOKI_NO_BROWSER: "1",
      LOKI_RECEIPT_SIGNING_KEY_FILE: join(tmp, "k.pem"),
    };
    delete env.LOKI_LEGACY_BASH;
    delete env.LOKI_MODEL_OVERRIDE;
    delete env.LOKI_RECEIPT_SIGNING_KEY;
    const proc = Bun.spawn(["bash", BIN_LOKI, "add a subtract function to calc.ts", "--no-pr"], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    const outP = new Response(proc.stdout).text();
    const errP = new Response(proc.stderr).text();
    const pidFile = join(hangDir, "pid");
    for (let i = 0; i < 400 && !existsSync(pidFile) && proc.exitCode === null; i++) await sleep(150);
    if (!existsSync(pidFile)) { proc.kill("SIGKILL"); throw new Error(`stub never reached implement: ${(await outP) + (await errP)}`); }
    try {
      expect(existsSync(pidFile)).toBe(true);
      const c = Bun.spawnSync(["bash", BIN_LOKI, "cancel"], { cwd: repo, env });
      expect(c.exitCode).toBe(0);
    } finally { rmSync(hang, { force: true }); } // release the stub whatever happened
    const rc = await Promise.race([proc.exited, sleep(90_000).then(() => -1)]);
    const out = await outP;
    if (rc === -1) proc.kill("SIGKILL");
    expect(rc).not.toBe(-1);
    const marker = JSON.parse(readFileSync(join(repo, ".loki", "engine.json"), "utf8")) as { events: string };
    const events = readFileSync(join(repo, marker.events), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
    const types = events.map((e) => e.type);
    expect(types.indexOf("cancel_requested")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("cancel_effective")).toBe(types.indexOf("cancel_requested") + 1);
    const done = events.findLast((e) => e.type === "run.completed");
    expect(done?.data.cancelled).toBe(true);
    expect(done?.data.outcome).toBe("CANCELLED");
    expect(types).not.toContain("pr.opened");
    expect(out).toContain("CANCELLED");
  }, 150_000);
});

describe("supervisor main flag values", () => {
  test("missing flag value: --spec or --max-cost with no value exits 2 with a needs-a-value line, via the real CLI", async () => {
    const plain = mkdtempSync(join(tmpdir(), "e10-mfv-"));
    roots.push(plain);
    const CLI = join(import.meta.dir, "../../src/cli.ts");
    for (const [flag, args] of [["--spec", ["task", "--spec"]], ["--max-cost", ["task", "--max-cost"]], ["--spec", ["task", "--spec", "--deep"]], ["--max-cost", ["task", "--max-cost", ""]]] as [string, string[]][]) {
      const p = Bun.spawn([process.execPath, CLI, "engine10", "run", ...args], { cwd: plain, env: process.env, stdout: "ignore", stderr: "pipe" });
      const err = await new Response(p.stderr).text();
      expect(await p.exited).toBe(2);
      expect(err).toContain(`${flag} needs a value`);
    }
  }, 60_000);
});

describe("stuck-run alert (LOKI_STUCK_MIN)", () => {
  const MIN = 60_000;
  test("silent run: 0 alerts before threshold, exactly 1 after, names last stage", async () => {
    const { createStuckWatch } = await import("../../src/util/slack_events.ts");
    const alerts: { stage?: string; lastEventAt?: string; action?: string }[] = [];
    const w = createStuckWatch(15, 0, (f) => alerts.push(f));
    w.event("implement", 1 * MIN);
    w.tick(15 * MIN); expect(alerts.length).toBe(0);
    w.tick(16 * MIN); w.tick(20 * MIN); w.tick(40 * MIN);
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.stage).toBe("implement");
    expect(alerts[0]?.lastEventAt).toBe(new Date(1 * MIN).toISOString());
    expect(alerts[0]?.action).toBeTruthy();
  });
  test("new event clears the alert; a later silence alerts again", async () => {
    const { createStuckWatch } = await import("../../src/util/slack_events.ts");
    const alerts: { stage?: string }[] = [];
    const w = createStuckWatch(15, 0, (f) => alerts.push(f));
    w.tick(16 * MIN); expect(alerts.length).toBe(1);
    w.event("verify", 17 * MIN);
    w.tick(20 * MIN); expect(alerts.length).toBe(1);
    w.tick(33 * MIN); expect(alerts.length).toBe(2);
    expect(alerts[1]?.stage).toBe("verify");
  });
  test("LOKI_STUCK_MIN 0, negative or invalid falls back to 15; valid value honored", async () => {
    const { stuckMinutes } = await import("../../src/util/slack_events.ts");
    for (const v of ["0", "-3", "abc", "", "NaN"]) expect(stuckMinutes({ LOKI_STUCK_MIN: v })).toBe(15);
    expect(stuckMinutes({})).toBe(15);
    expect(stuckMinutes({ LOKI_STUCK_MIN: "2" })).toBe(2);
  });
  test("supervisor wiring: the real beat interval ticks and every ingested event feeds the watch", async () => {
    const base = mkdtempSync(join(tmpdir(), "e10-stuckwire-"));
    roots.push(base);
    const dir = join(base, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@example.com");
    writeFileSync(join(dir, "a.txt"), "base\n");
    git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(base, "worker.js"), `
const out = (stage) => console.log(JSON.stringify({ type: "stage.started", stage, data: {} }));
out("implement");
setTimeout(() => out("verify"), 1200);
setTimeout(() => process.exit(0), 2200);
`);
    // Fake clock: Date.now is offset by a variable and the supervisor's own 15s beat callback is captured, then fired by hand.
    writeFileSync(join(base, "drive.ts"), `import { runSupervisor } from ${JSON.stringify(SUP)};
const realNow = Date.now.bind(Date), realSet = globalThis.setTimeout;
let offset = 0, beat: (() => void) | null = null;
Date.now = () => realNow() + offset;
const origInterval = globalThis.setInterval;
(globalThis as any).setInterval = (fn: () => void, ms: number, ...a: unknown[]) => { if (ms === 15000) { beat = fn; return { unref() {}, ref() {} }; } return (origInterval as any)(fn, ms, ...a); };
const fire = (n: number) => { for (let i = 0; i < n; i++) beat?.(); };
realSet(() => { offset += 16 * 60_000; fire(3); }, 600); // silence after "implement": exactly one alert
realSet(() => { fire(2); }, 1800); // "verify" arrived at 1200ms of fake time after the jump, so nothing is stale yet
await runSupervisor({ runId: "e10-stuckwire", repoDir: ${JSON.stringify(dir)}, env: process.env, capS: 600, workerArgv: [process.execPath, ${JSON.stringify(join(base, "worker.js"))}], started: {} });
process.stdout.write("BEAT_CAPTURED=" + (beat !== null) + "\\n");
process.exit(0);`);
    const p = Bun.spawn([process.execPath, join(base, "drive.ts")], { cwd: dir, env: { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true", LOKI_CONTROL: "0", LOKI_STUCK_MIN: "15" }, stdout: "pipe", stderr: "pipe" });
    const [err, out] = [await new Response(p.stderr).text(), await new Response(p.stdout).text()];
    await p.exited;
    expect(out).toContain("BEAT_CAPTURED=true");
    const lines = err.split("\n").filter((l) => l.startsWith("engine10: no event for"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("last stage implement");
  }, 60_000);
  test("stuck slack payload carries stage and action", async () => {
    const { slackPayload } = await import("../../src/util/slack_events.ts");
    expect(slackPayload("stuck", { stage: "verify", lastEventAt: "t", action: "act" }).text).toContain("verify");
  });
});

// SB-04d: a run stopped by SIGTERM or Ctrl-C is offered Resume by `loki start` (and resumed with no prompt off a TTY) from its settled stages.
describe("loki start continues a cancelled run", () => {
  const RID = "e10-20260101T000000Z-cafe";
  type Row = [string, string | null, Record<string, unknown>?];
  const afterPlan: Row[] = [["run.started", null, { provider: "claude" }], ["stage.completed", "intake", { task: "add subtract" }], ["stage.completed", "plan"]];
  const cancelDone: Row = ["run.completed", null, { verdict: "FAILED", cancelled: true, signal: "SIGTERM", outcome: "CANCELLED" }];
  let keyDir = "";
  const saved = { k: process.env["LOKI_RECEIPT_SIGNING_KEY"], f: process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] };
  beforeAll(() => { keyDir = mkdtempSync(join(tmpdir(), "e10-sb04d-key-")); roots.push(keyDir); process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(keyDir, "k.pem"); signReceipt("warm", "0".repeat(64)); });
  afterAll(() => { for (const [k, v] of [["LOKI_RECEIPT_SIGNING_KEY", saved.k], ["LOKI_RECEIPT_SIGNING_KEY_FILE", saved.f]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  /** A repo holding the run branch and a log written by the real SupervisorLog (so the cancel seal is the engine's own). */
  function mkRun(rows: Row[], seal = true): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "e10-sb04d-")); roots.push(dir);
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@example.com");
    writeFileSync(join(dir, "a.txt"), "base\n"); git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "base");
    git(dir, "branch", `loki/${RID}`);
    const path = join(dir, ".loki", "runs", RID, "events.jsonl"); mkdirSync(join(dir, ".loki", "runs", RID), { recursive: true });
    const log = new SupervisorLog(path, RID), base = git(dir, "rev-parse", "HEAD");
    for (const [t, st, d] of rows) log.append(t, st as never, t === "stage.completed" && st === "intake" ? { ...d, base_sha: base } : d ?? {});
    if (seal && rows.some((r) => r[0] === "run.completed")) log.sealLog();
    process.chdir(dir); // resumeFlag resolves the repo from the cwd, as it does for a real `loki start`
    return { dir, path };
  }
  const cwd0 = process.cwd();
  afterEach(() => { process.chdir(cwd0); });
  const harness = (...answers: (string | null)[]) => {
    const say: string[] = [], q = [...answers]; let seen = 0, asked = 0;
    return { say, get seen() { return seen; }, get asked() { return asked; }, deps: { out: (x: string) => { say.push(x); }, ask: async () => { asked++; return q.length ? q.shift()! : null; }, supervise: (async () => { seen++; return { outcome: "VERIFIED" }; }) as never } };
  };

  test("non-TTY, same task: resumes from the settled intake and plan to VERIFIED; the machine re-enters past them", async () => {
    const r = mkRun([...afterPlan, cancelDone]), h = harness();
    expect(await startRecovery(r.dir, "add subtract", false, { ...h.deps, tty: false })).toBe(0);
    expect(h.seen).toBe(1);
    expect(h.say.join("")).toContain("settled: intake, plan");
    const ctx = {}, flow = resumeMachineOpts(ctx, readEvents(r.path), readFileSync(r.path, "utf8"), ["intake", ["plan", "wall"], "implement", "verify"] as const);
    expect(flow.ok && flow.flow).toEqual([["wall"], "implement", "verify"]); // no settled stage is called a second time
    expect(flow.ok && Object.keys(flow.restored)).toEqual(["intake", "plan"]);
  });
  test("TTY: the default choice (Enter) resumes a cancelled run and the menu marks Resume as the default", async () => {
    const r = mkRun([...afterPlan, cancelDone]), h = harness("");
    expect(await startRecovery(r.dir, "add subtract", false, { ...h.deps, tty: true })).toBe(0);
    expect(h.asked).toBe(1);
    expect(h.seen).toBe(1);
    expect(h.say.join("")).toContain("1) Resume (continue from the settled stages) [default]");
  });
  test("a bare start (no task) resumes the cancelled run too; a different task starts fresh", async () => {
    const r = mkRun([...afterPlan, cancelDone]), h = harness();
    expect(await startRecovery(r.dir, "something else", false, { ...h.deps, tty: false })).toBeNull();
    expect(h.seen).toBe(0);
    expect(await startRecovery(r.dir, "", false, { ...h.deps, tty: false })).toBe(0);
    expect(h.seen).toBe(1);
  });
  test("cancelled with nothing settled: Start fresh only, never a Resume entry", async () => {
    const r = mkRun([["run.started", null], cancelDone]), h = harness("1");
    expect(await startRecovery(r.dir, "add subtract", false, { ...h.deps, tty: true })).toBeNull();
    expect(h.say.join("")).not.toContain("Resume (");
    expect(h.say.join("")).toContain("1) Start fresh");
    expect(h.seen).toBe(0);
    expect(await startRecovery(r.dir, "add subtract", false, { ...h.deps, tty: false })).toBeNull();
    expect(h.seen).toBe(0);
  });
  test("Ctrl-C or EOF at the menu returns 130: nothing resumes, no run starts", async () => {
    for (const a of [RECOVERY_ABORT, null]) {
      const r = mkRun([...afterPlan, cancelDone]), h = harness(a);
      expect(await startRecovery(r.dir, "add subtract", false, { ...h.deps, tty: true })).toBe(130);
      expect(h.seen).toBe(0);
    }
  });
  test("--fresh and LOKI_NO_RESUME=1 skip the offer; --no-pr still resumes the stages", async () => {
    const r = mkRun([...afterPlan, cancelDone]), h = harness();
    expect(await startRecovery(r.dir, "add subtract", false, { ...h.deps, tty: false, fresh: true })).toBeNull();
    process.env["LOKI_NO_RESUME"] = "1";
    try { expect(await startRecovery(r.dir, "add subtract", false, { ...h.deps, tty: false })).toBeNull(); } finally { delete process.env["LOKI_NO_RESUME"]; }
    expect(h.seen).toBe(0);
    expect(await startRecovery(r.dir, "add subtract", true, { ...h.deps, tty: false })).toBe(0);
    expect(h.seen).toBe(1);
  });
  test("an explicit loki start --resume <id> works on a cancelled run", async () => {
    const r = mkRun([...afterPlan, cancelDone]), h = harness();
    expect(await resumeFlag(RID, true, h.deps)).toBe(0);
    expect(h.seen).toBe(1);
    expect(h.say.join("")).not.toContain("no interrupted engine10 run");
  });
  test("a refusal before the engine starts (dirty tree) never blocks a non-TTY fresh start", async () => {
    const r = mkRun([...afterPlan, cancelDone]), h = harness();
    writeFileSync(join(r.dir, "dirty.txt"), "x\n");
    expect(await startRecovery(r.dir, "add subtract", false, { ...h.deps, tty: false })).toBeNull();
    expect(h.seen).toBe(0);
    expect(h.say.join("")).toContain("could not be resumed");
  });
  test("tampered tail after a cancel: an event appended after the cancel seal is refused, an edited earlier line too; the untouched log is the control", async () => {
    const ok = mkRun([...afterPlan, cancelDone]); expect(findInterrupted(ok.dir, RID, true)).not.toBeNull();
    const tail = mkRun([...afterPlan, cancelDone]);
    writeFileSync(tail.path, readFileSync(tail.path, "utf8") + JSON.stringify({ v: 1, run: RID, seq: 99, ts: "2026-01-01T00:00:00.000Z", type: "stage.completed", stage: "implement", data: { forged: true } }) + "\n");
    const h = harness();
    expect(await resumeFlag(RID, true, h.deps)).toBe(2);
    expect(h.say.join("")).toContain("after its last log.sealed");
    expect(h.seen).toBe(0);
    expect(await startRecovery(tail.dir, "add subtract", false, { ...h.deps, tty: false })).toBeNull();
    expect(h.seen).toBe(0);
    const edit = mkRun([...afterPlan, cancelDone]);
    writeFileSync(edit.path, readFileSync(edit.path, "utf8").replace('"add subtract"', '"add multiply"'));
    expect(findInterrupted(edit.dir, RID, true)).toBeNull();
  });
  test("truncated: a cancel seal cut off the log, or a line cut out before it, is never offered Resume and --resume refuses it", async () => {
    const cut = mkRun([...afterPlan, cancelDone]), lines = readFileSync(cut.path, "utf8").split("\n").filter((l) => l !== "");
    expect(lines.at(-1)).toContain("log.sealed");
    writeFileSync(cut.path, lines.slice(0, -1).join("\n") + "\n"); // the seal after run.completed removed
    const h = harness();
    expect(await startRecovery(cut.dir, "add subtract", false, { ...h.deps, tty: false })).toBeNull();
    expect(h.seen).toBe(0);
    expect(await resumeFlag(RID, true, h.deps)).not.toBe(0);
    expect(h.seen).toBe(0);
    const gap = mkRun([...afterPlan, cancelDone]), gl = readFileSync(gap.path, "utf8").split("\n").filter((l) => l !== "");
    writeFileSync(gap.path, [...gl.slice(0, 2), ...gl.slice(3)].join("\n") + "\n"); // an earlier line cut out
    const g = harness();
    expect(await startRecovery(gap.dir, "add subtract", false, { ...g.deps, tty: false })).toBeNull();
    expect(g.seen).toBe(0);
  });
  test("seal honesty: the resumed run seals its own new events, and a tail edit after the resume breaks that seal", () => {
    const r = mkRun([...afterPlan, cancelDone]);
    const b = new SupervisorLog(r.path, RID);
    b.append("run.resumed", null, { phase: "stage" }); b.append("stage.completed", "wall", {}); b.append("run.completed", null, { verdict: "VERIFIED" }); b.sealLog();
    const raw = readFileSync(r.path, "utf8");
    expect(verifyLogSeals(raw, readEvents(r.path), { sealLast: true })).toBeNull();
    expect(readEvents(r.path).filter((e) => e.type === "log.sealed").length).toBe(2);
    expect(verifyLogSeals(raw.replace('"verdict":"VERIFIED"', '"verdict":"PARTIAL"'), readEvents(r.path), { sealLast: true })).not.toBeNull();
  });
  test("a resumed run that stopped again is an interrupted run, not a tampered one", () => {
    const r = mkRun([...afterPlan, cancelDone]);
    const b = new SupervisorLog(r.path, RID); b.append("run.resumed", null, { phase: "stage" });
    const it = findInterrupted(r.dir, RID, true);
    expect(it).not.toBeNull();
    expect(it?.cancelled).toBeUndefined();
  });
  test("the cancel line and loki status say Resume will be offered, only when a stage settled", () => {
    const withStage = mkRun([...afterPlan, cancelDone]);
    expect(reasonOf(readEvents(withStage.path), false, null, "CANCELLED")).toContain("offers to resume it (settled stages are kept) or start fresh");
    const none = mkRun([["run.started", null], cancelDone]);
    expect(reasonOf(readEvents(none.path), false, null, "CANCELLED")).toContain("offers to start fresh");
    expect(statusNextStep(withStage.dir, join(withStage.dir, ".loki", "runs"), RID, readEvents(withStage.path))).toContain("offers to resume it from its settled stages");
    expect(statusNextStep(none.dir, join(none.dir, ".loki", "runs"), RID, readEvents(none.path))).toContain("offers to start fresh");
    expect(nextStepText(RID, "verify", true, true)).toContain("resume");
  });
});

// Steer-ack KPI: the real `loki steer` is injected at 5 points of a stub-provider run. Each steer must (a) print its ack line fast,
// (b) be read at the expected stage, (c) lose no work, and (d) be applied (or refused loudly) before seal: never silently left behind.
describe("loki steer at five stage points (stub provider)", () => {
  const LOKI = resolve(import.meta.dir, "../../../autonomy/loki");
  const ACK_BUDGET_S = 5;
  type Stage = "plan" | "wall" | "implement" | "verify";
  type Point = { at: string; stage: Stage; readAt: string; sealRefuses: boolean };
  // stage = the stage about to run when the steer arrives; plan and implement sessions read steers, wall and verify do not.
  const POINTS: Point[] = [
    { at: "before-plan", stage: "plan", readAt: "plan", sealRefuses: false },
    { at: "before-wall", stage: "wall", readAt: "implement", sealRefuses: true },
    { at: "before-implement", stage: "implement", readAt: "implement", sealRefuses: true },
    { at: "before-verify", stage: "verify", readAt: "seal", sealRefuses: true },
    { at: "mid-wall-session", stage: "wall", readAt: "implement", sealRefuses: true },
  ];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const measured: string[] = [];
  for (const p of POINTS) test(`steer ${p.at}: ack within ${ACK_BUDGET_S}s, read at ${p.readAt}, no lost work, applied before seal`, async () => {
    const { withSteer, staleAtSeal, staleReason, readIntentRevisions } = await import("../../src/util/steer.ts");
    const dir = mkdtempSync(join(tmpdir(), "e10-steer5-")); roots.push(dir);
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@example.com");
    writeFileSync(join(dir, "a.txt"), "base\n"); git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "base");
    mkdirSync(join(dir, ".loki"));
    const baseSha = git(dir, "rev-parse", "HEAD");
    const note = `steer at ${p.at}: prefer small functions`;
    const timeline: { stage: string; startMs: number }[] = [], ctx = { intentRevisions: [] as import("../../src/util/steer.ts").IntentRevision[], timeline };
    const readStages: string[] = [], env = { ...process.env, LOKI_STEER_ACTOR: "tester", LOKI_STEER_SOURCE: "cli" } as NodeJS.ProcessEnv;
    delete env.LOKI_PROMPT_INJECTION;
    let ackS = -1, ack = "";
    const inject = () => {
      const t0 = performance.now();
      const r = spawnSync("bash", [LOKI, "steer", note], { cwd: dir, env, encoding: "utf8" });
      ackS = (performance.now() - t0) / 1000; ack = r.stdout;
      expect(r.status).toBe(0);
    };
    // Stub provider: a session records whether its brief carried the steer; the implement session produces the work.
    const session = (stage: Stage): void => {
      timeline.push({ stage, startMs: Date.now() });
      const out = withSteer({ stage, brief: "task\n\nbody" }, dir, ctx.intentRevisions);
      if ((out.brief as string).includes("prefer small functions")) readStages.push(stage);
      if (stage === "implement") { writeFileSync(join(dir, "feature.txt"), "feature work\n"); git(dir, "add", "feature.txt"); git(dir, "commit", "-q", "-m", "feature"); }
    };
    for (const st of ["plan", "wall", "implement", "verify"] as Stage[]) {
      await sleep(8);
      if (p.at === "mid-wall-session" && st === "wall") { timeline.push({ stage: "wall", startMs: Date.now() }); await sleep(8); inject(); await sleep(8); continue; }
      if (st === p.stage) inject();
      await sleep(8);
      session(st);
    }
    const diffStat = git(dir, "diff", "--stat", baseSha, "HEAD");
    const stale = staleAtSeal(dir, ctx);
    const read = readStages[0] ?? (stale.length > 0 ? "seal" : "never");
    expect(ack).toContain("Steer rev 1 received: applies at next plan/implement stage.");
    expect(ackS).toBeLessThan(ACK_BUDGET_S);
    expect(read).toBe(p.readAt);
    // never left behind: inbox empty, archived with the exact text, revision recorded
    expect(existsSync(join(dir, ".loki", "HUMAN_INPUT.md"))).toBe(false);
    const arch = execFileSync("sh", ["-c", "cat .loki/logs/human-input-*.md"], { cwd: dir, encoding: "utf8" });
    expect(arch).toContain(note);
    expect(readIntentRevisions(dir).map((r) => r.rev)).toEqual([1]);
    // seal: a pre-Wall steer passes; a post-Wall steer must refuse loudly and name the rev
    if (p.sealRefuses) { expect(stale.map((r) => r.rev)).toEqual([1]); expect(staleReason(stale)).toContain("operator steer rev 1 arrived after the Wall was frozen"); }
    else expect(stale).toEqual([]);
    // no lost work: the implement commit is intact, the base file is untouched, the tree is clean apart from .loki
    expect(diffStat).toContain("feature.txt");
    expect(git(dir, "show", "HEAD:feature.txt")).toBe("feature work");
    expect(git(dir, "status", "--porcelain", "--", ".", ":(exclude).loki")).toBe("");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("base\n");
    measured.push(`${p.at}: ack ${ackS.toFixed(3)}s, read at ${read}, seal ${p.sealRefuses ? "refuses (post-Wall)" : "accepts"}, diff: ${diffStat.split("\n").pop()!.trim()}`);
  }, 30000);
  test("steer KPI summary", () => { console.log(`steer-ack KPI\n${measured.join("\n")}`); expect(measured.length).toBe(POINTS.length); });
});
