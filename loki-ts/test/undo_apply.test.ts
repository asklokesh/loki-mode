// UNDO-2: `LOKI_UNDO=1 loki undo <run-id>` applies the plan. Fixture repos live in a run-owned temp dir; this repo is never touched.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUndo, type UndoDeps } from "../src/commands/undo.ts";
import { APPLY_GIT, type ApplyGit } from "../src/commands/undo_apply.ts";
import { computeReceiptHash } from "../src/engine10/verify_cmd.ts";
import { signReceipt } from "../src/engine10/stages/seal.ts";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LOKI_NO_BROWSER: "1" };
let root = "", repo = "", runsRoot = "", undoDir = "", savedKey: string | undefined;
let n = 0;
const sh = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=false", ...a], { env: ENV, encoding: "utf8" }).trim();

function commit(file: string, msg: string, trailer?: string): string {
  writeFileSync(join(repo, file), msg);
  sh(repo, "add", file);
  sh(repo, "commit", "-q", "-m", msg, ...(trailer ? ["-m", `Loki-Run: ${trailer}`] : []));
  return sh(repo, "rev-parse", "HEAD");
}
function writeReceipt(runId: string, base: string, head: string, mode: "signed" | "unsigned" | "tampered" = "signed"): void {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  const body: Record<string, unknown> = { schema: "loki.v10.receipt/1", run_id: runId, base_sha: base, head_sha: head, verdict: "VERIFIED" };
  const hash = computeReceiptHash(body);
  const sig = mode === "unsigned" ? { jwt: null, kid: null } : signReceipt(runId, hash);
  const rec: Record<string, unknown> = { ...body, receipt_sha256: hash, verification: sig };
  if (mode === "tampered") rec["head_sha"] = base;
  writeFileSync(join(dir, "receipt.json"), JSON.stringify(rec));
}
function snap(): string {
  return [sh(repo, "for-each-ref", "--format=%(refname) %(objectname)"), sh(repo, "rev-parse", "HEAD"), sh(repo, "status", "--porcelain=v1", "--branch"), sh(repo, "worktree", "list")].join("\n--\n");
}
interface Fx { base: string; head: string }
/** main + loki/<id> with two run commits. */
function fixture(id: string): Fx {
  const base = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-q", "-b", `loki/${id}`, base);
  commit(`${id}-1.txt`, `${id}-1`, id);
  const head = commit(`${id}-2.txt`, `${id}-2`, id);
  sh(repo, "checkout", "-q", "main");
  return { base, head };
}
const record = (id: string): { status: string; reason: string | null; steps: { step: string; ok: boolean }[]; pre_undo: Record<string, string | null> } => JSON.parse(readFileSync(join(undoDir, `${id}.json`), "utf8"));

async function undo(args: string[], extra: Partial<UndoDeps> = {}, env: NodeJS.ProcessEnv = { LOKI_UNDO: "1" }): Promise<{ rc: number; out: string; err: string }> {
  let out = "", err = "";
  const rc = await runUndo(args, { repoDir: repo, runsRoot, undoDir, env, out: (s) => (out += s), err: (s) => (err += s), ...extra });
  return { rc, out, err };
}

beforeAll(() => {
  root = mkdtempSync(join(process.env["LOKI_RUN_TMP"] ?? tmpdir(), "loki-run-undoapply-"));
  savedKey = process.env["LOKI_RECEIPT_SIGNING_KEY"];
  process.env["LOKI_RECEIPT_SIGNING_KEY"] = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY"]; else process.env["LOKI_RECEIPT_SIGNING_KEY"] = savedKey;
});
beforeEach(() => {
  const dir = join(root, `case-${++n}`);
  repo = join(dir, "repo"); runsRoot = join(dir, "runs"); undoDir = join(dir, "undo");
  mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "base.txt"), "base");
  sh(repo, "add", "base.txt");
  sh(repo, "commit", "-q", "-m", "base");
});
afterEach(() => { rmSync(join(root, `case-${n}`), { recursive: true, force: true }); });

