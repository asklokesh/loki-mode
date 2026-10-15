// OC-FIX-AGENTS: custom agents (.loki/agents/*.md, ~/.config/loki/agents/*.md) that declare the council or reviewer role
// apply on the default engine10 review path. Role = optional frontmatter `role:` key, else the file name (reviewer, council).
// Project definitions override user ones. Read-only, never throws: an unreadable or malformed file is skipped.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentRole = "council" | "reviewer";
export interface RoleAgent { name: string; role: AgentRole; provider: string; model: string; prompt: string; }

const ROLES: readonly string[] = ["council", "reviewer"];

export function agentDirs(repoDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [env["LOKI_AGENTS_PROJECT_DIR"] || join(repoDir, ".loki", "agents"), env["LOKI_AGENTS_USER_DIR"] || join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "loki", "agents")];
}

function parseAgent(file: string, stem: string): RoleAgent | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(readFileSync(file, "utf8")); if (!m) return null;
  const body = m[2]!.trim(); if (!body) return null;
  const kv = (k: string): string => new RegExp(`^${k}:[ \\t]*["']?([^"'\\r\\n#]*?)["']?[ \\t]*$`, "m").exec(m[1]!)?.[1]?.trim() ?? "";
  const role = (kv("role") || stem).toLowerCase();
  if (!ROLES.includes(role)) return null;
  return { name: kv("name") || stem, role: role as AgentRole, provider: (kv("provider") || "claude").toLowerCase(), model: kv("model"), prompt: body.slice(0, 4000) };
}

/** First agent declaring `role`: the file named <role>.md first, then any file with `role: <role>`; project dir before user dir. */
export function loadRoleAgent(repoDir: string, role: AgentRole, env: NodeJS.ProcessEnv = process.env): RoleAgent | null {
  for (const d of agentDirs(repoDir, env)) {
    if (!existsSync(d)) continue;
    let names: string[];
    try { names = readdirSync(d).filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort(); } catch { continue; }
    const ordered = [...names.filter((n) => n === `${role}.md`), ...names.filter((n) => n !== `${role}.md`)];
    for (const n of ordered) {
      try { const a = parseAgent(join(d, n), n.slice(0, -3)); if (a && a.role === role) return a; } catch { /* unreadable agent file: skip */ }
    }
  }
  return null;
}

/** The agent that drives the review stage: reviewer first, then council. */
export function loadReviewStageAgent(repoDir: string, env: NodeJS.ProcessEnv = process.env): RoleAgent | null {
  return loadRoleAgent(repoDir, "reviewer", env) ?? loadRoleAgent(repoDir, "council", env);
}
