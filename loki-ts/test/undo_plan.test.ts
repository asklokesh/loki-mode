// UNDO-1: `loki undo <run-id> --plan` is read-only. Every fixture repo lives in a run-owned temp dir.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_ONLY_GIT, runUndo, type GitRunner, type UndoPlan } from "../src/commands/undo.ts";
import { computeReceiptHash } from "../src/engine10/verify_cmd.ts";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LOKI_NO_BROWSER: "1" };
let root = "", repo = "", runsRoot = "";
const sh = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=false", ...a], { env: ENV, encoding: "utf8" }).trim();
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function commit(file: string, msg: string, runTrailer?: string): string {
  writeFileSync(join(repo, file), msg);
  sh(repo, "add", file);
  sh(repo, "commit", "-q", "-m", msg, ...(runTrailer ? ["-m", `Loki-Run: ${runTrailer}`] : []));
  return sh(repo, "rev-parse", "HEAD");
}

function writeReceipt(runId: string, base: string, head: string, tamper = false, events?: object[]): void {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  const body: Record<string, unknown> = { schema: "loki.v10.receipt/1", run_id: runId, base_sha: base, head_sha: head, verdict: "VERIFIED", events_sha256: sha256(""), verification: { jwt: null } };
  body["receipt_sha256"] = computeReceiptHash(body);
  if (tamper) body["head_sha"] = base;
  writeFileSync(join(dir, "receipt.json"), JSON.stringify(body));
  if (events) writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function snapshot(): string {
  return [sh(repo, "for-each-ref"), sh(repo, "rev-parse", "HEAD"), sh(repo, "status", "--porcelain=v1", "--branch"), sha256(readFileSync(join(repo, ".git", "index")).toString("latin1")), sh(repo, "reflog", "--all")].join("\n--\n");
}

async function plan(runId: string, extra: string[] = ["--allow-unsigned"], git?: GitRunner): Promise<{ rc: number; out: string; err: string }> {
  let out = "", err = "";
  const rc = await runUndo([runId, "--plan", ...extra], { repoDir: repo, runsRoot, out: (s) => (out += s), err: (s) => (err += s), ...(git ? { git } : {}) });
  return { rc, out, err };
}

let base = "";
beforeAll(() => {
  root = mkdtempSync(join(process.env["LOKI_RUN_TMP"] ?? tmpdir(), "loki-run-undo-"));
  repo = join(root, "repo");
  runsRoot = join(root, "runs");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  base = commit("base.txt", "base");
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("loki undo --plan", () => {
  test("unmerged branch: plan is delete branch, foreign-run commit excluded, nothing changes", async () => {
    sh(repo, "checkout", "-q", "-b", "loki/run-a", base);
    commit("a1.txt", "a1", "run-a");
    commit("x1.txt", "x1", "run-x");
    const head = commit("a2.txt", "a2", "run-a");
    sh(repo, "checkout", "-q", "main");
    writeReceipt("run-a", base, head, false, [{ v: 1, seq: 0, ts: "2026-10-08T00:00:00.000Z", run: "run-a", type: "run.completed", stage: null, data: { pr_url: "https://github.com/o/r/pull/9" } }]);
    const before = snapshot();
    const argv: string[][] = [];
    const rec: GitRunner = (dir, args) => {
      argv.push([...args]);
      const r = execFileSyncSafe(dir, args);
      return r;
    };
    const r = await plan("run-a", undefined, rec);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("delete local branch loki/run-a (2 commit(s)");
    expect(r.out).toContain("commits (2, ");
    expect(r.out).toContain("1 from other runs excluded");
    expect(r.out).not.toContain("x1");
    expect(r.out).toContain("https://github.com/o/r/pull/9");
    expect(r.out).not.toContain("revert");
    expect(snapshot()).toBe(before);
    expect(argv.length).toBeGreaterThan(0);
    for (const a of argv) expect(READ_ONLY_GIT.has(a[0]!)).toBe(true);
  });

  test("merged branch: plan is revert commits", async () => {
    sh(repo, "merge", "-q", "--no-ff", "-m", "merge run-a", "loki/run-a");
    const before = snapshot();
    const r = await plan("run-a");
    expect(r.rc).toBe(0);
    expect(r.out).toContain("revert 2 commit(s) already on main");
    expect(r.out).toContain("on-default");
    expect(r.out).not.toContain("delete local branch");
    expect(snapshot()).toBe(before);
  });

  test("pushed branch is reported and its remote copy is left in place", async () => {
    const bare = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare], { env: ENV });
    sh(repo, "remote", "add", "origin", bare);
    sh(repo, "checkout", "-q", "-b", "loki/run-b", "main");
    const base2 = sh(repo, "rev-parse", "HEAD");
    const head = commit("b1.txt", "b1", "run-b");
    sh(repo, "push", "-q", "origin", "loki/run-b");
    sh(repo, "checkout", "-q", "main");
    writeReceipt("run-b", base2, head);
    const before = snapshot();
    const r = await plan("run-b");
    expect(r.rc).toBe(0);
    expect(r.out).toContain("pushed");
    expect(r.out).toContain("origin/loki/run-b");
    expect(r.out).toContain("left in place");
    expect(snapshot()).toBe(before);
  });

  test("later commit on the run branch is flagged", async () => {
    sh(repo, "checkout", "-q", "-b", "loki/run-c", "main");
    const base3 = sh(repo, "rev-parse", "HEAD");
    const head = commit("c1.txt", "c1", "run-c");
    commit("c2.txt", "human follow-up");
    sh(repo, "checkout", "-q", "main");
    writeReceipt("run-c", base3, head);
    const r = await plan("run-c");
    expect(r.rc).toBe(0);
    expect(r.out).toContain("has 1 commit(s) after the run's head");
  });

  test("tampered receipt is refused", async () => {
    writeReceipt("run-t", base, sh(repo, "rev-parse", "main"), true);
    const before = snapshot();
    const r = await plan("run-t");
    expect(r.rc).toBe(1);
    expect(r.err).toContain("TAMPERED");
    expect(r.out).toBe("");
    expect(snapshot()).toBe(before);
  });

  test("unsigned receipt is refused without --allow-unsigned", async () => {
    const r = await plan("run-a", []);
    expect(r.rc).toBe(3);
    expect(r.out).toBe("");
  });

  test("unknown run exits 66; bad id and missing --plan exit 2", async () => {
    expect((await plan("nope")).rc).toBe(66);
    expect((await plan("../x")).rc).toBe(2);
    let err = "";
    expect(await runUndo(["run-a"], { repoDir: repo, runsRoot, err: (s) => (err += s) })).toBe(2);
    expect(err).toContain("only --plan");
  });

  test("--json is a parseable plan", async () => {
    const r = await plan("run-a", ["--allow-unsigned", "--json"]);
    const p = JSON.parse(r.out) as UndoPlan;
    expect(p.run_id).toBe("run-a");
    expect(p.commits.every((c) => c.state === "on-default")).toBe(true);
  });

  test("the allowlist holds no mutating git subcommand", () => {
    for (const bad of ["checkout", "reset", "branch", "revert", "commit", "merge", "push", "fetch", "update-ref", "clean", "gc", "worktree", "stash", "switch", "restore", "add", "rm", "tag"]) expect(READ_ONLY_GIT.has(bad)).toBe(false);
  });
});

function execFileSyncSafe(dir: string, args: readonly string[]): { status: number; stdout: string } {
  try { return { status: 0, stdout: execFileSync("git", ["-C", dir, ...args], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) }; } catch (e) {
    return { status: (e as { status?: number }).status ?? 128, stdout: "" };
  }
}
