// FC-55 (INTAKE-FAST): a no-UI answer validates, a single-directory repo spends no model session, and a
// hung discovery session becomes a recorded fallback. The model call is always a stub.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectApi } from "../../src/project_model/api.ts";
import { discoverProjectModel } from "../../src/project_model/discover.ts";
import { loadProjectApi } from "../../src/project_model/resolve.ts";
import { unknownModel, validateAnswer } from "../../src/project_model/schema.ts";
import { commandFor } from "../../src/engine10/stages/verify.ts";
import type { RunContext, SessionResult, SessionRunOptions } from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "project-model", "firelater-17");
const RECORDED = JSON.parse(readFileSync(join(FIX, "response.json"), "utf8")) as Record<string, any>;
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
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
  });
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
