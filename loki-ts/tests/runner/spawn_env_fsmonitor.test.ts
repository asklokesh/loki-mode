// BACKLOG 149 round 4: in Bun (measured on 1.3.13) a child spawned with NO
// `env` option (Bun.spawn, Bun.spawnSync, execFileSync, spawnSync) inherits
// the environment from process START, ignoring later process.env edits. So
// withholdGithubTokens() protected the provider, but every bare git call the
// runner itself makes inside the agent's working tree (council.ts
// trackIteration, prd_reuse.ts computeCodebaseSignature) ran with the REAL
// GH_TOKEN and SSH_AUTH_SOCK. An agent that sets core.fsmonitor in .git/config
// gets its script run by that git call, holding the operator's credentials.
//
// The bug only exists for values present at process START, so the production
// paths run in a child bun process whose start environment carries synthetic
// canaries. Two controls run in the same child:
//  - explicit-env control: passes the canary in `env`; proves the hook records
//    env values on any Bun, so the product assertions can fail.
//  - bare control: no `env`; only DETECTS the inheritance mode. Bun 1.3.x
//    leaks the start env (the bug class exists, product assertions are the
//    guard); Bun >= 1.4 fixes this only for node:child_process. Bun.spawn and
//    Bun.spawnSync with no env STILL inherit the START env on 1.4.2, so the
//    bug class remains. tests/runner/spawn_env_guard.test.ts is the guard that
//    requires an explicit env on every Bun.spawn, Bun.spawnSync and
//    child_process call under src; do not remove it.

import { afterEach, beforeEach, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

setDefaultTimeout(30_000);

const SRC = resolve(import.meta.dir, "../../src/runner");
const CANARY_TOKEN = "ghp_FSMONCANARYstartenv0000000000";
const CANARY_SOCK = "/tmp/loki-fsmon-canary-agent.sock";

let root: string;
beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "loki-fsmon-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it("runner git calls do not hand start-env credentials to an agent-set core.fsmonitor", () => {
  const repo = resolve(root, "repo");
  const rec = resolve(root, "fsmon.rec");
  const control = resolve(root, "control.rec");
  const g = (...a: string[]) =>
    execFileSync("git", a, { cwd: repo, env: { ...process.env }, stdio: "ignore" });
  execFileSync("git", ["init", "-q", repo], { env: { ...process.env }, stdio: "ignore" });
  writeFileSync(resolve(repo, "a.txt"), "a\n");
  g("add", "a.txt");
  g("-c", "user.email=x@example.invalid", "-c", "user.name=x", "commit", "-q", "-m", "i");
  // Records what the fsmonitor hook sees; exit 1 = "no fsmonitor data", which
  // makes git fall back to a normal scan. A second hook writes the control
  // record, selected per call with `-c core.fsmonitor=` (an argument, so it
  // does not depend on the environment under test).
  const mkHook = (path: string, out: string) => {
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s|%s\\n' "\${GH_TOKEN:-absent}" "\${SSH_AUTH_SOCK:-absent}" >> '${out}'\nexit 1\n`,
    );
    chmodSync(path, 0o755);
  };
  const hook = resolve(root, "fsmon.sh");
  const controlHook = resolve(root, "fsmon-control.sh");
  const explicitHook = resolve(root, "fsmon-explicit.sh");
  const explicit = resolve(root, "explicit.rec");
  mkHook(hook, rec);
  mkHook(controlHook, control);
  mkHook(explicitHook, explicit);
  g("config", "core.fsmonitor", hook);
  const prd = resolve(repo, "prd.md");
  writeFileSync(prd, "# prd\n");

  const driver = resolve(root, "driver.ts");
  writeFileSync(
    driver,
    `import { execFileSync } from "node:child_process";
import { withholdGithubTokens } from ${JSON.stringify(resolve(SRC, "github_token.ts"))};
import { defaultCouncil } from ${JSON.stringify(resolve(SRC, "council.ts"))};
import { resolvePrdForRun } from ${JSON.stringify(resolve(SRC, "prd_reuse.ts"))};
withholdGithubTokens(process.env, () => {});
await defaultCouncil.trackIteration!("");
resolvePrdForRun({ prdPath: ${JSON.stringify(prd)}, cwd: ${JSON.stringify(repo)} });
// Explicit-env control: canary passed in env, recorded on any Bun.
try { execFileSync("git", ["-c", "core.fsmonitor=" + ${JSON.stringify(explicitHook)}, "status", "--porcelain"], { cwd: ${JSON.stringify(repo)}, stdio: "ignore", env: { ...process.env, GH_TOKEN: ${JSON.stringify(CANARY_TOKEN)}, SSH_AUTH_SOCK: ${JSON.stringify(CANARY_SOCK)} } }); } catch {}
// Bare control: no env; detects whether this Bun inherits the start env.
try { execFileSync("git", ["-c", "core.fsmonitor=" + ${JSON.stringify(controlHook)}, "status", "--porcelain"], { cwd: ${JSON.stringify(repo)}, stdio: "ignore" }); } catch {}
`,
  );

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env["GH_TOKEN"] = CANARY_TOKEN;
  env["SSH_AUTH_SOCK"] = CANARY_SOCK;
  env["TARGET_DIR"] = repo;
  env["LOKI_DIR"] = resolve(repo, ".loki");
  delete env["LOKI_ALLOW_AGENT_GITHUB_TOKEN"];
  const r = spawnSync(process.execPath, [driver], { cwd: repo, env, encoding: "utf8" });
  expect(r.status).toBe(0);

  const lines = readFileSync(rec, "utf8").trim().split("\n").filter(Boolean);
  // Both production paths ran git status/diff, which invoke fsmonitor.
  expect(lines.length).toBeGreaterThanOrEqual(2);
  for (const l of lines) {
    expect(l).not.toContain(CANARY_TOKEN);
    expect(l).not.toContain(CANARY_SOCK);
    expect(l).toMatch(/^ghp_LOKIWITHHELDsentinel\w+INVALID\|absent$/);
  }
  // Positive control: an explicit-env call records the canary, so the checks
  // above can fail on any Bun.
  expect(readFileSync(explicit, "utf8")).toContain(`${CANARY_TOKEN}|${CANARY_SOCK}`);
  // Inheritance-mode detector (not an assertion): a bare call leaking the
  // start env means the BACKLOG 149 bug class exists on this Bun. This probes
  // Bun.spawn/spawnSync only (node:child_process is fixed on Bun >= 1.4); the
  // guard in spawn_env_guard.test.ts must stay, since 1.4.2 still leaks.
  const ctl = readFileSync(control, "utf8");
  console.log(
    ctl.includes(CANARY_TOKEN)
      ? `bun ${Bun.version}: bare spawn inherits START env (bug class present; product assertions are the guard)`
      : `bun ${Bun.version}: bare spawn inherits CURRENT env (start-env bug class not observed on this Bun)`,
  );
});
