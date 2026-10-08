import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { coveredIssues, parseTriage, runIssues, type GhIssue, type IssuesRunDeps, type Triage } from "../../src/commands/issues_run.ts";
import type { RunOpts, RunResult } from "../../src/commands/queue.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "issues-run-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SLUG = "o/r";
const issue = (n: number, title = `issue ${n}`): { number: number; title: string; body: string; labels: { name: string }[] } => ({ number: n, title, body: `body ${n}`, labels: [] });

function harness(opts: {
  issues?: ReturnType<typeof issue>[];
  prs?: { headRefName: string; body: string }[];
  triage?: Record<number, Triage>;
  results?: Record<string, RunResult>;
  isTTY?: boolean;
  confirm?: boolean;
  runDelayMs?: number;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const ghCalls: string[][] = [];
  const triaged: number[] = [];
  const ran: { ref: string; opts: RunOpts }[] = [];
  const worktrees: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const inject: Partial<IssuesRunDeps> = {
    repoDir: dir,
    lokiDir: join(dir, ".loki"),
    gh: (args) => {
      ghCalls.push([...args]);
      if (args[0] === "issue" && args[1] === "list") return { rc: 0, stdout: JSON.stringify(opts.issues ?? []), stderr: "" };
      if (args[0] === "pr" && args[1] === "list") return { rc: 0, stdout: JSON.stringify(opts.prs ?? []), stderr: "" };
      return { rc: 0, stdout: "", stderr: "" };
    },
    triage: async (_slug: string, i: GhIssue) => {
      triaged.push(i.number);
      return opts.triage?.[i.number] ?? { decision: "actionable", reason: "clear and small" };
    },
    runner: async (ref, o) => {
      ran.push({ ref, opts: o });
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, opts.runDelayMs ?? 0));
      inFlight--;
      return opts.results?.[ref] ?? { rc: 0, output: `PR: https://github.com/o/r/pull/${ref.split("#")[1]}\n`, verdict: "VERIFIED", costUsd: 1.25 };
    },
    estimate: () => ({ ok: false, reason: "0 prior verified runs for shape node, need 3" }),
    confirm: async () => opts.confirm ?? true,
    isTTY: opts.isTTY ?? true,
    worktree: {
      create: (name, base) => {
        expect(base).toBe("HEAD");
        worktrees.push(Number(name.replace("issue-", "")));
        return join(dir, `wt-${name}`);
      },
      remove: () => {},
    },
    sleep: async () => {},
    now: () => new Date("2026-10-08T03:00:00.000Z"),
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
  };
  return { inject, out, err, ghCalls, triaged, ran, worktrees, peak: () => peak };
}

