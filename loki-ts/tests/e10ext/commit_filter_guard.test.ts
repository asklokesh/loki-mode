import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backstopCommit, dropSet, guardedBackstop, validBase } from "../../src/e10ext/commit_filter.ts";

let dir = "";
let env: NodeJS.ProcessEnv = {};
const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "d50f4b-"));
  writeFileSync(join(dir, "git"), `#!/bin/sh\necho "$@" >> "${dir}/calls.log"\nexit 0\n`);
  chmodSync(join(dir, "git"), 0o755);
  env = { PATH: `${dir}:/usr/bin:/bin` };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("validBase accepts only 40-64 lowercase hex", () => {
  expect(validBase("a".repeat(40))).toBe("a".repeat(40));
  expect(validBase("b".repeat(64))).toBe("b".repeat(64));
  for (const bad of ["--output=x", "HEAD", "a".repeat(39), "a".repeat(65), "A".repeat(40), null, 7]) expect(validBase(bad)).toBeNull();
});

test("a base of --output=x is refused with zero git spawns", () => {
  const why = guardedBackstop(true, dir, env, "run1", "--output=x", undefined);
  expect(why).toContain("not a full object id");
  expect(calls()).toBe("");
});

test("a tampered log runs no backstop (zero git spawns)", () => {
  const why = guardedBackstop(false, dir, env, "run1", "a".repeat(40), undefined);
  expect(why).toContain("failed verification");
  expect(calls()).toBe("");
});

test("an intact log with a valid base still runs the backstop", () => {
  expect(guardedBackstop(true, dir, env, "run1", "a".repeat(40), undefined)).toBeNull();
  expect(calls()).toContain("add -A");
});

// TEN-QUALITY-16: the commit stage formats only the run's own kept files with a formatter the repo already configures.
import { mkdirSync } from "node:fs";
import { toolchainDropNotes } from "../../src/util/lock_ecosystems.ts";
import { commitStage } from "../../src/engine10/stages/seal.ts";
import type { RunContext } from "../../src/engine10/types.ts";

function sh(argv: string[], cwd: string): string {
  const p = Bun.spawnSync({ cmd: argv, cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} -> ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
let n = 0;
/** Repo with `base` files committed, a fake `ruff` first on PATH (rewrites each file arg to "FORMATTED"), then `edit` applied and commitStage run. */
async function commitRun(base: Record<string, string>, edit: Record<string, string>, seed: Record<string, string> = {}, preEdit: Record<string, string> = {}): Promise<{ repo: string; show: (f: string) => string; files: string[] }> {
  const repo = join(dir, `r${n++}`), bin = join(dir, `bin${n}`);
  mkdirSync(repo, { recursive: true }); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ruff"), `#!/bin/sh\necho "$@" >> "${repo}/../ruff.calls"\nshift\nfor f in "$@"; do echo FORMATTED > "$f"; done\n`); chmodSync(join(bin, "ruff"), 0o755);
  sh(["git", "init", "-q", "-b", "main"], repo); sh(["git", "config", "user.name", "t"], repo); sh(["git", "config", "user.email", "t@test.invalid"], repo);
  for (const [f, c] of Object.entries(base)) writeFileSync(join(repo, f), c);
  sh(["git", "add", "-A"], repo); sh(["git", "commit", "-q", "-m", "base"], repo);
  const baseSha = sh(["git", "rev-parse", "HEAD"], repo).trim();
  const blobs: Record<string, string> = {};
  for (const [f, c] of Object.entries(seed)) {
    writeFileSync(join(repo, f), c);
    blobs[f] = `${sh(["git", "hash-object", f], repo).trim()} ${(statSync(join(repo, f)).mode & 0o777).toString(8)}`;
  }
  for (const [f, c] of Object.entries(preEdit)) writeFileSync(join(repo, f), c);
  for (const [f, c] of Object.entries(edit)) { if (c === "DELETE") { rmSync(join(repo, f)); continue; } mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), c); }
  mkdirSync(join(repo, ".loki/runs/r1"), { recursive: true });
  const outputs = { intake: { title: "t", preexisting_untracked: Object.keys(seed), preexisting_untracked_blobs: blobs } };
  const ctx = { runId: "r1", repoDir: repo, runDir: join(repo, ".loki/runs/r1"), baseSha, branch: "loki/r1", provider: "claude", model: "m", deep: false, capS: 900, emit: () => {}, sessions: { run: async () => { throw new Error("none"); } }, tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] }, cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) }, clock: { now: () => 0 }, outputs: () => outputs } as unknown as RunContext;
  const pre = process.env["PATH"];
  process.env["PATH"] = `${bin}:${pre}`;
  try { expect((await commitStage.run(ctx, new AbortController().signal)).status).toBe("completed"); } finally { process.env["PATH"] = pre; }
  return { repo, show: (f) => { try { return sh(["git", "show", `HEAD:${f}`], repo); } catch { return ""; } }, files: sh(["git", "show", "--name-only", "--format=", "HEAD"], repo).split("\n").filter(Boolean) };
}
const RUFF_CFG = "[tool.ruff]\nline-length = 88\n";

