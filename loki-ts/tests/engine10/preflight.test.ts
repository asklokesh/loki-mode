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
import { providerProbeEnv, requirementFix } from "../../src/commands/doctor.ts";
import { withholdGithubTokens } from "../../src/runner/github_token.ts";
import { GITHUB_TOKEN_VARS, SENTINEL_PREFIX } from "../../src/util/credential_env.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPreflight, checkPreflight, PreflightError } from "../../src/engine10/preflight.ts";
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

function bareRepo(commit = true): { dir: string; env: Record<string, string> } {
  const dir = tmpRoot("e10-pf-repo-");
  const home = tmpRoot("e10-pf-home-");
  execFileSync("git", ["init", "-q", dir]);
  if (commit) execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-q", "--allow-empty", "-m", "init"]); // no repo-level identity is left behind
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
    const dir = tmpRoot("e10-pf-notrepo-"); writeFileSync(join(dir, "f.txt"), "x");
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { PATH: process.env.PATH ?? "" } });
    expect(r.fatal).toContain("not a git repository");
  });

  test("TEN-STABILITY-35: a repo with no commits is fatal and names the fix", async () => {
    const { dir, env } = bareRepo(false);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]); execFileSync("git", ["-C", dir, "config", "user.email", "t@t.test"]);
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { ...env, LOKI_CLAUDE_CLI: stubCli() } });
    expect(r.fatal).toBe("repository has no commits; run: git add . && git commit -m init");
  });

  test("TEN-STABILITY-35: the no-commits fatal comes through the real preflight() entry", () => {
    const { dir, env } = bareRepo(false);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]); execFileSync("git", ["-C", dir, "config", "user.email", "t@t.test"]);
    const code = `const { preflight } = await import(${JSON.stringify(PREFLIGHT_TS)}); await preflight({ repoDir: ${JSON.stringify(dir)}, provider: "claude", pr: false, env: ${JSON.stringify({ ...env, LOKI_CLAUDE_CLI: stubCli() })} });`;
    const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 60000 });
    expect(r.status).toBe(2); expect(r.stderr).toContain("repository has no commits; run: git add . && git commit -m init");
  });

  test("missing git identity is fatal", async () => {
    const { dir, env } = bareRepo();
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { ...env, LOKI_CLAUDE_CLI: stubCli() } });
    expect(r.fatal).toBe('git identity is not set; run: git config user.name "you" && git config user.email "you@example.com"');
  });

  test("unsupported provider is fatal with the E-37 line, named for the given provider", async () => {
    const { dir, env } = identifiedRepo();
    const r = await checkPreflight({ repoDir: dir, provider: "bogus", pr: false, env });
    expect(r.fatal).toBe("the v10 engine has no bogus invoker yet");
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
    expect(r.fatal).toBe(`provider CLI '${MISSING_CLI}' is not on PATH; install it or set LOKI_CLAUDE_CLI to its path. Fix: ${requirementFix("claude")}`);
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
    const dir = tmpRoot("e10-pf-wrapper-"); writeFileSync(join(dir, "f.txt"), "x"); // non-empty so never auto-initialised; deliberately not a git repo
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

describe("first run (TEN-UX-01)", () => {
  function emptyFolder(): { dir: string; env: Record<string, string> } {
    const dir = tmpRoot("e10-pf-empty-");
    const home = tmpRoot("e10-pf-home-");
    const gc = join(home, "gitconfig");
    writeFileSync(gc, "[user]\n\tname = t\n\temail = t@t.test\n");
    return { dir, env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: gc, GIT_CONFIG_SYSTEM: "/dev/null" } };
  }
  function fakeClaude(out: string, exit = 0): { cli: string; marker: string } {
    const d = tmpRoot("e10-pf-claude-");
    const marker = join(d, "called");
    const cli = join(d, "claude");
    writeFileSync(cli, `#!/bin/sh\ntouch '${marker}'\n${out ? `echo '${out}'\n` : ""}exit ${exit}\n`);
    chmodSync(cli, 0o755);
    return { cli, marker };
  }
  const opts = (dir: string, env: Record<string, string>) => ({ repoDir: dir, provider: "claude", pr: false, env });

  test("empty folder, no repo: initialised with a commit and one notice", async () => {
    const { dir, env } = emptyFolder();
    const r = await checkPreflight(opts(dir, { ...env, LOKI_CLAUDE_CLI: stubCli() }));
    expect(r.fatal).toBeNull();
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", env }).trim()).toBe("main");
    expect(r.warnings.filter((w) => w.startsWith("initialized a new git repository in"))).toEqual([`initialized a new git repository in ${dir} (LOKI_AUTO_GIT_INIT=0 to refuse)`]);
  });

  test("ds_store only folder is initialised via the start entry", () => {
    const { dir, env } = emptyFolder();
    writeFileSync(join(dir, ".DS_Store"), "x");
    const r = startIn(dir, env);
    expect(r.stderr).toContain("initialized a new git repository in");
    expect(r.stderr).not.toContain("This folder is not empty");
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  test("ds_store plus a real file stays fatal and untouched", () => {
    const { dir, env } = emptyFolder();
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, "a.txt"), "x");
    const r = startIn(dir, env);
    expect(r.stderr).toContain("git init && git add . && git commit -m init");
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("folder with a file and no repo stays fatal and untouched", async () => {
    const { dir, env } = emptyFolder();
    writeFileSync(join(dir, "a.txt"), "x");
    const r = await checkPreflight(opts(dir, { ...env, LOKI_CLAUDE_CLI: stubCli() }));
    expect(r.fatal).toContain("git init && git add . && git commit -m init");
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("LOKI_AUTO_GIT_INIT=0 refuses on an empty folder", async () => {
    const { dir, env } = emptyFolder();
    const r = await checkPreflight(opts(dir, { ...env, LOKI_AUTO_GIT_INIT: "0", LOKI_CLAUDE_CLI: stubCli() }));
    expect(r.fatal).toContain("not a git repository");
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  // TEN-UX-01-F1: the real start entry (supervisor main) must reach initEmptyRepo before its own repo check.
  function startIn(dir: string, env: Record<string, string>) {
    const code = `import { main } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "engine10", "supervisor.ts"))}; process.exit(await main(["fix the bug"]));`;
    const script = join(tmpRoot("e10-pf-entry-"), "entry.ts"); // main reads process.argv[1], so a real file, not -e
    writeFileSync(script, code);
    return spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", timeout: 60000, env: { ...env, LOKI_SPEED: "0", LOKI_CLAUDE_CLI: fakeClaude('{"loggedIn":false}').cli } });
  }

  test("start entry in an empty folder initialises the repo and gets past the repo check", () => {
    const { dir, env } = emptyFolder();
    const r = startIn(dir, env);
    expect(r.stderr).not.toContain("not inside a git repository");
    expect(r.stderr).toContain("initialized a new git repository in");
    expect(r.stderr).toContain("claude login (or set ANTHROPIC_API_KEY)");
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(r.status).toBe(2);
  });

  test("start entry in a non-empty folder keeps the named git init fix and touches nothing", () => {
    const { dir, env } = emptyFolder();
    writeFileSync(join(dir, "a.txt"), "x");
    const r = startIn(dir, env);
    expect(r.stderr).toContain("git init && git add . && git commit -m init");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(r.status).toBe(2);
  });

  test("claude loggedIn:false is fatal and names the fix", async () => {
    const { dir, env } = identifiedRepo();
    const { cli } = fakeClaude('{"loggedIn":false}');
    const r = await checkPreflight(opts(dir, { ...env, LOKI_CLAUDE_CLI: cli }));
    expect(r.fatal).toContain("claude login (or set ANTHROPIC_API_KEY)");
  });

  test("unknown login answer is a warning, never fatal", async () => {
    const { dir, env } = identifiedRepo();
    for (const f of [fakeClaude("{}"), fakeClaude("", 1)]) {
      const r = await checkPreflight(opts(dir, { ...env, LOKI_CLAUDE_CLI: f.cli }));
      expect(r.fatal).toBeNull();
      expect(r.warnings.filter((w) => w.includes("claude auth status"))).toHaveLength(1);
    }
  });

  test("TEN-UX-12: a silent first probe that answers on the retry adds no warning", async () => {
    const { dir, env } = identifiedRepo();
    const d = tmpRoot("e10-pf-flaky-"); const cli = join(d, "claude"); const n = join(d, "n");
    writeFileSync(cli, `#!/bin/sh\nif [ -f '${n}' ]; then echo '{"loggedIn":true}'; else touch '${n}'; fi\nexit 0\n`); chmodSync(cli, 0o755);
    const r = await checkPreflight(opts(dir, { ...env, LOKI_CLAUDE_CLI: cli }));
    expect(r.fatal).toBeNull();
    expect(r.warnings.filter((w) => w.includes("claude auth status"))).toHaveLength(0);
  });

  test("TEN-UX-12: a persistently unanswered probe warns on stderr only, never stdout", async () => {
    const { dir, env } = identifiedRepo();
    const so = process.stdout.write, se = process.stderr.write; let out = "", err = "";
    process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
    try { await assertPreflight(opts(dir, { ...env, LOKI_CLAUDE_CLI: fakeClaude("", 1).cli })); } finally { process.stdout.write = so; process.stderr.write = se; }
    expect(out).toBe("");
    expect(err.trim().split("\n").filter((l) => l.includes("could not confirm the Claude login"))).toHaveLength(1);
  });

  test("loggedIn:true is clean", async () => {
    const { dir, env } = identifiedRepo();
    const r = await checkPreflight(opts(dir, { ...env, LOKI_CLAUDE_CLI: fakeClaude('{"loggedIn":true}').cli }));
    expect(r.fatal).toBeNull();
    expect(r.warnings.filter((w) => w.includes("claude auth status"))).toHaveLength(0);
  });

  test("the login probe spawns the provider CLI without the GitHub token or SSH agent (P9, TEN-P9-FIX)", async () => {
    const { dir, env } = identifiedRepo();
    const d = tmpRoot("e10-pf-claude-env-");
    const dump = join(d, "env.txt");
    const cli = join(d, "claude");
    writeFileSync(cli, `#!/bin/sh\nenv > '${dump}'\necho '{"loggedIn":true}'\n`);
    chmodSync(cli, 0o755);
    const canary = "ghp_PFCANARYtokenzzzzzzzzzzzzzzzzzzzz";
    const r = await checkPreflight(opts(dir, { ...env, GH_TOKEN: canary, GITHUB_TOKEN: canary, SSH_AUTH_SOCK: join(d, "agent.sock"), GIT_SSH_COMMAND: "ssh", LOKI_CLAUDE_CLI: cli }));
    expect(r.fatal).toBeNull();
    const seen = readFileSync(dump, "utf8");
    expect(seen).not.toContain(canary);
    expect(seen).not.toMatch(/^SSH_AUTH_SOCK=/m);
    expect(seen).toMatch(/^GIT_SSH_COMMAND=false$/m);
    expect(seen).toMatch(/^GIT_CONFIG_KEY_\d+=credential\.helper$/m);
  });

  // TEN-P9-FIX-F1: the probe env is built BY withholdGithubTokens, not a hand-built copy of it. Every key that function sets,
  // changes or deletes on this input must reach the spawned CLI the same way, so a channel added there later (an askpass
  // var, a new GIT_CONFIG pair) is withheld from the probe with no doctor.ts edit. Token vars carry a fresh sentinel per call,
  // so they are compared by prefix; everything else by exact value or absence.
  const parseEnv = (dump: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const line of dump.split("\n")) { const i = line.indexOf("="); if (i > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, i))) m.set(line.slice(0, i), line.slice(i + 1)); }
    return m;
  };
  function expectWithheldLike(input: Record<string, string>, seen: Map<string, string>): number {
    const ref: NodeJS.ProcessEnv = { ...input };
    withholdGithubTokens(ref, () => {});
    let touched = 0;
    for (const k of new Set([...Object.keys(input), ...Object.keys(ref)])) {
      if (ref[k] === input[k]) continue;
      touched++;
      if (ref[k] === undefined) expect([k, seen.has(k)]).toEqual([k, false]);
      else if ((GITHUB_TOKEN_VARS as readonly string[]).includes(k)) expect([k, seen.get(k)?.startsWith(SENTINEL_PREFIX)]).toEqual([k, true]);
      // the empty gh config dir is per process: another process (the bun cli child) mints its own
      else if (k === "GH_CONFIG_DIR" && seen.get(k) !== ref[k]) expect([k, /\/loki-gh-config-[^/]+$/.test(seen.get(k) ?? "")]).toEqual([k, true]);
      else expect([k, seen.get(k)]).toEqual([k, ref[k]]);
    }
    return touched;
  }
  const P9_INPUT = (d: string): Record<string, string> => ({
    GH_TOKEN: "ghp_PFCANARYtokenzzzzzzzzzzzzzzzzzzzz", GITHUB_TOKEN: "ghp_PFCANARYtokenzzzzzzzzzzzzzzzzzzzz",
    GH_ENTERPRISE_TOKEN: "ghp_PFCANARYtokenzzzzzzzzzzzzzzzzzzzz", GITHUB_ENTERPRISE_TOKEN: "ghp_PFCANARYtokenzzzzzzzzzzzzzzzzzzzz",
    SSH_AUTH_SOCK: join(d, "agent.sock"), GIT_SSH_COMMAND: "ssh", GIT_ASKPASS: join(d, "askpass"), SSH_ASKPASS: join(d, "askpass"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_PARAMETERS: "'credential.helper'='store'",
    GIT_TERMINAL_PROMPT: "1", GCM_INTERACTIVE: "always",
  });

  test("the login probe env equals withholdGithubTokens on every channel it touches (TEN-P9-FIX-F1)", async () => {
    const { dir, env } = identifiedRepo();
    const d = tmpRoot("e10-pf-claude-same-");
    const dump = join(d, "env.txt");
    const cli = join(d, "claude");
    writeFileSync(cli, `#!/bin/sh\nenv > '${dump}'\necho '{"loggedIn":true}'\n`);
    chmodSync(cli, 0o755);
    const input = { ...env, ...P9_INPUT(d), LOKI_CLAUDE_CLI: cli };
    const r = await checkPreflight(opts(dir, input));
    expect(r.fatal).toBeNull();
    const seen = parseEnv(readFileSync(dump, "utf8"));
    expect(expectWithheldLike(input, seen)).toBeGreaterThanOrEqual(8);
    // The helper doctor uses for every provider spawn (login probe and --round-trip) agrees in-process too, and never mutates.
    const before = { ...input };
    const probe = providerProbeEnv(input);
    expect(input).toEqual(before);
    expectWithheldLike(input, new Map(Object.entries(probe).filter((e): e is [string, string] => e[1] !== undefined)));
  });

  test("operator opt-out keeps the probe env untouched, as withholdGithubTokens does for the session", () => {
    const d = tmpRoot("e10-pf-claude-optout-");
    const input = { ...P9_INPUT(d), LOKI_ALLOW_AGENT_GITHUB_TOKEN: "1" };
    expect(providerProbeEnv(input)).toEqual(input);
    // exact-string opt-out: a value that merely reads as true (or numerically equals 1) still withholds
    for (const v of ["01", "true", " 1", "1.0"]) expect([v, providerProbeEnv({ ...input, LOKI_ALLOW_AGENT_GITHUB_TOKEN: v })["GH_TOKEN"]?.startsWith(SENTINEL_PREFIX)]).toEqual([v, true]);
  });

  test("bun cli doctor: the login probe never sees the GitHub token (real entry path, TEN-P9-FIX-F1)", () => {
    const d = tmpRoot("e10-pf-doctor-");
    const dump = join(d, "env.txt");
    writeFileSync(join(d, "claude"), `#!/bin/sh\nif [ "$1" = auth ]; then env > '${dump}'; echo '{"loggedIn":true}'; exit 0; fi\necho "2.1.99 (Claude Code)"\n`);
    chmodSync(join(d, "claude"), 0o755);
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ANTHROPIC_API_KEY" && k !== "CLAUDE_CODE_OAUTH_TOKEN") base[k] = v;
    const input = { ...base, ...P9_INPUT(d), PATH: `${d}:${process.env.PATH ?? ""}` };
    const r = spawnSync("bun", [join(import.meta.dir, "..", "..", "src", "cli.ts"), "doctor"], { env: input, encoding: "utf8", timeout: 60000 });
    expect(r.stdout).toContain("Claude CLI is logged in");
    const raw = readFileSync(dump, "utf8");
    expect(raw).not.toContain("PFCANARY");
    expectWithheldLike(input, parseEnv(raw));
  }, 90000);

  test("CLAUDE_CODE_OAUTH_TOKEN skips the probe (an ANTHROPIC_API_KEY gets the RQ-11 key probe instead)", async () => {
    const { dir, env } = identifiedRepo();
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN"]) {
      const f = fakeClaude('{"loggedIn":false}');
      const r = await checkPreflight(opts(dir, { ...env, [k]: "x", LOKI_CLAUDE_CLI: f.cli }));
      expect(r.fatal).toBeNull();
      expect(existsSync(f.marker)).toBe(false);
    }
  });
});

describe("TEN-SPEED-05: login probe reuse", () => {
  function counting(out: string): { cli: string; count: () => number } {
    const d = tmpRoot("e10-pf-cnt-"); const cli = join(d, "claude"); const log = join(d, "log");
    writeFileSync(cli, `#!/bin/sh\necho x >> '${log}'\n${out ? `echo '${out}'\n` : ""}exit 0\n`); chmodSync(cli, 0o755);
    return { cli, count: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0) };
  }
  const o = (dir: string, env: Record<string, string>) => ({ repoDir: dir, provider: "claude", pr: false, env });
  const cacheFile = (env: Record<string, string>) => join(env.HOME ?? "", ".loki", "claude-login-ok.json");

  test("two starts inside 10 min spawn the probe once", async () => {
    const { dir, env } = identifiedRepo(); const c = counting('{"loggedIn":true}'); const e = { ...env, LOKI_CLAUDE_CLI: c.cli };
    expect((await checkPreflight(o(dir, e))).fatal).toBeNull();
    expect((await checkPreflight(o(dir, e))).fatal).toBeNull();
    expect(c.count()).toBe(1);
  });

  test("a logged-out probe is never cached", async () => {
    const { dir, env } = identifiedRepo(); const c = counting('{"loggedIn":false}'); const e = { ...env, LOKI_CLAUDE_CLI: c.cli };
    expect((await checkPreflight(o(dir, e))).fatal).toContain("not logged in");
    expect((await checkPreflight(o(dir, e))).fatal).toContain("not logged in");
    expect(c.count()).toBe(2);
    expect(existsSync(cacheFile(e))).toBe(false);
  });

  test("an unanswered probe is never cached", async () => {
    const { dir, env } = identifiedRepo(); const c = counting(""); const e = { ...env, LOKI_CLAUDE_CLI: c.cli };
    await checkPreflight(o(dir, e)); const first = c.count(); await checkPreflight(o(dir, e));
    expect(c.count()).toBe(first * 2);
  });

  test("an expired entry re-probes; a different CLI path re-probes", async () => {
    const { dir, env } = identifiedRepo(); const c = counting('{"loggedIn":true}'); const e = { ...env, LOKI_CLAUDE_CLI: c.cli };
    await checkPreflight(o(dir, e));
    writeFileSync(cacheFile(e), JSON.stringify({ cli: c.cli, at: Date.now() - 10 * 60 * 1000 - 1000 }));
    await checkPreflight(o(dir, e)); expect(c.count()).toBe(2);
    const c2 = counting('{"loggedIn":true}');
    await checkPreflight(o(dir, { ...e, LOKI_CLAUDE_CLI: c2.cli })); expect(c2.count()).toBe(1);
  });

  test("a corrupt cache file re-probes without crashing", async () => {
    const { dir, env } = identifiedRepo(); const c = counting('{"loggedIn":true}'); const e = { ...env, LOKI_CLAUDE_CLI: c.cli };
    await checkPreflight(o(dir, e)); writeFileSync(cacheFile(e), "{not json");
    expect((await checkPreflight(o(dir, e))).fatal).toBeNull(); expect(c.count()).toBe(2);
  });
});

describe("TEN-STABILITY-36: low disk", () => {
  const mb = (n: number) => () => ({ bavail: n * 1024, bsize: 1024 });
  const mk = (statfs: ((p: string) => { bavail: number; bsize: number }) | undefined, extra: Record<string, string> = {}) => {
    const { dir, env } = identifiedRepo();
    return checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { ...env, LOKI_CLAUDE_CLI: stubCli(), ANTHROPIC_API_KEY: "k", LOKI_PREFLIGHT_PROBE: "0", ...extra }, statfs });
  };
  test("under 2 GB warns naming the volume path", async () => {
    const r = await mk(mb(1500)); expect(r.fatal).toBeNull(); expect(r.warnings.join("\n")).toMatch(/low disk: 1500 MB free on the volume holding .*e10-pf-repo-/);
  });
  test("under 200 MB is fatal", async () => {
    const r = await mk(mb(50)); expect(r.fatal).toMatch(/only 50 MB free on the volume holding/);
  });
  test("normal disk prints nothing; LOKI_MIN_FREE_MB overrides", async () => {
    const r = await mk(mb(10000)); expect(r.fatal).toBeNull(); expect(r.warnings.filter((w) => w.includes("disk"))).toEqual([]);
    expect((await mk(mb(500), { LOKI_MIN_FREE_MB: "1000" })).fatal).toContain("need 1000 MB");
  });
  test("unreadable statfs is ignored", async () => {
    const r = await mk(() => { throw new Error("x"); }); expect(r.fatal).toBeNull();
  });
  test("real preflight() entry exits 2 on a full volume", () => {
    const { dir, env } = identifiedRepo();
    const r = spawnSync("bun", ["-e", `import {preflight} from ${JSON.stringify(PREFLIGHT_TS)}; await preflight({repoDir:${JSON.stringify(dir)},provider:"claude",pr:false,env:${JSON.stringify({ ...env, LOKI_CLAUDE_CLI: stubCli(), ANTHROPIC_API_KEY: "k", LOKI_PREFLIGHT_PROBE: "0", LOKI_MIN_FREE_MB: "999999999" })}});`], { encoding: "utf8" });
    expect(r.status).toBe(2); expect(r.stderr).toContain("MB free on the volume holding");
  });
});

describe("TEN-SPEED-08: gh auth probe reuse", () => {
  function ghDir(authExit: number): { path: string; count: () => number } {
    const d = tmpRoot("e10-pf-gh-"); const log = join(d, "log");
    writeFileSync(join(d, "gh"), `#!/bin/sh\n[ "$1" = auth ] && echo x >> '${log}'\nif [ "$1" = auth ]; then exit ${authExit}; fi\nexit 0\n`); chmodSync(join(d, "gh"), 0o755);
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(d, "git"));
    return { path: d, count: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0) };
  }
  function prRepo(g: { path: string }) {
    const { dir, env } = identifiedRepo();
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
    return { dir, env: { ...env, PATH: g.path, LOKI_CLAUDE_CLI: stubCli(), ANTHROPIC_API_KEY: "k", LOKI_PREFLIGHT_PROBE: "0" } };
  }
  const o = (dir: string, env: Record<string, string>) => ({ repoDir: dir, provider: "claude", pr: true, env });
  const cacheFile = (env: Record<string, string>) => join(env.HOME ?? "", ".loki", "gh-auth-ok.json");

  test("two PR runs inside 10 min spawn gh auth status once", async () => {
    const g = ghDir(0); const { dir, env } = prRepo(g);
    expect((await checkPreflight(o(dir, env))).fatal).toBeNull();
    expect((await checkPreflight(o(dir, env))).fatal).toBeNull();
    expect(g.count()).toBe(1);
  });

  test("a failed probe is never cached", async () => {
    const g = ghDir(1); const { dir, env } = prRepo(g);
    expect((await checkPreflight(o(dir, env))).fatal).toContain("gh (GitHub CLI)");
    expect((await checkPreflight(o(dir, env))).fatal).toContain("gh (GitHub CLI)");
    expect(g.count()).toBe(2); expect(existsSync(cacheFile(env))).toBe(false);
  });

  test("expired entry, other gh path, and corrupt file all re-probe", async () => {
    const g = ghDir(0); const { dir, env } = prRepo(g);
    await checkPreflight(o(dir, env));
    writeFileSync(cacheFile(env), JSON.stringify({ gh: join(g.path, "gh"), at: Date.now() - 10 * 60 * 1000 - 1000 }));
    await checkPreflight(o(dir, env)); expect(g.count()).toBe(2);
    writeFileSync(cacheFile(env), JSON.stringify({ gh: "/other/gh", at: Date.now() }));
    await checkPreflight(o(dir, env)); expect(g.count()).toBe(3);
    writeFileSync(cacheFile(env), "{not json");
    expect((await checkPreflight(o(dir, env))).fatal).toBeNull(); expect(g.count()).toBe(4);
  });
});

