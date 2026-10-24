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

// Review provider selection (moved from engine10/stages/xreview.ts to keep the engine core inside its line budget).
export type ReviewProvider = "codex" | "claude";
export const asProvider = (v: string | undefined): ReviewProvider | null => { const s = v?.trim().toLowerCase(); return s === "codex" || s === "claude" ? s : null; }; export const isOff = (v: string | undefined): boolean => /^(off|none|false|0)$/i.test(v?.trim() ?? "");
/** Explicit setting: env wins over loki.yaml top-level `review:`. A provider, "off", or undefined (nothing set). */
export function explicitReview(repoDir: string, env: NodeJS.ProcessEnv): ReviewProvider | "off" | undefined {
  const flag = xvendorDefault(env); // explicit off is only meaningful (and only honoured) with the flag on; off keeps the pre-XV-1 behaviour
  const ev = env["LOKI_REVIEW_PROVIDER"], e = asProvider(ev); if (e) return e; if (flag && isOff(ev)) return "off";
  for (const f of ["loki.yaml", "loki.yml"]) {
    const p = join(repoDir, f); if (!existsSync(p)) continue;
    try { const m = /^review:[ \t]*["']?([A-Za-z]+)["']?[ \t]*(?:#.*)?$/m.exec(readFileSync(p, "utf8")); const v = asProvider(m?.[1]); if (v) return v; if (flag && isOff(m?.[1])) return "off"; } catch { /* unreadable: nothing set */ }
  }
  return undefined;
}
/** XV-1 flag: LOKI_XVENDOR_DEFAULT=1 turns on the other-vendor default. Off keeps the opt-in behaviour. */
export const xvendorDefault = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes|on)$/i.test(env["LOKI_XVENDOR_DEFAULT"]?.trim() ?? "");
/** The CLI for a provider is on PATH (same resolution as engine10/preflight.ts: LOKI_<NAME>_CLI override, else the provider name). */
export const reviewCli = (p: ReviewProvider, env: NodeJS.ProcessEnv = process.env): string => env[`LOKI_${p.toUpperCase()}_CLI`]?.trim() || p;
export function vendorAvailable(p: ReviewProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  const cli = reviewCli(p, env);
  return !!Bun.which(cli, { PATH: env["PATH"] ?? process.env["PATH"] ?? "" });
}
/** Explicit setting always wins (including `off`). With LOKI_XVENDOR_DEFAULT=1 and nothing set, the other vendor than the builder when its CLI is installed. Else null (off). */
export function reviewProvider(repoDir: string, env: NodeJS.ProcessEnv = process.env, builder?: string): ReviewProvider | null {
  const x = explicitReview(repoDir, env); if (x) return x === "off" ? null : x;
  if (!xvendorDefault(env)) return null;
  const other: ReviewProvider | null = builder === "claude" ? "codex" : builder === "codex" ? "claude" : null;
  return other && vendorAvailable(other, env) ? other : null;
}
