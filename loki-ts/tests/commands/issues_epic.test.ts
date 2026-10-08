// MASS-2: `loki issues run` splits a too-large issue into stacked slices. Every external effect is a stub:
// gh, the decomposition model reply (JSON text), the queue runner and the worktrees.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDecomposition, renderEpicTree, type SliceResult } from "../../src/commands/issues_epic.ts";
import { runIssues, type GhIssue, type IssuesRunDeps, type Triage } from "../../src/commands/issues_run.ts";
import type { RunOpts, RunResult } from "../../src/commands/queue.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "issues-epic-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SLUG = "o/r";
const issue = (n: number, title = `issue ${n}`) => ({ number: n, title, body: `body ${n}`, labels: [] as { name: string }[] });
const slice = (id: string, deps: string[] = [], extra: Record<string, unknown> = {}) => ({ id, title: `title ${id}`, acceptance: [`${id} works`], depends_on: deps, files: [`src/${id}.ts`], ...extra });
const plan = (...slices: unknown[]): string => JSON.stringify({ slices });

// s1 <- s2 <- s3 (a stack), s4 independent root.
const STACK = plan(slice("s1"), slice("s2", ["s1"]), slice("s3", ["s2"]), slice("s4"));

function harness(opts: {
  issues?: ReturnType<typeof issue>[];
  triage?: Record<number, Triage>;
  decompose?: Record<number, string>;
  verdicts?: Record<string, { verdict: string; rc?: number; pr?: boolean }>;
  confirm?: boolean[];
}) {
  const out: string[] = [];
  const err: string[] = [];
  const ghCalls: string[][] = [];
  const decomposed: number[] = [];
  const ran: { ref: string; opts: RunOpts }[] = [];
  const wtCreated: { name: string; base: string }[] = [];
  const prompts: string[] = [];
  const answers = [...(opts.confirm ?? [])];
  let run = 0;
  const inject: Partial<IssuesRunDeps> = {
    repoDir: dir,
    lokiDir: join(dir, ".loki"),
    gh: (args) => {
      ghCalls.push([...args]);
      if (args[0] === "issue" && args[1] === "list") return { rc: 0, stdout: JSON.stringify(opts.issues ?? []), stderr: "" };
      if (args[0] === "pr" && args[1] === "list") return { rc: 0, stdout: "[]", stderr: "" };
      return { rc: 0, stdout: "", stderr: "" };
    },
    triage: async (_s: string, i: GhIssue) => opts.triage?.[i.number] ?? { decision: "too-large", reason: "several services" },
    decompose: async (_s: string, i: GhIssue) => {
      decomposed.push(i.number);
      return opts.decompose?.[i.number] ?? STACK;
    },
    runner: async (ref, o) => {
      ran.push({ ref, opts: o });
      run++;
      const id = /^Slice (\S+) /.exec(ref)?.[1] ?? ref;
      const v = opts.verdicts?.[id] ?? { verdict: "VERIFIED" };
      const runId = `e10-run${run}`;
      // A real engine10 run leaves its receipt in the checkout it ran in.
      if (o.cwd) {
        mkdirSync(join(o.cwd, ".loki", "runs", runId), { recursive: true });
        writeFileSync(join(o.cwd, ".loki", "runs", runId, "receipt.json"), JSON.stringify({ verdict: v.verdict }));
      }
      const res: RunResult = { rc: v.rc ?? 0, output: v.pr === false ? `${v.verdict}: nothing pushed\n` : `PR: https://github.com/o/r/pull/${100 + run}\n`, verdict: v.verdict, costUsd: 1.5, runId };
      return res;
    },
    estimate: () => ({ ok: false, reason: "no history", prior: { usd: [0.11, 0.98], tier: "sonnet", size_class: "unplanned" } }),
    confirm: async (q) => {
      prompts.push(q);
      return answers.length ? answers.shift()! : true;
    },
    isTTY: true,
    worktree: {
      create: (name, base) => {
        wtCreated.push({ name, base });
        const p = join(dir, "wt", name);
        mkdirSync(p, { recursive: true });
        return p;
      },
      remove: () => {},
    },
    sleep: async () => {},
    now: () => new Date("2026-10-08T03:00:00.000Z"),
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
  };
  const sliceOf = (r: { ref: string }) => /^Slice (\S+) /.exec(r.ref)?.[1];
  return { inject, out, err, ghCalls, decomposed, ran, wtCreated, prompts, sliceOf };
}

