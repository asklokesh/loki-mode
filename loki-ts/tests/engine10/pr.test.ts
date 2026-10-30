// loki-ts/tests/engine10/pr.test.ts
//
// E-11 (TS half) wall check. supervisor.ts/E-03 and machine.ts/E-02 are in
// rework and not on main, so RunContext deps are fakes and the push child is
// a stub script at an injected path (never the real, credentialed
// autonomy/lib/engine10-push.sh).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PUSH_GITLAB_SH, DEFAULT_PUSH_SH, runPr, stage } from "../../src/engine10/stages/pr.ts"; import { pushErrLine } from "../../src/util/term_width.ts";
import { publishFallback } from "../../src/util/engine_origin.ts";
import { receiptSha256, signReceipt } from "../../src/engine10/stages/seal.ts";
import { readEvents } from "../../src/engine10/events.ts"; import { stageCapability } from "../../src/engine10/worker.ts";
import { computeKey, shallowDirs } from "../../src/project_model/gather.ts";
import { renderMainOutput } from "../../src/engine10/supervisor.ts";
import { summaryTier, tierSealFor } from "../../src/util/run_outputs.ts";
import { SupervisorLog } from "../../src/engine10/supervisor.ts";
import { RECOVERY_ABORT, discardRun, findInterrupted, nextStepText, parseRecoveryChoice, phaseOf, resumeMain, startRecovery, statusNextStep, type RunPrFn } from "../../src/util/run_outputs.ts";
import type { CostReader, RunContext, SessionRunner, TestMapProvider, Verdict } from "../../src/engine10/types.ts";

const PR_URL = "https://github.com/octocat/hello/pull/42";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-pr-repo-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  return dir;
}

/** Writes a fake engine10-push.sh: logs every call (mode, args, the two pin
 *  env vars) to logPath, then prints PR_URL for push-pr and exits 0 for
 *  status. failOn makes one mode exit 2 with a stderr message instead. */
function writeStub(dir: string, logPath: string, failOn?: "push-pr" | "status", printUrl: string = PR_URL, marker = ""): string {
  const scriptPath = join(dir, "push-stub.sh");
  const content = `#!/bin/sh
mode="$1"; shift
printf 'CALL mode=%s args=%s\\n' "$mode" "$*" >> "${logPath}"
printf 'ENV pinned=%s origin=%s\\n' "\${_LOKI_ORIGIN_PINNED:-}" "\${_LOKI_PINNED_ORIGIN:-}" >> "${logPath}"
if [ "$mode" = "${failOn ?? ""}" ]; then echo "stub: refused" >&2; exit 2; fi
case "$mode" in
  push-pr) ${marker ? `echo "${marker}"; ` : ""}echo "${printUrl}" ;;
  status) exit 0 ;;
esac
exit 0
`;
  writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

const noLlmSessions: SessionRunner = {
  run() {
    throw new Error("pr stage must never start a provider session");
  },
};
const fakeCost: CostReader = { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) };
const fakeTests: TestMapProvider = { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] };

type Emitted = { type: string; stage: string | null; data: Record<string, unknown> };

function makeCtx(
  repoDir: string,
  runDir: string,
  opts: { verdict?: Verdict; notProven?: string[]; pinnedOrigin?: string | null; capHit?: boolean; routeLine?: string; mutationLine?: string } = {},
): { ctx: RunContext & { pinnedOrigin?: string; capHit?(): boolean }; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const seal = { verdict: opts.verdict ?? "VERIFIED", not_proven: opts.notProven ?? [], receipt_path: `${runDir}/receipt.json`, ...(opts.routeLine ? { route_line: opts.routeLine } : {}), ...(opts.mutationLine ? { mutation_line: opts.mutationLine } : {}) };
  const ctx: RunContext & { pinnedOrigin?: string; capHit?(): boolean } = {
    runId: "e10-test-run",
    repoDir,
    runDir,
    baseSha: "",
    branch: "loki/e10-test-run",
    provider: "claude",
    model: "test-model",
    deep: false,
    capS: 900,
    emit: (type, stage, data) => emitted.push({ type, stage, data }),
    sessions: noLlmSessions,
    tests: fakeTests,
    cost: fakeCost,
    clock: { now: () => Date.now() },
    outputs: () => ({ seal }),
    ...(opts.pinnedOrigin === null ? {} : { pinnedOrigin: opts.pinnedOrigin ?? "https://github.com/octocat/hello.git" }),
    ...(opts.capHit !== undefined ? { capHit: () => opts.capHit as boolean } : {}),
  };
  return { ctx, emitted };
}

let repoDir: string;
let runDir: string;
let stubDir: string;
let logPath: string;

