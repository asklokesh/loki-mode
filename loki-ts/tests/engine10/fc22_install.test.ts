// FC-22 S3: the install pre-step library. Fake installers are tiny shell scripts (tests/fixtures/install-fc22); no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectApi } from "../../src/project_model/api.ts";
import { changedFiles } from "../../src/util/check_result.ts";
import { dropSet, parseStaged } from "../../src/e10ext/commit_filter.ts";
import { currentDiff } from "../../src/runner/session_resume.ts";
import { installOwned } from "../../src/project_model/install.ts";
import { absentDepRoots, intakeDeps, lockedInstall, prepareDeps, resetInstallMemo } from "../../src/project_model/install.ts";
import type { ProjectModel } from "../../src/project_model/schema.ts";

const FIX = resolve(import.meta.dir, "../fixtures/install-fc22");
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t"];
let repo: string;
const git = (...a: string[]): string => execFileSync("git", [...GIT, ...a], { cwd: repo, env: process.env, encoding: "utf8" });

const model = (installs: Record<string, string | null>) => projectApi({
  schema: "loki.v10.project/1", status: "ok", key: "k", workspaceKind: "workspaces", workspaceCite: [],
  packages: Object.entries(installs).map(([root, cmd]) => ({
    name: root, root, runner: null, commands: { test: null, lint: null, build: null, start: null }, ui: { present: false, boot: null }, cite: [],
    install: cmd === null ? null : { cmd, cwd: root, cite: [`${root}/manifest`] },
  })),
} as unknown as ProjectModel);
const failed = (...roots: string[]) => roots.map((root) => ({ root, harnessOwned: true }));
const base = () => ({ repoDir: repo, signal: new AbortController().signal, timeoutMs: 60_000, env: {} as Record<string, string>, opts: { runId: "r1" } });

