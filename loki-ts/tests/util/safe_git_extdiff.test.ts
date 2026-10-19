// SAFEGIT-EXTDIFF: safeGit blanks diff.external, which made every patch-producing call die with "external diff died".
// The fix injects --no-ext-diff/--no-textconv centrally; a user-configured external diff must still never run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeGit, safeGitArgs, reviewerGitEnv } from "../../src/util/safe_git.ts";

let root: string, repo: string, hit: string;
const g = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "safegit-extdiff-"));
  repo = join(root, "repo"); hit = join(root, "hit.txt"); mkdirSync(repo);
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n"); g("add", "a.txt"); g("commit", "-qm", "init");
  writeFileSync(join(repo, "a.txt"), "two\n"); g("commit", "-qam", "second");
  writeFileSync(join(repo, "a.txt"), "three\n");
  const marker = join(root, "ext.sh");
  writeFileSync(marker, `#!/bin/sh\necho fired >> "${hit}"\nexit 0\n`); chmodSync(marker, 0o755);
  g("config", "diff.external", marker);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test("control: the configured external diff fires on a plain git diff", () => {
  rmSync(hit, { force: true }); g("diff"); expect(existsSync(hit)).toBe(true); rmSync(hit, { force: true });
});
test("safeGit diff, show -p and log -p return a real patch and never run the external diff", () => {
  rmSync(hit, { force: true });
  expect(safeGit(repo, ["diff"])).toContain("+three");
  expect(safeGit(repo, ["diff", "HEAD~1", "HEAD"])).toContain("+two");
  expect(safeGit(repo, ["show", "-p", "HEAD"])).toContain("+two");
  expect(safeGit(repo, ["log", "-p", "-1"])).toContain("+two");
  expect(existsSync(hit)).toBe(false);
});
test("a caller-supplied --ext-diff cannot re-enable it", () => {
  rmSync(hit, { force: true });
  expect(safeGit(repo, ["diff", "--ext-diff"])).toContain("+three");
  expect(existsSync(hit)).toBe(false);
});
test("a GIT_EXTERNAL_DIFF in the caller env never runs", () => {
  rmSync(hit, { force: true });
  expect(safeGit(repo, ["diff"], { env: { ...process.env, GIT_EXTERNAL_DIFF: join(root, "ext.sh") } })).toContain("+three");
  expect(existsSync(hit)).toBe(false);
});

describe("FC-25 safe git extdiff", () => {
  // FC-41/132-B1: patch-producing git through safeGit returns patches (no "external diff died") while a repo-chosen
  // diff.external or gitattributes diff driver still never runs.

  let root: string, repo: string, extHit: string, drvHit: string;
  const g = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const script = (hit: string, name: string): string => {
    const p = join(root, name); writeFileSync(p, `#!/bin/sh\necho fired >> "${hit}"\nexit 0\n`); chmodSync(p, 0o755); return p;
  };
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fc25-extdiff-"));
    repo = join(root, "repo"); extHit = join(root, "ext-hit.txt"); drvHit = join(root, "drv-hit.txt");
    mkdirSync(repo);
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\n"); writeFileSync(join(repo, "b.bin"), "x\n");
    writeFileSync(join(repo, ".gitattributes"), "b.bin diff=evil\n");
    g("add", "."); g("commit", "-qm", "init");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); g("commit", "-qam", "second");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n"); writeFileSync(join(repo, "b.bin"), "y\n");
    g("config", "diff.external", script(extHit, "ext.sh"));
    g("config", "diff.evil.command", script(drvHit, "drv.sh"));
    g("config", "diff.evil.textconv", script(drvHit, "tc.sh"));
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("diff returns the patch", () => {
    const out = safeGit(repo, ["diff"]);
    expect(out).toContain("+three");
    expect(out).not.toContain("external diff died");
  });
  test("log -p and show return patches", () => {
    expect(safeGit(repo, ["log", "-p", "-1", "HEAD"])).toContain("+two");
    expect(safeGit(repo, ["show", "HEAD"])).toContain("+two");
  });
  test("an explicit --no-ext-diff is not duplicated", () => {
    const argv = safeGitArgs(["diff", "--no-ext-diff"]);
    expect(argv.filter((a) => a === "--no-ext-diff").length).toBe(1);
  });
  test("--ext-diff and --textconv from a caller are dropped", () => {
    const argv = safeGitArgs(["diff", "--ext-diff", "--textconv"]);
    expect(argv).not.toContain("--ext-diff");
    expect(argv).not.toContain("--textconv");
  });
  test("diff --stat and --name-only output is unchanged", () => {
    expect(safeGit(repo, ["diff", "--name-only"]).split("\n").filter(Boolean).sort()).toEqual(["a.txt", "b.bin"]);
    expect(safeGit(repo, ["diff", "--stat"])).toContain("a.txt");
    expect(safeGit(repo, ["diff", "--stat"])).toBe(g("diff", "--no-ext-diff", "--no-textconv", "--stat"));
  });
  test("repo-config diff.external and gitattributes diff driver canaries never run", () => {
    safeGit(repo, ["diff"]); safeGit(repo, ["log", "-p", "-2"]); safeGit(repo, ["show", "HEAD"]);
    expect(existsSync(extHit)).toBe(false);
    expect(existsSync(drvHit)).toBe(false);
  });
});

