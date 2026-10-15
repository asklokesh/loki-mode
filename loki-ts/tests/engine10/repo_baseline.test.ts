// REPOMEM: repo profile discovery, baseline, reuse, attribution (pre-existing vs introduced), brief and doctor --repo. Real git repos, real node test runs.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attribute, discoverCommands, ensureProfile, loadProfile, manifestHash, profileBrief, profilePath, renderProfile, type BaselineRunner } from "../../src/util/repo_baseline.ts";
import { runIntake } from "../../src/engine10/stages/intake.ts";
import { verifyStage } from "../../src/engine10/stages/verify.ts";
import type { RunContext, TestRef } from "../../src/engine10/types.ts";
import { briefContext } from "../../src/e10ext/context.ts";
import { runDoctor } from "../../src/commands/doctor.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (d: string, a: string[]): string => execFileSync("git", a, { cwd: d, encoding: "utf8" }).trim();
function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "e10-repomem-"));
  dirs.push(d);
  git(d, ["init", "-q"]); git(d, ["config", "user.email", "t@t.test"]); git(d, ["config", "user.name", "t"]);
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); }
  git(d, ["add", "-A"]); git(d, ["commit", "-q", "-m", "base"]);
  writeFileSync(join(d, ".git", "info", "exclude"), ".loki/\n"); // intake does this before the profile is written
  return d;
}
const T = "const t=require('node:test');const assert=require('node:assert');";
const GOOD = T + "t('good',()=>{assert.strictEqual(1,1);});\n";
const OLD_RED = T + "t('old bug',()=>{assert.strictEqual(1,2);});\n";
const NODE = { "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint .", typecheck: "tsc --noEmit", build: "echo build" } }), "good.test.js": GOOD, "old.test.js": OLD_RED };
const never: BaselineRunner = () => { throw new Error("baseline must not run"); };

describe("discoverCommands", () => {
  test("node: scripts become test/lint/typecheck/build, the npm placeholder test is ignored, lockfile picks the manager", () => {
    const d = repo({ ...NODE, "pnpm-lock.yaml": "" });
    expect(discoverCommands(d).map((c) => `${c.kind}=${c.cmd}`)).toEqual(["test=pnpm test", "lint=pnpm run lint", "typecheck=pnpm run typecheck", "build=pnpm run build"]);
    const e = repo({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    expect(discoverCommands(e)).toEqual([]);
  });
  test("python: pytest, ruff, mypy from pyproject; a venv python wins", () => {
    const d = repo({ "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n", ".venv/bin/python": "" });
    expect(discoverCommands(d).map((c) => `${c.kind}=${c.cmd}`)).toEqual([`test=${join(".venv", "bin", "python")} -m pytest -q`, "lint=ruff check .", "typecheck=mypy ."]);
  });
  test("make: targets named test, lint, build", () => {
    const d = repo({ Makefile: ".PHONY: test\ntest:\n\techo t\nlint:\n\techo l\nbuild: lint\n\techo b\nVAR := x\n" });
    expect(discoverCommands(d).map((c) => `${c.kind}=${c.cmd}`)).toEqual(["test=make test", "lint=make lint", "build=make build"]);
  });
  test("go and cargo manifests; CI fills only a kind no manifest named and skips shell-compound lines", () => {
    expect(discoverCommands(repo({ "go.mod": "module x\n" })).map((c) => c.cmd)).toEqual(["go test ./...", "go vet ./...", "go build ./..."]);
    expect(discoverCommands(repo({ "Cargo.toml": "[package]\n" })).map((c) => c.cmd)).toEqual(["cargo test", "cargo clippy", "cargo build"]);
    const d = repo({ ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - run: npm run lint\n      - run: npm test && curl x\n" });
    expect(discoverCommands(d).map((c) => `${c.kind}=${c.cmd}[${c.source}]`)).toEqual(["lint=npm run lint[.github/workflows/ci.yml]"]);
  });
});

describe("baseline and persistence", () => {
  test("a pre-existing failure is recorded with its id; the profile is persisted with revision and manifest hash; no litter in the tree", () => {
    const d = repo(NODE);
    const r = ensureProfile(d)!;
    expect(r.reused).toBe(false);
    const p = loadProfile(d)!;
    expect(p.revision).toBe(git(d, ["rev-parse", "HEAD"]));
    expect(p.manifest_hash).toBe(manifestHash(d));
    expect(p.baseline).toMatchObject({ ran: true, command: "npm test", attributable: true });
    expect(p.baseline.exit_code).not.toBe(0);
    expect(p.baseline.failing_ids).toContain("old bug");
    const t = p.commands.find((c) => c.kind === "test")!;
    expect(t).toMatchObject({ validated: true, failing_ids: p.baseline.failing_ids });
    expect(p.commands.filter((c) => c.kind !== "test").every((c) => c.validated === null)).toBe(true);
    expect(git(d, ["ls-files", "--others", "--exclude-standard"])).toBe("");
  }, 60_000);
  test("a green baseline records exit 0 and no failing ids", () => {
    const d = repo({ "package.json": NODE["package.json"], "good.test.js": GOOD });
    const p = ensureProfile(d)!.profile;
    expect(p.baseline).toMatchObject({ exit_code: 0, failing_ids: [], attributable: true });
  }, 60_000);
  test("reuse while the manifest hash and HEAD match; new HEAD re-runs only the baseline; a manifest edit rediscovers", () => {
    const d = repo(NODE);
    let runs = 0;
    const run: BaselineRunner = () => { runs++; return { code: 0, timedOut: false, out: "" }; };
    expect(ensureProfile(d, { run })!.reused).toBe(false); expect(runs).toBe(1);
    expect(ensureProfile(d, { run: never })!.reused).toBe(true);
    writeFileSync(join(d, "README.md"), "x"); git(d, ["add", "README.md"]); git(d, ["commit", "-q", "-m", "docs"]);
    const moved = ensureProfile(d, { run })!;
    expect(moved.reused).toBe(false); expect(runs).toBe(2);
    expect(moved.profile.commands.map((c) => c.cmd)).toEqual(["npm test", "npm run lint", "npm run typecheck", "npm run build"]);
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "bun test" } })); git(d, ["commit", "-q", "-am", "scripts"]);
    expect(ensureProfile(d, { run })!.profile.commands.map((c) => c.cmd)).toEqual(["npm test"]);
    expect(runs).toBe(3);
  });
  test("a timed-out or unparseable baseline is not attributable and says why; a repo with no test command records no baseline", () => {
    const d = repo(NODE);
    const to = ensureProfile(d, { run: () => ({ code: null, timedOut: true, out: "" }), timeoutS: 1 })!.profile;
    expect(to.baseline).toMatchObject({ timed_out: true, attributable: false, reason: "timed out" });
    expect(to.commands[0]).toMatchObject({ validated: false });
    const e = repo({ "README.md": "x" });
    expect(ensureProfile(e)!.profile.baseline).toMatchObject({ ran: false, reason: "no test command discovered" });
    expect(renderProfile(ensureProfile(e)!.profile)).toContain("not run (no test command discovered)");
  });
});