beforeEach(() => {
  resetInstallMemo();
  repo = mkdtempSync(join(tmpdir(), "loki-fc22-"));
  execFileSync("git", ["init", "-q"], { cwd: repo, env: process.env });
  for (const p of ["a", "b"]) { mkdirSync(join(repo, p)); writeFileSync(join(repo, p, "package-lock.json"), "lock\n"); }
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git("add", "."); git("commit", "-qm", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("prepareDeps", () => {
  test("one install check per load-failed package, run with its cwd", async () => {
    const m = model({ a: `sh ${FIX}/ok.sh`, b: `sh ${FIX}/ok.sh`, c: `sh ${FIX}/ok.sh` });
    mkdirSync(join(repo, "c"));
    const r = await prepareDeps({ ...base(), model: m, failed: [...failed("a", "b"), { root: "c", harnessOwned: false }, ...failed("a")] });
    expect(r.checks.map((c) => [c.name, c.cwd, c.result])).toEqual([["install:a", "a", "pass"], ["install:b", "b", "pass"]]);
    expect(existsSync(join(repo, "a/node_modules/.installed"))).toBe(true);
    expect(existsSync(join(repo, "b/node_modules/.installed"))).toBe(true);
    expect(existsSync(join(repo, "c/node_modules"))).toBe(false);
  });
  test("no failed harness-owned check: nothing runs", async () => {
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/ok.sh` }), failed: [{ root: "a", harnessOwned: false }] });
    expect(r.checks).toEqual([]);
  });
  test("no install command: nothing runs, NOT PROVEN names the package", async () => {
    const r = await prepareDeps({ ...base(), model: model({ a: null }), failed: failed("a") });
    expect(r.checks).toEqual([]);
    expect(r.notProven.join("\n")).toMatch(/NOT PROVEN.*package a /);
    const r2 = await prepareDeps({ ...base(), model: null, failed: failed("zz") });
    expect(r2.checks).toEqual([]);
    expect(r2.notProven.join("\n")).toContain("zz");
  });
  test("LOKI_E10_INSTALL=0 skips the install", async () => {
    const r = await prepareDeps({ ...base(), env: { LOKI_E10_INSTALL: "0" }, model: model({ a: `sh ${FIX}/ok.sh` }), failed: failed("a") });
    expect(r.checks).toEqual([]);
    expect(r.skipped).toBe("opt-out");
    expect(existsSync(join(repo, "a/node_modules"))).toBe(false);
  });
  test("loki.yaml verify.install_deps: false skips the install", async () => {
    writeFileSync(join(repo, "loki.yaml"), "verify:\n  install_deps: false\n");
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/ok.sh` }), failed: failed("a") });
    expect(r.checks).toEqual([]);
    expect(r.skipped).toBe("opt-out");
    expect(existsSync(join(repo, "a/node_modules"))).toBe(false);
  });
  test("runs once per package per run across fix rounds; a new run installs again", async () => {
    const m = model({ a: `sh ${FIX}/ok.sh` });
    expect((await prepareDeps({ ...base(), model: m, failed: failed("a") })).checks).toHaveLength(1);
    expect((await prepareDeps({ ...base(), model: m, failed: failed("a") })).checks).toHaveLength(0);
    expect((await prepareDeps({ ...base(), opts: { runId: "r2" }, model: m, failed: failed("a") })).checks).toHaveLength(1);
  });
  test("a failed install is not_run owned by the harness, never fail", async () => {
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/fail.sh` }), failed: failed("a") });
    expect(r.checks[0]).toMatchObject({ name: "install:a", result: "not_run", owner: "harness", reason: "install exited 3: boom" });
    expect(r.checks.some((c) => (c.result as string) === "fail")).toBe(false);
    expect(r.notProven.join("\n")).toContain("install:a");
  });
  test("a timeout kills the recorded process group and is not_run", async () => {
    const t0 = Date.now();
    const r = await prepareDeps({ ...base(), timeoutMs: 400, model: model({ a: `sh ${FIX}/slow.sh` }), failed: failed("a") });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.checks[0]).toMatchObject({ result: "not_run", owner: "harness" });
    expect(r.checks[0]!.reason).toMatch(/timed out/);
  });
  test("an abort stops the install", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await prepareDeps({ ...base(), signal: ac.signal, model: model({ a: `sh ${FIX}/slow.sh` }), failed: failed("a") });
    expect(r.checks[0]).toMatchObject({ result: "not_run", reason: "aborted" });
  });
  test("an install that writes a tracked lockfile is restored and listed; new untracked files are listed", async () => {
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/lock.sh` }), failed: failed("a") });
    expect(r.checks[0]!.result).toBe("pass");
    expect(readFileSync(join(repo, "a/package-lock.json"), "utf8")).toBe("lock\n");
    expect(r.restored).toEqual(["a/package-lock.json"]);
    expect(r.untracked).toEqual(["a/stray.txt"]);
    expect(r.untracked.some((p) => p.includes("node_modules"))).toBe(false);
    expect(git("status", "--porcelain")).not.toContain("package-lock.json");
  });
  test("a tracked file the agent had already edited is never restored", async () => {
    writeFileSync(join(repo, "a/package-lock.json"), "agent edit\n");
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/lock_dirty.sh` }), failed: failed("a") });
    expect(r.restored).toEqual([]);
    expect(r.unrestored).toEqual(["a/package-lock.json"]);
    expect(readFileSync(join(repo, "a/package-lock.json"), "utf8")).toContain("agent edit");
  });
  test("a glob-looking path is restored literally and never takes the agent's own file with it", async () => {
    mkdirSync(join(repo, "pages"));
    const odd = "pages/we ird\nname.txt";
    writeFileSync(join(repo, "pages/[id].tsx"), "base\n"); writeFileSync(join(repo, "pages/d.tsx"), "base\n"); writeFileSync(join(repo, odd), "base\n");
    git("add", "."); git("commit", "-qm", "pages");
    writeFileSync(join(repo, "pages/d.tsx"), "agent edit\n");
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/glob.sh` }), failed: failed("a") });
    expect(r.restored.sort()).toEqual([odd, "pages/[id].tsx"].sort());
    expect(readFileSync(join(repo, "pages/d.tsx"), "utf8")).toBe("agent edit\n");
    expect(readFileSync(join(repo, "pages/[id].tsx"), "utf8")).toBe("base\n");
    expect(readFileSync(join(repo, odd), "utf8")).toBe("base\n");
    expect(r.unrestored).toEqual([]);
  });
  test("a non-git repo: the guard did not run and NOT PROVEN says so", async () => {
    const plain = mkdtempSync(join(tmpdir(), "loki-fc22p-"));
    try {
      mkdirSync(join(plain, "a"));
      const r = await prepareDeps({ ...base(), repoDir: plain, model: model({ a: `sh ${FIX}/ok.sh` }), failed: failed("a") });
      expect(r.checks[0]!.result).toBe("pass");
      expect(r.notProven.join("\n")).toContain("install:a tree guard not run (git status failed)");
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });
  test("a before-snapshot failure (install creates the repo) is reported", async () => {
    const plain = mkdtempSync(join(tmpdir(), "loki-fc22p-"));
    try {
      mkdirSync(join(plain, "a"));
      const r = await prepareDeps({ ...base(), repoDir: plain, model: model({ a: `sh ${FIX}/initgit.sh` }), failed: failed("a") });
      expect(r.notProven.join("\n")).toContain("tree guard not run");
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });
  test("an after-snapshot failure (install destroys the repo) is reported", async () => {
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/breakgit.sh` }), failed: failed("a") });
    expect(r.notProven.join("\n")).toContain("install:a tree guard not run (git status failed)");
  });
  test("a clean guard has no guard note", async () => {
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/ok.sh` }), failed: failed("a") });
    expect(r.notProven).toEqual([]);
  });
  test("an install cwd that is a link out of the repo is not run", async () => {
    const out = mkdtempSync(join(tmpdir(), "loki-fc22o-"));
    try {
      rmSync(join(repo, "b"), { recursive: true, force: true });
      symlinkSync(out, join(repo, "b"));
      const r = await prepareDeps({ ...base(), model: model({ b: `sh ${FIX}/ok.sh` }), failed: failed("b") });
      expect(r.checks[0]).toMatchObject({ result: "not_run", owner: "harness" });
      expect(r.checks[0]!.reason).toMatch(/outside the repo/);
      expect(existsSync(join(out, "node_modules"))).toBe(false);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
  test("a backgrounded orphan cannot write after the guard", async () => {
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/orphan.sh` }), failed: failed("a") });
    expect(r.checks[0]!.result).toBe("pass");
    await new Promise((res) => setTimeout(res, 1500));
    expect(existsSync(join(repo, "late.txt"))).toBe(false);
  });
  test("a pre-existing untracked file the install changed is listed as unrestored", async () => {
    writeFileSync(join(repo, "notes.txt"), "mine\n");
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/touch_untracked.sh` }), failed: failed("a") });
    expect(r.unrestored).toEqual(["notes.txt"]);
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toContain("changed");
  });
  test("a failed install carries a short output excerpt; the timeout shows a decimal", async () => {
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/fail.sh` }), failed: failed("a") });
    expect(r.checks[0]!.reason).toBe("install exited 3: boom");
    const t = await prepareDeps({ ...base(), timeoutMs: 400, model: model({ b: `sh ${FIX}/slow.sh` }), failed: failed("b") });
    expect(t.checks[0]!.reason).toContain("timed out after 0.4s");
  });
});

// FC-DEPS-NOT-INSTALLED: a fresh clone (manifest present, nothing ever installed) is installed once at intake, before the baseline.
const lockPkg = (root: string, cmd: string | null) => ({
  name: root, root, runner: null, commands: { test: null, lint: null, build: null, start: null }, ui: { present: false, boot: null }, cite: [`${root}/package-lock.json`], dependsOn: [],
  install: cmd === null ? null : { cmd, cwd: root, cite: [`${root}/package-lock.json`] },
});
const lockModel = (installs: Record<string, string | null>) => projectApi({
  schema: "loki.v10.project/1", status: "ok", key: "k", workspaceKind: "multi-root", workspaceCite: [], fingerprintFiles: [],
  packages: Object.entries(installs).map(([root, cmd]) => lockPkg(root, cmd)),
} as unknown as ProjectModel);

describe("absentDepRoots and intakeDeps (FC-DEPS-NOT-INSTALLED)", () => {
  test("a fresh clone names every package with a cited lockfile; an installed one is left alone", () => {
    const m = lockModel({ a: `sh ${FIX}/ok.sh`, b: `sh ${FIX}/ok.sh` });
    expect(absentDepRoots(repo, m)).toEqual(["a", "b"]);
    mkdirSync(join(repo, "a/node_modules")); writeFileSync(join(repo, "a/node_modules/x"), "");
    expect(absentDepRoots(repo, m)).toEqual(["b"]);
  });
  test("a cited file that does not exist, no install command, or no model: nothing is named", () => {
    expect(absentDepRoots(repo, model({ a: `sh ${FIX}/ok.sh` }))).toEqual([]);
    expect(absentDepRoots(repo, lockModel({ a: null }))).toEqual([]);
    expect(absentDepRoots(repo, null)).toEqual([]);
  });
  test("Loki's own .loki/ at the repo root is not an installed dependency directory", () => {
    writeFileSync(join(repo, "package-lock.json"), "lock\n"); git("add", "package-lock.json"); git("commit", "-qm", "root");
    mkdirSync(join(repo, ".loki")); writeFileSync(join(repo, ".loki/x"), "");
    expect(absentDepRoots(repo, lockModel({ ".": `sh ${FIX}/ok.sh` }))).toEqual(["."]);
    mkdirSync(join(repo, "node_modules")); writeFileSync(join(repo, "node_modules/x"), "");
    expect(absentDepRoots(repo, lockModel({ ".": `sh ${FIX}/ok.sh` }))).toEqual([]);
  });
  // FC-DEPS-NOT-INSTALLED: what the install created is recorded as intake data (file hashes, created dirs); nothing is written to the repo's git config or exclude files.
  const INSTALL = `sh -c "mkdir -p node_modules .venv && : > node_modules/x && : > .venv/y && echo l > bun.lock && echo p > pnpm-lock.yaml && echo l > ../package-lock.json"`;
  const prep = (dir: string, cmd: string) => {
    mkdirSync(join(dir, ".loki"), { recursive: true });
    writeFileSync(join(dir, ".loki/project.json"), JSON.stringify({ schema: "loki.v10.project/1", status: "ok", key: "k", workspaceKind: "multi-root", workspaceCite: ["a/package-lock.json"], fingerprintFiles: ["a/package-lock.json"], packages: [lockPkg("a", cmd)] }));
  };
  const runDeps = async (dir: string): Promise<Record<string, unknown>> => {
    const saved = process.env["LOKI_E10_PROJECT_MODEL"]; process.env["LOKI_E10_PROJECT_MODEL"] = "1";
    try { return await intakeDeps({ repoDir: dir, runId: "r-ic", emit: () => {} } as never, new AbortController().signal, []); } finally { if (saved === undefined) delete process.env["LOKI_E10_PROJECT_MODEL"]; else process.env["LOKI_E10_PROJECT_MODEL"] = saved; }
  };
  /** The commit stage's set: git add -A, then what dropSet keeps. */
  const commitSet = (dir: string, installCreated: unknown): string[] => {
    execFileSync("git", [...GIT, "add", "-A", "--", ".", ":(exclude).loki"], { cwd: dir });
    const staged = parseStaged(execFileSync("git", [...GIT, "diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"], { cwd: dir, encoding: "utf8" }));
    const drop = new Set(dropSet(dir, staged, undefined, process.env, installCreated).map(({ f }) => f));
    return staged.map(({ f }) => f).filter((f) => !drop.has(f)).sort();
  };
  const baseOf = (dir: string): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const visible = (dir: string, ic: unknown): string[] => changedFiles(dir, baseOf(dir), installOwned(dir, ic)).filter((f) => !f.startsWith(".loki/")).sort();
  test("install-created paths (node_modules without a gitignore, lockfiles, .venv) are absent from changedFiles and the commit set", async () => {
    git("rm", "-q", ".gitignore"); git("commit", "-qm", "no gitignore");
    prep(repo, INSTALL); writeFileSync(join(repo, "mine.txt"), "operator file\n");
    const ic = (await runDeps(repo))["install_created"];
    expect(ic).toBeTruthy();
    expect(visible(repo, ic)).toEqual(["mine.txt"]);
    expect(commitSet(repo, ic)).toEqual(["mine.txt"]);
  });
  test("an agent-modified install-created lockfile IS in changedFiles and the commit set; the dependency tree stays out", async () => {
    git("rm", "-q", ".gitignore"); git("commit", "-qm", "no gitignore");
    prep(repo, INSTALL);
    const ic = (await runDeps(repo))["install_created"];
    writeFileSync(join(repo, "package-lock.json"), "agent changed this\n");
    writeFileSync(join(repo, "a/node_modules/extra"), "dep tree content is never a change\n");
    expect(visible(repo, ic)).toEqual(["package-lock.json"]);
    expect(commitSet(repo, ic)).toEqual(["package-lock.json"]);
  });
  test("intakeDeps leaves .git/info/exclude unchanged, in a clone and in a linked worktree (common dir)", async () => {
    const exclude = (d: string): string => { const p = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: d, encoding: "utf8" }).trim(); const f = resolve(d, p); return existsSync(f) ? readFileSync(f, "utf8") : ""; };
    git("rm", "-q", ".gitignore"); git("commit", "-qm", "no gitignore");
    const before = exclude(repo); prep(repo, INSTALL); await runDeps(repo);
    expect(exclude(repo)).toBe(before);
    const wt = `${repo}-wt`;
    try {
      git("worktree", "add", "-q", "--detach", wt, "HEAD"); resetInstallMemo(); prep(wt, INSTALL);
      expect((await runDeps(wt))["install_created"]).toBeTruthy();
      expect(exclude(wt)).toBe(before); expect(exclude(repo)).toBe(before);
    } finally { rmSync(wt, { recursive: true, force: true }); }
  });
  test("currentDiff lists the agent's new file but not install-created paths", async () => {
    git("rm", "-q", ".gitignore"); git("commit", "-qm", "no gitignore");
    prep(repo, INSTALL); const ic = (await runDeps(repo))["install_created"]; writeFileSync(join(repo, "mine.txt"), "x\n");
    const d = currentDiff(repo, baseOf(repo), 6000, false, installOwned(repo, ic)) ?? "";
    expect(d).toContain("mine.txt"); expect(d).not.toContain("node_modules"); expect(d).not.toContain("bun.lock");
  });
  test("a failed install records nothing that hides files", async () => {
    git("rm", "-q", ".gitignore"); git("commit", "-qm", "no gitignore");
    prep(repo, `sh -c "mkdir -p node_modules && : > node_modules/x && echo l > bun.lock; exit 3"`);
    const out = await runDeps(repo);
    expect(out["install_created"]).toBeUndefined();
    expect(visible(repo, out["install_created"])).toEqual(["a/bun.lock", "a/node_modules/x"]);
  });
  test("intakeDeps installs absent packages once, emits deps.install, and a failure is NOT PROVEN while the run goes on", async () => {
    mkdirSync(join(repo, ".loki"));
    writeFileSync(join(repo, ".loki/project.json"), JSON.stringify({ schema: "loki.v10.project/1", status: "ok", key: "k", workspaceKind: "multi-root", workspaceCite: ["a/package-lock.json"], fingerprintFiles: ["a/package-lock.json"], packages: [lockPkg("a", `sh ${FIX}/ok.sh`), lockPkg("b", `sh ${FIX}/fail.sh`)] }));
    const events: [string, string | null, Record<string, unknown>][] = [];
    const ctx = { repoDir: repo, runId: "r-intake", emit: (t: string, s: string | null, d: Record<string, unknown>) => { events.push([t, s, d]); } };
    const saved = process.env["LOKI_E10_PROJECT_MODEL"];
    process.env["LOKI_E10_PROJECT_MODEL"] = "1"; // tests/preload.ts turns the model off
    try {
      const out = await intakeDeps(ctx as never, new AbortController().signal, []);
      expect(events.map(([t, s, d]) => [t, s, d.name, d.result])).toEqual([["deps.install", "intake", "install:a", "pass"], ["deps.install", "intake", "install:b", "not_run"]]);
      expect(existsSync(join(repo, "a/node_modules/.installed"))).toBe(true);
      expect((out.deps_not_proven as string[]).join("\n")).toContain("install exited 3: boom (install:b; harness-owned)");
      expect(await intakeDeps(ctx as never, new AbortController().signal, [])).toEqual({}); // a is installed now, b ran once this run
    } finally { if (saved === undefined) delete process.env["LOKI_E10_PROJECT_MODEL"]; else process.env["LOKI_E10_PROJECT_MODEL"] = saved; }
  });
});

// Founder 2026-10-19: the up-front install is the ecosystem's lockfile-frozen form; a failed locked install never falls back to a mutating one.
describe("lockedInstall (locked, reproducible install)", () => {
  const put = (dir: string, ...files: string[]): void => { for (const f of files) writeFileSync(join(dir, f), f === "package.json" ? "{}" : "x\n"); };
  // [lockfile, model command, expected command run]
  const TABLE: Array<[string, string, string]> = [
    ["package-lock.json", "npm install", "npm ci"],
    ["npm-shrinkwrap.json", "npm i --legacy-peer-deps", "npm ci --legacy-peer-deps"],
    ["pnpm-lock.yaml", "pnpm install", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn", "yarn install --frozen-lockfile"],
    ["yarn.lock", "yarn install", "yarn install --frozen-lockfile"],
    ["bun.lock", "bun install", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun i", "bun install --frozen-lockfile"],
    ["uv.lock", "uv sync", "uv sync --locked"],
    ["Pipfile.lock", "pipenv install --dev", "pipenv install --dev --deploy"],
    ["Cargo.lock", "cargo fetch", "cargo fetch --locked"],
    ["Gemfile.lock", "bundle install", "BUNDLE_FROZEN=true bundle install"],
    ["Gemfile.lock", "bundle", "BUNDLE_FROZEN=true bundle install"],
    ["composer.lock", "composer update", "composer install"],
  ];
  for (const [lock, cmd, want] of TABLE) {
    test(`${lock}: ${cmd} -> ${want}`, () => {
      put(repo, lock);
      const r = lockedInstall(repo, repo, cmd);
      expect([r.cmd, r.locked, r.rewritten]).toEqual([want, true, true]);
    });
  }
  test("yarn Berry (.yarnrc.yml or packageManager yarn@>=2) uses --immutable", () => {
    put(repo, "yarn.lock", ".yarnrc.yml");
    expect(lockedInstall(repo, repo, "yarn install").cmd).toBe("yarn install --immutable");
    rmSync(join(repo, ".yarnrc.yml"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ packageManager: "yarn@4.1.0" }));
    expect(lockedInstall(repo, repo, "yarn").cmd).toBe("yarn install --immutable");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ packageManager: "yarn@1.22.0" }));
    expect(lockedInstall(repo, repo, "yarn").cmd).toBe("yarn install --frozen-lockfile");
  });
  test("an already-locked command is kept byte for byte", () => {
    put(repo, "package-lock.json", "pnpm-lock.yaml", "uv.lock", "composer.lock", "Gemfile.lock", "Cargo.lock");
    for (const cmd of ["npm ci", "pnpm install --frozen-lockfile", "uv sync --locked", "composer install --no-dev", "BUNDLE_FROZEN=true bundle install", "cargo fetch --locked"]) {
      const r = lockedInstall(repo, repo, cmd);
      expect([r.cmd, r.locked, r.rewritten]).toEqual([cmd, true, false]);
    }
  });
  test("no lockfile: the model command is kept and the check says it is not locked", () => {
    const r = lockedInstall(repo, repo, "npm install");
    expect([r.cmd, r.locked, r.rewritten]).toEqual(["npm install", false, false]);
    expect(r.note).toContain("no package-lock.json or npm-shrinkwrap.json governs");
  });
  test("no rule matches, or the command names packages: kept and visibly not locked", () => {
    put(repo, "package-lock.json");
    expect(lockedInstall(repo, repo, "make deps")).toMatchObject({ cmd: "make deps", locked: false });
    const r = lockedInstall(repo, repo, "npm install left-pad");
    expect([r.cmd, r.locked]).toEqual(["npm install left-pad", false]);
  });
  test("poetry install already honors poetry.lock: kept unchanged and reported locked", () => {
    put(repo, "poetry.lock");
    expect(lockedInstall(repo, repo, "poetry install")).toMatchObject({ cmd: "poetry install", locked: true, rewritten: false });
  });
  test("pnpm --no-frozen-lockfile is dropped when --frozen-lockfile is added", () => {
    put(repo, "pnpm-lock.yaml");
    expect(lockedInstall(repo, repo, "pnpm install --no-frozen-lockfile --ignore-scripts").cmd).toBe("pnpm install --ignore-scripts --frozen-lockfile");
  });
  test("a segment with a || fallback is left as written and recorded unlocked", () => {
    put(repo, "package-lock.json");
    for (const fb of ["true", "npm install"]) {
      const r = lockedInstall(repo, repo, `npm install || ${fb}`);
      expect([r.cmd, r.locked, r.rewritten]).toEqual([`npm install || ${fb}`, false, false]);
      expect(r.note).toContain("fallback masks install failure");
    }
    const m = lockedInstall(repo, repo, "npm install && npm install || true");
    expect([m.cmd, m.locked]).toEqual(["npm ci && npm install || true", false]);
  });
  test("uv --frozen and pipenv sync are rewritten to forms that fail on a stale lock", () => {
    put(repo, "uv.lock", "Pipfile.lock");
    expect(lockedInstall(repo, repo, "uv sync --frozen").cmd).toBe("uv sync --locked");
    expect(lockedInstall(repo, repo, "uv sync --locked")).toMatchObject({ cmd: "uv sync --locked", rewritten: false });
    expect(lockedInstall(repo, repo, "pipenv sync").cmd).toBe("pipenv install --deploy");
    expect(lockedInstall(repo, repo, "pipenv install --deploy")).toMatchObject({ cmd: "pipenv install --deploy", rewritten: false });
  });
  test("pnpm-workspace.yaml inline lists, unindented items and exclusions", () => {
    put(repo, "pnpm-lock.yaml");
    const ws = (y: string): void => writeFileSync(join(repo, "pnpm-workspace.yaml"), y);
    for (const y of ["packages: [\"apps/*\", 'libs/*', '!apps/skip']\n", "packages:\n- apps/*\n- libs/*\n- '!apps/skip'\n", "packages: # c\n  - apps/*\n  - libs/*\n  - '!apps/skip'\nother: 1\n"]) {
      ws(y);
      expect(lockedInstall(repo, sub("apps/a"), "pnpm install").cmd).toBe("pnpm install --frozen-lockfile");
      expect(lockedInstall(repo, sub("libs/b"), "pnpm install").cmd).toBe("pnpm install --frozen-lockfile");
      expect(lockedInstall(repo, sub("apps/skip"), "pnpm install")).toMatchObject({ locked: false });
    }
  });
  test("cd X moves the lookup to X; an unresolvable directory leaves the segment unlocked", () => {
    mkdirSync(join(repo, "web")); put(join(repo, "web"), "package-lock.json");
    expect(lockedInstall(repo, repo, "cd web && npm install").cmd).toBe("cd web && npm ci");
    const r = lockedInstall(repo, repo, "cd nowhere && npm install");
    expect([r.cmd, r.locked]).toEqual(["cd nowhere && npm install", false]);
    expect(r.note).toContain("cannot be resolved");
  });
  // An ancestor lockfile governs a package only when that ancestor declares a workspace containing it.
  const sub = (dir: string): string => { mkdirSync(join(repo, dir), { recursive: true }); return join(repo, dir); };
  test("non-member subpackage beside a root lockfile stays unlocked for npm, pnpm, cargo and uv", () => {
    const web = sub("web");
    put(repo, "package-lock.json", "pnpm-lock.yaml", "Cargo.lock", "uv.lock");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }));
    writeFileSync(join(repo, "Cargo.toml"), "[workspace]\nmembers = [\"crates/*\"]\n");
    writeFileSync(join(repo, "pyproject.toml"), "[tool.uv.workspace]\nmembers = [\"libs/*\"]\n");
    for (const cmd of ["npm install", "pnpm install", "cargo fetch", "uv sync"]) {
      const r = lockedInstall(repo, web, cmd);
      expect([r.cmd, r.locked, r.rewritten]).toEqual([cmd, false, false]);
      expect(r.note).toContain("governs");
    }
  });
  test("a real workspace member gets the locked form from the root lockfile", () => {
    put(repo, "package-lock.json", "pnpm-lock.yaml", "Cargo.lock", "uv.lock", "yarn.lock");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - '!packages/skip'\n");
    writeFileSync(join(repo, "Cargo.toml"), "[workspace]\nmembers = [\"crates/*\"]\n");
    writeFileSync(join(repo, "pyproject.toml"), "[tool.uv.workspace]\nmembers = [\"libs/*\"]\n");
    const pk = sub("packages/a"), cr = sub("crates/x"), lb = sub("libs/y"), skip = sub("packages/skip");
    expect(lockedInstall(repo, pk, "npm install").cmd).toBe("npm ci");
    expect(lockedInstall(repo, pk, "pnpm install").cmd).toBe("pnpm install --frozen-lockfile");
    expect(lockedInstall(repo, pk, "yarn install").cmd).toBe("yarn install --frozen-lockfile");
    expect(lockedInstall(repo, cr, "cargo fetch").cmd).toBe("cargo fetch --locked");
    expect(lockedInstall(repo, lb, "uv sync").cmd).toBe("uv sync --locked");
    expect(lockedInstall(repo, skip, "pnpm install")).toMatchObject({ locked: false });
  });

  // Fake package manager on PATH, no network: npm ci fails when the lockfile is out of sync, npm install would "fix" it.
  const fakeNpm = (body: string): string => {
    const bin = mkdtempSync(join(tmpdir(), "loki-fc22-bin-"));
    writeFileSync(join(bin, "npm"), `#!/bin/sh\n${body}`, { mode: 0o755 });
    return bin;
  };
  test("fail closed: an out-of-sync lockfile is NOT PROVEN with the real reason and never falls back to a mutating install", async () => {
    const bin = fakeNpm(`echo "$@" >> "$0.calls"\nif [ "$1" = ci ]; then echo "npm error package.json and package-lock.json are not in sync" >&2; exit 1; fi\n: > mutated\nexit 0\n`);
    try {
      const r = await prepareDeps({ ...base(), env: { PATH: `${bin}:${process.env["PATH"]}` }, model: model({ a: "npm install" }), failed: failed("a") });
      expect(r.checks).toHaveLength(1);
      expect(r.checks[0]).toMatchObject({ cmd: "npm ci", model_cmd: "npm install", locked: true, result: "not_run", owner: "harness" });
      expect(r.checks[0]!.reason).toContain("install exited 1: npm error package.json and package-lock.json are not in sync");
      expect(r.notProven.join("\n")).toContain("(install:a; harness-owned)");
      expect(readFileSync(join(bin, "npm.calls"), "utf8")).toBe("ci\n");
      expect(existsSync(join(repo, "a/mutated"))).toBe(false);
    } finally { rmSync(bin, { recursive: true, force: true }); }
  });
  test("a passing locked install records the command run and that it was locked", async () => {
    const bin = fakeNpm("mkdir -p node_modules\nexit 0\n");
    try {
      const r = await prepareDeps({ ...base(), env: { PATH: `${bin}:${process.env["PATH"]}` }, model: model({ a: "npm install" }), failed: failed("a") });
      expect(r.checks[0]).toMatchObject({ cmd: "npm ci", locked: true, result: "pass", lock_note: "install rewritten to its lockfile-frozen form" });
    } finally { rmSync(bin, { recursive: true, force: true }); }
  });
  test("an unlocked install (no rule) still runs and is recorded locked: false", async () => {
    const r = await prepareDeps({ ...base(), model: model({ a: `sh ${FIX}/ok.sh` }), failed: failed("a") });
    expect(r.checks[0]).toMatchObject({ result: "pass", locked: false });
    expect(r.checks[0]!.lock_note).toContain("not lockfile-locked");
  });
});
