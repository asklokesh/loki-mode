// loki-ts/src/providers/mcp_config.ts -- Phase D (v7.5.22) + Phase G (v7.5.24).
//
// Emits a per-iteration Loki MCP server bundle under <targetDir>/.loki/mcp-config.json
// for Claude Code's `--mcp-config <configs...>` variadic flag. Optionally chains a
// user overlay at ~/.claude/mcp.json when present. Hook events flag is composed by
// claude_flags.ts; this module owns only the config paths.
//
// Phase G (v7.5.24): when any supported LSP binary is on PATH
// (typescript-language-server, pylsp, gopls, rust-analyzer), the bundle also
// gets a single `lsp-proxy` server entry that fans out to per-language servers
// at runtime. Detection uses `which` (or PATH walk fallback); absence is a
// normal state, not an error. Bash mirror in autonomy/lib/mcp-config.sh.
//
// Public API:
//   mcpConfigPath(targetDir) -> absolute path to Loki bundle (idempotent write)
//   userMcpConfigPath() -> absolute path to ~/.claude/mcp.json if readable, else null
//   buildMcpConfigArgv(targetDir) -> ["--mcp-config", "<loki>", "<user?>"]
//   mcpLaunchFor(provider, targetDir) -> {argv, env, reason?} per-provider launch:
//     claude   -> buildMcpConfigArgv (byte-identical to the pre-CW-10 argv)
//     codex    -> `-c mcp_servers.<n>.command=..` / `.args=[..]` / `.env={..}` overrides
//                 (never writes ~/.codex/config.toml); env values go to launch.env and
//                 `.env_vars=[names]`, never onto argv
//     opencode -> env OPENCODE_CONFIG_CONTENT = {"mcp":{<n>:{type:"local",command:[..],enabled:true}}}
//     cline    -> empty launch + reason (no per-invocation MCP path; global settings untouched)
//     aider    -> empty launch + reason (no MCP support)
//   Servers for the non-claude providers: Loki bundle, then the project
//   <targetDir>/.mcp.json ONLY under LOKI_MCP_PROJECT=1 (an untrusted repo must not
//   start commands by default), then the ~/.claude/mcp.json overlay; the bundle wins
//   a name collision, then project over overlay. Bash mirror: loki_mcp_launch_for.
//
// Design notes:
// - Bundle shape is hardcoded (no runtime read of project .mcp.json) to prevent
//   drift and ensure no `${...}` env-var expansion lands in the emitted file.
// - Idempotent write: compares stable-stringified existing bytes vs desired bytes
//   and short-circuits before fs.writeFileSync when equal, preserving mtime.
// - Variadic emission: separate argv elements per Commander `<configs...>` syntax
//   verified via `claude --help` (v2.1.34).
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve as resolvePath, join, delimiter } from "node:path";

// Phase G: supported LSP binaries. Match autonomy/lib/mcp-config.sh exactly so
// bash and Bun routes detect the same set.
const LSP_BINARIES = ["typescript-language-server", "pylsp", "gopls", "rust-analyzer"];

// Detect any LSP binary on PATH. Returns true when at least one is found.
// Pure PATH walk (stdlib only) for predictability across Bun/Node.
function detectLsp(): boolean {
  const pathEnv = process.env["PATH"] ?? "";
  if (!pathEnv) return false;
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
  for (const bin of LSP_BINARIES) {
    for (const dir of dirs) {
      const candidate = join(dir, bin);
      try {
        const s = statSync(candidate);
        if (s.isFile()) return true;
      } catch {
        // Missing or unreadable -- continue
      }
    }
  }
  return false;
}

// Build the bundle, optionally with the Phase G lsp-proxy entry.
// Pure function; takes lsp_detected so tests can drive the conditional path.
function buildBundle(lspDetected: boolean): Record<string, unknown> {
  const servers: Record<string, unknown> = {
    "loki-mode": {
      command: "python3",
      args: ["-m", "mcp.server"],
    },
  };
  if (lspDetected) {
    servers["lsp-proxy"] = {
      command: "python3",
      args: ["-m", "mcp.lsp_proxy"],
    };
  }
  return { mcpServers: servers };
}

