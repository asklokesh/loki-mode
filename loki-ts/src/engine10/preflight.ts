import { accessSync, constants as fsc, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { truthy } from "../runner/providers.ts"; // E-36 first-run preflight (docs/v10/ENGINE.md); see preflight.test.ts for cases. Terse: engine10's own budget test caps this dir at 5,000 lines.
import { safeGitRun } from "../util/safe_git.ts";
import { anthropicKeyProbeCached, claudeLoginProbeCached, ghAuthProbeCached, providerAuthPath, providerLoginIssue, requirementFix } from "../commands/doctor.ts";
import { initEmptyRepo, NOT_A_REPO } from "../util/first_run_repo.ts";
import { run, type ShellOpts, type ShellResult } from "../util/shell.ts";
const CLI_ENV_VAR: Record<string, string> = { claude: "LOKI_CLAUDE_CLI", codex: "LOKI_CODEX_CLI", cline: "LOKI_CLINE_CLI", aider: "LOKI_AIDER_CLI", opencode: "LOKI_OPENCODE_CLI" }; // provider name doubles as its default CLI
const GITHUB_ORIGIN_RE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/;
export interface PreflightOptions { repoDir: string; provider: string; pr: boolean; env?: Record<string, string | undefined>; runDir?: string; statfs?: (path: string) => { bavail: number | bigint; bsize: number | bigint } }
export interface PreflightResult { fatal: string | null; warnings: string[] }
async function sh(argv: readonly string[], opts: ShellOpts): Promise<ShellResult> { try { return await run(argv, opts); } catch { return { stdout: "", stderr: "", exitCode: 127 }; } } // run() throws (Bun.spawn) when argv[0] does not resolve at all; treated as a failed check, never a crash
/** TEN-STABILITY-36: free MB on the repo volume (same statfsSync math as doctor checkDisk), null when unreadable. */
function freeMb(dir: string, statfs: NonNullable<PreflightOptions["statfs"]>): number | null { try { const s = statfs(dir); return (Number(s.bavail) * Number(s.bsize)) / (1024 * 1024); } catch { return null; } }
export async function checkPreflight(o: PreflightOptions): Promise<PreflightResult> {
  const env = (o.env ?? process.env) as Record<string, string>; const warnings: string[] = []; const git = (a: string[]) => safeGitRun(o.repoDir, a, { env, timeoutMs: 10000 }); // FC-25: the supervisor holds the token; the repo config is untrusted
  const reads = () => Promise.all([git(["rev-parse", "--is-inside-work-tree"]), git(["config", "user.name"]), git(["config", "user.email"]), git(["rev-parse", "--verify", "-q", "HEAD^{commit}"])]); // TEN-SPEED-14: all four git reads start together; TEN-STABILITY-35: git init with nothing committed has no HEAD and dies later in worktree creation
  let [wt, name, email, head] = await reads(); let initFatal: string | undefined; // TEN-UX-01: only a truly empty folder is initialised
  if (wt.exitCode !== 0 || wt.stdout.trim() !== "true") { const i = await initEmptyRepo(o.repoDir, env); if (i.notice) { warnings.push(i.notice); [wt, name, email, head] = await reads(); } else initFatal = i.fatal; } // re-read only when auto-init ran
  const envVar = CLI_ENV_VAR[o.provider]; const cli = (envVar && env[envVar]?.trim()) || o.provider; const cliOk = envVar ? !!Bun.which(cli, { PATH: env.PATH ?? process.env.PATH ?? "" }) : true; // resolve against the given env's PATH, never the process's
  const fatal =
    wt.exitCode !== 0 || wt.stdout.trim() !== "true" ? (initFatal ?? NOT_A_REPO(o.repoDir)) :
    !name.stdout.trim() || !email.stdout.trim() ? `git identity is not set; run: git config user.name "you" && git config user.email "you@example.com"` :
    !envVar ? `the v10 engine has no ${o.provider} invoker yet` :
    o.provider !== "claude" && truthy(env["LOKI_HOST_GUARD"]) ? `LOKI_HOST_GUARD=1 is set but provider '${o.provider}' has no enforced PreToolUse hook; unset LOKI_HOST_GUARD or use --provider claude` :
    !cliOk ? `provider CLI '${cli}' is not on PATH; install it or set ${envVar} to its path${requirementFix(o.provider) ? `. Fix: ${requirementFix(o.provider)}` : ""}` :
    head.exitCode !== 0 ? "repository has no commits; run: git add . && git commit -m init" :
    null;
  if (fatal) return { fatal, warnings };
  try { accessSync(o.repoDir, fsc.W_OK); } catch { return { fatal: `${o.repoDir} is not writable; run: chmod u+w "${o.repoDir}" (or run loki from a writable checkout)`, warnings }; } // TEN-UX-55: a read-only checkout otherwise fails mid-run on the first write
  const free = freeMb(o.repoDir, o.statfs ?? statfsSync); const minMb = Number(env["LOKI_MIN_FREE_MB"]) > 0 ? Number(env["LOKI_MIN_FREE_MB"]) : 200; // TEN-STABILITY-36: a full volume otherwise dies mid-run in worktree or event-log writes
  if (free !== null && free < minMb) return { fatal: `only ${Math.floor(free)} MB free on the volume holding ${o.repoDir} (need ${minMb} MB); free disk space, or lower LOKI_MIN_FREE_MB`, warnings };
  if (free !== null && free < Math.max(2048, minMb)) warnings.push(`low disk: ${Math.floor(free)} MB free on the volume holding ${o.repoDir}; a long run may fail mid-way (warns under 2 GB)`);
  // CW-14: zero-token auth probe (a local CLI status command only, never a model endpoint); LOKI_PREFLIGHT_PROBE=0 skips it. The outcome is bound into <runDir>/preflight.json.
  const auth_path = providerAuthPath(o.provider, env); let probe: "ok" | "failed" | "skipped" | "unknown" = "skipped"; let probe_reason: string | undefined; let authFatal: string | undefined; const keyed = !auth_path.startsWith("cli_login") && auth_path !== "none";
  if (env["LOKI_PREFLIGHT_PROBE"] !== "0" && !keyed) {
    if (o.provider === "claude") { // TEN-UX-01: a logged-out CLI fails before any spend; unknown stays a warning
      const li = claudeLoginProbeCached(cli, env); // TEN-UX-12 retry + TEN-SPEED-05 10-min cache of a successful probe live in doctor.ts
      if (li === "no") { probe = "failed"; authFatal = "claude is not logged in; run: claude login (or set ANTHROPIC_API_KEY)"; }
      else if (li === "") { probe = "unknown"; warnings.push("could not confirm the Claude login (claude auth status gave no answer); continuing"); } else probe = "ok";
    } else { const pl = providerLoginIssue(o.provider, cli, env); if (pl.fatal) { probe = "failed"; authFatal = pl.fatal; } else if (pl.warn) { probe = "unknown"; warnings.push(pl.warn); } else if (pl.checked) probe = "ok"; else probe_reason = pl.reason; } // TEN-ADOPTION-34
  }
  else if (env["LOKI_PREFLIGHT_PROBE"] !== "0" && o.provider === "claude" && auth_path === "api_key:ANTHROPIC_API_KEY" && !truthy(env["LOKI_AIRGAP"]) && !truthy(env["CLAUDE_CODE_USE_BEDROCK"]) && !truthy(env["CLAUDE_CODE_USE_VERTEX"])) { // RQ-11 (#351): a set key is checked once, with no tokens spent; the key is never printed
    const kp = await anthropicKeyProbeCached(env);
    if (kp.result === "rejected") { probe = "failed"; authFatal = `ANTHROPIC_API_KEY was rejected (HTTP ${kp.status}); fix the key or unset it to use claude login`; }
    else if (kp.result === "ok") probe = "ok"; else { probe = "unknown"; warnings.push("could not confirm the ANTHROPIC_API_KEY (the key probe got no usable answer); continuing"); }
  }
  if (probe === "skipped" && !probe_reason) probe_reason = env["LOKI_PREFLIGHT_PROBE"] === "0" ? "LOKI_PREFLIGHT_PROBE=0" : keyed ? `credential is ${auth_path.split(":")[0]}; no zero-token check ran for it` : "no check ran";
  if (o.runDir) { try { mkdirSync(o.runDir, { recursive: true }); writeFileSync(join(o.runDir, "preflight.json"), JSON.stringify({ provider: o.provider, auth_path, probe, ...(probe_reason ? { probe_reason } : {}) }) + "\n"); } catch { /* the record is evidence, never a gate */ } }
  if (authFatal) return { fatal: authFatal, warnings };
  if (o.pr && GITHUB_ORIGIN_RE.test((await git(["config", "--get", "remote.origin.url"])).stdout.trim())) {
    const ghOk = await ghAuthProbeCached(env, async () => (await sh(["gh", "--version"], { env, timeoutMs: 5000 })).exitCode === 0 && (await sh(["gh", "auth", "status"], { env, timeoutMs: 10000 })).exitCode === 0); // TEN-SPEED-08: 10-min cache of a passing probe
    if (!ghOk) return { fatal: `gh (GitHub CLI) is missing or not authenticated; run gh auth login, or pass --no-pr`, warnings };
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
