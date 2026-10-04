// CLI-MODERN-2: `loki status` shows Loki 10 runs and never the legacy box.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../src/engine10/events.ts";
import { NO_RUN_HINT, runModernStatus } from "../../src/commands/run_status.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "e10-modern-status-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const env = (): NodeJS.ProcessEnv => ({ LOKI_E10_REPO_DIR: dir, LOKI_CONTROL: "0", HOME: dir });

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
  try { return { code: await runModernStatus(args, env()), out }; } finally { process.stdout.write = orig; }
}

function writeRun(id: string, opts: { done: boolean }): void {
  const runDir = join(dir, ".loki", "runs", id);
  const log = new EventLog(join(runDir, "events.jsonl"), id);
  log.append("run.started", null, { issue_ref: "acme/widgets#12", task_source: "issue" });
  log.append("stage.started", "implement", {});
  log.append("cost", "implement", { session_id: "s1", usd: 0.42 });
  if (opts.done) {
    log.append("stage.completed", "implement", { duration_s: 5 });
    writeFileSync(join(runDir, "receipt.json"), "{}");
    log.append("pr.opened", "pr", { url: "https://github.com/acme/widgets/pull/99", draft: false });
    log.append("run.completed", null, { verdict: "VERIFIED", pr_url: "https://github.com/acme/widgets/pull/99", cost_usd: 0.42 });
  }
}

describe("loki status (Loki 10)", () => {
  test("a completed run shows id, ref, cost, outcome, PR and receipt", async () => {
    writeRun("e10-20261003T000000Z-aaaa", { done: true });
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toContain("e10-20261003T000000Z-aaaa");
    expect(out).toContain("VERIFIED");
    expect(out).toContain("acme/widgets#12");
    expect(out).toContain("$0.42");
    expect(out).toContain("https://github.com/acme/widgets/pull/99");
    expect(out).toContain("receipt.json");
  });

  test("a live run is preferred over a newer-named completed one and shows its stage", async () => {
    writeRun("e10-20261003T000000Z-aaaa", { done: false });
    const { out } = await run([]);
    expect(out).toContain("running, implement");
  });

  test("only a stale STATUS.txt: no legacy box, one hint line", async () => {
    mkdirSync(join(dir, ".loki"), { recursive: true });
    writeFileSync(join(dir, ".loki", "STATUS.txt"), "Updated: Wed Jan 7 2026\nPhase: BOOTSTRAP\n");
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toBe(`${NO_RUN_HINT}\n`);
    expect(out).not.toMatch(/BOOTSTRAP|Phase|analyze|Loki Mode Status/);
  });

  test("no runs at all: exactly one hint line", async () => {
    const { out } = await run([]);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("loki");
  });

  test("--json parses and carries the same fields", async () => {
    writeRun("e10-20261003T000000Z-aaaa", { done: true });
    const j = JSON.parse((await run(["--json"])).out);
    expect(j.run_id).toBe("e10-20261003T000000Z-aaaa");
    expect(j.ref).toBe("acme/widgets#12");
    expect(j.outcome).toBe("VERIFIED");
    expect(j.cost_usd).toBeCloseTo(0.42);
    expect(j.pr_url).toBe("https://github.com/acme/widgets/pull/99");
    expect(j.receipt_path).toContain("receipt.json");
    expect(j.control_plane_url).toBeNull();
  });

  test("--json with no runs still parses", async () => {
    const j = JSON.parse((await run(["--json"])).out);
    expect(j.run_id).toBeNull();
    expect(j.hint).toBe(NO_RUN_HINT);
  });

  describe("Control Plane URL (A6a)", () => {
    let srv: ReturnType<typeof Bun.serve>;
    beforeEach(() => { srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ service: "loki-control", pid: process.pid }) }); });
    afterEach(() => { srv.stop(true); });
    async function runWith(e: NodeJS.ProcessEnv, args: string[]): Promise<string> {
      const orig = process.stdout.write.bind(process.stdout);
      let out = "";
      process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
      try { await runModernStatus(args, e); } finally { process.stdout.write = orig; }
      return out;
    }

    test("prints the URL the running CP listens on when instance.json is absent (LOKI_CONTROL_PORT)", async () => {
      writeRun("e10-20261003T000000Z-cccc", { done: true });
      const out = await runWith({ LOKI_E10_REPO_DIR: dir, HOME: dir, LOKI_CONTROL_PORT: String(srv.port) }, []);
      expect(out).toContain(`Control Plane: http://127.0.0.1:${srv.port}`);
    });

    test("a stale instance.json (dead pid) does not hide a live CP", async () => {
      mkdirSync(join(dir, ".loki", "control"), { recursive: true });
      writeFileSync(join(dir, ".loki", "control", "instance.json"), JSON.stringify({ pid: 2147483646, url: "http://127.0.0.1:1" }));
      const j = JSON.parse(await runWith({ LOKI_E10_REPO_DIR: dir, HOME: dir, LOKI_CONTROL_PORT: String(srv.port) }, ["--json"]));
      expect(j.control_plane_url).toBe(`http://127.0.0.1:${srv.port}`);
    });

    test("no runs: the text output still names the CP URL", async () => {
      const out = await runWith({ LOKI_E10_REPO_DIR: dir, HOME: dir, LOKI_CONTROL_PORT: String(srv.port) }, []);
      expect(out).toContain(`Control Plane: http://127.0.0.1:${srv.port}`);
    });

    test("nothing listening: no Control Plane line", async () => {
      const out = await runWith({ LOKI_E10_REPO_DIR: dir, HOME: dir, LOKI_CONTROL_PORT: "1" }, []);
      expect(out).not.toContain("Control Plane:");
    });
  });
});