// Stable-key JSON serialization. JSON.stringify with sorted keys would also work
// for our small fixed object, but explicit serialization keeps byte output
// deterministic across Node/Bun versions.
function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

// Resolves to <targetDir>/.loki/mcp-config.json. Writes the Loki bundle when the
// existing file content differs (idempotent). Returns the absolute path either way.
export function mcpConfigPath(targetDir: string): string {
  const lokiDir = resolvePath(targetDir, ".loki");
  const cfgPath = join(lokiDir, "mcp-config.json");
  const desired = stableStringify(buildBundle(detectLsp()));

  let existing: string | null = null;
  if (existsSync(cfgPath)) {
    try {
      existing = readFileSync(cfgPath, "utf8");
    } catch {
      existing = null;
    }
  }

  if (existing === desired) {
    // Idempotent: identical bytes already on disk, skip write to preserve mtime.
    return cfgPath;
  }

  mkdirSync(lokiDir, { recursive: true });
  writeFileSync(cfgPath, desired, "utf8");
  return cfgPath;
}

// Returns ~/.claude/mcp.json only when it contains the current Claude Code
// `mcpServers` object and is at most 1 MiB. A legacy `servers` file makes
// `claude --mcp-config` refuse before the first provider turn, so ignore it
// with recovery guidance and preserve Loki's own valid bundle.
export function userMcpConfigPath(): string | null {
  const home = process.env["HOME"];
  if (!home) return null;
  const p = join(home, ".claude", "mcp.json");
  if (!existsSync(p)) return null;
  try {
    // Stat probe ensures readability without slurping the whole file.
    const s = statSync(p);
    if (!s.isFile()) return null;
    if (s.size > 1024 * 1024) {
      console.warn("[mcp_config] ignoring ~/.claude/mcp.json: file exceeds the 1 MiB safety limit.");
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("mcpServers" in parsed) ||
      typeof (parsed as { mcpServers?: unknown }).mcpServers !== "object" ||
      (parsed as { mcpServers?: unknown }).mcpServers === null ||
      Array.isArray((parsed as { mcpServers?: unknown }).mcpServers)
    ) {
      console.warn(
        '[mcp_config] ignoring ~/.claude/mcp.json: Claude Code requires a top-level "mcpServers" object; update or remove the legacy/invalid file.',
      );
      return null;
    }
    return p;
  } catch {
    console.warn(
      '[mcp_config] ignoring ~/.claude/mcp.json: Claude Code requires valid JSON with a top-level "mcpServers" object.',
    );
    return null;
  }
}

// Composes the variadic --mcp-config argv: ["--mcp-config", "<loki>"] plus user
// overlay path appended when present. Per Commander `<configs...>` semantics,
// each path is a separate argv element (verified via `claude --help`).
export function buildMcpConfigArgv(targetDir: string): string[] {
  const loki = mcpConfigPath(targetDir);
  const argv: string[] = ["--mcp-config", loki];
  const user = userMcpConfigPath();
  if (user !== null) {
    argv.push(user);
  }
  return argv;
}

export interface McpLaunch {
  argv: string[];
  env: Record<string, string>;
  reason?: string;
}

interface McpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const MAX_MCP_FILE_BYTES = 1024 * 1024;
const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Keeps only stdio servers (string command, string-array args, string env values).
// Values stay literal: `${...}` is never expanded.
function normalizeServers(raw: unknown): Record<string, McpServer> {
  const out: Record<string, McpServer> = {};
  if (!isPlainObject(raw)) return out;
  for (const [name, entry] of Object.entries(raw)) {
    if (!SERVER_NAME_RE.test(name) || !isPlainObject(entry)) continue;
    const command = entry["command"];
    if (typeof command !== "string" || command.length === 0) continue;
    const rawArgs = entry["args"];
    if (rawArgs !== undefined && !(Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === "string"))) continue;
    const rawEnv = entry["env"];
    const env: Record<string, string> = {};
    if (rawEnv !== undefined) {
      if (!isPlainObject(rawEnv) || !Object.values(rawEnv).every((v) => typeof v === "string")) continue;
      for (const [k, v] of Object.entries(rawEnv)) env[k] = v as string;
    }
    out[name] = { command, args: (rawArgs as string[] | undefined) ?? [], env };
  }
  return out;
}

