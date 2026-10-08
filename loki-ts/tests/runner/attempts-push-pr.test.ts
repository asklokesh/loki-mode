// T5-ATTEMPTS-PR: the --attempts winner reaches a remote ONLY through engine10-push.sh push-pr (_loki_trusted_push).
// Real git, a local bare pinned origin, planted hostile repo config in the winner worktree; no network.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { productionDeps } from "../../src/runner/attempts.ts";

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
    expect(out).toBe(`local://${bare}#loki/run1`);
    expect(sh(bare, ["for-each-ref", "--format=%(refname)"]).stdout.trim()).toBe("refs/heads/loki/run1");
    expect(sh(bare, ["show", "loki/run1:b.txt"]).stdout).toBe("winner\n");
    expect(existsSync(cap)).toBe(false);
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
