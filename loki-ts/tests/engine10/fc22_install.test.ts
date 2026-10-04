// FC-22 S3: the install pre-step library. Fake installers are tiny shell scripts (tests/fixtures/install-fc22); no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectApi } from "../../src/project_model/api.ts";
import { prepareDeps, resetInstallMemo } from "../../src/project_model/install.ts";
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
    expect(r.checks[0]).toMatchObject({ name: "install:a", result: "not_run", owner: "harness", reason: "install exited 3" });
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
});