describe("attribution", () => {
  const prof = (d: string, ids: string[], attributable = true): string => {
    const base = git(d, ["rev-parse", "HEAD"]);
    mkdirSync(join(d, ".loki", "state"), { recursive: true });
    writeFileSync(profilePath(d), JSON.stringify({ version: 1, revision: base, manifest_hash: "h", created_at: "t", commands: [], baseline: { ran: true, command: "npm test", exit_code: 1, duration_s: 1, timed_out: false, failing_ids: ids, attributable } }));
    return base;
  };
  test("only a check whose every id is in the baseline is pre-existing; one new id makes it introduced; unknown ids never excuse", () => {
    const d = repo(NODE), base = prof(d, ["a", "b"]);
    const a = attribute(d, base, [{ name: "n:1", ids: ["a"], eligible: true }, { name: "n:2", ids: ["a", "new"], eligible: true }, { name: "n:3", eligible: true }, { name: "n:4", ids: ["b"], eligible: false }]);
    expect(a.preExistingChecks).toEqual(["n:1"]);
    expect(a.introducedChecks).toEqual(["n:2", "n:3", "n:4"]);
    expect(a.line).toBe("baseline: 1 pre-existing failing check(s) (not blocking), 3 introduced (blocking)");
  });
  test("stale revision, unattributable or empty baseline: everything is introduced", () => {
    const d = repo(NODE), base = prof(d, ["a"]);
    expect(attribute(d, "0".repeat(40), [{ name: "n", ids: ["a"], eligible: true }]).preExistingChecks).toEqual([]);
    prof(d, ["a"], false);
    expect(attribute(d, base, [{ name: "n", ids: ["a"], eligible: true }]).preExistingChecks).toEqual([]);
    prof(d, []);
    expect(attribute(d, base, [{ name: "n", ids: ["a"], eligible: true }]).line).toBeNull();
  });
});