beforeEach(() => {
  repoDir = freshRepo();
  runDir = mkdtempSync(join(tmpdir(), "e10-pr-rundir-"));
  stubDir = mkdtempSync(join(tmpdir(), "e10-pr-stub-"));
  logPath = join(stubDir, "calls.log");
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

function readLog(): string {
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

describe("engine10 pr stage", () => {
  test("VERIFIED with no cap hit: push-pr runs with no --draft flag", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx, emitted } = makeCtx(repoDir, runDir, { verdict: "VERIFIED" });
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });

    expect(result.status).toBe("completed");
    expect(result.data.draft).toBe(false);
    expect(result.data.pr_url).toBe(PR_URL);
    const log = readLog();
    expect(log).toContain(`args=${ctx.repoDir} ${ctx.branch}`);
    expect(log).not.toContain("--draft");
    expect(emitted[0]).toEqual({ type: "pr.opened", stage: "pr", data: { url: PR_URL, draft: false, existing: null } });
  });

  test("PARTIAL verdict: --draft is passed", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx } = makeCtx(repoDir, runDir, { verdict: "PARTIAL" });
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.data.draft).toBe(true);
    expect(readLog()).toContain("--draft");
  });

  test("VERIFIED but the cap fired: --draft is still passed", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx } = makeCtx(repoDir, runDir, { verdict: "VERIFIED", capHit: true });
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.data.draft).toBe(true);
    expect(readLog()).toContain("--draft");
  });

  test("missing verdict is treated as not-VERIFIED (fail-safe draft)", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx } = makeCtx(repoDir, runDir);
    ctx.outputs = () => ({ seal: {} }); // no verdict key at all
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.data.draft).toBe(true);
  });

  test("fork-only (exit 4): a draft run on a repo the user cannot push to reports the fork notice as one line, no PR", async () => {
    const script = join(stubDir, "fork-only.sh");
    writeFileSync(script, "#!/bin/bash\necho 'INFO: no push access to o/r: pushing to the fork me/r' >&2\necho 'fork-only: pushed loki/x to me/r; no draft PR is opened on o/r, which you cannot push to. Open one yourself: gh pr create --repo o/r --head me:loki/x' >&2\nexit 4\n", { mode: 0o755 });
    const { ctx } = makeCtx(repoDir, runDir, { verdict: "SPEC_CONFLICT" });
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("fork-only: pushed loki/x to me/r; no draft PR is opened on o/r, which you cannot push to. Open one yourself: gh pr create --repo o/r --head me:loki/x");
  });
  test("exit 4 with no fork notice keeps the script, mode and exit status", async () => {
    const script = join(stubDir, "exit4.sh"); writeFileSync(script, "#!/bin/bash\nexit 4\n", { mode: 0o755 });
    const { ctx } = makeCtx(repoDir, runDir, { verdict: "SPEC_CONFLICT" });
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.reason).toBe("engine10-push.sh push-pr failed (exit 4): ");
  });
  test("R100-022: an intake-recorded fork_branch publish adds the branch and compare URL to the failure reason", async () => {
    const script = join(stubDir, "exit4b.sh"); writeFileSync(script, "#!/bin/bash\nexit 4\n", { mode: 0o755 });
    const root = `https://github.com/${runDir.split("/").pop()}/${repoDir.split("/").pop()}/compare`; // derived, not a literal repo
    writeFileSync(join(runDir, "preflight.json"), JSON.stringify({ provider: "claude", publish: "fork_branch", publish_reason: "collaborators only", publish_compare: root }));
    const { ctx } = makeCtx(repoDir, runDir, { verdict: "SPEC_CONFLICT" });
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe(`engine10-push.sh push-pr failed (exit 4):  | publish expectation set at intake (fork_branch: collaborators only). The work is on branch ${ctx.branch}. Compare: ${root}/${ctx.branch}`);
  });
  test("R100-022: publishFallback is empty for a normal run, a missing file, junk, and a foreign compare URL", () => {
    expect(publishFallback(runDir, "b")).toBe("");
    writeFileSync(join(runDir, "preflight.json"), "{junk"); expect(publishFallback(runDir, "b")).toBe("");
    writeFileSync(join(runDir, "preflight.json"), JSON.stringify({ publish: "fork_pr" })); expect(publishFallback(runDir, "b")).toBe("");
    writeFileSync(join(runDir, "preflight.json"), JSON.stringify({ provider: "claude" })); expect(publishFallback(runDir, "b")).toBe("");
    writeFileSync(join(runDir, "preflight.json"), JSON.stringify({ publish: "branch", publish_compare: "https://evil.example/x/compare" }));
    expect(publishFallback(runDir, "b")).not.toContain("evil.example");
    writeFileSync(join(runDir, "preflight.json"), JSON.stringify({ publish: "branch", publish_compare: "https://github.com/o/r/compare" }));
    expect(publishFallback(runDir, "b", "main")).toContain("Compare: https://github.com/o/r/compare/main...b");
  });
  test("pushErrLine keeps the die line and the permission denial, on one line", () => {
    const raw = "remote: Permission to anthropics/claude-code.git denied to asklokesh.\nfatal: unable to access 'https://github.com/anthropics/claude-code.git/': The requested URL returned error: 403\nengine10-push: push refused or failed (rc=128)\n";
    expect(pushErrLine(raw)).toBe("engine10-push: push refused or failed (rc=128): Permission to anthropics/claude-code.git denied to asklokesh.");
    expect(pushErrLine("")).toBe("");
    expect(pushErrLine("glab: 401\nengine10-push-gitlab: push-mr failed\n")).toBe("engine10-push-gitlab: push-mr failed");
  });

  test("the stub sees both pin env vars", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx } = makeCtx(repoDir, runDir, { pinnedOrigin: "https://github.com/o/r.git" });
    await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(readLog()).toContain("ENV pinned=1 origin=https://github.com/o/r.git");
  });

  test("GAME10-05a review 1: onSpawnEnv hands over the exact env the push script is spawned with, bot token included", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx } = makeCtx(repoDir, runDir, { pinnedOrigin: "https://github.com/o/r.git" });
    const keys = ["LOKI_PR_AUTHOR", "LOKI_PR_BOT_TOKEN", "GH_TOKEN"], saved = keys.map((k) => process.env[k]);
    process.env.LOKI_PR_AUTHOR = "bot"; process.env.LOKI_PR_BOT_TOKEN = "ghp_bottokenvalue0123456789abcdefABCDEF"; delete process.env.GH_TOKEN;
    let seen: NodeJS.ProcessEnv | undefined;
    try { await runPr(ctx, new AbortController().signal, { pushScriptPath: script, onSpawnEnv: (e) => { seen = e; } }); }
    finally { keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
    expect(seen?.GH_TOKEN).toBe("ghp_bottokenvalue0123456789abcdefABCDEF"); expect(seen?._LOKI_ORIGIN_PINNED).toBe("1");
  });

  test("GAME10-05a round 3: the capability of the env the push script is spawned with is true with a bot token and unknown (never false) without one", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx } = makeCtx(repoDir, runDir, { pinnedOrigin: "https://github.com/o/r.git" });
    const keys = ["LOKI_PR_AUTHOR", "LOKI_PR_BOT_TOKEN", "GH_TOKEN"], saved = keys.map((k) => process.env[k]);
    const spawnedEnv = async (): Promise<NodeJS.ProcessEnv> => { let seen: NodeJS.ProcessEnv = {}; await runPr(ctx, new AbortController().signal, { pushScriptPath: script, onSpawnEnv: (e) => { seen = e; } }); return seen; };
    try {
      delete process.env.GH_TOKEN; process.env.LOKI_PR_AUTHOR = "bot"; process.env.LOKI_PR_BOT_TOKEN = "ghp_bottokenvalue0123456789abcdefABCDEF";
      expect(stageCapability("pr", await spawnedEnv()).can_push).toBe(true);
      delete process.env.LOKI_PR_AUTHOR; delete process.env.LOKI_PR_BOT_TOKEN;
      expect(stageCapability("pr", await spawnedEnv()).can_push).toBe("unknown");
    } finally { keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
  });

  test("no pinned origin: refuses before spawning anything (Rule of Two)", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx, emitted } = makeCtx(repoDir, runDir, { pinnedOrigin: null });
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("no pinned origin");
    expect(readLog()).toBe("");
    expect(emitted).toHaveLength(0);
  });

  test("hung push script: the stage fails with a timeout reason instead of blocking", async () => {
    const script = join(stubDir, "hang.sh");
    writeFileSync(script, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const { ctx, emitted } = makeCtx(repoDir, runDir, { verdict: "VERIFIED" });
    const prev = process.env.LOKI_PR_PUSH_TIMEOUT_MS;
    process.env.LOKI_PR_PUSH_TIMEOUT_MS = "500";
    try {
      const t0 = Date.now();
      const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("timed out after 500ms");
      expect(emitted.some((e) => e.type === "pr.opened")).toBe(false);
    } finally { if (prev === undefined) delete process.env.LOKI_PR_PUSH_TIMEOUT_MS; else process.env.LOKI_PR_PUSH_TIMEOUT_MS = prev; }
  });

  test("a failing push-pr call gives failed, no pr.opened, no status call", async () => {
    const script = writeStub(stubDir, logPath, "push-pr");
    const { ctx, emitted } = makeCtx(repoDir, runDir);
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.status).toBe("failed");
    expect(emitted.find((e) => e.type === "pr.opened")).toBeUndefined();
    const calls = readLog().split("\n").filter((l) => l.startsWith("CALL"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("mode=push-pr");
  });

  test("after pr.opened, a status call follows with pending and the 40-hex HEAD sha", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx } = makeCtx(repoDir, runDir);
    await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    const calls = readLog().split("\n").filter((l) => l.startsWith("CALL"));
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("mode=push-pr");
    expect(calls[1]).toContain("mode=status");
    expect(calls[2]).toContain("mode=issue-comment");
    expect(calls[2]).toContain("args=--update #");
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    expect(calls[1]).toContain(`args=${headSha} pending`);
  });

  test("a status failure is non-fatal: the stage still completes with the PR data", async () => {
    const script = writeStub(stubDir, logPath, "status");
    const { ctx } = makeCtx(repoDir, runDir);
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.status).toBe("completed");
    expect(result.data.pr_url).toBe(PR_URL);
    expect(result.data.not_proven).toEqual(["commit status loki/deep-verify not set"]);
  });

  test("existing is null without a marker, true on 'reused', false on 'created'", async () => {
    for (const [marker, want] of [["", null], ["reused", true], ["created", false]] as const) {
      const script = writeStub(stubDir, logPath, undefined, PR_URL, marker);
      const rd = mkdtempSync(join(tmpdir(), "e10-pr-rd-")); // fresh run dir: the outbox replays a recorded PR
      const { ctx, emitted } = makeCtx(repoDir, rd);
      const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
      expect(result.status).toBe("completed");
      expect(result.data.pr_url).toBe(PR_URL);
      expect(result.data.existing).toBe(want);
      expect(emitted[0]!.data.existing).toBe(want);
      rmSync(rd, { recursive: true, force: true });
    }
  });

  test("an already-aborted signal fails before touching anything", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx, emitted } = makeCtx(repoDir, runDir);
    const controller = new AbortController();
    controller.abort();
    const result = await runPr(ctx, controller.signal, { pushScriptPath: script });
    expect(result.status).toBe("failed");
    expect(readLog()).toBe("");
    expect(emitted).toHaveLength(0);
  });

  test("E-41: a local bare origin's local://<origin>#<branch> line is accepted and emitted as pr.opened", async () => {
    const origin = "/srv/eval/run1/remote.git";
    const url = `local://${origin}#loki/e10-test-run`;
    const script = writeStub(stubDir, logPath, undefined, url);
    const { ctx, emitted } = makeCtx(repoDir, runDir, { pinnedOrigin: origin });
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.status).toBe("completed");
    expect(result.data.pr_url).toBe(url);
    expect(result.data.not_proven).toEqual(["commit status loki/deep-verify not set (local origin)"]);
    expect(emitted[0]).toEqual({ type: "pr.opened", stage: "pr", data: { url, draft: false, existing: null } });
  });

  test("E-41: a local:// line naming another origin or branch is refused, no pr.opened", async () => {
    const origin = "/srv/eval/run1/remote.git";
    for (const bad of [`local:///srv/eval/other.git#loki/e10-test-run`, `local://${origin}#loki/other`, `local://${origin}`]) {
      const script = writeStub(stubDir, logPath, undefined, bad);
      const { ctx, emitted } = makeCtx(repoDir, runDir, { pinnedOrigin: origin });
      const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
      expect(result.status).toBe("failed");
      expect(emitted.find((e) => e.type === "pr.opened")).toBeUndefined();
    }
  });

  test("E-41: a local:// line is refused when the pinned origin is a GitHub URL", async () => {
    const script = writeStub(stubDir, logPath, undefined, "local://https://github.com/octocat/hello.git#loki/e10-test-run");
    const { ctx, emitted } = makeCtx(repoDir, runDir);
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.status).toBe("failed");
    expect(emitted).toHaveLength(0);
  });

  test("the default push script path exists (the real, on-main engine10-push.sh)", () => {
    expect(existsSync(DEFAULT_PUSH_SH)).toBe(true);
  });

  test("the exported stage carries the ENGINE.md section 4 PR budget", () => {
    expect(stage.name).toBe("pr");
    expect(stage.targetS).toBe(15);
    expect(stage.limitS).toBe(60);
  });

  test("R1-15: the sealed route line lands under the verdict in the real PR body only while LOKI_ROUTER is on", async () => {
    const line = "Route: executor haiku-5.5, advisor opus-5.5; advisor tokens 30000 in / 700 out; over 100K: 1 of 2 requests (50.0%)";
    const prev = process.env.LOKI_ROUTER;
    try {
      process.env.LOKI_ROUTER = "1";
      const on = makeCtx(repoDir, runDir, { verdict: "VERIFIED", routeLine: line });
      await runPr(on.ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
      const body = readFileSync(join(runDir, "pr-body.md"), "utf8").split("\n");
      const v = body.findIndex((l) => /^- Verdict:/.test(l));
      expect(v).toBeGreaterThan(-1);
      expect(body[v + 1]).toBe(line);
      delete process.env.LOKI_ROUTER;
      const off = makeCtx(repoDir, runDir, { verdict: "VERIFIED", routeLine: line });
      await runPr(off.ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
      expect(readFileSync(join(runDir, "pr-body.md"), "utf8")).not.toContain("Route:");
    } finally {
      if (prev === undefined) delete process.env.LOKI_ROUTER; else process.env.LOKI_ROUTER = prev;
    }
  });

  const cmd = { cmd: "x", cwd: ".", cite: ["package.json"] };
  const answerFor = (runner: string): string => JSON.stringify({ workspaceKind: "single", workspaceCite: ["package.json"], packages: [{ name: "p0", root: ".", runner, commands: { test: cmd, lint: null, build: null, start: null }, ui: { present: false, boot: null, cite: ["package.json"] }, cite: ["package.json"] }], fingerprintFiles: ["package.json"] });
  const putRun = (id: string, model: string, verdict: string, runner: string | null): void => {
    const body = { schema: "loki.v10.receipt/1", model, verdict }, d = join(repoDir, ".loki", "runs", id);
    mkdirSync(d, { recursive: true }); writeFileSync(join(d, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: receiptSha256(body as never), verification: { jwt: null, kid: null } }));
    if (runner !== null) writeFileSync(join(d, "project-model.answer.json"), answerFor(runner));
  };
  const tierSetup = (): void => { writeFileSync(join(repoDir, "package.json"), "{}"); mkdirSync(join(repoDir, ".loki"), { recursive: true }); };
  const want = "haiku tier sealed; top-tier cost avoided not measured; parity here: haiku sealed 2 of 3, opus sealed 1 of 1";
  const seedTier = (): void => { tierSetup(); putRun("a1", "claude-haiku-4-5", "VERIFIED", "jest"); putRun("a2", "claude-haiku-4-5", "FAILED", "jest"); putRun("a3", "claude-opus-4-5", "VERIFIED", "jest"); putRun("e10-test-run", "claude-haiku-4-5", "VERIFIED", "jest"); };

  test("sealed tier record flows from the repo's receipts into the console Tier line and the real PR body; the cost avoided stays not measured", async () => {
    seedTier();
    expect(tierSealFor(repoDir, "e10-test-run")).toMatchObject({ tier: "haiku", topTierCostAvoidedUsd: null });
    const summary = { pr: null, verdict: "VERIFIED", notProven: [], flaky: [], wallS: 60, stages: [], cost: { usd: 0.5, provider: "claude", tokens: 1000 }, tier: tierSealFor(repoDir, "e10-test-run") };
    expect(renderMainOutput([], summary as never, false)).toContain(`Tier:       ${want}`);
    const { ctx } = makeCtx(repoDir, runDir, { verdict: "VERIFIED" });
    await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
    expect(readFileSync(join(runDir, "pr-body.md"), "utf8")).toContain(`\n- Model tier: ${want}\n`);
  });

  test("each sealed receipt counts for its own run's shape: a later shape change does not re-credit earlier runs", () => {
    tierSetup();
    putRun("b1", "claude-haiku-4-5", "VERIFIED", "jest"); putRun("b2", "claude-haiku-4-5", "VERIFIED", "jest"); putRun("b3", "claude-haiku-4-5", "VERIFIED", "jest");
    writeFileSync(join(repoDir, ".loki", "project.json"), JSON.stringify({ schema: "loki.v10.project/1", status: "ok", workspaceKind: "single", workspaceCite: ["package.json"], packages: [JSON.parse(answerFor("vitest")).packages[0]], fingerprintFiles: ["package.json"], key: computeKey(repoDir, ["package.json"], shallowDirs(repoDir)) }));
    putRun("b4", "claude-haiku-4-5", "VERIFIED", "vitest");
    expect(tierSealFor(repoDir, "b4").record?.haiku?.total).toBe(1);
    putRun("b5", "claude-haiku-4-5", "VERIFIED", null); // shape cannot be recovered: skipped, never given the current shape
    expect(tierSealFor(repoDir, "b4").record?.haiku?.total).toBe(1);
  });

  test("the supervisor summary input carries the tier, and none for a tampered run", () => {
    seedTier();
    expect(summaryTier(repoDir, "e10-test-run", false)).toMatchObject({ tier: "haiku" });
    expect(summaryTier(repoDir, "e10-test-run", true)).toBeUndefined();
    expect(readFileSync(join(import.meta.dir, "../../src/engine10/supervisor.ts"), "utf8")).toContain("tier: summaryTier(repoDir, runId, res.tampered)");
  });

  test("a PARTIAL or FAILED draft PR body carries no tier line", async () => {
    seedTier();
    for (const verdict of ["PARTIAL", "FAILED"] as const) {
      const { ctx } = makeCtx(repoDir, runDir, { verdict });
      await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
      expect(readFileSync(join(runDir, "pr-body.md"), "utf8")).not.toContain("Model tier:");
    }
  });

  test("T2: the sealed mutation_line (the key seal.ts writes) lands in the PR body, and is absent when seal wrote none", async () => {
    const line = "test fails without the fix: yes";
    const on = makeCtx(repoDir, runDir, { verdict: "VERIFIED", mutationLine: line });
    await runPr(on.ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
    expect(readFileSync(join(runDir, "pr-body.md"), "utf8")).toContain(`\n${line}\n`);
    const off = makeCtx(repoDir, runDir, { verdict: "VERIFIED" });
    await runPr(off.ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
    expect(readFileSync(join(runDir, "pr-body.md"), "utf8")).not.toContain(line);
  });

  describe("MASS-2 stacked slice PRs", () => {
    const keep = { base: process.env.LOKI_PR_BASE, refs: process.env.LOKI_PR_REFS };
    afterEach(() => {
      for (const [k, v] of [["LOKI_PR_BASE", keep.base], ["LOKI_PR_REFS", keep.refs]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    test("LOKI_PR_BASE reaches push-pr as --base and the body names the epic and the parent", async () => {
      process.env.LOKI_PR_BASE = "loki/e10-parent";
      process.env.LOKI_PR_REFS = "octocat/hello#12";
      const { ctx } = makeCtx(repoDir, runDir, { verdict: "PARTIAL" });
      const r = await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
      expect(r.status).toBe("completed");
      expect(readLog()).toContain(`--draft --base loki/e10-parent`);
      const body = readFileSync(join(runDir, "pr-body.md"), "utf8");
      expect(body).toContain("\nRefs octocat/hello#12\n");
      expect(body).not.toContain("Closes");
      expect(body).toContain("Stacked on `loki/e10-parent`");
    });

    test("no LOKI_PR_BASE: no --base, no stack line", async () => {
      delete process.env.LOKI_PR_BASE;
      delete process.env.LOKI_PR_REFS;
      const { ctx } = makeCtx(repoDir, runDir, { verdict: "VERIFIED" });
      await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
      expect(readLog()).not.toContain("--base");
      expect(readFileSync(join(runDir, "pr-body.md"), "utf8")).not.toContain("Stacked on");
    });

    test("an unsafe LOKI_PR_BASE or LOKI_PR_REFS fails closed or is dropped; nothing is pushed for a bad base", async () => {
      for (const bad of ["-x", "a..b", "a b", "a/", "x.lock", "main;rm"]) {
        process.env.LOKI_PR_BASE = bad;
        const { ctx } = makeCtx(repoDir, runDir, { verdict: "PARTIAL" });
        const r = await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
        expect(r.status).toBe("failed");
        expect(readLog()).toBe("");
      }
      delete process.env.LOKI_PR_BASE;
      process.env.LOKI_PR_REFS = "octocat/hello#12\nCloses other/repo#1";
      const { ctx } = makeCtx(repoDir, runDir, { verdict: "VERIFIED" });
      await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
      expect(readFileSync(join(runDir, "pr-body.md"), "utf8")).not.toContain("octocat/hello#12");
    });
  });
});

describe("engine10 pr stage AI marker (MARK-1)", () => {
  test("the marker lands under the verdict only while LOKI_AI_MARKING=1", async () => {
    const prev = process.env.LOKI_AI_MARKING;
    try {
      process.env.LOKI_AI_MARKING = "1";
      const on = makeCtx(repoDir, runDir, { verdict: "VERIFIED" });
      await runPr(on.ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
      const lines = readFileSync(join(runDir, "pr-body.md"), "utf8").split("\n");
      const v = lines.findIndex((l) => /^- Verdict:/.test(l));
      expect(v).toBeGreaterThan(-1);
      expect(lines[v + 1]).toMatch(/^AI-Generated: true \(Loki Mode, .+, run .+\)$/);
      expect(lines.filter((l) => l.startsWith("AI-Generated")).length).toBe(1);
      delete process.env.LOKI_AI_MARKING;
      const off = makeCtx(repoDir, runDir, { verdict: "VERIFIED" });
      await runPr(off.ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
      expect(readFileSync(join(runDir, "pr-body.md"), "utf8")).not.toContain("AI-Generated");
    } finally {
      if (prev === undefined) delete process.env.LOKI_AI_MARKING; else process.env.LOKI_AI_MARKING = prev;
    }
  });
});

describe("engine10 pr stage reviewer brief (T4)", () => {
  async function body(env: string | undefined): Promise<string> {
    const prev = process.env.LOKI_REVIEWER_BRIEF;
    if (env === undefined) delete process.env.LOKI_REVIEWER_BRIEF; else process.env.LOKI_REVIEWER_BRIEF = env;
    try {
      const script = writeStub(stubDir, logPath);
      const { ctx } = makeCtx(repoDir, runDir, { verdict: "VERIFIED" });
      await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
      return readFileSync(join(runDir, "pr-body.md"), "utf8");
    } finally {
      if (prev === undefined) delete process.env.LOKI_REVIEWER_BRIEF; else process.env.LOKI_REVIEWER_BRIEF = prev;
    }
  }
  test("on by default; LOKI_REVIEWER_BRIEF=0 body is the brief-free prefix, byte for byte", async () => {
    const on = await body(undefined);
    const off = await body("0");
    expect(on).toContain("## Reviewer brief");
    expect(off).not.toContain("Reviewer brief");
    expect(on.startsWith(off + "\n## Reviewer brief")).toBe(true);
  });
});

const gitOut = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const RUN = "e10-20261015T000000Z-abcd";

describe("RECOVERY: interrupted run resume", () => {
  let repo: string, log: SupervisorLog, out: string[], prCalls: number;
  const evPath = (): string => join(repo, ".loki", "runs", RUN, "events.jsonl");
  const say = (s: string): void => { out.push(s); };
  const runPr: RunPrFn = async () => { prCalls++; return { status: "completed", data: { pr_url: "https://github.com/o/r/pull/9", draft: false, existing: prCalls > 1 ? true : null } }; };
  const tgit = (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" }).trim();
  const sealedHead = (): string => { // loki/<run> carries one commit; its sha is the receipt's head_sha
    if (!gitOut(repo, ["branch", "--list", `loki/${RUN}`])) { tgit("commit", "-q", "--allow-empty", "-m", "sealed"); tgit("branch", `loki/${RUN}`); }
    return gitOut(repo, ["rev-parse", `loki/${RUN}`]);
  };
  const seal = (verdict = "VERIFIED", notProven: string[] = []): void => { // a real signed receipt: a publish resume takes verdict and not_proven from this file, not from the log line
    mkdirSync(join(repo, ".loki", "runs", RUN), { recursive: true });
    const body = { schema: "loki.v10.receipt/1", run_id: RUN, verdict, head_sha: sealedHead(), not_proven: notProven, events_sha256: createHash("sha256").update(existsSync(evPath()) ? readFileSync(evPath()) : "").digest("hex"), time: { wall_s: 0, stages: {} }, checks: [] }; // bound to the log as it stands before receipt.sealed, as seal.ts does
    const hash = receiptSha256(body as never);
    writeFileSync(join(repo, ".loki", "runs", RUN, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signReceipt(RUN, hash) }, null, 2));
    log.append("receipt.sealed", "seal", { verdict, receipt_sha256: hash, path: ".loki/runs/x/receipt.json" });
    log.checkpoint(hash); // exactly what the supervisor does on seeing receipt.sealed: a signed checkpoint and an open run.state.json, which is all a crash in the publish phase leaves
  };
  const branch = (): void => { try { gitOut(repo, ["rev-parse", "--verify", "-q", `refs/heads/loki/${RUN}`]); } catch { gitOut(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "x"]); gitOut(repo, ["branch", `loki/${RUN}`]); } };
  const keyEnv = { a: process.env["LOKI_RECEIPT_SIGNING_KEY"], b: process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] };
  beforeAll(() => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(tmpdir(), `loki-recovery-key-${process.pid}.pem`); });
  afterAll(() => { rmSync(process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]!, { force: true }); for (const [k, v] of [["LOKI_RECEIPT_SIGNING_KEY", keyEnv.a], ["LOKI_RECEIPT_SIGNING_KEY_FILE", keyEnv.b]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  beforeEach(() => {
    delete process.env["LOKI_NONINTERACTIVE"]; delete process.env["LOKI_NO_RESUME"];
    repo = mkdtempSync(join(tmpdir(), "loki-recovery-"));
    gitOut(repo, ["init", "-q"]);
    gitOut(repo, ["remote", "add", "origin", "https://github.com/o/r.git"]);
    log = new SupervisorLog(evPath(), RUN);
    log.append("run.started", null, { provider: "claude", model: "m" });
    log.append("stage.completed", "intake", { task: "fix the bug", base_sha: "0".repeat(40) });
    out = []; prCalls = 0;
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("phaseOf names implement, verify, publish and done", () => {
    expect(phaseOf(readEvents(evPath()))).toBe("implement");
    log.append("stage.completed", "implement", {});
    expect(phaseOf(readEvents(evPath()))).toBe("verify");
    seal();
    expect(phaseOf(readEvents(evPath()))).toBe("publish");
    log.append("pr.opened", "pr", { url: "u", draft: false, existing: null });
    expect(phaseOf(readEvents(evPath()))).toBe("done");
  });

  test("interrupted in implement: reported, not resumed, no PR call", async () => {
    expect(findInterrupted(repo)?.phase).toBe("implement");
    const cwd = process.cwd(); process.chdir(repo);
    try { expect(await resumeMain([], { runPr, out: say })).toBe(4); } finally { process.chdir(cwd); }
    expect(out.join("")).toContain("phase: implement");
    expect(prCalls).toBe(0);
  });

  test("interrupted in verify: reported with the phase name", async () => {
    log.append("stage.completed", "implement", {});
    const cwd = process.cwd(); process.chdir(repo);
    try { expect(await resumeMain([], { runPr, out: say })).toBe(4); } finally { process.chdir(cwd); }
    expect(out.join("")).toContain("phase: verify");
    expect(prCalls).toBe(0);
  });

  test("resume that finds an already-open PR says 'PR reused' and records existing true", async () => {
    seal();
    const reused: RunPrFn = async () => { prCalls++; return { status: "completed", data: { pr_url: "https://github.com/o/r/pull/9", draft: false, existing: true } }; };
    const cwd = process.cwd(); process.chdir(repo);
    try { expect(await resumeMain([], { runPr: reused, out: say })).toBe(0); } finally { process.chdir(cwd); }
    expect(out.join("")).toContain("PR reused https://github.com/o/r/pull/9");
    expect(readEvents(evPath()).findLast((e) => e.type === "pr.opened")!.data.existing).toBe(true);
  });

  test("interrupted in publish: resume opens exactly one PR, reuses the receipt, and a second resume finds nothing", async () => {
    seal();
    const before = readFileSync(join(repo, ".loki", "runs", RUN, "receipt.json"), "utf8");
    const cwd = process.cwd(); process.chdir(repo);
    try {
      expect(await resumeMain([], { runPr, out: say })).toBe(0);
      expect(await resumeMain([], { runPr, out: say })).toBe(3);
    } finally { process.chdir(cwd); }
    expect(out.join("")).toContain("resumed phase: publish");
    expect(prCalls).toBe(1);
    const ev = readEvents(evPath());
    expect(ev.filter((e) => e.type === "receipt.sealed")).toHaveLength(1);
    expect(ev.filter((e) => e.type === "pr.opened")).toHaveLength(1);
    expect(ev.some((e) => e.type === "run.resumed")).toBe(true);
    expect(readFileSync(join(repo, ".loki", "runs", RUN, "receipt.json"), "utf8")).toBe(before);
    expect(existsSync(join(repo, ".loki", "runs", RUN, "receipt.json"))).toBe(true);
  });

  test("resume keeps the sealed receipt not_proven entries in the PR seal and run.completed", async () => {
    seal("PARTIAL", ["cost unmetered", "wall result not recorded"]);
    let seen: unknown = null;
    const spy: RunPrFn = async (ctx: Record<string, unknown>) => { seen = ((ctx["outputs"] as () => Record<string, unknown>)()["seal"] as Record<string, unknown>)["not_proven"]; return runPr(ctx, new AbortController().signal); };
    const cwd = process.cwd(); process.chdir(repo);
    try { expect(await resumeMain([], { runPr: spy, out: say })).toBe(0); } finally { process.chdir(cwd); }
    const want = ["cost unmetered", "wall result not recorded", "publish phase resumed after an interruption"];
    expect(seen).toEqual(want);
    const done = readEvents(evPath()).findLast((e) => e.type === "run.completed");
    expect(done?.data["not_proven"]).toEqual(want);
  });

  test("resume surfaces the policy-not-evaluated note in the PR seal and run.completed", async () => {
    writeFileSync(join(repo, ".loki", "policies.json"), JSON.stringify({ autonomy: "execute", actions: { pr: "allow" } }));
    seal("PARTIAL", ["cost unmetered"]);
    const bin = join(repo, "..", `${RUN}-gitonly`); mkdirSync(bin, { recursive: true });
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    let seen: unknown = null;
    const spy: RunPrFn = async (ctx: Record<string, unknown>) => { seen = ((ctx["outputs"] as () => Record<string, unknown>)()["seal"] as Record<string, unknown>)["not_proven"]; return runPr(ctx, new AbortController().signal); };
    const keep = { p: process.env["PATH"], r: process.env["LOKI_POLICY_REQUIRE_NODE"] }; process.env["PATH"] = bin; process.env["LOKI_POLICY_REQUIRE_NODE"] = "0";
    const cwd = process.cwd(); process.chdir(repo);
    try { expect(await resumeMain([], { runPr: spy, out: say })).toBe(0); } finally { process.chdir(cwd); process.env["PATH"] = keep.p; if (keep.r === undefined) delete process.env["LOKI_POLICY_REQUIRE_NODE"]; else process.env["LOKI_POLICY_REQUIRE_NODE"] = keep.r; rmSync(bin, { recursive: true, force: true }); }
    expect((seen as string[]).some((x) => x.includes("policy NOT evaluated"))).toBe(true);
    expect(readEvents(evPath()).findLast((e) => e.type === "run.completed")?.data["not_proven"]).toContain((seen as string[])[2]);
  });

  test("failed publish leaves the run resumable and appends no pr.opened", async () => {
    seal();
    const failing: RunPrFn = async () => { prCalls++; return { status: "failed", data: {}, reason: "boom" }; };
    const cwd = process.cwd(); process.chdir(repo);
    try { expect(await resumeMain([], { runPr: failing, out: say })).toBe(5); } finally { process.chdir(cwd); }
    expect(readEvents(evPath()).some((e) => e.type === "pr.opened")).toBe(false);
    expect(findInterrupted(repo)?.phase).toBe("publish");
    expect(prCalls).toBe(1);
  });

  test("POLICY: resume under autonomy propose opens no PR; execute opens one; require_approval drafts", async () => {
    seal();
    const pol = (v: unknown): void => { mkdirSync(join(repo, ".loki"), { recursive: true }); writeFileSync(join(repo, ".loki", "policies.json"), JSON.stringify(v)); };
    const seen: boolean[] = [];
    const spy: RunPrFn = async (c) => { prCalls++; seen.push((c as { draft?: boolean }).draft === true); return { status: "completed", data: { pr_url: "https://github.com/o/r/pull/9", draft: false, existing: null } }; };
    const cwd = process.cwd(); process.chdir(repo);
    try {
      pol({ autonomy: "propose" });
      expect(await resumeMain([], { runPr: spy, out: say })).toBe(5);
      expect(prCalls).toBe(0);
      expect(out.join("")).toContain("policy denied");
      expect(readEvents(evPath()).some((e) => e.type === "pr.opened")).toBe(false);
      pol({ autonomy: "execute", actions: { pr: "require_approval" } });
      expect(await resumeMain([], { runPr: spy, out: say })).toBe(0);
      expect(seen).toEqual([true]);
    } finally { process.chdir(cwd); }
  });

  test("startRecovery resumes only the same task; a different task starts fresh with a notice", async () => {
    seal(); branch();
    expect(await startRecovery(repo, "something else", false, { runPr, out: say })).toBeNull();
    expect(out.join("")).toContain("interrupted in phase publish");
    expect(prCalls).toBe(0);
    expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say })).toBe(0);
    expect(prCalls).toBe(1);
  });

  describe("SB-12: the resume offer", () => {
    const asks = (...a: (string | null)[]): { ask: (q: string) => Promise<string | null>; left: () => number } => { const q = [...a]; return { ask: async () => (q.length ? q.shift()! : null), left: () => q.length }; };
    const withEnv = async (k: string, v: string, f: () => Promise<void>): Promise<void> => { const o = process.env[k]; process.env[k] = v; try { await f(); } finally { if (o === undefined) delete process.env[k]; else process.env[k] = o; } };

    test("parseRecoveryChoice: default, numbers, words; Resume is refused when not resumable", () => {
      expect(parseRecoveryChoice("", true)).toBe("resume");
      expect(parseRecoveryChoice("", false)).toBe("fresh");
      expect(parseRecoveryChoice("2", true)).toBe("fresh");
      expect(parseRecoveryChoice("2", false)).toBe("discard");
      expect(parseRecoveryChoice("4", true)).toBe("details");
      expect(parseRecoveryChoice("4", false)).toBeNull();
      expect(parseRecoveryChoice(" Show Details ", false)).toBe("details");
      expect(parseRecoveryChoice("discard", true)).toBe("discard");
      expect(parseRecoveryChoice("resume", true)).toBe("resume");
      expect(parseRecoveryChoice("resume", false)).toBeNull();
      expect(parseRecoveryChoice("banana", true)).toBeNull();
    });

    test("TTY on a resumable run: Enter resumes (default)", async () => {
      seal(); branch();
      const a = asks("");
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: a.ask })).toBe(0);
      expect(prCalls).toBe(1);
      expect(out.join("")).toContain("1) Resume");
    });

    test("TTY: Start fresh keeps the branch and says so; nothing is resumed or marked", async () => {
      seal(); branch();
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: asks("2").ask })).toBeNull();
      expect(prCalls).toBe(0);
      expect(out.join("")).toContain(`Starting fresh; old work is kept on loki/${RUN}`);
      expect(findInterrupted(repo)?.runId).toBe(RUN);
    });

    test("TTY: Discard marks the run so it is no longer offered and deletes nothing", async () => {
      seal(); branch();
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: asks("3").ask })).toBeNull();
      expect(out.join("")).toContain(`Discarded run ${RUN}`);
      expect(existsSync(join(repo, ".loki", "runs", RUN, "discarded"))).toBe(true);
      expect(existsSync(evPath()) && existsSync(join(repo, ".loki", "runs", RUN, "receipt.json"))).toBe(true);
      expect(gitOut(repo, ["rev-parse", "--verify", `refs/heads/loki/${RUN}`])).not.toBe("");
      expect(findInterrupted(repo)).toBeNull();
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: asks().ask })).toBeNull();
      expect(prCalls).toBe(0);
    });

    test("discardRun refuses a symlinked run dir and a bad id", () => {
      const real = join(repo, "elsewhere"); mkdirSync(real);
      mkdirSync(join(repo, ".loki", "runs"), { recursive: true });
      symlinkSync(real, join(repo, ".loki", "runs", "e10-link"));
      expect(discardRun(repo, "e10-link")).toBe(false);
      expect(existsSync(join(real, "discarded"))).toBe(false);
      expect(discardRun(repo, "../x")).toBe(false);
    });

    test("TTY: Show details and a bad answer re-ask; EOF is an abort, never a resume", async () => {
      seal(); branch();
      const a = asks("what", "4", null);
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: a.ask })).toBe(130);
      const t = out.join("");
      expect(t).toContain("not a choice: what");
      expect(t).toContain("resumable (same task, publish phase)");
      expect(prCalls).toBe(0);
    });

    test("Ctrl-C at the menu returns 130 with no resume and no new run", async () => {
      seal(); branch();
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: asks(RECOVERY_ABORT).ask })).toBe(130);
      expect(prCalls).toBe(0);
      expect(findInterrupted(repo)?.runId).toBe(RUN);
    });

    test("Resume is not offered when it cannot finish: no run branch, no origin", async () => {
      seal(); gitOut(repo, ["branch", "-D", `loki/${RUN}`]); // seal() makes the sealed-head branch the signed receipt names; drop it to model a run with no branch
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: asks("1").ask })).toBeNull();
      expect(out.join("")).not.toContain("Resume (");
      branch(); out.length = 0;
      gitOut(repo, ["remote", "remove", "origin"]);
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: asks("1").ask })).toBeNull();
      expect(out.join("")).not.toContain("Resume (");
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: false })).toBeNull();
      expect(prCalls).toBe(0);
    });

    test("discardRun never writes through a dangling marker link", () => {
      const outside = join(repo, "outside.txt");
      mkdirSync(join(repo, ".loki", "runs", RUN), { recursive: true });
      symlinkSync(outside, join(repo, ".loki", "runs", RUN, "discarded"));
      expect(discardRun(repo, RUN)).toBe(false);
      expect(existsSync(outside)).toBe(false);
    });

    test("TTY on a non-resumable phase: no Resume entry, default is Start fresh, a resume answer is refused", async () => {
      const a = asks("resume", "");
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: a.ask })).toBeNull();
      const t = out.join("");
      expect(t).not.toContain("Resume (");
      expect(t).toContain("1) Start fresh");
      expect(t).toContain("not a choice: resume");
      expect(prCalls).toBe(0);
    });

    test("TTY: a same-task publish run under --no-pr or a different task is not offered Resume", async () => {
      seal(); branch();
      expect(await startRecovery(repo, "fix the bug", true, { runPr, out: say, tty: true, ask: asks("").ask })).toBeNull();
      expect(await startRecovery(repo, "other", false, { runPr, out: say, tty: true, ask: asks("").ask })).toBeNull();
      expect(out.join("")).not.toContain("Resume (");
      expect(prCalls).toBe(0);
    });

    test("a cancelled run at the publish phase is offered Resume and finishes its pull request step", async () => {
      seal(); branch(); const sl = new SupervisorLog(evPath(), RUN); sl.append("run.completed", null, { verdict: "FAILED", cancelled: true, outcome: "CANCELLED" }); sl.sealLog();
      expect(findInterrupted(repo)).toBeNull();
      expect(findInterrupted(repo, undefined, true)?.cancelled).toBe(true);
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say })).toBe(0);
      expect(prCalls).toBe(1);
    });

    test("non-TTY resumes a same-task publish run; a different task starts fresh with a note naming the branch", async () => {
      seal(); branch();
      expect(await startRecovery(repo, "other task", false, { runPr, out: say, tty: false })).toBeNull();
      expect(out.join("")).toContain(`old work is kept on loki/${RUN}`);
      expect(prCalls).toBe(0);
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: false })).toBe(0);
      expect(prCalls).toBe(1);
    });

    test("LOKI_NONINTERACTIVE=1 never prompts even on a TTY", async () => {
      seal(); branch();
      await withEnv("LOKI_NONINTERACTIVE", "1", async () => {
        const a = asks("2");
        expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: true, ask: a.ask })).toBe(0);
        expect(a.left()).toBe(1);
      });
    });

    test("--fresh and LOKI_NO_RESUME=1 skip the offer entirely", async () => {
      seal(); branch();
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: false, fresh: true })).toBeNull();
      await withEnv("LOKI_NO_RESUME", "1", async () => { expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: false })).toBeNull(); });
      expect(prCalls).toBe(0);
      expect(out.join("")).toBe("");
    });

    test("a crashed publish run whose signed checkpoint was cut is not offered Resume, starts fresh, and loki resume names LOKI_NO_RESUME", async () => {
      seal(); branch();
      const kept = readFileSync(evPath(), "utf8").split("\n").filter((l) => l !== "");
      expect(JSON.parse(kept[kept.length - 1]!).type).toBe("log.sealed");
      writeFileSync(evPath(), kept.slice(0, -1).join("\n") + "\n"); // the tail was cut right after receipt.sealed: nothing past the receipt is authenticated
      expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say, tty: false })).toBeNull();
      expect(out.join("")).toContain(`starting a new run, old work is kept on loki/${RUN}`);
      const cwd = process.cwd(); process.chdir(repo);
      try { expect(await resumeMain([], { runPr, out: say })).toBe(5); } finally { process.chdir(cwd); }
      expect(prCalls).toBe(0);
    });

    test("a bare start (no task) resumes a publish run and otherwise says to give a task", async () => {
      seal(); branch();
      expect(await startRecovery(repo, "", false, { runPr, out: say, tty: false })).toBe(0);
      expect(prCalls).toBe(1);
    });

    test("a bare start on a non-resumable run names the branch and asks for a task", async () => {
      branch();
      expect(await startRecovery(repo, "", false, { runPr, out: say, tty: true, ask: asks("1").ask })).toBeNull();
      expect(out.join("")).toContain(`give a task to start a new run`);
      expect(out.join("")).toContain(`loki/${RUN}`);
    });

    test("status and cancel next-step lines say what happens next, only for a run that can be offered", () => {
      expect(statusNextStep(repo, join(repo, ".loki", "runs"), RUN, readEvents(evPath()))).toContain("offers to start fresh; no run branch was created");
      seal(); branch();
      expect(statusNextStep(repo, join(repo, ".loki", "runs"), RUN, readEvents(evPath()))).toContain("offers to finish its pull request step");
      expect(nextStepText(RUN, "publish", false, true)).toBe(`next loki start offers to start fresh; old work stays on loki/${RUN}`);
      discardRun(repo, RUN);
      expect(statusNextStep(repo, join(repo, ".loki", "runs"), RUN, readEvents(evPath()))).toBeNull();
    });
  });
});

