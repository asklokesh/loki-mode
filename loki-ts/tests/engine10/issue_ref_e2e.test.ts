// E-47: issue-ref end to end (docs/v10/ENGINE.md sections 4 and 6). Runs the
// real engine from the real entry (bin/loki, LOKI_ENGINE=v10,
// LOKI_TS_ENTRY=src/cli.ts, stub claude via LOKI_E10_INVOKER=cli) on a task
// that is an issue reference, in both accepted forms (owner/repo#N and a
// GitHub issue URL). A stub gh serves fixture issue JSON, so the run needs no
// network. Rule of Two: the fetch child (P1, in the supervisor process) runs
// with a real GH_TOKEN; the worker (spawned after withholdGithubTokens) never
// sees it.
//
// Test-only slice; the file set is fixtures and this test, per the BOARD row.
// All three cases below are currently RED, and every one is red for the same
// single reason, verified by a local, uncommitted trial edit (never landed):
// loki-ts/src/engine10/supervisor.ts's `main()`, in the `isIssue` branch,
// calls `fetchIssueToFile(task, join(runDir, "issue.json"))` before anything
// creates `runDir` (`.loki/runs/<runId>`). Node's `writeFileSync` does not
// create missing parent directories, so every issue-ref run fails immediately
// with ENOENT and `main()` returns 2, before intake or any stage ever runs.
// Adding one `mkdirSync(runDir, { recursive: true })` ahead of that call (out
// of scope for this test-only slice) turns all three tests here green with no
// other change, confirming the fixtures and assertions match the documented
// contract (ENGINE.md sections 4 and 6, fetch_issue.ts's own header comment).
// This is a real gap in already-merged code, not a documented-but-unbuilt
// E-42 dependency: it should become its own fix slice.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "issue-ref");
const STUB_DIR = join(FIX, "bin");
const ENTRY = process.env.E2E_LOKI_TS_ENTRY ?? join(LOKI_TS, "src", "cli.ts");
const CANARY = "ghp_ISSUEREFCANARYnotarealtoken00000000";

const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

interface Run {
  repo: string; code: number; out: string;
  events: { seq: number; type: string; stage: string | null; data: Record<string, unknown> }[];
  runDir: string; stubCalls: string[]; stubEnv: string; ghLog: string; brief: string;
}

/** Runs one issue-ref task (`ref`) against the fixture issue for `issueNumber`. */
function runEngine(ref: string, issueNumber: number): Run {
  if (!existsSync(ENTRY)) throw new Error(`engine entry missing: ${ENTRY}`); // never fall through to the legacy bash route
  const tmp = mkdtempSync(join(tmpdir(), "loki-issue-ref-"));
  temps.push(tmp);
  const repo = join(tmp, "repo");
  cpSync(join(FIX, "repo"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "e2e");
  git(repo, "config", "user.email", "e2e@example.invalid");
  git(repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml");
  git(repo, "commit", "-q", "-m", "base");
  const stubLog = join(tmp, "stub.log");
  const stubEnvLog = join(tmp, "stub-env.log");
  const briefLog = join(tmp, "brief.log");
  const ghLog = join(tmp, "gh.log");
  const env: Record<string, string | undefined> = {
    ...process.env,
    LOKI_ENGINE: "v10",
    LOKI_TS_ENTRY: ENTRY,
    LOKI_E10_INVOKER: "cli",
    LOKI_CLAUDE_CLI: join(STUB_DIR, "claude"),
    PATH: `${STUB_DIR}:${process.env.PATH ?? ""}`,
    ISSUE_REF_STUB_LOG: stubLog,
    ISSUE_REF_STUB_ENV_LOG: stubEnvLog,
    ISSUE_REF_STUB_BRIEF_LOG: briefLog,
    ISSUE_REF_GH_LOG: ghLog,
    LOKI_NO_BROWSER: "1",
    GH_TOKEN: CANARY, // stands in for a real operator credential
  };
  delete env.LOKI_ALLOW_AGENT_GITHUB_TOKEN;
  delete env.LOKI_MODEL_OVERRIDE;
  delete env.LOKI_LEGACY_BASH; // bin/loki would skip the engine10 block
  delete env.LOKI_RECEIPT_SIGNING_KEY;
  env.LOKI_RECEIPT_SIGNING_KEY_FILE = join(tmp, "k.pem"); // throwaway auto-generated key, never the real ~/.loki
  const r = Bun.spawnSync(["bash", BIN_LOKI, ref, "--no-pr"], { cwd: repo, env, timeout: 60_000 });
  const out = r.stdout.toString() + r.stderr.toString();
  const marker = join(repo, ".loki", "engine.json");
  const m = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { run_id: string; events: string }) : null;
  const eventsPath = m ? join(repo, m.events) : "";
  const events = eventsPath && existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const stubCalls = existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean) : [];
  const stubEnv = existsSync(stubEnvLog) ? readFileSync(stubEnvLog, "utf8") : "";
  const ghLogContent = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
  const brief = existsSync(briefLog) ? readFileSync(briefLog, "utf8") : "";
  void issueNumber;
  return { repo, code: r.exitCode ?? -1, out, events, runDir: m ? join(repo, ".loki", "runs", m.run_id) : "", stubCalls, stubEnv, ghLog: ghLogContent, brief };
}

