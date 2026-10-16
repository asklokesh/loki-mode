// E-21: `loki status` (docs/v10/ENGINE.md section 11, section 5).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readEvents } from "../../src/engine10/events.ts";
import { main } from "../../src/contrib/status.ts";
import { eventsPath as runEventsPath, latestRunId, listRunIds, render, runsRoot, summarize } from "../../src/commands/run_status.ts";
import { groupGrid } from "../../src/features/speed/group_grid.ts";

function capture(stream: "stdout" | "stderr", fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const target = process[stream];
  const orig = target.write.bind(target);
  let out = "";
  target.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof target.write;
  return fn()
    .then((code) => ({ code, out }))
    .finally(() => {
      target.write = orig;
    });
}

let repoDir: string;
let origRepoDir: string | undefined;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "e10-status-"));
  origRepoDir = process.env.LOKI_E10_REPO_DIR;
  process.env.LOKI_E10_REPO_DIR = repoDir;
});
afterEach(() => {
  if (origRepoDir === undefined) delete process.env.LOKI_E10_REPO_DIR;
  else process.env.LOKI_E10_REPO_DIR = origRepoDir;
  rmSync(repoDir, { recursive: true, force: true });
});

const root = () => runsRoot(process.env, repoDir);
function writeRun(runId: string): EventLog {
  return new EventLog(runEventsPath(root(), runId), runId);
}

describe("latestRunId / listRunIds / runsRoot", () => {
  test("null when the runs dir does not exist (injected path, not a real-repo absence)", () => {
    expect(latestRunId(root())).toBeNull();
    expect(listRunIds(root())).toEqual([]);
  });
  test("picks the lexicographically last (= most recent) run id", () => {
    writeRun("e10-20260927T220000Z-aaaa").append("run.started", null, {});
    writeRun("e10-20260927T230000Z-bbbb").append("run.started", null, {});
    expect(latestRunId(root())).toBe("e10-20260927T230000Z-bbbb");
  });
  test("runsRoot joins the fixed .loki/runs path", () => {
    expect(runsRoot({}, repoDir)).toBe(join(repoDir, ".loki", "runs"));
  });
  test("runsRoot honors LOKI_DIR, so group_grid reads runs from there", () => {
    const alt = join(repoDir, "alt");
    const log = new EventLog(runEventsPath(runsRoot({ LOKI_DIR: alt }, repoDir), "e10-20260927T220000Z-gggg"), "e10-20260927T220000Z-gggg");
    log.append("run.started", null, { group_id: "g1" });
    const prev = process.env.LOKI_DIR;
    process.env.LOKI_DIR = alt;
    try {
      expect(groupGrid(repoDir, "g1").length).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.LOKI_DIR;
      else process.env.LOKI_DIR = prev;
    }
  });
});

describe("summarize (pure, folded events only)", () => {
  const runId = "e10-20260927T220000Z-ab12";
  const sum = (nowMs: number) => summarize(runId, readEvents(runEventsPath(root(), runId)), root(), nowMs);

  test("an unfinished run reports its current stage and elapsed time", () => {
    const log = writeRun(runId);
    log.append("run.started", null, { task_source: "text" });
    log.append("stage.started", "intake", { target_s: 15, limit_s: 60 });
    log.append("stage.completed", "intake", { duration_s: 11, base_sha: "x" });
    log.append("stage.started", "implement", { target_s: 180, limit_s: 480 });
    const events = readEvents(runEventsPath(root(), runId));
    const startedMs = Date.parse(events[0]!.ts);
    const view = sum(startedMs + 30_000);
    expect(view.stage).toBe("implement");
    expect(view.outcome).toBe("running");
    expect(view.elapsed_s).toBeCloseTo(30, 0);
  });

  test("plan and wall open together render as the combined \"plan+wall\" stage", () => {
    const log = writeRun(runId);
    log.append("run.started", null, {});
    log.append("stage.started", "plan", {});
    log.append("stage.started", "wall", {});
    expect(sum(Date.now()).stage).toBe("plan+wall");
  });

  test("a finished run reports the verdict and no current stage", () => {
    const log = writeRun(runId);
    log.append("run.started", null, {});
    log.append("stage.started", "intake", {});
    log.append("stage.completed", "intake", { duration_s: 5 });
    log.append("run.completed", null, { verdict: "VERIFIED" });
    const view = sum(Date.now());
    expect(view.outcome).toBe("VERIFIED");
    expect(view.stage).toBeNull();
  });

  test("a skipped optional stage is not treated as open", () => {
    const log = writeRun(runId);
    log.append("run.started", null, {});
    log.append("stage.started", "plan", {});
    log.append("stage.skipped", "plan", { reason: "module not present" });
    expect(sum(Date.now()).stage).toBeNull();
  });

  test("render names the run, the stage while running and the verdict once done", () => {
    writeRun(runId).append("run.started", null, {});
    const running = { ...sum(Date.now()), control_plane_url: null };
    expect(render({ ...running, stage: "intake", state: "executing", outcome: "running" })).toContain("executing, intake");
    expect(render({ ...running, stage: null, state: "budget_stopped", outcome: "PARTIAL" })).toContain("budget_stopped (PARTIAL)");
    expect(render(running)).toContain(runId);
  });
});

describe("main (cli.ts calls this with `args`, section 11)", () => {
  test("no runs found: exit 0, one hint line on stdout", async () => {
    const { code, out } = await capture("stdout", () => main([]));
    expect(code).toBe(0);
    expect(out).toContain("No Loki 10 runs here yet");
  });

  test("an explicit unknown run id: exit 1", async () => {
    const { code, out } = await capture("stderr", () => main(["e10-does-not-exist"]));
    expect(code).toBe(1);
    expect(out).toContain("e10-does-not-exist");
  });

  test("defaults to the latest run and prints its status on stdout", async () => {
    const log1 = writeRun("e10-20260927T220000Z-aaaa");
    log1.append("run.started", null, {});
    log1.append("run.completed", null, { verdict: "PARTIAL" });
    const log2 = writeRun("e10-20260927T230000Z-bbbb");
    log2.append("run.started", null, {});
    log2.append("stage.started", "intake", {});
    log2.append("stage.completed", "intake", { duration_s: 3 });
    log2.append("run.completed", null, { verdict: "VERIFIED" });

    const { code, out } = await capture("stdout", () => main([]));
    expect(code).toBe(0);
    expect(out).toContain("e10-20260927T230000Z-bbbb");
    expect(out).toContain("VERIFIED");
  });

  test("an explicit run id overrides the latest", async () => {
    writeRun("e10-20260927T220000Z-aaaa").append("run.started", null, {});
    writeRun("e10-20260927T230000Z-bbbb").append("run.started", null, {});
    const { code, out } = await capture("stdout", () => main(["e10-20260927T220000Z-aaaa"]));
    expect(code).toBe(0);
    expect(out).toContain("e10-20260927T220000Z-aaaa");
  });
});
