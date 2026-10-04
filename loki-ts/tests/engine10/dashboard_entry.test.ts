// E-49: loki dashboard reachable through the real entry (docs/v10/ENGINE.md
// section 12). E-24 already unit-tests startServer()/summarizeRun() directly
// (dashboard.test.ts); this proves the CLI route actually reaches them: `cli.ts
// engine10 dashboard` (cli.ts's "engine10" dispatch, TABLE["dashboard"] route) starts the real
// Bun.serve and serves a run folded from a fixture events.jsonl written
// straight to disk, with no engine run behind it. Test only, per the BOARD row.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "cli.ts");

const temps: string[] = [];
const procs: Bun.Subprocess[] = [];
afterAll(async () => {
  for (const p of procs) {
    p.kill();
    await p.exited;
  }
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function mkRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "e10-dash-entry-"));
  temps.push(d);
  return d;
}

const ev = (seq: number, type: string, stage: string | null, data: Record<string, unknown>) => ({
  v: 1, seq, ts: `2026-09-27T00:00:${String(seq).padStart(2, "0")}Z`, run: "r1", type, stage, data,
});

function writeRun(repoDir: string, runId: string, lines: Record<string, unknown>[]): void {
  const dir = join(repoDir, ".loki", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(25);
  }
}

describe("engine10 dashboard entry e2e (real cli.ts, real Bun.serve)", () => {
  test("engine10 dashboard serves a run folded from a fixture event log", async () => {
    const repoDir = mkRepo();
    writeRun(repoDir, "r1", [
      ev(0, "run.started", null, {}),
      ev(1, "receipt.sealed", "seal", { not_proven: ["app boot"] }),
      ev(2, "pr.opened", "pr", { url: "https://github.com/o/r/pull/9", draft: false }),
      ev(3, "cost", null, { session_id: "s1", usd: 0.42 }),
      ev(4, "run.completed", null, { verdict: "VERIFIED" }),
    ]);

    // A fixed high port (never 0): main() prints the URL but there is no
    // point reading it back from stdout when we can just pick the port and
    // poll until it answers, same as any other "wait for the server" test.
    const port = 51000 + (process.pid % 4000);
    const url = `http://127.0.0.1:${port}/`;
    const env: Record<string, string | undefined> = {
      ...process.env,
      LOKI_TS_ENTRY: ENTRY,
      LOKI_E10_DASHBOARD_PORT: String(port),
      LOKI_NO_BROWSER: "1",
    };
    delete env.LOKI_LEGACY_BASH; // would skip the engine10 route entirely

    const proc = Bun.spawn({
      cmd: [process.execPath, ENTRY, "engine10", "dashboard"],
      cwd: repoDir,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    procs.push(proc);

    await waitFor(async () => {
      try {
        return (await fetch(url)).status === 200;
      } catch {
        return false;
      }
    }, 10_000);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Loki 10 dashboard</title>");

    const runs = (await (await fetch(`${url}api/runs`)).json()) as {
      runId: string;
      verdict: string;
      pr: { url: string; draft: boolean } | null;
      notProven: string[] | null;
      costUsd: number | null;
      wallS: number | null;
    }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe("r1");
    expect(runs[0]!.verdict).toBe("VERIFIED");
    expect(runs[0]!.pr).toEqual({ url: "https://github.com/o/r/pull/9", draft: false });
    expect(runs[0]!.notProven).toEqual(["app boot"]);
    expect(runs[0]!.costUsd).toBe(0.42);
    expect(runs[0]!.wallS).toBe(4);

    proc.kill();
    expect(await proc.exited).not.toBe(0); // killed while blocked forever, never a clean exit
  }, 20_000);
});
