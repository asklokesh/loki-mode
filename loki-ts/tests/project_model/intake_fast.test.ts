// FC-55 (INTAKE-FAST): a no-UI answer validates, a single-directory repo spends no model session, and a
// hung discovery session becomes a recorded fallback. The model call is always a stub.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectApi } from "../../src/project_model/api.ts";
import { discoverProjectModel, intakeProjectModel, signalsResolve } from "../../src/project_model/discover.ts";
import { loadProjectApi } from "../../src/project_model/resolve.ts";
import { unknownModel, validateAnswer } from "../../src/project_model/schema.ts";
import { runIntake } from "../../src/engine10/stages/intake.ts";
import { buildTestMap } from "../../src/engine10/testmap.ts";
import { commandFor } from "../../src/engine10/stages/verify.ts";
import type { RunContext, SessionResult, SessionRunOptions } from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "project-model", "firelater-17");
const RECORDED = JSON.parse(readFileSync(join(FIX, "response.json"), "utf8")) as Record<string, any>;
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); }, 120_000); // fixture B leaves 20,050 files to remove; the hook has its own 5s default
const git = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: "pipe", env: process.env }); };
function multiRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "pm-fast-"));
  dirs.push(d);
  cpSync(FIX, d, { recursive: true });
  rmSync(join(d, "response.json"));
  git(d, "init", "-q");
  git(d, "add", "-A", "-f");
  return d;
}
function pyRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "pm-fast-py-"));
  dirs.push(d);
  writeFileSync(join(d, "pyproject.toml"), '[project]\nname = "sumlib"\n[tool.pytest.ini_options]\naddopts = "-q"\n');
  writeFileSync(join(d, "sumlib.py"), "def add(a, b):\n    return a + b\n");
  writeFileSync(join(d, "test_sumlib.py"), "from sumlib import add\n\ndef test_add():\n    assert add(1, 2) == 3\n");
  git(d, "init", "-q");
  git(d, "add", "-A", "-f");
  return d;
}
const ok: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };
function ctxFor(repoDir: string, run: (o: SessionRunOptions) => Promise<SessionResult>, events: Array<[string, Record<string, unknown>]> = []): RunContext {
  return { runId: "r1", repoDir, runDir: join(repoDir, ".loki", "runs", "r1"), sessions: { run }, emit: (t: string, _s: unknown, data: Record<string, unknown>) => { events.push([t, data]); } } as unknown as RunContext;
}
const sig = new AbortController().signal;