describe("TEN-SPEED-14: parallel git reads", () => {
  // A git shim that logs S (start) and E (end) per call and sleeps in between, so serial vs parallel spawn order is visible.
  function shim(): { path: string; log: string } {
    const d = tmpRoot("e10-pf-shim-"); const log = join(d, "log"); const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(d, "git"), `#!/bin/sh\necho S >> '${log}'\nsleep 0.4\n'${real}' "$@"\nrc=$?\necho E >> '${log}'\nexit $rc\n`); chmodSync(join(d, "git"), 0o755);
    return { path: d, log };
  }
  test("parallel git reads: all four starts precede the first end", async () => {
    const { dir, env } = identifiedRepo(); const s = shim();
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: { ...env, PATH: `${s.path}:${env.PATH}`, LOKI_CLAUDE_CLI: stubCli() } });
    expect(r.fatal).toBeNull();
    const seq = readFileSync(s.log, "utf8").trim().split("\n").join("");
    expect(seq.startsWith("SSSSEEEE")).toBe(true);
  });
  test("auto-init re-reads once and still passes", async () => {
    const dir = tmpRoot("e10-pf-empty-"); const home = tmpRoot("e10-pf-home-"); const s = shim();
    const env = { PATH: `${s.path}:${process.env.PATH ?? ""}`, HOME: home, GIT_CONFIG_GLOBAL: join(home, "gc"), GIT_CONFIG_SYSTEM: "/dev/null", LOKI_CLAUDE_CLI: stubCli() };
    writeFileSync(join(home, "gc"), "[user]\n\tname = t\n\temail = t@t.test\n");
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env });
    expect(r.fatal).toBeNull(); expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("TEN-ADOPTION-34: provider login probe", () => {
  function cli(body: string): string {
    const dir = tmpRoot("e10-pf-login-"); const p = join(dir, "fake-cli");
    writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p;
  }
  const run = (provider: string, envVar: string, c: string, extra: Record<string, string> = {}) => {
    const { dir, env } = identifiedRepo();
    return checkPreflight({ repoDir: dir, provider, pr: false, env: { ...env, [envVar]: c, ...extra } });
  };

  test("codex logged out is fatal and names the login command", async () => {
    const r = await run("codex", "LOKI_CODEX_CLI", cli('[ "$1" = login ] && { echo "Not logged in"; exit 1; }; exit 0'));
    expect(r.fatal).toContain("codex is not logged in; run: codex login");
  });
  test("codex logged in and codex with an API key pass", async () => {
    expect((await run("codex", "LOKI_CODEX_CLI", cli("exit 0"))).fatal).toBeNull();
    expect((await run("codex", "LOKI_CODEX_CLI", cli('echo "Not logged in"; exit 1'), { OPENAI_API_KEY: "k" })).fatal).toBeNull();
  });
  test("codex unknown probe answer only warns", async () => {
    const r = await run("codex", "LOKI_CODEX_CLI", cli("exit 3"));
    expect(r.fatal).toBeNull(); expect(r.warnings.join("\n")).toContain("could not confirm the Codex login");
  });
  test("aider, cline, opencode without any key warn by name, never fatal", async () => {
    for (const [p, v] of [["aider", "LOKI_AIDER_CLI"], ["cline", "LOKI_CLINE_CLI"], ["opencode", "LOKI_OPENCODE_CLI"]] as const) {
      const r = await run(p, v, cli("exit 0"));
      expect(r.fatal).toBeNull(); expect(r.warnings.join("\n")).toContain(`no ${p} login or API key found`);
    }
  });
  test("a provider API key silences the warning", async () => {
    const r = await run("aider", "LOKI_AIDER_CLI", cli("exit 0"), { ANTHROPIC_API_KEY: "k" });
    expect(r.warnings.join("\n")).not.toContain("login or API key");
  });
});