test("T16 configured ruff: the run's unformatted py file is committed formatted", async () => {
  const r = await commitRun({ "pyproject.toml": RUFF_CFG }, { "a.py": "x=1\n" });
  expect(r.show("a.py")).toBe("FORMATTED\n");
  expect(r.files).toEqual(["a.py"]);
});

test("T16 unchanged files are untouched, and a non-owned extension is not handed to the formatter", async () => {
  const r = await commitRun({ "pyproject.toml": RUFF_CFG, "old.py": "y=2\n" }, { "a.py": "x=1\n", "notes.txt": "hi\n" });
  expect(readFileSync(join(r.repo, "old.py"), "utf8")).toBe("y=2\n");
  expect(r.show("notes.txt")).toBe("hi\n");
  expect(readFileSync(join(r.repo, "..", "ruff.calls"), "utf8")).not.toContain("old.py");
  expect(r.files.sort()).toEqual(["a.py", "notes.txt"]);
});

test("T16 no formatter config means no spawn and the file commits as written", async () => {
  const r = await commitRun({ "README.md": "r\n" }, { "a.py": "x=1\n" });
  expect(r.show("a.py")).toBe("x=1\n");
  expect(existsSync(join(r.repo, "..", "ruff.calls"))).toBe(false);
});

test("T16 a deleted file and a .loki file are never formatted", async () => {
  const r = await commitRun({ "pyproject.toml": RUFF_CFG, "gone.py": "z=3\n" }, { "a.py": "x=1\n", "gone.py": "DELETE", ".loki/state/s.py": "q=1\n" });
  const calls = readFileSync(join(r.repo, "..", "ruff.calls"), "utf8");
  expect(calls).toContain("a.py");
  expect(calls).not.toContain(".loki");
  expect(calls).not.toContain("gone.py");
});

test("T16 real gofmt via go.mod formats the run's go file", async () => {
  if (!Bun.which("gofmt")) return; // no Go toolchain (macOS runners): spawnSync throws ENOENT there rather than returning no exit code
  const r = await commitRun({ "go.mod": "module x\n" }, { "m.go": "package main\nfunc  main( ){\n}\n" });
  expect(r.show("m.go")).toBe("package main\n\nfunc main() {\n}\n");
});

// FC-COMMIT-STAGES-USER-UNTRACKED: a pre-run untracked file the run did not touch is never committed.
test("FC-COMMIT-STAGES-USER-UNTRACKED an untouched pre-run untracked file is left out of the commit", async () => {
  const r = await commitRun({ "README.md": "r\n" }, { "a.txt": "x\n" }, { "user-notes.txt": "mine\n" });
  expect(r.files).toEqual(["a.txt"]);
  expect(readFileSync(join(r.repo, "user-notes.txt"), "utf8")).toBe("mine\n");
});

test("FC-COMMIT-STAGES-USER-UNTRACKED a pre-run untracked file the run edited is the run's change and is committed", async () => {
  const r = await commitRun({ "README.md": "r\n" }, { "a.txt": "x\n" }, { "user-notes.txt": "mine\n" }, { "user-notes.txt": "mine plus run\n" });
  expect(r.files.sort()).toEqual(["a.txt", "user-notes.txt"]);
});

test("FC-COMMIT-STAGES-USER-UNTRACKED a file not in the intake snapshot (crash-written) is still committed", async () => {
  const r = await commitRun({ "README.md": "r\n" }, { "a.txt": "x\n", "crash.txt": "c\n" }, { "user-notes.txt": "mine\n" });
  expect(r.files.sort()).toEqual(["a.txt", "crash.txt"]);
});