describe("FC-55 ui.cite is required only when the package has a UI", () => {
  const withUi = (ui: unknown): Record<string, any> => { const a = JSON.parse(JSON.stringify(RECORDED)); a.packages[0].ui = ui; return a; };
  test("present:false with an empty or absent cite validates", () => {
    const d = multiRepo();
    expect(validateAnswer(d, withUi({ present: false, boot: null, cite: [] })).ok).toBe(true);
    expect(validateAnswer(d, withUi({ present: false, boot: null })).ok).toBe(true);
  });
  test("present:true with an empty cite still fails", () => {
    const d = multiRepo();
    const r = validateAnswer(d, withUi({ present: true, boot: null, cite: [] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join("\n")).toContain("packages[0].ui.cite: needs at least one citation");
  });
  test("present:false with a bad citation is still rejected", () => {
    const d = multiRepo();
    expect(validateAnswer(d, withUi({ present: false, boot: null, cite: ["no/such/file.txt"] })).ok).toBe(false);
  });
});

describe("FC-55 single-directory repo", () => {
  test("starts no session and returns a typed unknown model", async () => {
    const d = pyRepo();
    let calls = 0;
    const out = await discoverProjectModel(ctxFor(d, async () => { calls++; return ok; }), sig);
    expect(calls).toBe(0);
    expect(out.attempts).toBe(0);
    expect(out.model.status).toBe("unknown");
    expect(out.model.reason).toBe("single-directory repo");
  });
  test("consumers keep repo-root behavior: no api, packageOf null, harness-chosen command unchanged", async () => {
    const d = pyRepo();
    await discoverProjectModel(ctxFor(d, async () => ok), sig);
    expect(loadProjectApi(d)).toBeNull(); // wall.ts packageOf is called as loadProjectApi(...)?.packageOf(...) -> undefined
    expect(projectApi(unknownModel("", "single-directory repo")).packageOf("x")).toBeNull();
    // a model that named a non-default test command for the root package never changes the runner command
    const rootModel = projectApi({ ...unknownModel("k", "x"), status: "ok", packages: [{ name: "sumlib", root: ".", runner: "pytest", commands: { test: { cmd: "pytest -q", cwd: ".", cite: ["pyproject.toml"] } }, ui: { present: false, boot: null, cite: [] }, cite: ["pyproject.toml"] }] } as never);
    const t = { runner: "pytest", path: "test_sumlib.py" } as never;
    expect(commandFor(t, d, null).argv).toEqual(commandFor(t, d, rootModel).argv);
    expect(commandFor(t, d, null).cwd).toBe(d);
  });
  // Fixtures A and B: shallowDirs() truncates by depth and by 20,000 entries, so it must not decide "single".
  const sessionsFor = async (d: string): Promise<number> => {
    let calls = 0;
    await discoverProjectModel(ctxFor(d, async () => { calls++; return ok; }), sig);
    return calls;
  };
  test("A: a workspace package deeper than the shallow depth still runs discovery", async () => {
    const d = mkdtempSync(join(tmpdir(), "pm-fast-a-"));
    dirs.push(d);
    writeFileSync(join(d, "package.json"), '{"name":"root","workspaces":["libs/*/*"]}\n');
    writeFileSync(join(d, "README.md"), "x\n");
    mkdirSync(join(d, "libs", "shared", "ui"), { recursive: true });
    writeFileSync(join(d, "libs", "shared", "ui", "package.json"), '{"name":"ui"}\n');
    git(d, "init", "-q");
    git(d, "add", "-A", "-f");
    expect(await sessionsFor(d)).toBeGreaterThan(0);
  });
  test("B: a package hidden by the 20,000-entry truncation still runs discovery", async () => {
    const d = mkdtempSync(join(tmpdir(), "pm-fast-b-"));
    dirs.push(d);
    writeFileSync(join(d, "README.md"), "x\n");
    writeFileSync(join(d, "package.json"), '{"name":"root"}\n');
    mkdirSync(join(d, "web", "app"), { recursive: true });
    writeFileSync(join(d, "web", "app", "package.json"), '{"name":"web"}\n');
    mkdirSync(join(d, "assets", "img", "icons"), { recursive: true });
    for (let i = 0; i < 20_050; i++) writeFileSync(join(d, "assets", "img", "icons", `i${i}.txt`), "");
    git(d, "init", "-q");
    git(d, "add", "-A", "-f");
    expect(await sessionsFor(d)).toBeGreaterThan(0);
  }, 120_000); // 20,050 file writes plus a git add exceed bun's 5s default on a loaded host (FC-TEST-BULK-FIXTURE-DEFAULT-TIMEOUT)
  test("an empty repo (no tracked files) is not single-directory", async () => {
    const d = mkdtempSync(join(tmpdir(), "pm-fast-e-"));
    dirs.push(d);
    git(d, "init", "-q");
    expect(await sessionsFor(d)).toBeGreaterThan(0);
  });
  test("a multi-directory repo still runs discovery", async () => {
    const d = multiRepo();
    let calls = 0;
    const out = await discoverProjectModel(ctxFor(d, async (o) => {
      calls++;
      writeFileSync(/\(absolute path\): (\S+)/.exec(o.brief)![1]!, JSON.stringify(RECORDED));
      return ok;
    }), sig);
    expect(calls).toBe(1);
    expect(out.model.status).toBe("ok");
  });
});

describe("FC-55 hard timeout on the discovery session", () => {
  test("a hung session becomes a recorded fallback, not a stall or a retry", async () => {
    const d = multiRepo();
    let calls = 0, aborted = false;
    const events: Array<[string, Record<string, unknown>]> = [];
    const t0 = Date.now();
    const out = await discoverProjectModel(ctxFor(d, (o) => { calls++; o.signal.addEventListener("abort", () => { aborted = true; }); return new Promise<SessionResult>(() => {}); }, events), sig, { hardTimeoutMs: 60 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(calls).toBe(1);
    expect(aborted).toBe(true);
    expect(out.model.status).toBe("unknown");
    expect(out.owner).toBe("provider");
    expect(out.model.reason).toContain("hung");
    expect(events.map((e) => e[0])).toContain("project_model.fallback");
  });
});

describe("intake skips discovery when the deterministic signals resolve", () => {
  function twoPkg(withRunner: boolean): string {
    const d = mkdtempSync(join(tmpdir(), "pm-resolved-"));
    dirs.push(d);
    if (withRunner) writeFileSync(join(d, "pytest.ini"), "[pytest]\naddopts = -q\n");
    for (const p of ["alpha", "beta"]) {
      mkdirSync(join(d, p), { recursive: true });
      writeFileSync(join(d, p, `${p}.py`), "def f():\n    return 1\n");
      if (withRunner) writeFileSync(join(d, p, `test_${p}.py`), `from ${p} import f\n\ndef test_f():\n    assert f() == 1\n`);
    }
    writeFileSync(join(d, "README.md"), "x\n");
    git(d, "init", "-q");
    git(d, "add", "-A", "-f");
    return d;
  }
  const count = async (d: string): Promise<{ calls: number; frag: Record<string, any> }> => {
    let calls = 0;
    const prev = process.env["LOKI_E10_PROJECT_MODEL"];
    delete process.env["LOKI_E10_PROJECT_MODEL"]; // default ON
    try {
      const frag = await intakeProjectModel(ctxFor(d, async () => { calls++; return ok; }), sig, Date.now(), buildTestMap(d));
      return { calls, frag };
    } finally { if (prev === undefined) delete process.env["LOKI_E10_PROJECT_MODEL"]; else process.env["LOKI_E10_PROJECT_MODEL"] = prev; }
  };
  test("a two-package repo whose runner and units resolve from manifests runs zero sessions", async () => {
    const { calls, frag } = await count(twoPkg(true));
    expect(calls).toBe(0);
    expect(frag["project_model"].owner).toBe("harness");
    expect(frag["project_model"].attempts).toBe(0);
  });
  test("through runIntake: the stage wires its test map to discovery, so the same repo runs zero sessions", async () => {
    const d = twoPkg(true);
    for (const a of [["config", "user.email", "t@example.com"], ["config", "user.name", "t"], ["commit", "-q", "-m", "init"]]) git(d, ...a);
    let calls = 0;
    const ctx = { ...ctxFor(d, async () => { calls++; return ok; }), branch: "loki/pm-resolved", tests: { detect: async (r: string) => buildTestMap(r), impacted: () => [] } } as unknown as RunContext;
    const keys = ["LOKI_E10_PROJECT_MODEL", "LOKI_E10_INSTALL", "LOKI_REPO_BASELINE"] as const;
    const prev = keys.map((k) => process.env[k]);
    delete process.env["LOKI_E10_PROJECT_MODEL"];
    process.env["LOKI_E10_INSTALL"] = "0";
    process.env["LOKI_REPO_BASELINE"] = "0";
    try {
      const r = await runIntake(ctx, sig, { taskText: "do a thing" });
      expect(r.status).toBe("completed");
      expect((r.data as any).project_model.owner).toBe("harness");
      expect(calls).toBe(0);
    } finally { keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]!; }); }
  });
  test("a repo with per-package manifests below the root still runs discovery, so each package gets its own install", async () => {
    const d = mkdtempSync(join(tmpdir(), "pm-nested-"));
    dirs.push(d);
    writeFileSync(join(d, "pytest.ini"), "[pytest]\naddopts = -q\n");
    for (const p of ["a", "b"]) {
      mkdirSync(join(d, p, "tests"), { recursive: true });
      writeFileSync(join(d, p, "pyproject.toml"), `[project]\nname = "${p}"\n`);
      writeFileSync(join(d, p, "tests", `test_${p}.py`), "def test_x():\n    assert True\n");
    }
    mkdirSync(join(d, "c", "src"), { recursive: true });
    writeFileSync(join(d, "c", "src", "c.py"), "x = 1\n");
    git(d, "init", "-q");
    git(d, "add", "-A", "-f");
    const tm = buildTestMap(d);
    expect(tm.runners.length).toBe(1);
    expect(tm.tests.length).toBeGreaterThan(0); // the test-file signal alone resolves; only the nested manifests must stop the skip
    expect(signalsResolve(tm)).toBe(true);
    expect(signalsResolve(tm, d)).toBe(false);
    const { calls } = await count(d);
    expect(calls).toBeGreaterThan(0);
  });
  test("a two-package repo whose signals do not resolve still runs discovery", async () => {
    const { calls } = await count(twoPkg(false));
    expect(calls).toBeGreaterThan(0);
  });
});

describe("project-model discovery follows the run tier", () => {
  const KEYS = ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_FAST", "LOKI_ALLOW_HAIKU"];
  const first = async (runModel: string, env: Record<string, string> = {}): Promise<string | undefined> => {
    const saved = KEYS.map((k) => process.env[k]);
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    const d = multiRepo();
    let model: string | undefined, seen = false;
    try {
      await discoverProjectModel({ ...ctxFor(d, async (o) => { if (!seen) { seen = true; model = o.model; } return ok; }), model: runModel } as RunContext, sig, { hardTimeoutMs: 2000 });
    } finally { KEYS.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]!; }); }
    return model;
  };
  test("a haiku run discovers on haiku", async () => { expect(await first("haiku")).toBe("haiku"); });
  test("a sonnet run is unchanged", async () => { expect(await first("sonnet")).toBe("sonnet"); });
  test("an explicit LOKI_CLAUDE_MODEL_FAST pin is honored on a haiku run", async () => { expect(await first("haiku", { LOKI_CLAUDE_MODEL_FAST: "sonnet" })).toBe("sonnet"); });
});