describe("parseDecomposition (schema, L0: the model decides the split, the harness only validates)", () => {
  test("a valid plan comes back in dependency order with one stack parent per slice", () => {
    const p = parseDecomposition(plan(slice("b", ["a"]), slice("a"), slice("c", ["a", "b"])));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.slices.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(p.parent).toEqual({ a: null, b: "a", c: "b" });
  });

  test("schema rejections name the problem", () => {
    const bad = (text: string) => {
      const r = parseDecomposition(text);
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.reason;
    };
    expect(bad("not json at all")).toContain("no JSON object");
    expect(bad(JSON.stringify({ parts: [] }))).toContain("slices");
    expect(bad(plan(slice("s1")))).toContain("at least 2");
    expect(bad(plan(slice("s1"), { id: "s2", title: "t", acceptance: [] }))).toContain("acceptance");
    expect(bad(plan(slice("s1"), slice("s1")))).toContain("duplicate");
    expect(bad(plan(slice("s1"), slice("s2", ["s9"])))).toContain("unknown slice s9");
    expect(bad(plan(slice("s1"), slice("bad id!")))).toContain("id");
    expect(bad(plan(slice("s1"), slice("s2", [], { title: 7 })))).toContain("title");
    expect(bad(plan(slice("a"), slice("b"), slice("c", ["a", "b"])))).toContain("one stack");
  });

  test("a dependency cycle is refused", () => {
    const r = parseDecomposition(plan(slice("s1", ["s3"]), slice("s2", ["s1"]), slice("s3", ["s2"]), slice("s4")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("cycle");
    const self = parseDecomposition(plan(slice("s1", ["s1"]), slice("s2")));
    expect(self.ok).toBe(false);
  });

  test("the JSON may sit in a fenced block after prose", () => {
    const r = parseDecomposition("Here is the split.\n```json\n" + STACK + "\n```\n");
    expect(r.ok).toBe(true);
  });
});

describe("loki issues run: epic split", () => {
  test("stacking: slices run in dependency order, each in a worktree on its parent's branch, PR base = parent branch", async () => {
    const h = harness({ issues: [issue(12, "Big epic")] });
    expect(await runIssues(["run", SLUG, "--yes"], h.inject)).toBe(0);
    expect(h.decomposed).toEqual([12]);
    expect(h.ran.map(h.sliceOf)).toEqual(["s1", "s2", "s3", "s4"]);
    // Roots start from HEAD and PR to the default branch; s2 stacks on s1's run branch, s3 on s2's.
    expect(h.wtCreated.map((w) => w.base)).toEqual(["HEAD", "loki/e10-run1", "loki/e10-run2", "HEAD"]);
    expect(h.ran.map((r) => r.opts.prBase ?? null)).toEqual([null, "loki/e10-run1", "loki/e10-run2", null]);
    for (const r of h.ran) {
      expect(r.opts.pr).toBe(true);
      expect(r.opts.draft).toBe(true);
      expect(r.opts.prRefs).toBe("o/r#12");
      expect(r.opts.cwd).toBeDefined();
    }
    // Each slice keeps its own receipt after its worktree is gone.
    const runs = readdirSync(join(dir, ".loki", "issues-run"));
    const receipts = readdirSync(join(dir, ".loki", "issues-run", runs[0]!, "receipts")).sort();
    expect(receipts).toEqual(["e10-run1", "e10-run2", "e10-run3", "e10-run4"]);
    // The slice task is a single run's text (no list lines the group router would split again).
    expect(h.ran[1]!.ref).toStartWith("Slice s2 of 4 for o/r#12: title s2");
    expect(h.ran[1]!.ref.split("\n").some((l) => /^\s*(?:\d+[.)]|[-*+])\s+/.test(l) || /^\s{0,3}#/.test(l))).toBe(false);
  });

  test("stop rule: a FAILED slice skips its dependents (transitively) while an independent sibling still runs", async () => {
    const h = harness({ issues: [issue(12)], verdicts: { s2: { verdict: "FAILED", rc: 1, pr: false } } });
    expect(await runIssues(["run", SLUG, "--yes"], h.inject)).toBe(0);
    expect(h.ran.map(h.sliceOf)).toEqual(["s1", "s2", "s4"]);
    const text = h.out.join("");
    expect(text).toContain("s3 title s3: SKIPPED (depends on s2, which was FAILED)");
    const blocked = harness({ issues: [issue(12)], verdicts: { s1: { verdict: "BLOCKED", rc: 3, pr: false } } });
    await runIssues(["run", SLUG, "--yes"], blocked.inject);
    expect(blocked.ran.map(blocked.sliceOf)).toEqual(["s1", "s4"]);
    expect(blocked.out.join("")).toContain("s3 title s3: SKIPPED (depends on s2, which was SKIPPED)");
  });

  test("a rejected decomposition falls back to skipped: too-large and runs nothing", async () => {
    const h = harness({ issues: [issue(12)], decompose: { 12: plan(slice("s1", ["s2"]), slice("s2", ["s1"])) } });
    expect(await runIssues(["run", SLUG, "--yes"], h.inject)).toBe(0);
    expect(h.ran).toEqual([]);
    expect(h.out.join("")).toMatch(/\| #12 issue 12 \| too-large \| skipped: split refused: dependency cycle/);
  });

  test("--no-split keeps the MASS-1 behavior: no decomposition call, too-large is skipped", async () => {
    const h = harness({ issues: [issue(12)] });
    expect(await runIssues(["run", SLUG, "--yes", "--no-split"], h.inject)).toBe(0);
    expect(h.decomposed).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(h.out.join("")).toMatch(/\| #12 issue 12 \| too-large \| skipped: several services \| none \|/);
  });

  test("--comment off: no gh issue comment and no sub-issue; on: the slice plan is posted on the epic", async () => {
    const off = harness({ issues: [issue(12)] });
    await runIssues(["run", SLUG, "--yes"], off.inject);
    expect(off.ghCalls.filter((c) => !(c[1] === "list"))).toEqual([]);
    const on = harness({ issues: [issue(12)] });
    await runIssues(["run", SLUG, "--yes", "--comment"], on.inject);
    const writes = on.ghCalls.filter((c) => c[1] !== "list");
    expect(writes.length).toBe(1);
    expect(writes[0]!.slice(0, 5)).toEqual(["issue", "comment", "12", "--repo", SLUG]);
    expect(writes[0]![5]).toBe("--body");
    expect(writes[0]![6]).toContain("split it into 4 stacked pull requests");
    expect(writes[0]![6]).toContain("s3: title s3 (after s2)");
  });

  test("cost: each epic shows slices x per-run estimate (labelled rough prior) before the run prompt", async () => {
    const h = harness({ issues: [issue(12), issue(13)], triage: { 13: { decision: "actionable", reason: "small" } } });
    expect(await runIssues(["run", SLUG], h.inject)).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("epic #12: 4 slices x ~$0.11-$0.98 (rough prior) = ~$0.44-$3.92");
    expect(h.prompts.length).toBe(2);
    expect(h.prompts[1]).toContain("Run 1 issue and 4 slices in 1 epic");
    expect(text.indexOf("epic #12: 4 slices")).toBeLessThan(text.indexOf("#13 running"));
    const na = harness({ issues: [issue(12)] });
    na.inject.estimate = () => ({ ok: false, reason: "no project shape recorded for this repo" });
    await runIssues(["run", SLUG, "--yes"], na.inject);
    expect(na.out.join("")).toContain("epic #12: 4 slices x NOT AVAILABLE (no project shape recorded for this repo)");
    const no = harness({ issues: [issue(12)], confirm: [true, false] });
    expect(await runIssues(["run", SLUG], no.inject)).toBe(1);
    expect(no.ran).toEqual([]);
  });

  test("the digest shows each epic as a tree (golden)", async () => {
    const h = harness({ issues: [issue(12, "Big epic")], verdicts: { s2: { verdict: "PARTIAL" }, s3: { verdict: "FAILED", rc: 1, pr: false } } });
    expect(await runIssues(["run", SLUG, "--yes"], h.inject)).toBe(0);
    const runs = readdirSync(join(dir, ".loki", "issues-run"));
    // The Time cell is wall-clock; everything else is golden.
    const digest = readFileSync(join(dir, ".loki", "issues-run", runs[0]!, "digest.md"), "utf8").replace(/ \| \d+s \|$/m, " | - |");
    expect(digest).toBe(
      [
        "# Loki issues run: o/r",
        "",
        "Started: 2026-10-08T03:00:00.000Z  ",
        "Finished: 2026-10-08T03:00:00.000Z",
        "",
        "| Issue | Triage | Outcome | PR | Cost | Time |",
        "| --- | --- | --- | --- | --- | --- |",
        "| #12 Big epic | too-large | split: 4 slices, 3 PRs, 1 failed, 0 skipped | see epic tree | $6.00 | - |",
        "",
        "## Epics",
        "",
        "### #12 Big epic",
        "",
        "- s1 title s1: VERIFIED, https://github.com/o/r/pull/101, $1.50",
        "  - s2 title s2: PARTIAL, https://github.com/o/r/pull/102, $1.50",
        "    - s3 title s3: FAILED, no PR, $1.50",
        "- s4 title s4: VERIFIED, https://github.com/o/r/pull/104, $1.50",
        "",
      ].join("\n"),
    );
  });

  test("renderEpicTree marks skipped slices with their reason and no cost", () => {
    const rows: SliceResult[] = [
      { id: "a", title: "A", parent: null, outcome: "FAILED", pr: null, cost: "NOT RECORDED" },
      { id: "b", title: "B", parent: "a", outcome: "SKIPPED (depends on a, which was FAILED)", pr: null, cost: "-" },
    ];
    expect(renderEpicTree(7, "E", rows)).toBe("### #7 E\n\n- a A: FAILED, no PR, NOT RECORDED\n  - b B: SKIPPED (depends on a, which was FAILED), no PR, -\n");
  });

  test("issues code (run and epic) has no git push, no allowToken and no gh pr create", () => {
    for (const f of ["issues_run.ts", "issues_epic.ts"]) {
      const src = readFileSync(join(import.meta.dir, "../../src/commands", f), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      expect(src).not.toMatch(/["'`]push["'`]/);
      expect(src).not.toContain("allowToken");
      expect(src).not.toMatch(/["'`]pr["'`]\s*,\s*["'`]create["'`]/);
      expect(src).not.toContain("engine10-push");
    }
  });
});
