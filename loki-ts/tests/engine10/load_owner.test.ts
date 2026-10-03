// FC-02 B2/R1 (HIGH review): a base load error counts as harness-owned only when it is head's own error; the base run is bounded.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFilesNamed, harnessLoadReason, loadErrorIsHarnessOwned, runOnBase } from "../../src/runner/load_owner.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const G = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null"];
/** A repo whose HEAD tree has src/main.js edited (the agent's change) over a committed base. */
function repo(): { dir: string; sha: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "e10-lo-test-"))); roots.push(dir);
  const git = (a: string[]) => execFileSync("git", [...G, ...a], { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]); mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/main.js"), "BASE\n"); writeFileSync(join(dir, "src/config.js"), "x\n");
  git(["add", "src"]); git(["commit", "-qm", "base"]);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  writeFileSync(join(dir, "src/main.js"), "NEW\n");
  return { dir, sha };
}
const HEAD_MISSING_LOCAL = "FAIL src/config.test.js\n  Test suite failed to run\n\n    Cannot find module './formatter' from 'src/config.js'\n";
const run = (dir: string, sha: string, headOut: string, baseOut: string) => {
  // prints baseOut on the base checkout (src/main.js says BASE), the head output otherwise
  const script = `if grep -q BASE src/main.js; then printf '%s\\n' "$BASE_OUT"; else printf '%s\\n' "$HEAD_OUT"; fi; exit 1`;
  return loadErrorIsHarnessOwned({ repoDir: dir, baseSha: sha, out: headOut, cmd: "bash", args: ["-c", script], signal: new AbortController().signal, env: { BASE_OUT: baseOut, HEAD_OUT: headOut } });
};

describe("B2: base load error must match head's", () => {
  test("agent-introduced missing local module vs base missing dependency is agent-owned", async () => {
    const { dir, sha } = repo();
    expect(await run(dir, sha, HEAD_MISSING_LOCAL, "FAIL src/fmt.test.js\n  Test suite failed to run\n\n    Cannot find module 'dep' from 'src/fmt.js'\n")).toBe(false);
  });
  test("base 'jest: command not found' is non-reproduction for a head missing module", async () => {
    const { dir, sha } = repo();
    expect(await run(dir, sha, HEAD_MISSING_LOCAL, "sh: jest: command not found")).toBe(false);
  });
  test("positive control: head and base miss the same dependency, harness-owned", async () => {
    const { dir, sha } = repo();
    const o = "FAIL a.test.js\n  Test suite failed to run\n\n    Cannot find module 'dep' from 'src/fmt.js'\n";
    expect(await run(dir, sha, o, o)).toBe(true);
  });
  test("positive control: same signature without a name, paths normalized across checkouts", async () => {
    const { dir, sha } = repo();
    const o = `ImportError while importing test module '${dir}/tests/test_a.py'.\n`;
    // the script emits the head text on both sides only when base path normalization works: base prints with its own root
    const script = `if grep -q BASE src/main.js; then printf "ImportError while importing test module '$PWD/tests/test_a.py'.\\n"; else printf '%s\\n' "$HEAD_OUT"; fi; exit 1`;
    expect(await loadErrorIsHarnessOwned({ repoDir: dir, baseSha: sha, out: o, cmd: "bash", args: ["-c", script], signal: new AbortController().signal, env: { HEAD_OUT: o } })).toBe(true);
  });
  test("harnessLoadReason (the package_suite path) gives undefined for the mismatch", async () => {
    const { dir, sha } = repo();
    const script = `if grep -q BASE src/main.js; then echo "sh: jest: command not found"; else echo "$HEAD_OUT"; fi; exit 1`;
    expect(await harnessLoadReason({ repoDir: dir, baseSha: sha, out: HEAD_MISSING_LOCAL, cmd: "bash", args: ["-c", script], signal: new AbortController().signal, env: { HEAD_OUT: HEAD_MISSING_LOCAL } })).toBeUndefined();
  });
});

describe("B2: changedFilesNamed widening", () => {
  test("package-relative path", () => {
    expect(changedFilesNamed("Error at src/index.ts:4", "/r", ["packages/a/src/index.ts"])).toEqual(["packages/a/src/index.ts"]);
    expect(changedFilesNamed("Error at xsrc/index.ts:4", "/r", ["packages/a/src/index.ts"])).toEqual([]);
  });
  test("go import path names the changed directory", () => {
    expect(changedFilesNamed('cannot find package "example.com/fx/calc"', "/r", ["calc/add.go"])).toEqual(["calc/add.go"]);
    expect(changedFilesNamed('cannot find package "example.com/fx/other"', "/r", ["calc/add.go"])).toEqual([]);
  });
});

describe("R1: runOnBase is bounded by the timeout, not pipe EOF", () => {
  test("an orphaned grandchild holding the pipes returns in about the timeout", async () => {
    const t = Date.now();
    const r = await runOnBase({ repoDir: "/nonexistent-r1", baseSha: "x", out: "", cmd: "bash", args: ["-c", "(sleep 12 &); sleep 30; exit 1"], signal: new AbortController().signal, cwd: tmpdir(), timeoutMs: 2000 }, "/nonexistent-r1-dir");
    expect(r).toBeNull();
    expect(Date.now() - t).toBeLessThan(4000);
  }, 10_000);
  test("abort returns promptly", async () => {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 500);
    const t = Date.now();
    await runOnBase({ repoDir: "/nonexistent-r1", baseSha: "x", out: "", cmd: "bash", args: ["-c", "sleep 30"], signal: ac.signal, cwd: tmpdir() }, "/nonexistent-r1-dir");
    expect(Date.now() - t).toBeLessThan(3000);
  }, 10_000);
});
