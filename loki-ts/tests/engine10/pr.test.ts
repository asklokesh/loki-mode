// loki-ts/tests/engine10/pr.test.ts
//
// E-11 (TS half) wall check. supervisor.ts/E-03 and machine.ts/E-02 are in
// rework and not on main, so RunContext deps are fakes and the push child is
// a stub script at an injected path (never the real, credentialed
// autonomy/lib/engine10-push.sh).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PUSH_GITLAB_SH, DEFAULT_PUSH_SH, runPr, stage } from "../../src/engine10/stages/pr.ts";
import { EventLog, readEvents } from "../../src/engine10/events.ts";
import { findInterrupted, phaseOf, resumeMain, startRecovery, type RunPrFn } from "../../src/util/run_outputs.ts";
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
  let repo: string, log: EventLog, out: string[], prCalls: number;
  const evPath = (): string => join(repo, ".loki", "runs", RUN, "events.jsonl");
  const say = (s: string): void => { out.push(s); };
  const runPr: RunPrFn = async () => { prCalls++; return { status: "completed", data: { pr_url: "https://github.com/o/r/pull/9", draft: false, existing: prCalls > 1 ? true : null } }; };
  const seal = (): void => {
    mkdirSync(join(repo, ".loki", "runs", RUN), { recursive: true });
    writeFileSync(join(repo, ".loki", "runs", RUN, "receipt.json"), '{"receipt_sha256":"abc"}\n');
    log.append("receipt.sealed", "seal", { verdict: "VERIFIED", receipt_sha256: "abc", path: ".loki/runs/x/receipt.json" });
  };
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loki-recovery-"));
    gitOut(repo, ["init", "-q"]);
    gitOut(repo, ["remote", "add", "origin", "https://github.com/o/r.git"]);
    log = new EventLog(evPath(), RUN);
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
    mkdirSync(join(repo, ".loki", "runs", RUN), { recursive: true });
    log.append("receipt.sealed", "seal", { verdict: "PARTIAL", receipt_sha256: "abc", path: "p", not_proven: ["cost unmetered", "wall result not recorded"] });
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
    mkdirSync(join(repo, ".loki", "runs", RUN), { recursive: true });
    writeFileSync(join(repo, ".loki", "policies.json"), JSON.stringify({ autonomy: "execute", actions: { pr: "allow" } }));
    log.append("receipt.sealed", "seal", { verdict: "PARTIAL", receipt_sha256: "abc", path: "p", not_proven: ["cost unmetered"] });
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
    seal();
    expect(await startRecovery(repo, "something else", false, { runPr, out: say })).toBeNull();
    expect(out.join("")).toContain("interrupted in phase publish");
    expect(prCalls).toBe(0);
    expect(await startRecovery(repo, "fix the bug", false, { runPr, out: say })).toBe(0);
    expect(prCalls).toBe(1);
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
