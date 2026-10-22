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
// Outbound remote servers: LOKI_MCP_<NAME>_URL declares an HTTP server named
// <name> (lowercase, "_" to "-"); LOKI_MCP_<NAME>_AUTH, when set, becomes its
// Authorization header ("Bearer " is added unless the value names a scheme).
// A plain-http URL is accepted only for loopback. A bundle that holds a header
// value is written 0600, and no header value is ever logged.
//
// Public API:
//   mcpConfigPath(targetDir) -> absolute path to Loki bundle (idempotent write)
//   userMcpConfigPath() -> absolute path to ~/.claude/mcp.json if readable, else null
//   buildMcpConfigArgv(targetDir) -> ["--mcp-config", "<loki>", "<user?>"]
//
// Design notes:
// - Bundle shape is hardcoded (no runtime read of project .mcp.json) to prevent
//   drift and ensure no `${...}` env-var expansion lands in the emitted file.
// - Idempotent write: compares stable-stringified existing bytes vs desired bytes
//   and short-circuits before fs.writeFileSync when equal, preserving mtime.
// - Variadic emission: separate argv elements per Commander `<configs...>` syntax
//   verified via `claude --help` (v2.1.34).
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, renameSync, rmSync } from "node:fs";
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
// One loopback set, matched against the host as written (new URL() would rewrite 0:0:0:0:0:0:0:1 and 0x7f.1 into
// loopback forms); mirrored in autonomy/lib/mcp-config.sh so the airgap audit and the writer agree.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Host as written in the URL authority: userinfo, port and IPv6 brackets removed, lowercased. Empty when the
// authority is missing (new URL("https:///x") would otherwise treat "x" as the host).
function literalHost(raw: string): string {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(raw)?.[1] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const bracketed = /^\[([^\]]*)\]/.exec(hostPort);
  return (bracketed ? bracketed[1]! : hostPort.replace(/:[^:]*$/, "")).toLowerCase();
}

// CR, LF, NUL, tab, DEL and the rest of C0 would let a value inject headers.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Anything outside RFC 3986 URI syntax (notably a backslash, which WHATWG reads as a slash but Python urlsplit does
// not) lets two parsers disagree about the host the Authorization header is sent to. Mirrored in autonomy/lib/mcp-config.sh.
const NON_RFC3986 = /[^A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/;

// Names the tool owns inside the LOKI_MCP_<NAME>_URL namespace. REGISTRY was the registry test's URL knob (#316);
// a stale shell variable of that name must never become an outbound server. Mirrored in autonomy/lib/mcp-config.sh.
const RESERVED_REMOTE_NAMES = new Set(["REGISTRY"]);

// Collect LOKI_MCP_<NAME>_URL servers from env. Returns the server map and
// whether any carries a header value. Warns by variable name only.
export function remoteServersFromEnv(env: NodeJS.ProcessEnv): { servers: Record<string, unknown>; hasSecret: boolean } {
  const servers: Record<string, unknown> = {};
  let hasSecret = false;
  for (const key of Object.keys(env).sort()) {
    const m = /^LOKI_MCP_([A-Z0-9]+(?:_[A-Z0-9]+)*)_URL$/.exec(key);
    const raw = env[key];
    if (!m || !raw) continue;
    if (RESERVED_REMOTE_NAMES.has(m[1]!)) {
      console.warn(`[mcp_config] ignoring ${key}: ${m[1]} is a reserved name, not a remote server.`);
      continue;
    }
    // new URL() silently strips CR, LF and tab, so the raw value is checked first.
    if (CONTROL_CHARS.test(raw)) {
      console.warn(`[mcp_config] ignoring ${key}: control characters are not allowed.`);
      continue;
    }
    if (NON_RFC3986.test(raw)) {
      console.warn(`[mcp_config] ignoring ${key}: the URL contains characters outside RFC 3986 (for example a backslash).`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      console.warn(`[mcp_config] ignoring ${key}: not a valid URL.`);
      continue;
    }
    const host = literalHost(raw);
    // The host as written must be the host WHATWG connects to (no percent-decoding, no IPv4 rewrite) and a plain
    // name or canonical IP; mirrored by host_agrees in autonomy/lib/mcp-config.sh.
    const whatwgHost = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    const hostOk = host !== "" && host === whatwgHost && (host.includes(":") || /^[a-z0-9._-]+$/.test(host));
    const secure = hostOk && (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(host)));
    if (!secure) {
      console.warn(`[mcp_config] ignoring ${key}: remote MCP servers must use https (plain http is loopback only).`);
      continue;
    }
    const entry: Record<string, unknown> = { type: "http", url: raw };
    const auth = env[`LOKI_MCP_${m[1]}_AUTH`];
    if (auth && CONTROL_CHARS.test(auth)) {
      console.warn(`[mcp_config] ignoring ${key}: LOKI_MCP_${m[1]}_AUTH contains control characters.`);
      continue;
    }
    if (auth) {
      entry["headers"] = { Authorization: /^[A-Za-z][A-Za-z0-9-]*\s+\S/.test(auth) ? auth : `Bearer ${auth}` };
      hasSecret = true;
    }
    servers[m[1]!.toLowerCase().replace(/_/g, "-")] = entry;
  }
  return { servers, hasSecret };
}

function buildBundle(lspDetected: boolean, remote: Record<string, unknown> = {}): Record<string, unknown> {
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
  for (const [name, entry] of Object.entries(remote)) {
    if (!(name in servers)) servers[name] = entry;
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
  const remote = remoteServersFromEnv(process.env);
  const desired = stableStringify(buildBundle(detectLsp(), remote.servers));

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
    if (remote.hasSecret) chmodSync(cfgPath, 0o600);
    return cfgPath;
  }

  mkdirSync(lokiDir, { recursive: true });
  if (!remote.hasSecret) {
    writeFileSync(cfgPath, desired, { encoding: "utf8", mode: 0o666 });
    return cfgPath;
  }
  // writeFileSync's mode applies only when it creates the file, so writing a
  // token into an existing 644 bundle would expose it. Write a sibling opened
  // 0600 and rename it over the target (mirrors tmp + mv in the bash route).
  const tmpPath = `${cfgPath}.tmp.${process.pid}`;
  try {
    rmSync(tmpPath, { force: true });
    writeFileSync(tmpPath, desired, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmpPath, cfgPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
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
