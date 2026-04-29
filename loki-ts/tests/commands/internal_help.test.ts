// v7.5.5 (#204): `loki internal` and `loki internal --help` print a
// discoverable subcommand listing instead of failing silently. Verified
// by spawning the CLI as a subprocess so the dispatch path is exercised
// end-to-end.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

describe("loki internal -- help / discovery", () => {
  test("bare `internal` prints help and exits 0", async () => {
    const r = await runCli(["internal"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("loki internal");
    expect(r.out).toContain("phase1-hooks");
  });

  test("`internal --help` prints help and exits 0", async () => {
    const r = await runCli(["internal", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("phase1-hooks");
  });

  test("`internal -h` prints help", async () => {
    const r = await runCli(["internal", "-h"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("phase1-hooks");
  });

  test("`internal help` prints help", async () => {
    const r = await runCli(["internal", "help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("phase1-hooks");
  });

  test("unknown internal subcommand exits 2 and points to --help", async () => {
    const r = await runCli(["internal", "bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown internal subcommand: bogus");
    expect(r.err).toContain("loki internal --help");
  });
});
