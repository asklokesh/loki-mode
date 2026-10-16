// P12-44: checks declared by a repo skill run as a quality gate. Owner of skill-manifest loading, the check env and the runner
// (no existing module reads .claude/skills frontmatter). Declared in .claude/skills/<skill>/SKILL.md frontmatter:
//   checks:
//     - bash scripts/check.sh            (shorthand: the command)
//     - name: lint                       (or name + run)
//       run: bun run lint
// Fail closed: a check that exits non-zero, times out, cannot spawn, or a checks block that cannot be parsed, fails the gate.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hardenCredentialEnv } from "./credential_env.ts";
import { readStreamCapped } from "./shell.ts";

export interface SkillCheck { skill: string; name: string; run: string }
export interface SkillCheckLoad { checks: SkillCheck[]; errors: string[] }
export interface SkillCheckResult { passed: boolean; detail: string }

/** The ONLY parent vars a skill check sees. Everything else (tokens, API keys, cloud creds) is dropped, never filtered by name. */
export const SKILL_CHECK_ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "CI"] as const;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Allowlist env for a skill check, then the shared credential hardening (GH sentinel, empty gh config dir, git helper reset). */
export function skillCheckEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: NodeJS.ProcessEnv = {};
  for (const k of SKILL_CHECK_ENV_ALLOW) if (typeof base[k] === "string") out[k] = base[k];
  out["FORCE_COLOR"] = "0"; out["NO_COLOR"] = "1";
  hardenCredentialEnv(out);
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(out)) if (typeof v === "string") clean[k] = v;
  return clean;
}

const unquote = (s: string): string => { const t = s.trim(); return t.length >= 2 && /^(["']).*\1$/s.test(t) ? t.slice(1, -1) : t; };

/** Parse the `checks:` list of one SKILL.md. null = no checks key; throws on a checks block that yields nothing usable. */
export function parseSkillChecks(text: string, skill: string): SkillCheck[] | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const lines = m[1]!.split(/\r?\n/);
  const start = lines.findIndex((l) => /^checks\s*:\s*$/.test(l));
  if (start < 0) return null;
  const out: SkillCheck[] = [];
  let cur: { name?: string; run?: string } | null = null;
  const flush = (): void => {
    if (!cur) return;
    if (!cur.run) throw new Error(`skill ${skill}: check entry without a run command`);
    out.push({ skill, name: cur.name ?? cur.run, run: cur.run });
    cur = null;
  };
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === "" || l.trim().startsWith("#")) continue;
    if (/^\S/.test(l)) break; // next top-level key
    const item = l.match(/^\s*-\s+(.*)$/);
    const body = item ? item[1]! : l.trim();
    const kv = body.match(/^(name|run)\s*:\s*(.+)$/);
    if (item) { flush(); cur = {}; }
    if (kv) {
      if (!cur) throw new Error(`skill ${skill}: key outside a list item: ${l.trim()}`);
      cur[kv[1] as "name" | "run"] = unquote(kv[2]!);
    } else if (item && cur) cur.run = unquote(body);
    else throw new Error(`skill ${skill}: unparseable checks line: ${l.trim()}`);
  }
  flush();
  if (out.length === 0) throw new Error(`skill ${skill}: checks declared but none parsed`);
  return out;
}

/** Load every check declared by <cwd>/.claude/skills/<skill>/SKILL.md. Parse problems land in errors (the gate fails on any). */
export function loadSkillChecks(cwd: string): SkillCheckLoad {
  const root = join(cwd, ".claude", "skills");
  const res: SkillCheckLoad = { checks: [], errors: [] };
  let names: string[];
  try { names = readdirSync(root).sort(); } catch { return res; }
  for (const n of names) {
    const file = join(root, n, "SKILL.md");
    try {
      let isLink: boolean;
      try { isLink = lstatSync(file).isSymbolicLink(); } catch { continue; }
      if (isLink) { res.errors.push(`skill ${n}: SKILL.md is a symlink (refused)`); continue; }
      const parsed = parseSkillChecks(readFileSync(file, "utf8"), n);
      if (parsed) res.checks.push(...parsed);
    } catch (e) { res.errors.push((e as Error).message); }
  }
  return res;
}

async function runOne(c: SkillCheck, cwd: string, timeoutMs: number): Promise<string | null> {
  let timedOut = false;
  try {
    const proc = Bun.spawn({ cmd: ["sh", "-c", c.run], cwd, env: skillCheckEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const t = setTimeout(() => { timedOut = true; try { proc.kill("SIGKILL"); } catch { /* exited */ } }, timeoutMs);
    try {
      const [out, err, code] = await Promise.all([readStreamCapped(proc.stdout as ReadableStream<Uint8Array>, 65536), new Response(proc.stderr).text(), proc.exited]);
      if (timedOut) return `timed out after ${timeoutMs}ms`;
      if (code !== 0) return `exit ${code}: ${(err || out).trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`;
      return null;
    } finally { clearTimeout(t); }
  } catch (e) { return `spawn error: ${(e as Error).message}`; }
}

/** Run every declared check; fails closed. No skills or no checks declared = pass. */
export async function runSkillChecks(cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SkillCheckResult> {
  const { checks, errors } = loadSkillChecks(cwd);
  const failures = [...errors];
  for (const c of checks) {
    const why = await runOne(c, cwd, timeoutMs);
    if (why) failures.push(`${c.skill}/${c.name}: ${why}`);
  }
  if (failures.length > 0) return { passed: false, detail: `skill_checks: ${failures.length} failed -- ${failures.join("; ")}` };
  return { passed: true, detail: `skill_checks: ${checks.length} check(s) passed` };
}
