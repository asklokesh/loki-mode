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
      expect(readFileSync(join(import.meta.dir, f), "utf8")).toContain("reviewerGitEnv(process.cwd(), tokenFreeEnv(process.env))");
    }
  });
});

// Round 2 (HIGH review): gpg programs, partial-clone lazy fetch over core.sshCommand, an option-shaped file name, textconv that must not die.
describe("FC-REVIEWER-GIT-CONFIG-EXEC round 2", () => {
  let root2: string, repo2: string, hit2: string;
  const base = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" });
  const g2 = (env: NodeJS.ProcessEnv, input: string | undefined, ...a: string[]): string => execFileSync("git", a, { cwd: repo2, encoding: "utf8", env, input, stdio: ["pipe", "pipe", "pipe"] });
  const mark = (name: string): string => {
    const p = join(root2, name);
    writeFileSync(p, `#!/bin/sh\necho "${name}" >> "${hit2}"\nexit 1\n`); chmodSync(p, 0o755);
    return p;
  };
  const fired = (): string => (existsSync(hit2) ? readFileSync(hit2, "utf8") : "");
  const safe = (): NodeJS.ProcessEnv => reviewerGitEnv(repo2, base());
  const tryRun = (env: NodeJS.ProcessEnv, ...a: string[]): void => { try { g2(env, undefined, ...a); } catch { /* only the marker matters */ } };
  beforeAll(() => {
    root2 = mkdtempSync(join(tmpdir(), "reviewer-git-env2-"));
    repo2 = join(root2, "repo"); hit2 = join(root2, "hit.txt"); mkdirSync(repo2);
    const e = base();
    g2(e, undefined, "init", "-q"); g2(e, undefined, "config", "user.email", "t@t"); g2(e, undefined, "config", "user.name", "t");
    writeFileSync(join(repo2, "a.txt"), "one\n"); writeFileSync(join(repo2, "-n"), "dash\n"); writeFileSync(join(repo2, "s.crypt"), "c1\n");
    g2(e, undefined, "add", "--", "a.txt", "-n", "s.crypt"); g2(e, undefined, "commit", "-qm", "init");
    // a commit carrying a gpgsig header, so log.showSignature / --show-signature / show invoke the verifier
    const tree = g2(e, undefined, "rev-parse", "HEAD^{tree}").trim(), parent = g2(e, undefined, "rev-parse", "HEAD").trim();
    const signed = `tree ${tree}\nparent ${parent}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`;
    const oid = g2(e, signed, "hash-object", "-t", "commit", "-w", "--stdin").trim();
    g2(e, undefined, "update-ref", "HEAD", oid);
    g2(e, undefined, "config", "gpg.program", mark("gpg")); g2(e, undefined, "config", "log.showSignature", "true");
    g2(e, undefined, "config", "gpg.ssh.program", mark("gpgssh")); g2(e, undefined, "config", "gpg.x509.program", mark("gpgx509"));
    // partial clone: a tree naming a blob that is not in the object store, origin is a promisor over ssh
    g2(e, undefined, "config", "core.repositoryformatversion", "1"); g2(e, undefined, "config", "extensions.partialClone", "origin");
    g2(e, undefined, "config", "remote.origin.promisor", "true"); g2(e, undefined, "config", "remote.origin.url", "ssh://nohost.invalid/x.git");
    g2(e, undefined, "config", "core.sshCommand", mark("sshcmd"));
    const mt = g2(e, "100644 blob 0123456789012345678901234567890123456789\tmissing.txt\n", "mktree", "--missing").trim();
    const c = g2(e, "lazy\n", "commit-tree", mt).trim();
    g2(e, undefined, "update-ref", "refs/heads/lazy", c);
  });
  afterAll(() => { rmSync(root2, { recursive: true, force: true }); });

  test("gpg: plain git fires gpg.program on log, log --show-signature and show; reviewerGitEnv fires none (openpgp, ssh, x509)", () => {
    rmSync(hit2, { force: true });
    tryRun(base(), "log", "-1"); tryRun(base(), "log", "--show-signature", "-1"); tryRun(base(), "show", "--show-signature", "HEAD");
    expect(fired()).toContain("gpg");
    rmSync(hit2, { force: true });
    for (const env of [safe()]) { tryRun(env, "log", "-1"); tryRun(env, "log", "--show-signature", "-1"); tryRun(env, "show", "--show-signature", "HEAD"); tryRun(env, "show", "HEAD"); }
    expect(fired()).toBe("");
  });
  test("lazy fetch: a missing promisor object fires core.sshCommand in plain git and not under reviewerGitEnv", () => {
    rmSync(hit2, { force: true });
    tryRun(base(), "show", "lazy:missing.txt"); tryRun(base(), "show", "refs/heads/lazy"); tryRun(base(), "diff", "HEAD", "refs/heads/lazy");
    // LOKI_TEST_FORCE_LAZY_CONTROL_MISS=1 simulates a git that never lazy-fetches, to prove the guard below bites.
    const controlFired = process.env["LOKI_TEST_FORCE_LAZY_CONTROL_MISS"] === "1" ? false : fired().includes("sshcmd");
    rmSync(hit2, { force: true });
    const env = safe();
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    if (!controlFired) {
      // The positive control is the precondition: if this git never lazy-fetches over core.sshCommand here (the CI runner's
      // git 2.56.0 did not), the not-fired check below proves nothing. CI says so and moves on; a dev machine fails loudly.
      if (!process.env["GITHUB_ACTIONS"]) throw new Error("lazy-fetch control did not fire: plain git did not run core.sshCommand for a missing promisor object, so the reviewerGitEnv check would prove nothing");
      console.warn(`SKIP lazy-fetch fire check: plain git ${execFileSync("git", ["--version"], { encoding: "utf8" }).trim()} did not run core.sshCommand for a missing promisor object, so reviewerGitEnv cannot be compared against it`);
      return;
    }
    tryRun(env, "show", "lazy:missing.txt"); tryRun(env, "show", "refs/heads/lazy"); tryRun(env, "diff", "HEAD", "refs/heads/lazy"); tryRun(env, "log", "-p", "lazy");
    expect(fired()).toBe("");
  });
  test("a tracked file named -n is a path to the diff shim, not an option (review is not blinded)", () => {
    writeFileSync(join(repo2, "-n"), "dash\nchanged\n");
    const out = g2(safe(), undefined, "diff");
    expect(out).toContain("+changed");
  });
  test("a repo textconv driver (git-crypt style) is replaced by cat: log -p still succeeds and the repo program never runs", () => {
    const e = base();
    g2(e, undefined, "checkout", "-q", "-B", "main2", "HEAD");
    g2(e, undefined, "config", "diff.crypt.textconv", mark("textconv"));
    writeFileSync(join(repo2, ".gitattributes"), "*.crypt diff=crypt\n");
    writeFileSync(join(repo2, "s.crypt"), "c1\nc2\n");
    g2(e, undefined, "add", ".gitattributes", "s.crypt"); g2(e, undefined, "commit", "-qm", "crypt");
    rmSync(hit2, { force: true });
    const out = g2(safe(), undefined, "log", "-p", "-1");
    expect(out).toContain("+c2");
    expect(fired()).toBe("");
  });
  test("fail closed: a repo-local remote uploadpack (first value wins, env cannot beat it) makes the builder throw", () => {
    const e = base();
    g2(e, undefined, "config", "remote.origin.uploadpack", mark("uploadpack"));
    try { expect(() => reviewerGitEnv(repo2, base())).toThrow(/uploadpack/); } finally { g2(e, undefined, "config", "--unset", "remote.origin.uploadpack"); }
    expect(() => reviewerGitEnv(repo2, base())).not.toThrow();
  });
  test("fail closed: a partial clone on git older than 2.44 (GIT_NO_LAZY_FETCH ignored) makes the builder throw; 2.44 and newer is accepted", () => {
    expect(() => reviewerGitEnv(repo2, base(), "git version 2.39.2")).toThrow(/2\.44/);
    expect(() => reviewerGitEnv(repo2, base(), "git version 2.34.1")).toThrow(/2\.44/);
    expect(() => reviewerGitEnv(repo2, base(), "git version 2.44.0")).not.toThrow();
    expect(() => reviewerGitEnv(repo2, base(), "git version 2.55.0")).not.toThrow();
  });
});