function readServersFile(p: string): Record<string, McpServer> {
  try {
    const s = statSync(p);
    if (!s.isFile() || s.size > MAX_MCP_FILE_BYTES) return {};
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    return isPlainObject(parsed) ? normalizeServers(parsed["mcpServers"]) : {};
  } catch {
    return {};
  }
}

function collectServers(targetDir: string): Record<string, McpServer> {
  const merged: Record<string, McpServer> = {};
  const user = userMcpConfigPath();
  if (user !== null) Object.assign(merged, readServersFile(user));
  if (process.env["LOKI_MCP_PROJECT"] === "1") {
    Object.assign(merged, readServersFile(join(resolvePath(targetDir), ".mcp.json")));
  }
  const bundle = buildBundle(detectLsp()) as { mcpServers: Record<string, unknown> };
  Object.assign(merged, normalizeServers(bundle.mcpServers));
  // Order: bundle first, then project/overlay, for a stable argv.
  const ordered: Record<string, McpServer> = {};
  for (const k of Object.keys(bundle.mcpServers)) ordered[k] = merged[k] as McpServer;
  for (const k of Object.keys(merged)) if (!(k in ordered)) ordered[k] = merged[k] as McpServer;
  return ordered;
}

function clineVersion(): string {
  try {
    const r = spawnSync("cline", ["--version"], { encoding: "utf8", timeout: 5000, env: process.env });
    if (r.status === 0) {
      const line = (r.stdout ?? "").split("\n")[0]?.trim() ?? "";
      if (line) return line;
    }
  } catch {
    // fall through
  }
  return "unknown";
}

export function mcpLaunchFor(provider: string, targetDir: string): McpLaunch {
  switch (provider) {
    case "claude":
      return { argv: buildMcpConfigArgv(targetDir), env: {} };
    case "codex": {
      // Secrets never ride argv (readable by `ps`): env values go to the codex process
      // env and the server lists the names in `env_vars` (codex forwards them).
      // env_vars names share one namespace, so a later server whose value for a name
      // conflicts with an earlier one is skipped and named in `reason`.
      const argv: string[] = [];
      const env: Record<string, string> = {};
      const skipped: string[] = [];
      for (const [name, srv] of Object.entries(collectServers(targetDir))) {
        const names = Object.keys(srv.env).filter((k) => SERVER_NAME_RE.test(k));
        if (names.some((k) => k in env && env[k] !== srv.env[k])) {
          skipped.push(name);
          continue;
        }
        argv.push("-c", `mcp_servers.${name}.command=${JSON.stringify(srv.command)}`);
        argv.push("-c", `mcp_servers.${name}.args=${JSON.stringify(srv.args)}`);
        if (names.length > 0) {
          for (const k of names) env[k] = srv.env[k] as string;
          argv.push("-c", `mcp_servers.${name}.env_vars=${JSON.stringify(names)}`);
        }
      }
      const out: McpLaunch = { argv, env };
      if (skipped.length > 0) out.reason = `mcp: skipped ${skipped.join(",")} (env name conflict)`;
      return out;
    }
    case "opencode": {
      const mcp: Record<string, unknown> = {};
      for (const [name, srv] of Object.entries(collectServers(targetDir))) {
        const entry: Record<string, unknown> = {
          type: "local",
          command: [srv.command, ...srv.args],
          enabled: true,
        };
        if (Object.keys(srv.env).length > 0) entry["environment"] = srv.env;
        mcp[name] = entry;
      }
      return { argv: [], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) } };
    }
    case "cline":
      return { argv: [], env: {}, reason: `mcp: unsupported (cline ${clineVersion()})` };
    case "aider":
      return { argv: [], env: {}, reason: "mcp: unsupported (aider has no MCP support)" };
    default:
      return { argv: [], env: {}, reason: `mcp: unsupported (provider ${provider})` };
  }
}