describe("verify and brief wiring", () => {
  function ctxFor(d: string, base: string, impacted: TestRef[]): RunContext {
    return { repoDir: d, runDir: join(d, ".loki"), baseSha: base, emit: () => {}, tests: { detect: async () => ({ runners: [], tests: impacted }), impacted: (_m: unknown, f: string[]) => (f.length ? impacted : []) },
      outputs: () => ({ intake: { task: "", tree: undefined }, wall: { files: [] } }) } as unknown as RunContext;
  }
  const node = (path: string): TestRef => ({ runner: "node", path }) as TestRef;
  test("a baseline-red test the agent did not touch never blocks; a test the agent broke always blocks; the line says so", async () => {
    const d = repo({ ...NODE, "feat.js": "exports.v=1;\n", "feat.test.js": T + "const {v}=require('./feat.js');t('feat',()=>{assert.strictEqual(v,1);});\n" });
    ensureProfile(d);
    const base = git(d, ["rev-parse", "HEAD"]);
    writeFileSync(join(d, "feat.js"), "exports.v=2;\n");
    const out = (await verifyStage.run(ctxFor(d, base, [node("old.test.js"), node("feat.test.js")]), new AbortController().signal)).data as Record<string, unknown>;
    expect(out["pre_red_checks"]).toEqual(["node:old.test.js"]);
    expect(out["introduced_checks"]).toEqual(["node:feat.test.js"]);
    expect(out["baseline_line"]).toBe("baseline: 1 pre-existing failing check(s) (not blocking), 1 introduced (blocking)");
    expect((out["failures_grouped"] as unknown[]).length).toBe(1);
  }, 120_000);
  test("without a profile verify behaves as before: no baseline fields, every failure stays", async () => {
    const d = repo({ "old.test.js": OLD_RED, "x.js": "1\n" });
    const base = git(d, ["rev-parse", "HEAD"]);
    writeFileSync(join(d, "x.js"), "2\n");
    const out = (await verifyStage.run(ctxFor(d, base, [node("old.test.js")]), new AbortController().signal)).data as Record<string, unknown>;
    expect(out["baseline_line"]).toBeUndefined();
    expect(out["pre_red_checks"]).toEqual([]);
    expect((out["failures_grouped"] as unknown[]).length).toBe(1);
  }, 120_000);
  test("the implementer brief carries the validated commands and the known-red ids, byte-stable across calls", () => {
    const d = repo(NODE);
    ensureProfile(d);
    const brief = profileBrief(d);
    expect(brief).toContain("test: npm test (validated on the untouched tree)");
    expect(brief).toContain("lint: npm run lint");
    expect(brief).toContain("old bug");
    expect(profileBrief(d)).toBe(brief);
    const ctx = ctxFor(d, git(d, ["rev-parse", "HEAD"]), []);
    expect(briefContext(ctx, { select: () => [], cmd: () => ["x", [], undefined, "."] })).toContain(brief);
    expect(profileBrief(repo({ "README.md": "x" }))).toBe("");
  }, 60_000);
  test("loki doctor --repo prints the profile read-only, --json prints it raw; an absent profile is stated", async () => {
    const d = repo(NODE), cwd = process.cwd(), chunks: string[] = [], w = process.stdout.write.bind(process.stdout);
    const cap = async (a: string[]): Promise<string> => { chunks.length = 0; process.stdout.write = ((s: string) => (chunks.push(String(s)), true)) as typeof process.stdout.write; try { await runDoctor(a); } finally { process.stdout.write = w; } return chunks.join(""); };
    try {
      process.chdir(d);
      expect(await cap(["--repo"])).toContain("none yet");
      ensureProfile(d);
      const before = readFileSync(profilePath(d), "utf8");
      const text = await cap(["--repo"]);
      expect(text).toContain("npm test");
      expect(text).toContain("baseline:");
      expect(JSON.parse(await cap(["--repo", "--json"])).baseline.command).toBe("npm test");
      expect(readFileSync(profilePath(d), "utf8")).toBe(before);
    } finally { process.chdir(cwd); }
  }, 60_000);
});

describe("intake wiring", () => {
  const ictx = (d: string): RunContext => ({ runId: "e10-t", repoDir: d, runDir: join(d, ".loki", "runs", "e10-t"), baseSha: "", branch: "loki/e10-t", provider: "claude", model: "m", deep: false, capS: 900, emit: () => {},
    sessions: { run() { throw new Error("no session"); } }, tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] }, cost: {}, clock: { now: () => Date.now() }, outputs: () => ({}) }) as unknown as RunContext;
  test("intake writes the profile on the untouched tree and a second intake reuses it; LOKI_REPO_BASELINE=0 skips it", async () => {
    const d = repo(NODE);
    expect((await runIntake(ictx(d), new AbortController().signal, { taskText: "t" })).status).toBe("completed");
    const p = loadProfile(d)!;
    expect(p.baseline.failing_ids).toContain("old bug");
    expect(git(d, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
    const before = readFileSync(profilePath(d), "utf8");
    await runIntake(ictx(d), new AbortController().signal, { taskText: "t" });
    expect(readFileSync(profilePath(d), "utf8")).toBe(before);
    const e = repo(NODE);
    process.env.LOKI_REPO_BASELINE = "0";
    try { await runIntake(ictx(e), new AbortController().signal, { taskText: "t" }); } finally { delete process.env.LOKI_REPO_BASELINE; }
    expect(loadProfile(e)).toBeNull();
  }, 60_000);
});
