// #334 AC6: the engine10 session spawn is wrapped by the one profile builder.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { confineSpawn } from "../../src/util/os_confine.ts";
import { readSandboxStatus } from "../../src/commands/run_status.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";

const darwin = process.platform === "darwin";
const mk = (base: string) => mkdtempSync(join(base, "loki-run.confine."));

describe("confineSpawn", () => {
  test("auto wraps the command; the status file records the kind", () => {
    const ws = mk(tmpdir()); const run = join(ws, ".loki"); mkdirSync(run);
    const r = confineSpawn("/bin/echo", ["hi"], { workspace: ws, runDir: run, provider: "claude", env: { ...process.env, LOKI_OS_SANDBOX: "auto" } });
    if (r.active) {
      expect(r.args.slice(-2)).toEqual(["/bin/echo", "hi"]);
      expect(r.cmd === "/usr/bin/sandbox-exec" || r.cmd.endsWith("bwrap")).toBe(true);
    } else expect(r.warning).toContain("unconfined");
    expect(existsSync(join(run, "state", "os-sandbox.json"))).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });
  test("unset env is the default and leaves the command bare", () => {
    const ws = mk(tmpdir()); const run = join(ws, ".loki"); mkdirSync(run);
    const env = { ...process.env }; delete env["LOKI_OS_SANDBOX"];
    const r = confineSpawn("/bin/echo", ["hi"], { workspace: ws, runDir: run, provider: "claude", env });
    expect([r.cmd, r.args, r.active, r.warning]).toEqual(["/bin/echo", ["hi"], false, null]);
    rmSync(ws, { recursive: true, force: true });
  });
  test("off leaves the command bare with no warning", () => {
    const ws = mk(tmpdir()); const run = join(ws, ".loki"); mkdirSync(run);
    const r = confineSpawn("/bin/echo", ["hi"], { workspace: ws, runDir: run, provider: "claude", env: { ...process.env, LOKI_OS_SANDBOX: "off" } });
    expect([r.cmd, r.args, r.active, r.warning]).toEqual(["/bin/echo", ["hi"], false, null]);
    rmSync(ws, { recursive: true, force: true });
  });
  test("on with codex fails closed because codex cannot be nested", () => {
    const ws = mk(tmpdir()); const run = join(ws, ".loki"); mkdirSync(run);
    expect(() => confineSpawn("/bin/echo", [], { workspace: ws, runDir: run, provider: "codex", env: { ...process.env, LOKI_OS_SANDBOX: "on" } })).toThrow(/LOKI_OS_SANDBOX=on/);
    rmSync(ws, { recursive: true, force: true });
  });
  test("off writes kind none to the status file without spawning confinement", () => {
    const ws = mk(tmpdir()); const run = join(ws, ".loki"); mkdirSync(run);
    confineSpawn("/bin/echo", [], { workspace: ws, runDir: run, provider: "claude", env: { ...process.env, LOKI_OS_SANDBOX: "off" } });
    const j = JSON.parse(readFileSync(join(run, "state", "os-sandbox.json"), "utf8"));
    expect([j.kind, j.mode]).toEqual(["none", "off"]);
    rmSync(ws, { recursive: true, force: true });
  });
  test("codex applies its own sandbox and is reported unwrapped", () => {
    const ws = mk(tmpdir()); const run = join(ws, ".loki"); mkdirSync(run);
    const r = confineSpawn("/bin/echo", [], { workspace: ws, runDir: run, provider: "codex", env: { ...process.env, LOKI_OS_SANDBOX: "auto" } });
    expect(r.active).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });
});

describe.skipIf(!darwin)("session spawn is confined (macOS Seatbelt)", () => {
  test("a symlink in the workspace pointing outside cannot be read through the real session spawn", async () => {
    const ws = mk(tmpdir()); const run = join(ws, ".loki"); mkdirSync(run);
    const out = mkdtempSync(join(homedir(), ".loki-confine-out."));
    writeFileSync(join(out, "secret.txt"), "outside\n");
    symlinkSync(join(out, "secret.txt"), join(ws, "link.txt"));
    const marker = join(ws, "result.txt");
    const sh = `if /bin/cat '${join(ws, "link.txt")}' >/dev/null 2>&1; then echo READ > '${marker}'; else echo DENIED > '${marker}'; fi`;
    process.env["LOKI_OS_SANDBOX"] = "auto";
    const runner = createSessionRunner({ provider: "claude", lokiRoot: run, childCommand: ["/bin/sh", ["-c", sh]], confineChildCommand: true } as never);
    const ac = new AbortController();
    await runner.run({ cwd: ws, iterationId: "t1", stage: "implement", limitS: 30, signal: ac.signal } as never);
    delete process.env["LOKI_OS_SANDBOX"];
    expect(readFileSync(marker, "utf8").trim()).toBe("DENIED");
    rmSync(ws, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });
});

describe("loki status sandbox field", () => {
  test("reports what the launch recorded, and null when nothing was recorded", () => {
    const repo = mk(tmpdir());
    expect(readSandboxStatus(repo)).toBeNull();
    mkdirSync(join(repo, ".loki", "state"), { recursive: true });
    writeFileSync(join(repo, ".loki", "state", "os-sandbox.json"), JSON.stringify({ kind: "none", mode: "auto", provider: "claude", reason: "sandbox-exec missing" }));
    expect(readSandboxStatus(repo)).toEqual({ kind: "none", mode: "auto", provider: "claude", reason: "sandbox-exec missing" });
    rmSync(repo, { recursive: true, force: true });
  });
});
