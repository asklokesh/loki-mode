// v11.7.0 GROUP: the default GroupRunner for route.ts (D61 slices 10-13 glued together). Order: freeze per-unit acceptance
// (contract.ts), write the DAG, run units through autonomy/lib/backlog.py under the provider slot cap, merge passing unit
// branches and run the suite once (engine10/integrate.ts). Moat: the exit code is never 0 (NOT_PROVEN until a group Seal exists); a launcher
// failure, an orphan criterion or an unreadable result is never VERIFIED. This runner does not write group/manifest.json, so it
// never claims a combined group Seal receipt: it says so.
import { mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { Dag } from "../decompose.ts";
import { freezeGroupContract, parseContract } from "../contract.ts";
import { integrate } from "../../engine10/integrate.ts";
import { safeGitSpawn } from "../../util/safe_git.ts";
import { atomicWriteJson } from "../../util/atomic.ts";
import { REPO_ROOT } from "../../util/paths.ts";
import { providerSlots, type GroupCtx } from "./route.ts";

/** Group integrated but not sealed: distinct non-zero so no caller reads it as VERIFIED. */
export const NOT_PROVEN = 4;

export interface BacklogRun { code: number; stdout: string }
/** argv is the full python3 argument list after the interpreter; env is already scoped. */
export type BacklogLauncher = (argv: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<BacklogRun>;

const ENV_KEEP = /^(PATH|HOME|TMPDIR|LANG|LC_ALL|CI|SSH_AUTH_SOCK|GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|LOKI_[A-Z0-9_]+|CLAUDE_[A-Z0-9_]+)$/;
export function scopedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && ENV_KEEP.test(k)) out[k] = v;
  out["LOKI_NO_BROWSER"] = "1";
  return out;
}

const defaultLauncher: BacklogLauncher = (argv, env, cwd) => new Promise((resolve) => {
  const child = spawn("python3", argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); process.stderr.write(b); });
  child.stderr.on("data", (b: Buffer) => { process.stderr.write(b); });
  child.on("error", (e) => resolve({ code: 127, stdout: out + String(e) }));
  child.on("close", (c) => resolve({ code: c ?? 1, stdout: out }));
});

const git = (dir: string, args: string[]): string => {
  const r = safeGitSpawn(dir, args, { encoding: "utf8" });
  return r.status === 0 ? String(r.stdout).trim() : "";
};
const SLUG_RE = /[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/;

/** Repo test command argv: LOKI_GROUP_TEST_CMD (whitespace split) wins; else a detected default; else empty (the suite then did not run). */
export function testCommand(repoDir: string, env: NodeJS.ProcessEnv): string[] {
  const o = (env.LOKI_GROUP_TEST_CMD ?? "").trim();
  if (o) return o.split(/\s+/);
  if (existsSync(join(repoDir, "package.json"))) return ["npm", "test", "--silent"];
  if (existsSync(join(repoDir, "pyproject.toml")) || existsSync(join(repoDir, "pytest.ini"))) return ["python3", "-m", "pytest", "-q"];
  return [];
}

export async function runGroup(launcher: BacklogLauncher | undefined, dag: Dag, ctx: GroupCtx): Promise<number> {
  const say = ctx.say ?? ((s: string): void => { process.stderr.write(s); });
  const { repoDir, env } = ctx;
  const groupId = `g${Date.now().toString(36)}`;
  const run = launcher ?? defaultLauncher;

  const frozen = freezeGroupContract(repoDir, groupId, dag.units, parseContract(ctx.spec, ctx.specPath ?? ""));
  if (!frozen.ok) { say(`loki: ${frozen.reason}\n`); return 1; }

  const dagPath = join(repoDir, ".loki", "groups", groupId, "dag.json");
  mkdirSync(dirname(dagPath), { recursive: true });
  atomicWriteJson(dagPath, { group: groupId, ...dag });

  const slug = SLUG_RE.exec(git(repoDir, ["remote", "get-url", "origin"]))?.[1];
  if (!slug) { say("loki: NOT PROVEN: group run needs an origin remote of the form owner/repo; no unit was started\n"); return 1; }
  const baseRef = git(repoDir, ["rev-parse", "HEAD"]);
  if (!baseRef) { say("loki: NOT PROVEN: cannot resolve HEAD; no unit was started\n"); return 1; }

  const { provider, slots } = providerSlots(env, ctx.provider);
  const n = Math.min(slots, dag.units.length);
  say(`loki: group ${groupId}: ${dag.units.length} units, ${n} parallel slot(s) (provider ${provider})\n`);
  const backlog = join(REPO_ROOT, "autonomy", "lib", "backlog.py");
  const res = await run([backlog, slug, "--dag", dagPath, "--group", groupId, "--slots", String(n), "--provider", provider], scopedEnv({ ...env, LOKI_PROVIDER: provider }), repoDir);

  // backlog prints `backlog: unit-<group>-<n> <status>`; a unit passed only when its status is VERIFIED or a PR url. Anything else is a fail.
  const status = new Map<string, string>();
  for (const m of res.stdout.matchAll(/^backlog: (unit-\S+) (VERIFIED|PR \S+|FAILED.*|BLOCKED.*|BUDGET_STOP.*|SKIPPED.*)$/gm)) status.set(m[1]!, m[2]!);
  const branches: Record<string, string> = {};
  const failedUnits: string[] = [];
  dag.units.forEach((u, i) => {
    const key = `unit-${groupId}-${i + 1}`, st = status.get(key) ?? "";
    if (/^(VERIFIED|PR )/.test(st)) branches[u.id] = `loki/${key}`; else failedUnits.push(u.id);
  });
  if (res.code !== 0) say(`loki: unit launcher exit ${res.code}; ${failedUnits.length} unit(s) did not pass\n`);
  if (Object.keys(branches).length === 0) { say("loki: FAILED: no unit passed; nothing to integrate\n"); return 1; }

  const r = integrate({ repoDir, groupId, baseRef, dag, branches, failedUnits, testCmd: testCommand(repoDir, env) });
  for (const [id, o] of Object.entries(r.perUnit)) say(`loki: unit ${id} ${o}\n`);
  if (!r.ok || res.code !== 0) {
    say(`loki: FAILED: group not verified (${r.reason ?? "launcher reported a failed unit"})\n`);
    return 1;
  }
  // Moat: no group Seal receipt is written (sealGroup is not wired here) and the frozen per-unit acceptance is not forwarded to
  // the workers, so the group is integrated but NOT PROVEN. Exit 4 (NOT_PROVEN), never 0: callers map 0 to VERIFIED.
  say(`loki: group ${groupId} integrated on ${r.branch}, suite exit ${r.suiteExit}. NOT PROVEN: Group Seal receipt UNCHECKED (no combined receipt written, frozen unit acceptance not checked); exit ${NOT_PROVEN}\n`);
  return NOT_PROVEN;
}
