// Rule of Two (moat P9) on the Bun route: Loki never passes GitHub tokens into the environment of an agent
// the runner spawns, unless the operator opts out with
// LOKI_ALLOW_AGENT_GITHUB_TOKEN=1, which also prints one stderr warning.
//
// The bash route is proven by tests/moat/p9-rule-of-two.sh
// (P9.injection-cannot-reach-token). This drives runAutonomous() through the
// REAL providers.ts claude invoker with a fake claude binary that dumps its
// environment, the same harness shape as e2e_fake_provider.test.ts.

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runAutonomous } from "../../src/runner/autonomous.ts";
import {
  AGENT_TOKEN_WARNING_PREFIX,
  withholdGithubTokens,
} from "../../src/runner/github_token.ts";
import type { CouncilHook, RunnerContext, RunnerOpts, SignalSource } from "../../src/runner/types.ts";

setDefaultTimeout(30_000);

const GH = "ghp_BUNCANARYgh";
const GHA = "ghs_BUNCANARYgithub";

describe("withholdGithubTokens", () => {
  it("sentinels every GitHub token by default and warns nothing", () => {
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: GH, GITHUB_TOKEN: GHA, GH_ENTERPRISE_TOKEN: "e1", GITHUB_ENTERPRISE_TOKEN: "e2", KEEP: "x",
    };
    const warned: string[] = [];
    const removed = withholdGithubTokens(env, (l) => warned.push(l));
    expect(removed).toEqual(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
    // BACKLOG 149 round 2: no longer deleted -- set to a garbage sentinel so
    // gh's own env-token precedence (`gh help environment`) shadows a keyring
    // fallback instead of falling through to it.
    expect(env["GH_TOKEN"]).toBeTruthy();
    expect(env["GH_TOKEN"]).not.toBe(GH);
    expect(env["GITHUB_TOKEN"]).toBeTruthy();
    expect(env["GITHUB_TOKEN"]).not.toBe(GHA);
    expect(env["GH_ENTERPRISE_TOKEN"]).toBeTruthy();
    expect(env["GH_ENTERPRISE_TOKEN"]).not.toBe("e1");
    expect(env["GITHUB_ENTERPRISE_TOKEN"]).toBeTruthy();
    expect(env["GITHUB_ENTERPRISE_TOKEN"]).not.toBe("e2");
    // All 4 vars get the SAME sentinel value in one call.
    expect(env["GH_TOKEN"]).toBe(env["GITHUB_TOKEN"]);
    expect(env["GH_TOKEN"]).toBe(env["GH_ENTERPRISE_TOKEN"]);
    expect(env["GH_TOKEN"]).toBe(env["GITHUB_ENTERPRISE_TOKEN"]);
    expect(env["KEEP"]).toBe("x");
    expect(warned).toEqual([]);
  });

  it("mints a different sentinel on each call", () => {
    const env1: NodeJS.ProcessEnv = {};
    const env2: NodeJS.ProcessEnv = {};
    withholdGithubTokens(env1);
    withholdGithubTokens(env2);
    expect(env1["GH_TOKEN"]).not.toBe(env2["GH_TOKEN"]);
  });

  it("keeps the tokens under LOKI_ALLOW_AGENT_GITHUB_TOKEN=1 and warns exactly once", () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: GH, GITHUB_TOKEN: GHA, LOKI_ALLOW_AGENT_GITHUB_TOKEN: "1" };
    const warned: string[] = [];
    expect(withholdGithubTokens(env, (l) => warned.push(l))).toEqual([]);
    expect(env["GH_TOKEN"]).toBe(GH);
    expect(env["GITHUB_TOKEN"]).toBe(GHA);
    expect(warned.length).toBe(1);
    expect(warned[0]!.startsWith(AGENT_TOKEN_WARNING_PREFIX)).toBe(true);
    expect(warned[0]).toContain("GH_TOKEN GITHUB_TOKEN");
  });

  it("honors only the exact value 1", () => {
    for (const v of ["true", "yes", "01", " 1", ""]) {
      const env: NodeJS.ProcessEnv = { GH_TOKEN: GH, LOKI_ALLOW_AGENT_GITHUB_TOKEN: v };
      const warned: string[] = [];
      expect(withholdGithubTokens(env, (l) => warned.push(l))).toEqual(["GH_TOKEN"]);
      expect(env["GH_TOKEN"]).not.toBe(GH);
      expect(warned).toEqual([]);
    }
  });

  it("does not warn under the opt-out when there is no token to hold", () => {
    const warned: string[] = [];
    expect(withholdGithubTokens({ LOKI_ALLOW_AGENT_GITHUB_TOKEN: "1" }, (l) => warned.push(l))).toEqual([]);
    expect(warned).toEqual([]);
  });

  // BACKLOG 149: a hosts.yml-authenticated user (`gh auth login`, no
  // GH_TOKEN/GITHUB_TOKEN set at all) is the case the 4-var withhold above
  // cannot see. GH_CONFIG_DIR must still be scoped to a fresh, empty,
  // non-default-looking directory so gh cannot resolve the real hosts.yml.
  it("scopes GH_CONFIG_DIR to a fresh empty dir even with no token present", () => {
    const env: NodeJS.ProcessEnv = { KEEP: "x" };
    const removed = withholdGithubTokens(env);
    expect(removed).toEqual([]);
    const scoped = env["GH_CONFIG_DIR"];
    expect(scoped).toBeTruthy();
    expect(scoped).not.toBe("");
    expect(env["KEEP"]).toBe("x");
    // The 4 vars are sentineled even when none was present before (the exact
    // case the pre-round-2 fix could not see: a hosts.yml-only user has none
    // of these set, so the old "return [] early" behavior never scoped
    // anything for them either).
    expect(env["GH_TOKEN"]).toBeTruthy();
  });

  it("does not scope GH_CONFIG_DIR under the opt-out", () => {
    const env: NodeJS.ProcessEnv = { LOKI_ALLOW_AGENT_GITHUB_TOKEN: "1" };
    withholdGithubTokens(env);
    expect(env["GH_CONFIG_DIR"]).toBeUndefined();
  });

  it("scopes GH_CONFIG_DIR alongside sentineling tokens in the default case", () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: GH, GITHUB_TOKEN: GHA };
    withholdGithubTokens(env);
    expect(env["GH_TOKEN"]).not.toBe(GH);
    expect(env["GH_CONFIG_DIR"]).toBeTruthy();
  });

  // BACKLOG 149 round 2: the git-invoked credential.helper path is not
  // gh-mediated at all, so the sentinel alone cannot close it -- git's own
  // credential.helper chain must be reset independently.
  it("resets git's credential.helper via GIT_CONFIG_COUNT/KEY/VALUE", () => {
    const env: NodeJS.ProcessEnv = {};
    withholdGithubTokens(env);
    expect(env["GIT_CONFIG_COUNT"]).toBe("1");
    expect(env["GIT_CONFIG_KEY_0"]).toBe("credential.helper");
    expect(env["GIT_CONFIG_VALUE_0"]).toBe("");
  });

  it("appends the credential.helper reset after a pre-existing GIT_CONFIG_COUNT", () => {
    const env: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "loki",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "loki@example.com",
    };
    withholdGithubTokens(env);
    expect(env["GIT_CONFIG_COUNT"]).toBe("3");
    expect(env["GIT_CONFIG_KEY_2"]).toBe("credential.helper");
    expect(env["GIT_CONFIG_VALUE_2"]).toBe("");
    // Operator's own overrides at index 0/1 are preserved.
    expect(env["GIT_CONFIG_KEY_0"]).toBe("user.name");
    expect(env["GIT_CONFIG_KEY_1"]).toBe("user.email");
  });

  it("does not reset credential.helper under the opt-out", () => {
    const env: NodeJS.ProcessEnv = { LOKI_ALLOW_AGENT_GITHUB_TOKEN: "1" };
    withholdGithubTokens(env);
    expect(env["GIT_CONFIG_COUNT"]).toBeUndefined();
    expect(env["GIT_CONFIG_KEY_0"]).toBeUndefined();
  });

  // BACKLOG 149 round 3: SSH transport bypass. Round 2 closed the HTTPS
  // (GH_TOKEN/GITHUB_TOKEN/GH_CONFIG_DIR/credential.helper) surface but left
  // SSH_AUTH_SOCK and GIT_SSH_COMMAND untouched -- a reachable SSH agent lets
  // an agent push over an SSH-transport remote unaffected by any round-2
  // mitigation. `git remote set-url origin git@github.com:... && git push`
  // would authenticate exactly as an unrestricted session.
  it("removes SSH_AUTH_SOCK and overrides GIT_SSH_COMMAND by default", () => {
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: GH,
      SSH_AUTH_SOCK: "/tmp/real-agent.sock",
      GIT_SSH_COMMAND: "ssh -i /home/user/.ssh/id_ed25519",
    };
    withholdGithubTokens(env, () => {});
    expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(env["GIT_SSH_COMMAND"]).toBe("false");
  });

  it("removes SSH_AUTH_SOCK even when no GH_TOKEN-family var is present", () => {
    const env: NodeJS.ProcessEnv = { SSH_AUTH_SOCK: "/tmp/real-agent.sock" };
    withholdGithubTokens(env, () => {});
    expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(env["GIT_SSH_COMMAND"]).toBe("false");
  });

  it("overrides GIT_SSH_COMMAND to false even when it was absent before", () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: GH };
    withholdGithubTokens(env, () => {});
    expect(env["GIT_SSH_COMMAND"]).toBe("false");
    expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
  });

  it("keeps the real SSH agent and ssh command under the opt-out", () => {
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: GH,
      SSH_AUTH_SOCK: "/tmp/real-agent.sock",
      GIT_SSH_COMMAND: "ssh -i /home/user/.ssh/id_ed25519",
      LOKI_ALLOW_AGENT_GITHUB_TOKEN: "1",
    };
    withholdGithubTokens(env, () => {});
    expect(env["SSH_AUTH_SOCK"]).toBe("/tmp/real-agent.sock");
    expect(env["GIT_SSH_COMMAND"]).toBe("ssh -i /home/user/.ssh/id_ed25519");
  });
});