// FC-REVIEWER-GIT-CONFIG-EXEC: a reviewer child whose Bash allowlist has git status/diff/show/log builds its own argv, so the
// hardening is in the ENV it is spawned with (reviewerGitEnv, the builder voter_agents and quality_gates use).
describe("FC-REVIEWER-GIT-CONFIG-EXEC reviewerGitEnv", () => {
  let rroot: string, rrepo: string, fired: string;
  const rg = (env: NodeJS.ProcessEnv, ...a: string[]): string => execFileSync("git", a, { cwd: rrepo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const base = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" });
  const script = (name: string): string => {
    const p = join(rroot, name);
    writeFileSync(p, `#!/bin/sh\necho "${name}" >> "${fired}"\nexit 0\n`); chmodSync(p, 0o755);
    return p;
  };
  beforeAll(() => {
    rroot = mkdtempSync(join(tmpdir(), "reviewer-git-env-"));
    rrepo = join(rroot, "repo"); fired = join(rroot, "fired.txt"); mkdirSync(rrepo);
    const e = base();
    rg(e, "init", "-q"); rg(e, "config", "user.email", "t@t"); rg(e, "config", "user.name", "t");
    writeFileSync(join(rrepo, "a.txt"), "one\n"); writeFileSync(join(rrepo, "b.dat"), "x\n");
    rg(e, "add", "a.txt", "b.dat"); rg(e, "commit", "-qm", "init");
    writeFileSync(join(rrepo, "a.txt"), "two\n"); rg(e, "commit", "-qam", "second");
    writeFileSync(join(rrepo, "a.txt"), "three\n"); writeFileSync(join(rrepo, "b.dat"), "y\n");
    rg(e, "config", "core.fsmonitor", script("fsmonitor"));
    rg(e, "config", "diff.external", script("external"));
    rg(e, "config", "diff.evil.command", script("drvcommand"));
    rg(e, "config", "diff.evil.textconv", script("textconv"));
    rg(e, "config", "filter.evil.clean", script("clean"));
    writeFileSync(join(rrepo, ".git", "info", "attributes"), "b.dat diff=evil filter=evil\n");
  });
  afterAll(() => { rmSync(rroot, { recursive: true, force: true }); });
  const run = (env: NodeJS.ProcessEnv): string[] => {
    rmSync(fired, { force: true });
    return [rg(env, "status"), rg(env, "diff"), rg(env, "diff", "HEAD~1", "HEAD"), rg(env, "show", "-p", "HEAD"), rg(env, "log", "-p", "-1")];
  };

  test("control: plain git runs the repo-configured programs (fsmonitor, external diff, driver command)", () => {
    try { run(base()); } catch { /* a program may break the output; only the marker matters */ }
    const ran = existsSync(fired) ? readFileSync(fired, "utf8") : "";
    for (const k of ["fsmonitor", "external", "drvcommand"]) expect(ran).toContain(k);
  });
  test("with reviewerGitEnv none of them run and git diff still returns a real patch", () => {
    const out = run(reviewerGitEnv(rrepo, base()));
    expect(existsSync(fired)).toBe(false);
    expect(out[1]).toContain("+three");
    expect(out[2]).toContain("+two");
    expect(out[3]).toContain("+two");
    expect(out[4]).toContain("+two");
  });
  test("the builder keeps a caller GIT_CONFIG_COUNT entry, drops GIT_ATTR_SOURCE and never mutates its input", () => {
    const b = { ...base(), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "keep", GIT_ATTR_SOURCE: "HEAD" };
    const snap = JSON.stringify(b);
    const e = reviewerGitEnv(rrepo, b);
    expect(JSON.stringify(b)).toBe(snap);
    expect(e.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(e.GIT_ATTR_SOURCE).toBeUndefined();
    expect(e.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(rg(e, "config", "user.name")).toContain("keep");
  });
  test("a directory that is not a repository still gets the static hardening and does not throw", () => {
    expect(reviewerGitEnv(rroot, base()).GIT_CONFIG_COUNT).toBeDefined();
  });
  test("every reviewer spawn that can receive the shared allowlist uses the builder", () => {
    for (const f of ["../../src/council/voter_agents.ts", "../../src/runner/quality_gates.ts"]) {
      expect(readFileSync(join(import.meta.dir, f), "utf8")).toContain("reviewerGitEnv()");
    }
  });
});