describe("TEN-UX-55: repo writable", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const env = (e: Record<string, string>) => ({ ...e, LOKI_CLAUDE_CLI: stubCli(), ANTHROPIC_API_KEY: "k", LOKI_PREFLIGHT_PROBE: "0" });
  test.skipIf(isRoot)("read-only repo dir is fatal with a one-line fix", async () => {
    const { dir, env: e } = identifiedRepo(); chmodSync(dir, 0o555);
    try { const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: env(e) }); expect(r.fatal).toMatch(/is not writable; run: chmod u\+w/); expect(r.fatal).not.toContain("\n"); } finally { chmodSync(dir, 0o755); }
  });
  test("writable repo dir passes", async () => {
    const { dir, env: e } = identifiedRepo(); expect((await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: env(e) })).fatal).toBeNull();
  });
  test.skipIf(isRoot)("real preflight() entry exits 2 on a read-only repo", () => {
    const { dir, env: e } = identifiedRepo(); chmodSync(dir, 0o555);
    try {
      const r = spawnSync("bun", ["-e", `import {preflight} from ${JSON.stringify(PREFLIGHT_TS)}; await preflight({repoDir:${JSON.stringify(dir)},provider:"claude",pr:false,env:${JSON.stringify(env(e))}});`], { encoding: "utf8" });
      expect(r.status).toBe(2); expect(r.stderr).toContain("is not writable");
    } finally { chmodSync(dir, 0o755); }
  });
});

