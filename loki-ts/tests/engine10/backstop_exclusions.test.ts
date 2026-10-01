// D50-F4: the supervisor backstop commit must honor the commit stage's exclusions (pre-existing
// dirt, Wall files, stray lockfiles). Otherwise a FAILED run publishes the user's setup dirt as a PR.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisor, type PrStep } from "../../src/engine10/supervisor.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) execFileSync("rm", ["-rf", r]); });
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

const ghStub = mkdtempSync(join(tmpdir(), "e10-bx-gh-"));
roots.push(ghStub);
writeFileSync(join(ghStub, "gh"), '#!/bin/sh\ncase "$1" in\n  --version) echo "gh stub 0.0.0" ;;\n  auth) exit 0 ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
const ENV: NodeJS.ProcessEnv = { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true", PATH: `${ghStub}:${process.env.PATH ?? ""}` };

/** Repo whose tracked package-lock.json was dirtied by a setup step before intake. */
function fixture(): { dir: string; base: string; blob: string } {
  const dir = mkdtempSync(join(tmpdir(), "e10-bx-"));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@example.com");
  writeFileSync(join(dir, "a.txt"), "base\n");
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  git(dir, "add", "a.txt", "package-lock.json");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "remote", "add", "origin", "https://github.com/acme/widget.git");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "package-lock.json"), '{"setup":"npm install output"}\n');
  return { dir, base, blob: git(dir, "hash-object", "-w", "package-lock.json") };
}
// intake records the dirt; the worker then makes `edit` (JS source) and exits 1 (FAILED).
const workerFor = (base: string, blob: string, edit: string): string[] => [process.execPath, "-e", `
  console.log(JSON.stringify({ type: "stage.completed", stage: "intake", data: { base_sha: ${JSON.stringify(base)}, preexisting_dirty: { "package-lock.json": ${JSON.stringify(blob)} } } }));
  ${edit}
  process.exit(1);`];
const run = async (f: ReturnType<typeof fixture>, edit: string, env: NodeJS.ProcessEnv = ENV): Promise<string[]> => {
  const calls: string[] = [];
  const pr: PrStep = async ({ verdict }) => { calls.push(verdict); return { url: "https://github.com/acme/widget/pull/1", draft: true, existing: null }; };
  await runSupervisor({ runId: "e10-bx", repoDir: f.dir, env, workerArgv: workerFor(f.base, f.blob, edit), capS: 20, graceS: 5, pr });
  return calls;
};
const filesIn = (f: ReturnType<typeof fixture>): string[] => git(f.dir, "diff-tree", "-r", "--no-commit-id", "--name-only", f.base, "HEAD").split("\n").filter(Boolean);

describe("D50-F4: backstop commit exclusions", () => {
  test("only pre-existing dirt, FAILED: no commit, HEAD stays at base, no PR", async () => {
    const f = fixture();
    const calls = await run(f, "");
    expect(git(f.dir, "rev-parse", "HEAD")).toBe(f.base);
    expect(calls.length).toBe(0);
  }, 20_000);

  test("pre-existing dirt plus a run edit: the backstop commit holds only the run edit", async () => {
    const f = fixture();
    const calls = await run(f, `require("node:fs").writeFileSync("a.txt", "run edit\\n");`);
    expect(filesIn(f)).toEqual(["a.txt"]);
    expect(calls.length).toBe(1);
  }, 20_000);

  test("Wall files and a stray lockfile never enter the backstop commit", async () => {
    const f = fixture();
    mkdirSync(join(f.dir, "sub"));
    await run(f, `const fs = require("node:fs");
      fs.writeFileSync("a.txt", "run edit\\n"); fs.writeFileSync("loki_wall_x.test.ts", "w\\n");
      fs.writeFileSync("sub/loki_wall_y.sh", "w\\n"); fs.writeFileSync("sub/yarn.lock", "l\\n"); fs.writeFileSync("bun.lock", "l\\n");`);
    expect(filesIn(f)).toEqual(["a.txt"]);
  }, 20_000);

  test("implement already committed the pre-existing dirt: the backstop revert leaves no net diff, so no PR", async () => {
    const f = fixture();
    const calls = await run(f, `const cp = require("node:child_process"); cp.execFileSync("git", ["add", "package-lock.json"]); cp.execFileSync("git", ["commit", "-q", "-m", "wip"]);`);
    expect(git(f.dir, "diff", "--name-only", f.base, "HEAD")).toBe("");
    expect(calls.length).toBe(0);
  }, 20_000);

  test("a clean filter in the agent-writable .git/config never sees the supervisor's token", async () => {
    const f = fixture();
    const leak = join(f.dir, "..", `${f.dir.split("/").pop()}-leak`);
    git(f.dir, "config", "filter.x.clean", `sh -c 'echo GH_TOKEN=$GH_TOKEN >> ${leak}; cat'`);
    appendFileSync(join(f.dir, ".git", "info", "attributes"), "package-lock.json filter=x\n");
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "SUPERVISOR_SECRET";
    try { await run(f, `require("node:fs").writeFileSync("a.txt", "run edit\\n");`, { ...ENV, GH_TOKEN: "SUPERVISOR_SECRET" }); }
    finally { if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved; }
    roots.push(leak);
    expect(existsSync(leak) ? readFileSync(leak, "utf8") : "").not.toContain("SUPERVISOR_SECRET");
  }, 20_000);
});
