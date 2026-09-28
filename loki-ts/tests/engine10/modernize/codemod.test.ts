// M-16: deterministic codemods first (futurize for py2 to 3, OpenRewrite for java 8 to 21), or
// skipped with a reason when the tool is absent. The runner is stubbed throughout: no test here
// depends on futurize or mvn actually being on PATH.
import { describe, expect, it } from "bun:test";
import { realCommandRunner, runCodemod } from "../../../src/engine10/modernize/codemod.ts";
import type { CommandRunner } from "../../../src/engine10/modernize/codemod.ts";

const files = ["a.py", "b.py"];

describe("runCodemod", () => {
  it("runs futurize for the python3 target", () => {
    const calls: [string, string[], string][] = [];
    const runner: CommandRunner = (cmd, args, cwd) => {
      calls.push([cmd, args, cwd]);
      return { found: true, code: 0 };
    };
    const out = runCodemod("python3", files, "/repo", runner);
    expect(out.tool).toBe("futurize");
    expect(out.ran).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.skippedReason).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("futurize");
    expect(calls[0]![1]).toEqual(["--write", "--nobackups", "a.py", "b.py"]);
    expect(calls[0]![2]).toBe("/repo");
  });

  it("runs OpenRewrite's UpgradeToJava21 recipe via maven for the java21 target", () => {
    const runner: CommandRunner = () => ({ found: true, code: 0 });
    const out = runCodemod("java21", ["A.java"], "/repo", runner);
    expect(out.tool).toBe("openrewrite");
    expect(out.ran).toBe(true);
    expect(out.applied).toBe(true);
  });

  it("skips with a reason when the tool binary is not found", () => {
    const runner: CommandRunner = () => ({ found: false, code: null });
    const out = runCodemod("python3", files, "/repo", runner);
    expect(out.ran).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.skippedReason).toBe("futurize not found on PATH");
  });

  it("ran is true but applied is false when the tool runs and exits non-zero", () => {
    const runner: CommandRunner = () => ({ found: true, code: 1 });
    const out = runCodemod("python3", files, "/repo", runner);
    expect(out.ran).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.skippedReason).toBeNull();
  });

  it("skips an empty unit without invoking the runner", () => {
    let invoked = false;
    const runner: CommandRunner = () => {
      invoked = true;
      return { found: true, code: 0 };
    };
    const out = runCodemod("python3", [], "/repo", runner);
    expect(out.ran).toBe(false);
    expect(out.skippedReason).toBe("no files in unit");
    expect(invoked).toBe(false);
  });

  it("defaults to the real command runner when none is passed", () => {
    const out = runCodemod("python3", files, "/repo", undefined);
    expect(out.target).toBe("python3");
    expect(out.tool).toBe("futurize");
  });

  it("realCommandRunner reports a nonexistent binary as found:false, not a throw", () => {
    // A command name that cannot exist on PATH, regardless of what this machine has installed --
    // keeps this test deterministic without depending on futurize/mvn being absent.
    const r = realCommandRunner("loki-mode-codemod-tool-that-does-not-exist-xyz", [], "/repo");
    expect(r.found).toBe(false);
    expect(r.code).toBeNull();
  });
});
