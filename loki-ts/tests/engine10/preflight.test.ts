// E-36 Wall (docs/v10/ENGINE.md): first-run preflight, fatal checks plus
// non-fatal UNSIGNED warnings. checkPreflight is the pure, unit-tested core;
// one spawned-child test proves the process-facing preflight() wrapper
// really does process.exit(2) with no .loki/runs dir left behind.
//
// Git-identity isolation: this host has a real global git identity
// configured (see CLAUDE.md), so a bare repo with no LOCAL identity would
// still read one from the global config and falsely pass the "missing
// identity" case. Every repo fixture pins HOME to an empty temp dir and
// blanks GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM so the check is hermetic.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPreflight, PreflightError } from "../../src/engine10/preflight.ts";
import { runSupervisor } from "../../src/engine10/supervisor.ts";

const PREFLIGHT_TS = join(import.meta.dir, "..", "..", "src", "engine10", "preflight.ts");
const MISSING_CLI = "/definitely/not/a/real/loki-preflight-binary-xyz";
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function tmpRoot(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

function bareRepo(): { dir: string; env: Record<string, string> } {
  const dir = tmpRoot("e10-pf-repo-");
  const home = tmpRoot("e10-pf-home-");
  execFileSync("git", ["init", "-q", dir]);
  return { dir, env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } };
}

function identifiedRepo(): { dir: string; env: Record<string, string> } {
  const r = bareRepo();
  execFileSync("git", ["-C", r.dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", r.dir, "config", "user.email", "t@t.test"]);
  return r;
}

function stubCli(): string {
  const dir = tmpRoot("e10-pf-cli-");
  const p = join(dir, "fake-cli");
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

// A PATH with git resolvable but nothing else (gh included), so the gh-check
// tests can simulate "gh missing" without going as far as breaking git too.
function pathWithOnlyGit(): string {
  const dir = tmpRoot("e10-pf-path-");
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  symlinkSync(gitPath, join(dir, "git"));
  return dir;
}

describe("checkPreflight", () => {
  test("not a git work tree is fatal", async () => {
    const dir = tmpRoot("e10-pf-notrepo-");
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { PATH: process.env.PATH ?? "" } });
    expect(r.fatal).toContain("not a git repository");
  });

  test("missing git identity is fatal", async () => {
    const { dir, env } = bareRepo();
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { ...env, LOKI_CLAUDE_CLI: stubCli() } });
    expect(r.fatal).toBe('git identity is not set; run: git config user.name "you" && git config user.email "you@example.com"');
  });

  test("unsupported provider is fatal with the E-37 line, named for the given provider", async () => {
    const { dir, env } = identifiedRepo();
    const r = await checkPreflight({ repoDir: dir, provider: "opencode", pr: false, env });
    expect(r.fatal).toBe("the v10 engine has no opencode invoker yet; use LOKI_ENGINE=legacy loki start --provider opencode");
  });

  test("host guard with a non-claude provider is fatal (would otherwise throw at providers.ts:63)", async () => {
    const { dir, env } = identifiedRepo();
    const r = await checkPreflight({
      repoDir: dir, provider: "codex", pr: false,
      env: { ...env, LOKI_HOST_GUARD: "1", LOKI_CODEX_CLI: stubCli() },
    });
    expect(r.fatal).toContain("LOKI_HOST_GUARD=1 is set but provider 'codex'");
  });

  test("missing provider CLI is fatal", async () => {
    const { dir, env } = identifiedRepo();
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { ...env, LOKI_CLAUDE_CLI: MISSING_CLI } });
    expect(r.fatal).toBe(`provider CLI '${MISSING_CLI}' is not on PATH; install it or set LOKI_CLAUDE_CLI to its path`);
  });

  test("a present provider CLI clears that check", async () => {
    const { dir, env } = identifiedRepo();
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { ...env, LOKI_CLAUDE_CLI: stubCli() } });
    expect(r.fatal).toBeNull();
  });

  test("--no-pr skips the gh check even with gh missing and a non-GitHub origin", async () => {
    const { dir, env } = identifiedRepo();
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "/tmp/e10-local-bare.git"]);
    const r = await checkPreflight({
      repoDir: dir, provider: "claude", pr: false,
      env: { ...env, PATH: pathWithOnlyGit(), LOKI_CLAUDE_CLI: stubCli() },
    });
    expect(r.fatal).toBeNull();
  });

  test("a non-GitHub origin skips the gh check even when a PR is requested", async () => {
    const { dir, env } = identifiedRepo();
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "/tmp/e10-local-bare.git"]);
    const r = await checkPreflight({
      repoDir: dir, provider: "claude", pr: true,
      env: { ...env, PATH: pathWithOnlyGit(), LOKI_CLAUDE_CLI: stubCli() },
    });
    expect(r.fatal).toBeNull();
  });

  test("a GitHub origin with a PR requested and no gh on PATH is fatal, with a --no-pr hint", async () => {
    const { dir, env } = identifiedRepo();
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
    const r = await checkPreflight({
      repoDir: dir, provider: "claude", pr: true,
      env: { ...env, PATH: pathWithOnlyGit(), LOKI_CLAUDE_CLI: stubCli() },
    });
    expect(r.fatal).toBe("gh (GitHub CLI) is missing or not authenticated; run gh auth login, or pass --no-pr");
  });

  test("no UNSIGNED warning: seal.ts signs natively with the auto-generated local key (A-121)", async () => {
    const { dir, env } = identifiedRepo();
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { ...env, LOKI_CLAUDE_CLI: stubCli() } });
    expect(r.fatal).toBeNull();
    expect(r.warnings.some((w) => w.includes("UNSIGNED"))).toBe(false);
  });
});

describe("runSupervisor forwards opts.env to preflight", () => {
  // Regression for the E-37 opencode-refusal REJECT: runSupervisor used to call
  // preflight() with no env field, so checkPreflight fell back to process.env
  // and never saw LOKI_HOST_GUARD/LOKI_*_CLI set only in opts.env (the shape
  // every caller, including providers.test.ts, actually uses).
  test("opts.env distinct from process.env drives the fatal, which rejects in-process instead of exiting", async () => {
    const { dir, env: repoEnv } = identifiedRepo();
    const optsEnv = { ...repoEnv, LOKI_HOST_GUARD: "1", LOKI_CODEX_CLI: stubCli() };
    // This test process's own env has no LOKI_HOST_GUARD: if runSupervisor read process.env
    // instead of opts.env, the host-guard check would never fire. And if preflight still
    // called process.exit, this whole test file would die here instead of reaching expect.
    const err = await runSupervisor({ runId: "e10-pf-sv-guard", repoDir: dir, workerArgv: ["/bin/false"], started: { provider: "codex" }, env: optsEnv })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect((err as Error).message).toContain("LOKI_HOST_GUARD=1 is set but provider 'codex'");
    expect(existsSync(join(dir, ".loki", "runs"))).toBe(false);
  });
});

describe("preflight() wrapper", () => {
  test("exits 2 with the fatal line on stderr and leaves no .loki/runs dir", () => {
    const dir = tmpRoot("e10-pf-wrapper-"); // deliberately not a git repo
    const code = [
      `const { preflight } = await import(${JSON.stringify(PREFLIGHT_TS)});`,
      `await preflight({ repoDir: ${JSON.stringify(dir)}, provider: "claude", pr: false, env: { PATH: process.env.PATH } });`,
      `console.log("UNREACHABLE");`,
    ].join("\n");
    const res = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("not a git repository");
    expect(res.stdout).not.toContain("UNREACHABLE");
    expect(existsSync(join(dir, ".loki", "runs"))).toBe(false);
  });
});
