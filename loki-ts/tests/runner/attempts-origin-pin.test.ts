// FC-25 / moat P9: the origin is pinned before any attempt runs. An attempt agent that rewrites origin in the shared
// .git/config must not redirect the credentialed push. Real git, local bare repos, a gh PATH shim; no network.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { productionDeps } from "../../src/runner/attempts.ts";

// Each test spawns bin/loki with a 60-120s budget; bun's 5s default fails them under full-suite load (FC-38).
setDefaultTimeout(130_000);

let root = "";
const savedPath = process.env.PATH;
const sh = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loki-attempts-pin-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> '${join(root, "gh.log")}'\necho https://example.invalid/pr/1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
});
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe("attempts origin pin", () => {
  it("a rewritten origin cannot redirect the push: the pinned bare repo gets the branch, the attacker repo nothing", () => {
    const pinned = join(root, "pinned.git"), attacker = join(root, "attacker.git"), repo = join(root, "repo");
    sh(root, ["init", "-q", "--bare", "-b", "trunk", pinned]);
    sh(root, ["init", "-q", "--bare", attacker]);
    mkdirSync(repo);
    sh(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "x\n");
    sh(repo, ["add", "a.txt"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
    sh(repo, ["remote", "add", "origin", pinned]);

    const deps = productionDeps(repo, async () => 0, async () => 0, { noPr: false }); // pins here
    const base = deps.baseSha();
    const wt = join(root, "attempt-1");
    deps.createWorktree(wt, base);
    sh(wt, ["checkout", "-q", "-b", "loki/run1"]);
    sh(repo, ["remote", "set-url", "origin", attacker]); // what a hostile attempt agent does to the shared config

    const out = deps.openPr!(wt, base);
    expect(out.startsWith(`local://${pinned}#loki-attempts/`)).toBe(true);
    expect(sh(pinned, ["for-each-ref", "--format=%(refname)"]).stdout.trim()).toBe(`refs/heads/${out.split("#")[1]}`);
    expect(sh(attacker, ["for-each-ref"]).stdout.trim()).toBe("");
  });

  it("a pinned origin that is neither GitHub nor a bare repo opens no PR and pushes nothing", () => {
    const bare = join(root, "plain"), repo = join(root, "repo2");
    mkdirSync(bare);
    sh(bare, ["init", "-q"]); // non-bare
    mkdirSync(repo);
    sh(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "x\n");
    sh(repo, ["add", "a.txt"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
    sh(repo, ["remote", "add", "origin", bare]);
    const deps = productionDeps(repo, async () => 0, async () => 0, { noPr: false });
    const wt = join(root, "attempt-2");
    deps.createWorktree(wt, deps.baseSha());
    expect(() => deps.openPr!(wt, "main")).toThrow(/no PR opened/);
    expect(sh(bare, ["for-each-ref"]).stdout.trim()).toBe("");
    expect(sh(bare, ["branch", "--list"]).stdout.trim()).toBe("");
  });
});