describe("engine10 issue-ref e2e (stub gh, stub claude)", () => {
  test("owner/repo#N: fetch child runs with credentials, intake uses title+body, worker never sees GH_TOKEN", () => {
    const r = runEngine("acme/widgets#101", 101);
    if (r.code !== 0) console.error(r.out);
    expect(r.code).toBe(0);

    // The fetch child (P1, runs inside the supervisor process before the
    // worker is spawned) saw the real credential.
    expect(r.ghLog).toContain(`GH_TOKEN=${CANARY}`);

    // Intake used the fixture's title and body (never a re-derivation from
    // the raw ref), and nothing that only the P1 fetch fields would carry
    // (state, closedByPullRequestsReferences) leaked into the task text.
    const intake = r.events.find((e) => e.type === "stage.completed" && e.stage === "intake");
    expect(intake).toBeDefined();
    expect(intake!.data.source).toBe("issue");
    expect(intake!.data.task).toContain("Add subtract function to calc.ts");
    expect(intake!.data.task).toContain("ISSUE-BODY-MARKER-9f3a");
    expect(intake!.data.title).toBe("Add subtract function to calc.ts");
    expect(intake!.data.already_satisfied).toBe(false);

    // The issue text reached the implement brief the provider session saw.
    expect(r.brief).toContain("Add subtract function to calc.ts");
    expect(r.brief).toContain("ISSUE-BODY-MARKER-9f3a");

    // Rule of Two: the worker's session never saw the real token, only the
    // withholdGithubTokens sentinel.
    expect(r.stubEnv).toContain("implement GH_TOKEN=ghp_LOKIWITHHELDsentinel");
    expect(r.stubEnv).not.toContain(CANARY);
    const leaked = Bun.spawnSync(["grep", "-rl", CANARY, join(r.repo, ".loki")], { env: process.env });
    expect(leaked.stdout.toString()).toBe("");

    const receipt = JSON.parse(readFileSync(join(r.runDir, "receipt.json"), "utf8"));
    expect(receipt.verdict).toBe("VERIFIED");
    expect(readFileSync(join(r.repo, "calc.ts"), "utf8")).toContain("subtract");
  }, 90_000);

  test("a GitHub issue URL is accepted the same way as owner/repo#N", () => {
    const r = runEngine("https://github.com/acme/widgets/issues/101", 101);
    if (r.code !== 0) console.error(r.out);
    expect(r.code).toBe(0);
    const intake = r.events.find((e) => e.type === "stage.completed" && e.stage === "intake");
    expect(intake!.data.task).toContain("Add subtract function to calc.ts");
    const receipt = JSON.parse(readFileSync(join(r.runDir, "receipt.json"), "utf8"));
    expect(receipt.verdict).toBe("VERIFIED");
  }, 90_000);

  test("a closed issue with no executed check is NOT PROVEN (FC-16), with no implement session", () => {
    const r = runEngine("acme/widgets#202", 202);

    // No implement session at all: intake's already_satisfied short-circuit
    // (machine.ts earlyExit) skips plan, wall, implement, verify and fix.
    expect(r.stubCalls).toEqual([]);
    expect(r.events.some((e) => e.stage === "implement")).toBe(false);
    expect(r.events.some((e) => e.stage === "plan")).toBe(false);
    expect(r.events.some((e) => e.stage === "wall")).toBe(false);

    const intake = r.events.find((e) => e.type === "stage.completed" && e.stage === "intake");
    expect(intake!.data.already_satisfied).toBe(true);

    const receipt = JSON.parse(readFileSync(join(r.runDir, "receipt.json"), "utf8"));
    expect(receipt.verdict).toBe("PARTIAL");
    expect(receipt.not_proven).toContain("no tests executed");
    expect(receipt.head_sha).toBe(receipt.base_sha);
    expect(readFileSync(join(r.repo, "calc.ts"), "utf8")).not.toContain("subtract");
    expect(r.out).not.toContain("Outcome:    ALREADY_SATISFIED");
  }, 90_000);
});
