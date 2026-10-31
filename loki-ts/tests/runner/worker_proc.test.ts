// #265 slice B: opt-in process limits on the engine10 worker spawn (FC-WORKER-NO-PROCESS-LIMITS).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWorker, ulimitArgv, ULIMIT_REFUSED_EXIT } from "../../src/runner/worker_proc.ts";

const dir = mkdtempSync(join(tmpdir(), "wp-"));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const baseEnv = { PATH: process.env.PATH };

const run = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const lines: string[] = [];
  const r = await spawnWorker(argv, env, dir, 20000, 1000, (l) => lines.push(l));
  return { ...r, lines };
};

describe("ulimitArgv", () => {
  test("both knobs unset: argv is returned byte-identical", () => {
    const argv = ["node", "-e", "1", "a b"];
    expect(ulimitArgv(argv, {})).toBe(argv);
    expect(ulimitArgv(argv, { LOKI_ULIMIT_NPROC: "", LOKI_ULIMIT_VMEM_KB: "" })).toBe(argv);
  });
  test("values travel as positional arguments, never in the script text", () => {
    const out = ulimitArgv(["w", "x"], { LOKI_ULIMIT_VMEM_KB: "1048576", LOKI_ULIMIT_NPROC: "64" });
    expect(out.slice(0, 2)).toEqual(["/bin/bash", "-c"]);
    expect(out.slice(3)).toEqual(["sh", "1048576", "64", "w", "x"]);
    expect(out[2]).not.toMatch(/1048576|64/);
  });
  for (const bad of ["5; rm -rf x", "-1", "0", "2.5", "abc", "08", "$(id)"]) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(() => ulimitArgv(["w"], { LOKI_ULIMIT_NPROC: bad })).toThrow(/LOKI_ULIMIT_NPROC must be a positive integer/);
    });
  }
});

describe("spawnWorker with limits", () => {
  test("NPROC=64: the worker sees ulimit -u 64", async () => {
    const r = await run(["/bin/bash", "-c", "ulimit -u"], { ...baseEnv, LOKI_ULIMIT_NPROC: "64" });
    expect(r.lines).toEqual(["64"]);
    expect(r.code).toBe(0);
  });
  test("unset knobs: the worker runs as before", async () => {
    const r = await run(["/bin/sh", "-c", "echo plain"], baseEnv);
    expect(r.lines).toEqual(["plain"]);
    expect(r.code).toBe(0);
  });
  test("a refused value spawns nothing and exits 97", async () => {
    const marker = join(dir, "spawned");
    const r = await run(["/bin/sh", "-c", `echo x > ${marker}`], { ...baseEnv, LOKI_ULIMIT_NPROC: "5; rm -rf x" });
    expect(r.code).toBe(ULIMIT_REFUSED_EXIT);
    expect(existsSync(marker)).toBe(false);
  });
  test("a ulimit the OS refuses exits 97 with the named reason and never runs the worker", async () => {
    // Stand-in for a platform whose ulimit -v fails: a shell function shadows the builtin inside the wrapper.
    const w = ulimitArgv(["/bin/sh", "-c", "echo ran"], { LOKI_ULIMIT_VMEM_KB: "1" });
    const r = await run(["/bin/sh", "-c", `ulimit() { return 1; }; ${w[2]}`, "sh", ...w.slice(4)], baseEnv);
    expect(r.code).toBe(ULIMIT_REFUSED_EXIT);
    expect(r.lines).toEqual([]);
    expect(w[2]).toContain("macOS rejects ulimit -v");
  });
});
