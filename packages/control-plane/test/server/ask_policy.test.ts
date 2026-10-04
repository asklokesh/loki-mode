// CP-ASK slice 6: tool policy, read-only mcp.json and the per-job scratch dir.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ALLOWED_TOOLS, DENIED_TOOLS, MCP_SERVER_NAME, buildMcpConfig, createJobDir, removeJobDir } from "../../src/ask/policy.ts";

const REPO = resolve(import.meta.dir, "../../../..");

test("the deny list covers every token of the loki-ts REVIEW denylist, plus the outbound and shell tools", () => {
  const src = readFileSync(join(REPO, "loki-ts/src/runner/quality_gates.ts"), "utf8");
  const m = /const REVIEW_GUARD_DENYLIST =\s*\n?\s*"([^"]+)"/.exec(src);
  expect(m).not.toBeNull();
  const deny = DENIED_TOOLS.split(",");
  for (const tok of m![1]!.split(",")) expect(deny).toContain(tok);
  for (const tok of ["Write", "Edit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Task", "Read", "Grep", "Glob"]) expect(deny).toContain(tok);
});

test("the allow list is only the one TypeScript tools server", () => {
  expect(ALLOWED_TOOLS).toBe(`mcp__${MCP_SERVER_NAME}__*`);
});

test("mcp.json launches only the TS tools server (bun, no python, no server.py) with the db path and no token", () => {
  const cfg = buildMcpConfig(REPO, "/data/control.db") as { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
  expect(Object.keys(cfg.mcpServers)).toEqual([MCP_SERVER_NAME]);
  const s = cfg.mcpServers[MCP_SERVER_NAME]!;
  expect(s.command).toBe("bun");
  expect(s.args).toEqual([join(REPO, "packages/control-plane/src/ask/tools_server.ts")]);
  expect(s.env).toEqual({ LOKI_CONTROL_DB: "/data/control.db" });
  const text = JSON.stringify(cfg);
  for (const bad of ["server.py", "python", "TOKEN"]) expect(text).not.toContain(bad);
});

test("the scratch dir is 0700, outside every repo, and removal is validated", () => {
  const dir = createJobDir();
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  let d = dir;
  while (d !== dirname(d)) { expect(existsSync(join(d, ".git"))).toBe(false); d = dirname(d); }
  removeJobDir(dir);
  expect(existsSync(dir)).toBe(false);
});

test("removeJobDir refuses a path that is not a marked scratch dir", () => {
  expect(() => removeJobDir(REPO)).toThrow();
  expect(() => removeJobDir("/tmp")).toThrow();
  expect(existsSync(join(REPO, "package.json"))).toBe(true);
});
