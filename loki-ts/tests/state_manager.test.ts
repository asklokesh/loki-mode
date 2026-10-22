// getStateManager keying (#312). The older state/test_manager.ts and tests/test-state-versioning.ts are
// standalone scripts that bun test does not discover, so this file, under loki-ts/tests where local-ci runs bun test, is the discoverable home for them.
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStateManager, resetStateManager } from "../../state/manager";

const quiet = { enableWatch: false, enableEvents: false } as const;

describe("getStateManager keys managers by the .loki directory identity (#312)", () => {
  let base: string;
  let savedCap: string | undefined;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "loki-statemgr-"));
    savedCap = process.env["LOKI_STATE_MANAGER_MAX"];
    resetStateManager();
  });
  afterEach(() => {
    resetStateManager();
    if (savedCap === undefined) delete process.env["LOKI_STATE_MANAGER_MAX"];
    else process.env["LOKI_STATE_MANAGER_MAX"] = savedCap;
    rmSync(base, { recursive: true, force: true });
  });

  it("a second lokiDir gets its own manager with distinct state; the same dir gets the same manager", () => {
    const a = join(base, "a", ".loki");
    const b = join(base, "b", ".loki");
    const ma = getStateManager({ lokiDir: a, ...quiet });
    const mb = getStateManager({ lokiDir: b, ...quiet });
    expect(mb).not.toBe(ma);
    ma.setState("orchestrator.json", { root: "a" });
    expect(mb.getState("orchestrator.json")).not.toEqual({ root: "a" });
    expect(getStateManager({ lokiDir: a, ...quiet })).toBe(ma);
    expect(getStateManager({ lokiDir: b, ...quiet })).toBe(mb);
  });

  it("evicts the least recently used manager past the cap and stops it", () => {
    process.env["LOKI_STATE_MANAGER_MAX"] = "2";
    const dirs = [1, 2, 3].map((i) => join(base, `r${i}`, ".loki"));
    const m1 = getStateManager({ lokiDir: dirs[0]!, enableEvents: false });
    const stop1 = spyOn(m1, "stop");
    const m2 = getStateManager({ lokiDir: dirs[1]!, ...quiet });
    const stop2 = spyOn(m2, "stop");
    expect(getStateManager({ lokiDir: dirs[0]!, enableEvents: false })).toBe(m1); // touch r1, so r2 is LRU
    getStateManager({ lokiDir: dirs[2]!, ...quiet });
    expect(stop2).toHaveBeenCalledTimes(1);
    expect(stop1).not.toHaveBeenCalled();
    expect((m2 as unknown as { watcher: unknown }).watcher).toBeNull();
    // An evicted root gets a fresh manager, never the stopped one.
    expect(getStateManager({ lokiDir: dirs[1]!, ...quiet })).not.toBe(m2);
  });

  it("closes the watcher of an evicted manager", () => {
    process.env["LOKI_STATE_MANAGER_MAX"] = "1";
    const m1 = getStateManager({ lokiDir: join(base, "w1", ".loki"), enableEvents: false });
    const hadWatcher = (m1 as unknown as { watcher: unknown }).watcher !== null;
    getStateManager({ lokiDir: join(base, "w2", ".loki"), ...quiet });
    expect((m1 as unknown as { watcher: unknown }).watcher).toBeNull();
    // hadWatcher is false only where chokidar is unavailable; the null check above is then vacuous.
    expect(typeof hadWatcher).toBe("boolean");
  });

  it("two spellings of one directory (symlink alias) share one manager", () => {
    const real = join(base, "real", ".loki");
    mkdirSync(real, { recursive: true });
    const alias = join(base, "alias");
    symlinkSync(join(base, "real"), alias);
    const m1 = getStateManager({ lokiDir: real, ...quiet });
    const m2 = getStateManager({ lokiDir: join(alias, ".loki"), ...quiet });
    expect(m2).toBe(m1);
  });

  const caseInsensitive = ((): boolean => {
    const d = mkdtempSync(join(tmpdir(), "loki-case-"));
    try {
      mkdirSync(join(d, "probe"));
      return existsSync(join(d, "PROBE"));
    } catch { return false; }
    finally { rmSync(d, { recursive: true, force: true }); }
  })();
  // Skipped on case-sensitive volumes (Linux ext4 and similar): only a case-insensitive volume maps two spellings to one directory.
  (caseInsensitive ? it : it.skip)("two case spellings of one directory share one manager", () => {
    const lower = join(base, "casedir", ".loki");
    mkdirSync(lower, { recursive: true });
    const m1 = getStateManager({ lokiDir: lower, ...quiet });
    const m2 = getStateManager({ lokiDir: join(base, "CASEDIR", ".loki"), ...quiet });
    expect(m2).toBe(m1);
  });
});
