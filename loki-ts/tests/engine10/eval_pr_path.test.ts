// E-51: regression test of the E-41 (local-origin push) plus E-42 (real
// supervisor/worker entry) path used by the eval harness (eval/loki10). A v10
// run with a pinned local bare origin and no --no-pr must push the branch to
// that origin, emit pr.opened as local://<origin>#<branch>, and never let a
// canary GH_TOKEN reach the worker or the origin's own receive-side hook.
//
// The push script (autonomy/lib/engine10-push.sh) runs the local push through
// a scrubbed `env -i` git invocation (see its comments): the bare origin's own
// hooks still fire (git does not pass -c core.hooksPath to receive-pack), but
// only inherit that scrubbed environment, never the ambient one carrying the
// real token. A post-receive hook that dumps its own env is the check for that.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "e2e"); // reuses E-42's tiny bun repo and stub claude
const STUB_DIR = join(FIX, "bin");
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "cli.ts");
const CANARY = "ghp_EVALPRPATHCANARYnotarealtoken00000";
const TASK = "add a multiply(a, b) function to calc.ts";

const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

interface Run {
  repo: string; origin: string; code: number; out: string;
  events: { type: string; stage: string | null; data: Record<string, unknown> }[];
  runId: string; runDir: string; stubEnv: string; hookEnv: string;
}

function runEngine(): Run {
  if (!existsSync(ENTRY)) throw new Error(`engine entry missing: ${ENTRY}`);
  const tmp = mkdtempSync(join(tmpdir(), "loki-eval-pr-path-"));
  temps.push(tmp);
  const repo = join(tmp, "repo");
  cpSync(join(FIX, "repo"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "eval-pr-path");
  git(repo, "config", "user.email", "eval-pr-path@example.invalid");
  git(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml");
  git(repo, "commit", "-q", "-m", "base");

  // E-41's pinned local bare origin: main pushed first, so the engine's own
  // branch push (a different ref) is the one under test.
  const origin = join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");

  // Receive-side hook: dumps the env receive-pack ran it with. If the
  // canary ever reached the ambient env feeding the push, it would show here.
  const hookEnvLog = join(tmp, "hook-env.log");
  writeFileSync(join(origin, "hooks", "post-receive"), `#!/bin/sh\nenv > ${JSON.stringify(hookEnvLog)}\n`);
  chmodSync(join(origin, "hooks", "post-receive"), 0o755);

  const stubEnvLog = join(tmp, "stub-env.log");
  const env: Record<string, string | undefined> = {
    ...process.env,
    LOKI_ENGINE: "v10",
    LOKI_TS_ENTRY: ENTRY,
    LOKI_E10_INVOKER: "cli",
    LOKI_CLAUDE_CLI: join(STUB_DIR, "claude"),
    PATH: `${STUB_DIR}:${process.env.PATH ?? ""}`,
    E2E_STUB_MODE: "done",
    E2E_STUB_ENV_LOG: stubEnvLog,
    LOKI_NO_BROWSER: "1",
    GH_TOKEN: CANARY,
  };
  delete env.LOKI_ALLOW_AGENT_GITHUB_TOKEN;
  delete env.LOKI_MODEL_OVERRIDE;
  delete env.LOKI_LEGACY_BASH; // bin/loki would skip the engine10 block
  delete env.LOKI_RECEIPT_SIGNING_KEY;
  env.LOKI_RECEIPT_SIGNING_KEY_FILE = join(tmp, "k.pem"); // throwaway auto-generated key, never the real ~/.loki

  // No --no-pr: this is the eval harness's real path (E-38's v10 arm).
  const r = Bun.spawnSync(["bash", BIN_LOKI, TASK], { cwd: repo, env, timeout: 60_000 });
  const out = r.stdout.toString() + r.stderr.toString();
  const marker = join(repo, ".loki", "engine.json");
  const m = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { run_id: string; events: string }) : null;
  const eventsPath = m ? join(repo, m.events) : "";
  const events = eventsPath && existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  return {
    repo, origin, code: r.exitCode ?? -1, out, events,
    runId: m?.run_id ?? "", runDir: m ? join(repo, ".loki", "runs", m.run_id) : "",
    stubEnv: existsSync(stubEnvLog) ? readFileSync(stubEnvLog, "utf8") : "",
    hookEnv: existsSync(hookEnvLog) ? readFileSync(hookEnvLog, "utf8") : "",
  };
}

describe("engine10 eval PR path (E-41 plus E-42, local bare origin)", () => {
  test("branch lands on the bare origin, pr.opened is local://, no canary token anywhere", () => {
    const r = runEngine();
    if (r.code !== 0) console.error(r.out);
    expect(r.code).toBe(0);
    expect(r.runId).not.toBe("");

    const branch = `loki/${r.runId}`;
    // The branch was pushed to the bare origin (not just committed locally).
    expect(git(r.origin, "rev-parse", `refs/heads/${branch}`)).toBe(git(r.repo, "rev-parse", "HEAD"));

    const opened = r.events.filter((e) => e.type === "pr.opened");
    expect(opened.length).toBe(1);
    expect(opened[0]!.data.url).toBe(`local://${r.origin}#${branch}`);
    expect(r.out).toContain(`PR:         local://${r.origin}#${branch}`);

    // The hook actually ran (a vacuous pass would mean it never fired).
    expect(r.hookEnv).not.toBe("");
    expect(r.hookEnv).not.toContain(CANARY);
    // The worker (the stub claude session) never saw the token either.
    expect(r.stubEnv).not.toContain(CANARY);
    expect(r.stubEnv).toContain(`GH_TOKEN=ghp_LOKIWITHHELDsentinel`);

    // Belt and suspenders: the canary appears nowhere under .loki (events,
    // receipt, efficiency records) or in either captured environment dump.
    const leaked = Bun.spawnSync(["grep", "-rl", CANARY, join(r.repo, ".loki")], { env: process.env });
    expect(leaked.stdout.toString()).toBe("");
  }, 90_000);
});
