// E-47: issue-ref end to end (docs/v10/ENGINE.md sections 4 and 6). Runs the
// real engine from the real entry (bin/loki,
// LOKI_TS_ENTRY=src/cli.ts, stub claude via LOKI_E10_INVOKER=cli) on a task
// that is an issue reference, in both accepted forms (owner/repo#N and a
// GitHub issue URL). A stub gh serves fixture issue JSON, so the run needs no
// network. Rule of Two: the fetch child (P1, in the supervisor process) runs
// with a real GH_TOKEN; the worker (spawned after withholdGithubTokens) never
// sees it.
//
// P12-13 adds the vertical slice (kill -9 mid-implement, comment steer, resume, PR branch, receipt revision) and the
// U-journeys below. The stub claude blocks on $ISSUE_REF_STUB_HANG_DIR/hang-<stage> so the test can kill -9 the run's
// recorded process chain at a known point; a local bare origin takes the E-41 local PR path, so no network is needed.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface Prep { tmp: string; repo: string; env: Record<string, string | undefined>; stubLog: string; briefLog: string; ghLog: string; hangDir: string; origin: string }

/** Fresh fixture repo plus the env every case shares. `withOrigin` adds a local bare origin (the E-41 local PR path), so a PR can open with no network. */
function prep(withOrigin = false, extra: Record<string, string> = {}): Prep {
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
  const origin = join(tmp, "origin.git");
  if (withOrigin) {
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
  }
  const stubLog = join(tmp, "stub.log"), briefLog = join(tmp, "brief.log"), ghLog = join(tmp, "gh.log"), hangDir = join(tmp, "hang");
  mkdirSync(hangDir);
  const env: Record<string, string | undefined> = {
    ...process.env,
    LOKI_TS_ENTRY: ENTRY,
    LOKI_E10_INVOKER: "cli",
    LOKI_CLAUDE_CLI: join(STUB_DIR, "claude"),
    PATH: `${STUB_DIR}:${process.env.PATH ?? ""}`,
    ISSUE_REF_STUB_LOG: stubLog,
    ISSUE_REF_STUB_ENV_LOG: join(tmp, "stub-env.log"),
    ISSUE_REF_STUB_BRIEF_LOG: briefLog,
    ISSUE_REF_STUB_HANG_DIR: hangDir,
    ISSUE_REF_STUB_PLAN_BRIEF_LOG: join(tmp, "plan-brief.log"),
    ISSUE_REF_GH_LOG: ghLog,
    LOKI_NO_BROWSER: "1",
    GH_TOKEN: CANARY, // stands in for a real operator credential
    ...extra,
  };
  delete env.LOKI_ALLOW_AGENT_GITHUB_TOKEN;
  delete env.LOKI_MODEL_OVERRIDE;
  delete env.LOKI_LEGACY_BASH; // bin/loki would skip the engine10 block
  delete env.LOKI_RECEIPT_SIGNING_KEY;
  env.LOKI_RECEIPT_SIGNING_KEY_FILE = join(tmp, "k.pem"); // throwaway auto-generated key, never the real ~/.loki
  return { tmp, repo, env, stubLog, briefLog, ghLog, hangDir, origin };
}

type Ev = { seq: number; type: string; stage: string | null; data: Record<string, unknown> };
function readRun(p: Prep): { events: Ev[]; runDir: string } {
  const marker = join(p.repo, ".loki", "engine.json");
  const m = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { run_id: string; events: string }) : null;
  const eventsPath = m ? join(p.repo, m.events) : "";
  const events = eventsPath && existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev)
    : [];
  return { events, runDir: m ? join(p.repo, ".loki", "runs", m.run_id) : "" };
}
const slurp = (f: string): string => (existsSync(f) ? readFileSync(f, "utf8") : "");

