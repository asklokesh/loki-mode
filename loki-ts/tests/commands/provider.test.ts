import { describe, expect, it } from "bun:test";
import { run } from "../../src/util/shell.ts";
import { stripAnsi } from "../../src/util/colors.ts";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

async function bunCmd(args: string[]) {
  return run(["bun", CLI, ...args]);
}

async function bashCmd(args: string[]) {
  return run([BASH_CLI, ...args]);
}

describe("provider show", () => {
  it("byte-for-byte parity with bash (default)", async () => {
    const a = await bunCmd(["provider", "show"]);
    const b = await bashCmd(["provider", "show"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("contains expected sections", async () => {
    const a = await bunCmd(["provider", "show"]);
    const plain = stripAnsi(a.stdout);
    expect(plain).toContain("Current Provider");
    expect(plain).toContain("Provider:");
    expect(plain).toContain("Status:");
  });
});

describe("provider list", () => {
  it("byte-for-byte parity with bash", async () => {
    const a = await bunCmd(["provider", "list"]);
    const b = await bashCmd(["provider", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("lists all 5 providers", async () => {
    const a = await bunCmd(["provider", "list"]);
    const plain = stripAnsi(a.stdout);
    for (const p of ["claude", "codex", "gemini", "cline", "aider"]) {
      expect(plain).toContain(p);
    }
  });
});

describe("provider unknown subcommand", () => {
  it("prints help on unknown subcommand", async () => {
    const a = await bunCmd(["provider", "definitelynotacommand"]);
    expect(a.exitCode).toBe(0);
    expect(stripAnsi(a.stdout)).toContain("Loki Mode Provider Management");
  });
});
