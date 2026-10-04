// CP-ASK slice 6: the security policy for an Ask job. Layer 1 (tools), layer 2 (empty 0700 scratch cwd), layer 3 (one read-only tools server).
// The provider never gets a shell, a file tool or the web; its only tools are the read-only TS tools server.
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Name of the TS tools server (packages/control-plane/src/ask/tools_server.ts); its tools surface as mcp__<name>__*. */
export const MCP_SERVER_NAME = "loki-ask";
export const MCP_SERVER_SCRIPT = "packages/control-plane/src/ask/tools_server.ts";

export const ALLOWED_TOOLS = `mcp__${MCP_SERVER_NAME}__*`;

// Deny wins over allow in claude. Includes the loki-ts review denylist tokens (mutation forms) and every built-in that can touch files, a shell, the web or sub-agents.
export const DENIED_TOOLS = [
  "Edit", "Write", "NotebookEdit",
  "Bash(git commit:*)", "Bash(git reset:*)", "Bash(git push:*)", "Bash(git checkout:*)", "Bash(git clean:*)", "Bash(git rm:*)", "Bash(git stash:*)", "Bash(git -C:*)", "Bash(git --git-dir:*)", "Bash(git -c:*)",
  "Bash", "WebFetch", "WebSearch", "Task", "Read", "Grep", "Glob",
].join(",");

/** The mcp.json for one job. The tools server reads control.db directly (read-only), so no CP URL or token exists anywhere in the job. */
export function buildMcpConfig(repoRoot: string, dbPath: string): Record<string, unknown> {
  const env: Record<string, string> = { LOKI_CONTROL_DB: dbPath };
  return { mcpServers: { [MCP_SERVER_NAME]: { command: "bun", args: [join(repoRoot, MCP_SERVER_SCRIPT)], env } } };
}

const PREFIX = "loki-ask.";
const MARKER = ".loki-ask-owned";

/** Empty 0700 scratch dir (the provider cwd), never inside a repo. */
export function createJobDir(): string {
  const root = realpathSync(tmpdir());
  for (let d = root; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) throw new Error(`temp root is inside a repo: ${d}`);
    if (d === dirname(d)) break;
  }
  const dir = mkdtempSync(join(root, PREFIX));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, MARKER), dir, { mode: 0o600 });
  return dir;
}

/** Remove only a validated scratch dir: marker present and matching, right prefix, owned by this user, mode 0700, a direct child of the temp root. */
export function removeJobDir(dir: string): void {
  const root = realpathSync(tmpdir());
  const refuse = (why: string): never => { throw new Error(`refusing to remove ${dir}: ${why}`); };
  if (dirname(dir) !== root || !dir.slice(root.length + 1).startsWith(PREFIX)) refuse("not a scratch dir name");
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) refuse("not a plain directory");
  if (st.uid !== process.getuid!()) refuse("not owned by this user");
  if ((st.mode & 0o777) !== 0o700) refuse("mode is not 0700");
  const marker = join(dir, MARKER);
  if (!existsSync(marker) || readFileSync(marker, "utf8") !== dir) refuse("marker missing or wrong");
  if (!statSync(marker).isFile()) refuse("marker is not a file");
  rmSync(dir, { recursive: true, force: true });
}