describe("CW-14: zero-token auth probe bound into preflight.json", () => {
  const CANARY = "sk-canary-DO-NOT-LEAK-0123456789";
  // A fake CLI that records every argv it receives; it can never reach a model endpoint.
  function argvCli(status: number, say = ""): { cli: string; log: string } {
    const d = tmpRoot("e10-pf-cw14-"); const log = join(d, "argv.log"); const cli = join(d, "fake-cli");
    writeFileSync(cli, `#!/bin/sh\necho "$*" >> '${log}'\n${say ? `echo '${say}'\n` : ""}exit ${status}\n`); chmodSync(cli, 0o755); return { cli, log };
  }
  const go = (provider: string, envVar: string, cli: string, extra: Record<string, string> = {}) => {
    const { dir, env } = identifiedRepo(); const runDir = join(dir, ".loki", "runs", "r1");
    return checkPreflight({ repoDir: dir, provider, pr: false, runDir, env: { ...env, [envVar]: cli, ...extra } }).then((r) => ({ r, runDir }));
  };
  const rec = (runDir: string) => JSON.parse(readFileSync(join(runDir, "preflight.json"), "utf8"));

  test("key contract: exactly {provider, auth_path, probe}", async () => {
    const { cli } = argvCli(0); const { runDir } = await go("codex", "LOKI_CODEX_CLI", cli);
    expect(Object.keys(rec(runDir)).sort()).toEqual(["auth_path", "probe", "provider"]);
    expect(rec(runDir)).toEqual({ provider: "codex", auth_path: "cli_login:codex", probe: "ok" });
  });
  test("failed probe is fatal within 10s, names the fix, and is recorded", async () => {
    const { cli } = argvCli(1, "Not logged in"); const t0 = Date.now();
    const { r, runDir } = await go("codex", "LOKI_CODEX_CLI", cli);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.fatal).toContain("run: codex login"); expect(rec(runDir).probe).toBe("failed");
  });
  test("LOKI_PREFLIGHT_PROBE=0 skips: the CLI is never called and nothing is fatal", async () => {
    const { cli, log } = argvCli(1, "Not logged in");
    const { r, runDir } = await go("codex", "LOKI_CODEX_CLI", cli, { LOKI_PREFLIGHT_PROBE: "0" });
    expect(r.fatal).toBeNull(); expect(existsSync(log)).toBe(false); expect(rec(runDir).probe).toBe("skipped");
  });
  test("zero tokens: only the fixed local status argv is ever run; a key skips the probe and never lands in the record", async () => {
    const { cli, log } = argvCli(0);
    await go("codex", "LOKI_CODEX_CLI", cli);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["login status"]);
    const k = argvCli(1, "Not logged in");
    const { r, runDir } = await go("codex", "LOKI_CODEX_CLI", k.cli, { OPENAI_API_KEY: CANARY });
    expect(r.fatal).toBeNull(); expect(existsSync(k.log)).toBe(false);
    const raw = readFileSync(join(runDir, "preflight.json"), "utf8");
    expect(raw).not.toContain(CANARY); expect(rec(runDir)).toEqual({ provider: "codex", auth_path: "api_key:OPENAI_API_KEY", probe: "skipped", probe_reason: "credential is api_key; no zero-token check ran for it" });
  });
  test("claude logged out records failed", async () => {
    const d = tmpRoot("e10-pf-cw14c-"); const cli = join(d, "claude");
    writeFileSync(cli, `#!/bin/sh\necho '{"loggedIn":false}'\nexit 1\n`); chmodSync(cli, 0o755);
    const { dir, env } = identifiedRepo(); const runDir = join(dir, ".loki", "runs", "r1");
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, runDir, env: { ...env, LOKI_CLAUDE_CLI: cli } });
    expect(r.fatal).toContain("claude is not logged in"); expect(rec(runDir)).toEqual({ provider: "claude", auth_path: "cli_login:claude", probe: "failed" });
  });
});

