// E-21: `loki status` (docs/v10/ENGINE.md section 11, section 5).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, fold, readEvents } from "../../src/engine10/events.ts";
import { buildStatus, eventsPath, findLatestRun, main, renderStatus, runsDir } from "../../src/engine10/status.ts";

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

function writeRun(runId: string): EventLog {
  return new EventLog(eventsPath(repoDir, runId), runId);
}

describe("findLatestRun", () => {
  test("null when the runs dir does not exist (injected path, not a real-repo absence)", () => {
    expect(findLatestRun(repoDir)).toBeNull();
  });
  test("picks the lexicographically last (= most recent) run id", () => {
    writeRun("e10-20260927T220000Z-aaaa").append("run.started", null, {});
    writeRun("e10-20260927T230000Z-bbbb").append("run.started", null, {});
    expect(findLatestRun(repoDir)).toBe("e10-20260927T230000Z-bbbb");
  });
  test("runsDir joins the fixed .loki/runs path", () => {
    expect(runsDir(repoDir)).toBe(join(repoDir, ".loki", "runs"));
  });
});

describe("buildStatus (pure, folded events only)", () => {
  const runId = "e10-20260927T220000Z-ab12";

  test("an unfinished run reports its current stage and elapsed time", () => {
    const log = writeRun(runId);
    log.append("run.started", null, { task_source: "text" });
    log.append("stage.started", "intake", { target_s: 15, limit_s: 60 });
    log.append("stage.completed", "intake", { duration_s: 11, base_sha: "x" });
    log.append("stage.started", "implement", { target_s: 180, limit_s: 480 });

    const events = readEvents(eventsPath(repoDir, runId));
    const startedMs = Date.parse(events[0]!.ts);
    const implStartMs = Date.parse(events[3]!.ts);
    const view = buildStatus(runId, events, fold(events), implStartMs + 30_000);

    expect(view.verdict).toBeNull();
    expect(view.currentStage).toBe("implement");
    expect(view.elapsedS).toBeCloseTo(30, 0);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]).toContain("intake");
    expect(view.lines[0]).toContain("done");
    void startedMs;
  });

  test("plan and wall open together render as the combined \"plan+wall\" stage", () => {
    const log = writeRun(runId);
    log.append("run.started", null, {});
    log.append("stage.started", "plan", {});
    log.append("stage.started", "wall", {});
    const events = readEvents(eventsPath(repoDir, runId));
    const view = buildStatus(runId, events, fold(events), Date.now());
    expect(view.currentStage).toBe("plan+wall");
  });

  test("a finished run reports the verdict and no current stage", () => {
    const log = writeRun(runId);
    log.append("run.started", null, {});
    log.append("stage.started", "intake", {});
    log.append("stage.completed", "intake", { duration_s: 5 });
    log.append("run.completed", null, { verdict: "VERIFIED" });
    const events = readEvents(eventsPath(repoDir, runId));
    const view = buildStatus(runId, events, fold(events), Date.now());
    expect(view.verdict).toBe("VERIFIED");
    expect(view.currentStage).toBeNull();
  });

  test("a skipped optional stage is listed, not treated as open", () => {
    const log = writeRun(runId);
    log.append("run.started", null, {});
    log.append("stage.started", "plan", {});
    log.append("stage.skipped", "plan", { reason: "module not present" });
    const events = readEvents(eventsPath(repoDir, runId));
    const view = buildStatus(runId, events, fold(events), Date.now());
    expect(view.currentStage).toBeNull();
    expect(view.lines[0]).toContain("skipped");
  });

  // ENGINE.md section 5: "Unknown is never 0 ... every reader renders null
  // as 'not measured'". stage.skipped carries only `reason`, never
  // `duration_s`, so a skipped stage must never render a fabricated "0s".
  test("a skipped stage's untimed duration renders as not measured, never 0s", () => {
    const log = writeRun(runId);
    log.append("run.started", null, {});
    log.append("stage.started", "plan", {});
    log.append("stage.skipped", "plan", { reason: "module not present" });
    const events = readEvents(eventsPath(repoDir, runId));
    const view = buildStatus(runId, events, fold(events), Date.now());
    expect(view.lines[0]).not.toContain("0s");
    expect(view.lines[0]).toContain("not measured");
  });

  test("renderStatus names the run and shows Stage: while running, Verdict: once done", () => {
    const running = buildStatus(runId, [], fold([]), Date.now());
    expect(renderStatus({ ...running, currentStage: "intake", elapsedS: 5 })).toContain("Stage:      intake");
    expect(renderStatus({ ...running, verdict: "PARTIAL" })).toContain("Verdict:    PARTIAL");
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