test("FC-COMMIT-STAGES-USER-UNTRACKED the supervisor backstop also leaves an untouched pre-run untracked file out", () => {
  const repo = join(dir, "bs");
  mkdirSync(repo, { recursive: true });
  sh(["git", "init", "-q", "-b", "main"], repo); sh(["git", "config", "user.name", "t"], repo); sh(["git", "config", "user.email", "t@test.invalid"], repo);
  writeFileSync(join(repo, "README.md"), "r\n"); sh(["git", "add", "-A"], repo); sh(["git", "commit", "-q", "-m", "base"], repo);
  const base = sh(["git", "rev-parse", "HEAD"], repo).trim();
  writeFileSync(join(repo, "user-notes.txt"), "mine\n");
  const blobs = { "user-notes.txt": `${sh(["git", "hash-object", "user-notes.txt"], repo).trim()} ${(statSync(join(repo, "user-notes.txt")).mode & 0o777).toString(8)}` };
  writeFileSync(join(repo, "a.txt"), "x\n");
  backstopCommit(repo, { ...process.env }, "r1", base, undefined, undefined, blobs);
  expect(sh(["git", "show", "--name-only", "--format=", "HEAD"], repo).split("\n").filter(Boolean)).toEqual(["a.txt"]);
});

const gitIn = (...a: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe", env: process.env }).toString().trim();
const baseRepo = (): string => { gitIn("init", "-q"); writeFileSync(join(dir, "README.md"), "r\n"); gitIn("add", "README.md"); gitIn("commit", "-qm", "base"); return gitIn("rev-parse", "HEAD"); };

test("build output a rust, gradle, node or python run created is dropped from the commit set; tracked files and a bare target/ are kept", () => {
  const base = baseRepo(); mkdirSync(join(dir, "target"), { recursive: true }); writeFileSync(join(dir, "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
  const a = (f: string) => ({ st: "A", f });
  const staged = [a("src/lib.rs"), a("target/CACHEDIR.TAG"), a("target/debug/app"), a("target/release/.fingerprint/x"), a("pkg/__pycache__/m.cpython-312.pyc"), a("node_modules/x/index.js"), a("web/target/keep.txt"), { st: "M", f: "target/tracked.txt" }];
  const dropped = dropSet(dir, staged, undefined, env, undefined, undefined, base).map(({ f }) => f).sort();
  expect(dropped).toEqual(["node_modules/x/index.js", "pkg/__pycache__/m.cpython-312.pyc", "target/CACHEDIR.TAG", "target/debug/app", "target/release/.fingerprint/x"]);
});

test("an output dir that already holds a file tracked at the base is the user's: nothing in it is dropped", () => {
  const g = gitIn;
  g("init", "-q"); mkdirSync(join(dir, "target"), { recursive: true }); writeFileSync(join(dir, "target", "keep.txt"), "mine\n");
  g("add", "target/keep.txt"); g("commit", "-qm", "base"); const base = g("rev-parse", "HEAD");
  writeFileSync(join(dir, "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
  const staged = [{ st: "A", f: "target/CACHEDIR.TAG" }, { st: "A", f: "target/debug/app" }];
  expect(dropSet(dir, staged, undefined, process.env, undefined, undefined, base).map(({ f }) => f)).toEqual([]);
});

test("a file the run itself committed into target/ after the base does not make the dir the user's", () => {
  const base = baseRepo(); mkdirSync(join(dir, "target"), { recursive: true }); writeFileSync(join(dir, "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
  writeFileSync(join(dir, "target", "early.o"), "o\n"); gitIn("add", "-f", "target/early.o"); gitIn("commit", "-qm", "implement");
  expect(dropSet(dir, [{ st: "A", f: "target/CACHEDIR.TAG" }, { st: "A", f: "target/debug/app" }], undefined, process.env, undefined, undefined, base).map(({ f }) => f).sort()).toEqual(["target/CACHEDIR.TAG", "target/debug/app"]);
});

test("when the base cannot be read (not a git dir, or no base), nothing is dropped", () => {
  mkdirSync(join(dir, "node_modules", "p"), { recursive: true });
  const staged = [{ st: "A", f: "node_modules/p/i.js" }];
  expect(dropSet(dir, staged, undefined, process.env, undefined, undefined, "0".repeat(40))).toEqual([]);
  expect(dropSet(dir, staged, undefined, process.env)).toEqual([]);
});

test("each dropped toolchain output dir is disclosed as one note with its file count", () => {
  mkdirSync(join(dir, "target"), { recursive: true }); writeFileSync(join(dir, "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
  expect(toolchainDropNotes(dir, ["target/CACHEDIR.TAG", "target/debug/app", "node_modules/x/i.js", "src/a.rs"], baseRepo())).toEqual([
    "toolchain build output left out of the commit: target/ (2 files)", "toolchain build output left out of the commit: node_modules/ (1 file)",
  ]);
});
