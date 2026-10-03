// CPE-09: run.pid write, remove and the three-way verification that guards Stop against PID reuse.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartTime, readRunPid, runPidPath, verifyRunPid, writeRunPid } from "../../src/util/run_pid.ts";

const dir = mkdtempSync(join(tmpdir(), "run-pid-"));
const kids: ReturnType<typeof spawn>[] = [];
afterAll(() => {
  for (const k of kids) if (k.exitCode === null) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
});
const sleeper = () => { const k = spawn("sleep", ["60"], { stdio: "ignore" }); kids.push(k); return k; };

test("writes pid, start time and argv as 0600 JSON, and removes only its own file", () => {
  const rm = writeRunPid(dir, "r1", process.pid, ["a", "b"]);
  const rec = readRunPid(dir)!;
  expect(rec.pid).toBe(process.pid);
  expect(rec.argv).toEqual(["a", "b"]);
  expect(rec.run_id).toBe("r1");
  expect(rec.start).toBe(processStartTime(process.pid)!);
  expect(statSync(runPidPath(dir)).mode & 0o777).toBe(0o600);
  writeFileSync(runPidPath(dir), JSON.stringify({ pid: 999999, start: "x", argv: [], run_id: "r1" }));
  rm();
  expect(existsSync(runPidPath(dir))).toBe(true); // someone else's file stays
  writeRunPid(dir, "r1")();
  expect(existsSync(runPidPath(dir))).toBe(false);
});

test("verify accepts a live matching process, and refuses stale, reused and foreign records", async () => {
  const k = sleeper();
  writeRunPid(dir, "r2", k.pid!);
  expect(verifyRunPid(dir, "r2")).toEqual({ ok: true, pid: k.pid! });
  const wrong = verifyRunPid(dir, "other");
  expect(wrong.ok).toBe(false);
  expect(!wrong.ok && wrong.reason).toContain("different run");
  const reused = verifyRunPid(dir, "r2", () => "Mon Jan  1 00:00:00 2001");
  expect(!reused.ok && reused.reason).toContain("start time differs");
  const stale = verifyRunPid(dir, "r2", () => null);
  expect(!stale.ok && stale.reason).toContain("no longer running");
  k.kill("SIGKILL");
  await new Promise((r) => k.once("exit", r));
  const gone = verifyRunPid(dir, "r2");
  expect(gone.ok).toBe(false);
});

test("a missing, corrupt or self-referencing run.pid is refused", () => {
  rmSync(runPidPath(dir), { force: true });
  expect(verifyRunPid(dir, "r3").ok).toBe(false);
  writeFileSync(runPidPath(dir), "not json");
  expect(verifyRunPid(dir, "r3").ok).toBe(false);
  writeRunPid(dir, "r3", process.pid);
  const self = verifyRunPid(dir, "r3");
  expect(!self.ok && self.reason).toContain("calling process");
  expect(processStartTime(1)).toBeNull();
});