describe("RQ-11 (#351): zero-token ANTHROPIC_API_KEY probe", () => {
  const KEY = "sk-ant-canary-RQ11-DO-NOT-LEAK-0123456789";
  type Seen = { method: string; path: string; key: string | null }[];
  function stub(status: number, delayMs = 0): { url: string; seen: Seen; stop: () => void } {
    const seen: Seen = [];
    const srv = Bun.serve({ port: 0, async fetch(req) { seen.push({ method: req.method, path: new URL(req.url).pathname, key: req.headers.get("x-api-key") }); if (delayMs) await Bun.sleep(delayMs); return new Response("{}", { status }); } });
    return { url: `http://127.0.0.1:${srv.port}`, seen, stop: () => srv.stop(true) };
  }
  async function go(base: string, extra: Record<string, string> = {}) {
    const { dir, env } = identifiedRepo(); const runDir = join(dir, ".loki", "runs", "r1"); const out: string[] = [];
    const ow = process.stdout.write.bind(process.stdout), ew = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stderr.write;
    let thrown = ""; let r: Awaited<ReturnType<typeof checkPreflight>>;
    const e = { ...env, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: base, LOKI_CLAUDE_CLI: stubCli(), ...extra };
    try { r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, runDir, env: e }); try { await assertPreflight({ repoDir: dir, provider: "claude", pr: false, env: e }); } catch (x) { thrown = String((x as Error).message); } }
    finally { process.stdout.write = ow; process.stderr.write = ew; }
    const files: string[] = []; const walk = (p: string) => { try { for (const n of require("node:fs").readdirSync(p)) { const q = join(p, n); try { require("node:fs").statSync(q).isDirectory() ? walk(q) : files.push(readFileSync(q, "utf8")); } catch { /* skip */ } } } catch { /* skip */ } };
    walk(join(dir, ".loki")); walk(join(env.HOME!, ".loki"));
    const leaked = [...out, thrown, r.fatal ?? "", ...r.warnings, ...files].some((t) => t.includes(KEY));
    return { r, runDir, leaked, home: env.HOME };
  }
  const rec = (runDir: string) => JSON.parse(readFileSync(join(runDir, "preflight.json"), "utf8"));

  test("401 is fatal with the fix line, recorded failed, and the key never appears anywhere", async () => {
    const s = stub(401); const { r, runDir, leaked } = await go(s.url); s.stop();
    expect(r.fatal).toBe("ANTHROPIC_API_KEY was rejected (HTTP 401); fix the key or unset it to use claude login");
    expect(rec(runDir)).toEqual({ provider: "claude", auth_path: "api_key:ANTHROPIC_API_KEY", probe: "failed" });
    expect(leaked).toBe(false);
    expect(s.seen.every((x) => x.method === "GET" && x.path === "/v1/models" && x.key === KEY)).toBe(true);
    expect(s.seen.some((x) => x.path === "/v1/messages")).toBe(false);
  });
  test("403 is fatal too", async () => {
    const s = stub(403); const { r } = await go(s.url); s.stop(); expect(r.fatal).toContain("(HTTP 403)");
  });
  test("200 records ok, caches for 10 min (one request across two starts), never leaks the key or stores it", async () => {
    const s = stub(200); const { dir, env } = identifiedRepo(); const runDir = join(dir, ".loki", "runs", "r1");
    const e: Record<string, string> = { ...env, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: s.url, LOKI_CLAUDE_CLI: stubCli() };
    const a = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, runDir, env: e }); const b = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: e }); s.stop();
    expect(a.fatal).toBeNull(); expect(b.fatal).toBeNull(); expect(rec(runDir).probe).toBe("ok"); expect(s.seen.length).toBe(1);
    expect(readFileSync(join(e.HOME!, ".loki", "anthropic-key-ok.json"), "utf8")).not.toContain(KEY);
  });
  test("a rejected key is never cached, and a different key re-probes", async () => {
    const s = stub(401); const { dir, env } = identifiedRepo(); const e: Record<string, string> = { ...env, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: s.url, LOKI_CLAUDE_CLI: stubCli() };
    await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: e }); await checkPreflight({ repoDir: dir, provider: "claude", pr: false, env: e }); s.stop();
    expect(s.seen.length).toBe(2); expect(existsSync(join(e.HOME!, ".loki", "anthropic-key-ok.json"))).toBe(false);
  });
  test("a timeout warns, records unknown, and is not fatal", async () => {
    const s = stub(200, 7000); const t0 = Date.now(); const { r, runDir, leaked } = await go(s.url); s.stop();
    expect(r.fatal).toBeNull(); expect(r.warnings.join("\n")).toContain("could not confirm the ANTHROPIC_API_KEY"); expect(rec(runDir).probe).toBe("unknown"); expect(leaked).toBe(false);
    expect(Date.now() - t0).toBeLessThan(20000);
  }, 30000);
  test("a network error and a 500 are unknown, not fatal", async () => {
    const dead = await go("http://127.0.0.1:9"); expect(dead.r.fatal).toBeNull(); expect(rec(dead.runDir).probe).toBe("unknown");
    const s = stub(500); const five = await go(s.url); s.stop(); expect(five.r.fatal).toBeNull(); expect(rec(five.runDir).probe).toBe("unknown");
  });
  test("LOKI_PREFLIGHT_PROBE=0, LOKI_AIRGAP and an OAuth token send no request and record skipped", async () => {
    for (const extra of [{ LOKI_PREFLIGHT_PROBE: "0" }, { LOKI_AIRGAP: "true" }] as Record<string, string>[]) {
      const s = stub(401); const { r, runDir } = await go(s.url, extra); s.stop();
      expect(r.fatal).toBeNull(); expect(s.seen.length).toBe(0); expect(rec(runDir).probe).toBe("skipped");
    }
    const s = stub(401); const { dir, env } = identifiedRepo(); const runDir = join(dir, ".loki", "runs", "r1");
    const r = await checkPreflight({ repoDir: dir, provider: "claude", pr: false, runDir, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_BASE_URL: s.url, LOKI_CLAUDE_CLI: stubCli() } }); s.stop();
    expect(r.fatal).toBeNull(); expect(s.seen.length).toBe(0);
  });
  test("a redirect is never followed (the key header would leave the host) and is unknown", async () => {
    const target = stub(200); const srv = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `${target.url}/v1/models` } }) });
    const { r, runDir } = await go(`http://127.0.0.1:${srv.port}`); srv.stop(true); target.stop();
    expect(target.seen.length).toBe(0); expect(r.fatal).toBeNull(); expect(rec(runDir).probe).toBe("unknown");
  });
});

