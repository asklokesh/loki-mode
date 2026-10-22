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

describe("shell.run abort signal", () => {
  it("an aborted signal terminates the child instead of orphaning it", async () => {
    const ctl = new AbortController(), t0 = Date.now();
    setTimeout(() => ctl.abort(), 100);
    const r = await run(["sleep", "30"], { signal: ctl.signal });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.exitCode).not.toBe(0);
  });
});

describe("shell.run onFirstStdout", () => {
  it("fires exactly once across several stdout chunks", async () => {
    let n = 0;
    const r = await run(["sh", "-c", "echo a; sleep 0.1; echo b; sleep 0.1; echo c"], { onFirstStdout: () => { n++; } });
    expect(r.stdout).toBe("a\nb\nc\n");
    expect(n).toBe(1);
  });
  it("a throwing callback is ignored: stdout and exit code are intact", async () => {
    const r = await run(["sh", "-c", "echo ok"], { onFirstStdout: () => { throw new Error("boom"); } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok\n");
  });
  it("does not fire when the child prints nothing", async () => {
    let n = 0;
    await run(["true"], { onFirstStdout: () => { n++; } });
    expect(n).toBe(0);
  });
});
