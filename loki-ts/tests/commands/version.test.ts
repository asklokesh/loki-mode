import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
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

describe("version json", () => {
  it("version json prints version, runtime, install_path via the CLI", async () => {
    const a = await run(["bun", CLI, "version", "--json"]);
    expect(a.exitCode).toBe(0);
    const o = JSON.parse(a.stdout);
    const plain = await run(["bun", CLI, "version"]);
    expect(plain.stdout).toBe(`Loki Mode v${o.version}\n`);
    expect(o.runtime).toBe("bun");
    expect(o.install_path).toBe(REPO_ROOT);
    expect(Object.keys(o)).toEqual(["version", "runtime", "install_path"]);
  });

  it("version json bash route matches version and shape", async () => {
    const a = await run(["bun", CLI, "version", "--json"]);
    const b = await run([BASH_CLI, "version", "--json"]);
    expect(b.exitCode).toBe(0);
    const o = JSON.parse(b.stdout);
    expect(o.version).toBe(JSON.parse(a.stdout).version);
    expect(o.runtime).toBe("bash");
    expect(typeof o.install_path).toBe("string");
  });
});

describe("version unknown flag", () => {
  it("unknown flag exits 2 with usage and no version on stdout", async () => {
    const a = await run(["bun", CLI, "version", "--bogus"]);
    expect(a.exitCode).toBe(2);
    expect(a.stdout).toBe("");
    expect(a.stderr).toContain("Unknown option for version: --bogus");
    expect(a.stderr).toContain("Usage: loki version [--json]");
  });

  it("known flags still succeed", async () => {
    for (const f of ["--json", "--help", "-h", "help"]) {
      const a = await run(["bun", CLI, "version", f]);
      expect(a.exitCode).toBe(0);
    }
    const p = await run(["bun", CLI, "version"]);
    expect(p.stdout).toMatch(/^Loki Mode v\d+\.\d+\.\d+\n$/);
  });
});

describe("version extra args", () => {
  it("extra positional exits 2 with usage and no version on stdout", async () => {
    for (const argv of [["version", "bogus"], ["--version", "bogus"], ["-v", "bogus"], ["version", "--json", "bogus"]]) {
      const a = await run(["bun", CLI, ...argv]);
      expect(a.exitCode).toBe(2);
      expect(a.stdout).toBe("");
      expect(a.stderr).toContain("Unexpected argument for version: bogus");
      expect(a.stderr).toContain("Usage: loki version [--json]");
    }
  });

  it("bare help word still prints help", async () => {
    const a = await run(["bun", CLI, "version", "help"]);
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toContain("Usage: loki version");
  });
});