describe("RQ-12: preflight.json probe holds the outcome of the check that ran", () => {
  const rec = (runDir: string) => JSON.parse(readFileSync(join(runDir, "preflight.json"), "utf8"));
  const go = async (provider: string, envVar: string, extra: (home: string) => Record<string, string> = () => ({})) => {
    const { dir, env } = identifiedRepo(); const runDir = join(dir, ".loki", "runs", "r1"); const home = env.HOME!;
    const r = await checkPreflight({ repoDir: dir, provider, pr: false, runDir, env: { ...env, [envVar]: stubCli(), ...extra(home) } }); return { r, rec: rec(runDir) };
  };
  test("a check that ran is never recorded skipped, one case per provider", async () => {
    const login = (cmd: string) => { const d = tmpRoot("e10-pf-rq12-"); const p = join(d, "cli"); writeFileSync(p, `#!/bin/sh\n${cmd}\n`); chmodSync(p, 0o755); return p; };
    const c = identifiedRepo(); const cRun = join(c.dir, ".loki", "runs", "r1");
    const claude = await checkPreflight({ repoDir: c.dir, provider: "claude", pr: false, runDir: cRun, env: { ...c.env, LOKI_CLAUDE_CLI: login(`echo '{"loggedIn":true}'`) } });
    expect(claude.fatal).toBeNull(); expect(rec(cRun).probe).toBe("ok");
    const codex = await go("codex", "LOKI_CODEX_CLI"); expect(codex.rec.probe).toBe("ok");
    const cline = await go("cline", "LOKI_CLINE_CLI", (h) => { mkdirSync(join(h, ".cline")); return {}; }); expect(cline.rec.probe).toBe("ok");
    const opencode = await go("opencode", "LOKI_OPENCODE_CLI", (h) => { mkdirSync(join(h, ".local", "share", "opencode"), { recursive: true }); writeFileSync(join(h, ".local", "share", "opencode", "auth.json"), "{}"); return {}; }); expect(opencode.rec.probe).toBe("ok");
    const aider = await go("aider", "LOKI_AIDER_CLI"); expect(aider.rec.probe).toBe("unknown");
  });
  test("a warn result records unknown, not skipped", async () => {
    for (const [p, v] of [["aider", "LOKI_AIDER_CLI"], ["cline", "LOKI_CLINE_CLI"], ["opencode", "LOKI_OPENCODE_CLI"]] as const) {
      const x = await go(p, v); expect(x.r.warnings.join("\n")).toContain(`no ${p} login or API key found`); expect(x.rec.probe).toBe("unknown"); expect(x.rec.probe_reason).toBeUndefined();
    }
  });
  test("LOKI_PREFLIGHT_PROBE=0 records skipped with its reason", async () => {
    const x = await go("aider", "LOKI_AIDER_CLI", () => ({ LOKI_PREFLIGHT_PROBE: "0" }));
    expect(x.rec.probe).toBe("skipped"); expect(x.rec.probe_reason).toBe("LOKI_PREFLIGHT_PROBE=0");
  });
  test("no provider-name branch sets the probe in preflight.ts", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "engine10", "preflight.ts"), "utf8");
    expect(src).not.toMatch(/o\.provider === "(?:codex|cline|aider|opencode)"/); // only the claude CLI-login and key branches are named; every other provider goes through providerLoginIssue
  });
});
