// RECOVERY: phase detection and publish-phase resume with a counting runPr stub (fault injection at each phase).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readEvents } from "../../src/engine10/events.ts";
import { findInterrupted, main, phaseOf, startRecovery, type RunPrFn } from "../../src/util/run_recovery.ts";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const RUN = "e10-20261015T000000Z-abcd";

describe("engine10 recovery", () => {
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
    git(repo, ["init", "-q"]);
    git(repo, ["remote", "add", "origin", "https://github.com/o/r.git"]);
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
    try { expect(await main([], { runPr, out: say })).toBe(4); } finally { process.chdir(cwd); }
    expect(out.join("")).toContain("phase: implement");
    expect(prCalls).toBe(0);
  });

  test("interrupted in verify: reported with the phase name", async () => {
    log.append("stage.completed", "implement", {});
    const cwd = process.cwd(); process.chdir(repo);
    try { expect(await main([], { runPr, out: say })).toBe(4); } finally { process.chdir(cwd); }
    expect(out.join("")).toContain("phase: verify");
    expect(prCalls).toBe(0);
  });

  test("interrupted in publish: resume opens exactly one PR, reuses the receipt, and a second resume finds nothing", async () => {
    seal();
    const before = readFileSync(join(repo, ".loki", "runs", RUN, "receipt.json"), "utf8");
    const cwd = process.cwd(); process.chdir(repo);
    try {
      expect(await main([], { runPr, out: say })).toBe(0);
      expect(await main([], { runPr, out: say })).toBe(3);
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

  test("failed publish leaves the run resumable and appends no pr.opened", async () => {
    seal();
    const failing: RunPrFn = async () => { prCalls++; return { status: "failed", data: {}, reason: "boom" }; };
    const cwd = process.cwd(); process.chdir(repo);
    try { expect(await main([], { runPr: failing, out: say })).toBe(5); } finally { process.chdir(cwd); }
    expect(readEvents(evPath()).some((e) => e.type === "pr.opened")).toBe(false);
    expect(findInterrupted(repo)?.phase).toBe("publish");
    expect(prCalls).toBe(1);
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