describe("TEN-ADOPTION-09 gitlab.com origin routes to engine10-push-gitlab.sh push-mr", () => {
  const GL_ORIGIN = "https://gitlab.com/grp/sub/proj.git";
  const MR_URL = "https://gitlab.com/grp/sub/proj/-/merge_requests/7";
  /** A fake engine10-push-gitlab.sh: logs mode, args and the pin env to its own log, prints printUrl for push-mr. */
  function writeGlStub(printUrl: string = MR_URL): { script: string; log: string } {
    const script = join(stubDir, "push-gl-stub.sh"), log = join(stubDir, "gl.log");
    writeFileSync(script, `#!/bin/sh\nmode="$1"; shift\nprintf 'GL mode=%s args=%s pinned=%s origin=%s\\n' "$mode" "$*" "\${_LOKI_ORIGIN_PINNED:-}" "\${_LOKI_PINNED_ORIGIN:-}" >> "${log}"\n[ "$mode" = push-mr ] && echo "${printUrl}"\nexit 0\n`, { mode: 0o755 });
    return { script, log };
  }
  const glLog = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const freshRunDir = (): string => mkdtempSync(join(stubDir, "run-")); // one outbox per run, so a loop never replays a recorded push

  test("a gitlab.com pin calls push-mr (never the GitHub push script) and records the MR URL", async () => {
    const gh = writeStub(stubDir, logPath), gl = writeGlStub();
    const { ctx, emitted } = makeCtx(repoDir, runDir, { verdict: "PARTIAL", pinnedOrigin: GL_ORIGIN });
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: gh, gitlabPushScriptPath: gl.script });
    expect(result.status).toBe("completed");
    expect(result.data.pr_url).toBe(MR_URL);
    expect(result.data.existing).toBeNull();
    expect(result.data.not_proven).toEqual(["commit status loki/deep-verify not set (gitlab origin)"]);
    expect(emitted[0]).toEqual({ type: "pr.opened", stage: "pr", data: { url: MR_URL, draft: true, existing: null } });
    expect(glLog(gl.log)).toContain(`GL mode=push-mr args=${ctx.repoDir} ${ctx.branch} Loki 10: PARTIAL (e10-test-run) ${runDir}/pr-body.md --draft pinned=1 origin=${GL_ORIGIN}`);
    expect(readLog()).toBe(""); // neither push-pr nor the GitHub status call ran
  });

  test("ssh and upper-case forms route too; VERIFIED passes no --draft", async () => {
    for (const origin of ["git@gitlab.com:grp/proj.git", "ssh://git@gitlab.com/grp/proj.git", "HTTPS://GITLAB.COM/grp/proj"]) {
      rmSync(join(stubDir, "gl.log"), { force: true });
      const gl = writeGlStub("https://gitlab.com/grp/proj/-/merge_requests/1");
      const { ctx } = makeCtx(repoDir, freshRunDir(), { verdict: "VERIFIED", pinnedOrigin: origin });
      const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath), gitlabPushScriptPath: gl.script });
      expect(result.data.pr_url).toBe("https://gitlab.com/grp/proj/-/merge_requests/1");
      expect(glLog(gl.log)).toContain("GL mode=push-mr");
      expect(glLog(gl.log)).not.toContain("--draft");
    }
    expect(readLog()).toBe("");
  });

  test("a GitHub PR URL, another host, a one-segment path or a non-URL line is refused, no pr.opened", async () => {
    for (const bad of [PR_URL, "https://gitlab.example.com/grp/proj/-/merge_requests/7", "https://gitlab.com/proj/-/merge_requests/7", "https://gitlab.com/grp/proj/-/merge_requests/7x", "Creating merge request"]) {
      const gl = writeGlStub(bad);
      const { ctx, emitted } = makeCtx(repoDir, freshRunDir(), { pinnedOrigin: GL_ORIGIN });
      const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath), gitlabPushScriptPath: gl.script });
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("printed no valid MR URL");
      expect(emitted).toEqual([]);
    }
  });

  test("a look-alike host (gitlab.com.evil.example) stays on the GitHub script path", async () => {
    const gh = writeStub(stubDir, logPath), gl = writeGlStub();
    const { ctx } = makeCtx(repoDir, runDir, { pinnedOrigin: "https://gitlab.com.evil.example/grp/proj.git" });
    await runPr(ctx, new AbortController().signal, { pushScriptPath: gh, gitlabPushScriptPath: gl.script });
    expect(readLog()).toContain("CALL mode=push-pr");
    expect(glLog(gl.log)).toBe("");
  });

  test("LOKI_PR_BASE with a gitlab origin fails closed before any push", async () => {
    const prev = process.env.LOKI_PR_BASE; process.env.LOKI_PR_BASE = "loki/epic-1";
    try {
      const gl = writeGlStub();
      const { ctx } = makeCtx(repoDir, runDir, { pinnedOrigin: GL_ORIGIN });
      const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath), gitlabPushScriptPath: gl.script });
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("has no --base");
      expect(glLog(gl.log)).toBe("");
    } finally { if (prev === undefined) delete process.env.LOKI_PR_BASE; else process.env.LOKI_PR_BASE = prev; }
  });

  test("end to end through the real engine10-push-gitlab.sh: the branch lands and the MR URL is recorded", async () => {
    const gl = join(stubDir, "gl"), bin = join(stubDir, "bin"), gcfg = join(stubDir, "gitconfig"), glabLog = join(stubDir, "glab.log");
    mkdirSync(join(gl, "grp/sub"), { recursive: true }); mkdirSync(bin);
    execFileSync("git", ["init", "-q", "--bare", join(gl, "grp/sub/proj.git")]);
    writeFileSync(gcfg, `[url "${gl}/"]\n\tinsteadOf = https://gitlab.com/\n`);
    writeFileSync(join(bin, "glab"), `#!/bin/sh\necho "$*" >> "${glabLog}"\ncase "$1 $2" in\n  "api projects/grp%2Fsub%2Fproj") echo '{"default_branch":"main"}' ;;\n  "mr list") echo '[]' ;;\n  "mr create") echo "Creating merge request"; echo "${MR_URL}" ;;\nesac\nexit 0\n`, { mode: 0o755 });
    git(repoDir, ["branch", "loki/e10-test-run"]);
    git(repoDir, ["remote", "add", "origin", GL_ORIGIN]);
    const keys = ["PATH", "GIT_CONFIG_GLOBAL", "GIT_ALLOW_PROTOCOL", "GIT_TERMINAL_PROMPT"] as const;
    const saved = keys.map((k) => process.env[k]);
    Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: gcfg, GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" });
    try {
      const { ctx, emitted } = makeCtx(repoDir, runDir, { verdict: "VERIFIED", pinnedOrigin: GL_ORIGIN });
      const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: writeStub(stubDir, logPath) });
      expect(result.reason).toBeUndefined();
      expect(result.data.pr_url).toBe(MR_URL);
      expect(emitted[0]?.data.url).toBe(MR_URL);
      expect(readFileSync(glabLog, "utf8")).toContain("mr create --repo grp/sub/proj --source-branch loki/e10-test-run");
      const landed = execFileSync("git", ["--git-dir", join(gl, "grp/sub/proj.git"), "rev-parse", "refs/heads/loki/e10-test-run"], { encoding: "utf8" }).trim();
      expect(landed).toBe(execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
      expect(readLog()).toBe("");
    } finally { keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
  });

  test("the default GitLab push script path exists", () => {
    expect(existsSync(DEFAULT_PUSH_GITLAB_SH)).toBe(true);
  });
});