/** Runs one issue-ref task (`ref`) against the fixture issue for `issueNumber`. */
function runEngine(ref: string, issueNumber: number): Run {
  const p = prep();
  const r = Bun.spawnSync(["bash", BIN_LOKI, ref, "--no-pr"], { cwd: p.repo, env: p.env, timeout: 60_000 });
  const out = r.stdout.toString() + r.stderr.toString();
  const { events, runDir } = readRun(p);
  const stubCalls = slurp(p.stubLog).trim().split("\n").filter(Boolean);
  void issueNumber;
  return { repo: p.repo, code: r.exitCode ?? -1, out, events, runDir, stubCalls, stubEnv: slurp(join(p.tmp, "stub-env.log")), ghLog: slurp(p.ghLog), brief: slurp(p.briefLog) };
}

describe("engine10 issue-ref e2e (stub gh, stub claude)", () => {
  test("owner/repo#N: fetch child runs with credentials, intake uses title+body, Loki never passes GH_TOKEN into the worker environment", () => {
    const r = runEngine("acme/widgets#101", 101);
    if (r.code !== 0) console.error(r.out);
    expect(r.code).toBe(0);

    // The fetch child (P1, runs inside the supervisor process before the
    // worker is spawned) saw the real credential.
    expect(r.ghLog).toContain(`GH_TOKEN=${CANARY}`);

    // FV-work-item-2: run.started records who asked and the intent keys (no policy file, no parent run here).
    const started = r.events.find((e) => e.type === "run.started");
    expect(started!.data.actor).toBe("e2e");
    expect(started!.data.policy_revision).toBeNull();
    expect(started!.data.parent_run).toBeNull();

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

/** Runs argv in the fixture repo; resolves with exit code and combined output. */
async function exec(p: Prep, argv: string[], extra: Record<string, string> = {}, timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { cwd: p.repo, env: { ...p.env, ...extra }, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: o + e };
}

const ppidOf = (pid: number): number => Number(Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString().trim() || 0);

/** Starts an issue run whose stub blocks in `stage`, waits for the stub to announce itself, then kill -9s the stub's whole ancestry (stub, worker, supervisor) as recorded pids. */
async function startAndKill9(p: Prep, ref: string, stage: "plan" | "implement"): Promise<void> {
  const hang = join(p.hangDir, `hang-${stage}`);
  writeFileSync(hang, "1");
  const proc = Bun.spawn(["bash", BIN_LOKI, ref], { cwd: p.repo, env: p.env, stdout: "ignore", stderr: "ignore" });
  const pidFile = join(p.hangDir, "pid");
  for (let i = 0; i < 300 && !existsSync(pidFile); i++) await Bun.sleep(100);
  if (!existsSync(pidFile)) { proc.kill(9); throw new Error(`stub never reached ${stage}`); }
  const chain: number[] = [];
  for (let pid = Number(readFileSync(pidFile, "utf8").trim()); pid > 1 && pid !== process.pid && chain.length < 10; pid = ppidOf(pid)) { chain.push(pid); if (pid === proc.pid) break; }
  expect(chain).toContain(proc.pid);
  for (const pid of chain.reverse()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  await proc.exited;
  rmSync(hang);
  rmSync(pidFile);
}

const COMMENT = "https://github.com/acme/widgets/issues/101#issuecomment-5";
const steerFromComment = (p: Prep, text: string) => exec(p, ["bash", BIN_LOKI, "steer", text], { LOKI_STEER_SOURCE: COMMENT, LOKI_STEER_ACTOR: "octocat" }); // what the trigger server runs for an issue comment
const resume = (p: Prep) => exec(p, [process.execPath, ENTRY, "engine10", "--resume"]);
const stageDone = (events: Ev[], stage: string) => events.find((e) => e.type === "stage.completed" && e.stage === stage);

describe("engine10 issue-ref vertical slice: kill -9, comment steer, resume, PR, receipt revision (P12-13)", () => {
  test("kill -9 mid-implement, resume: settled stages are not rerun, the PR branch lands at the resumed commit, the receipt is VERIFIED", async () => {
    const p = prep(true);
    await startAndKill9(p, "acme/widgets#101", "implement");
    const killed = readRun(p);
    expect(killed.events.some((e) => e.type === "run.started")).toBe(true);
    expect(killed.events.some((e) => e.type === "run.completed")).toBe(false);
    expect(stageDone(killed.events, "intake")).toBeDefined();

    const res = await resume(p);
    if (res.code !== 0) console.error(res.out);
    expect(res.code).toBe(0);
    const { events, runDir } = readRun(p);
    expect(events.filter((e) => e.type === "run.resumed")).toHaveLength(1);
    expect(slurp(p.stubLog).trim().split("\n")).toEqual(["implement", "implement"]); // killed once, rerun once; intake, plan and wall are not model sessions on this tier
    const opened = events.find((e) => e.type === "pr.opened");
    expect(String(opened!.data.url)).toStartWith("local://");
    const branch = String(opened!.data.url).split("#")[1]!;
    expect(git(p.origin, "rev-parse", `refs/heads/${branch}`)).toBe(String(stageDone(events, "commit")!.data.head_sha));
    expect(JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8")).verdict).toBe("VERIFIED");
  }, 120_000);

  test("a comment steer written while the run is dead is applied by the resumed implement session and sealed as receipt revision 1", async () => {
    const p = prep(true);
    await startAndKill9(p, "acme/widgets#101", "implement");
    expect((await steerFromComment(p, "STEER-LATE-3d2e keep it to subtract only")).code).toBe(0);
    const res = await resume(p);
    if (res.code !== 0) console.error(res.out);
    expect(res.code).toBe(0);
    const { events, runDir } = readRun(p);
    expect(slurp(p.briefLog)).toContain("STEER-LATE-3d2e");
    const receipt = JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8"));
    expect(receipt.verdict).toBe("VERIFIED"); // the Wall was skipped on this tier, so no frozen tests went stale
    expect(receipt.intent_revisions).toEqual([expect.objectContaining({ rev: 1, source: COMMENT, actor: "octocat" })]);
    expect(events.find((e) => e.type === "pr.opened")).toBeDefined();
  }, 120_000);

  test("a steer queued before the run, then kill -9 and resume, still seals with its revision", async () => {
    const p = prep(true);
    mkdirSync(join(p.repo, ".loki"), { recursive: true }); // `loki steer` needs the state dir; a comment can arrive while the issue is still queued
    expect((await steerFromComment(p, "STEER-EARLY-91ab prefer a pure function")).code).toBe(0);
    await startAndKill9(p, "acme/widgets#101", "implement");
    const res = await resume(p);
    if (res.code !== 0) console.error(res.out);
    expect(res.code).toBe(0);
    const { events, runDir } = readRun(p);
    expect(events.some((e) => e.type === "run.resumed")).toBe(true);
    const receipt = JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8"));
    expect(receipt.verdict).toBe("VERIFIED");
    expect(receipt.intent_revisions).toEqual([expect.objectContaining({ rev: 1, source: COMMENT, actor: "octocat" })]);
  }, 120_000);

  test("a completed Wall, then kill -9, then a late comment steer: the resumed run is refused at Seal, not VERIFIED (P12-13c)", async () => {
    const p = prep(true, { LOKI_E10_PLAN: "always" }); // forces a real Wall on this small task
    await startAndKill9(p, "acme/widgets#101", "implement");
    const killed = readRun(p);
    expect(stageDone(killed.events, "wall")).toBeDefined();
    expect(killed.events.some((e) => e.type === "wall.sealed")).toBe(true);
    expect((await steerFromComment(p, "STEER-AFTER-WALL-77c1 also add multiply")).code).toBe(0);
    const res = await resume(p);
    expect(res.code).not.toBe(0);
    const { events, runDir } = readRun(p);
    const sealFail = events.find((e) => e.type === "stage.failed" && e.stage === "seal");
    expect(String(sealFail?.data.reason)).toContain("arrived after the Wall was frozen");
    const receiptPath = join(runDir, "receipt.json");
    if (existsSync(receiptPath)) expect(JSON.parse(readFileSync(receiptPath, "utf8")).verdict).not.toBe("VERIFIED");
  }, 180_000);
});

// U1-U8 user journeys (docs/v10/PLAN-V12.md S13/N4 name them without a table, so these are the eight this file pins):
// U1 issue ref to verified, U2 issue URL, U3 closed issue not proven (the three cases above), U4 kill -9 then resume,
// U5 comment steer during an outage, U6 steer queued before the run (the vertical slice block), U7 unknown issue, U8 nothing to resume, U9 PR updated.
describe("engine10 issue-ref user journeys U7-U9 (recorded fixtures, no paid models)", () => {
  test("U7: an issue with no fixture fails before any model session and leaves no PR or run branch", async () => {
    const p = prep(true);
    const r = await exec(p, ["bash", BIN_LOKI, "acme/widgets#999"]);
    expect(r.code).not.toBe(0);
    expect(slurp(p.stubLog)).toBe("");
    expect(git(p.origin, "branch", "--list", "loki/*")).toBe("");
  }, 60_000);

  test("U8: resume with nothing interrupted exits 3 and says so", async () => {
    const p = prep(true);
    expect((await exec(p, ["bash", BIN_LOKI, "acme/widgets#101"])).code).toBe(0);
    const r = await resume(p);
    expect(r.code).toBe(3);
    expect(r.out).toContain("no interrupted engine10 run");
  }, 120_000);

  test("U9: PR updated: pr-ready edits the body then readies, and comment posts, as recorded stub gh calls", async () => {
    const p = prep(true);
    const calls = join(p.tmp, "gh-calls.tsv");
    const prUrl = "https://github.com/acme/widgets/pull/7";
    const body = join(p.tmp, "body.md");
    writeFileSync(body, "updated PR body\n");
    const push = resolve(LOKI_TS, "../autonomy/lib/engine10-push.sh");
    const pinned = { _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: "https://github.com/acme/widgets.git", ISSUE_REF_GH_CALLS: calls, ISSUE_REF_GH_PR_URL: prUrl };
    const ready = await exec(p, ["bash", push, "pr-ready", p.repo, "loki/issue-101", body, prUrl], pinned);
    expect(ready.code).toBe(0);
    const cmt = await exec(p, ["bash", push, "comment", "7", body], pinned);
    expect(cmt.code).toBe(0);
    const rec = slurp(calls).trim().split("\n").map((l) => l.split("\t"));
    const pr = rec.filter((a) => a[0] === "pr");
    expect(pr.map((a) => a[1])).toEqual(["list", "edit", "ready", "comment"]);
    expect(pr[1]).toEqual(["pr", "edit", prUrl, "--repo", "acme/widgets", "--body-file", body]);
    expect(pr[2]).toEqual(["pr", "ready", prUrl, "--repo", "acme/widgets"]);
    expect(pr[3]).toEqual(["pr", "comment", "7", "--repo", "acme/widgets", "--body-file", body]);
  }, 60_000);

  test("U9b: the stub gh records argv for pr create the same way as pr edit and comment (P12-13b)", async () => {
    const p = prep(true);
    const calls = join(p.tmp, "gh-calls.tsv");
    const prUrl = "https://github.com/acme/widgets/pull/7";
    const r = await exec(p, ["gh", "pr", "create", "--repo", "acme/widgets", "--head", "loki/issue-101", "--title", "T", "--body-file", "b.md", "--draft"], { ISSUE_REF_GH_CALLS: calls, ISSUE_REF_GH_PR_URL: prUrl });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(prUrl);
    expect(slurp(calls).trim().split("\n").map((l) => l.split("\t"))).toEqual([["pr", "create", "--repo", "acme/widgets", "--head", "loki/issue-101", "--title", "T", "--body-file", "b.md", "--draft"]]);
  }, 60_000);
});

describe("engine10 loki answer: a BLOCKED run resumes in place under the same run id (stub provider)", () => {
  test("answer joins the task, run.resumed (not a second run.started) is appended, settled stages are not re-run, the receipt is VERIFIED", async () => {
    const p = prep(true, { ISSUE_REF_STUB_CONFLICT: "1" });
    const first = await exec(p, ["bash", BIN_LOKI, "acme/widgets#101"]);
    expect(first.code).toBe(4);
    const blocked = readRun(p);
    const runId = (JSON.parse(readFileSync(join(p.repo, ".loki", "engine.json"), "utf8")) as { run_id: string }).run_id;
    expect(blocked.events.findLast((e) => e.type === "run.completed")!.data.verdict).toBe("SPEC_CONFLICT");
    const implementCalls = slurp(p.stubLog).trim().split("\n").filter((l) => l === "implement").length;
    expect(implementCalls).toBe(2); // the conflict and its one correction round

    const wrong = await exec(p, [process.execPath, ENTRY, "answer", "e10-nope", "x"]);
    expect(wrong.code).toBe(2);

    const ans = await exec(p, [process.execPath, ENTRY, "answer", runId, "yes, clamp at zero"]);
    if (ans.code !== 0) console.error(ans.out);
    expect(ans.code).toBe(0);
    const { events, runDir } = readRun(p);
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(1);
    const resumed = events.filter((e) => e.type === "run.resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.data.answered).toBe(true);
    expect(resumed[0]!.data.answer).toBe("yes, clamp at zero");
    expect(events.filter((e) => e.type === "stage.completed" && e.stage === "intake")).toHaveLength(1); // settled stage restored, not re-run
    expect(slurp(p.stubLog).trim().split("\n").filter((l) => l === "implement")).toHaveLength(3); // the answered attempt is one more implement session
    expect(slurp(p.briefLog)).toContain("Clarification answering");
    expect(slurp(p.briefLog)).toContain("yes, clamp at zero");
    expect(events.findLast((e) => e.type === "run.completed")!.data.verdict).toBe("VERIFIED");
    expect(JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8")).verdict).toBe("VERIFIED");

    const again = await exec(p, [process.execPath, ENTRY, "answer", runId, "again"]);
    expect(again.code).toBe(2); // no longer BLOCKED
  }, 180_000);

  // seal_drift boundEvents cuts at a log.sealed NOT followed by run.resumed, so the first (BLOCKED) seal of a resumed run does not truncate the bound log.
  test("verify of the answered run is VERIFIED", async () => {
    const p = prep(true, { ISSUE_REF_STUB_CONFLICT: "1" });
    expect((await exec(p, ["bash", BIN_LOKI, "acme/widgets#101"])).code).toBe(4);
    const runId = (JSON.parse(readFileSync(join(p.repo, ".loki", "engine.json"), "utf8")) as { run_id: string }).run_id;
    expect((await exec(p, [process.execPath, ENTRY, "answer", runId, "yes, clamp at zero"])).code).toBe(0);
    const ver = await exec(p, [process.execPath, ENTRY, "engine10", "verify", runId]);
    expect(ver.out).not.toContain("TAMPERED");
    expect(ver.out).not.toContain("no test.result pass");
    expect(ver.out).toMatch(/\bVERIFIED\b/);
    expect(ver.code).toBe(0);
  }, 180_000);

  test("a tampered second segment of the answered run still reads TAMPERED", async () => {
    const p = prep(true, { ISSUE_REF_STUB_CONFLICT: "1" });
    expect((await exec(p, ["bash", BIN_LOKI, "acme/widgets#101"])).code).toBe(4);
    const runId = (JSON.parse(readFileSync(join(p.repo, ".loki", "engine.json"), "utf8")) as { run_id: string }).run_id;
    expect((await exec(p, [process.execPath, ENTRY, "answer", runId, "yes, clamp at zero"])).code).toBe(0);
    const log = join(readRun(p).runDir, "events.jsonl");
    const lines = readFileSync(log, "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes('"run.resumed"'));
    expect(at).toBeGreaterThan(0);
    const later = lines.findIndex((l, i) => i > at && l.includes('"test.result"'));
    expect(later).toBeGreaterThan(at);
    lines[later] = lines[later]!.replace('"pass"', '"fail"');
    writeFileSync(log, lines.join("\n"));
    const ver = await exec(p, [process.execPath, ENTRY, "engine10", "verify", runId]);
    expect(ver.code).not.toBe(0);
    expect(ver.out).toContain("TAMPERED");
  }, 180_000);
});