describe("loki issues run", () => {
  test("lists through gh on PATH with --label and --limit", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "gh-argv.log");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$1 $2" in\n  "issue list") echo '[{"number":7,"title":"t7","body":"b","labels":[{"name":"bug"}]}]' ;;\n  "pr list") echo '[]' ;;\nesac\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const h = harness({});
    delete h.inject.gh;
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      expect(await runIssues(["run", SLUG, "--label", "bug", "--limit", "5", "--dry-run"], h.inject)).toBe(0);
    } finally {
      process.env.PATH = savedPath;
    }
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines[0]).toBe("issue list --repo o/r --state open --json number,title,body,labels --limit 5 --label bug");
    expect(lines[1]).toStartWith("pr list --repo o/r --state open");
    expect(h.out.join("")).toContain("plan #7: t7");
  });

  test("dedupe skips an issue with an open loki/issue-N PR or a linking Loki PR body", async () => {
    const h = harness({
      issues: [issue(1), issue(2), issue(3), issue(4)],
      prs: [
        { headRefName: "loki/issue-2", body: "" },
        { headRefName: "loki/e10-abc", body: "## Receipt\n\nRefs o/r#3\n" },
        { headRefName: "feature/human", body: "mentions #4" },
      ],
    });
    expect(await runIssues(["run", SLUG, "--yes"], h.inject)).toBe(0);
    expect(h.triaged).toEqual([1, 4]);
    expect(h.ran.map((r) => r.ref)).toEqual(["o/r#1", "o/r#4"]);
    const text = h.out.join("");
    expect(text).toContain("skip #2 (open Loki PR exists)");
    expect(text).toContain("skip #3 (open Loki PR exists)");
    expect([...coveredIssues(SLUG, [{ headRefName: "loki/x", body: "Closes o/r#12 and https://github.com/o/r/issues/13" }])].sort()).toEqual([12, 13]);
  });

  test("triage routes: needs-info and too-large are skipped and listed, never commented without --comment", async () => {
    const h = harness({
      issues: [issue(1), issue(2), issue(3)],
      triage: { 2: { decision: "needs-info", reason: "no repro steps" }, 3: { decision: "too-large", reason: "needs a schema redesign" } },
    });
    expect(await runIssues(["run", SLUG, "--yes"], h.inject)).toBe(0);
    expect(h.ran.map((r) => r.ref)).toEqual(["o/r#1"]);
    expect(h.ghCalls.some((c) => c[0] === "issue" && c[1] === "comment")).toBe(false);
    const text = h.out.join("");
    expect(text).toContain("#2 triage: needs-info: no repro steps");
    expect(text).toMatch(/\| #2 issue 2 \| needs-info \| skipped: no repro steps \| none \|/);
    expect(text).toMatch(/\| #3 issue 3 \| too-large \|/);

    const c = harness({ issues: [issue(2)], triage: { 2: { decision: "needs-info", reason: "no repro steps" } } });
    expect(await runIssues(["run", SLUG, "--yes", "--comment"], c.inject)).toBe(0);
    expect(c.ghCalls.find((x) => x[1] === "comment")).toEqual(["issue", "comment", "2", "--repo", SLUG, "--body", "Loki triage: needs-info. no repro steps"]);
  });

  test("parseTriage reads the model's last TRIAGE line, unknown otherwise", () => {
    expect(parseTriage("thinking\nTRIAGE: too-large | three services\n")).toEqual({ decision: "too-large", reason: "three services" });
    expect(parseTriage("TRIAGE: needs-info | x\nTRIAGE: actionable | one file").decision).toBe("actionable");
    expect(parseTriage("looks actionable to me").decision).toBe("unknown");
  });

  test("a VERIFIED issue gets its PR in the digest, a BLOCKED one gets none plus a diagnosis", async () => {
    const h = harness({
      issues: [issue(1), issue(2)],
      results: { "o/r#2": { rc: 3, output: "engine10: stage plan done\nBLOCKED: spec conflict: which API version?\n", verdict: "BLOCKED", costUsd: null } },
    });
    expect(await runIssues(["run", SLUG, "--yes"], h.inject)).toBe(0);
    const text = h.out.join("");
    expect(text).toMatch(/\| #1 issue 1 \| actionable \| VERIFIED \| https:\/\/github\.com\/o\/r\/pull\/1 \| \$1\.25 \| 0s \|/);
    expect(text).toMatch(/\| #2 issue 2 \| actionable \| BLOCKED, no PR: BLOCKED: spec conflict: which API version\? \| none \| NOT RECORDED \|/);
    const runs = readdirSync(join(dir, ".loki", "issues-run"));
    expect(runs.length).toBe(1);
    const digest = readFileSync(join(dir, ".loki", "issues-run", runs[0]!, "digest.md"), "utf8");
    expect(digest).toContain("| Issue | Triage | Outcome | PR | Cost | Time |");
    expect(digest).toContain("https://github.com/o/r/pull/1");
  });

  test("--draft reaches the runner's PR options", async () => {
    const h = harness({ issues: [issue(1)] });
    expect(await runIssues(["run", SLUG, "--yes", "--draft"], h.inject)).toBe(0);
    expect(h.ran[0]!.opts).toEqual({ pr: true, draft: true });
    const plain = harness({ issues: [issue(1)] });
    await runIssues(["run", SLUG, "--yes"], plain.inject);
    expect(plain.ran[0]!.opts.draft).toBeUndefined();
  });

  test("--dry-run makes no triage call, spawns nothing and exits 0", async () => {
    const h = harness({ issues: [issue(1), issue(2)], isTTY: false });
    expect(await runIssues(["run", SLUG, "--dry-run"], h.inject)).toBe(0);
    expect(h.triaged).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(h.worktrees).toEqual([]);
    expect(existsSync(join(dir, ".loki", "issues-run"))).toBe(false);
    expect(h.out.join("")).toContain("estimated total: NOT AVAILABLE (0 prior verified runs for shape node, need 3)");
  });

  test("no TTY and no --yes refuses with exit 2 before any billed call", async () => {
    const h = harness({ issues: [issue(1)], isTTY: false });
    expect(await runIssues(["run", SLUG], h.inject)).toBe(2);
    expect(h.err.join("")).toContain("pass --yes");
    expect(h.triaged).toEqual([]);
    expect(h.ran).toEqual([]);
    const no = harness({ issues: [issue(1)], confirm: false });
    expect(await runIssues(["run", SLUG], no.inject)).toBe(1);
    expect(no.triaged).toEqual([]);
  });

  test("--parallel caps at 4 in flight, each in its own worktree; 5 is refused", async () => {
    const h = harness({ issues: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => issue(n)), runDelayMs: 20 });
    expect(await runIssues(["run", SLUG, "--yes", "--parallel", "4"], h.inject)).toBe(0);
    expect(h.ran.length).toBe(8);
    expect(h.peak()).toBe(4);
    expect(h.worktrees.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(h.ran.map((r) => r.opts.cwd)).size).toBe(8);
    const seq = harness({ issues: [1, 2, 3].map((n) => issue(n)), runDelayMs: 5 });
    await runIssues(["run", SLUG, "--yes"], seq.inject);
    expect(seq.peak()).toBe(1);
    expect(seq.worktrees).toEqual([]);
    const over = harness({ issues: [issue(1)] });
    expect(await runIssues(["run", SLUG, "--yes", "--parallel", "5"], over.inject)).toBe(2);
    expect(over.err.join("")).toContain("--parallel is at most 4");
  });

  test("a provider rate limit backs off and retries the same issue", async () => {
    let calls = 0;
    const h = harness({ issues: [issue(1)] });
    h.inject.runner = async () => (++calls === 1 ? { rc: 1, output: "Error: 429 rate limit exceeded, retry-after: 7" } : { rc: 0, output: "https://github.com/o/r/pull/9", verdict: "VERIFIED", costUsd: 0.5 });
    const slept: number[] = [];
    h.inject.sleep = async (ms) => void slept.push(ms);
    expect(await runIssues(["run", SLUG, "--yes"], h.inject)).toBe(0);
    expect(calls).toBe(2);
    expect(slept).toEqual([7000]);
    expect(h.out.join("")).toContain("https://github.com/o/r/pull/9");
  });

  test("issues_run source has no git push, no allowToken and no gh pr create (PRs come only from the engine10 PR stage)", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/commands/issues_run.ts"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(src).not.toMatch(/["'`]push["'`]/);
    expect(src).not.toContain("allowToken");
    expect(src).not.toMatch(/["'`]pr["'`]\s*,\s*["'`]create["'`]/);
    expect(src).not.toContain("engine10-push");
  });

  test("a failed gh pr list fails closed instead of risking duplicate PRs", async () => {
    const h = harness({ issues: [issue(1)] });
    const gh = h.inject.gh!;
    h.inject.gh = (args) => (args[0] === "pr" ? { rc: 1, stdout: "", stderr: "HTTP 502" } : gh(args));
    expect(await runIssues(["run", SLUG, "--yes"], h.inject)).toBe(1);
    expect(h.triaged).toEqual([]);
  });
});
