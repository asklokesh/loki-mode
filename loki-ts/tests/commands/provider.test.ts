import { describe, expect, it } from "bun:test";
import { run } from "../../src/util/shell.ts";
import { stripAnsi } from "../../src/util/colors.ts";
import { resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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

  it("lists every supported provider route", async () => {
    const a = await bunCmd(["provider", "list"]);
    const plain = stripAnsi(a.stdout);
    for (const p of ["claude", "codex", "cline", "aider", "opencode"]) {
      expect(plain).toContain(p);
    }
  });
});

describe("opencode provider selection", () => {
  it("persists the listed opencode route for provider and config selection", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "loki-provider-opencode-"));
    try {
      const selected = await run(["bun", CLI, "provider", "set", "opencode"], {
        cwd,
      });
      expect(selected.exitCode).toBe(0);
      expect(stripAnsi(selected.stdout)).toContain("Provider set to: opencode");
      expect(readFileSync(resolve(cwd, ".loki", "state", "provider"), "utf8")).toBe("opencode\n");

      const shown = await run(["bun", CLI, "provider", "show"], { cwd });
      expect(shown.exitCode).toBe(0);
      expect(stripAnsi(shown.stdout)).toContain("Provider: opencode");
      expect(stripAnsi(shown.stdout)).toContain("Model-agnostic mode");

      const configured = await run([BASH_CLI, "config", "set", "provider", "opencode"], { cwd });
      expect(configured.exitCode).toBe(0);
      const settings = JSON.parse(readFileSync(resolve(cwd, ".loki", "config", "settings.json"), "utf8"));
      expect(settings.provider).toBe("opencode");

      const info = await run(["bun", CLI, "provider", "info", "opencode"], {
        cwd,
      });
      expect(info.exitCode).toBe(0);
      expect(stripAnsi(info.stdout)).toContain("Model-agnostic mode");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
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
