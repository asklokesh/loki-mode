import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAfterBlock, captureBeforeAfter, realDeps, type BeforeAfterDeps } from "../../src/integrations/before_after.ts";

let root = "", REPO = "", RUN = "";
const g = (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: REPO, encoding: "utf8" }).trim();
const alive = (pid: number): boolean => { try { process.kill(-pid, 0); return true; } catch { return false; } };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ba-"));
  REPO = join(root, "repo"); RUN = join(root, "run");
  mkdirSync(REPO); mkdirSync(RUN);
  g("init", "-q");
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ scripts: { dev: "echo dev" } }));
  g("add", "package.json"); g("commit", "-qm", "base");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CHANGED = ["src/app/dashboard/page.tsx"];
/** Fake capture: writes a png under <runDir>/evidence/x and reports a detached sleeper as the dev server. */
function fakeDeps(opts: { failTree?: string; spawned?: number[]; trees?: string[]; removed?: string[] } = {}): BeforeAfterDeps {
  return {
    ...realDeps,
    worktreeRemove: (repo, path) => { opts.removed?.push(path); realDeps.worktreeRemove(repo, path); },
    capture: async (tree, runDir, _c, o) => {
      opts.trees?.push(tree);
      const c = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      c.unref();
      if (c.pid) { opts.spawned?.push(c.pid); o.onServer?.(c.pid); }
      if (opts.failTree && tree.endsWith(opts.failTree)) return { screens: [], http: false, skipped: "dev server did not answer within 1s" };
      mkdirSync(join(runDir, "evidence", "x"), { recursive: true });
      writeFileSync(join(runDir, "evidence", "x", "dashboard.png"), tree);
      return { screens: [{ path: "evidence/x/dashboard.png", sha256: "ab".repeat(32) }], http: false, skipped: null };
    },
  };
}

test("both sides captured, files under the run dir, section lists both", async () => {
  const trees: string[] = [];
  const out = await beforeAfterBlock(REPO, RUN, CHANGED, "HEAD", { env: {}, deps: fakeDeps({ trees }) });
  expect(out).toContain("## Before / After");
  expect(out).toContain("before_after/before/evidence/x/dashboard.png");
  expect(out).toContain("before_after/after/evidence/x/dashboard.png");
  expect(existsSync(join(RUN, "before_after", "before", "evidence", "x", "dashboard.png"))).toBe(true);
  expect(existsSync(join(RUN, "before_after", "after", "evidence", "x", "dashboard.png"))).toBe(true);
  expect(trees[0]).toContain("base-tree");
  expect(trees[1]).toBe(REPO);
});

test("boot failure on the base tree records the reason and never throws", async () => {
  const out = await beforeAfterBlock(REPO, RUN, CHANGED, "HEAD", { env: {}, deps: fakeDeps({ failTree: "base-tree" }) });
  expect(out).toContain("before/after: NOT CAPTURED (base tree: dev server did not answer within 1s)");
});

test("boot failure on the changed tree records the reason", async () => {
  const out = await beforeAfterBlock(REPO, RUN, CHANGED, "HEAD", { env: {}, deps: fakeDeps({ failTree: "repo" }) });
  expect(out).toContain("NOT CAPTURED (changed tree: dev server did not answer");
});

test("no dev command: NOT CAPTURED and no worktree is created", async () => {
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ scripts: { build: "x" } }));
  const removed: string[] = [], trees: string[] = [];
  const out = await beforeAfterBlock(REPO, RUN, CHANGED, "HEAD", { env: {}, deps: fakeDeps({ removed, trees }) });
  expect(out).toContain("before/after: NOT CAPTURED (no dev or start command");
  expect(trees).toEqual([]);
  expect(existsSync(join(RUN, "before_after", "base-tree"))).toBe(false);
});

test("no changed route: NOT CAPTURED", async () => {
  const out = await beforeAfterBlock(REPO, RUN, ["README.md"], "HEAD", { env: {}, deps: fakeDeps() });
  expect(out).toContain("NOT CAPTURED (no changed UI route identified)");
});

test("recorded PIDs are stopped and the exact temp worktree is removed, also on failure", async () => {
  for (const failTree of [undefined, "base-tree"]) {
    const spawned: number[] = [], removed: string[] = [];
    await beforeAfterBlock(REPO, RUN, CHANGED, "HEAD", { env: {}, deps: fakeDeps({ spawned, removed, failTree }) });
    expect(spawned.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    for (const p of spawned) expect(alive(p)).toBe(false);
    expect(removed).toEqual([join(RUN, "before_after", "base-tree")]);
    expect(existsSync(removed[0]!)).toBe(false);
    expect(g("worktree", "list")).not.toContain("base-tree");
  }
});

test("a worktree add failure is a NOT CAPTURED line", async () => {
  const out = await beforeAfterBlock(REPO, RUN, CHANGED, "no-such-ref", { env: {}, deps: fakeDeps() });
  expect(out).toContain("NOT CAPTURED (base worktree failed");
});

test("LOKI_BEFORE_AFTER=0 is byte-identical: empty, nothing created, capture never called", async () => {
  const trees: string[] = [];
  const out = await beforeAfterBlock(REPO, RUN, CHANGED, "HEAD", { env: { LOKI_BEFORE_AFTER: "0" }, deps: fakeDeps({ trees }) });
  expect(out).toBe("");
  expect(trees).toEqual([]);
  expect(existsSync(join(RUN, "before_after"))).toBe(false);
});

test("captureBeforeAfter forces headless env", async () => {
  let seen: NodeJS.ProcessEnv | undefined;
  const deps: BeforeAfterDeps = { ...fakeDeps(), capture: async (_t, _r, _c, o) => { seen = o.env; return { screens: [], http: false, skipped: "x" }; } };
  await captureBeforeAfter(REPO, RUN, CHANGED, "HEAD", { env: {}, deps });
  expect(seen?.["LOKI_NO_BROWSER"]).toBe("1");
});