describe("loki undo apply", () => {
  test("merged run: reverts on a new branch, base tree restored, current branch and tree untouched", async () => {
    const f = fixture("r1");
    sh(repo, "merge", "-q", "--no-ff", "-m", "merge r1", "loki/r1");
    writeReceipt("r1", f.base, f.head);
    const mainTip = sh(repo, "rev-parse", "main");
    const r = await undo(["r1", "--yes"]);
    expect(r.rc).toBe(0);
    expect(sh(repo, "rev-parse", "loki/undo-r1^{tree}")).toBe(sh(repo, `rev-parse`, `${f.base}^{tree}`));
    expect(sh(repo, "rev-parse", "main")).toBe(mainTip);
    expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(sh(repo, "status", "--porcelain")).toBe("");
    expect(sh(repo, "worktree", "list").split("\n").length).toBe(1);
    expect(record("r1").status).toBe("applied");
    expect(record("r1").steps.map((s) => s.step)).toContain("revert");
  });

  test("unmerged run: local branch deleted, tip kept at a pre-undo ref, HEAD untouched", async () => {
    const f = fixture("r2");
    writeReceipt("r2", f.base, f.head);
    const head0 = sh(repo, "rev-parse", "HEAD");
    const r = await undo(["r2", "--yes"]);
    expect(r.rc).toBe(0);
    expect(() => sh(repo, "rev-parse", "--verify", "-q", "refs/heads/loki/r2")).toThrow();
    expect(sh(repo, "rev-parse", "refs/loki/undo/r2/branch")).toBe(f.head);
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head0);
    expect(record("r2").pre_undo["run_branch_tip"]).toBe(f.head);
  });

  test("no --yes and no terminal: dry run, nothing changes, no record", async () => {
    const f = fixture("r3");
    writeReceipt("r3", f.base, f.head);
    const before = snap();
    const r = await undo(["r3"]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("dry run");
    expect(snap()).toBe(before);
    expect(existsSync(join(undoDir, "r3.json"))).toBe(false);
  });

  test("a declined prompt changes nothing; an accepted prompt applies", async () => {
    const f = fixture("r4");
    writeReceipt("r4", f.base, f.head);
    const before = snap();
    expect((await undo(["r4"], { confirm: async () => false })).rc).toBe(0);
    expect(snap()).toBe(before);
    expect((await undo(["r4"], { confirm: async () => true })).rc).toBe(0);
    expect(() => sh(repo, "rev-parse", "--verify", "-q", "refs/heads/loki/r4")).toThrow();
  });

  test("later foreign commit on the run branch: refused, branch intact, record written", async () => {
    const f = fixture("r5");
    sh(repo, "checkout", "-q", "loki/r5");
    commit("human.txt", "human");
    sh(repo, "checkout", "-q", "main");
    writeReceipt("r5", f.base, f.head);
    const before = snap();
    const r = await undo(["r5", "--yes"]);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("not this run's work");
    expect(snap()).toBe(before);
    expect(record("r5").status).toBe("refused");
  });

  test("dirty tracked file: refused and left as it was", async () => {
    const f = fixture("r6");
    writeReceipt("r6", f.base, f.head);
    writeFileSync(join(repo, "base.txt"), "edited");
    const before = snap();
    const r = await undo(["r6", "--yes"]);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("uncommitted");
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("edited");
    expect(snap()).toBe(before);
    expect(record("r6").status).toBe("refused");
  });

  test("the run branch is checked out: refused", async () => {
    const f = fixture("r7");
    sh(repo, "checkout", "-q", "loki/r7");
    writeReceipt("r7", f.base, f.head);
    const r = await undo(["r7", "--yes"]);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("checked-out");
    expect(sh(repo, "rev-parse", "--verify", "refs/heads/loki/r7")).toBe(f.head);
  });

  test("revert conflict fails cleanly: no undo branch, no worktree, tree untouched, failure recorded", async () => {
    const f = fixture("r8");
    sh(repo, "merge", "-q", "--no-ff", "-m", "merge r8", "loki/r8");
    commit("r8-1.txt", "later change on main"); // a later edit to a file the run added makes the revert conflict
    writeReceipt("r8", f.base, f.head);
    const before = snap();
    const r = await undo(["r8", "--yes"]);
    expect(r.rc).toBe(1);
    expect(snap()).toBe(before);
    expect(record("r8").status).toBe("failed");
  });

  test("tampered and unsigned receipts are refused even with --yes", async () => {
    const f = fixture("r9"), g = fixture("r10");
    writeReceipt("r9", f.base, f.head, "tampered");
    writeReceipt("r10", g.base, g.head, "unsigned");
    const before = snap();
    expect((await undo(["r9", "--yes"])).rc).toBe(1);
    expect((await undo(["r10", "--yes"])).rc).toBe(3);
    expect((await undo(["r10", "--yes", "--allow-unsigned"])).rc).toBe(2);
    expect(snap()).toBe(before);
  });

  test("hostile receipt refs are refused before any git call and write nothing", async () => {
    const f = fixture("r17");
    const victim = join(root, "PWNED-apply");
    writeReceipt("r17", `--output=${victim}`, f.head);
    const calls: string[][] = [];
    const before = snap();
    const r = await undo(["r17", "--yes"], { applyGit: (_d, a) => (calls.push([...a]), { status: 1, stdout: "", stderr: "" }) });
    expect(r.rc).toBe(2);
    expect(calls).toEqual([]);
    expect(existsSync(victim)).toBe(false);
    expect(snap()).toBe(before);
  });

  test("apply is off without LOKI_UNDO=1", async () => {
    const f = fixture("r11");
    writeReceipt("r11", f.base, f.head);
    const before = snap();
    expect((await undo(["r11", "--yes"], {}, {})).rc).toBe(2);
    expect(snap()).toBe(before);
  });

  test("recorded git argv: allowed subcommands only, no force, push, reset or hard", async () => {
    const f = fixture("r12");
    sh(repo, "merge", "-q", "--no-ff", "-m", "merge r12", "loki/r12");
    const g = fixture("r13");
    writeReceipt("r12", f.base, f.head);
    writeReceipt("r13", g.base, g.head);
    const argv: string[][] = [];
    const rec: ApplyGit = (dir, args) => {
      argv.push([...args]);
      try { return { status: 0, stdout: execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=false", ...args], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; } catch (e) {
        const x = e as { status?: number; stdout?: string; stderr?: string };
        return { status: x.status ?? 128, stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? "") };
      }
    };
    expect((await undo(["r12", "--yes"], { applyGit: rec })).rc).toBe(0);
    expect((await undo(["r13", "--yes"], { applyGit: rec })).rc).toBe(0);
    expect(argv.length).toBeGreaterThan(5);
    for (const a of argv) {
      expect(APPLY_GIT.has(a.find((x) => !x.startsWith("-")) ?? "")).toBe(true);
      for (const x of a) expect(x).not.toMatch(/^(--force|-f|-D|--hard|--force-with-lease|--delete|push|reset|checkout|switch|clean|rebase)$/);
    }
  });

  test("--close-pr closes the recorded PR through the injected closer only when asked", async () => {
    const f = fixture("r14");
    writeReceipt("r14", f.base, f.head);
    mkdirSync(join(runsRoot, "r14"), { recursive: true });
    writeFileSync(join(runsRoot, "r14", "events.jsonl"), JSON.stringify({ v: 1, seq: 0, ts: "2026-10-08T00:00:00.000Z", run: "r14", type: "run.completed", stage: null, data: { pr_url: "https://github.com/o/r/pull/3" } }) + "\n");
    const closed: string[] = [];
    const r = await undo(["r14", "--yes", "--close-pr"], { closePr: (u) => (closed.push(u), { ok: true, message: "" }) });
    expect(r.rc).toBe(0);
    expect(closed).toEqual(["https://github.com/o/r/pull/3"]);
    const g = fixture("r15");
    writeReceipt("r15", g.base, g.head);
    const closed2: string[] = [];
    expect((await undo(["r15", "--yes"], { closePr: (u) => (closed2.push(u), { ok: true, message: "" }) })).rc).toBe(0);
    expect(closed2).toEqual([]);
  });

  test("a failed PR close is recorded and exits 1", async () => {
    const f = fixture("r16");
    writeReceipt("r16", f.base, f.head);
    writeFileSync(join(runsRoot, "r16", "events.jsonl"), JSON.stringify({ v: 1, seq: 0, ts: "2026-10-08T00:00:00.000Z", run: "r16", type: "run.completed", stage: null, data: { pr_url: "https://github.com/o/r/pull/4" } }) + "\n");
    const r = await undo(["r16", "--yes", "--close-pr"], { closePr: () => ({ ok: false, message: "gh: not logged in" }) });
    expect(r.rc).toBe(1);
    expect(record("r16").status).toBe("failed");
    expect(record("r16").steps.find((s) => s.step === "close-pr")?.ok).toBe(false);
  });
});

test("gh pr close child env carries only gh auth keys, never the rest of the parent env", async () => {
  const { ghCloseEnv } = await import("../src/commands/undo_apply.ts");
  const env = ghCloseEnv({ PATH: "/bin", HOME: "/h", GH_TOKEN: "t", SSH_AUTH_SOCK: "/s", ANTHROPIC_API_KEY: "k", AWS_SECRET_ACCESS_KEY: "a" } as NodeJS.ProcessEnv);
  expect(env).toEqual({ PATH: "/bin", HOME: "/h", GH_TOKEN: "t" });
});
