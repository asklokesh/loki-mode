// Test-gap follow-up for E-07/E-12 (docs/v10/ENGINE.md section 11).
//
// session.test.ts's own "exports main matching cli.ts's routing contract"
// test only proves route(["session"]) resolves to the right module/fn pair,
// then swaps in a PROBE loader and a stub `main` -- it never runs cli.ts's
// real dynamic loader against session.ts's real exported `main`
// (sessionChildMain). This file closes that gap: it drives
// runEngine10(["session"]) with the DEFAULT loader (a genuine
// `import("./session.ts")` resolved from cli.ts's own directory) all the way
// into the real sessionChildMain, which calls resolveProvider() for real and
// then process.exit()s. Because that exit would kill the test runner itself,
// the real dispatch has to run in a spawned child with an explicit env (never
// the test process's own) -- the same pattern rule_of_two.test.ts uses for
// its fake worker (`[process.execPath, "-e", code]`).
//
// Provider is "codex", not "claude": codexProvider() needs no --help flag
// cache, no settings.json, no session-stamp UUIDs -- just one resolveCli()
// env var (LOKI_CODEX_CLI) pointing at a fake binary, so the dispatch itself
// stays the thing under test.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ABS = join(import.meta.dir, "..", "..", "src", "engine10", "cli.ts");

function driverCode(): string {
  // Top-level await of the REAL cli.ts loader path (defaultLoader = plain
  // `import(spec)`), exactly what `loki engine10 session` reaches in
  // production. sessionChildMain never returns -- it calls process.exit()
  // itself -- so the process.exit below only matters if that contract breaks.
  return [
    `const { runEngine10 } = await import(${JSON.stringify(CLI_ABS)});`,
    `const code = await runEngine10(["session"]);`,
    `process.exit(typeof code === "number" ? code : 0);`,
  ].join("\n");
}

function writeFakeCodex(dir: string): string {
  const cli = join(dir, "fake-codex.sh");
  const argvLog = join(dir, "argv.log");
  writeFileSync(cli, [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
    "exit 7",
  ].join("\n") + "\n");
  chmodSync(cli, 0o755);
  return cli;
}

describe("engine10 session dispatch: real cli.ts loader, real session.ts main", () => {
  test("runEngine10([\"session\"]) reaches the real sessionChildMain and propagates the provider's exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-session-dispatch-"));
    const fakeCodex = writeFakeCodex(dir);
    const brief = "dispatch-test-brief-marker";

    const proc = Bun.spawnSync({
      cmd: [process.execPath, "-e", driverCode()],
      cwd: dir,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        LOKI_E10_PROVIDER: "codex",
        LOKI_E10_BRIEF: brief,
        LOKI_E10_TIER: "development",
        LOKI_ITERATION: "e10-dispatch-1",
        LOKI_CODEX_CLI: fakeCodex,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = proc.stderr.toString();
    // Distinguishes "the real module was found and its real main ran" from
    // cli.ts's own not-built-yet fallback, which a broken loader path or a
    // typo'd routing table entry would otherwise silently satisfy.
    expect(stderr).not.toContain("not built yet");
    // sessionChildMain does `process.exit(result.exitCode)`: 7 can only come
    // from the fake codex binary's own exit, proving resolveProvider("codex")
    // really ran codexProvider().invoke(), not a stub.
    expect(proc.exitCode).toBe(7);

    const argv = readFileSync(join(dir, "argv.log"), "utf8");
    expect(argv).toContain("exec"); // codexProvider()'s real argv shape (providers.ts:847-852)
    expect(argv).toContain(brief); // the real LOKI_E10_BRIEF reached the real invoker's prompt

    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});
