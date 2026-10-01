import { truthy } from "../runner/providers.ts"; // E-36 first-run preflight (docs/v10/ENGINE.md); see preflight.test.ts for cases. Terse: engine10's own budget test caps this dir at 5,000 lines.
import { run, type ShellOpts, type ShellResult } from "../util/shell.ts";
const CLI_ENV_VAR: Record<string, string> = { claude: "LOKI_CLAUDE_CLI", codex: "LOKI_CODEX_CLI", cline: "LOKI_CLINE_CLI", aider: "LOKI_AIDER_CLI" }; // provider name doubles as its default CLI
const GITHUB_ORIGIN_RE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/;
export interface PreflightOptions { repoDir: string; provider: string; pr: boolean; env?: Record<string, string | undefined> }
export interface PreflightResult { fatal: string | null; warnings: string[] }
async function sh(argv: readonly string[], opts: ShellOpts): Promise<ShellResult> { try { return await run(argv, opts); } catch { return { stdout: "", stderr: "", exitCode: 127 }; } } // run() throws (Bun.spawn) when argv[0] does not resolve at all; treated as a failed check, never a crash
export async function checkPreflight(o: PreflightOptions): Promise<PreflightResult> {
  const env = (o.env ?? process.env) as Record<string, string>; const warnings: string[] = []; const git = (a: string[]) => sh(["git", ...a], { cwd: o.repoDir, env, timeoutMs: 10000 });
  const [wt, name, email] = await Promise.all([git(["rev-parse", "--is-inside-work-tree"]), git(["config", "user.name"]), git(["config", "user.email"])]);
  const envVar = CLI_ENV_VAR[o.provider]; const cli = (envVar && env[envVar]?.trim()) || o.provider; const cliOk = envVar ? !!Bun.which(cli, { PATH: env.PATH ?? process.env.PATH ?? "" }) : true; // resolve against the given env's PATH, never the process's
  const fatal =
    wt.exitCode !== 0 || wt.stdout.trim() !== "true" ? `not a git repository: ${o.repoDir} is not inside a git work tree; run loki from inside a git checkout` :
    !name.stdout.trim() || !email.stdout.trim() ? `git identity is not set; run: git config user.name "you" && git config user.email "you@example.com"` :
    !envVar ? `the v10 engine has no ${o.provider} invoker yet; use LOKI_ENGINE=legacy loki start --provider ${o.provider}` :
    o.provider !== "claude" && truthy(env["LOKI_HOST_GUARD"]) ? `LOKI_HOST_GUARD=1 is set but provider '${o.provider}' has no enforced PreToolUse hook; unset LOKI_HOST_GUARD or use --provider claude` :
    !cliOk ? `provider CLI '${cli}' is not on PATH; install it or set ${envVar} to its path` :
    null;
  if (fatal) return { fatal, warnings };
  if (o.pr && GITHUB_ORIGIN_RE.test((await git(["config", "--get", "remote.origin.url"])).stdout.trim())) {
    const v = await sh(["gh", "--version"], { env, timeoutMs: 5000 }); const a = v.exitCode === 0 ? await sh(["gh", "auth", "status"], { env, timeoutMs: 10000 }) : v;
    if (v.exitCode !== 0 || a.exitCode !== 0) return { fatal: `gh (GitHub CLI) is missing or not authenticated; run gh auth login, or pass --no-pr`, warnings };
  }
  return { fatal: null, warnings };
}
export class PreflightError extends Error {}
/** Library form: warnings to stderr, a fatal check throws PreflightError (never exits, so in-process callers and tests survive). */
export async function assertPreflight(o: PreflightOptions): Promise<void> {
  const r = await checkPreflight(o); for (const w of r.warnings) process.stderr.write(`${w}\n`); if (r.fatal) throw new PreflightError(r.fatal);
}
/** CLI form: exits 2 with the fatal line. */
export async function preflight(o: PreflightOptions): Promise<void> {
  try { await assertPreflight(o); } catch (e) { if (!(e instanceof PreflightError)) throw e; process.stderr.write(`${e.message}\n`); process.exit(2); }
}
