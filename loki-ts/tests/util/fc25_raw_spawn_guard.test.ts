// FC-25 guard: a raw spawn of the git binary under loki-ts/src must go through safeGit()/safeGitArgv() (util/safe_git.ts)
// unless the file is allowlisted below with a reason. A new raw spawn in a token-holding process (supervisor, CLI before
// withholding, PR path) is what let a core.fsmonitor plant in the agent's repo run holding the real token (moat P9).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const WORKER = "worker process (engine10 stage or its helper), env already token-withheld via withholdGithubTokens(workerEnv)";
const RUNNER = "bash-route TS runner, calls withholdGithubTokens() at startup (runner/autonomous.ts) before any of these run";
const ALLOW: Record<string, string> = {
  "engine10/worker.ts": WORKER,
  "engine10/session.ts": WORKER,
  "engine10/stages/intake.ts": WORKER,
  "engine10/stages/verify.ts": WORKER,
  "engine10/stages/deep.ts": WORKER + " (deep-worker is spawned with workerEnv)",
  "engine10/stages/seal.ts": WORKER,
  "e10ext/assert_delta.ts": WORKER,
  "e10ext/discard.ts": WORKER + "; also needs Buffer stdout",
  "e10ext/preexisting_dirty.ts": WORKER,
  "e10ext/treeswap.ts": WORKER + "; operates on a private tree copy",
  "features/speed/already_done_async.ts": WORKER + " (reached from intake)",
  "features/wall_manifest_wire.ts": WORKER + " (reached from intake/seal); also needs Buffer stdout and stdin",
  "project_model/gather.ts": "project discovery; follow-up: confirm every caller is worker-side or convert",
  "runner/checkpoint.ts": RUNNER,
  "runner/council.ts": RUNNER,
  "runner/prd_reuse.ts": RUNNER,
  "runner/quality_gates.ts": RUNNER,
  "runner/github_token.ts": "git --version only, no repo cwd",
  "cli/completions.ts": "tab completion for-each-ref, 150ms, read-only ref listing, never runs with a token-bearing task",
};
const RAW = /[(\[]\s*"git"\s*[,)]/;

function walk(d: string, out: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("no raw git spawn outside safe_git.ts unless allowlisted with a reason", () => {
  const raw: string[] = [];
  for (const f of walk(SRC)) {
    const rel = relative(SRC, f);
    if (rel === "util/safe_git.ts") continue;
    if (readFileSync(f, "utf8").split("\n").some((l) => RAW.test(l) && !l.trim().startsWith("//"))) raw.push(rel);
  }
  const unlisted = raw.filter((r) => !(r in ALLOW));
  expect(unlisted).toEqual([]);
});

test("the allowlist has no stale entries and every entry has a reason", () => {
  const raw = new Set(walk(SRC).filter((f) => readFileSync(f, "utf8").split("\n").some((l) => RAW.test(l))).map((f) => relative(SRC, f)));
  for (const [k, why] of Object.entries(ALLOW)) {
    expect(why.length).toBeGreaterThan(10);
    expect(raw.has(k)).toBe(true);
  }
});
