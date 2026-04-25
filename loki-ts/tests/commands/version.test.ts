import { describe, expect, it } from "bun:test";
import { run } from "../../src/util/shell.ts";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

describe("version command", () => {
  it("byte-for-byte parity with bash autonomy/loki version", async () => {
    const a = await run(["bun", CLI, "version"]);
    const b = await run([BASH_CLI, "version"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("--version alias works", async () => {
    const a = await run(["bun", CLI, "--version"]);
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toMatch(/^Loki Mode v\d+\.\d+\.\d+/);
  });

  it("-v alias works", async () => {
    const a = await run(["bun", CLI, "-v"]);
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toMatch(/^Loki Mode v\d+\.\d+\.\d+/);
  });
});
