// loki-ts/tests/engine10/pr.test.ts
//
// E-11 (TS half) wall check. supervisor.ts/E-03 and machine.ts/E-02 are in
// rework and not on main, so RunContext deps are fakes and the push child is
// a stub script at an injected path (never the real, credentialed
// autonomy/lib/engine10-push.sh).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PUSH_SH, runPr, stage } from "../../src/engine10/stages/pr.ts";
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
function writeStub(dir: string, logPath: string, failOn?: "push-pr" | "status", printUrl: string = PR_URL): string {
  const scriptPath = join(dir, "push-stub.sh");
  const content = `#!/bin/sh
mode="$1"; shift
printf 'CALL mode=%s args=%s\\n' "$mode" "$*" >> "${logPath}"
printf 'ENV pinned=%s origin=%s\\n' "\${_LOKI_ORIGIN_PINNED:-}" "\${_LOKI_PINNED_ORIGIN:-}" >> "${logPath}"
if [ "$mode" = "${failOn ?? ""}" ]; then echo "stub: refused" >&2; exit 2; fi
case "$mode" in
  push-pr) echo "${printUrl}" ;;
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
  opts: { verdict?: Verdict; notProven?: string[]; pinnedOrigin?: string | null; capHit?: boolean; routeLine?: string } = {},
): { ctx: RunContext & { pinnedOrigin?: string; capHit?(): boolean }; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const seal = { verdict: opts.verdict ?? "VERIFIED", not_proven: opts.notProven ?? [], receipt_path: `${runDir}/receipt.json`, ...(opts.routeLine ? { route_line: opts.routeLine } : {}) };
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

  test("the stub sees both pin env vars", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx } = makeCtx(repoDir, runDir, { pinnedOrigin: "https://github.com/o/r.git" });
    await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(readLog()).toContain("ENV pinned=1 origin=https://github.com/o/r.git");
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
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("mode=push-pr");
    expect(calls[1]).toContain("mode=status");
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

  test("existing is reported as null (the push script cannot tell reuse from create)", async () => {
    const script = writeStub(stubDir, logPath);
    const { ctx } = makeCtx(repoDir, runDir);
    const result = await runPr(ctx, new AbortController().signal, { pushScriptPath: script });
    expect(result.data.existing).toBeNull();
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
});
