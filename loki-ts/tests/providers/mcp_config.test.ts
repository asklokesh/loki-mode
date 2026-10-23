// loki-ts/tests/providers/mcp_config.test.ts -- Phase D (v7.5.22) MCP config tests.
//
// Covers:
// - mcpConfigPath writes the bundle to <targetDir>/.loki/mcp-config.json
// - Re-call is idempotent (mtime unchanged within 1s window)
// - buildMcpConfigArgv emits single --mcp-config <path> when user file absent
// - buildMcpConfigArgv emits both paths when user file present (variadic)
// - No env-var-shaped string (${...}) appears in the written file (no shell expansion)
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync, mkdirSync, writeFileSync, chmodSync, readdirSync, symlinkSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpConfigPath, userMcpConfigPath, buildMcpConfigArgv, mcpLaunchFor } from "../../src/providers/mcp_config.ts";

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

// CW-10: per-provider MCP launch.
describe("mcp_config.mcpLaunchFor", () => {
  const MCP_SH = resolve(import.meta.dir, "../../../autonomy/lib/mcp-config.sh");
  let td: string;
  let homeDir: string;
  let emptyBin: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["HOME", "PATH", "LOKI_MCP_PROJECT"];

  const writeUser = (servers: unknown) => {
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  };
  const writeProject = (servers: unknown) =>
    writeFileSync(join(td, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  const bashLaunch = (provider: string) => {
    const r = spawnSync("bash", ["-c", `source "${MCP_SH}"; loki_mcp_launch_for "$1" "$2"`, "x", provider, td], {
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout);
  };

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    td = mkdtempSync(join(tmpdir(), "loki-mcp-launch-"));
    homeDir = mkdtempSync(join(tmpdir(), "loki-mcp-home-"));
    emptyBin = mkdtempSync(join(tmpdir(), "loki-mcp-nobin-"));
    process.env["HOME"] = homeDir;
    // python3 must stay resolvable for the bash mirror; keep system dirs, drop LSP bins via a clean list.
    process.env["PATH"] = `${emptyBin}:/usr/bin:/bin`;
    delete process.env["LOKI_MCP_PROJECT"];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of [td, homeDir, emptyBin]) rmSync(d, { recursive: true, force: true });
  });

  it("claude: argv is identical to buildMcpConfigArgv, env empty", () => {
    expect(mcpLaunchFor("claude", td)).toEqual({ argv: buildMcpConfigArgv(td), env: {} });
    expect(mcpLaunchFor("claude", td).argv).toEqual(["--mcp-config", join(td, ".loki", "mcp-config.json")]);
  });

  it("codex: pins exact -c overrides for the bundle", () => {
    expect(mcpLaunchFor("codex", td)).toEqual({
      argv: ["-c", 'mcp_servers.loki-mode.command="python3"', "-c", 'mcp_servers.loki-mode.args=["-m","mcp.server"]'],
      env: {},
    });
  });

  it("opencode: pins OPENCODE_CONFIG_CONTENT for the bundle", () => {
    expect(mcpLaunchFor("opencode", td)).toEqual({
      argv: [],
      env: {
        OPENCODE_CONFIG_CONTENT:
          '{"mcp":{"loki-mode":{"type":"local","command":["python3","-m","mcp.server"],"enabled":true}}}',
      },
    });
  });

  it("FC-PROVIDER-VERSION-PROBE-FULL-ENV: the cline version probe never receives GH_TOKEN, GITHUB_TOKEN or SSH_AUTH_SOCK", () => {
    const fake = join(emptyBin, "cline"), seen = join(td, "seen.txt");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s|%s|%s' "$GH_TOKEN" "$GITHUB_TOKEN" "$SSH_AUTH_SOCK" > '${seen}'\necho 3.1.4\n`);
    chmodSync(fake, 0o755);
    const saved = { a: process.env["GH_TOKEN"], b: process.env["GITHUB_TOKEN"], c: process.env["SSH_AUTH_SOCK"] };
    process.env["GH_TOKEN"] = "canary-gh"; process.env["GITHUB_TOKEN"] = "canary-github"; process.env["SSH_AUTH_SOCK"] = "/canary/sock";
    try { expect(mcpLaunchFor("cline", td).reason).toBe("mcp: unsupported (cline 3.1.4)"); } finally {
      for (const [k, v] of [["GH_TOKEN", saved.a], ["GITHUB_TOKEN", saved.b], ["SSH_AUTH_SOCK", saved.c]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    const got = readFileSync(seen, "utf8"); // tokenFreeEnv withholds the real values (a non-working sentinel stands in for the token family)
    expect(got).not.toContain("canary"); expect(got.endsWith("|")).toBe(true);
  });

  it("cline reports unsupported with the probed version; aider and unknown report a reason", () => {
    expect(mcpLaunchFor("cline", td)).toEqual({ argv: [], env: {}, reason: "mcp: unsupported (cline unknown)" });
    const fake = join(emptyBin, "cline");
    writeFileSync(fake, "#!/bin/sh\necho 3.1.4\n");
    chmodSync(fake, 0o755);
    expect(mcpLaunchFor("cline", td).reason).toBe("mcp: unsupported (cline 3.1.4)");
    expect(mcpLaunchFor("aider", td)).toEqual({
      argv: [],
      env: {},
      reason: "mcp: unsupported (aider has no MCP support)",
    });
    expect(mcpLaunchFor("nope", td).reason).toBe("mcp: unsupported (provider nope)");
  });

  it("project .mcp.json is ignored unless LOKI_MCP_PROJECT=1, and ${HOME} stays literal", () => {
    writeProject({ proj: { command: "node", args: ["srv.js", "${HOME}/x"], env: { TOKEN: "${HOME}" } } });
    expect(mcpLaunchFor("codex", td).argv.join(" ")).not.toContain("proj");
    expect(mcpLaunchFor("opencode", td).env["OPENCODE_CONFIG_CONTENT"]).not.toContain("proj");
    process.env["LOKI_MCP_PROJECT"] = "1";
    const codex = mcpLaunchFor("codex", td).argv;
    expect(codex).toContain('mcp_servers.proj.args=["srv.js","${HOME}/x"]');
    expect(codex).toContain('mcp_servers.proj.env_vars=["TOKEN"]');
    expect(mcpLaunchFor("codex", td).env).toEqual({ TOKEN: "${HOME}" });
    const oc = JSON.parse(mcpLaunchFor("opencode", td).env["OPENCODE_CONFIG_CONTENT"] as string);
    expect(oc.mcp.proj).toEqual({
      type: "local",
      command: ["node", "srv.js", "${HOME}/x"],
      enabled: true,
      environment: { TOKEN: "${HOME}" },
    });
  });

  it("codex: secret env values never appear on argv; conflicting names skip the later server", () => {
    writeUser({ a: { command: "a", env: { TOKEN: "s3cr3t-A" } }, b: { command: "b", env: { TOKEN: "s3cr3t-B" } }, c: { command: "c", env: { TOKEN: "s3cr3t-A" } } });
    const l = mcpLaunchFor("codex", td);
    expect(l.argv.join("\n")).not.toContain("s3cr3t");
    expect(l.env).toEqual({ TOKEN: "s3cr3t-A" });
    expect(l.argv).toContain('mcp_servers.a.env_vars=["TOKEN"]');
    expect(l.argv).toContain('mcp_servers.c.env_vars=["TOKEN"]');
    expect(l.argv.join(" ")).not.toContain("mcp_servers.b.");
    expect(l.reason).toBe("mcp: skipped b (env name conflict)");
  });

  it("claude argv does not change under LOKI_MCP_PROJECT=1", () => {
    writeProject({ proj: { command: "node" } });
    const before = mcpLaunchFor("claude", td);
    process.env["LOKI_MCP_PROJECT"] = "1";
    expect(mcpLaunchFor("claude", td)).toEqual(before);
  });

  it("merge order: bundle wins a name collision, project beats overlay; bad entries dropped", () => {
    writeUser({ shared: { command: "user" }, "loki-mode": { command: "evil" }, "bad name": { command: "x" }, url: { url: "http://x" } });
    writeProject({ shared: { command: "proj" } });
    process.env["LOKI_MCP_PROJECT"] = "1";
    const argv = mcpLaunchFor("codex", td).argv;
    expect(argv).toContain('mcp_servers.loki-mode.command="python3"');
    expect(argv).toContain('mcp_servers.shared.command="proj"');
    expect(argv.join(" ")).not.toMatch(/evil|bad name|url/);
  });

  it("bash and TS produce the same launch for the same fixture", () => {
    writeUser({ over: { command: "uvx", args: ["pkg"], env: { A: "1" } }, over2: { command: "x", env: { A: "2" } } });
    writeProject({ proj: { command: "node", args: ["a", "${HOME}"] } });
    for (const proj of [false, true]) {
      if (proj) process.env["LOKI_MCP_PROJECT"] = "1";
      else delete process.env["LOKI_MCP_PROJECT"];
      for (const p of ["claude", "codex", "opencode", "cline", "aider", "nope"]) {
        expect(bashLaunch(p)).toEqual(mcpLaunchFor(p, td));
      }
    }
  });
});

describe("mcp_config outbound remote servers and auth headers", () => {
  let td: string;
  let savedPath: string | undefined;
  const KEYS = ["LOKI_MCP_LOKI_MODE_AUTH", "LOKI_MCP_LOKI_MODE_URL", "LOKI_MCP_LOOP_URL", "LOKI_MCP_ACME_URL", "LOKI_MCP_ACME_AUTH", "LOKI_MCP_ACME_CO_URL", "LOKI_MCP_ACME_CO_AUTH", "LOKI_MCP_NOURL_AUTH", "LOKI_MCP_REGISTRY_URL"];
  const TOKEN = "s3cr3t-token-value";
  const bundle = (): any => JSON.parse(readFileSync(mcpConfigPath(td), "utf8"));
  beforeEach(() => {
    td = mkdtempSync(join(tmpdir(), "loki-mcp-auth-"));
    savedPath = process.env["PATH"];
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "loki-mcp-empty-path-"));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
    for (const k of KEYS) delete process.env[k];
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  it("the reserved name REGISTRY never becomes a remote server, with a warning that names only the variable (#316)", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    try {
      process.env["LOKI_MCP_REGISTRY_URL"] = "https://registry.example.com/mcp";
      expect(bundle().mcpServers["registry"]).toBeUndefined();
      expect(JSON.stringify(bundle())).not.toContain("registry.example.com");
    } finally {
      console.warn = orig;
    }
    expect(warns.join("\n")).toContain("LOKI_MCP_REGISTRY_URL");
    expect(warns.join("\n")).toContain("reserved");
    expect(warns.join("\n")).not.toContain("registry.example.com");
  });

  it("an env auth var produces an Authorization header on its remote server", () => {
    process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp";
    process.env["LOKI_MCP_ACME_AUTH"] = TOKEN;
    expect(bundle().mcpServers["acme"]).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("CR, LF or any control character in AUTH refuses the server and never echoes the value", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    try {
      for (const bad of [`${TOKEN}\r\nX-Evil: 1`, `${TOKEN}\n`, `${TOKEN}\u0000`, `${TOKEN}\u007f`, `Bearer ${TOKEN}\tx`]) {
        process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp";
        process.env["LOKI_MCP_ACME_AUTH"] = bad;
        expect(bundle().mcpServers["acme"]).toBeUndefined();
      }
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(5);
    expect(warns.join("\n")).toContain("LOKI_MCP_ACME_AUTH");
    expect(warns.join("\n")).not.toContain(TOKEN);
  });

  it("a control character in the URL refuses the server", () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp\r\nX-Evil: 1";
      expect(bundle().mcpServers["acme"]).toBeUndefined();
      process.env["LOKI_MCP_ACME_URL"] = "https://mcp.exa\nmple.com/mcp";
      expect(bundle().mcpServers["acme"]).toBeUndefined();
    } finally {
      console.warn = orig;
    }
  });

  it("refuses a backslash url whose host differs between WHATWG and Python urlsplit", () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      for (const u of [
        "http://evil.example\\@127.0.0.1/mcp",
        "http://evil\\@127.0.0.1/",
        "http://evil\\@localhost/",
        "https://co.example.com\\@127.0.0.1/mcp",
      ]) {
        process.env["LOKI_MCP_ACME_URL"] = u;
        process.env["LOKI_MCP_ACME_AUTH"] = TOKEN;
        const b = bundle();
        expect(b.mcpServers["acme"]).toBeUndefined();
        expect(JSON.stringify(b)).not.toContain(TOKEN);
      }
    } finally {
      console.warn = orig;
    }
  });

  it("plain http to a non-loopback host is refused even with a token", () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      process.env["LOKI_MCP_ACME_URL"] = "http://mcp.example.com/mcp";
      process.env["LOKI_MCP_ACME_AUTH"] = TOKEN;
      const b = bundle();
      expect(b.mcpServers["acme"]).toBeUndefined();
      expect(JSON.stringify(b)).not.toContain(TOKEN);
    } finally {
      console.warn = orig;
    }
  });

  it("adding a secret to an existing 644 bundle replaces the file atomically at 0600", () => {
    const cfg = mcpConfigPath(td);
    chmodSync(cfg, 0o644);
    expect(statSync(cfg).mode & 0o777).toBe(0o644);
    const before = statSync(cfg).ino;
    process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp";
    process.env["LOKI_MCP_ACME_AUTH"] = TOKEN;
    mcpConfigPath(td);
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
    expect(readFileSync(cfg, "utf8")).toContain(TOKEN);
    // A new inode proves the token never went into the world-readable file.
    expect(statSync(cfg).ino).not.toBe(before);
    expect(readdirSync(join(td, ".loki")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("a stale or planted tmp file at the predictable path does not fail the run or receive the token", () => {
    process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp";
    process.env["LOKI_MCP_ACME_AUTH"] = TOKEN;
    mkdirSync(join(td, ".loki"), { recursive: true });
    const cfg = join(td, ".loki", "mcp-config.json");
    const tmp = `${cfg}.tmp.${process.pid}`;
    const victim = join(td, "victim");
    writeFileSync(victim, "VICTIM");
    chmodSync(victim, 0o644);
    // A stale regular file from a crashed run with the same pid.
    writeFileSync(tmp, "STALE");
    mcpConfigPath(td);
    expect(readFileSync(cfg, "utf8")).toContain(TOKEN);
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
    // A symlink planted at the tmp path is replaced, never followed.
    rmSync(cfg);
    symlinkSync(victim, tmp);
    mcpConfigPath(td);
    expect(readFileSync(victim, "utf8")).toBe("VICTIM");
    expect(statSync(victim).mode & 0o777).toBe(0o644);
    expect(lstatSync(cfg).isSymbolicLink()).toBe(false);
    expect(readFileSync(cfg, "utf8")).toContain(TOKEN);
    expect(readdirSync(join(td, ".loki")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("a failed rename leaves no tmp file holding the token and rethrows", () => {
    process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp";
    process.env["LOKI_MCP_ACME_AUTH"] = TOKEN;
    // A directory at the target makes the rename fail after the tmp file was written.
    mkdirSync(join(td, ".loki", "mcp-config.json"), { recursive: true });
    expect(() => mcpConfigPath(td)).toThrow();
    expect(lstatSync(join(td, ".loki", "mcp-config.json")).isDirectory()).toBe(true);
    expect(readdirSync(join(td, ".loki")).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(readdirSync(join(td, ".loki", "mcp-config.json"))).toEqual([]);
  });

  it("an unchanged bundle holding a secret that was left at 644 is tightened to 0600", () => {
    process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp";
    process.env["LOKI_MCP_ACME_AUTH"] = TOKEN;
    const cfg = mcpConfigPath(td);
    chmodSync(cfg, 0o644);
    mcpConfigPath(td);
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
  });

  it("a remote named loki-mode never overrides the builtin server", () => {
    process.env["LOKI_MCP_LOKI_MODE_URL"] = "https://evil.example.com/mcp";
    process.env["LOKI_MCP_LOKI_MODE_AUTH"] = TOKEN;
    const b = bundle();
    expect(b.mcpServers["loki-mode"]).toEqual({ command: "python3", args: ["-m", "mcp.server"] });
    delete process.env["LOKI_MCP_LOKI_MODE_AUTH"];
  });

  it("plain http to the IPv6 loopback is allowed", () => {
    process.env["LOKI_MCP_LOOP_URL"] = "http://[::1]:8080/mcp";
    expect(bundle().mcpServers["loop"]).toEqual({ type: "http", url: "http://[::1]:8080/mcp" });
  });

  it("a value that already names a scheme is used verbatim", () => {
    process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp";
    process.env["LOKI_MCP_ACME_AUTH"] = "Basic abc123";
    expect(bundle().mcpServers["acme"].headers).toEqual({ Authorization: "Basic abc123" });
  });

  it("multi-word server names map to lowercase hyphenated keys", () => {
    process.env["LOKI_MCP_ACME_CO_URL"] = "https://co.example.com/mcp";
    process.env["LOKI_MCP_ACME_CO_AUTH"] = TOKEN;
    expect(Object.keys(bundle().mcpServers)).toContain("acme-co");
  });

  it("a remote server with no auth var has no headers", () => {
    process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp";
    expect(bundle().mcpServers["acme"]).toEqual({ type: "http", url: "https://mcp.example.com/mcp" });
  });

  it("an auth var without a url declares no server", () => {
    process.env["LOKI_MCP_NOURL_AUTH"] = TOKEN;
    expect(Object.keys(bundle().mcpServers)).toEqual(["loki-mode"]);
  });

  it("refuses a plain-http non-loopback url and never logs the header value", () => {
    process.env["LOKI_MCP_ACME_URL"] = "http://mcp.example.com/mcp";
    process.env["LOKI_MCP_ACME_AUTH"] = TOKEN;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const logs = spyOn(console, "log").mockImplementation(() => {});
    const b = bundle();
    expect(b.mcpServers["acme"]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("LOKI_MCP_ACME_URL"));
    const seen = JSON.stringify([...warn.mock.calls, ...logs.mock.calls]);
    expect(seen.includes(TOKEN)).toBe(false);
    warn.mockRestore();
    logs.mockRestore();
  });

  it("plain http is allowed for loopback", () => {
    process.env["LOKI_MCP_ACME_URL"] = "http://127.0.0.1:8765/mcp";
    expect(bundle().mcpServers["acme"].url).toBe("http://127.0.0.1:8765/mcp");
  });

  it("a bundle that holds a header value is written owner-only (0600)", () => {
    process.env["LOKI_MCP_ACME_URL"] = "https://mcp.example.com/mcp";
    process.env["LOKI_MCP_ACME_AUTH"] = TOKEN;
    const p = mcpConfigPath(td);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("with no remote env the bundle is exactly the old one", () => {
    expect(bundle()).toEqual({
      mcpServers: { "loki-mode": { command: "python3", args: ["-m", "mcp.server"] } },
    });
  });
});
