import { accessSync, constants as fsc, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { truthy } from "../runner/providers.ts"; // E-36 first-run preflight (docs/v10/ENGINE.md); cases: tests/min/newcomer-path.sh. Terse: engine10's own budget test caps this dir at 5,000 lines.
import { safeGitRun } from "../util/safe_git.ts"; import { canonicalSessionPin } from "../util/claude_model.ts";
import { claudeLoginProbeCached, claudeSdkReady, ghAuthProbeCached, providerAuthPath, providerLoginIssue, requirementFix, sdkBinaryPresent } from "../commands/doctor.ts";
import { initEmptyRepo, NOT_A_REPO } from "../util/first_run_repo.ts";
import { probePublish, recordPublish } from "../util/engine_origin.ts";
import { run, type ShellOpts, type ShellResult } from "../util/shell.ts"; import { noteRefusal, type PreflightBlocker } from "../util/funnel.ts";
const CLI_ENV_VAR: Record<string, string> = { claude: "LOKI_CLAUDE_CLI", codex: "LOKI_CODEX_CLI", cline: "LOKI_CLINE_CLI", aider: "LOKI_AIDER_CLI", opencode: "LOKI_OPENCODE_CLI" }; // provider name doubles as its default CLI
const GITHUB_ORIGIN_RE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/;
export interface PreflightOptions { repoDir: string; provider: string; pr: boolean; env?: Record<string, string | undefined>; runDir?: string; statfs?: (path: string) => { bavail: number | bigint; bsize: number | bigint } }
export interface PreflightResult { fatal: string | null; warnings: string[]; blocker?: PreflightBlocker; blockers?: PreflightBlocker[] } // AN-08: blocker is the first refusing check's class; L035: blockers lists every one, in fatal's numbered order
async function sh(argv: readonly string[], opts: ShellOpts): Promise<ShellResult> { try { return await run(argv, opts); } catch { return { stdout: "", stderr: "", exitCode: 127 }; } } // run() throws (Bun.spawn) when argv[0] does not resolve at all; treated as a failed check, never a crash
/** TEN-STABILITY-36: free MB on the repo volume (same statfsSync math as doctor checkDisk), null when unreadable. */
function freeMb(dir: string, statfs: NonNullable<PreflightOptions["statfs"]>): number | null { try { const s = statfs(dir); return (Number(s.bavail) * Number(s.bsize)) / (1024 * 1024); } catch { return null; } }
/** gh installed and logged in. TEN-SPEED-08: 10-min cache of a passing probe. */
export const ghReady = (env: Record<string, string>): Promise<boolean> => ghAuthProbeCached(env, async () => (await sh(["gh", "--version"], { env, timeoutMs: 5000 })).exitCode === 0 && (await sh(["gh", "auth", "status"], { env, timeoutMs: 10000 })).exitCode === 0);
export async function checkPreflight(o: PreflightOptions): Promise<PreflightResult> {
  const env = (o.env ?? process.env) as Record<string, string>; const warnings: string[] = []; const git = (a: string[]) => safeGitRun(o.repoDir, a, { env, timeoutMs: 10000 }); // FC-25: the supervisor holds the token; the repo config is untrusted
  const reads = () => Promise.all([git(["rev-parse", "--is-inside-work-tree"]), git(["config", "user.name"]), git(["config", "user.email"]), git(["rev-parse", "--verify", "-q", "HEAD^{commit}"])]); // TEN-SPEED-14: all four git reads start together; TEN-STABILITY-35: git init with nothing committed has no HEAD and dies later in worktree creation
  let [wt, name, email, head] = await reads(); let initFatal: string | undefined; // TEN-UX-01: only a truly empty folder is initialised
  if (wt.exitCode !== 0 || wt.stdout.trim() !== "true") { const i = await initEmptyRepo(o.repoDir, env); if (i.notice) { warnings.push(i.notice); [wt, name, email, head] = await reads(); } else initFatal = i.fatal; } // re-read only when auto-init ran
  const envVar = CLI_ENV_VAR[o.provider]; const cli = (envVar && env[envVar]?.trim()) || o.provider; const cliOk = envVar ? !!Bun.which(cli, { PATH: env.PATH ?? process.env.PATH ?? "" }) : true; // resolve against the given env's PATH, never the process's
  const sdk = o.provider === "claude" && !cliOk && claudeSdkReady(env); // L034: a key plus the bundled SDK binary runs claude with no CLI (session.ts uses the SDK unless LOKI_E10_INVOKER=cli)
  let pinErr: string | undefined; if (o.provider === "claude") { try { canonicalSessionPin(env["LOKI_SESSION_MODEL"]); } catch (e) { pinErr = `${(e as Error).message}; run: unset LOKI_SESSION_MODEL (or set a valid value; the run would otherwise drop the pin and use the provider default model)`; } } // FC-ENGINE10-IGNORES-SESSION-MODEL-PIN: refuse, never substitute
  // L035: every blocker in one pass, in the order the fixes apply (identity before the first commit). AN-08: each names its own class.
  const hits: [PreflightBlocker, string][] = []; const add = (on: unknown, b: PreflightBlocker, f: string) => { if (on) hits.push([b, f]); };
  const repoOk = wt.exitCode === 0 && wt.stdout.trim() === "true";
  add(!repoOk, "not_a_repo", initFatal ?? NOT_A_REPO(o.repoDir));
  add(!name.stdout.trim() || !email.stdout.trim(), "git_identity", `git identity is not set; run: git config user.name "you" && git config user.email "you@example.com"`);
  add(repoOk && head.exitCode !== 0, "other", "repository has no commits; run: git add . && git commit -m init");
  add(!envVar, "unsupported_flag", `the v10 engine has no ${o.provider} invoker yet; run with --provider claude`);
  add(envVar && o.provider !== "claude" && truthy(env["LOKI_HOST_GUARD"]), "other", `LOKI_HOST_GUARD=1 is set but provider '${o.provider}' has no enforced PreToolUse hook; unset LOKI_HOST_GUARD or use --provider claude`);
  add(pinErr, "other", pinErr ?? "");
  add(!cliOk && !sdk, "no_provider", `provider CLI '${cli}' is not on PATH; install it or set ${envVar} to its path${requirementFix(o.provider) ? `. Fix: ${requirementFix(o.provider)}` : ""}${o.provider === "claude" && sdkBinaryPresent(env) ? " (or export ANTHROPIC_API_KEY=<your key> to run on the bundled Agent SDK)" : ""}`);
  try { accessSync(o.repoDir, fsc.W_OK); } catch { add(true, "other", `${o.repoDir} is not writable; run: chmod u+w "${o.repoDir}" (or run loki from a writable checkout)`); } // TEN-UX-55: a read-only checkout otherwise fails mid-run on the first write
  const free = freeMb(o.repoDir, o.statfs ?? statfsSync); const minMb = Number(env["LOKI_MIN_FREE_MB"]) > 0 ? Number(env["LOKI_MIN_FREE_MB"]) : 200; // TEN-STABILITY-36: a full volume otherwise dies mid-run in worktree or event-log writes
  add(free !== null && free < minMb, "disk", `only ${Math.floor(free ?? 0)} MB free on the volume holding ${o.repoDir} (need ${minMb} MB); free disk space, or lower LOKI_MIN_FREE_MB`);
  if (free !== null && free >= minMb && free < Math.max(2048, minMb)) warnings.push(`low disk: ${Math.floor(free)} MB free on the volume holding ${o.repoDir}; a long run may fail mid-way (warns under 2 GB)`);
  // CW-14: zero-token auth probe (a local CLI status command only, never a model endpoint); LOKI_PREFLIGHT_PROBE=0 skips it. The outcome is bound into <runDir>/preflight.json.
  const auth_path = providerAuthPath(o.provider, env); let probe: "ok" | "failed" | "skipped" = "skipped"; const keyed = !auth_path.startsWith("cli_login") && auth_path !== "none";
  if (env["LOKI_PREFLIGHT_PROBE"] !== "0" && !keyed && envVar && cliOk) { // a CLI that is not there has no login to probe (its own blocker says so)
    if (o.provider === "claude") { // TEN-UX-01: a logged-out CLI fails before any spend; unknown stays a warning
      const li = claudeLoginProbeCached(cli, env); // TEN-UX-12 retry + TEN-SPEED-05 10-min cache of a successful probe live in doctor.ts
      if (li === "no") { probe = "failed"; add(true, "not_logged_in", "claude is not logged in; run: claude auth login (or set ANTHROPIC_API_KEY)"); }
      else if (li === "") warnings.push("could not confirm the Claude login (claude auth status gave no answer); continuing"); else probe = "ok";
    } else { const pl = providerLoginIssue(o.provider, cli, env); if (pl?.fatal) { probe = "failed"; add(true, "not_logged_in", pl.fatal); } else if (pl?.warn) warnings.push(pl.warn); else if (o.provider === "codex") probe = "ok"; } // TEN-ADOPTION-34
  }
  if (o.runDir && hits.every(([b]) => b === "not_logged_in")) { try { mkdirSync(o.runDir, { recursive: true }); writeFileSync(join(o.runDir, "preflight.json"), JSON.stringify({ provider: o.provider, auth_path, probe }) + "\n"); } catch { /* the record is evidence, never a gate */ } }
  if (o.pr && repoOk && GITHUB_ORIGIN_RE.test((await git(["config", "--get", "remote.origin.url"])).stdout.trim())) {
    if (!(await ghReady(env))) add(true, "other", "gh (GitHub CLI) is missing or not authenticated; run: gh auth login (or pass --no-pr)");
    else if (!hits.length) {
      const plan = await probePublish((await git(["config", "--get", "remote.origin.url"])).stdout.trim(), env); // R100-022: read at intake, never discovered after the work
      if (plan) { if (plan.warning) warnings.push(plan.warning); if (o.runDir) recordPublish(o.runDir, plan); }
    }
  }
  if (!hits.length) return { fatal: null, warnings };
  const fatal = hits.length === 1 ? hits[0]![1] : `${hits.length} things to fix before this run can start:\n${hits.map(([, f], i) => `  ${i + 1}. ${f}`).join("\n")}`;
  return { fatal, warnings, blocker: hits[0]![0], blockers: hits.map(([b]) => b) };
}
export class PreflightError extends Error { constructor(message: string, readonly blocker: PreflightBlocker = "other") { super(message); } }
/** Library form: warnings to stderr, a fatal check throws PreflightError (never exits, so in-process callers and tests survive). */
export async function assertPreflight(o: PreflightOptions): Promise<void> {
  const r = await checkPreflight(o); for (const w of r.warnings) process.stderr.write(`${w}\n`); if (r.fatal) throw new PreflightError(r.fatal, r.blocker);
}
/** CLI form: exits 2 with the fatal line. */
export async function preflight(o: PreflightOptions): Promise<void> {
  try { await assertPreflight(o); } catch (e) { if (!(e instanceof PreflightError)) throw e; process.stderr.write(`${e.message}\n`); noteRefusal(e.blocker); process.exit(2); }
}
