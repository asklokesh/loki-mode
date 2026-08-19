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
//
// Design notes:
// - Bundle shape is hardcoded (no runtime read of project .mcp.json) to prevent
//   drift and ensure no `${...}` env-var expansion lands in the emitted file.
// - Idempotent write: compares stable-stringified existing bytes vs desired bytes
//   and short-circuits before fs.writeFileSync when equal, preserving mtime.
// - Variadic emission: separate argv elements per Commander `<configs...>` syntax
//   verified via `claude --help` (v2.1.34).
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
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