// ---------------------------------------------------------------------------
// Through the runner: the provider's own environment.
// ---------------------------------------------------------------------------

class OneIteration implements SignalSource {
  private checks: (0 | 1 | 2)[] = [0, 2];
  async checkHumanIntervention(): Promise<0 | 1 | 2> {
    return this.checks.shift() ?? 2;
  }
  async isBudgetExceeded(): Promise<boolean> {
    return false;
  }
}
class StopNow implements CouncilHook {
  async shouldStop(_ctx: RunnerContext): Promise<boolean> {
    return true;
  }
}

const SAVED = [
  "LOKI_DIR",
  "LOKI_CLAUDE_CLI",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "LOKI_ALLOW_AGENT_GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
];
const REAL_SSH_AUTH_SOCK = "/tmp/moat-p9-fake-agent.sock";
let saved: Record<string, string | undefined>;
let root: string;
let envDump: string;
let stderrLines: string[];
let realStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  root = mkdtempSync(resolve(tmpdir(), "loki-gh-token-"));
  mkdirSync(resolve(root, ".loki", "queue"), { recursive: true });
  envDump = resolve(root, "provider-env.txt");
  const fake = resolve(root, "fake-claude.sh");
  writeFileSync(
    fake,
    `#!/bin/bash
env > '${envDump}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s","model":"opus"}'
printf '%s\\n' '{"type":"result","subtype":"success","duration_ms":1,"is_error":false,"result":"ok"}'
exit 0
`,
  );
  chmodSync(fake, 0o755);
  process.env["LOKI_DIR"] = resolve(root, ".loki");
  process.env["LOKI_CLAUDE_CLI"] = fake;
  process.env["GH_TOKEN"] = GH;
  process.env["GITHUB_TOKEN"] = GHA;
  // Synthetic path only -- never a real agent socket. Models an operator
  // session with a reachable SSH agent (BACKLOG 149 round 3).
  process.env["SSH_AUTH_SOCK"] = REAL_SSH_AUTH_SOCK;
  delete process.env["GIT_SSH_COMMAND"];
  delete process.env["LOKI_ALLOW_AGENT_GITHUB_TOKEN"];
  stderrLines = [];
  realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = realStderrWrite;
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

