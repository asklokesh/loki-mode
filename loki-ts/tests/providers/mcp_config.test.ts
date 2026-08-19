// loki-ts/tests/providers/mcp_config.test.ts -- Phase D (v7.5.22) MCP config tests.
//
// Covers:
// - mcpConfigPath writes the bundle to <targetDir>/.loki/mcp-config.json
// - Re-call is idempotent (mtime unchanged within 1s window)
// - buildMcpConfigArgv emits single --mcp-config <path> when user file absent
// - buildMcpConfigArgv emits both paths when user file present (variadic)
// - No env-var-shaped string (${...}) appears in the written file (no shell expansion)
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpConfigPath, userMcpConfigPath, buildMcpConfigArgv } from "../../src/providers/mcp_config.ts";

describe("mcp_config.mcpConfigPath", () => {
  let td: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    td = mkdtempSync(join(tmpdir(), "loki-mcp-cfg-"));
    // Phase G: stub PATH to an empty dir so LSP detection is deterministically
    // false during these tests. Without this, tests that assert the bundle
    // shape would fail on machines where typescript-language-server, pylsp,
    // gopls, or rust-analyzer happen to be on PATH.
    savedPath = process.env["PATH"];
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "loki-mcp-empty-path-"));
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  it("returns absolute path under .loki/ and writes the bundle (no LSP)", () => {
    const p = mcpConfigPath(td);
    expect(p).toBe(join(td, ".loki", "mcp-config.json"));
    const body = readFileSync(p, "utf8");
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({
      mcpServers: {
        "loki-mode": { command: "python3", args: ["-m", "mcp.server"] },
      },
    });
  });

  it("re-call is idempotent (mtime unchanged within 1s)", async () => {
    const p = mcpConfigPath(td);
    const mtime1 = statSync(p).mtimeMs;
    // Small sleep so a re-write would change mtime in a measurable way.
    await new Promise((r) => setTimeout(r, 50));
    const p2 = mcpConfigPath(td);
    expect(p2).toBe(p);
    const mtime2 = statSync(p).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it("no env-var-shaped string (${...}) appears in the written file", () => {
    const p = mcpConfigPath(td);
    const body = readFileSync(p, "utf8");
    // Security: bundle must not contain shell-expansion patterns ($VAR or ${VAR})
    // which Claude could pass through to the spawned MCP server unexpanded.
    expect(body.includes("${")).toBe(false);
    expect(/\$[A-Za-z_]/.test(body)).toBe(false);
  });

  // Phase G (v7.5.24): LSP-proxy entry injected when supported binary on PATH.
  it("injects lsp-proxy entry when an LSP binary is on PATH", () => {
    // Drop a fake `typescript-language-server` binary into a temp dir and
    // prepend that dir to PATH. The detector only checks for a file's
    // existence, so the binary need not be executable in the test.
    const fakeBinDir = mkdtempSync(join(tmpdir(), "loki-mcp-bin-"));
    try {
      const fakeBin = join(fakeBinDir, "typescript-language-server");
      writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
      process.env["PATH"] = fakeBinDir;
      const p = mcpConfigPath(td);
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      expect(parsed.mcpServers["lsp-proxy"]).toEqual({
        command: "python3",
        args: ["-m", "mcp.lsp_proxy"],
      });
    } finally {
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });
});

describe("mcp_config.buildMcpConfigArgv", () => {
  let td: string;
  let homeDir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    td = mkdtempSync(join(tmpdir(), "loki-mcp-argv-"));
    homeDir = mkdtempSync(join(tmpdir(), "loki-mcp-home-"));
    savedHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  });

  it("emits single --mcp-config <path> when user overlay absent", () => {
    // userMcpConfigPath returns null because ~/.claude/mcp.json doesn't exist.
    expect(userMcpConfigPath()).toBeNull();
    const argv = buildMcpConfigArgv(td);
    expect(argv).toEqual(["--mcp-config", join(td, ".loki", "mcp-config.json")]);
  });

  it("ignores a legacy servers overlay instead of making Claude refuse", () => {
    const userCfgDir = join(homeDir, ".claude");
    const userCfg = join(userCfgDir, "mcp.json");
    mkdirSync(userCfgDir, { recursive: true });
    writeFileSync(userCfg, JSON.stringify({ servers: { custom: { command: "foo" } } }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(userMcpConfigPath()).toBeNull();
    expect(buildMcpConfigArgv(td)).toEqual([
      "--mcp-config",
      join(td, ".loki", "mcp-config.json"),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('top-level "mcpServers" object'));
    warn.mockRestore();
  });

  it("emits both paths when a current mcpServers overlay is present", () => {
    const userCfgDir = join(homeDir, ".claude");
    const userCfg = join(userCfgDir, "mcp.json");
    mkdirSync(userCfgDir, { recursive: true });
    writeFileSync(userCfg, JSON.stringify({ mcpServers: { custom: { command: "foo" } } }));
    expect(userMcpConfigPath()).toBe(userCfg);
    const argv = buildMcpConfigArgv(td);
    expect(argv).toEqual([
      "--mcp-config",
      join(td, ".loki", "mcp-config.json"),
      userCfg,
    ]);
  });

  it("ignores an oversized overlay without reading it", () => {
    const userCfgDir = join(homeDir, ".claude");
    const userCfg = join(userCfgDir, "mcp.json");
    mkdirSync(userCfgDir, { recursive: true });
    writeFileSync(userCfg, JSON.stringify({ mcpServers: {}, padding: "x".repeat(1024 * 1024) }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(userMcpConfigPath()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 MiB safety limit"));
    warn.mockRestore();
  });

  it("userMcpConfigPath returns null when HOME unset", () => {
    delete process.env["HOME"];
    expect(userMcpConfigPath()).toBeNull();
  });
});
