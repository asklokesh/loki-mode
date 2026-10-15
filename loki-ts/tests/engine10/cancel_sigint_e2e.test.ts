// BUDGET slice (LM-002): SIGINT during an engine10 run. A stub claude records its pid and sleeps; the test sends
// SIGINT to the supervisor and asserts: the provider child is gone, the run is marked cancelled (not failed), the
// usage measured so far is written with its unmeasured flag, the summary prints, and the exit code is 130.
// Headless, no network, no real provider.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "issue-ref");
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "cli.ts");

const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

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
    temps.push(tmp);
    const repo = join(tmp, "repo");
    cpSync(join(FIX, "repo"), repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "e2e");
    git(repo, "config", "user.email", "e2e@example.invalid");
    git(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml");
    git(repo, "commit", "-q", "-m", "base");
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