function opts(): RunnerOpts {
  return {
    cwd: root,
    provider: "claude",
    autonomyMode: "checkpoint",
    maxRetries: 3,
    maxIterations: 5,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    sessionModel: "sonnet",
    loggerStream: { write: () => true } as unknown as NodeJS.WritableStream,
    signals: new OneIteration(),
    council: new StopNow(),
  };
}

const warnings = (): number =>
  stderrLines.join("").split("\n").filter((l) => l.startsWith(AGENT_TOKEN_WARNING_PREFIX)).length;

describe("runAutonomous withholds GitHub tokens from the provider", () => {
  it("default: the spawned provider sees neither token, and nothing warns", async () => {
    await runAutonomous(opts());
    const dump = readFileSync(envDump, "utf8");
    expect(dump).toContain("LOKI_DIR="); // the dump is live: inherited vars do show
    expect(dump).not.toContain(GH);
    expect(dump).not.toContain(GHA);
    // BACKLOG 149 round 2: the provider must see a sentinel, not an absent
    // var -- proves the fix sentinels rather than merely deletes.
    expect(dump).toMatch(/GH_TOKEN=ghp_LOKIWITHHELDsentinel/);
    expect(dump).toMatch(/GH_CONFIG_DIR=/);
    expect(dump).toMatch(/GIT_CONFIG_KEY_0=credential\.helper/);
    // BACKLOG 149 round 3: the provider must not inherit a reachable SSH
    // agent, and any ssh-transport git operation it attempts must fail
    // closed via GIT_SSH_COMMAND=false.
    expect(dump).not.toContain(`SSH_AUTH_SOCK=${REAL_SSH_AUTH_SOCK}`);
    expect(dump).not.toMatch(/^SSH_AUTH_SOCK=/m);
    expect(dump).toMatch(/^GIT_SSH_COMMAND=false$/m);
    expect(warnings()).toBe(0);
  });

  it("LOKI_ALLOW_AGENT_GITHUB_TOKEN=1: the provider holds both tokens, one warning line", async () => {
    process.env["LOKI_ALLOW_AGENT_GITHUB_TOKEN"] = "1";
    await runAutonomous(opts());
    const dump = readFileSync(envDump, "utf8");
    expect(dump).toContain(`GH_TOKEN=${GH}`);
    expect(dump).toContain(`GITHUB_TOKEN=${GHA}`);
    // The opt-out is the operator's explicit choice to keep the old, fully
    // inherited behavior -- the real SSH agent must reach the provider too.
    expect(dump).toContain(`SSH_AUTH_SOCK=${REAL_SSH_AUTH_SOCK}`);
    expect(warnings()).toBe(1);
  });
});
