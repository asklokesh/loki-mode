// FC-25 regression fixture (moat P9 [planted], 2026-10-08): the engine10 supervisor holds the real GH_TOKEN and
// SSH_AUTH_SOCK, and the cost preview (runner/router/cost_preview.ts estimateFor -> history.ts shapeKeyForRepo ->
// project_model/gather.ts shallowDirs / isGitTracked) ran `git ls-files` with env: process.env inside the agent's
// repo. A core.fsmonitor plant there ran 4 times holding the token. preflight.ts and xreview.ts passed
// safeGitEnv() to util/shell.ts run(), which merges it OVER process.env, so the token survived there too.
//
// The driver runs in a child bun whose START env carries canaries and never withholds them (supervisor shape).
// An explicit-env control proves the plant records env values, so the product assertions can fail.
import { afterEach, beforeEach, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

setDefaultTimeout(60_000);

const SRC = resolve(import.meta.dir, "../../src");
const CANARY_TOKEN = "ghp_FC25SUPERVISORcanary000000000000";
const CANARY_SOCK = "/tmp/loki-fc25-canary-agent.sock";

let root: string;
beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "loki-fc25-sup-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it("supervisor-side git calls never run a planted core.fsmonitor holding the token", () => {
  const repo = resolve(root, "repo");
  const rec = resolve(root, "fsmon.rec");
  const control = resolve(root, "control.rec");
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, env: { ...process.env }, stdio: "ignore" });
  execFileSync("git", ["init", "-q", repo], { env: { ...process.env }, stdio: "ignore" });
  mkdirSync(resolve(repo, "src"));
  writeFileSync(resolve(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(resolve(repo, "package.json"), "{}\n");
  g("add", ".");
  g("-c", "user.email=x@example.invalid", "-c", "user.name=x", "commit", "-q", "-m", "i");
  const mkHook = (path: string, out: string) => {
    writeFileSync(path, `#!/bin/sh\nprintf '%s|%s\\n' "\${GH_TOKEN:-absent}" "\${SSH_AUTH_SOCK:-absent}" >> '${out}'\nexit 1\n`);
    chmodSync(path, 0o755);
  };
  const hook = resolve(root, "fsmon.sh");
  const controlHook = resolve(root, "fsmon-control.sh");
  mkHook(hook, rec);
  mkHook(controlHook, control);
  g("config", "core.fsmonitor", hook);

  const driver = resolve(root, "driver.ts");
  const imp = (p: string) => JSON.stringify(resolve(SRC, p));
  writeFileSync(
    driver,
    `import { execFileSync } from "node:child_process";
import { shallowDirs, isGitTracked, gather } from ${imp("project_model/gather.ts")};
import { shapeKeyForRepo } from ${imp("runner/router/history.ts")};
import { estimateFor } from ${imp("runner/router/cost_preview.ts")};
import { safeGit, safeGitSpawn, safeGitRun } from ${imp("util/safe_git.ts")};
const repo = ${JSON.stringify(repo)};
shallowDirs(repo);
isGitTracked(repo, "src/a.ts");
isGitTracked(repo, ".loki/project-model.json");
gather(repo);
shapeKeyForRepo(repo);
estimateFor(repo, ${JSON.stringify(resolve(root, "cache"))});
safeGit(repo, ["status", "--porcelain"]);
safeGitSpawn(repo, ["status", "--porcelain"], { encoding: "utf8" });
// An explicit env carrying the token is still stripped (the run()+safeGitEnv merge bug).
await safeGitRun(repo, ["status", "--porcelain"], { env: { ...process.env } });
// Positive control: a raw call with an explicit env records the canary on any Bun.
try { execFileSync("git", ["-c", "core.fsmonitor=" + ${JSON.stringify(controlHook)}, "status", "--porcelain"], { cwd: repo, stdio: "ignore", env: { ...process.env } }); } catch {}
`,
  );

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env["GH_TOKEN"] = CANARY_TOKEN;
  env["SSH_AUTH_SOCK"] = CANARY_SOCK;
  delete env["LOKI_ALLOW_AGENT_GITHUB_TOKEN"];
  const r = spawnSync(process.execPath, [driver], { cwd: repo, env, encoding: "utf8" });
  expect(r.stderr).not.toContain("error:");
  expect(r.status).toBe(0);

  expect(readFileSync(control, "utf8")).toContain(`${CANARY_TOKEN}|${CANARY_SOCK}`);
  const seen = existsSync(rec) ? readFileSync(rec, "utf8") : "";
  expect(seen).not.toContain(CANARY_TOKEN);
  expect(seen).not.toContain(CANARY_SOCK);
});

it("safeGit diff works and never runs a repo diff.external; repoDrivers keeps a repo clean filter for add", async () => {
  const { safeGit, safeGitRun } = await import("../../src/util/safe_git.ts");
  const repo = resolve(root, "repo2");
  const mark = resolve(root, "extdiff.mark");
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, env: { ...process.env }, stdio: "ignore" });
  execFileSync("git", ["init", "-q", repo], { env: { ...process.env }, stdio: "ignore" });
  writeFileSync(resolve(repo, "a.txt"), "one\n");
  g("add", "a.txt");
  g("-c", "user.email=x@example.invalid", "-c", "user.name=x", "commit", "-q", "-m", "i");
  const ext = resolve(root, "ext.sh");
  writeFileSync(ext, `#!/bin/sh\ntouch '${mark}'\n`);
  chmodSync(ext, 0o755);
  g("config", "diff.external", ext);
  writeFileSync(resolve(repo, "a.txt"), "two\n");
  // An empty diff.external alone makes porcelain diff die; safeGit adds --no-ext-diff after the subcommand.
  expect(safeGit(repo, ["diff"])).toContain("+two");
  expect(safeGit(repo, ["-c", "core.quotePath=false", "diff", "--stat"])).toContain("a.txt");
  expect(existsSync(mark)).toBe(false);

  writeFileSync(resolve(repo, ".gitattributes"), "b.txt filter=up\n");
  g("config", "filter.up.clean", "tr a-z A-Z");
  writeFileSync(resolve(repo, "b.txt"), "low\n");
  expect((await safeGitRun(repo, ["add", "b.txt"], { repoDrivers: true })).exitCode).toBe(0);
  expect(safeGit(repo, ["show", ":b.txt"])).toBe("LOW\n");
});

it("diff.<drv>.command is blanked with textconv, and --config-env/--attr-source values are not read as the subcommand", async () => {
  const { safeGitArgs } = await import("../../src/util/safe_git.ts");
  const repo = resolve(root, "repo3");
  execFileSync("git", ["init", "-q", repo], { env: { ...process.env }, stdio: "ignore" });
  execFileSync("git", ["config", "diff.evil.command", "/bin/false"], { cwd: repo, env: { ...process.env }, stdio: "ignore" });
  const argv = safeGitArgs(["status"], false, repo);
  expect(argv.join(" ")).toContain("-c diff.evil.command=");
  for (const pre of [["--config-env", "core.pager=PAGER"], ["--attr-source", "HEAD"]]) {
    const a = safeGitArgs([...pre, "diff", "HEAD"]);
    expect(a.slice(a.indexOf("diff") + 1, a.indexOf("diff") + 3)).toEqual(["--no-ext-diff", "--no-textconv"]);
  }
});
