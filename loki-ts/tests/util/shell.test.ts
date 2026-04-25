import { describe, expect, it } from "bun:test";
import { run, runOrThrow, commandExists, commandVersion, ShellError } from "../../src/util/shell.ts";

describe("shell.run", () => {
  it("captures stdout from echo", async () => {
    const r = await run(["echo", "hello"]);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.exitCode).toBe(0);
  });

  it("captures non-zero exit without throwing", async () => {
    const r = await run(["sh", "-c", "exit 7"]);
    expect(r.exitCode).toBe(7);
  });

  it("respects timeoutMs", async () => {
    const r = await run(["sh", "-c", "sleep 2; echo done"], { timeoutMs: 100 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("done");
  });
});

describe("shell.runOrThrow", () => {
  it("throws ShellError on non-zero exit", async () => {
    let err: unknown;
    try {
      await runOrThrow(["sh", "-c", "exit 3"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ShellError);
    expect((err as ShellError).exitCode).toBe(3);
  });
});

describe("shell.commandExists", () => {
  it("finds sh", async () => {
    const path = await commandExists("sh");
    expect(path).toBeTruthy();
    expect(path!.length).toBeGreaterThan(0);
  });

  it("returns null for nonexistent command", async () => {
    const path = await commandExists("definitelynotacommand_xyz_42");
    expect(path).toBeNull();
  });

  it("rejects shell-injection attempts", async () => {
    let err: unknown;
    try {
      await commandExists("foo; rm -rf /");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });
});

describe("shell.commandVersion", () => {
  it("returns version string for bash", async () => {
    const v = await commandVersion("bash");
    expect(v).toBeTruthy();
    expect(v!).toMatch(/bash|GNU/i);
  });

  it("returns null for missing command", async () => {
    const v = await commandVersion("definitelynotacommand_xyz_42");
    expect(v).toBeNull();
  });
});
