// T5-ATTEMPTS-PR: the --attempts winner reaches a remote ONLY through engine10-push.sh push-pr (_loki_trusted_push).
// Real git, a local bare pinned origin, planted hostile repo config in the winner worktree; no network.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pinnedOriginUsable, productionDeps, runAttempts } from "../../src/runner/attempts.ts";

let root = "";
const saved = { GH_TOKEN: process.env.GH_TOKEN, PATH: process.env.PATH };
const sh = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loki-attempts-pushpr-"));
  process.env.GH_TOKEN = "tok-secret";
});
afterAll(() => {
  if (saved.GH_TOKEN === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.GH_TOKEN;
  rmSync(root, { recursive: true, force: true });
});

describe("attempts winner push goes through push-pr", () => {
  it("pushes the committed winner branch to the pinned bare origin; planted credential helper and sshCommand see nothing", () => {
    const bare = join(root, "origin.git"), repo = join(root, "repo"), cap = join(root, "captured.txt");
    sh(root, ["init", "-q", "--bare", "-b", "trunk", bare]);
    mkdirSync(repo);
    sh(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "x\n");
    sh(repo, ["add", "a.txt"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
    sh(repo, ["remote", "add", "origin", bare]);
    const hook = join(root, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\nenv >> '${cap}'\ncat >> '${cap}'\nexit 0\n`);
    chmodSync(hook, 0o755);

    const deps = productionDeps(repo, async () => 0, async () => 0, { noPr: false });
    const base = deps.baseSha();
    const wt = join(root, "attempt-1");
    deps.createWorktree(wt, base);
    sh(wt, ["checkout", "-q", "-b", "loki/run1"]);
    writeFileSync(join(wt, "b.txt"), "winner\n"); // uncommitted straggler: must be committed before the push
    sh(wt, ["config", "credential.helper", hook]);
    sh(wt, ["config", "core.sshCommand", hook]);

    const out = deps.openPr!(wt, base);
    const pushed = out.replace(`local://${bare}#`, "");
    expect(out.startsWith(`local://${bare}#loki-attempts/`)).toBe(true);
    expect(sh(bare, ["for-each-ref", "--format=%(refname)"]).stdout.trim()).toBe(`refs/heads/${pushed}`);
    expect(sh(bare, ["show", `${pushed}:b.txt`]).stdout).toBe("winner\n");
    expect(existsSync(cap)).toBe(false);
  });
});

describe("hostile winner HEAD and missing identity", () => {
  const mk = (name: string) => {
    const bare = join(root, `${name}.git`), repo = join(root, name);
    sh(root, ["init", "-q", "--bare", "-b", "trunk", bare]);
    mkdirSync(repo);
    sh(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "x\n");
    sh(repo, ["add", "a.txt"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
    sh(repo, ["remote", "add", "origin", bare]);
    sh(repo, ["push", "-q", "origin", "main:release"]);
    return { bare, repo };
  };
  it("a winner whose HEAD is named after an existing origin branch cannot move it", () => {
    const { bare, repo } = mk("hostile");
    const before = sh(bare, ["rev-parse", "release"]).stdout.trim();
    const deps = productionDeps(repo, async () => 0, async () => 0, { noPr: false });
    const wt = join(root, "attempt-h");
    deps.createWorktree(wt, deps.baseSha());
    sh(wt, ["checkout", "-q", "-B", "release"]);
    writeFileSync(join(wt, "evil.txt"), "pwn\n");
    sh(wt, ["add", "evil.txt"]);
    sh(wt, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "evil"]);
    deps.openPr!(wt, "main");
    expect(sh(bare, ["rev-parse", "release"]).stdout.trim()).toBe(before);
  });
  it("commits stragglers with the fallback identity when git has none", () => {
    const { bare, repo } = mk("noident");
    const deps = productionDeps(repo, async () => 0, async () => 0, { noPr: false });
    const wt = join(root, "attempt-n");
    deps.createWorktree(wt, deps.baseSha());
    writeFileSync(join(wt, "c.txt"), "c\n");
    const keep = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^GIT_(AUTHOR|COMMITTER)_|^EMAIL$/.test(k)) delete process.env[k];
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const out = deps.openPr!(wt, "main");
      expect(sh(bare, ["show", `${out.replace(`local://${bare}#`, "")}:c.txt`]).stdout).toBe("c\n");
    } finally {
      for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) delete process.env[k];
      Object.assign(process.env, keep);
    }
  });
});

describe("partial identity and pin preflight", () => {
  it("commits stragglers when user.email is set but user.name is not", () => {
    const bare = join(root, "halfid.git"), repo = join(root, "halfid");
    sh(root, ["init", "-q", "--bare", "-b", "trunk", bare]);
    mkdirSync(repo);
    sh(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "x\n");
    sh(repo, ["add", "a.txt"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
    sh(repo, ["remote", "add", "origin", bare]);
    const deps = productionDeps(repo, async () => 0, async () => 0, { noPr: false });
    const wt = join(root, "attempt-hn");
    deps.createWorktree(wt, deps.baseSha());
    sh(wt, ["config", "user.email", "only@email"]);
    sh(wt, ["config", "user.useConfigOnly", "true"]); // no gecos-derived name, as on a bare CI box
    writeFileSync(join(wt, "d.txt"), "d\n");
    const keep = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^GIT_(AUTHOR|COMMITTER)_|^EMAIL$/.test(k)) delete process.env[k];
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const out = deps.openPr!(wt, "main");
      expect(sh(bare, ["show", `${out.replace(`local://${bare}#`, "")}:d.txt`]).stdout).toBe("d\n");
    } finally {
      for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) delete process.env[k];
      Object.assign(process.env, keep);
    }
  });

  it("an unusable pinned origin fails before attempt 1 runs", async () => {
    const repo = join(root, "badpin"), plain = join(root, "badpin-nonbare");
    mkdirSync(plain);
    sh(plain, ["init", "-q"]);
    mkdirSync(repo);
    sh(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "x\n");
    sh(repo, ["add", "a.txt"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
    sh(repo, ["remote", "add", "origin", plain]);
    let ran = 0;
    const lines: string[] = [];
    const deps = productionDeps(repo, async () => 0, async () => { ran++; return 0; }, { noPr: false });
    const rc = await runAttempts(2, { ...deps, print: (l: string) => void lines.push(l) });
    expect(rc).toBe(1);
    expect(ran).toBe(0);
    expect(lines.join("\n")).toMatch(/pinned origin/);
    expect(sh(repo, ["worktree", "list"]).stdout.trim().split("\n").length).toBe(1);
  });
});

describe("preflight parity with push-pr", () => {
  it("accepts and refuses the same origins push-pr does", () => {
    const real = join(root, "par-real.git");
    sh(root, ["init", "-q", "--bare", real]);
    symlinkSync(root, join(root, "par-link"));
    mkdirSync(join(root, "par-dir"), { recursive: true });
    const nonbare = join(root, "par-nonbare");
    mkdirSync(nonbare);
    sh(nonbare, ["init", "-q"]);
    const accept = [real, `${real}/`, join(root, "par-link", "par-real.git"), join(root, "par-dir", "..", "par-real.git"), realpathSync(real),
      "https://github.com/o/r.git", "https://github.com/o/r", "git@github.com:o/r", "ssh://git@github.com/o/r/", "https://github.com/o/r/", "HTTPS://GitHub.com/o/r.git"];
    const refuse = ["", nonbare, "relative/path.git", "https://github.com/o/r#x", "https://github.com/o/.r", "https://github.com/o/r..x", "https://github.com/o/r%41", "https://example.com/o/r.git", "/nonexistent/x.git"];
    for (const o of accept) expect([o, pinnedOriginUsable(o)]).toEqual([o, true]);
    for (const o of refuse) expect([o, pinnedOriginUsable(o)]).toEqual([o, false]);
  });
});

describe("no direct credentialed push from attempts code", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/runner/attempts.ts"), "utf8");
  it("attempts.ts never runs git push, gh pr create or allowToken", () => {
    expect(src).not.toMatch(/["']push["']/);
    expect(src).not.toMatch(/["']pr["'],\s*["']create["']/);
    expect(src).not.toMatch(/allowToken\s*[:=,)]\s*true|allowToken = true/);
    expect(src).toContain("engine10-push.sh");
  });
});
